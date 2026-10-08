//! The systemd backend (Linux): the user unit `coforge-daemon.service`, under `systemctl --user`.
//!
//! Ported from `SystemdUserDaemonHost` (packages/daemon/src/daemon-host/systemd-user.ts).
//! `systemctl stop` and `start` wait for their job, so there is no launchd-style race, but the
//! state is still read back: stopped is `inactive` or `failed`, started is `active` with a main
//! process. A start is preceded by `reset-failed`, as the Computer's own `restart` does.
//!
//! `systemctl --user` needs this user's session bus, which a `su` or `sudo` shell never has. That
//! failure (2026-09-20) reads like nothing else, so it has its own error with the way out.

use std::time::Duration;

use super::{
    Attempt, CommandLine, CommandRunner, ServiceError, ServiceState, StartOutcome, StopOutcome,
    SupervisorService, execute,
};
use crate::clock::{Clock, poll_until};
use crate::contract::CoordinatorService;

const SYSTEMCTL: &str = "systemctl";

const COMMAND_BOUND: Duration = Duration::from_secs(30);
/// `systemctl stop` returns when the unit is down, and systemd's own `TimeoutStopSec` (90 s by
/// default) ends a unit that will not go. The bound is above it so systemd, not the installer,
/// has the last word on a slow stop.
const STOP_BOUND: Duration = Duration::from_secs(120);
/// After a `stop` that has already returned: the unit should be inactive at once.
const STOP_WAIT: Duration = Duration::from_secs(15);
const START_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(50);

pub struct SystemdUser<'a> {
    runner: &'a dyn CommandRunner,
    clock: &'a dyn Clock,
    unit: String,
}

impl<'a> SystemdUser<'a> {
    pub fn new(
        runner: &'a dyn CommandRunner,
        clock: &'a dyn Clock,
        service: &CoordinatorService,
    ) -> Result<Self, ServiceError> {
        let unit = &service.systemd_user_unit;
        if !is_valid_unit_name(unit) {
            return Err(ServiceError::InvalidIdentity {
                what: "systemd user unit",
                value: unit.clone(),
            });
        }
        Ok(Self {
            runner,
            clock,
            unit: unit.clone(),
        })
    }

    fn systemctl(&self, verb: &str, bound: Duration) -> Result<Attempt, ServiceError> {
        execute(
            self.runner,
            CommandLine::new(SYSTEMCTL, ["--user", verb, &self.unit]),
            bound,
        )
    }

    /// What systemd says about the unit, in one read-only call.
    fn read(&self) -> Result<Unit, ServiceError> {
        let attempt = execute(
            self.runner,
            CommandLine::new(
                SYSTEMCTL,
                [
                    "--user",
                    "show",
                    &self.unit,
                    "--property=LoadState",
                    "--property=ActiveState",
                    "--property=SubState",
                    "--property=MainPID",
                ],
            ),
            COMMAND_BOUND,
        )?;
        if !attempt.succeeded() {
            return Err(self.refused(&attempt));
        }
        parse_unit(&attempt)
    }

    /// systemd's refusal, turned into what a person should do next. Ported from `systemctlFailure`
    /// and `systemctlRemedy` (systemd-user.ts).
    fn refused(&self, attempt: &Attempt) -> ServiceError {
        let diagnostic = attempt.diagnostic();
        let lowered = diagnostic.to_lowercase();
        // The first three are older systemd releases' wording (the Computer's own hosts match the
        // first two); systemd 257 says the fourth, measured 2026-09-30.
        if [
            "failed to connect to bus",
            "no medium found",
            "failed to get d-bus connection",
            "failed to connect to user scope bus",
        ]
        .iter()
        .any(|needle| lowered.contains(needle))
        {
            return ServiceError::NoSystemdUserSession {
                command: attempt.command_text(),
                diagnostic,
            };
        }
        if ["not loaded", "not found", "no such unit"]
            .iter()
            .any(|needle| lowered.contains(needle))
        {
            return ServiceError::NotInstalled {
                service: self.unit.clone(),
            };
        }
        ServiceError::CommandFailed {
            command: attempt.command_text(),
            code: attempt.code(),
            diagnostic,
            hint: format!(
                "Check `systemctl --user status {}` for the unit's own account of it.",
                self.unit
            ),
        }
    }

    fn status_hint(&self) -> String {
        format!(
            "Check `systemctl --user status {}` and `journalctl --user -u {} -n 50` for the \
             unit's own account of it.",
            self.unit, self.unit
        )
    }
}

