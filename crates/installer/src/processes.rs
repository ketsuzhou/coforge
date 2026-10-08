//! The processes of the installed product executable: which ones exist, whether they are gone,
//! and ending the ones the service manager left behind.
//!
//! The supervisor, its daemons, and the `__agent-cli` re-execs all run the one `coforge-computer`
//! executable, so "every process of this installation" is "every process whose canonical
//! executable is that file". Agents (claude, codex, ...) are other executables and are not
//! collected. An upgrade uses this module around the service manager's stop
//! ([`crate::service`]): [`collect`] first, then the stop, then [`terminate`] for whatever is
//! still alive, which also proves each collected process dead.
//!
//! # The caller
//!
//! When `coforge-computer upgrade` launches the installer in the foreground, the waiting
//! `upgrade` process runs the same executable and is alive, so it would be collected and killed.
//! The installer is told its pid with `--caller-pid <pid>` (an argument, not an environment
//! variable: an argument reaches only the process it names and cannot be inherited by a child or
//! left over from another run). [`VerifiedCaller::verify`] accepts it only as the installer's
//! immediate parent, and [`collect`] leaves it out, so it is neither signalled nor waited for.
//! A run with no `--caller-pid` (the installer started by hand) has no caller to spare.
//!
//! # Identity
//!
//! A process is identified by [`ProcessIdentity`]: pid, start time, and canonical executable.
//! The pid alone is not enough: a dead process's pid is reused. A collected identity counts as
//! dead when its pid is gone, is a zombie, or now belongs to a process with another start time or
//! another executable, and a signal is sent only after the same check, so a reused pid is never
//! signalled.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::clock::{Clock, poll_until};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "linux", test))]
mod proc_stat;
#[cfg(unix)]
mod signals;
#[cfg(windows)]
mod windows;

#[cfg(test)]
mod fakes;

#[cfg(target_os = "linux")]
pub use linux::OsProcesses;
#[cfg(target_os = "macos")]
pub use macos::OsProcesses;
#[cfg(windows)]
pub use windows::OsProcesses;

/// One process, as a receipt can name it.
///
/// `started_at` is a number the platform keeps for the life of the process, comparable only with
/// another reading on the same machine and boot:
/// - Linux: field 22 of `/proc/<pid>/stat`, clock ticks since boot;
/// - macOS: `proc_bsdinfo.pbi_start_tvsec` and `pbi_start_tvusec` from
///   `proc_pidinfo(PROC_PIDTBSDINFO)`, as microseconds since the Unix epoch;
/// - Windows: the creation time from `GetProcessTimes`, a `FILETIME` (100 ns intervals since
///   1601-01-01 UTC).
///
/// `executable` is the canonical path of the running image: `/proc/<pid>/exe` (a trailing
/// ` (deleted)`, which Linux adds when the file was replaced, is removed), `proc_pidpath`, or
/// `QueryFullProcessImageNameW`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at: u64,
    pub executable: PathBuf,
}

/// What the operating system says about one pid right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inspection {
    /// No process has this pid.
    Absent,
    /// The process has exited and only its exit status is left to be collected: dead.
    Zombie,
    /// The process exists but this user may not inspect it (another user's process).
    Unreadable,
    /// The process is alive, but its executable file has been deleted since it started and the
    /// system no longer has a path for it (macOS; Linux still gives one). Any app that replaced
    /// itself while running looks like this.
    Unlinked {
        started_at: u64,
    },
    Alive(ProcessIdentity),
}

/// What [`ProcessTable::request_exit`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitRequest {
    /// The process was asked to exit and may take time to do so (SIGTERM).
    Sent,
    /// This platform has no way to ask: only [`ProcessTable::kill`] ends a process.
    Unsupported,
}

/// The operating system's process table: the port [`collect`] and [`terminate`] work through.
pub trait ProcessTable {
    /// Every pid the system lists.
    fn pids(&self) -> Result<Vec<u32>, ProcessError>;

    fn inspect(&self, pid: u32) -> Result<Inspection, ProcessError>;

    /// The pid of the parent of `pid`, or `None` when `pid` is not a live process.
    fn parent_of(&self, pid: u32) -> Result<Option<u32>, ProcessError>;

    /// Asks the process to exit (SIGTERM). A process that has already gone is not an error.
    fn request_exit(&self, pid: u32) -> Result<ExitRequest, ProcessError>;

