//! The durable side of Windows Agent Runtime containment.
//!
//! `docs/agent-runtime-containment.md` requires the registry to store the guard
//! pid **together with its process creation time** so a reused pid is rejected.
//! That is the whole purpose of this module: a pid on its own is not an identity.
//! Windows hands pids out again quickly, so a row left behind by a crash can
//! name a pid that now belongs to something entirely unrelated -- and the two
//! wrong answers are both serious. Treating that row as live orphans a
//! containment nobody owns; treating it as dead invites terminating a stranger's
//! process, or reclaiming a staging directory a live provider is still writing.
//!
//! Every judgement therefore has three outcomes, never two: `Ours`, `Gone`, and
//! `Unknown`. `Unknown` is not a failure to decide -- it is the decision, and it
//! means fail closed: no reclaim, no terminate. A process whose creation time
//! cannot be read (it is a different user's, or it is exiting as we look) must
//! not be guessed at.
//!
//! ⚠️ Like `windows_job`, this is a prerequisite rather than the feature. The
//! containment document still requires staging isolation, Codex sandbox
//! compatibility and a broker-escape E2E before a Windows mode may be opened.

#![cfg(windows)]
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use crate::windows_job::{process_alive, process_creation_time};

const RECORD_FILE_NAME: &str = "agent-runtime-windows-containment.json";
const SCHEMA_VERSION: u64 = 1;

/// One contained provider, as it survives a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainmentRecord {
    pub launch_id: String,
    pub pid: u32,
    /// `GetProcessTimes` creation time. Zero is not accepted: a record that
    /// cannot fence its pid is worse than no record, because it reads as
    /// authority over whatever holds that pid later.
    pub created_at: u64,
}

/// What a stored row turned out to refer to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordIdentity {
    /// The pid is still the process this row was written for.
    Ours,
    /// The pid is gone, or now belongs to a different process. Safe to discard.
    Gone,
    /// The pid exists but its identity could not be established. Fail closed.
    Unknown,
}

fn record_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RECORD_FILE_NAME)
}

/// A launch id is used in durable state and in messages, so it is deliberately
/// narrow: anything else is rejected rather than sanitised, because a value that
/// had to be repaired is a value whose origin is not understood.
fn valid_launch_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn parse_records(raw: &str) -> Vec<ContainmentRecord> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    if value.get("schemaVersion").and_then(serde_json::Value::as_u64) != Some(SCHEMA_VERSION) {
        // A version this build does not understand is not partially adopted:
        // half-understood containment rows are what fail-closed exists to avoid.
        return Vec::new();
    }
    let Some(rows) = value.get("records").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for row in rows {
        let Some(launch_id) = row.get("launchId").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !valid_launch_id(launch_id) {
            continue;
        }
        let Some(pid) = row.get("pid").and_then(serde_json::Value::as_u64) else {
            continue;
        };
        let Some(created_at) = row.get("createdAt").and_then(serde_json::Value::as_u64) else {
            continue;
        };
        // A pid of 0 or 4 is the kernel, never a provider; a zero creation time
        // cannot fence anything.
        if pid <= 4 || pid > u64::from(u32::MAX) || created_at == 0 {
            continue;
        }
        if records
            .iter()
            .any(|existing: &ContainmentRecord| existing.launch_id == launch_id)
        {
            // Two rows for one launch id means the file was edited or merged by
            // something that is not this code. Keep the first and ignore the
            // rest rather than picking arbitrarily.
            continue;
        }
        records.push(ContainmentRecord {
            launch_id: launch_id.to_string(),
            pid: pid as u32,
            created_at,
        });
    }
    records
}

pub fn serialize_records(records: &[ContainmentRecord]) -> String {
    let rows: Vec<serde_json::Value> = records
        .iter()
        .map(|record| {
            serde_json::json!({
                "launchId": record.launch_id,
                "pid": record.pid,
                "createdAt": record.created_at,
            })
        })
        .collect();
    serde_json::json!({ "schemaVersion": SCHEMA_VERSION, "records": rows }).to_string()
}

