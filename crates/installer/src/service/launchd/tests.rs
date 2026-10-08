use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use super::*;
use crate::clock::VirtualClock;
use crate::service::fakes::{ScriptedRunner, Step, cannot_run, exits, ok};
use crate::service::{RunError, coordinator_service};
use crate::test_support::Scratch;

const LABEL: &str = "cn.coforge.computer.daemon";
const PRINT: &str = "/bin/launchctl print gui/501/cn.coforge.computer.daemon";
const BOOTOUT: &str = "/bin/launchctl bootout gui/501/cn.coforge.computer.daemon";
const KICKSTART: &str = "/bin/launchctl kickstart gui/501/cn.coforge.computer.daemon";
const POLL: Duration = Duration::from_millis(50);
const SECOND: Duration = Duration::from_secs(1);

/// `launchctl print` of a job with a live process, as macOS 27 prints it (trimmed). Its nested
/// `resource coalition` block repeats `state`, which must not be read as the job's own.
const RUNNING: &str = "gui/501/cn.coforge.computer.daemon = {\n\
\tactive count = 1\n\
\tpath = /Users/frank/Library/LaunchAgents/cn.coforge.computer.daemon.plist\n\
\ttype = LaunchAgent\n\
\tstate = running\n\
\n\
\tprogram = /Users/frank/.coforge/computer/install/active/coforge-computer\n\
\targuments = {\n\
\t\t/Users/frank/.coforge/computer/install/active/coforge-computer\n\
\t\t__daemon\n\
\t}\n\
\n\
\tdomain = gui/501 [100021]\n\
\truns = 1\n\
\tpid = 4242\n\
\tlast exit code = (never exited)\n\
\n\
\tresource coalition = {\n\
\t\tID = 1272\n\
\t\tstate = active\n\
\t\tpid = 9\n\
\t}\n\
}\n";

/// The same job on Frank's Mac on 2026-09-30: `KeepAlive` respawning a daemon that exits at once
/// with EX_CONFIG. launchd lists it and reports no process.
const CRASH_LOOP: &str = "gui/501/cn.coforge.computer.daemon = {\n\
\tactive count = 0\n\
\tpath = /Users/frank/Library/LaunchAgents/cn.coforge.computer.daemon.plist\n\
\ttype = LaunchAgent\n\
\tstate = spawn scheduled\n\
\n\
\tdomain = gui/501 [100021]\n\
\truns = 7364\n\
\tlast exit code = 78: EX_CONFIG\n\
\n\
\tresource coalition = {\n\
\t\tID = 1272\n\
\t\tstate = active\n\
\t}\n\
}\n";

/// The job while `bootout` tears it down and it ignores SIGTERM (measured on macOS 27 on
/// 2026-09-30): launchd keeps answering `print` with the old pid and this state for about five
/// seconds, then SIGKILLs it and the job leaves the domain.
const TEARING_DOWN: &str = "gui/501/cn.coforge.computer.daemon = {\n\
\tactive count = 1\n\
\tstate = SIGTERMed\n\
\n\
\truns = 1\n\
\tpid = 4242\n\
\tlast exit code = (never exited)\n\
}\n";

const NOT_LOADED: &str = "Bad request.\nCould not find service \"cn.coforge.computer.daemon\" in domain for user gui: 501\n";

struct Scenario {
    home: Scratch,
    runner: ScriptedRunner,
    clock: VirtualClock,
}

impl Scenario {
    fn new(plist_on_disk: bool, script: Vec<Step>) -> Self {
        let home = Scratch::new("launchd");
        if plist_on_disk {
            let plist = plist_in(home.path());
            fs::create_dir_all(plist.parent().unwrap()).unwrap();
            fs::write(&plist, "<plist/>").unwrap();
        }
        Self {
            home,
            runner: ScriptedRunner::new(script),
            clock: VirtualClock::new(),
        }
    }

    fn launchd(&self) -> Launchd<'_> {
        Launchd::new(
            &self.runner,
            &self.clock,
            &coordinator_service(),
            self.home.path(),
            501,
        )
        .unwrap()
    }

    fn bootstrap(&self) -> String {
        format!(
            "/bin/launchctl bootstrap gui/501 {}",
            plist_in(self.home.path()).display()
        )
    }
}

