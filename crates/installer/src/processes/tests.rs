use std::time::Duration;

use super::fakes::{FakeTable, Signal};
use super::*;
use crate::clock::VirtualClock;

const PRODUCT: &str = "/home/u/.coforge/computer/install/versions/1.2.3/coforge-computer";
const AGENT: &str = "/usr/local/bin/claude";
const SECOND: Duration = Duration::from_secs(1);

fn product() -> ProductExecutable {
    ProductExecutable(PRODUCT.into())
}

fn pids(identities: &[ProcessIdentity]) -> Vec<u32> {
    identities.iter().map(|identity| identity.pid).collect()
}

// --- the caller ---

#[test]
fn a_caller_that_is_the_installers_immediate_parent_is_verified() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(200, 5, "/usr/bin/coforge-installer");
    table.parent(200, 100);
    let caller = VerifiedCaller::verify(&table, 200, 100).unwrap();
    assert_eq!(caller.pid(), 100);
}

#[test]
fn a_caller_that_is_not_the_parent_is_refused_naming_both() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(200, 5, "/usr/bin/coforge-installer");
    table.parent(200, 100);
    let error = VerifiedCaller::verify(&table, 200, 999).unwrap_err();
    assert_eq!(
        error,
        ProcessError::CallerNotParent {
            claimed: 999,
            actual: Some(100)
        }
    );
    let message = error.to_string();
    assert!(
        message.contains("999") && message.contains("100"),
        "{message}"
    );
    assert!(message.contains("--caller-pid"), "{message}");
}

#[test]
fn a_caller_is_refused_when_the_installers_own_parent_cannot_be_found() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let error = VerifiedCaller::verify(&table, 200, 100).unwrap_err();
    assert_eq!(
        error,
        ProcessError::CallerNotParent {
            claimed: 100,
            actual: None
        }
    );
}

// --- collecting ---

#[test]
fn collects_every_process_of_the_product_executable_and_no_other() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    // The supervisor, a daemon, and an `__agent-cli` re-exec all run the one file.
    let supervisor = table.spawn(40, 1000, PRODUCT);
    let daemon = table.spawn(12, 1010, PRODUCT);
    let agent_cli = table.spawn(77, 1020, PRODUCT);
    table.spawn(50, 1030, AGENT);
    table.spawn(
        51,
        1040,
        "/home/u/.coforge/computer/install/versions/1.2.3/other",
    );
    let found = collect(&table, &product(), None).unwrap();
    assert_eq!(found, vec![daemon, supervisor, agent_cli]);
}

#[test]
fn zombies_and_processes_that_may_not_be_inspected_are_not_collected() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(1, 1, PRODUCT);
    table.spawn(2, 2, PRODUCT);
    table.spawn(3, 3, PRODUCT);
    table.become_zombie(1);
    table.become_unreadable(2);
    assert_eq!(pids(&collect(&table, &product(), None).unwrap()), vec![3]);
}

#[test]
fn a_process_whose_executable_was_deleted_is_passed_over_not_an_error() {
    // macOS gives no path for an image whose file is gone: any app that updated itself in place
    // while running. The installer never deletes a version, so such a process is not the
    // product's.
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(1, 1, "/Applications/Some.app/Contents/MacOS/Some");
    table.spawn(2, 2, PRODUCT);
    table.unlink(1);
    assert_eq!(pids(&collect(&table, &product(), None).unwrap()), vec![2]);
}

#[test]
fn the_verified_caller_is_never_collected() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, PRODUCT); // `coforge-computer upgrade`, waiting for the installer
    table.spawn(200, 2, "/usr/bin/coforge-installer");
    table.parent(200, 100);
    table.spawn(300, 3, PRODUCT);
    let caller = VerifiedCaller::verify(&table, 200, 100).unwrap();
    let found = collect(&table, &product(), Some(&caller)).unwrap();
    assert_eq!(pids(&found), vec![300]);
}

