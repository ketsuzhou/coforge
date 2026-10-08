use std::time::Duration;

use super::*;
use crate::clock::VirtualClock;
use crate::service::fakes::{ScriptedRunner, Step, cannot_run, exits, ok};
use crate::service::{
    RunError, ServiceState, StartOutcome, SupervisorService, coordinator_service,
};

/// The one command that reads the task's state, pinned as a literal: it is the only thing the
/// installer says to PowerShell. It names the state by the `ScheduledTask.State` enum, which
/// PowerShell prints the same in every Windows language (`schtasks /Query` translates its
/// labels and values), and exits 3 for a task that is not there.
const QUERY: &str = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command \"$ErrorActionPreference = \
'Stop'; $task = Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq 'CoForge Daemon' \
}; if ($null -eq $task) { exit 3 }; $task.State.ToString()\"";
const END: &str = "C:\\Windows\\System32\\schtasks.exe /End /TN \"CoForge Daemon\"";
const RUN: &str = "C:\\Windows\\System32\\schtasks.exe /Run /TN \"CoForge Daemon\"";
const SYSTEM_ROOT: &str = "C:\\Windows";
const POLL: Duration = Duration::from_millis(500);

fn state(name: &str) -> Step {
    // PowerShell ends its output lines with CRLF.
    ok(QUERY, &format!("{name}\r\n"))
}

fn not_registered() -> Step {
    exits(QUERY, 3, "")
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

    fn task(&self) -> WindowsTask<'_> {
        WindowsTask::new(
            &self.runner,
            &self.clock,
            &coordinator_service(),
            SYSTEM_ROOT,
        )
        .unwrap()
    }
}

#[test]
fn a_task_that_is_not_registered_is_not_installed() {
    let scenario = Scenario::new(vec![not_registered()]);
    assert_eq!(scenario.task().state().unwrap(), ServiceState::NotInstalled);
}

#[test]
fn a_task_with_no_running_instance_is_stopped() {
    for name in ["Ready", "Disabled"] {
        let scenario = Scenario::new(vec![state(name)]);
        assert_eq!(
            scenario.task().state().unwrap(),
            ServiceState::Stopped,
            "{name}"
        );
    }
}

#[test]
fn a_running_or_queued_task_is_running_and_has_no_pid() {
    // Task Scheduler exposes no process id for a task's instance.
    for name in ["Running", "Queued"] {
        let scenario = Scenario::new(vec![state(name)]);
        assert_eq!(
            scenario.task().state().unwrap(),
            ServiceState::Running { pid: None },
            "{name}"
        );
    }
}

#[test]
fn a_state_the_installer_does_not_know_is_not_guessed_at() {
    for output in ["Unknown\r\n", "Wird ausgeführt\r\n", ""] {
        let scenario = Scenario::new(vec![ok(QUERY, output)]);
        let error = scenario.task().state().unwrap_err();
        assert!(
            matches!(error, ServiceError::UnexpectedOutput { .. }),
            "{output:?}: {error:?}"
        );
    }
}

#[test]
fn a_powershell_that_is_not_there_is_named() {
    let scenario = Scenario::new(vec![cannot_run(QUERY, RunError::NotFound)]);
    assert_eq!(
        scenario.task().state().unwrap_err(),
        ServiceError::ToolMissing {
            program: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".to_owned()
        }
    );
}

#[test]
fn a_failed_query_carries_the_error_and_the_command_that_shows_the_task() {
    let scenario = Scenario::new(vec![exits(
        QUERY,
        1,
        "Get-ScheduledTask : Access is denied.\n",
    )]);
    let message = scenario.task().state().unwrap_err().to_string();
    assert!(message.contains("(1)"), "{message}");
    assert!(message.contains("Access is denied."), "{message}");
    assert!(
        message.contains("schtasks /Query /TN \"CoForge Daemon\" /V /FO LIST"),
        "{message}"
    );
}

#[test]
fn stop_ends_the_task_then_waits_until_it_has_no_running_instance() {
    let scenario = Scenario::new(vec![
        state("Running"),
        ok(END, ""),
        state("Running").times(2),
        state("Ready"),
    ]);
    let outcome = scenario.task().stop().unwrap();
    assert_eq!(outcome.before, ServiceState::Running { pid: None });
    assert_eq!(scenario.clock.sleeps(), vec![POLL, POLL]);
    assert_eq!(scenario.runner.ran(), vec![QUERY, END, QUERY, QUERY, QUERY]);
}

#[test]
fn stopping_what_is_not_running_or_not_registered_ends_nothing() {
    let scenario = Scenario::new(vec![state("Ready")]);
    assert_eq!(
        scenario.task().stop().unwrap().before,
        ServiceState::Stopped
    );

    let scenario = Scenario::new(vec![not_registered()]);
    assert_eq!(
        scenario.task().stop().unwrap().before,
        ServiceState::NotInstalled
    );
}