impl SupervisorService for SystemdUser<'_> {
    fn state(&self) -> Result<ServiceState, ServiceError> {
        Ok(self.read()?.state())
    }

    fn stop(&self) -> Result<StopOutcome, ServiceError> {
        let unit = self.read()?;
        let before = unit.state();
        // Stopped is `inactive` or `failed`; anything else, including a unit waiting out its
        // restart delay, has a job to cancel.
        if !matches!(before, ServiceState::Running { .. }) {
            return Ok(StopOutcome { before });
        }
        let stop = self.systemctl("stop", STOP_BOUND)?;
        if !stop.succeeded() {
            return Err(self.refused(&stop));
        }
        let mut observed = String::new();
        let down = poll_until(self.clock, STOP_WAIT, POLL, || {
            let unit = self.read()?;
            if matches!(unit.state(), ServiceState::Running { .. }) {
                observed = unit.describe();
                Ok(None)
            } else {
                Ok(Some(()))
            }
        })?;
        match down {
            Some(()) => Ok(StopOutcome { before }),
            None => Err(ServiceError::StopTimedOut {
                service: self.unit.clone(),
                waited: STOP_WAIT,
                observed,
                hint: self.status_hint(),
            }),
        }
    }

    fn start(&self) -> Result<StartOutcome, ServiceError> {
        let unit = self.read()?;
        if unit.load_state == "not-found" {
            return Err(ServiceError::NotInstalled {
                service: self.unit.clone(),
            });
        }
        if unit.is_up() {
            return Ok(StartOutcome { pid: unit.main_pid });
        }
        // As the Computer's own `restart` does (systemd-user.ts:93-97): a unit that hit its start
        // limit refuses `start` until its failed state is cleared. Usually there is nothing to
        // clear, so the answer is ignored, whatever it is.
        let _ = self.systemctl("reset-failed", COMMAND_BOUND);
        let start = self.systemctl("start", COMMAND_BOUND)?;
        if !start.succeeded() {
            return Err(self.refused(&start));
        }
        let mut observed = String::new();
        let started = poll_until(self.clock, START_WAIT, POLL, || {
            let unit = self.read()?;
            if unit.is_up() {
                return Ok(Some(StartOutcome { pid: unit.main_pid }));
            }
            observed = unit.describe();
            Ok(None)
        })?;
        started.ok_or_else(|| ServiceError::StartTimedOut {
            service: self.unit.clone(),
            waited: START_WAIT,
            observed,
            hint: self.status_hint(),
        })
    }
}

/// The properties of a unit, from `systemctl show`.
#[derive(Debug)]
struct Unit {
    load_state: String,
    active_state: String,
    sub_state: String,
    main_pid: Option<u32>,
}

impl Unit {
    fn state(&self) -> ServiceState {
        if self.load_state == "not-found" {
            ServiceState::NotInstalled
        } else if matches!(self.active_state.as_str(), "inactive" | "failed") {
            ServiceState::Stopped
        } else {
            ServiceState::Running { pid: self.main_pid }
        }
    }

    /// The unit is up: active, with a main process.
    fn is_up(&self) -> bool {
        self.active_state == "active" && self.main_pid.is_some()
    }

    fn describe(&self) -> String {
        format!(
            "systemd reports LoadState={}, ActiveState={}, SubState={}",
            self.load_state, self.active_state, self.sub_state
        )
    }
}

fn parse_unit(attempt: &Attempt) -> Result<Unit, ServiceError> {
    let mut load_state = None;
    let mut active_state = None;
    let mut sub_state = String::new();
    let mut main_pid = None;
    for line in attempt.output.stdout.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key {
            "LoadState" => load_state = Some(value.to_owned()),
            "ActiveState" => active_state = Some(value.to_owned()),
            "SubState" => sub_state = value.to_owned(),
            "MainPID" => main_pid = value.parse::<u32>().ok().filter(|pid| *pid > 0),
            _ => {}
        }
    }
    match (load_state, active_state) {
        (Some(load_state), Some(active_state)) => Ok(Unit {
            load_state,
            active_state,
            sub_state,
            main_pid,
        }),
        _ => Err(ServiceError::UnexpectedOutput {
            command: attempt.command_text(),
            output: attempt.output.stdout.clone(),
        }),
    }
}

/// A `.service` unit name systemd accepts and the shell cannot misread
/// (`isValidServiceName`, systemd-user.ts).
fn is_valid_unit_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".service") else {
        return false;
    };
    name.len() <= 255
        && stem
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | ':' | '-'))
}

#[cfg(test)]
mod tests;
