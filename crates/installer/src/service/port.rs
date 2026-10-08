//! The port the service backends run their commands through, and its real adapter.

use std::fmt;
use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// One command to run: a program and its arguments, never a shell string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLine {
    program: String,
    args: Vec<String>,
}

impl CommandLine {
    pub fn new<I, S>(program: &str, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            program: program.to_owned(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }
}

/// The command as a person would type it, so an error can tell them what to run themselves.
impl fmt::Display for CommandLine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.program)?;
        for arg in &self.args {
            if arg.is_empty() || arg.contains(char::is_whitespace) {
                write!(formatter, " \"{arg}\"")?;
            } else {
                write!(formatter, " {arg}")?;
            }
        }
        Ok(())
    }
}

/// A finished command. `code` is the exit status, or `128 + signal` for a command a signal ended
/// (the convention shells use), so a killed command never reads as a success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A command that did not finish. A command that ran and failed is a [`CommandOutput`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// The program does not exist on this machine.
    NotFound,
    /// The command was still running when its bound elapsed, and was killed.
    TimedOut,
    /// Starting or reading the command failed for another reason.
    Failed(String),
}

pub trait CommandRunner {
    /// Runs `command` to completion, killing it after `timeout`.
    fn run(&self, command: &CommandLine, timeout: Duration) -> Result<CommandOutput, RunError>;
}

/// Runs the real command with `std::process`: no input, both output streams captured, `LC_ALL=C`
/// (the backends match English diagnostics; the rest of the environment is kept because
/// `systemctl --user` finds the user's bus through it).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemRunner;

/// How often a running command is checked for having finished. `std` has no timed wait.
const CHILD_POLL: Duration = Duration::from_millis(10);
/// How long the output streams get to drain after the command has ended. A grandchild that keeps
/// a stream open would otherwise hold the caller forever.
const DRAIN: Duration = Duration::from_secs(2);

impl CommandRunner for SystemRunner {
    fn run(&self, command: &CommandLine, timeout: Duration) -> Result<CommandOutput, RunError> {
        let mut child = Command::new(command.program())
            .args(command.args())
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => RunError::NotFound,
                _ => RunError::Failed(error.to_string()),
            })?;
        let stdout = drain(child.stdout.take());
        let stderr = drain(child.stderr.take());
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RunError::TimedOut);
                }
                Ok(None) => thread::sleep(CHILD_POLL),
                Err(error) => return Err(RunError::Failed(error.to_string())),
            }
        };
        Ok(CommandOutput {
            code: exit_code(status),
            stdout: collect(&stdout),
            stderr: collect(&stderr),
        })
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(-1)
}

/// Reads a stream to its end on its own thread, so a command that fills a pipe never blocks.
fn drain(stream: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_end(&mut bytes);
        }
        let _ = sender.send(bytes);
    });
    receiver
}

fn collect(receiver: &mpsc::Receiver<Vec<u8>>) -> String {
    let bytes = receiver.recv_timeout(DRAIN).unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests;