#[test]
fn a_refused_end_is_a_stop_when_the_task_has_stopped_meanwhile() {
    // `/End` of a task with no running instance exits 1; the task may have ended by itself
    // between the query and the command.
    let scenario = Scenario::new(vec![
        state("Running"),
        exits(END, 1, "ERROR: There is no running instance of the task.\n"),
        state("Ready"),
    ]);
    assert!(scenario.task().stop().is_ok());
}

#[test]
fn a_refused_end_with_the_task_still_running_is_reported() {
    let scenario = Scenario::new(vec![
        state("Running"),
        exits(END, 1, "ERROR: Access is denied.\n"),
        state("Running"),
    ]);
    let message = scenario.task().stop().unwrap_err().to_string();
    assert!(message.contains(END), "{message}");
    assert!(message.contains("ERROR: Access is denied."), "{message}");
}

#[test]
fn stop_gives_up_after_fifteen_seconds_and_says_what_to_run() {
    let scenario = Scenario::new(vec![
        state("Running"),
        ok(END, ""),
        state("Running").forever(),
    ]);
    let error = scenario.task().stop().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StopTimedOut { waited, service, .. }
            if *waited == Duration::from_secs(15) && service == "CoForge Daemon"),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains("Running"), "{message}");
    assert!(
        message.contains("schtasks /End /TN \"CoForge Daemon\""),
        "{message}"
    );
}

#[test]
fn start_runs_the_task_then_waits_for_a_running_instance() {
    let scenario = Scenario::new(vec![
        state("Ready"),
        ok(RUN, ""),
        state("Queued"),
        state("Running"),
    ]);
    assert_eq!(scenario.task().start().unwrap(), StartOutcome { pid: None });
    assert_eq!(scenario.clock.sleeps(), vec![POLL]);
}

#[test]
fn starting_a_running_task_runs_nothing_more() {
    let scenario = Scenario::new(vec![state("Running")]);
    assert_eq!(scenario.task().start().unwrap(), StartOutcome { pid: None });
    assert_eq!(scenario.runner.ran(), vec![QUERY]);
}

#[test]
fn starting_a_task_that_is_not_registered_says_how_to_install_it() {
    let scenario = Scenario::new(vec![not_registered()]);
    let error = scenario.task().start().unwrap_err();
    assert_eq!(
        error,
        ServiceError::NotInstalled {
            service: "CoForge Daemon".to_owned()
        }
    );
    assert!(error.to_string().contains("coforge-computer start"));
}

#[test]
fn a_disabled_task_is_not_run_and_the_error_says_how_to_enable_it() {
    let scenario = Scenario::new(vec![state("Disabled")]);
    let error = scenario.task().start().unwrap_err();
    assert_eq!(
        error,
        ServiceError::TaskDisabled {
            task: "CoForge Daemon".to_owned()
        }
    );
    let message = error.to_string();
    assert!(message.contains("is disabled"), "{message}");
    assert!(
        message.contains(r#"`schtasks /Change /TN "CoForge Daemon" /ENABLE`"#),
        "{message}"
    );
    assert_eq!(scenario.runner.ran(), vec![QUERY]);
}

#[test]
fn tools_are_found_under_the_system_root_however_it_is_spelled_never_through_path() {
    for root in ["C:\\Windows", "C:\\Windows\\", "C:/Windows/"] {
        let scenario = Scenario::new(vec![state("Ready"), ok(RUN, ""), state("Running")]);
        let task = WindowsTask::new(
            &scenario.runner,
            &scenario.clock,
            &coordinator_service(),
            root,
        )
        .unwrap();
        task.start().unwrap();
    }
}

#[test]
fn a_refused_run_carries_the_task_schedulers_words_and_the_command() {
    let scenario = Scenario::new(vec![
        state("Ready"),
        exits(
            RUN,
            1,
            "ERROR: The task image is corrupt or has been tampered with.\n",
        ),
    ]);
    let message = scenario.task().start().unwrap_err().to_string();
    assert!(message.contains(RUN), "{message}");
    assert!(message.contains("The task image is corrupt"), "{message}");
}

#[test]
fn start_gives_up_after_ten_seconds_and_says_what_the_task_reports() {
    let scenario = Scenario::new(vec![state("Ready"), ok(RUN, ""), state("Ready").forever()]);
    let error = scenario.task().start().unwrap_err();
    assert!(
        matches!(&error, ServiceError::StartTimedOut { waited, .. } if *waited == Duration::from_secs(10)),
        "{error:?}"
    );
    let message = error.to_string();
    assert!(message.contains("Ready"), "{message}");
    assert!(
        message.contains("schtasks /Query /TN \"CoForge Daemon\" /V /FO LIST"),
        "{message}"
    );
}

#[test]
fn a_task_name_that_could_break_out_of_the_script_is_refused() {
    let scenario = Scenario::new(vec![]);
    for bad in ["", "x'; calc; '", "a\"b", "..\\evil", " leading", "a\nb"] {
        let mut names = coordinator_service();
        names.windows_task = bad.to_owned();
        let refused = WindowsTask::new(&scenario.runner, &scenario.clock, &names, SYSTEM_ROOT);
        assert!(
            matches!(refused, Err(ServiceError::InvalidIdentity { .. })),
            "{bad:?}"
        );
    }
}