fn plist_in(home: &std::path::Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

fn not_loaded() -> Step {
    exits(PRINT, 113, NOT_LOADED)
}

#[test]
fn a_service_that_is_neither_loaded_nor_on_disk_is_not_installed() {
    let scenario = Scenario::new(false, vec![not_loaded()]);
    assert_eq!(
        scenario.launchd().state().unwrap(),
        ServiceState::NotInstalled
    );
}

#[test]
fn a_plist_that_launchd_has_not_loaded_is_a_stopped_service() {
    let scenario = Scenario::new(true, vec![not_loaded()]);
    assert_eq!(scenario.launchd().state().unwrap(), ServiceState::Stopped);
}

#[test]
fn a_running_job_reports_the_pid_launchd_prints_for_the_job_itself() {
    let scenario = Scenario::new(true, vec![ok(PRINT, RUNNING)]);
    assert_eq!(
        scenario.launchd().state().unwrap(),
        ServiceState::Running { pid: Some(4242) }
    );
}

#[test]
fn a_job_launchd_holds_between_respawns_is_running_with_no_pid() {
    // Loaded, no process: launchd is respawning a job that keeps exiting. The manager still holds
    // it, so it is not stopped, and stopping it still takes a bootout.
    let scenario = Scenario::new(true, vec![ok(PRINT, CRASH_LOOP)]);
    assert_eq!(
        scenario.launchd().state().unwrap(),
        ServiceState::Running { pid: None }
    );
}

#[test]
fn a_missing_desktop_session_is_reported_as_the_missing_domain() {
    let scenario = Scenario::new(
        true,
        vec![exits(
            PRINT,
            112,
            "Bad request.\nCould not find domain for user gui: 501\n",
        )],
    );
    let error = scenario.launchd().state().unwrap_err();
    assert!(
        matches!(&error, ServiceError::NoLaunchdDomain { domain, code: 112, .. } if domain == "gui/501"),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains(PRINT), "{message}");
    assert!(message.contains("desktop login session"), "{message}");
    assert!(message.contains("coforge-computer foreground"), "{message}");
}

#[test]
fn a_launchctl_that_is_not_there_is_named() {
    let scenario = Scenario::new(true, vec![cannot_run(PRINT, RunError::NotFound)]);
    assert_eq!(
        scenario.launchd().state().unwrap_err(),
        ServiceError::ToolMissing {
            program: "/bin/launchctl".to_owned()
        }
    );
}

#[test]
fn any_other_refusal_carries_launchds_words_and_the_command_to_run() {
    let scenario = Scenario::new(true, vec![exits(PRINT, 1, "Print failed: 1: Unknown\n")]);
    let message = scenario.launchd().state().unwrap_err().to_string();
    assert!(message.contains(PRINT), "{message}");
    assert!(message.contains("(1)"), "{message}");
    assert!(message.contains("Print failed: 1: Unknown"), "{message}");
}

#[test]
fn stop_boots_the_job_out_then_waits_until_launchd_no_longer_lists_it() {
    // The 2026-09-17 incident: `bootout` returns before the job has left the domain, and `print`
    // keeps answering for the outgoing instance. Only a `print` that fails proves it gone.
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, RUNNING),
            ok(BOOTOUT, ""),
            ok(PRINT, RUNNING).times(2),
            not_loaded(),
        ],
    );
    let outcome = scenario.launchd().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: Some(4242) });
    assert_eq!(scenario.clock.sleeps(), vec![POLL, POLL]);
    assert_eq!(
        scenario.runner.ran(),
        vec![PRINT, BOOTOUT, PRINT, PRINT, PRINT]
    );
}

#[test]
fn stop_takes_a_bootout_for_a_job_launchd_holds_with_no_process() {
    let scenario = Scenario::new(
        true,
        vec![ok(PRINT, CRASH_LOOP), ok(BOOTOUT, ""), not_loaded()],
    );
    let outcome = scenario.launchd().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: None });
}

#[test]
fn a_job_already_gone_at_bootout_needs_no_wait() {
    // Darwin ESRCH (3): the job left between the query and the bootout.
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, RUNNING),
            exits(BOOTOUT, 3, "Boot-out failed: 3: No such process\n"),
        ],
    );
    let outcome = scenario.launchd().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: Some(4242) });
    assert_eq!(scenario.clock.sleeps(), Vec::<Duration>::new());
}

