//! Per-launch staging for a contained provider, and harvesting what it wrote.
//!
//! This is the `staging-prepared` → `materialized` half of the containment state
//! machine in `docs/agent-runtime-containment.md`. Low integrity is what closes
//! the broker escapes (measured: WMI, the task scheduler and the explorer broker
//! all escape a Job Object at normal integrity and none of them at low), and the
//! price is that the provider can only write where a mandatory label allows. So
//! it gets one directory, and afterwards the owner — which runs at normal
//! integrity and may read down — takes out the part that has to survive.
//!
//! Two decisions here are load-bearing:
//!
//! - **`CODEX_HOME` is staged; `~/.codex` is never relabelled.** Relabelling it
//!   would hand a low-integrity provider write access to the user's `auth.json`
//!   and to the rollout history 「내가 한 말」 reads. Staging keeps the blast
//!   radius to one launch.
//! - ⚠️ **Staging must not live under `%TEMP%`.** Measured: Codex refuses to
//!   create its PATH-alias helper binaries under the temp tree ("Refusing to
//!   create helper binaries under temporary dir …"). Under the app's own local
//!   data its stderr is empty.
//!
//! ⚠️ Everything in staging was written by the contained provider, so the harvest
//! treats it as untrusted: names are matched, not trusted; nothing is followed;
//! nothing outside the destination is written; and an existing file is never
//! overwritten.

#![cfg(windows)]
#![allow(dead_code)]

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::windows_job::label_low_integrity;

/// Directory under the app's local data that holds one subtree per launch.
pub const STAGING_DIRECTORY: &str = "agent-runtime-staging";

/// The directories one contained launch is given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staging {
    pub root: PathBuf,
    /// `CODEX_HOME` for this launch.
    pub codex_home: PathBuf,
    /// `TEMP`/`TMP` for this launch, so scratch stays inside the label.
    pub scratch: PathBuf,
}

/// What a harvest moved, and what it refused.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HarvestReport {
    /// Destination-relative paths that were written.
    pub materialized: Vec<String>,
    /// Staging-relative paths that were refused, with the reason.
    pub refused: Vec<(String, String)>,
}

/// A rollout, as Codex files it: `sessions/YYYY/MM/DD/rollout-*.jsonl`.
fn is_rollout_relative(relative: &Path) -> bool {
    let parts: Vec<&OsStr> = relative.iter().collect();
    if parts.len() != 5 {
        return false;
    }
    if parts[0] != OsStr::new("sessions") {
        return false;
    }
    let digits = |value: &OsStr, len: usize| {
        value
            .to_str()
            .is_some_and(|text| text.len() == len && text.bytes().all(|b| b.is_ascii_digit()))
    };
    if !digits(parts[1], 4) || !digits(parts[2], 2) || !digits(parts[3], 2) {
        return false;
    }
    parts[4]
        .to_str()
        .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
}

/// Whether a path is made only of plain names.
///
/// ⚠️ The provider chose these names. A `..`, a root, a drive prefix or a verbatim
/// `\\?\` component would let the harvest write outside its destination, so the
/// path is rejected rather than normalised: a path that had to be repaired is a
/// path whose origin is not understood.
fn is_plain_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Creates and labels one launch's staging. `launch_id` must be a plain name.
pub fn prepare(local_app_data: &Path, launch_id: &str) -> Result<Staging, String> {
    if launch_id.is_empty()
        || launch_id.len() > 64
        || !launch_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!("invalid staging launch id: {launch_id:?}"));
    }
    let root = local_app_data.join(STAGING_DIRECTORY).join(launch_id);
    if root.exists() {
        // A leftover subtree is a different launch's, or this id is being reused;
        // neither may be adopted silently.
        return Err(format!("staging already exists: {}", root.display()));
    }
    let codex_home = root.join("codex-home");
    let scratch = root.join("scratch");
    for directory in [&root, &codex_home, &scratch] {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
    }
    // The label is inherited by whatever the provider creates inside.
    for directory in [&codex_home, &scratch] {
        label_low_integrity(directory.as_os_str())?;
    }
    Ok(Staging { root, codex_home, scratch })
}

