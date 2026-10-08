//! The launchd backend (macOS): the `gui/<uid>` user agent `cn.coforge.computer.daemon`.
//!
//! Ported from `LaunchdDaemonHost` (packages/daemon/src/daemon-host/launchd.ts) and `LaunchdJob`
//! (packages/daemon/src/platform/launchd-job.ts). launchd has one notion of "there": a job is
//! loaded into the domain or it is not. Stopping is `bootout`, which unloads the job; starting an
//! unloaded job is `bootstrap` of the plist the Computer installed under
//! `~/Library/LaunchAgents/`; starting a loaded job that has no process is `kickstart`.
//!
//! `bootout` returns once launchd has been asked, not once it has finished: `print` keeps
//! answering for the outgoing instance through launchd's SIGTERM, then SIGKILL after 5 s, ladder.
//! The dev.34 to dev.35 upgrade bootstrapped a replacement inside that window, saw the label
//! still loaded, skipped it, and launchd then removed the job with nothing left to start.
//! Two rules follow, and the tests pin both: [`stop`](SupervisorService::stop) returns only after
//! a `print` fails, and [`start`](SupervisorService::start) never takes a loaded job for a
//! started one: it waits for a process. During the teardown `print` still exits 0, prints the old
//! pid, and says `state = SIGTERMed` (measured, macOS 27, 2026-09-30). A job in that state is not
//! running. `stop` still boots it out (a second `bootout` exits 0 at once, and it turns the
//! respawn of a `kickstart -k` restart into a removal); `start` waits until the job is no longer
//! torn down, which is either gone (then it is bootstrapped) or settled after a `kickstart -k`
//! restart (`print` never fails then).
//!
//! `launchctl print` is not a documented API; the state and pid are read from its top-level
//! `state` and `pid` lines only (its nested blocks repeat those keys), and a format change makes
//! the wait for a process time out with launchd's words in the message, never a wrong success.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{
    Attempt, CommandLine, CommandRunner, ServiceError, ServiceState, StartOutcome, StopOutcome,
    SupervisorService, execute,
};
use crate::clock::{Clock, poll_until};
use crate::contract::CoordinatorService;

const LAUNCHCTL: &str = "/bin/launchctl";

/// Generous: a `kickstart -k` against a job that respawned inside launchd's throttle window blocks
/// for up to about 9 s (measured), and that is not a hung command.
const COMMAND_BOUND: Duration = Duration::from_secs(30);
/// Longer than launchd's 5 s SIGKILL teardown window.
const STOP_WAIT: Duration = Duration::from_secs(15);
const START_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);
const BOOTSTRAP_ATTEMPTS: usize = 3;
const BOOTSTRAP_RETRY_DELAY: Duration = Duration::from_secs(1);

// launchctl exit codes. Measured on macOS 27 on 2026-09-30 unless noted.
/// `print` or `kickstart` of a label the domain does not hold.
const SERVICE_NOT_FOUND: i32 = 113;
/// `print` of a domain that does not exist: `gui/<uid>` of a user with no desktop login.
const DOMAIN_NOT_FOUND: i32 = 112;
/// `bootout` of a job that is not loaded: "No such process".
const NO_SUCH_PROCESS: i32 = 3;
/// `bootstrap` while an earlier bootout of the label is still tearing down: EIO, or "Operation
/// already in progress" (documented at launchd.ts:16). EIO is also what a missing plist gives
/// (measured), so a plist is checked before it is bootstrapped.
const IO_ERROR: i32 = 5;
const ALREADY_IN_PROGRESS: i32 = 37;
/// "Domain does not support specified action", from the 2026-09-16 recovery notes (not measured
/// here): launchctl acting on a `gui/<uid>` domain the session cannot reach.
const DOMAIN_UNSUPPORTED: i32 = 125;

pub struct Launchd<'a> {
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
    label: String,
    /// `gui/<uid>`.
    domain: String,
    /// `gui/<uid>/<label>`.
    target: String,
    plist: PathBuf,
}

