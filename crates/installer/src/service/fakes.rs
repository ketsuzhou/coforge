//! Test doubles for the service backends: a [`CommandRunner`] that plays a script of exactly the
//! command lines the backend is expected to run, in order, and fails the test on any deviation.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::time::Duration;

use super::{CommandLine, CommandOutput, CommandRunner, RunError};

/// One expected command and what it answers.
pub(crate) struct Step {
    expect: String,
    answer: Result<CommandOutput, RunError>,
    /// How many more times this step answers; `None` answers until the test ends.
    remaining: Option<usize>,
}

impl Step {
    /// The step answers `count` times in a row.
    pub(crate) fn times(mut self, count: usize) -> Self {
        self.remaining = Some(count);
        self
    }

    /// The step answers every remaining call: a poll that never sees the change it waits for.
    pub(crate) fn forever(mut self) -> Self {
        self.remaining = None;
        self
    }
}

/// `command` exits 0 and prints `stdout`.
pub(crate) fn ok(command: &str, stdout: &str) -> Step {
    exits(command, 0, "").with_stdout(stdout)
}

/// `command` exits `code` and writes `stderr`.
pub(crate) fn exits(command: &str, code: i32, stderr: &str) -> Step {
    Step {
        expect: command.to_owned(),
        answer: Ok(CommandOutput {
            code,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        }),
        remaining: Some(1),
    }
}

/// `command` cannot be run at all.
pub(crate) fn cannot_run(command: &str, error: RunError) -> Step {
    Step {
        expect: command.to_owned(),
        answer: Err(error),
        remaining: Some(1),
    }
}

impl Step {
    fn with_stdout(mut self, stdout: &str) -> Self {
        if let Ok(output) = &mut self.answer {
            output.stdout = stdout.to_owned();
        }
        self
    }
}

pub(crate) struct ScriptedRunner {
    script: RefCell<VecDeque<Step>>,
    ran: RefCell<Vec<(String, Duration)>>,
}

impl ScriptedRunner {
    pub(crate) fn new(steps: Vec<Step>) -> Self {
        Self {
            script: RefCell::new(steps.into()),
            ran: RefCell::new(Vec::new()),
        }
    }

    /// Every command line run so far, as typed.
    pub(crate) fn ran(&self) -> Vec<String> {
        self.ran
            .borrow()
            .iter()
            .map(|(command, _)| command.clone())
            .collect()
    }

    /// The longest bound any command was given.
    pub(crate) fn longest_timeout(&self) -> Duration {
        self.ran
            .borrow()
            .iter()
            .map(|(_, timeout)| *timeout)
            .max()
            .unwrap_or_default()
    }
}

impl CommandRunner for ScriptedRunner {
    fn run(&self, command: &CommandLine, timeout: Duration) -> Result<CommandOutput, RunError> {
        let line = command.to_string();
        self.ran.borrow_mut().push((line.clone(), timeout));
        let mut script = self.script.borrow_mut();
        let Some(step) = script.front_mut() else {
            panic!("unexpected command after the script ended: {line}");
        };
        assert_eq!(
            step.expect,
            line,
            "command number {} did not match the script; ran so far: {:#?}",
            self.ran.borrow().len(),
            self.ran.borrow()
        );
        let answer = step.answer.clone();
        match &mut step.remaining {
            None => {}
            Some(remaining) if *remaining > 1 => *remaining -= 1,
            Some(_) => {
                script.pop_front();
            }
        }
        answer
    }
}

impl Drop for ScriptedRunner {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let unrun: Vec<String> = self
            .script
            .borrow()
            .iter()
            .filter(|step| step.remaining.is_some())
            .map(|step| step.expect.clone())
            .collect();
        assert!(
            unrun.is_empty(),
            "the script expected more commands: {unrun:#?}"
        );
    }
}
