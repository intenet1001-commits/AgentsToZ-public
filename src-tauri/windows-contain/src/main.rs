//! The containment primitive the Agent Runtime guard is missing on Windows.
//!
//! The guard (`agent-runtime-process-guard.ts`) already does every protocol and
//! policy job: it validates the launch protocol, activates the durable
//! reservation, verifies the Codex executable identity, filters the provider's
//! environment through an allowlist, runs from a neutral cwd so no project
//! dotenv reaches a provider, and watches its parent. What it cannot do on
//! Windows is **contain** what it starts, and that is the one thing this does.
//!
//! So this is deliberately thin. It is not a second guard: it takes an argv the
//! guard already validated, applies the containment measured in
//! `windows_job.rs`, and reports the provider's exit code.
//!
//! ```text
//! agentstoz-windows-contain <launch-id> <workspace-cwd> <executable> [args...]
//! ```
//!
//! - the Job Object holds the provider from creation, with kill-on-close read
//!   back, and every exit path proves `ActiveProcesses == 0`;
//! - the token is lowered to low integrity, which is what actually closes the
//!   broker escapes — measured: WMI, the task scheduler and the running
//!   explorer each put a process outside the job at normal integrity and none of
//!   them did at low;
//! - the provider gets this process's own standard handles, so the guard's pipes
//!   reach it directly with nothing to relay;
//! - it writes into per-launch staging and the rollouts are harvested afterwards,
//!   because a low-integrity provider cannot write anywhere else and `~/.codex`
//!   is never relabelled for it.
//!
//! ⚠️ Exit codes above 200 are this launcher's own failures, so a caller can tell
//! "the provider exited 1" from "containment could not be established".
//!
//! ⚠️ `owner-pid` is not decoration. Windows does not kill a child when its parent
//! dies, so a guard that is hard-killed would leave this launcher holding a live
//! job -- the provider would survive exactly the event the containment exists to
//! survive. The launcher therefore watches that pid and takes the job down with
//! it, which mirrors what the guard already does for the sidecar.

// ⚠️ Not a crate-level `#![cfg(windows)]`: that empties the whole file off Windows, and a bin with no `main`
// fails to build there (E0601). The launcher itself is Windows-only: build-sidecar.ts builds it on Windows and
// tauri.windows.conf.json ships it.
#[cfg(not(windows))]
fn main() {
    eprintln!("agentstoz-windows-contain is Windows-only.");
    std::process::exit(202);
}

#[cfg(windows)]
fn main() {
    contain::main()
}

#[cfg(windows)]
mod contain {

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use app_lib::windows_job::{ContainedIntegrity, ContainedProcess, ContainedStdio};
use app_lib::windows_staging::{dispose, harvest_rollouts, prepare};

/// Containment could not be established. Never confused with a provider's code.
const EXIT_CONTAINMENT_FAILED: i32 = 201;
/// The argv this launcher was given is not the one it accepts.
const EXIT_BAD_INVOCATION: i32 = 202;
/// The provider was still running when the wait gave up.
const EXIT_PROVIDER_STUCK: i32 = 203;
/// The owner went away, so the provider was taken down with it.
const EXIT_OWNER_GONE: i32 = 204;

/// How often the owner is checked. Frequent enough that an orphaned provider is
/// measured in a second, cheap enough to be irrelevant beside it.
const OWNER_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// One rollout should not be enormous; a staged one is also untrusted input.
const MAX_ROLLOUT_BYTES: u64 = 64 * 1024 * 1024;

fn fail(message: &str, code: i32) -> ! {
    eprintln!("[contain] {message}");
    std::process::exit(code);
}

/// Quotes one argument the way `CreateProcessW` parses it back.
///
/// ⚠️ The launcher is handed an argv array and Win32 takes a single string, so
/// this is where a path with a space either survives or becomes two arguments.
/// Nothing is dropped and nothing is interpreted: no shell is involved anywhere
/// in this program.
fn quote(argument: &OsStr) -> OsString {
    let text = argument.to_string_lossy();
    if !text.is_empty() && !text.contains([' ', '\t', '"']) {
        return argument.to_os_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for character in text.chars() {
        match character {
            '\\' => {
                backslashes += 1;
                quoted.push('\\');
            }
            '"' => {
                // A quote needs its preceding backslashes doubled first.
                quoted.extend(std::iter::repeat_n('\\', backslashes + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                quoted.push(character);
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes));
    quoted.push('"');
    OsString::from(quoted)
}

fn command_line(parts: &[OsString]) -> OsString {
    let mut line = OsString::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            line.push(" ");
        }
        line.push(quote(part));
    }
    line
}

/// Whether the owner is still the process this launcher was started by.
///
/// A pid alone is not an identity, so the creation time captured at startup is
/// what is compared: a reused pid must not keep a provider alive, and must not
/// look like a death either.
fn owner_still_present(pid: u32, created_at: u64) -> bool {
    // ⚠️ Not a creation-time comparison on its own. Measured: a terminated owner
    // was still openable and still reported the same creation time four seconds
    // after being killed, because the shell that started it held a handle -- so
    // the launcher happily kept its provider alive. `process_alive` also asks
    // WaitForSingleObject, which is signalled exactly when a process has exited.
    app_lib::windows_job::process_alive(pid, created_at)
}

fn absolute_directory(value: &OsStr) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return None;
    }
    std::fs::metadata(&path).ok().filter(|m| m.is_dir()).map(|_| path)
}

/// The provider's environment: what the guard already filtered, with the staging
/// paths replacing anything it inherited for them.
fn provider_environment(
    codex_home: &Path,
    scratch: &Path,
) -> Vec<(OsString, OsString)> {
    let mut variables: Vec<(OsString, OsString)> = Vec::new();
    let staged: [(&str, &Path); 3] = [
        ("CODEX_HOME", codex_home),
        ("TEMP", scratch),
        ("TMP", scratch),
    ];
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        // The guard's allowlist decided what is here; these three are the ones
        // containment overrides, so an inherited copy must not survive and win.
        if staged.iter().any(|(staged_name, _)| *staged_name == name) {
            continue;
        }
        variables.push((key, value));
    }
    for (key, value) in staged {
        variables.push((OsString::from(key), value.as_os_str().to_os_string()));
    }
    variables
}

