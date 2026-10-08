//! Unix signals to a pid. The two ways to end a process: ask, and kill.

use std::io;

use super::{ExitRequest, ProcessError, refuse_unendable};

/// SIGTERM.
pub(super) fn request_exit(pid: u32) -> Result<ExitRequest, ProcessError> {
    send(pid, libc::SIGTERM)?;
    Ok(ExitRequest::Sent)
}

/// SIGKILL.
pub(super) fn kill(pid: u32) -> Result<(), ProcessError> {
    send(pid, libc::SIGKILL)
}

/// A process that is already gone (`ESRCH`) is not an error: it is what was wanted.
fn send(pid: u32, signal: libc::c_int) -> Result<(), ProcessError> {
    refuse_unendable(pid)?;
    // A pid past `pid_t` would turn negative, which addresses a process group.
    let Ok(target) = libc::pid_t::try_from(pid) else {
        return Err(ProcessError::Signal {
            pid,
            detail: "that is not a process the installer may end".to_owned(),
        });
    };
    // SAFETY: kill(2) takes two integers and reads or writes no memory.
    if unsafe { libc::kill(target, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        _ => Err(ProcessError::Signal {
            pid,
            detail: error.to_string(),
        }),
    }
}