/// Copies this launch's rollouts out of staging into the real Codex home.
///
/// Only rollouts, because that is what has to survive: 「내가 한 말」 and Codex
/// 「다시 시작」 both read `sessions/…/rollout-*.jsonl`, and on Windows the resume
/// path has nothing else to go on (there is no lsof to name the live thread).
/// Everything else the provider wrote stays in staging and is disposed of.
pub fn harvest_rollouts(
    staging: &Staging,
    destination_codex_home: &Path,
    max_bytes: u64,
) -> HarvestReport {
    let mut report = HarvestReport::default();
    let mut pending = vec![staging.codex_home.join("sessions")];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            // `symlink_metadata` so a link is seen as a link and not followed.
            let Ok(metadata) = std::fs::symlink_metadata(&path) else { continue };
            let Ok(relative) = path.strip_prefix(&staging.codex_home) else { continue };
            let shown = relative.to_string_lossy().to_string();
            if metadata.is_symlink() {
                // A provider that planted a link could otherwise make the
                // harvest read or write anywhere this process can.
                report.refused.push((shown, "symlink".to_string()));
                continue;
            }
            if metadata.is_dir() {
                if is_plain_relative(relative) {
                    pending.push(path);
                } else {
                    report.refused.push((shown, "not a plain relative path".to_string()));
                }
                continue;
            }
            if !is_plain_relative(relative) {
                report.refused.push((shown, "not a plain relative path".to_string()));
                continue;
            }
            if !is_rollout_relative(relative) {
                report.refused.push((shown, "not a rollout".to_string()));
                continue;
            }
            if metadata.len() > max_bytes {
                report.refused.push((shown, format!("larger than {max_bytes} bytes")));
                continue;
            }
            let target = destination_codex_home.join(relative);
            if target.exists() {
                // Never overwrite: the destination holds the user's real history,
                // and a provider must not be able to replace an entry in it.
                report.refused.push((shown, "already present".to_string()));
                continue;
            }
            let Some(parent) = target.parent() else {
                report.refused.push((shown, "no destination directory".to_string()));
                continue;
            };
            if let Err(error) = std::fs::create_dir_all(parent) {
                report.refused.push((shown, format!("could not create the destination: {error}")));
                continue;
            }
            match std::fs::copy(&path, &target) {
                Ok(_) => report.materialized.push(relative.to_string_lossy().to_string()),
                Err(error) => report.refused.push((shown, format!("copy failed: {error}"))),
            }
        }
    }
    report.materialized.sort();
    report.refused.sort();
    report
}