impl<'a> Launchd<'a> {
    /// The Coordinator's user agent for user `uid`, whose plist is under `home`.
    pub fn new(
        runner: &'a dyn CommandRunner,
        clock: &'a dyn Clock,
        service: &CoordinatorService,
        home: &Path,
        uid: u32,
    ) -> Result<Self, ServiceError> {
        let label = &service.launchd_label;
        if label.is_empty()
            || !label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Err(ServiceError::InvalidIdentity {
                what: "launchd label",
                value: label.clone(),
            });
        }
        let domain = service.launchd_domain.replace("{uid}", &uid.to_string());
        if domain != format!("gui/{uid}") {
            return Err(ServiceError::InvalidIdentity {
                what: "launchd domain",
                value: domain,
            });
        }
        Ok(Self {
            runner,
            clock,
            target: format!("{domain}/{label}"),
            plist: home
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{label}.plist")),
            label: label.clone(),
            domain,
        })
    }

    fn launchctl(&self, args: &[&str]) -> Result<Attempt, ServiceError> {
        execute(
            self.runner,
            CommandLine::new(LAUNCHCTL, args.iter().copied()),
            COMMAND_BOUND,
        )
    }

    /// What launchd and the disk say, in the vocabulary of launchd.
    fn observe(&self) -> Result<Observed, ServiceError> {
        let attempt = self.launchctl(&["print", &self.target])?;
        if attempt.succeeded() {
            return Ok(Observed::Loaded(parse_job(&attempt.output.stdout)));
        }
        if attempt.code() == SERVICE_NOT_FOUND {
            return Ok(if self.plist_installed()? {
                Observed::Unloaded
            } else {
                Observed::NotInstalled
            });
        }
        Err(self.refused(&attempt, self.inspect_hint()))
    }

    fn plist_installed(&self) -> Result<bool, ServiceError> {
        match fs::metadata(&self.plist) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(ServiceError::FileUnreadable {
                path: self.plist.display().to_string(),
                detail: error.to_string(),
            }),
        }
    }

    /// A refusal from launchctl: the missing-domain codes get their own explanation, everything
    /// else carries launchctl's words and `hint`.
    fn refused(&self, attempt: &Attempt, hint: String) -> ServiceError {
        match attempt.code() {
            DOMAIN_NOT_FOUND | DOMAIN_UNSUPPORTED => ServiceError::NoLaunchdDomain {
                domain: self.domain.clone(),
                command: attempt.command_text(),
                code: attempt.code(),
                diagnostic: attempt.diagnostic(),
            },
            code => ServiceError::CommandFailed {
                command: attempt.command_text(),
                code,
                diagnostic: attempt.diagnostic(),
                hint,
            },
        }
    }

    fn inspect_hint(&self) -> String {
        format!(
            "Run `launchctl print {}` yourself for launchd's own account of it.",
            self.target
        )
    }

    /// `bootstrap` of the installed plist. Retried, and only on the two codes that mean an earlier
    /// bootout of this label has not finished; any other code is a real failure.
    fn bootstrap(&self) -> Result<(), ServiceError> {
        let plist = self.plist.display().to_string();
        let mut attempts = 1;
        loop {
            let attempt = self.launchctl(&["bootstrap", &self.domain, &plist])?;
            if attempt.succeeded() {
                return Ok(());
            }
            let retryable = matches!(attempt.code(), IO_ERROR | ALREADY_IN_PROGRESS);
            if !retryable || attempts == BOOTSTRAP_ATTEMPTS {
                return Err(self.refused(
                    &attempt,
                    format!(
                        "Run `launchctl bootstrap {} {plist}` yourself to see launchd's own \
                         reason, or reinstall the user agent with `coforge-computer start`.",
                        self.domain
                    ),
                ));
            }
            attempts += 1;
            self.clock.sleep(BOOTSTRAP_RETRY_DELAY);
        }
    }

    /// Waits until `print` no longer finds the job. A failing `print` is the proof: it is the only
    /// signal that launchd has finished, and any failure means the job is not there to be held.
    fn wait_until_dropped(&self) -> Result<(), ServiceError> {
        let mut observed = "launchd still lists it".to_owned();
        let dropped = poll_until(self.clock, STOP_WAIT, POLL, || {
            let attempt = self.launchctl(&["print", &self.target])?;
            if attempt.succeeded() {
                observed = format!(
                    "launchd still lists it, {}",
                    describe(&parse_job(&attempt.output.stdout))
                );
                Ok(None)
            } else {
                Ok(Some(()))
            }
        })?;
        match dropped {
            Some(()) => Ok(()),
            None => Err(ServiceError::StopTimedOut {
                service: self.target.clone(),
                waited: STOP_WAIT,
                observed,
                hint: format!(
                    "launchd is still tearing the job down. Wait a few seconds and run \
                     `launchctl print {}` until it says it could not find the service, then run \
                     the operation again.",
                    self.target
                ),
            }),
        }
    }

    /// Waits until launchd has finished taking the job down: it is gone, or it has settled into
    /// another state (a `kickstart -k` restart respawns it, so `print` never fails).
    fn wait_out_teardown(&self) -> Result<Observed, ServiceError> {
        let mut observed = "launchd does not say".to_owned();
        let settled = poll_until(self.clock, STOP_WAIT, POLL, || {
            let now = self.observe()?;
            match &now {
                Observed::Loaded(job) if job.is_tearing_down() => {
                    observed = describe(job);
                    Ok(None)
                }
                _ => Ok(Some(now)),
            }
        })?;
        settled.ok_or_else(|| ServiceError::StartTimedOut {
            service: self.target.clone(),
            waited: STOP_WAIT,
            observed,
            hint: format!(
                "launchd is still taking the job down. Wait a few seconds and run `launchctl \
                 print {}` until it says it could not find the service or shows a state other \
                 than SIGTERMed, then run the operation again.",
                self.target
            ),
        })
    }

    /// Waits until launchd reports a process for the job.
    fn wait_until_running(&self) -> Result<StartOutcome, ServiceError> {
        let mut observed = "launchd does not list it".to_owned();
        let started = poll_until(self.clock, START_WAIT, POLL, || {
            let attempt = self.launchctl(&["print", &self.target])?;
            if attempt.succeeded() {
                let job = parse_job(&attempt.output.stdout);
                if job.is_running() {
                    return Ok(Some(StartOutcome { pid: job.pid }));
                }
                observed = describe(&job);
                return Ok(None);
            }
            if attempt.code() == SERVICE_NOT_FOUND {
                observed = "launchd does not list it".to_owned();
                return Ok(None);
            }
            Err(self.refused(&attempt, self.inspect_hint()))
        })?;
        started.ok_or_else(|| ServiceError::StartTimedOut {
            service: self.target.clone(),
            waited: START_WAIT,
            observed,
            hint: format!(
                "Check `launchctl print {}` and the Daemon's log, `daemon.log` in its state \
                 directory.",
                self.target
            ),
        })
    }
}

