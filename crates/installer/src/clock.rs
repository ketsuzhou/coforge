//! The clock and sleep port. Every bounded wait in the installer (a service manager that has to
//! drop a job, a process that has to exit) reads time and sleeps through [`Clock`], so its tests
//! run on a virtual clock and take no real time.

use std::time::{Duration, Instant};

pub trait Clock {
    /// Time since an arbitrary fixed origin. Only differences mean anything.
    fn now(&self) -> Duration;

    fn sleep(&self, duration: Duration);
}

/// The wall clock: [`Instant`] and [`std::thread::sleep`].
#[derive(Debug, Clone, Copy)]
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// Calls `probe` until it yields a value, sleeping `interval` between calls, for at most `bound`.
/// `Ok(None)` means the bound elapsed first; the probe always runs at least once, and once more
/// after the last sleep. An error from the probe ends the wait at once.
pub fn poll_until<T, E>(
    clock: &dyn Clock,
    bound: Duration,
    interval: Duration,
    mut probe: impl FnMut() -> Result<Option<T>, E>,
) -> Result<Option<T>, E> {
    let deadline = clock.now() + bound;
    loop {
        if let Some(found) = probe()? {
            return Ok(Some(found));
        }
        if clock.now() >= deadline {
            return Ok(None);
        }
        clock.sleep(interval);
    }
}

#[cfg(test)]
pub(crate) use virtual_clock::VirtualClock;

#[cfg(test)]
mod virtual_clock {
    use std::cell::{Cell, RefCell};
    use std::time::Duration;

    use super::Clock;

    /// A clock that only moves when something sleeps on it, and remembers every sleep.
    #[derive(Debug, Default)]
    pub(crate) struct VirtualClock {
        now: Cell<Duration>,
        sleeps: RefCell<Vec<Duration>>,
    }

    impl VirtualClock {
        pub(crate) fn new() -> Self {
            Self::default()
        }

        pub(crate) fn sleeps(&self) -> Vec<Duration> {
            self.sleeps.borrow().clone()
        }

        pub(crate) fn elapsed(&self) -> Duration {
            self.now.get()
        }
    }

    impl Clock for VirtualClock {
        fn now(&self) -> Duration {
            self.now.get()
        }

        fn sleep(&self, duration: Duration) {
            self.now.set(self.now.get() + duration);
            self.sleeps.borrow_mut().push(duration);
        }
    }
}

#[cfg(test)]
mod tests;
