//! A process table that plays out what a machine does: processes that exit when asked, ignore
//! the request, survive a kill, turn into zombies, or lose their pid to another process. Time is
//! the test's [`VirtualClock`], so a process that "takes 2 s to exit" costs the test nothing.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::Duration;

use super::{ExitRequest, Inspection, ProcessError, ProcessIdentity, ProcessTable};
use crate::clock::{Clock, VirtualClock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Signal {
    Exit,
    Kill,
}

#[derive(Debug, Clone, Copy)]
enum Reaction {
    Ignores,
    DiesAfter(Duration),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum View {
    Alive,
    /// Alive, with its executable file deleted.
    Unlinked,
    Zombie,
    Unreadable,
    Failing,
}

impl View {
    fn is_living(self) -> bool {
        matches!(self, Self::Alive | Self::Unlinked)
    }
}

struct Fake {
    identity: ProcessIdentity,
    parent: u32,
    view: View,
    on_exit: Reaction,
    on_kill: Reaction,
    /// What is left when it dies: a zombie, or nothing.
    leaves_zombie: bool,
    dies_at: Option<Duration>,
}

pub(crate) struct FakeTable<'a> {
    clock: &'a VirtualClock,
    processes: RefCell<BTreeMap<u32, Fake>>,
    signals: RefCell<Vec<(u32, Signal)>>,
    can_request_exit: bool,
}

impl<'a> FakeTable<'a> {
    pub(crate) fn new(clock: &'a VirtualClock) -> Self {
        Self {
            clock,
            processes: RefCell::new(BTreeMap::new()),
            signals: RefCell::new(Vec::new()),
            can_request_exit: true,
        }
    }

    /// A platform with no way to ask a process to exit.
    pub(crate) fn without_exit_requests(mut self) -> Self {
        self.can_request_exit = false;
        self
    }

    /// A live process that exits the moment it is asked and dies the moment it is killed.
    pub(crate) fn spawn(&self, pid: u32, started_at: u64, executable: &str) -> ProcessIdentity {
        let identity = ProcessIdentity {
            pid,
            started_at,
            executable: executable.into(),
        };
        self.processes.borrow_mut().insert(
            pid,
            Fake {
                identity: identity.clone(),
                parent: 1,
                view: View::Alive,
                on_exit: Reaction::DiesAfter(Duration::ZERO),
                on_kill: Reaction::DiesAfter(Duration::ZERO),
                leaves_zombie: false,
                dies_at: None,
            },
        );
        identity
    }

    fn with(&self, pid: u32, change: impl FnOnce(&mut Fake)) {
        change(
            self.processes
                .borrow_mut()
                .get_mut(&pid)
                .expect("a spawned pid"),
        );
    }

    pub(crate) fn parent(&self, pid: u32, parent: u32) {
        self.with(pid, |fake| fake.parent = parent);
    }

    pub(crate) fn exits_after(&self, pid: u32, taking: Duration) {
        self.with(pid, |fake| fake.on_exit = Reaction::DiesAfter(taking));
    }

    pub(crate) fn ignores_the_request_to_exit(&self, pid: u32) {
        self.with(pid, |fake| fake.on_exit = Reaction::Ignores);
    }

    pub(crate) fn survives_a_kill(&self, pid: u32) {
        self.with(pid, |fake| fake.on_kill = Reaction::Ignores);
    }

    pub(crate) fn leaves_a_zombie(&self, pid: u32) {
        self.with(pid, |fake| fake.leaves_zombie = true);
    }

    /// Already dead, exit status not yet collected.
    pub(crate) fn become_zombie(&self, pid: u32) {
        self.with(pid, |fake| fake.view = View::Zombie);
    }

    pub(crate) fn vanish(&self, pid: u32) {
        self.processes.borrow_mut().remove(&pid);
    }

    /// Another user's process: it exists, but this user may not look at it.
    pub(crate) fn become_unreadable(&self, pid: u32) {
        self.with(pid, |fake| fake.view = View::Unreadable);
    }

    /// Its executable file is deleted while it runs (macOS then gives no path).
    pub(crate) fn unlink(&self, pid: u32) {
        self.with(pid, |fake| fake.view = View::Unlinked);
    }

    /// The operating system fails when asked about this pid.
    pub(crate) fn fail_inspecting(&self, pid: u32) {
        self.with(pid, |fake| fake.view = View::Failing);
    }

    /// The old process is gone and its pid now belongs to a different one.
    pub(crate) fn reuse_pid(&self, pid: u32, started_at: u64, executable: &str) {
        self.vanish(pid);
        self.spawn(pid, started_at, executable);
    }

    /// Every signal sent, in order.
    pub(crate) fn signals(&self) -> Vec<(u32, Signal)> {
        self.signals.borrow().clone()
    }

    /// Applies a death that is due by now.
    fn settle(&self, pid: u32) {
        let mut processes = self.processes.borrow_mut();
        let Some(fake) = processes.get_mut(&pid) else {
            return;
        };
        if fake.view.is_living() && fake.dies_at.is_some_and(|at| at <= self.clock.now()) {
            if fake.leaves_zombie {
                fake.view = View::Zombie;
            } else {
                processes.remove(&pid);
            }
        }
    }

    fn schedule(&self, pid: u32, reaction: impl FnOnce(&Fake) -> Reaction) {
        let now = self.clock.now();
        if let Some(fake) = self.processes.borrow_mut().get_mut(&pid) {
            if !fake.view.is_living() {
                return;
            }
            if let Reaction::DiesAfter(taking) = reaction(fake) {
                let at = now + taking;
                fake.dies_at = Some(fake.dies_at.map_or(at, |earlier| earlier.min(at)));
            }
        }
    }
}

impl ProcessTable for FakeTable<'_> {
    fn pids(&self) -> Result<Vec<u32>, ProcessError> {
        let pids: Vec<u32> = self.processes.borrow().keys().copied().collect();
        pids.iter().for_each(|pid| self.settle(*pid));
        Ok(self.processes.borrow().keys().copied().collect())
    }

    fn inspect(&self, pid: u32) -> Result<Inspection, ProcessError> {
        self.settle(pid);
        let processes = self.processes.borrow();
        Ok(match processes.get(&pid) {
            None => Inspection::Absent,
            Some(fake) => match fake.view {
                View::Alive => Inspection::Alive(fake.identity.clone()),
                View::Unlinked => Inspection::Unlinked {
                    started_at: fake.identity.started_at,
                },
                View::Zombie => Inspection::Zombie,
                View::Unreadable => Inspection::Unreadable,
                View::Failing => {
                    return Err(ProcessError::Inspect {
                        pid,
                        detail: "the system refused".to_owned(),
                    });
                }
            },
        })
    }

    fn parent_of(&self, pid: u32) -> Result<Option<u32>, ProcessError> {
        self.settle(pid);
        Ok(self
            .processes
            .borrow()
            .get(&pid)
            .filter(|fake| fake.view.is_living())
            .map(|fake| fake.parent))
    }

    fn request_exit(&self, pid: u32) -> Result<ExitRequest, ProcessError> {
        if !self.can_request_exit {
            return Ok(ExitRequest::Unsupported);
        }
        self.signals.borrow_mut().push((pid, Signal::Exit));
        self.schedule(pid, |fake| fake.on_exit);
        Ok(ExitRequest::Sent)
    }

    fn kill(&self, pid: u32) -> Result<(), ProcessError> {
        self.signals.borrow_mut().push((pid, Signal::Kill));
        self.schedule(pid, |fake| fake.on_kill);
        Ok(())
    }
}
