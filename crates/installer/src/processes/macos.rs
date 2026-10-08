//! The macOS process table: libproc (`proc_listallpids`, `proc_pidinfo`, `proc_pidpath`), which
//! is what `ps` reads, and `kill(2)`.

use std::ffi::{OsStr, c_int, c_void};
use std::io;
use std::mem::size_of;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

use super::{ExitRequest, Inspection, ProcessError, ProcessIdentity, ProcessTable, signals};

/// The processes of this machine, read through libproc and signalled with `kill(2)`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsProcesses;

/// What libproc gave for one pid.
enum Read<T> {
    Gone,
    /// `EPERM` or `EACCES`: another user's process.
    Denied,
    Got(T),
}

/// What `proc_pidpath` gave for one pid.
enum ImagePath {
    Gone,
    Denied,
    /// `ENOENT`: the executable file was deleted or replaced after the process started, and
    /// libproc has no path for the running image any more.
    Unlinked,
    Got(PathBuf),
}

fn errno() -> io::Error {
    io::Error::last_os_error()
}

/// `proc_bsdinfo` of `pid`: parent, status, and start time.
fn bsd_info(pid: u32) -> Result<Read<libc::proc_bsdinfo>, ProcessError> {
    let Ok(target) = libc::pid_t::try_from(pid) else {
        return Ok(Read::Gone);
    };
    // SAFETY: proc_bsdinfo is plain integers and byte arrays; all-zero is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as c_int;
    // SAFETY: `info` is a writable buffer of exactly `size` bytes for the whole call.
    let written = unsafe {
        libc::proc_pidinfo(
            target,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast::<c_void>(),
            size,
        )
    };
    if written == size {
        return Ok(Read::Got(info));
    }
    let error = errno();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(Read::Gone),
        Some(libc::EPERM | libc::EACCES) => Ok(Read::Denied),
        _ if written > 0 => Err(ProcessError::Inspect {
            pid,
            detail: format!("proc_pidinfo returned {written} bytes, expected {size}"),
        }),
        _ => Err(ProcessError::Inspect {
            pid,
            detail: format!("proc_pidinfo: {error}"),
        }),
    }
}

/// `proc_pidpath` of `pid`: the path of the running image.
fn image_path(pid: u32) -> Result<ImagePath, ProcessError> {
    let Ok(target) = libc::pid_t::try_from(pid) else {
        return Ok(ImagePath::Gone);
    };
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buffer` is writable for the `buffer.len()` bytes passed.
    let length = unsafe {
        libc::proc_pidpath(
            target,
            buffer.as_mut_ptr().cast::<c_void>(),
            buffer.len() as u32,
        )
    };
    if length > 0 {
        buffer.truncate(length as usize);
        return Ok(ImagePath::Got(PathBuf::from(OsStr::from_bytes(&buffer))));
    }
    let error = errno();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(ImagePath::Gone),
        Some(libc::EPERM | libc::EACCES) => Ok(ImagePath::Denied),
        Some(libc::ENOENT) => Ok(ImagePath::Unlinked),
        _ => Err(ProcessError::Inspect {
            pid,
            detail: format!("proc_pidpath: {error}"),
        }),
    }
}

impl ProcessTable for OsProcesses {
    fn pids(&self) -> Result<Vec<u32>, ProcessError> {
        let enumerate = |detail: String| ProcessError::Enumerate { detail };
        // SAFETY: a null buffer of size 0 asks only for the number of pids.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count < 0 {
            return Err(enumerate(format!("proc_listallpids: {}", errno())));
        }
        // Processes start between the two calls; leave room for them.
        let mut pids = vec![0 as libc::pid_t; count as usize + 64];
        let bytes = (pids.len() * size_of::<libc::pid_t>()) as c_int;
        // SAFETY: `pids` is writable for `bytes` bytes for the whole call.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), bytes) };
        if listed < 0 {
            return Err(enumerate(format!("proc_listallpids: {}", errno())));
        }
        // The call returns the number of pids; unused slots are 0.
        Ok(pids
            .into_iter()
            .take(listed as usize)
            .filter_map(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .collect())
    }

    fn inspect(&self, pid: u32) -> Result<Inspection, ProcessError> {
        let info = match bsd_info(pid)? {
            Read::Gone => return Ok(Inspection::Absent),
            Read::Denied => return Ok(Inspection::Unreadable),
            Read::Got(info) => info,
        };
        if info.pbi_status == libc::SZOMB {
            return Ok(Inspection::Zombie);
        }
        let started_at = info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec;
        Ok(match image_path(pid)? {
            ImagePath::Gone => Inspection::Absent,
            ImagePath::Denied => Inspection::Unreadable,
            ImagePath::Unlinked => Inspection::Unlinked { started_at },
            ImagePath::Got(executable) => Inspection::Alive(ProcessIdentity {
                pid,
                started_at,
                executable,
            }),
        })
    }

    fn parent_of(&self, pid: u32) -> Result<Option<u32>, ProcessError> {
        Ok(match bsd_info(pid)? {
            Read::Got(info) if info.pbi_status != libc::SZOMB => Some(info.pbi_ppid),
            _ => None,
        })
    }

    fn request_exit(&self, pid: u32) -> Result<ExitRequest, ProcessError> {
        signals::request_exit(pid)
    }

    fn kill(&self, pid: u32) -> Result<(), ProcessError> {
        signals::kill(pid)
    }
}
