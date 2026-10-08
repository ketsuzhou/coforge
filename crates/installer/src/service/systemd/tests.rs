use std::time::Duration;

use super::*;
use crate::clock::VirtualClock;
use crate::service::fakes::{ScriptedRunner, Step, cannot_run, exits, ok};
use crate::service::{
    RunError, ServiceState, StartOutcome, SupervisorService, coordinator_service,
};

const UNIT: &str = "coforge-daemon.service";
const SHOW: &str = "systemctl --user show coforge-daemon.service --property=LoadState \
                    --property=ActiveState --property=SubState --property=MainPID";
const STOP: &str = "systemctl --user stop coforge-daemon.service";
const START: &str = "systemctl --user start coforge-daemon.service";
const RESET: &str = "systemctl --user reset-failed coforge-daemon.service";
const POLL: Duration = Duration::from_millis(50);

const NO_BUS: &str = "Failed to connect to bus: No medium found\n";

/// `systemctl show` output. systemd prints the properties in its own order, not the requested one.
fn shown(load: &str, active: &str, sub: &str, pid: u32) -> String {
    format!("MainPID={pid}\nLoadState={load}\nActiveState={active}\nSubState={sub}\n")
}

fn running(pid: u32) -> Step {
    ok(SHOW, &shown("loaded", "active", "running", pid))
}

fn stopped() -> Step {
    ok(SHOW, &shown("loaded", "inactive", "dead", 0))
}

fn deactivating(pid: u32) -> Step {
    ok(SHOW, &shown("loaded", "deactivating", "stop-sigterm", pid))
}

/// The unit crashed and systemd is waiting out `RestartSec`: active-ish, no process.
fn waiting_to_restart() -> Step {
    ok(SHOW, &shown("loaded", "activating", "auto-restart", 0))
}

struct Scenario {
    runner: ScriptedRunner,
    clock: VirtualClock,
}

impl Scenario {
    fn new(script: Vec<Step>) -> Self {
        Self {
            runner: ScriptedRunner::new(script),
            clock: VirtualClock::new(),
        }
    }

    fn systemd(&self) -> SystemdUser<'_> {
        SystemdUser::new(&self.runner, &self.clock, &coordinator_service()).unwrap()
    }
}

#[test]
fn a_unit_systemd_has_not_found_is_not_installed() {
    let scenario = Scenario::new(vec![ok(SHOW, &shown("not-found", "inactive", "dead", 0))]);
    assert_eq!(
        scenario.systemd().state().unwrap(),
        ServiceState::NotInstalled
    );
}

#[test]
fn an_inactive_or_failed_unit_is_stopped() {
    let scenario = Scenario::new(vec![stopped()]);
    assert_eq!(scenario.systemd().state().unwrap(), ServiceState::Stopped);

    let scenario = Scenario::new(vec![ok(SHOW, &shown("loaded", "failed", "failed", 0))]);
    assert_eq!(scenario.systemd().state().unwrap(), ServiceState::Stopped);
}

#[test]
fn an_active_unit_reports_its_main_pid() {
    let scenario = Scenario::new(vec![running(1234)]);
    assert_eq!(
        scenario.systemd().state().unwrap(),
        ServiceState::Running { pid: Some(1234) }
    );
}

#[test]
fn a_unit_waiting_to_restart_is_running_with_no_pid() {
    let scenario = Scenario::new(vec![waiting_to_restart()]);
    assert_eq!(
        scenario.systemd().state().unwrap(),
        ServiceState::Running { pid: None }
    );
}