impl SupervisorService for Launchd<'_> {
    fn state(&self) -> Result<ServiceState, ServiceError> {
        Ok(self.observe()?.state())
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        let job = match self.observe()? {
            Observed::Loaded(job) => job,
            other => {
                return Ok(StopOutcome {
                    before: other.state(),
                });
            }
        };
        let outcome = StopOutcome {
            before: ServiceState::Running { pid: job.pid },
        };
        // A loaded job is booted out whether or not it has a process: launchd respawns a
        // `KeepAlive` job that has none.
        let bootout = self.launchctl(&["bootout", &self.target])?;
        if bootout.succeeded() {
            self.wait_until_dropped()?;
            return Ok(outcome);
        }
        if matches!(bootout.code(), NO_SUCH_PROCESS | SERVICE_NOT_FOUND) {
            // The job left between the query and the bootout.
            return Ok(outcome);
        }
        // A refused bootout is a stop only when a fresh query proves the job gone
        // (launchd-job.ts:96); a query that fails leaves the bootout's own refusal to report.
        match self.observe() {
            Ok(Observed::Unloaded | Observed::NotInstalled) => Ok(outcome),
            Ok(Observed::Loaded(_)) | Err(_) => Err(self.refused(&bootout, self.inspect_hint())),
        }
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        let mut observed = self.observe()?;
        if matches!(&observed, Observed::Loaded(job) if job.is_tearing_down()) {
            // Bootstrapping now would be refused, or would find the label loaded and skip it:
            // the 2026-09-17 failure. Wait for the teardown to end, whichever way it ends.
            observed = self.wait_out_teardown()?;
        }
        match observed {
            Observed::NotInstalled => {
                return Err(ServiceError::NotInstalled {
                    service: self.label.clone(),
                });
            }
            Observed::Loaded(job) if job.is_running() => {
                return Ok(StartOutcome { pid: job.pid });
            }
            Observed::Loaded(_) => {
                let attempt = self.launchctl(&["kickstart", &self.target])?;
                if !attempt.succeeded() {
                    return Err(self.refused(&attempt, self.inspect_hint()));
                }
            }
            Observed::Unloaded => self.bootstrap()?,
        }
        self.wait_until_running()
    }
}

