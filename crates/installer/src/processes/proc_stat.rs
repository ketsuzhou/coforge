//! Reading what Linux's `/proc` says about a process. Pure text handling, compiled on every
//! platform under test so the parsing is checked without a Linux machine.

use std::path::{Path, PathBuf};

/// The fields of `/proc/<pid>/stat` the installer uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Stat {
    /// `R`, `S`, `D`, `Z`, ... (proc_pid_stat(5)).
    pub(super) state: char,
    pub(super) parent: u32,
    /// Field 22: clock ticks since boot.
    pub(super) start_ticks: u64,
}

impl Stat {
    /// A zombie, or a process being torn down: nothing of it runs any more.
    pub(super) fn is_dead(&self) -> bool {
        matches!(self.state, 'Z' | 'X' | 'x')
    }
}

/// Parses `pid (comm) state ppid ...`. The command name may hold spaces and parentheses, so the
/// fields begin after the last `)`.
pub(super) fn parse_stat(text: &str) -> Option<Stat> {
    let after_name = &text[text.rfind(')')? + 1..];
    let mut fields = after_name.split_whitespace();
    let state = fields.next()?.chars().next()?;
    let parent = fields.next()?.parse().ok()?;
    // Fields 5 to 21 lie between `ppid` (4) and `starttime` (22).
    let start_ticks = fields.nth(17)?.parse().ok()?;
    Some(Stat {
        state,
        parent,
        start_ticks,
    })
}

/// The executable named by the `/proc/<pid>/exe` link. Linux appends ` (deleted)` when the file
/// was replaced or removed after the process started; the process still runs that file, so the
/// suffix is not part of the path.
pub(super) fn executable(link: &Path) -> PathBuf {
    let text = link.to_string_lossy();
    match text.strip_suffix(" (deleted)") {
        Some(path) => PathBuf::from(path),
        None => link.to_path_buf(),
    }
}

#[cfg(test)]
mod tests;