#[test]
fn no_user_bus_is_reported_as_no_user_session_with_the_way_out() {
    // 2026-09-20, s144: a `su` shell has no XDG_RUNTIME_DIR, so every `systemctl --user` failed
    // with this line while the Computer ran fine under the unit.
    let scenario = Scenario::new(vec![exits(SHOW, 1, NO_BUS)]);
    let error = scenario.systemd().state().unwrap_err();
    assert!(
        matches!(&error, ServiceError::NoSystemdUserSession { command, diagnostic }
            if command == SHOW && diagnostic == "Failed to connect to bus: No medium found"),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(
        message.contains("Failed to connect to bus: No medium found."),
        "{message}"
    );
    assert!(message.contains("no systemd user session"), "{message}");
    assert!(message.contains("`su` or `sudo`"), "{message}");
    assert!(message.contains("ssh <user>@<host>"), "{message}");
    assert!(message.contains("machinectl shell <user>@"), "{message}");
}

#[test]
fn systemd_257_words_the_missing_session_differently_and_it_is_still_that_failure() {
    // Measured on 2026-09-30 against systemd 257 (Debian 13) in a shell with no XDG_RUNTIME_DIR:
    // the older "Failed to connect to bus" is gone from this message.
    let scenario = Scenario::new(vec![exits(
        SHOW,
        1,
        "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and \
         $XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to \
         bus of other user)\n",
    )]);
    let error = scenario.systemd().state().unwrap_err();
    assert!(
        matches!(error, ServiceError::NoSystemdUserSession { .. }),
        "{error:?}"
    );
}

#[test]
fn a_bus_that_cannot_be_reached_stops_a_stop_before_it_changes_anything() {
    let scenario = Scenario::new(vec![exits(
        SHOW,
        1,
        "Failed to connect to bus: No such file or directory\n",
    )]);
    let error = scenario.systemd().stop().unwrap_err();
    assert!(
        matches!(error, ServiceError::NoSystemdUserSession { .. }),
        "{error:?}"
    );
    assert_eq!(scenario.runner.ran(), vec![SHOW]);
}

#[test]
fn a_missing_systemctl_is_named() {
    let scenario = Scenario::new(vec![cannot_run(SHOW, RunError::NotFound)]);
    assert_eq!(
        scenario.systemd().state().unwrap_err(),
        ServiceError::ToolMissing {
            program: "systemctl".to_owned()
        }
    );
}

#[test]
fn output_without_a_unit_state_is_not_guessed_at() {
    let scenario = Scenario::new(vec![ok(SHOW, "Something=else\n")]);
    let error = scenario.systemd().state().unwrap_err();
    assert!(
        matches!(error, ServiceError::UnexpectedOutput { .. }),
        "{error:?}"
    );
}

#[test]
fn stop_asks_systemd_then_checks_the_unit_is_inactive() {
    let scenario = Scenario::new(vec![running(1234), ok(STOP, ""), stopped()]);
    let outcome = scenario.systemd().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: Some(1234) });
    assert_eq!(scenario.runner.ran(), vec![SHOW, STOP, SHOW]);
    assert_eq!(scenario.clock.sleeps(), Vec::<Duration>::new());
}

#[test]
fn stop_waits_out_a_unit_that_is_still_deactivating() {
    let scenario = Scenario::new(vec![
        running(1234),
        ok(STOP, ""),
        deactivating(1234).times(2),
        stopped(),
    ]);
    scenario.systemd().stop().unwrap();
    assert_eq!(scenario.clock.sleeps(), vec![POLL, POLL]);
}

#[test]
fn stop_cancels_a_restart_systemd_is_waiting_out() {
    // A crashed daemon is `activating (auto-restart)` with no process. Skipping it would let
    // systemd start the old binary again under the upgrade.
    let scenario = Scenario::new(vec![waiting_to_restart(), ok(STOP, ""), stopped()]);
    let outcome = scenario.systemd().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: None });
}

#[test]
fn stopping_what_is_not_running_or_not_there_runs_no_stop() {
    let scenario = Scenario::new(vec![stopped()]);
    assert_eq!(
        scenario.systemd().stop().unwrap().before,
        ServiceState::Stopped
    );
    assert_eq!(scenario.runner.ran(), vec![SHOW]);

    let scenario = Scenario::new(vec![ok(SHOW, &shown("not-found", "inactive", "dead", 0))]);
    assert_eq!(
        scenario.systemd().stop().unwrap().before,
        ServiceState::NotInstalled
    );
    assert_eq!(scenario.runner.ran(), vec![SHOW]);
}

#[test]
fn stop_gives_up_after_fifteen_seconds_and_says_what_systemd_reports() {
    let scenario = Scenario::new(vec![
        running(1234),
        ok(STOP, ""),
        deactivating(1234).forever(),
    ]);
    let error = scenario.systemd().stop().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StopTimedOut { waited, service, .. }
            if *waited == Duration::from_secs(15) && service == UNIT),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains("ActiveState=deactivating"), "{message}");
    assert!(message.contains("SubState=stop-sigterm"), "{message}");
    assert!(
        message.contains("systemctl --user status coforge-daemon.service"),
        "{message}"
    );
}

#[test]
fn a_refused_stop_carries_systemds_words_and_the_command_to_run() {
    let scenario = Scenario::new(vec![
        running(1234),
        exits(
            STOP,
            1,
            "Failed to stop coforge-daemon.service: Interactive authentication required.\n",
        ),
    ]);
    let error = scenario.systemd().stop().unwrap_err();
    let message = error.to_string();
    assert!(message.contains(STOP), "{message}");
    assert!(message.contains("(1)"), "{message}");
    assert!(
        message.contains("Interactive authentication required."),
        "{message}"
    );
    assert!(
        message.contains("systemctl --user status coforge-daemon.service"),
        "{message}"
    );
}