#[test]
fn a_process_that_cannot_be_inspected_stops_the_collection_rather_than_being_missed() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(1, 1, PRODUCT);
    table.spawn(2, 2, PRODUCT);
    table.fail_inspecting(2);
    assert!(matches!(
        collect(&table, &product(), None),
        Err(ProcessError::Inspect { pid: 2, .. })
    ));
}

// --- terminating and proving dead ---

fn terminate_with(
    table: &FakeTable<'_>,
    clock: &VirtualClock,
    identities: &[ProcessIdentity],
) -> Result<Termination, ProcessError> {
    terminate(table, clock, Escalation::default(), identities)
}

#[test]
fn nothing_alive_is_verified_dead_without_a_signal_or_a_wait() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let gone = table.spawn(1, 1, PRODUCT);
    let zombie = table.spawn(2, 2, PRODUCT);
    table.vanish(1);
    table.become_zombie(2);
    let outcome = terminate_with(&table, &clock, &[gone.clone(), zombie.clone()]).unwrap();
    assert_eq!(
        outcome,
        Termination {
            verified_dead: vec![gone, zombie],
            forced_kills: 0
        }
    );
    assert_eq!(table.signals(), vec![]);
    assert_eq!(clock.elapsed(), Duration::ZERO);
}

#[test]
fn no_processes_is_no_work() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let outcome = terminate_with(&table, &clock, &[]).unwrap();
    assert_eq!(outcome.verified_dead, vec![]);
}

#[test]
fn a_reused_pid_is_dead_and_the_new_process_is_left_alone() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let same_file_later = table.spawn(10, 100, PRODUCT);
    let other_file = table.spawn(11, 100, PRODUCT);
    // Both pids now belong to unrelated processes: one started later, one runs another file.
    table.reuse_pid(10, 999, PRODUCT);
    table.reuse_pid(11, 100, AGENT);
    let outcome = terminate_with(&table, &clock, &[same_file_later, other_file]).unwrap();
    assert_eq!(outcome.forced_kills, 0);
    assert_eq!(table.signals(), vec![]);
    assert_eq!(clock.elapsed(), Duration::ZERO);
}

#[test]
fn a_collected_process_whose_executable_is_deleted_is_still_that_process_until_it_exits() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let daemon = table.spawn(40, 1, PRODUCT);
    table.unlink(40);
    table.exits_after(40, 2 * SECOND);
    let outcome = terminate_with(&table, &clock, std::slice::from_ref(&daemon)).unwrap();
    assert_eq!(outcome.verified_dead, vec![daemon]);
    assert_eq!(table.signals(), vec![(40, Signal::Exit)]);
    assert_eq!(clock.elapsed(), 2 * SECOND);
}

#[test]
fn a_reused_pid_whose_executable_is_deleted_is_dead_and_left_alone() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let daemon = table.spawn(40, 1, PRODUCT);
    table.reuse_pid(40, 999, AGENT);
    table.unlink(40);
    let outcome = terminate_with(&table, &clock, std::slice::from_ref(&daemon)).unwrap();
    assert_eq!(outcome.verified_dead, vec![daemon]);
    assert_eq!(table.signals(), vec![]);
}

#[test]
fn a_process_that_exits_when_asked_is_not_killed() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let daemon = table.spawn(40, 1, PRODUCT);
    table.exits_after(40, 2 * SECOND);
    let outcome = terminate_with(&table, &clock, std::slice::from_ref(&daemon)).unwrap();
    assert_eq!(outcome.forced_kills, 0);
    assert_eq!(outcome.verified_dead, vec![daemon]);
    assert_eq!(table.signals(), vec![(40, Signal::Exit)]);
    assert_eq!(clock.elapsed(), 2 * SECOND);
}

#[test]
fn a_process_that_ignores_the_request_is_killed_after_fifteen_seconds() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let daemon = table.spawn(40, 1, PRODUCT);
    table.ignores_the_request_to_exit(40);
    let outcome = terminate_with(&table, &clock, std::slice::from_ref(&daemon)).unwrap();
    assert_eq!(outcome.forced_kills, 1);
    assert_eq!(
        table.signals(),
        vec![(40, Signal::Exit), (40, Signal::Kill)]
    );
    assert_eq!(clock.elapsed(), Duration::from_secs(15));
}

