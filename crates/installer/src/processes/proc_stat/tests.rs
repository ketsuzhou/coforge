use std::path::{Path, PathBuf};

use super::*;

/// `/proc/<pid>/stat` of a running process, with the fields named in proc_pid_stat(5): after
/// `ppid` come pgrp, session, tty_nr, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime,
/// stime, cutime, cstime, priority, nice, num_threads, itrealvalue, and then starttime (22).
const RUNNING: &str = "1234 (coforge-computer) S 1 1234 1234 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 4 0 987654 123456789 4000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n";

#[test]
fn reads_the_state_parent_and_start_time() {
    assert_eq!(
        parse_stat(RUNNING),
        Some(Stat {
            state: 'S',
            parent: 1,
            start_ticks: 987654
        })
    );
}

#[test]
fn a_process_name_with_spaces_and_parentheses_does_not_shift_the_fields() {
    let text = RUNNING.replace("(coforge-computer)", "(a b) S (x)");
    assert_eq!(
        parse_stat(&text),
        Some(Stat {
            state: 'S',
            parent: 1,
            start_ticks: 987654
        })
    );
}

#[test]
fn a_zombie_and_a_dead_process_are_dead() {
    for state in ['Z', 'X', 'x'] {
        assert!(
            Stat {
                state,
                parent: 1,
                start_ticks: 1
            }
            .is_dead(),
            "{state}"
        );
    }
    for state in ['R', 'S', 'D', 'T', 't', 'I'] {
        assert!(
            !Stat {
                state,
                parent: 1,
                start_ticks: 1
            }
            .is_dead(),
            "{state}"
        );
    }
}

#[test]
fn text_that_is_not_a_stat_line_is_not_read() {
    for text in ["", "1234", "1234 (x)", "1234 (x) S 1", "1234 (x) S one 2"] {
        assert_eq!(parse_stat(text), None, "{text:?}");
    }
}

#[test]
fn linux_marks_a_replaced_executable_deleted_and_it_is_still_the_same_file() {
    assert_eq!(
        executable(Path::new("/opt/coforge/coforge-computer (deleted)")),
        PathBuf::from("/opt/coforge/coforge-computer")
    );
    assert_eq!(
        executable(Path::new("/opt/coforge/coforge-computer")),
        PathBuf::from("/opt/coforge/coforge-computer")
    );
}