pub fn main() {
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    if arguments.len() < 4 {
        fail(
            "usage: agentstoz-windows-contain <launch-id> <owner-pid> <workspace-cwd> <executable> [args...]",
            EXIT_BAD_INVOCATION,
        );
    }
    let launch_id = arguments[0].to_string_lossy().to_string();
    let Some(owner_pid) = arguments[1]
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 4)
    else {
        fail("an owning process id is required", EXIT_BAD_INVOCATION)
    };
    // Captured before the provider exists, so a pid reused later cannot be
    // mistaken for the owner still being alive.
    let Ok(owner_created_at) = app_lib::windows_job::process_creation_time(owner_pid) else {
        fail("the owning process is already gone", EXIT_BAD_INVOCATION)
    };
    let Some(workspace) = absolute_directory(&arguments[2]) else {
        fail(
            "an absolute, existing provider working directory is required",
            EXIT_BAD_INVOCATION,
        )
    };
    let provider = &arguments[3..];
    if provider[0].is_empty() {
        fail("a provider executable is required", EXIT_BAD_INVOCATION);
    }

    // Staging lives under local app data, not the temp tree: Codex refuses to
    // create its helper binaries under %TEMP% (measured).
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        fail("LOCALAPPDATA is required for staging", EXIT_CONTAINMENT_FAILED)
    };
    let staging = match prepare(&local_app_data, &launch_id) {
        Ok(staging) => staging,
        Err(error) => fail(&format!("staging failed: {error}"), EXIT_CONTAINMENT_FAILED),
    };

    let environment = provider_environment(&staging.codex_home, &staging.scratch);
    let line = command_line(provider);

    let contained = match ContainedProcess::spawn_with(
        &line,
        Some(workspace.as_os_str()),
        // The guard gave this process pipes; the provider gets the same handles,
        // so there is no relay between them.
        ContainedStdio::Inherit,
        ContainedIntegrity::Low,
        &environment,
    ) {
        Ok(contained) => contained,
        Err(error) => {
            let _ = dispose(&staging);
            fail(&format!("containment failed: {error}"), EXIT_CONTAINMENT_FAILED);
        }
    };

    // No deadline on the provider itself: a working session may be long. What is
    // watched instead is the owner, because an orphaned launcher would keep the
    // job -- and the provider -- alive past the guard it belongs to.
    let mut owner_gone = false;
    let code = loop {
        if let Some(code) = contained.wait(OWNER_POLL) {
            break Some(code);
        }
        if !owner_still_present(owner_pid, owner_created_at) {
            owner_gone = true;
            break None;
        }
    };

    // Terminate whatever the provider left behind, and prove it, before anything
    // is harvested: a descendant still writing into staging would be harvested
    // mid-write.
    let proof = contained.terminate_proven(0);

    // The rollouts are what has to survive; everything else staging holds is the
    // provider's own scratch and is disposed of with it.
    let real_codex_home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|home| home.join(".codex"));
    if let Some(destination) = real_codex_home {
        let report = harvest_rollouts(&staging, &destination, MAX_ROLLOUT_BYTES);
        for name in &report.materialized {
            eprintln!("[contain] materialized {name}");
        }
        for (name, why) in &report.refused {
            eprintln!("[contain] refused {name}: {why}");
        }
    } else {
        eprintln!("[contain] USERPROFILE is unavailable; nothing was harvested");
    }
    if let Err(error) = dispose(&staging) {
        // Not fatal: a leftover subtree is visible and recoverable, while
        // reporting a provider failure that did not happen is not.
        eprintln!("[contain] {error}");
    }
    if let Err(error) = proof {
        eprintln!("[contain] {error}");
    }

    match code {
        Some(code) => std::process::exit(i32::try_from(code).unwrap_or(EXIT_PROVIDER_STUCK)),
        None if owner_gone => std::process::exit(EXIT_OWNER_GONE),
        None => std::process::exit(EXIT_PROVIDER_STUCK),
    }
}
}