#[test]
fn a_killed_process_that_lingers_as_a_zombie_is_dead() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let daemon = table.spawn(40, 1, PRODUCT);
    table.ignores_the_request_to_exit(40);
    table.leaves_a_zombie(40);
    let outcome = terminate_with(&table, &clock, &[daemon]).unwrap();
    assert_eq!(outcome.forced_kills, 1);
}

#[test]
fn a_process_that_survives_the_kill_fails_the_stop_and_is_named() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let stubborn = table.spawn(40, 1, PRODUCT);
    let polite = table.spawn(41, 2, PRODUCT);
    table.ignores_the_request_to_exit(40);
    table.survives_a_kill(40);
    let error = terminate_with(&table, &clock, &[stubborn.clone(), polite]).unwrap_err();
    assert_eq!(clock.elapsed(), Duration::from_secs(20));
    let ProcessError::StillAlive { survivors, .. } = &error else {
        panic!("{error:?}");
    };
    assert_eq!(survivors, &vec![stubborn]);
    let message = error.to_string();
    assert!(message.contains("40"), "{message}");
    assert!(!message.contains("41"), "{message}");
    assert!(message.contains(PRODUCT), "{message}");
    let by_hand = if cfg!(windows) {
        "taskkill /F /PID 40"
    } else {
        "kill -9 40"
    };
    assert!(message.contains(by_hand), "{message}");
}

#[test]
fn only_what_is_still_alive_is_signalled() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let already = table.spawn(1, 1, PRODUCT);
    let alive = table.spawn(2, 2, PRODUCT);
    table.vanish(1);
    let outcome = terminate_with(&table, &clock, &[already, alive]).unwrap();
    assert_eq!(table.signals(), vec![(2, Signal::Exit)]);
    assert_eq!(outcome.forced_kills, 0);
}

#[test]
fn a_platform_that_cannot_ask_goes_straight_to_the_kill_without_the_idle_wait() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock).without_exit_requests();
    let daemon = table.spawn(40, 1, PRODUCT);
    let outcome = terminate_with(&table, &clock, &[daemon]).unwrap();
    assert_eq!(outcome.forced_kills, 1);
    assert_eq!(table.signals(), vec![(40, Signal::Kill)]);
    assert_eq!(clock.elapsed(), Duration::ZERO);
}

#[test]
fn a_process_that_cannot_be_inspected_is_not_proven_dead() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let daemon = table.spawn(40, 1, PRODUCT);
    table.become_unreadable(40);
    table.ignores_the_request_to_exit(40);
    table.survives_a_kill(40);
    let error = terminate_with(&table, &clock, &[daemon]).unwrap_err();
    assert!(
        matches!(error, ProcessError::StillAlive { .. }),
        "{error:?}"
    );
}

#[test]
fn the_caller_is_neither_signalled_nor_waited_for_across_collect_and_terminate() {
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    table.spawn(100, 1, PRODUCT); // waiting `coforge-computer upgrade`
    table.ignores_the_request_to_exit(100);
    table.survives_a_kill(100);
    table.spawn(200, 2, "/usr/bin/coforge-installer");
    table.parent(200, 100);
    table.spawn(300, 3, PRODUCT);
    let caller = VerifiedCaller::verify(&table, 200, 100).unwrap();
    let collected = collect(&table, &product(), Some(&caller)).unwrap();
    let outcome = terminate_with(&table, &clock, &collected).unwrap();
    assert_eq!(pids(&outcome.verified_dead), vec![300]);
    assert_eq!(table.signals(), vec![(300, Signal::Exit)]);
    assert_eq!(clock.elapsed(), Duration::ZERO);
}

// --- what a path is ---

