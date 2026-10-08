//! The Linux process table: `/proc`.

use std::fs;
use std::io;

use super::proc_stat::{Stat, executable, parse_stat};
use super::{ExitRequest, Inspection, ProcessError, ProcessIdentity, ProcessTable, signals};

/// The processes of this machine, read from `/proc` and signalled with `kill(2)`.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsProcesses;

/// `/proc/<pid>/stat`, or `None` when the process is gone. A `stat` this user may not read is
/// reported as a failure: `/proc` mounted with `hidepid` hides other users' pids entirely, so it
/// does not occur for the user's own processes.
fn read_stat(pid: u32) -> Result<Option<Stat>, ProcessError> {
    match fs::read(format!("/proc/{pid}/stat")) {
        Ok(bytes) => parse_stat(&String::from_utf8_lossy(&bytes))
            .map(Some)
            .ok_or_else(|| ProcessError::Inspect {
                pid,
                detail: "/proc/<pid>/stat is not in the documented format".to_owned(),
            }),
        // ESRCH is what a process that exits while its `stat` is being read gives.
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            Ok(None)
        }
        Err(error) => Err(ProcessError::Inspect {
            pid,
            detail: error.to_string(),
        }),
    }
}

impl ProcessTable for OsProcesses {
    fn pids(&self) -> Result<Vec<u32>, ProcessError> {
        let entries = fs::read_dir("/proc").map_err(|error| ProcessError::Enumerate {
            detail: format!("/proc: {error}"),
        })?;
        Ok(entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
            .collect())
    }

    fn inspect(&self, pid: u32) -> Result<Inspection, ProcessError> {
        let Some(stat) = read_stat(pid)? else {
            return Ok(Inspection::Absent);
        };
        if stat.is_dead() {
            return Ok(Inspection::Zombie);
        }
        match fs::read_link(format!("/proc/{pid}/exe")) {
            Ok(link) => Ok(Inspection::Alive(ProcessIdentity {
                pid,
                started_at: stat.start_ticks,
                executable: executable(&link),
            })),
            // Another user's process (EACCES), or a kernel thread, which has no executable
            // (ENOENT): not a process the installer can identify.
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound
                ) =>
            {
                Ok(Inspection::Unreadable)
            }
            Err(error) => Err(ProcessError::Inspect {
                pid,
                detail: format!("/proc/{pid}/exe: {error}"),
            }),
        }
    }

    fn parent_of(&self, pid: u32) -> Result<Option<u32>, ProcessError> {
        Ok(read_stat(pid)?
            .filter(|stat| !stat.is_dead())
            .map(|stat| stat.parent))
    }

    fn request_exit(&self, pid: u32) -> Result<ExitRequest, ProcessError> {
        signals::request_exit(pid)
    }

    fn kill(&self, pid: u32) -> Result<(), ProcessError> {
        signals::kill(pid)
    }
}