/// Removes one launch's staging. Called after the harvest, on every path.
pub fn dispose(staging: &Staging) -> Result<(), String> {
    for attempt in 0..5 {
        match std::fs::remove_dir_all(&staging.root) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                if attempt == 4 {
                    return Err(format!("could not dispose {}: {error}", staging.root.display()));
                }
                // A provider's last writes can still hold a handle for a moment.
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "agentstoz-staging-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&root).expect("test root");
        root
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        std::fs::write(path, contents).expect("write");
    }

    #[test]
    fn staging_is_labelled_and_never_reused() {
        let base = temp_root("prepare");
        let staging = prepare(&base, "launch-one").expect("prepare");
        assert!(staging.codex_home.is_dir());
        assert!(staging.scratch.is_dir());
        assert!(staging.root.starts_with(base.join(STAGING_DIRECTORY)));

        // A second prepare on the same id must not adopt the first one's tree.
        let again = prepare(&base, "launch-one");
        assert!(again.is_err(), "{again:?}");

        // A name that is not a plain id never reaches the filesystem.
        for bad in ["", "..", "a/b", "a\\b", "x".repeat(65).as_str()] {
            assert!(prepare(&base, bad).is_err(), "accepted {bad:?}");
        }
        dispose(&staging).expect("dispose");
        assert!(!staging.root.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn only_this_launchs_rollouts_are_materialized() {
        let base = temp_root("harvest");
        let staging = prepare(&base, "launch-two").expect("prepare");
        let destination = base.join("real-codex-home");
        std::fs::create_dir_all(&destination).expect("destination");

        let rollout = "sessions/2026/10/04/rollout-2026-10-04T00-00-00-01a0fa13.jsonl";
        write(&staging.codex_home.join(rollout), "{\"type\":\"session_meta\"}\n");
        // Everything else the provider wrote stays behind: auth is the obvious
        // one, and a harvest that moved it would be moving a secret the provider
        // controls into the user's real home.
        write(&staging.codex_home.join("auth.json"), "{}");
        write(&staging.codex_home.join("logs_2.sqlite"), "x");
        write(&staging.codex_home.join("sessions/2026/10/04/notes.txt"), "x");
        write(&staging.codex_home.join("sessions/2026/10/rollout-wrong-depth.jsonl"), "x");

        let report = harvest_rollouts(&staging, &destination, 1024 * 1024);
        assert_eq!(report.materialized, vec![rollout.replace('/', "\\")]);
        assert!(destination.join(rollout).is_file());
        assert!(!destination.join("auth.json").exists());
        // auth.json and the sqlite files are not even enumerated: the walk starts
        // at `sessions`, so nothing outside it is opened, listed or reported.
        // That is stronger than refusing them -- a secret the provider controls is
        // never read at all.
        let refused: Vec<&str> = report.refused.iter().map(|(name, _)| name.as_str()).collect();
        assert!(!refused.iter().any(|name| name.contains("auth.json")), "{refused:?}");
        assert!(!destination.join("logs_2.sqlite").exists());
        // Inside `sessions`, anything that is not a rollout is seen and refused.
        assert!(refused.iter().any(|name| name.contains("notes.txt")), "{refused:?}");
        assert!(refused.iter().any(|name| name.contains("wrong-depth")), "{refused:?}");

        dispose(&staging).expect("dispose");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_harvest_never_replaces_what_is_already_there() {
        let base = temp_root("overwrite");
        let staging = prepare(&base, "launch-three").expect("prepare");
        let destination = base.join("real-codex-home");
        let rollout = "sessions/2026/10/04/rollout-existing.jsonl";
        write(&destination.join(rollout), "the user's own history\n");
        write(&staging.codex_home.join(rollout), "replacement\n");

        let report = harvest_rollouts(&staging, &destination, 1024 * 1024);
        assert!(report.materialized.is_empty(), "{report:?}");
        assert!(report.refused.iter().any(|(_, why)| why == "already present"), "{report:?}");
        assert_eq!(
            std::fs::read_to_string(destination.join(rollout)).expect("read"),
            "the user's own history\n"
        );

        dispose(&staging).expect("dispose");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn an_oversized_rollout_is_refused() {
        let base = temp_root("size");
        let staging = prepare(&base, "launch-four").expect("prepare");
        let destination = base.join("real-codex-home");
        let rollout = "sessions/2026/10/04/rollout-big.jsonl";
        write(&staging.codex_home.join(rollout), &"x".repeat(4096));

        let report = harvest_rollouts(&staging, &destination, 1024);
        assert!(report.materialized.is_empty(), "{report:?}");
        assert!(
            report.refused.iter().any(|(_, why)| why.contains("larger than")),
            "{report:?}"
        );
        assert!(!destination.join(rollout).exists());

        dispose(&staging).expect("dispose");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_rollout_is_recognised_only_in_its_own_shape() {
        let yes = Path::new("sessions/2026/10/04/rollout-x.jsonl");
        assert!(is_rollout_relative(yes));
        for no in [
            "sessions/2026/10/04/notes.txt",
            "sessions/2026/10/rollout-x.jsonl",
            "sessions/2026/10/04/05/rollout-x.jsonl",
            "other/2026/10/04/rollout-x.jsonl",
            "sessions/20260/10/04/rollout-x.jsonl",
            "sessions/2026/1/04/rollout-x.jsonl",
            "sessions/2026/10/04/rollout-x.json",
            "rollout-x.jsonl",
        ] {
            assert!(!is_rollout_relative(Path::new(no)), "accepted {no}");
        }
    }

    #[test]
    fn a_path_that_leaves_its_tree_is_refused_rather_than_repaired() {
        assert!(is_plain_relative(Path::new("sessions/2026/a.jsonl")));
        for no in ["../escape", "sessions/../../escape", "/absolute", "C:\\drive", ""] {
            assert!(!is_plain_relative(Path::new(no)), "accepted {no:?}");
        }
    }
}