#[test]
fn a_windows_path_compares_without_its_verbatim_prefix_or_its_case() {
    assert_eq!(
        windows_key(Path::new(
            r"\\?\C:\Users\Frank\.coforge\coforge-computer.exe"
        )),
        windows_key(Path::new(r"c:/users/frank/.coforge/COFORGE-COMPUTER.EXE"))
    );
    assert_eq!(
        windows_key(Path::new(r"\\?\UNC\host\share\a.exe")),
        windows_key(Path::new(r"\\HOST\Share\A.exe"))
    );
    assert_ne!(
        windows_key(Path::new(r"C:\a\coforge-computer.exe")),
        windows_key(Path::new(r"C:\b\coforge-computer.exe"))
    );
}

#[cfg(unix)]
mod on_unix {
    use std::fs;
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::test_support::Scratch;

    #[test]
    fn the_product_executable_is_the_file_the_active_link_points_at() {
        let scratch = Scratch::new("product-executable");
        let version = scratch.path().join("versions/1.2.3");
        fs::create_dir_all(&version).unwrap();
        fs::write(version.join("coforge-computer"), "binary").unwrap();
        symlink(&version, scratch.path().join("active")).unwrap();

        let product =
            ProductExecutable::resolve(&scratch.path().join("active/coforge-computer")).unwrap();
        let real = fs::canonicalize(version.join("coforge-computer")).unwrap();
        assert_eq!(product.path(), real);
        assert!(product.matches(&real));
        // Not the link the process may have been started through, and not another file.
        assert!(!product.matches(&scratch.path().join("active/coforge-computer")));
        assert!(!product.matches(Path::new("/bin/sh")));
    }

    #[test]
    fn an_executable_that_is_not_there_is_an_error() {
        let scratch = Scratch::new("product-missing");
        assert!(ProductExecutable::resolve(&scratch.path().join("coforge-computer")).is_err());
    }
}

/// The one place these tests touch real processes: children this test spawns and owns, each ended
/// by the test itself or by its guard, and never a process it did not start.
#[cfg(unix)]
mod on_this_machine {
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    use super::*;
    use crate::clock::SystemClock;

    /// Ends and reaps the child however the test ends.
    struct Guard(Child);

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn alive(pid: u32) -> ProcessIdentity {
        match OsProcesses.inspect(pid).unwrap() {
            Inspection::Alive(identity) => identity,
            other => panic!("expected process {pid} to be alive, found {other:?}"),
        }
    }

