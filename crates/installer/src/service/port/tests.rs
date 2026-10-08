use std::time::Duration;

use super::*;

const LONG: Duration = Duration::from_secs(30);

#[test]
fn a_command_line_prints_as_it_would_be_typed() {
    let line = CommandLine::new(
        "schtasks.exe",
        ["/End", "/TN", "CoForge Daemon", "", "plain-arg"],
    );
    assert_eq!(
        line.to_string(),
        r#"schtasks.exe /End /TN "CoForge Daemon" "" plain-arg"#
    );
    assert_eq!(line.program(), "schtasks.exe");
    assert_eq!(
        line.args(),
        ["/End", "/TN", "CoForge Daemon", "", "plain-arg"]
    );
}

#[test]
fn a_program_that_does_not_exist_is_not_found() {
    let missing = CommandLine::new("coforge-installer-test-no-such-program", ["--flag"]);
    assert_eq!(SystemRunner.run(&missing, LONG), Err(RunError::NotFound));
}

#[cfg(unix)]
mod unix {
    use std::time::Instant;

    use super::*;

    fn sh(script: &str) -> CommandLine {
        CommandLine::new("/bin/sh", ["-c", script])
    }

    #[test]
    fn captures_the_exit_code_and_both_streams() {
        let output = SystemRunner
            .run(&sh("echo to-stdout; echo to-stderr >&2; exit 3"), LONG)
            .unwrap();
        assert_eq!(output.code, 3);
        assert_eq!(output.stdout, "to-stdout\n");
        assert_eq!(output.stderr, "to-stderr\n");
    }

    #[test]
    fn runs_in_the_c_locale_so_a_manager_says_its_errors_in_english() {
        let output = SystemRunner
            .run(&sh(r#"printf %s "$LC_ALL""#), LONG)
            .unwrap();
        assert_eq!(output.stdout, "C");
    }

    #[test]
    fn keeps_the_rest_of_the_environment_a_service_manager_needs() {
        // `systemctl --user` finds the user's bus through XDG_RUNTIME_DIR; a runner that wiped
        // the environment would report a missing bus on a machine that has one.
        let output = SystemRunner.run(&sh(r#"printf %s "$PATH""#), LONG).unwrap();
        assert_eq!(output.stdout, std::env::var("PATH").unwrap());
    }

    #[test]
    fn gives_the_command_no_input() {
        let output = SystemRunner.run(&sh("cat; echo done"), LONG).unwrap();
        assert_eq!(output.stdout, "done\n");
    }

    #[test]
    fn a_command_that_outlives_its_bound_is_killed_promptly() {
        let started = Instant::now();
        let result = SystemRunner.run(&sh("sleep 30"), Duration::from_millis(200));
        assert_eq!(result, Err(RunError::TimedOut));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_signalled_command_reports_the_shell_convention_not_a_success() {
        let output = SystemRunner.run(&sh("kill -9 $$"), LONG).unwrap();
        assert_eq!(output.code, 128 + 9);
    }
}
