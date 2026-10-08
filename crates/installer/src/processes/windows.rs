//! The Windows process table: Toolhelp snapshots for the list and parents, and per-process
//! handles for identity and termination (`windows-sys`, the version `ring` already brings).
//!
//! There is no way to ask a process to exit: a task-launched Computer has no console to send a
//! Ctrl-Break to, and `WM_CLOSE` reaches windows it does not have. [`ProcessTable::request_exit`]
//! says so ([`ExitRequest::Unsupported`]) and `terminate` goes straight to `TerminateProcess`.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE,
    INVALID_HANDLE_VALUE, STILL_ACTIVE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW,
    TerminateProcess,
};

use super::{
    ExitRequest, Inspection, ProcessError, ProcessIdentity, ProcessTable, refuse_unendable,
};

/// The processes of this machine, read through Toolhelp and ended with `TerminateProcess`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsProcesses;

/// An open process handle, closed when dropped.
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by OpenProcess or CreateToolhelp32Snapshot and is
        // closed exactly once, here.
        unsafe { CloseHandle(self.0) };
    }
}

enum Opened {
    Handle(Handle),
    /// `ERROR_INVALID_PARAMETER`: no process has this pid.
    Absent,
    /// `ERROR_ACCESS_DENIED`: another user's process, or a protected one.
    Denied,
}

fn open(pid: u32, access: u32) -> Result<Opened, io::Error> {
    // SAFETY: OpenProcess takes integers and returns a handle or null; it touches no memory.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle != 0 {
        return Ok(Opened::Handle(Handle(handle)));
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == ERROR_INVALID_PARAMETER as i32 => Ok(Opened::Absent),
        Some(code) if code == ERROR_ACCESS_DENIED as i32 => Ok(Opened::Denied),
        _ => Err(error),
    }
}

/// Whether the process still runs. An exited process whose handle someone still holds is the
/// Windows zombie: `GetExitCodeProcess` no longer says `STILL_ACTIVE`.
fn is_active(handle: &Handle) -> Result<bool, io::Error> {
    let mut code = 0u32;
    // SAFETY: `code` is a writable u32 for the whole call.
    if unsafe { GetExitCodeProcess(handle.0, &mut code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(code == STILL_ACTIVE as u32)
}

fn creation_time(handle: &Handle) -> Result<u64, io::Error> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: the four FILETIMEs are writable for the whole call.
    let read =
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

fn image_path(handle: &Handle) -> Result<PathBuf, io::Error> {
    // 32768 UTF-16 units is the longest path Windows allows.
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is writable for `length` units, and `length` is updated in place.
    let read = unsafe {
        QueryFullProcessImageNameW(
            handle.0,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

/// Every process in a Toolhelp snapshot, as (pid, parent pid).
fn snapshot() -> Result<Vec<(u32, u32)>, ProcessError> {
    let enumerate = |error: io::Error| ProcessError::Enumerate {
        detail: format!("Toolhelp snapshot: {error}"),
    };
    // SAFETY: CreateToolhelp32Snapshot takes integers and returns a handle or
    // INVALID_HANDLE_VALUE.
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(enumerate(io::Error::last_os_error()));
    }
    let handle = Handle(handle);
    // SAFETY: PROCESSENTRY32W is integers and an integer array; all-zero is valid, and dwSize is
    // set as the API requires.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut processes = Vec::new();
    // SAFETY: `entry` is a writable PROCESSENTRY32W with dwSize set, for the whole call.
    let mut more = unsafe { Process32FirstW(handle.0, &mut entry) };
    while more != 0 {
        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: as above.
        more = unsafe { Process32NextW(handle.0, &mut entry) };
    }
    Ok(processes)
}

impl ProcessTable for OsProcesses {
    fn pids(&self) -> Result<Vec<u32>, ProcessError> {
        Ok(snapshot()?.into_iter().map(|(pid, _)| pid).collect())
    }

    fn inspect(&self, pid: u32) -> Result<Inspection, ProcessError> {
        let failed = |error: io::Error| ProcessError::Inspect {
            pid,
            detail: error.to_string(),
        };
        let handle = match open(pid, PROCESS_QUERY_LIMITED_INFORMATION).map_err(failed)? {
            Opened::Absent => return Ok(Inspection::Absent),
            Opened::Denied => return Ok(Inspection::Unreadable),
            Opened::Handle(handle) => handle,
        };
        if !is_active(&handle).map_err(failed)? {
            return Ok(Inspection::Zombie);
        }
        Ok(Inspection::Alive(ProcessIdentity {
            pid,
            started_at: creation_time(&handle).map_err(failed)?,
            executable: image_path(&handle).map_err(failed)?,
        }))
    }

    fn parent_of(&self, pid: u32) -> Result<Option<u32>, ProcessError> {
        if !matches!(self.inspect(pid)?, Inspection::Alive(_)) {
            return Ok(None);
        }
        Ok(snapshot()?
            .into_iter()
            .find(|(candidate, _)| *candidate == pid)
            .map(|(_, parent)| parent))
    }

    fn request_exit(&self, _pid: u32) -> Result<ExitRequest, ProcessError> {
        Ok(ExitRequest::Unsupported)
    }

    fn kill(&self, pid: u32) -> Result<(), ProcessError> {
        let failed = |error: io::Error| ProcessError::Signal {
            pid,
            detail: error.to_string(),
        };
        refuse_unendable(pid)?;
        let handle = match open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)
            .map_err(failed)?
        {
            // Already gone is what was wanted.
            Opened::Absent => return Ok(()),
            Opened::Denied => {
                return Err(ProcessError::Signal {
                    pid,
                    detail: "access is denied".to_owned(),
                });
            }
            Opened::Handle(handle) => handle,
        };
        // SAFETY: TerminateProcess takes a handle and an exit code and touches no memory.
        if unsafe { TerminateProcess(handle.0, 1) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        // A process that exited an instant ago refuses termination with `ERROR_ACCESS_DENIED`.
        match is_active(&handle) {
            Ok(false) => Ok(()),
            _ => Err(failed(error)),
        }
    }
}
