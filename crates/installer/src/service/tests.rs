use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use super::*;
use crate::clock::VirtualClock;
use crate::contract::ServiceIdentities;
use crate::test_support::Scratch;

#[test]
fn the_installer_controls_the_services_the_product_installs() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/service-identities.json");
    let contract: ServiceIdentities =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(coordinator_service(), contract.coordinator);
}

/// Answers every command the same way and remembers what was run.
struct Recording {
    ran: RefCell<Vec<String>>,
}

impl CommandRunner for Recording {
    fn run(&self, command: &CommandLine, _: Duration) -> Result<CommandOutput, RunError> {
        self.ran.borrow_mut().push(command.to_string());
        Ok(CommandOutput {
            code: 0,
            stdout: "501\n".to_owned(),
            stderr: String::new(),
        })
    }
}

fn first_commands(platform: Platform) -> Vec<String> {
    let runner = Recording {
        ran: RefCell::new(Vec::new()),
    };
    let home = Scratch::new("for-platform");
    let clock = VirtualClock::new();
    let service = for_platform(platform, home.path(), Some(501), &runner, &clock).unwrap();
    // What the manager answers is not the point here, only which manager is asked.
    let _ = service.state();
    runner.ran.take()
}

#[test]
fn macos_asks_launchd_in_the_domain_of_the_user_id_id_prints() {
    assert_eq!(
        first_commands(Platform::Darwin),
        vec!["/bin/launchctl print gui/501/cn.coforge.computer.daemon"]
    );
}

#[test]
fn macos_without_a_user_id_has_no_domain_to_ask() {
    let runner = Recording {
        ran: RefCell::new(Vec::new()),
    };
    let home = Scratch::new("for-platform-no-uid");
    let clock = VirtualClock::new();
    let refused = for_platform(Platform::Darwin, home.path(), None, &runner, &clock);
    assert!(matches!(refused, Err(ServiceError::InvalidIdentity { .. })));
    assert_eq!(runner.ran.take(), Vec::<String>::new());
}

#[test]
fn linux_asks_the_user_systemd() {
    let commands = first_commands(Platform::Linux);
    assert_eq!(commands.len(), 1);
    assert!(
        commands[0].starts_with("systemctl --user show coforge-daemon.service "),
        "{commands:?}"
    );
}

#[test]
fn windows_asks_task_scheduler() {
    let commands = first_commands(Platform::Windows);
    assert_eq!(commands.len(), 1);
    assert!(
        commands[0].contains(r"\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile"),
        "{commands:?}"
    );
    assert!(commands[0].contains("CoForge Daemon"), "{commands:?}");
}

#[test]
fn every_failure_says_why_and_names_a_command_to_run() {
    let command = "systemctl --user show coforge-daemon.service".to_owned();
    let failures = [
        ServiceError::InvalidIdentity {
            what: "launchd label",
            value: "x/y".to_owned(),
        },
        ServiceError::NotInstalled {
            service: "coforge-daemon.service".to_owned(),
        },
        ServiceError::NoSystemdUserSession {
            command: command.clone(),
            diagnostic: "Failed to connect to bus".to_owned(),
        },
        ServiceError::NoLaunchdDomain {
            domain: "gui/501".to_owned(),
            command: command.clone(),
            code: 112,
            diagnostic: "Could not find domain".to_owned(),
        },
        ServiceError::TaskDisabled {
            task: "CoForge Daemon".to_owned(),
        },
        ServiceError::ToolMissing {
            program: "systemctl".to_owned(),
        },
        ServiceError::FileUnreadable {
            path: "/home/u/Library/LaunchAgents/x.plist".to_owned(),
            detail: "Permission denied (os error 13)".to_owned(),
        },
        ServiceError::CommandFailed {
            command: command.clone(),
            code: 1,
            diagnostic: "Access denied".to_owned(),
            hint: "Run `systemctl --user status coforge-daemon.service`.".to_owned(),
        },
        ServiceError::CommandTimedOut {
            command: command.clone(),
            waited: Duration::from_secs(30),
        },
        ServiceError::CommandNotRun {
            command: command.clone(),
            detail: "Too many open files (os error 24)".to_owned(),
        },
        ServiceError::UnexpectedOutput {
            command: command.clone(),
            output: "???".to_owned(),
        },
        ServiceError::StopTimedOut {
            service: "coforge-daemon.service".to_owned(),
            waited: Duration::from_secs(15),
            observed: "ActiveState=deactivating".to_owned(),
            hint: "Check `systemctl --user status coforge-daemon.service`.".to_owned(),
        },
        ServiceError::StartTimedOut {
            service: "coforge-daemon.service".to_owned(),
            waited: Duration::from_secs(10),
            observed: "ActiveState=activating".to_owned(),
            hint: "Check `journalctl --user -u coforge-daemon.service`.".to_owned(),
        },
    ];
    for failure in failures {
        let message = failure.to_string();
        // A command is a backticked span with a space in it, or one of the bare tools.
        let commands: Vec<&str> = message.split('`').skip(1).step_by(2).collect();
        assert!(!commands.is_empty(), "no command to run in: {message}");
        assert!(message.len() > 60, "too little to act on: {message}");
    }
}
