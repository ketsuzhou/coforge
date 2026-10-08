//! Why controlling the supervisor's service failed. Every message says what happened, why when
//! the service manager said so, and the command a person can run next.

use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    /// A service name the installer will not pass to a service manager or a script.
    InvalidIdentity { what: &'static str, value: String },
    /// The manager knows no service under the Computer's name.
    NotInstalled { service: String },
    /// `systemctl --user` cannot reach this user's systemd: no session bus. A `su` or `sudo`
    /// shell never has one, and the failure looks like nothing else.
    NoSystemdUserSession { command: String, diagnostic: String },
    /// launchd has no domain for this user to act on: nobody is logged in at the desktop.
    NoLaunchdDomain {
        domain: String,
        command: String,
        code: i32,
        diagnostic: String,
    },
    /// The Windows task exists but is disabled, so `/Run` would be refused.
    TaskDisabled { task: String },
    /// The tool that talks to the manager is not on this machine.
    ToolMissing { program: String },
    /// A file the service manager's state depends on could not be read.
    FileUnreadable { path: String, detail: String },
    /// The manager's tool ran and refused.
    CommandFailed {
        command: String,
        code: i32,
        diagnostic: String,
        hint: String,
    },
    /// The manager's tool was still running when its bound elapsed.
    CommandTimedOut { command: String, waited: Duration },
    /// The manager's tool could not be started or read.
    CommandNotRun { command: String, detail: String },
    /// The tool succeeded but printed something that is not a state the installer knows.
    UnexpectedOutput { command: String, output: String },
    /// The manager still listed the service after it was told to stop.
    StopTimedOut {
        service: String,
        waited: Duration,
        observed: String,
        hint: String,
    },
    /// The manager reported no running process after it was told to start.
    StartTimedOut {
        service: String,
        waited: Duration,
        observed: String,
        hint: String,
    },
}

impl fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentity { what, value } => write!(
                formatter,
                "The {what} `{value}` is not a name the installer will pass to the service \
                 manager, so this installer's own service names are wrong. Run `coforge-computer \
                 upgrade` to fetch a fixed installer."
            ),
            Self::NotInstalled { service } => write!(
                formatter,
                "CoForge Daemon is not installed as a service on this Computer ({service}). \
                 Install and start it with `coforge-computer start`, or control the Daemon \
                 through the external supervisor that runs it."
            ),
            Self::NoSystemdUserSession {
                command,
                diagnostic,
            } => write!(
                formatter,
                "`{command}` failed: {} This shell has no systemd user session, which a `su` \
                 or `sudo` shell never gets. Open this user's own login session - \
                 `ssh <user>@<host>`, or `machinectl shell <user>@` - and run the command there.",
                sentence(diagnostic)
            ),
            Self::NoLaunchdDomain {
                domain,
                command,
                code,
                diagnostic,
            } => write!(
                formatter,
                "`{command}` failed ({code}): {} launchd has no `{domain}` domain to act on, \
                 which happens when this user has no desktop login session (an SSH-only session \
                 has none). Log in to the desktop as this user and run the command there, or run \
                 the Computer under an external supervisor with `coforge-computer foreground`.",
                sentence(diagnostic)
            ),
            Self::TaskDisabled { task } => write!(
                formatter,
                "The scheduled task \"{task}\" is disabled, so it cannot be started. Enable it \
                 with `schtasks /Change /TN \"{task}\" /ENABLE`, then run the operation again."
            ),
            Self::ToolMissing { program } => write!(
                formatter,
                "`{program}` was not found on this machine, so CoForge cannot control the \
                 Daemon's service. Install it or add it to PATH, or run the Computer under an \
                 external supervisor with `coforge-computer foreground`."
            ),
            Self::FileUnreadable { path, detail } => write!(
                formatter,
                "{path} could not be read: {} Check that this user can read it with `ls -l \"{path}\"`.",
                sentence(detail)
            ),
            Self::CommandFailed {
                command,
                code,
                diagnostic,
                hint,
            } => {
                if diagnostic.is_empty() {
                    write!(formatter, "`{command}` failed ({code}). {hint}")
                } else {
                    write!(
                        formatter,
                        "`{command}` failed ({code}): {} {hint}",
                        sentence(diagnostic)
                    )
                }
            }
            Self::CommandTimedOut { command, waited } => write!(
                formatter,
                "`{command}` did not finish within {}s and was stopped. The service manager may \
                 be stuck; run the command yourself in a terminal to see what it is waiting for.",
                waited.as_secs()
            ),
            Self::CommandNotRun { command, detail } => write!(
                formatter,
                "`{command}` could not be run: {} Run it yourself in a terminal to see why.",
                sentence(detail)
            ),
            Self::UnexpectedOutput { command, output } => write!(
                formatter,
                "`{command}` printed something the installer cannot read as a service state: \
                 {}. Run the command yourself to see the service's state.",
                output.trim()
            ),
            Self::StopTimedOut {
                service,
                waited,
                observed,
                hint,
            } => write!(
                formatter,
                "CoForge Daemon ({service}) was still there {}s after it was asked to stop \
                 ({observed}). {hint}",
                waited.as_secs()
            ),
            Self::StartTimedOut {
                service,
                waited,
                observed,
                hint,
            } => write!(
                formatter,
                "CoForge Daemon ({service}) did not start within {}s ({observed}). {hint}",
                waited.as_secs()
            ),
        }
    }
}

impl std::error::Error for ServiceError {}

/// The leading lines of a manager's own account of a refusal, joined and bounded: it explains a
/// refusal better than CoForge can guess at it, but is free to write a wall of text. Ported from
/// `nativeCommandDiagnostic` (packages/daemon/src/platform/native-command.ts).
pub(crate) fn diagnostic(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect();
    lines.join(" ").chars().take(500).collect()
}

/// `text` as a sentence: the manager's own words, ended with a full stop if it has none.
fn sentence(text: &str) -> String {
    let text = text.trim();
    if text.ends_with(['.', '!', '?']) {
        text.to_owned()
    } else {
        format!("{text}.")
    }
}