#[test]
fn stop_still_boots_out_a_job_launchd_is_already_tearing_down() {
    // Measured 2026-09-30: a second `bootout` of a job in teardown exits 0 at once, and during
    // a `kickstart -k` restart (the Computer's `restart --supervisor`) it turns the respawn that
    // would follow into a removal. Waiting alone would wait for a job that comes back.
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, TEARING_DOWN),
            ok(BOOTOUT, ""),
            ok(PRINT, TEARING_DOWN).times(2),
            not_loaded(),
        ],
    );
    let outcome = scenario.launchd().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: Some(4242) });
    assert_eq!(scenario.clock.sleeps(), vec![POLL, POLL]);
}

#[test]
fn stopping_what_is_not_loaded_runs_no_bootout() {
    let scenario = Scenario::new(true, vec![not_loaded()]);
    assert_eq!(
        scenario.launchd().stop().unwrap().before,
        ServiceState::Stopped
    );

    let scenario = Scenario::new(false, vec![not_loaded()]);
    assert_eq!(
        scenario.launchd().stop().unwrap().before,
        ServiceState::NotInstalled
    );
    assert_eq!(scenario.runner.ran(), vec![PRINT]);
}

#[test]
fn stop_gives_up_after_fifteen_seconds_and_names_the_job() {
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, RUNNING),
            ok(BOOTOUT, ""),
            ok(PRINT, RUNNING).forever(),
        ],
    );
    let error = scenario.launchd().stop().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StopTimedOut { waited, service, .. }
            if *waited == Duration::from_secs(15) && service == "gui/501/cn.coforge.computer.daemon"),
        "{error:?}"
    );
    assert_eq!(scenario.clock.elapsed(), Duration::from_secs(15));
    let message = error.to_string();
    assert!(message.contains("15s"), "{message}");
    assert!(
        message.contains("launchctl print gui/501/cn.coforge.computer.daemon"),
        "{message}"
    );
}

#[test]
fn a_refused_bootout_is_a_stop_when_a_fresh_query_shows_the_job_gone() {
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, RUNNING),
            exits(BOOTOUT, 5, "Boot-out failed: 5: Input/output error\n"),
            not_loaded(),
        ],
    );
    assert!(scenario.launchd().stop().is_ok());
}

#[test]
fn a_refused_bootout_with_the_job_still_loaded_is_reported_with_launchds_words() {
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, RUNNING),
            exits(BOOTOUT, 1, "Boot-out failed: 1: Operation not permitted\n"),
            ok(PRINT, RUNNING),
        ],
    );
    let error = scenario.launchd().stop().unwrap_err();
    assert!(
        matches!(&error, ServiceError::CommandFailed { command, code: 1, diagnostic, .. }
            if command == BOOTOUT && diagnostic == "Boot-out failed: 1: Operation not permitted"),
        "{error:?}"
    );
}

#[test]
fn a_bootout_refused_for_want_of_a_desktop_session_says_so() {
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, RUNNING),
            exits(
                BOOTOUT,
                125,
                "Boot-out failed: 125: Domain does not support specified action\n",
            ),
            exits(PRINT, 112, "Could not find domain for user gui: 501\n"),
        ],
    );
    let error = scenario.launchd().stop().unwrap_err();
    assert!(
        matches!(&error, ServiceError::NoLaunchdDomain { code: 125, command, .. } if command == BOOTOUT),
        "{error:?}"
    );
}

#[test]
fn start_bootstraps_the_plist_of_an_unloaded_job_and_waits_for_a_process() {
    let scenario = Scenario::new(true, vec![]);
    let bootstrap = scenario.bootstrap();
    let runner = ScriptedRunner::new(vec![
        not_loaded(),
        ok(&bootstrap, ""),
        ok(PRINT, CRASH_LOOP),
        ok(PRINT, RUNNING),
    ]);
    let launchd = Launchd::new(
        &runner,
        &scenario.clock,
        &coordinator_service(),
        scenario.home.path(),
        501,
    )
    .unwrap();
    assert_eq!(launchd.start().unwrap(), StartOutcome { pid: Some(4242) });
    assert_eq!(scenario.clock.sleeps(), vec![POLL]);
}

