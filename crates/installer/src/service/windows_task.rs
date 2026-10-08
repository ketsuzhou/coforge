//! The Windows backend: the scheduled task `CoForge Daemon`, under `schtasks`.
//!
//! Ported from `WindowsUserDaemonHost` (packages/daemon/src/daemon-host/windows-task.ts): `/End`
//! stops the task's process, `/Run` starts it.
//!
//! The Computer also re-registers the task from XML before every run (`/Create /XML /F`); the
//! installer does not. The XML is built from the executable, socket, and state paths and the
//! daemon connection endpoint, which only the Computer knows, and it does not change between
//! versions: its action runs `install/active/coforge-computer.exe`, and the `active` junction is
//! what an upgrade moves. A task that is missing is [`ServiceError::NotInstalled`], and
//! `coforge-computer start` registers it again.
//!
//! The Computer's stop gives the daemon no grace on Windows, and neither does this: `/End`
//! terminates the task's process outright (the task XML sets `AllowHardTerminate`), so there is
//! nothing to wait for and no way to ask first.
//!
//! The tools are run from `%SystemRoot%\System32`, never found through `PATH`.
//!
//! The Computer never asks Task Scheduler for a state, so this is new. `schtasks /Query`
//! translates its labels and its `Status` values into the Windows display language, so nothing it
//! prints can be matched. `Get-ScheduledTask` returns the `State` enum, whose names PowerShell
//! prints identically everywhere, and the script exits 3 itself for a task that is not
//! registered, so "absent" never depends on parsing an error message.
//!
//! What this cannot know: `/End` "stops only the instances of a program started by a scheduled
//! task" (Microsoft Learn), so a task whose action was a `cmd.exe` wrapper can end while the
//! Computer it launched keeps running, and Task Scheduler exposes no process id. Whether the
//! product's processes are gone is [`crate::processes`], not this module.

use std::time::Duration;

use super::{
    Attempt, CommandLine, CommandRunner, ServiceError, ServiceState, StartOutcome, StopOutcome,
    SupervisorService, execute,
};
use crate::clock::{Clock, poll_until};
use crate::contract::CoordinatorService;

const COMMAND_BOUND: Duration = Duration::from_secs(30);
const STOP_WAIT: Duration = Duration::from_secs(15);
const START_WAIT: Duration = Duration::from_secs(10);
/// Each poll starts a PowerShell, which takes a good fraction of a second by itself.
const POLL: Duration = Duration::from_millis(500);

/// The exit status the query script gives a task that is not registered.
const TASK_NOT_REGISTERED: i32 = 3;

pub struct WindowsTask<'a> {
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
    task: String,
    powershell: String,
    schtasks: String,
}

impl<'a> WindowsTask<'a> {
    /// `system_root` is `%SystemRoot%`, where PowerShell and `schtasks` live.
    pub fn new(
        runner: &'a dyn CommandRunner,
        clock: &'a dyn Clock,
        service: &CoordinatorService,
        system_root: &str,
    ) -> Result<Self, ServiceError> {
        let task = &service.windows_task;
        // The name is spliced into a PowerShell script, so only what cannot end its string is
        // accepted. Task names may hold more; the Computer's does not.
        let valid = task.len() <= 238
            && task
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric())
            && task
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
        if !valid {
            return Err(ServiceError::InvalidIdentity {
                what: "Windows task",
                value: task.clone(),
            });
        }
        // Built with backslashes whatever the host: this is a Windows path.
        let system_root = system_root.replace('/', "\\");
        let system32 = format!(r"{}\System32", system_root.trim_end_matches('\\'));
        Ok(Self {
            runner,
            clock,
            task: task.clone(),
            powershell: format!(r"{system32}\WindowsPowerShell\v1.0\powershell.exe"),
            schtasks: format!(r"{system32}\schtasks.exe"),
        })
    }

    fn schtasks(&self, verb: &str) -> Result<Attempt, ServiceError> {
        execute(
            self.runner,
            CommandLine::new(&self.schtasks, [verb, "/TN", &self.task]),
            COMMAND_BOUND,
        )
    }

    /// `None` when the task is not registered.
    fn read(&self) -> Result<Option<TaskState>, ServiceError> {
        let script = format!(
            "$ErrorActionPreference = 'Stop'; \
             $task = Get-ScheduledTask -TaskPath '\\' | Where-Object {{ $_.TaskName -eq '{}' }}; \
             if ($null -eq $task) {{ exit {TASK_NOT_REGISTERED} }}; $task.State.ToString()",
            self.task
        );
        let attempt = execute(
            self.runner,
            CommandLine::new(
                &self.powershell,
                ["-NoProfile", "-NonInteractive", "-Command", &script],
            ),
            COMMAND_BOUND,
        )?;
        match attempt.code() {
            0 => TaskState::parse(&attempt).map(Some),
            TASK_NOT_REGISTERED => Ok(None),
            _ => Err(self.refused(&attempt)),
        }
    }

    fn refused(&self, attempt: &Attempt) -> ServiceError {
        ServiceError::CommandFailed {
            command: attempt.command_text(),
            code: attempt.code(),
            diagnostic: attempt.diagnostic(),
            hint: self.query_hint(),
        }
    }

    fn query_hint(&self) -> String {
        format!(
            "Run `schtasks /Query /TN \"{}\" /V /FO LIST` yourself for the task's own state.",
            self.task
        )
    }
}