pub fn read_records(app_data_dir: &Path) -> Vec<ContainmentRecord> {
    std::fs::read_to_string(record_path(app_data_dir))
        .ok()
        .map(|raw| parse_records(&raw))
        .unwrap_or_default()
}

/// Replaces the stored set.
///
/// Written to a temporary file and renamed, so a crash mid-write leaves the
/// previous set rather than a truncated one: a half-written containment registry
/// would lose track of live providers.
pub fn write_records(app_data_dir: &Path, records: &[ContainmentRecord]) -> Result<(), String> {
    let path = record_path(app_data_dir);
    let temporary = app_data_dir.join(format!(
        ".{RECORD_FILE_NAME}.{}.tmp",
        std::process::id()
    ));
    let result = (|| -> std::io::Result<()> {
        std::fs::write(&temporary, serialize_records(records))?;
        // Windows rename refuses an existing destination.
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        std::fs::rename(&temporary, &path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("containment registry write failed: {error}"));
    }
    Ok(())
}

/// What this row refers to right now.
pub fn identify(record: &ContainmentRecord) -> RecordIdentity {
    if record.created_at == 0 {
        return RecordIdentity::Unknown;
    }
    match process_creation_time(record.pid) {
        // ⚠️ A matching creation time alone is not liveness: a terminated process
        // stays openable while anything holds a handle to it, and keeps reporting
        // the same creation time. `process_alive` asks WaitForSingleObject as
        // well, which is signalled exactly when the process has exited.
        Ok(created_at) if created_at == record.created_at => {
            if process_alive(record.pid, record.created_at) {
                RecordIdentity::Ours
            } else {
                RecordIdentity::Gone
            }
        }
        // A live pid with a different creation time is a different process, so
        // the row is stale and discarding it cannot harm anyone.
        Ok(_) => RecordIdentity::Gone,
        Err(_) => {
            // The pid may be gone, or it may belong to another user and simply
            // not be openable. Those are not the same, and only one of them is
            // safe to act on, so neither is assumed.
            if pid_definitely_absent(record.pid) {
                RecordIdentity::Gone
            } else {
                RecordIdentity::Unknown
            }
        }
    }
}

/// Whether nothing holds this pid. Conservative: anything unclear answers false.
fn pid_definitely_absent(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: a limited-information query handle is the least this needs.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if !handle.is_null() {
        unsafe { CloseHandle(handle) };
        return false;
    }
    // ERROR_INVALID_PARAMETER (87) is what OpenProcess reports for a pid that
    // does not exist. ERROR_ACCESS_DENIED (5) means it exists and belongs to
    // somebody else, which is emphatically not absence.
    unsafe { GetLastError() == 87 }
}

/// The rows that may be discarded, and the rows that must be left alone.
///
/// Returned as two lists rather than one filtered list because the caller has to
/// treat them differently: `Unknown` rows are kept **and** must not be acted on.
pub fn triage(records: &[ContainmentRecord]) -> (Vec<ContainmentRecord>, Vec<ContainmentRecord>) {
    let mut discardable = Vec::new();
    let mut keep = Vec::new();
    for record in records {
        match identify(record) {
            RecordIdentity::Gone => discardable.push(record.clone()),
            RecordIdentity::Ours | RecordIdentity::Unknown => keep.push(record.clone()),
        }
    }
    (discardable, keep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_job::{ContainedProcess, ContainedStdio};
    use std::ffi::OsString;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentstoz-containment-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_record_round_trips_through_the_file() {
        let dir = temp_dir("roundtrip");
        let records = vec![
            ContainmentRecord { launch_id: "launch-a".into(), pid: 4242, created_at: 1234 },
            ContainmentRecord { launch_id: "launch_b".into(), pid: 99, created_at: 5678 },
        ];
        write_records(&dir, &records).expect("write");
        assert_eq!(read_records(&dir), records);
        // Replacing the set does not leave the old rows behind.
        write_records(&dir, &records[..1]).expect("rewrite");
        assert_eq!(read_records(&dir), records[..1].to_vec());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn anything_that_cannot_fence_its_pid_is_not_a_record() {
        // A row that cannot prove which process it means would read as authority
        // over whatever holds that pid next, so it is dropped at parse time.
        let cases = [
            r#"{"schemaVersion":1,"records":[{"launchId":"a","pid":100}]}"#,
            r#"{"schemaVersion":1,"records":[{"launchId":"a","pid":100,"createdAt":0}]}"#,
            r#"{"schemaVersion":1,"records":[{"launchId":"a","pid":4,"createdAt":9}]}"#,
            r#"{"schemaVersion":1,"records":[{"launchId":"","pid":100,"createdAt":9}]}"#,
            r#"{"schemaVersion":1,"records":[{"launchId":"a/b","pid":100,"createdAt":9}]}"#,
            // A schema this build does not understand is not partially adopted.
            r#"{"schemaVersion":2,"records":[{"launchId":"a","pid":100,"createdAt":9}]}"#,
            r#"{"records":[{"launchId":"a","pid":100,"createdAt":9}]}"#,
            "not json",
            "",
        ];
        for raw in cases {
            assert!(parse_records(raw).is_empty(), "accepted: {raw}");
        }
        // Two rows for one launch id: keep the first, never pick arbitrarily.
        let duplicated = parse_records(
            r#"{"schemaVersion":1,"records":[
                {"launchId":"a","pid":100,"createdAt":9},
                {"launchId":"a","pid":200,"createdAt":10}
            ]}"#,
        );
        assert_eq!(duplicated.len(), 1);
        assert_eq!(duplicated[0].pid, 100);
    }

    #[test]
    fn a_live_contained_process_is_recognised_as_ours() {
        let contained = ContainedProcess::spawn(
            &OsString::from("cmd.exe /c ping -n 31 127.0.0.1"),
            None,
            ContainedStdio::Null,
        )
        .expect("spawn");
        let record = ContainmentRecord {
            launch_id: "live-launch".into(),
            pid: contained.pid(),
            created_at: contained.created_at(),
        };
        assert_eq!(identify(&record), RecordIdentity::Ours);

        // The same pid with a different creation time is a different process, so
        // the row is stale -- this is the reuse fence the document asks for.
        let reused = ContainmentRecord { created_at: record.created_at + 1, ..record.clone() };
        assert_eq!(identify(&reused), RecordIdentity::Gone);

        let (discardable, keep) = triage(&[record.clone(), reused]);
        assert_eq!(discardable.len(), 1);
        assert_eq!(keep, vec![record]);
        contained.terminate_proven(1).expect("terminate");
    }

    #[test]
    fn a_terminated_process_leaves_a_discardable_row() {
        let (pid, created_at) = {
            let contained = ContainedProcess::spawn(
                &OsString::from("cmd.exe /c ping -n 31 127.0.0.1"),
                None,
                ContainedStdio::Null,
            )
            .expect("spawn");
            let identity = (contained.pid(), contained.created_at());
            contained.terminate_proven(1).expect("terminate");
            identity
        };
        std::thread::sleep(std::time::Duration::from_millis(400));
        let record = ContainmentRecord { launch_id: "ended".into(), pid, created_at };
        // Either the pid is gone, or something else holds it now; both are Gone.
        // What must not happen is Ours, which would orphan a containment.
        assert_ne!(identify(&record), RecordIdentity::Ours);
    }

    #[test]
    fn a_record_with_no_creation_time_fails_closed() {
        // Not Gone: a row that cannot be identified must not authorise a
        // reclaim or a terminate.
        let record = ContainmentRecord { launch_id: "blind".into(), pid: 4242, created_at: 0 };
        assert_eq!(identify(&record), RecordIdentity::Unknown);
        let (discardable, keep) = triage(&[record.clone()]);
        assert!(discardable.is_empty());
        assert_eq!(keep, vec![record]);
    }

    #[test]
    fn the_kernel_is_never_a_provider() {
        // pid 4 is the System process. A row naming it would hand this code
        // authority it must never have, so it never becomes a record at all.
        assert!(parse_records(
            r#"{"schemaVersion":1,"records":[{"launchId":"system","pid":4,"createdAt":1}]}"#
        )
        .is_empty());
        assert!(!pid_definitely_absent(4));
    }
}