#[test]
fn the_stop_verb_gets_longer_than_systemds_own_ninety_second_stop_timeout() {
    let scenario = Scenario::new(vec![running(1234), ok(STOP, ""), stopped()]);
    scenario.systemd().stop().unwrap();
    assert_eq!(scenario.runner.longest_timeout(), Duration::from_secs(120));
}

#[test]
fn start_asks_systemd_then_waits_for_an_active_unit_with_a_process() {
    let scenario = Scenario::new(vec![
        stopped(),
        ok(RESET, ""),
        ok(START, ""),
        waiting_to_restart(),
        running(4321),
    ]);
    assert_eq!(
        scenario.systemd().start().unwrap(),
        StartOutcome { pid: Some(4321) }
    );
    assert_eq!(scenario.clock.sleeps(), vec![POLL]);
}

#[test]
fn a_failed_unit_is_reset_before_it_is_started_and_a_refused_reset_is_ignored() {
    // As the Computer's own `restart` does (systemd-user.ts:93-97): a unit that hit its start
    // limit refuses `start` until its failed state is cleared, and there is usually nothing to
    // clear, so the reset's own answer means nothing.
    let scenario = Scenario::new(vec![
        ok(SHOW, &shown("loaded", "failed", "failed", 0)),
        exits(
            RESET,
            1,
            "Failed to reset failed state of unit: Unit not loaded.\n",
        ),
        ok(START, ""),
        running(4321),
    ]);
    assert_eq!(
        scenario.systemd().start().unwrap(),
        StartOutcome { pid: Some(4321) }
    );
    assert_eq!(scenario.runner.ran(), vec![SHOW, RESET, START, SHOW]);
}

#[test]
fn starting_an_active_unit_runs_nothing_more() {
    let scenario = Scenario::new(vec![running(1234)]);
    assert_eq!(
        scenario.systemd().start().unwrap(),
        StartOutcome { pid: Some(1234) }
    );
    assert_eq!(scenario.runner.ran(), vec![SHOW]);
}

#[test]
fn starting_a_unit_that_is_not_installed_says_how_to_install_it() {
    let scenario = Scenario::new(vec![ok(SHOW, &shown("not-found", "inactive", "dead", 0))]);
    let error = scenario.systemd().start().unwrap_err();
    assert_eq!(
        error,
        ServiceError::NotInstalled {
            service: UNIT.to_owned()
        }
    );
    assert!(error.to_string().contains("coforge-computer start"));
    assert_eq!(scenario.runner.ran(), vec![SHOW]);
}

#[test]
fn a_unit_that_vanishes_before_the_start_is_not_installed() {
    let scenario = Scenario::new(vec![
        stopped(),
        ok(RESET, ""),
        exits(
            START,
            5,
            "Failed to start coforge-daemon.service: Unit coforge-daemon.service not found.\n",
        ),
    ]);
    assert_eq!(
        scenario.systemd().start().unwrap_err(),
        ServiceError::NotInstalled {
            service: UNIT.to_owned()
        }
    );
}

#[test]
fn a_refused_start_carries_systemds_words_and_the_command_to_run() {
    let scenario = Scenario::new(vec![
        stopped(),
        ok(RESET, ""),
        exits(
            START,
            1,
            "Failed to start coforge-daemon.service: Start request repeated too quickly.\n",
        ),
    ]);
    let message = scenario.systemd().start().unwrap_err().to_string();
    assert!(message.contains(START), "{message}");
    assert!(
        message.contains("Start request repeated too quickly."),
        "{message}"
    );
    assert!(
        message.contains("systemctl --user status coforge-daemon.service"),
        "{message}"
    );
}

#[test]
fn start_gives_up_after_ten_seconds_and_points_at_the_journal() {
    let scenario = Scenario::new(vec![
        stopped(),
        ok(RESET, ""),
        ok(START, ""),
        waiting_to_restart().forever(),
    ]);
    let error = scenario.systemd().start().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StartTimedOut { waited, .. } if *waited == Duration::from_secs(10)),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains("ActiveState=activating"), "{message}");
    assert!(message.contains("SubState=auto-restart"), "{message}");
    assert!(
        message.contains("journalctl --user -u coforge-daemon.service"),
        "{message}"
    );
}

#[test]
fn a_unit_name_the_contract_cannot_have_is_refused() {
    let scenario = Scenario::new(vec![]);
    for bad in [
        "../evil.service",
        "coforge-daemon",
        "",
        "a b.service",
        "-x.service",
    ] {
        let mut names = coordinator_service();
        names.systemd_user_unit = bad.to_owned();
        let refused = SystemdUser::new(&scenario.runner, &scenario.clock, &names);
        assert!(
            matches!(refused, Err(ServiceError::InvalidIdentity { .. })),
            "{bad:?}"
        );
    }
}