impl SupervisorService for WindowsTask<'_> {
    fn state(&self) -> Result<ServiceState, ServiceError> {
        Ok(state_of(self.read()?))
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        let before = state_of(self.read()?);
        if !matches!(before, ServiceState::Running { .. }) {
            return Ok(StopOutcome { before });
        }
        let end = self.schtasks("/End")?;
        if !end.succeeded() {
            // `/End` of a task with no running instance is refused too; the task may have ended
            // by itself since the query.
            return match self.read() {
                Ok(state) if !matches!(state_of(state), ServiceState::Running { .. }) => {
                    Ok(StopOutcome { before })
                }
                _ => Err(self.refused(&end)),
            };
        }
        let mut observed = String::new();
        let ended = poll_until(self.clock, STOP_WAIT, POLL, || {
            let state = self.read()?;
            if matches!(state_of(state), ServiceState::Running { .. }) {
                observed = describe(state);
                Ok(None)
            } else {
                Ok(Some(()))
            }
        })?;
        match ended {
            Some(()) => Ok(StopOutcome { before }),
            None => Err(ServiceError::StopTimedOut {
                service: self.task.clone(),
                waited: STOP_WAIT,
                observed,
                hint: format!(
                    "The task still has a running instance. Run `schtasks /End /TN \"{}\"` \
                     yourself, or end the Computer's processes in Task Manager, then run the \
                     operation again.",
                    self.task
                ),
            }),
        }
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        match self.read()? {
            None => {
                return Err(ServiceError::NotInstalled {
                    service: self.task.clone(),
                });
            }
            // `/Run` refuses a disabled task with a message in the display language.
            Some(TaskState::Disabled) => {
                return Err(ServiceError::TaskDisabled {
                    task: self.task.clone(),
                });
            }
            Some(TaskState::Running) => return Ok(StartOutcome { pid: None }),
            Some(_) => {}
        }
        let run = self.schtasks("/Run")?;
        if !run.succeeded() {
            return Err(self.refused(&run));
        }
        let mut observed = String::new();
        let started = poll_until(self.clock, START_WAIT, POLL, || {
            let state = self.read()?;
            if state == Some(TaskState::Running) {
                return Ok(Some(StartOutcome { pid: None }));
            }
            observed = describe(state);
            Ok(None)
        })?;
        started.ok_or_else(|| ServiceError::StartTimedOut {
            service: self.task.clone(),
            waited: START_WAIT,
            observed,
            hint: self.query_hint(),
        })
    }
}

/// Task Scheduler's `TASK_STATE` (Microsoft Learn: RegisteredTask.State), without `Unknown`,
/// which is refused rather than guessed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskState {
    Disabled,
    Queued,
    Ready,
    Running,
}

impl TaskState {
    fn parse(attempt: &Attempt) -> Result<Self, ServiceError> {
        match attempt.output.stdout.trim() {
            "Disabled" => Ok(Self::Disabled),
            "Queued" => Ok(Self::Queued),
            "Ready" => Ok(Self::Ready),
            "Running" => Ok(Self::Running),
            _ => Err(ServiceError::UnexpectedOutput {
                command: attempt.command_text(),
                output: attempt.output.stdout.clone(),
            }),
        }
    }
}

/// A queued instance is on its way to running, like a launchd job between respawns.
fn state_of(state: Option<TaskState>) -> ServiceState {
    match state {
        None => ServiceState::NotInstalled,
        Some(TaskState::Ready | TaskState::Disabled) => ServiceState::Stopped,
        Some(TaskState::Running | TaskState::Queued) => ServiceState::Running { pid: None },
    }
}

fn describe(state: Option<TaskState>) -> String {
    match state {
        None => "Task Scheduler no longer lists the task".to_owned(),
        Some(state) => format!("Task Scheduler reports the task is {state:?}"),
    }
}

#[cfg(test)]
mod tests;