    /// Ends the process now (SIGKILL, `TerminateProcess`). A process that has already gone is not
    /// an error.
    fn kill(&self, pid: u32) -> Result<(), ProcessError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessError {
    Enumerate {
        detail: String,
    },
    Inspect {
        pid: u32,
        detail: String,
    },
    Signal {
        pid: u32,
        detail: String,
    },
    /// `--caller-pid` names a process that is not the installer's immediate parent.
    CallerNotParent {
        claimed: u32,
        actual: Option<u32>,
    },
    /// Processes of the installation are still alive after every step.
    StillAlive {
        survivors: Vec<ProcessIdentity>,
        kill_wait: Duration,
    },
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Enumerate { detail } => {
                write!(
                    formatter,
                    "The system's process list could not be read: {detail}."
                )
            }
            Self::Inspect { pid, detail } => {
                write!(formatter, "Process {pid} could not be inspected: {detail}.")
            }
            Self::Signal { pid, detail } => {
                write!(formatter, "Process {pid} could not be signalled: {detail}.")
            }
            Self::CallerNotParent { claimed, actual } => {
                let parent = match actual {
                    Some(parent) => format!("the installer's parent is process {parent}"),
                    None => "the installer's own parent could not be found".to_owned(),
                };
                write!(
                    formatter,
                    "`--caller-pid {claimed}` is not the process that started the installer \
                     ({parent}). The installer spares a waiting caller only when it is its own \
                     parent; run `coforge-computer upgrade` instead of starting the installer by \
                     hand with that option."
                )
            }
            Self::StillAlive {
                survivors,
                kill_wait,
            } => {
                let named: Vec<String> = survivors
                    .iter()
                    .map(|process| {
                        format!("pid {} ({})", process.pid, process.executable.display())
                    })
                    .collect();
                let pids: Vec<String> = survivors.iter().map(|p| p.pid.to_string()).collect();
                let by_hand = if cfg!(windows) {
                    format!("taskkill /F /PID {}", pids.join(" /PID "))
                } else {
                    format!("kill -9 {}", pids.join(" "))
                };
                write!(
                    formatter,
                    "{} still running {}s after being asked to exit and then killed: {}. Stop \
                     {} yourself with `{by_hand}`, then run the operation again.",
                    if survivors.len() == 1 {
                        "A Computer process is"
                    } else {
                        "Computer processes are"
                    },
                    kill_wait.as_secs(),
                    named.join(", "),
                    if survivors.len() == 1 { "it" } else { "them" },
                )
            }
        }
    }
}

impl std::error::Error for ProcessError {}

/// The key two Windows paths compare by: no `\\?\` prefix, one separator, no case.
fn windows_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned(),
    };
    text.replace('/', "\\").to_lowercase()
}

/// The installed product executable, canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductExecutable(PathBuf);

impl ProductExecutable {
    /// The canonical form of `path` (symlinks resolved, so `install/active/coforge-computer` is
    /// the file under `versions/<v>/` it points at).
    pub fn resolve(path: &Path) -> io::Result<Self> {
        fs::canonicalize(path).map(Self)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Whether a process image is this executable.
    pub fn matches(&self, executable: &Path) -> bool {
        if cfg!(windows) {
            windows_key(&self.0) == windows_key(executable)
        } else {
            self.0 == executable
        }
    }
}

/// The process that launched the installer and waits for it, checked to be its immediate parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedCaller {
    pid: u32,
}