#[test]
fn a_loaded_job_is_not_a_started_job() {
    // The other half of the 2026-09-17 incident: `print` exiting 0 must not be read as "the
    // service is up". A loaded job with no process is kickstarted, not skipped.
    let scenario = Scenario::new(
        true,
        vec![ok(PRINT, CRASH_LOOP), ok(KICKSTART, ""), ok(PRINT, RUNNING)],
    );
    assert_eq!(
        scenario.launchd().start().unwrap(),
        StartOutcome { pid: Some(4242) }
    );
}

#[test]
fn a_job_launchd_is_tearing_down_is_not_a_started_job_it_is_waited_out_then_bootstrapped() {
    // Its old pid is still printed, and printing exits 0, for the whole teardown.
    let scenario = Scenario::new(true, vec![]);
    let bootstrap = scenario.bootstrap();
    let runner = ScriptedRunner::new(vec![
        ok(PRINT, TEARING_DOWN),
        ok(PRINT, TEARING_DOWN).times(2),
        not_loaded(),
        ok(&bootstrap, ""),
        ok(PRINT, RUNNING),
    ]);
    let launchd = Launchd::new(
        &runner,
        &scenario.clock,
        &coordinator_service(),
        scenario.home.path(),
        501,
    )
    .unwrap();
    assert_eq!(launchd.start().unwrap(), StartOutcome { pid: Some(4242) });
    assert_eq!(scenario.clock.sleeps(), vec![POLL, POLL]);
}

#[test]
fn a_job_that_settles_after_its_teardown_is_not_bootstrapped() {
    // `kickstart -k` restarts in place (measured 2026-09-30): SIGTERMed for the exit timeout,
    // then `spawn scheduled` through the throttle, and `print` never fails. Waiting for the job
    // to leave would wait for ever.
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, TEARING_DOWN).times(2),
            ok(PRINT, CRASH_LOOP),
            ok(KICKSTART, ""),
            ok(PRINT, RUNNING),
        ],
    );
    assert_eq!(
        scenario.launchd().start().unwrap(),
        StartOutcome { pid: Some(4242) }
    );
    assert_eq!(scenario.clock.sleeps(), vec![POLL]);
}

#[test]
fn a_teardown_that_never_ends_is_reported_after_fifteen_seconds() {
    let scenario = Scenario::new(true, vec![ok(PRINT, TEARING_DOWN).forever()]);
    let error = scenario.launchd().start().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StartTimedOut { waited, .. } if *waited == Duration::from_secs(15)),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains("state = SIGTERMed"), "{message}");
    assert!(
        message.contains("launchctl print gui/501/cn.coforge.computer.daemon"),
        "{message}"
    );
}

#[test]
fn the_old_pid_of_a_job_being_torn_down_never_ends_the_wait_for_a_process() {
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, CRASH_LOOP),
            ok(KICKSTART, ""),
            ok(PRINT, TEARING_DOWN),
            ok(PRINT, RUNNING),
        ],
    );
    assert_eq!(
        scenario.launchd().start().unwrap(),
        StartOutcome { pid: Some(4242) }
    );
    assert_eq!(scenario.clock.sleeps(), vec![POLL]);
}

#[test]
fn starting_a_running_job_runs_nothing_more() {
    let scenario = Scenario::new(true, vec![ok(PRINT, RUNNING)]);
    assert_eq!(
        scenario.launchd().start().unwrap(),
        StartOutcome { pid: Some(4242) }
    );
}

#[test]
fn a_job_with_no_plist_is_not_installed_and_is_never_bootstrapped() {
    // `bootstrap` of a missing plist exits 5, the same code as "still tearing down": it would be
    // retried for three seconds and reported as launchd being slow.
    let scenario = Scenario::new(false, vec![not_loaded()]);
    assert_eq!(
        scenario.launchd().start().unwrap_err(),
        ServiceError::NotInstalled {
            service: LABEL.to_owned()
        }
    );
    assert_eq!(scenario.runner.ran(), vec![PRINT]);
}

#[test]
fn bootstrap_is_retried_only_while_launchd_is_still_tearing_down_the_old_job() {
    let scenario = Scenario::new(true, vec![]);
    let bootstrap = scenario.bootstrap();
    let runner = ScriptedRunner::new(vec![
        not_loaded(),
        exits(&bootstrap, 5, "Bootstrap failed: 5: Input/output error\n"),
        exits(
            &bootstrap,
            37,
            "Bootstrap failed: 37: Operation already in progress\n",
        ),
        ok(&bootstrap, ""),
        ok(PRINT, RUNNING),
    ]);
    let launchd = Launchd::new(
        &runner,
        &scenario.clock,
        &coordinator_service(),
        scenario.home.path(),
        501,
    )
    .unwrap();
    assert_eq!(launchd.start().unwrap().pid, Some(4242));
    assert_eq!(scenario.clock.sleeps(), vec![SECOND, SECOND]);
}

