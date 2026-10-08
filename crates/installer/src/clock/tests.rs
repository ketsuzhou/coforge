use std::time::Duration;

use super::*;

const SECOND: Duration = Duration::from_secs(1);

#[test]
fn a_probe_that_succeeds_at_once_never_sleeps() {
    let clock = VirtualClock::new();
    let found = poll_until(&clock, 15 * SECOND, SECOND, || Ok::<_, ()>(Some(7)));
    assert_eq!(found, Ok(Some(7)));
    assert_eq!(clock.sleeps(), Vec::<Duration>::new());
}

#[test]
fn polling_sleeps_one_interval_between_probes() {
    let clock = VirtualClock::new();
    let mut probes = 0;
    let found = poll_until(&clock, 15 * SECOND, SECOND, || {
        probes += 1;
        Ok::<_, ()>((probes == 3).then_some(probes))
    });
    assert_eq!(found, Ok(Some(3)));
    assert_eq!(clock.sleeps(), vec![SECOND, SECOND]);
}

#[test]
fn polling_gives_up_once_the_bound_has_elapsed() {
    let clock = VirtualClock::new();
    let mut probes = 0;
    let found = poll_until(&clock, 3 * SECOND, SECOND, || {
        probes += 1;
        Ok::<Option<()>, ()>(None)
    });
    assert_eq!(found, Ok(None));
    // A probe at 0 s, 1 s, 2 s and 3 s: the last one lands on the bound and is still made.
    assert_eq!(probes, 4);
    assert_eq!(clock.elapsed(), 3 * SECOND);
}

#[test]
fn a_probe_error_ends_the_wait() {
    let clock = VirtualClock::new();
    let found = poll_until(&clock, 15 * SECOND, SECOND, || Err::<Option<()>, _>("boom"));
    assert_eq!(found, Err("boom"));
    assert_eq!(clock.sleeps(), Vec::<Duration>::new());
}

#[test]
fn the_system_clock_moves_forward_and_sleeps_for_real() {
    let clock = SystemClock::new();
    let before = clock.now();
    clock.sleep(Duration::from_millis(20));
    assert!(clock.now() - before >= Duration::from_millis(20));
}