impl VerifiedCaller {
    /// `claimed` is the pid the command line named; `own_pid` is the installer's.
    pub fn verify(
        table: &dyn ProcessTable,
        own_pid: u32,
        claimed: u32,
    ) -> Result<Self, ProcessError> {
        match table.parent_of(own_pid)? {
            Some(parent) if parent == claimed => Ok(Self { pid: claimed }),
            actual => Err(ProcessError::CallerNotParent { claimed, actual }),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

/// Every live process running `product`, except the caller, sorted by pid.
pub fn collect(
    table: &dyn ProcessTable,
    product: &ProductExecutable,
    caller: Option<&VerifiedCaller>,
) -> Result<Vec<ProcessIdentity>, ProcessError> {
    let mut found = Vec::new();
    for pid in table.pids()? {
        if caller.is_some_and(|caller| caller.pid == pid) {
            continue;
        }
        // A pid that cannot be inspected is an error, not a skip: a product process missed here
        // is one the upgrade would replace underneath. One whose executable was deleted has no
        // path on macOS ([`Inspection::Unlinked`]) and is passed over: the installer never
        // deletes a version, so it is not the product's. Linux still names the file, and matches.
        if let Inspection::Alive(identity) = table.inspect(pid)?
            && product.matches(&identity.executable)
        {
            found.push(identity);
        }
    }
    found.sort_by_key(|identity| identity.pid);
    Ok(found)
}

/// How long [`terminate`] waits at each step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Escalation {
    /// After asking for an exit.
    pub exit_wait: Duration,
    /// After the kill.
    pub kill_wait: Duration,
    pub poll: Duration,
}

impl Default for Escalation {
    fn default() -> Self {
        Self {
            exit_wait: Duration::from_secs(15),
            kill_wait: Duration::from_secs(5),
            poll: Duration::from_millis(50),
        }
    }
}

/// What [`terminate`] proved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Termination {
    /// Every identity it was given, each verified dead.
    pub verified_dead: Vec<ProcessIdentity>,
    /// How many processes had to be killed because they ignored the request to exit.
    pub forced_kills: usize,
}

/// Ends whichever of `identities` is still alive and verifies all of them dead: ask to exit and
/// wait `exit_wait`, then kill and wait `kill_wait`. Anything alive after that is an error naming
/// it.
pub fn terminate(
    table: &dyn ProcessTable,
    clock: &dyn Clock,
    escalation: Escalation,
    identities: &[ProcessIdentity],
) -> Result<Termination, ProcessError> {
    let mut alive = survivors(table, identities)?;
    let mut forced_kills = 0;

    let mut asked = false;
    for process in &alive {
        asked |= table.request_exit(process.pid)? == ExitRequest::Sent;
    }
    // A platform with no way to ask (Windows) has nothing to wait for: the wait would only delay.
    if asked {
        wait_for_exit(
            table,
            clock,
            escalation.exit_wait,
            escalation.poll,
            &mut alive,
        )?;
    }

    // `alive` was read at the last poll (or just now), so the pids killed here are still the
    // identities collected, never a pid that has since been reused.
    for process in &alive {
        table.kill(process.pid)?;
        forced_kills += 1;
    }
    if !alive.is_empty() {
        wait_for_exit(
            table,
            clock,
            escalation.kill_wait,
            escalation.poll,
            &mut alive,
        )?;
    }

    if alive.is_empty() {
        Ok(Termination {
            verified_dead: identities.to_vec(),
            forced_kills,
        })
    } else {
        Err(ProcessError::StillAlive {
            survivors: alive,
            kill_wait: escalation.kill_wait,
        })
    }
}

/// Narrows `alive` to the identities still alive until none is, or `bound` has passed.
fn wait_for_exit(
    table: &dyn ProcessTable,
    clock: &dyn Clock,
    bound: Duration,
    poll: Duration,
    alive: &mut Vec<ProcessIdentity>,
) -> Result<(), ProcessError> {
    poll_until(clock, bound, poll, || {
        *alive = survivors(table, alive)?;
        Ok::<_, ProcessError>(alive.is_empty().then_some(()))
    })?;
    Ok(())
}

/// Refuses a pid the installer must never end: 0 (on Unix, a process group) and the installer's
/// own pid. Neither is ever a collected product process.
fn refuse_unendable(pid: u32) -> Result<(), ProcessError> {
    if pid == 0 || pid == std::process::id() {
        return Err(ProcessError::Signal {
            pid,
            detail: "that is not a process the installer may end".to_owned(),
        });
    }
    Ok(())
}

/// The identities that are still that live process. A pid that is gone, a zombie, or now another
/// process (other start time, other executable) is dead; one that may not be inspected cannot be
/// proven dead and stays.
fn survivors(
    table: &dyn ProcessTable,
    identities: &[ProcessIdentity],
) -> Result<Vec<ProcessIdentity>, ProcessError> {
    let mut alive = Vec::new();
    for identity in identities {
        let still_there = match table.inspect(identity.pid)? {
            Inspection::Absent | Inspection::Zombie => false,
            Inspection::Unreadable => true,
            // The pid and start time are still the collected process's; only its file is gone.
            Inspection::Unlinked { started_at } => started_at == identity.started_at,
            Inspection::Alive(now) => now == *identity,
        };
        if still_there {
            alive.push(identity.clone());
        }
    }
    Ok(alive)
}

#[cfg(test)]
mod tests;