#[test]
fn any_other_bootstrap_failure_is_not_retried() {
    let scenario = Scenario::new(true, vec![]);
    let bootstrap = scenario.bootstrap();
    let runner = ScriptedRunner::new(vec![
        not_loaded(),
        exits(
            &bootstrap,
            1,
            "Bootstrap failed: 1: Operation not permitted\n",
        ),
    ]);
    let launchd = Launchd::new(
        &runner,
        &scenario.clock,
        &coordinator_service(),
        scenario.home.path(),
        501,
    )
    .unwrap();
    let error = launchd.start().unwrap_err();
    assert_eq!(scenario.clock.sleeps(), Vec::<Duration>::new());
    let message = error.to_string();
    assert!(message.contains(&bootstrap), "{message}");
    assert!(
        message.contains("Bootstrap failed: 1: Operation not permitted"),
        "{message}"
    );
    assert!(message.contains("coforge-computer start"), "{message}");
}

#[test]
fn bootstrap_gives_up_after_three_attempts() {
    let scenario = Scenario::new(true, vec![]);
    let bootstrap = scenario.bootstrap();
    let runner = ScriptedRunner::new(vec![
        not_loaded(),
        exits(&bootstrap, 5, "Bootstrap failed: 5: Input/output error\n").times(3),
    ]);
    let launchd = Launchd::new(
        &runner,
        &scenario.clock,
        &coordinator_service(),
        scenario.home.path(),
        501,
    )
    .unwrap();
    let error = launchd.start().unwrap_err();
    assert!(
        matches!(error, ServiceError::CommandFailed { code: 5, .. }),
        "{error:?}"
    );
    assert_eq!(scenario.clock.sleeps(), vec![SECOND, SECOND]);
}

#[test]
fn start_gives_up_after_ten_seconds_and_says_what_launchd_reports() {
    let scenario = Scenario::new(
        true,
        vec![
            ok(PRINT, CRASH_LOOP),
            ok(KICKSTART, ""),
            ok(PRINT, CRASH_LOOP).forever(),
        ],
    );
    let error = scenario.launchd().start().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StartTimedOut { waited, .. } if *waited == Duration::from_secs(10)),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains("state = spawn scheduled"), "{message}");
    assert!(
        message.contains("last exit code = 78: EX_CONFIG"),
        "{message}"
    );
    assert!(message.contains("daemon.log"), "{message}");
}

#[test]
fn every_launchctl_call_is_bounded() {
    let scenario = Scenario::new(
        true,
        vec![ok(PRINT, RUNNING), ok(BOOTOUT, ""), not_loaded()],
    );
    scenario.launchd().stop().unwrap();
    assert_eq!(scenario.runner.longest_timeout(), Duration::from_secs(30));
}

#[cfg(unix)]
#[test]
fn the_user_id_is_the_one_the_system_reports() {
    // `id -u` is the independent source of truth for what `getuid` returns.
    let output = std::process::Command::new("id").arg("-u").output().unwrap();
    let expected: u32 = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(current_uid(), Some(expected));
}

#[cfg(not(unix))]
#[test]
fn there_is_no_user_id_where_there_are_no_launchd_domains() {
    assert_eq!(current_uid(), None);
}

#[test]
fn a_domain_or_label_the_contract_cannot_have_is_refused() {
    let scenario = Scenario::new(true, vec![]);
    let mut names = coordinator_service();
    names.launchd_label = "cn.coforge/../evil".to_owned();
    let refused = Launchd::new(
        &scenario.runner,
        &scenario.clock,
        &names,
        scenario.home.path(),
        501,
    );
    assert!(matches!(refused, Err(ServiceError::InvalidIdentity { .. })));

    let mut names = coordinator_service();
    names.launchd_domain = "system".to_owned();
    let refused = Launchd::new(
        &scenario.runner,
        &scenario.clock,
        &names,
        scenario.home.path(),
        501,
    );
    assert!(matches!(refused, Err(ServiceError::InvalidIdentity { .. })));
}