    #[test]
    fn a_real_child_is_identified_ended_on_request_and_verified_dead() {
        // Started through a symlinked directory, as the Computer is through `install/active`.
        let scratch = crate::test_support::Scratch::new("real-child");
        std::os::unix::fs::symlink("/bin", scratch.path().join("active")).unwrap();
        let through_the_link = scratch.path().join("active/sleep");
        let mut child = Guard(
            Command::new(&through_the_link)
                .arg("60")
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();

        let identity = alive(pid);
        assert_eq!(identity.pid, pid);
        assert!(identity.started_at > 0);
        assert_eq!(identity.executable, fs::canonicalize("/bin/sleep").unwrap());
        assert_eq!(
            alive(pid),
            identity,
            "an identity is stable for the life of the process"
        );
        assert_eq!(
            OsProcesses.parent_of(pid).unwrap(),
            Some(std::process::id())
        );

        // The whole machine's process table, and this child is in what the executable selects.
        let product = ProductExecutable::resolve(&through_the_link).unwrap();
        assert_eq!(product.path(), identity.executable);
        assert!(
            collect(&OsProcesses, &product, None)
                .unwrap()
                .contains(&identity)
        );

        // Only this child is terminated, whatever else is running `sleep`.
        let outcome = terminate(
            &OsProcesses,
            &SystemClock::new(),
            Escalation::default(),
            std::slice::from_ref(&identity),
        )
        .unwrap();
        assert_eq!(outcome.forced_kills, 0);
        assert_eq!(outcome.verified_dead, vec![identity]);

        // Not yet reaped by its parent, which is this test. Linux shows a zombie there; macOS
        // already refuses to describe it (ESRCH). Both are dead.
        let unreaped = OsProcesses.inspect(pid).unwrap();
        if cfg!(target_os = "linux") {
            assert_eq!(unreaped, Inspection::Zombie);
        } else {
            assert!(
                matches!(unreaped, Inspection::Zombie | Inspection::Absent),
                "{unreaped:?}"
            );
        }
        child.0.wait().unwrap();
        assert_eq!(OsProcesses.inspect(pid).unwrap(), Inspection::Absent);
    }

    #[test]
    fn a_real_child_whose_executable_is_deleted_is_still_found_dead_after_it_is_ended() {
        let scratch = crate::test_support::Scratch::new("deleted-image");
        let copy = scratch.path().join("sleep");
        fs::copy("/bin/sleep", &copy).unwrap();
        let mut child = Guard(
            Command::new(&copy)
                .arg("60")
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        let identity = alive(pid);
        fs::remove_file(&copy).unwrap();

        // Linux keeps the path (`/proc/<pid>/exe` reads `<path> (deleted)`); macOS has none left.
        let now = OsProcesses.inspect(pid).unwrap();
        if cfg!(target_os = "linux") {
            assert_eq!(now, Inspection::Alive(identity.clone()));
        } else {
            assert_eq!(
                now,
                Inspection::Unlinked {
                    started_at: identity.started_at
                }
            );
        }

        let outcome = terminate(
            &OsProcesses,
            &SystemClock::new(),
            Escalation::default(),
            std::slice::from_ref(&identity),
        )
        .unwrap();
        assert_eq!(outcome.forced_kills, 0);
        assert_eq!(outcome.verified_dead, vec![identity]);
        child.0.wait().unwrap();
    }

    #[test]
    fn a_real_child_that_ignores_the_request_is_killed() {
        let mut child = Guard(
            Command::new("/bin/sh")
                .args(["-c", "trap '' TERM; echo ready; while :; do :; done"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        // The trap is in place once the shell says so; a request before that would end it.
        let mut line = String::new();
        BufReader::new(child.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "ready\n");
        let identity = alive(child.0.id());

        let escalation = Escalation {
            exit_wait: Duration::from_millis(300),
            kill_wait: Duration::from_secs(5),
            poll: Duration::from_millis(10),
        };
        let outcome = terminate(
            &OsProcesses,
            &SystemClock::new(),
            escalation,
            std::slice::from_ref(&identity),
        )
        .unwrap();
        assert_eq!(outcome.forced_kills, 1);
        assert_eq!(outcome.verified_dead, vec![identity]);
    }

    #[test]
    fn this_processs_parent_is_what_the_kernel_says_and_is_accepted_as_a_caller() {
        let own = std::process::id();
        // SAFETY: getppid(2) takes no arguments and cannot fail.
        let parent = unsafe { libc::getppid() } as u32;
        assert_eq!(OsProcesses.parent_of(own).unwrap(), Some(parent));
        assert_eq!(
            VerifiedCaller::verify(&OsProcesses, own, parent)
                .unwrap()
                .pid(),
            parent
        );
        assert!(matches!(
            VerifiedCaller::verify(&OsProcesses, own, own),
            Err(ProcessError::CallerNotParent { .. })
        ));
    }

    #[test]
    fn a_signal_never_addresses_a_group_the_installer_itself_or_a_pid_that_is_not_there() {
        use super::super::signals;

        for pid in [0, u32::MAX, i32::MAX as u32 + 1, std::process::id()] {
            assert!(
                matches!(signals::request_exit(pid), Err(ProcessError::Signal { .. })),
                "{pid}"
            );
            assert!(
                matches!(signals::kill(pid), Err(ProcessError::Signal { .. })),
                "{pid}"
            );
        }
        // No process has the largest pid: already gone is success, not an error.
        assert_eq!(signals::kill(i32::MAX as u32), Ok(()));
        assert_eq!(
            signals::request_exit(i32::MAX as u32),
            Ok(ExitRequest::Sent)
        );
    }
}