/// The user id launchd's desktop domain `gui/<uid>` is named after: `getuid`. Windows has none.
pub fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: getuid(2) takes no arguments and cannot fail.
        Some(unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

enum Observed {
    NotInstalled,
    /// Not loaded, plist on disk.
    Unloaded,
    Loaded(Job),
}

impl Observed {
    fn state(&self) -> ServiceState {
        match self {
            Self::NotInstalled => ServiceState::NotInstalled,
            Self::Unloaded => ServiceState::Stopped,
            // Loaded is held, whether or not launchd has a process for it this instant.
            Self::Loaded(job) => ServiceState::Running { pid: job.pid },
        }
    }
}

/// What `launchctl print` says about a loaded job.
#[derive(Debug, Default, PartialEq, Eq)]
struct Job {
    state: Option<String>,
    pid: Option<u32>,
    last_exit: Option<String>,
}

impl Job {
    /// launchd is taking the job down: `SIGTERMed`, or `SIGKILLed` once its exit timeout passed.
    fn is_tearing_down(&self) -> bool {
        self.state
            .as_deref()
            .is_some_and(|state| state.starts_with("SIG"))
    }

    /// A process launchd runs for the job. Its pid, or its `running` state, counts; a pid that
    /// belongs to a job being torn down does not.
    fn is_running(&self) -> bool {
        !self.is_tearing_down() && (self.pid.is_some() || self.state.as_deref() == Some("running"))
    }
}

/// Reads the job's own `state`, `pid`, and `last exit code` from `launchctl print`. Those are the
/// lines indented by exactly one tab; deeper lines belong to nested blocks (`resource coalition`
/// has its own `state` and `pid`).
fn parse_job(output: &str) -> Job {
    let mut job = Job::default();
    for line in output.lines() {
        let Some(field) = line.strip_prefix('\t') else {
            continue;
        };
        if field.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = field.split_once(" = ") else {
            continue;
        };
        let value = value.trim();
        match key {
            "state" => job.state = Some(value.to_owned()),
            "pid" => job.pid = value.parse().ok(),
            "last exit code" => job.last_exit = Some(value.to_owned()),
            _ => {}
        }
    }
    job
}

/// What launchd says about a job that has no process, in its own words.
fn describe(job: &Job) -> String {
    let mut parts = Vec::new();
    if let Some(state) = &job.state {
        parts.push(format!("state = {state}"));
    }
    if let Some(exit) = &job.last_exit {
        parts.push(format!("last exit code = {exit}"));
    }
    if parts.is_empty() {
        "launchd reports no state for it".to_owned()
    } else {
        format!("launchd reports {}", parts.join(", "))
    }
}

#[cfg(test)]
mod tests;
