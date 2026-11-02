//! AgentsToZ Screen: the separate menu bar app that alone holds screen recording and Accessibility permission
//! (docs/design/screen-control-2026-10-24/DESIGN.md). A signed payload ships inside the main app, but is installed and
//! opened as an independent app with its own bundle and keychain identity. The panel reads
//! the helper's small status file and never switches the helper: turning on and registering a device stay in the
//! helper, at the Mac, behind Touch ID. The file decides nothing about security; a wrong value only misleads a label.
//!
//! AgentsToZ Viewer (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.4, SR-35) is the other companion: the app on Mac A
//! that shows Mac B. It holds no TCC permission and the main app never starts or drives a session; it only installs,
//! updates and opens the app, with no arguments. Both helpers are installed the same way, never to a lower
//! CFBundleVersion. A running helper is never stopped or relaunched by the installer. Its update waits until the
//! person fully quits it after finishing current connections, and is tried
//! again when the main app starts, right before 「다른 Mac 화면 보기」 opens it, and every ten minutes. A backup an update
//! had to keep (the old copy still ran from it) is removed by a later pass, so no older signed copy stays launchable.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, Once, OnceLock};
use std::time::{Duration, Instant};

const TEAM_ID: &str = "DA8QKAQ2C9";
/// The helper writes a few hundred bytes; anything larger is not its file.
const STATUS_LIMIT: u64 = 4096;
/// How long `open` gets before the answer is 「requested, not confirmed」 (the 3-state contract).
const OPEN_DEADLINE: Duration = Duration::from_secs(4);
/// The longest a put-off Viewer update waits once the Viewer is closed (SR-35). Nothing runs unless one was put off,
/// or an earlier update had to keep a backup that was still running.
const DEFERRED_RECHECK: Duration = Duration::from_secs(600);
/// A backup changed more recently than this may belong to an update another copy of the main app is still making, and
/// may still roll back from, so it is left for a later pass.
const BACKUP_SETTLE: Duration = Duration::from_secs(120);

/// One separately signed companion the main app carries in `Contents/Helpers` and installs as its own app. Korean
/// messages need the particle that follows the name (「Screen이·을」, 「Viewer가·를」), so each helper spells its own.
pub(crate) struct Helper {
    bundle_id: &'static str,
    /// The process name `pgrep -x` sees (under the 16-byte `MAXCOMLEN`).
    executable: &'static str,
    app_name: &'static str,
    label: &'static str,
    subject: &'static str,
    object: &'static str,
    short: &'static str,
    missing: &'static str,
    unsupported: &'static str,
    /// Legacy rollback capability; disabled for both deployed helpers, which are never restarted by installation.
    reopen_after_update: bool,
    /// A running or unobservable helper puts off replacement until a safe later check.
    defer_while_running: bool,
    /// One installation or open of this helper at a time; the other helper is never kept waiting.
    lock: Mutex<()>,
    /// An update was put off because the helper was running. Only then does the periodic check do any work.
    deferred: AtomicBool,
    /// An older bundle was kept beside the installed one only for now (it still ran, or had just been made), so the
    /// periodic check comes back to remove it (SR-35).
    kept_backup: AtomicBool,
}

const fn screen() -> Helper {
    Helper {
        bundle_id: "com.intenet.agentstozbycs.screen",
        executable: "AgentsToZScreen",
        app_name: "AgentsToZ Screen.app",
        label: "AgentsToZ Screen",
        subject: "AgentsToZ Screen이",
        object: "AgentsToZ Screen을",
        short: "Screen",
        missing: "AgentsToZ Screen이 없습니다. Screen이 포함된 메인 앱을 설치해 주세요.",
        unsupported: "AgentsToZ Screen은 macOS 14 이상에서 쓸 수 있습니다.",
        reopen_after_update: false,
        defer_while_running: true,
        lock: Mutex::new(()),
        deferred: AtomicBool::new(false),
        kept_backup: AtomicBool::new(false),
    }
}

/// `AgentsToZViewer` is the SwiftPM executable target the Viewer bundle wraps (DESIGN 5.1), like `AgentsToZScreen`.
const fn viewer() -> Helper {
    Helper {
        bundle_id: "com.intenet.agentstozbycs.viewer",
        executable: "AgentsToZViewer",
        app_name: "AgentsToZ Viewer.app",
        label: "AgentsToZ Viewer",
        subject: "AgentsToZ Viewer가",
        object: "AgentsToZ Viewer를",
        short: "Viewer",
        missing: "AgentsToZ Viewer가 없습니다. Viewer가 포함된 메인 앱을 설치해 주세요.",
        unsupported: "AgentsToZ Viewer는 macOS 14 이상에서 쓸 수 있습니다.",
        reopen_after_update: false,
        defer_while_running: true,
        lock: Mutex::new(()),
        deferred: AtomicBool::new(false),
        kept_backup: AtomicBool::new(false),
    }
}

static SCREEN: Helper = screen();
static VIEWER: Helper = viewer();

fn lock(helper: &Helper) -> MutexGuard<'_, ()> { helper.lock.lock().unwrap_or_else(|error| error.into_inner()) }

/// The helper's file as ScreenStatusFile.swift writes it. Unknown keys are ignored so a newer helper still shows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperFile {
    version: u32,
    pid: i32,
    power: String,
    viewing: bool,
    devices: u32,
    capture: bool,
    control: bool,
    login_item: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HelperState {
    /** off · starting · on · waiting (on, but not on a network approved in the helper, so no device can connect) */
    power: &'static str,
    viewing: bool,
    /** Registrations that can still connect. */
    devices: u32,
    capture: bool,
    control: bool,
    /** on · off · approval (the person must allow it in System Settings) */
    login_item: &'static str,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenHelperStatus {
    supported: bool,
    installed: bool,
    running: bool,
    update_pending: bool,
    other_instance_running: bool,
    instance_status_unknown: bool,
    /** None while running means the state could not be read (an older helper, or the file is not its own). */
    state: Option<HelperState>,
}

/// What the work-mode panel needs to offer 「다른 Mac 화면 보기」. The Viewer writes no status file: whether it is
/// connected, and to which Mac, is never told to the main app.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewerHelperStatus {
    supported: bool,
    installed: bool,
    /** This main app carries a Viewer, so opening can (re)try installing it. */
    bundled: bool,
    running: bool,
    other_instance_running: bool,
    instance_status_unknown: bool,
    /** A newer Viewer waits for the running one to close (SR-35). */
    update_pending: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenResult {
    /** False: `open` asked in time but the helper was not seen running before the deadline. */
    verified: bool,
}

/// Only a file whose process is one of the running helpers counts: a crash leaves the last file behind.
fn parse_state(text: &str, running: &[i32]) -> Option<HelperState> {
    let file: HelperFile = serde_json::from_str(text).ok()?;
    if file.version != 1 || !running.contains(&file.pid) || file.devices > 10_000 { return None; }
    let power = match file.power.as_str() {
        "off" => "off", "starting" => "starting", "on" => "on", "waiting" => "waiting", _ => return None
    };
    let login_item = match file.login_item.as_str() { "on" => "on", "off" => "off", "approval" => "approval", _ => return None };
    Some(HelperState { power, viewing: file.viewing, devices: file.devices, capture: file.capture, control: file.control, login_item })
}

fn read_state(path: &Path, running: &[i32]) -> Option<HelperState> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > STATUS_LIMIT { return None; }
    parse_state(&std::fs::read_to_string(path).ok()?, running)
}

fn read_running_helpers(helper: &Helper) -> Result<Vec<i32>, ()> {
    let output = Command::new("/usr/bin/pgrep").args(["-x", helper.executable]).output().map_err(|_| ())?;
    parse_running_helpers(output.status.code(), &output.stdout)
}

fn parse_running_helpers(code: Option<i32>, bytes: &[u8]) -> Result<Vec<i32>, ()> {
    if code == Some(1) && bytes.is_empty() { return Ok(Vec::new()); }
    if code != Some(0) { return Err(()); }
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let pids: Vec<i32> = text.lines().map(|line| line.trim().parse::<i32>().map_err(|_| ()))
        .collect::<Result<_, _>>()?;
    if pids.is_empty() || pids.iter().any(|pid| *pid <= 1) { return Err(()); }
    Ok(pids)
}

fn running_helpers(helper: &Helper) -> Vec<i32> {
    read_running_helpers(helper).unwrap_or_default()
}

/// Process names/paths only block a replacement or launch. They never confer helper authority.
#[derive(Default, Clone, Debug)]
struct InstanceObservation { expected: Vec<i32>, other: bool, unknown: bool }
impl InstanceObservation {
    fn blocks_install(&self) -> bool { !self.expected.is_empty() || self.other || self.unknown }
    fn check_open(&self, helper: &Helper) -> Result<(), String> {
        if self.unknown { return Err(format!("{} 실행 상태를 확인하지 못했습니다. 다시 확인한 뒤 열어 주세요.", helper.label)); }
        if self.other { return Err(format!("다른 위치의 {} 실행 중입니다. 그 앱에서 현재 연결을 마치고 완전히 종료한 뒤 다시 열어 주세요.", helper.subject)); }
        Ok(())
    }
}

fn classify_instances(pids: Result<Vec<i32>, ()>, expected: &Path, path: impl Fn(i32) -> Option<PathBuf>) -> InstanceObservation {
    let Ok(pids) = pids else { return InstanceObservation { unknown: true, ..Default::default() }; };
    let mut result = InstanceObservation::default();
    for pid in pids {
        match path(pid) {
            Some(actual) if actual == expected => result.expected.push(pid),
            Some(_) => result.other = true,
            None => result.unknown = true,
        }
    }
    result
}

fn home() -> Option<PathBuf> { std::env::var_os("HOME").map(PathBuf::from) }

fn installation_places(helper: &Helper, home: Option<&Path>) -> Vec<PathBuf> {
    let mut places = vec![Path::new("/Applications").join(helper.app_name)];
    if let Some(home) = home { places.push(home.join("Applications").join(helper.app_name)); }
    places
}

fn path_exists(helper: &Helper, path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("{} 설치 경로를 확인하지 못했습니다: {error}", helper.label)),
    }
}

/// Neither an Applications alias nor a redirected app/binary may become an installer destination.
fn reject_symlink_components(helper: &Helper, path: &Path) -> Result<(), String> {
    if !path.is_absolute() { return Err(format!("{} 설치 경로가 절대 경로가 아닙니다.", helper.label)); }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Normal(_) => current.push(component.as_os_str()),
            _ => return Err(format!("{} 설치 경로에 허용되지 않는 구성 요소가 있습니다.", helper.label)),
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(format!("{} 설치 경로의 심볼릭 링크는 허용하지 않습니다.", helper.label)),
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("{} 설치 경로를 확인하지 못했습니다: {error}", helper.label)),
        }
    }
    Ok(())
}

fn reject_bundle_links(helper: &Helper, path: &Path) -> Result<(), String> {
    reject_symlink_components(helper, path)?;
    let mut pending = vec![(path.to_path_buf(), 0usize)];
    let mut count = 0usize;
    while let Some((current, depth)) = pending.pop() {
        count += 1;
        if count > 4096 || depth > 16 { return Err(format!("{} 번들의 크기 제한을 초과했습니다.", helper.label)); }
        let metadata = std::fs::symlink_metadata(&current).map_err(|error| format!("{} 번들을 확인하지 못했습니다: {error}", helper.label))?;
        if metadata.file_type().is_symlink() { return Err(format!("{} 번들의 심볼릭 링크는 허용하지 않습니다.", helper.label)); }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(&current).map_err(|error| error.to_string())? {
                pending.push((entry.map_err(|error| error.to_string())?.path(), depth + 1));
            }
        } else if !metadata.is_file() { return Err(format!("{} 번들에 일반 파일이 아닌 항목이 있습니다.", helper.label)); }
    }
    Ok(())
}

fn signature_requirement(helper: &Helper) -> String {
    format!("=identifier \"{}\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{TEAM_ID}\"", helper.bundle_id)
}

/// CFBundleVersion as the builds write it: `N.0.0` from the git build number (stageScreenControlBundle.ts), a
/// development Screen `2`. Compared as numbers, missing components as zero; anything else is unreadable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct BundleVersion([u64; 3]);

impl BundleVersion {
    fn parse(text: &str) -> Option<Self> {
        let mut parts = [0u64; 3];
        for (index, part) in text.trim().split('.').enumerate() {
            if index >= parts.len() || part.is_empty() || part.len() > 9 || !part.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
            parts[index] = part.parse().ok()?;
        }
        Some(Self(parts))
    }
}

impl std::fmt::Display for BundleVersion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.0[0], self.0[1], self.0[2])
    }
}

trait InstallActions {
    fn verify(&self, app: &Path) -> Result<String, String>;
    /// The signed Info.plist's CFBundleVersion. Read only after `verify`, so it is the signer's value.
    fn version(&self, app: &Path) -> Result<BundleVersion, String>;
    fn copy(&self, source: &Path, destination: &Path) -> Result<(), String>;
    fn running(&self, app: &Path) -> Vec<i32>;
    fn instances(&self, app: &Path) -> InstanceObservation {
        InstanceObservation { expected: self.running(app), ..Default::default() }
    }
    fn stop(&self, app: &Path, pids: &[i32]) -> Result<(), String>;
    fn reopen(&self, app: &Path) -> Result<(), String>;
    /// `open` with no arguments: asked, not yet seen running.
    fn launch(&self, app: &Path) -> Result<(), String>;
    /// Unchanged for `BACKUP_SETTLE`, so no update in flight still owns it.
    fn settled(&self, app: &Path) -> bool;
}

struct NativeInstall(&'static Helper);

fn native_command(helper: &Helper, command: &mut Command) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| format!("{} 설치 명령을 실행하지 못했습니다: {error}", helper.label))?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|error| error.to_string())?.is_some() { break; }
        if started.elapsed() >= Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{} 설치 명령의 대기 시간을 초과했습니다.", helper.label));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("{} 설치 명령이 실패했습니다: {}", helper.label, String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

#[cfg(target_os = "macos")]
fn process_executable(pid: i32) -> Option<PathBuf> {
    #[link(name = "proc")]
    extern "C" { fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, buffer_size: u32) -> i32; }
    let mut bytes = [0u8; 4096];
    let length = unsafe { proc_pidpath(pid, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if length <= 0 { return None; }
    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    Some(PathBuf::from(std::str::from_utf8(&bytes[..end]).ok()?))
}

#[cfg(not(target_os = "macos"))]
fn process_executable(_pid: i32) -> Option<PathBuf> { None }

fn exact_running(helper: &Helper, app: &Path) -> Vec<i32> {
    let executable = app.join("Contents/MacOS").join(helper.executable);
    running_helpers(helper).into_iter().filter(|pid| process_executable(*pid).as_deref() == Some(executable.as_path())).collect()
}

fn open_independent(helper: &Helper, app: &Path) -> Result<(), String> {
    native_command(helper, Command::new("/usr/bin/open").arg(app)).map(|_| ())
}

impl InstallActions for NativeInstall {
    fn verify(&self, app: &Path) -> Result<String, String> {
        let helper = self.0;
        reject_bundle_links(helper, app)?;
        if !app.join("Contents/MacOS").join(helper.executable).is_file() { return Err(format!("{} 실행 파일이 없습니다.", helper.label)); }
        native_command(helper, Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict", "--all-architectures", "-R", &signature_requirement(helper)]).arg(app))?;
        let output = native_command(helper, Command::new("/usr/bin/codesign").args(["--display", "--verbose=4"]).arg(app))?;
        let hashes: Vec<_> = output.lines().filter_map(|line| line.strip_prefix("CDHash=")).collect();
        if hashes.len() != 1 || hashes[0].len() != 40 || !hashes[0].bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("{}의 코드 서명 지문을 확인하지 못했습니다.", helper.label));
        }
        Ok(hashes[0].to_string())
    }
    fn version(&self, app: &Path) -> Result<BundleVersion, String> {
        let helper = self.0;
        let plist = app.join("Contents/Info.plist");
        reject_symlink_components(helper, &plist)?;
        let output = native_command(helper, Command::new("/usr/bin/plutil").args(["-extract", "CFBundleVersion", "raw", "-o", "-"]).arg(&plist))?;
        BundleVersion::parse(&output).ok_or_else(|| format!("{}의 번들 버전을 읽지 못했습니다.", helper.label))
    }
    fn copy(&self, source: &Path, destination: &Path) -> Result<(), String> {
        native_command(self.0, Command::new("/usr/bin/ditto").arg(source).arg(destination)).map(|_| ())
    }
    fn running(&self, app: &Path) -> Vec<i32> { exact_running(self.0, app) }
    fn instances(&self, app: &Path) -> InstanceObservation {
        classify_instances(read_running_helpers(self.0), &app.join("Contents/MacOS").join(self.0.executable), process_executable)
    }
    fn stop(&self, app: &Path, pids: &[i32]) -> Result<(), String> {
        let helper = self.0;
        let executable = app.join("Contents/MacOS").join(helper.executable);
        for pid in pids {
            if process_executable(*pid).as_deref() != Some(executable.as_path()) { continue; }
            #[cfg(unix)]
            if unsafe { libc::kill(*pid, libc::SIGTERM) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("실행 중인 {} 종료하지 못했습니다. 기존 앱을 유지합니다.", helper.object));
            }
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            if pids.iter().all(|pid| process_executable(*pid).as_deref() != Some(executable.as_path())) { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(format!("실행 중인 {} 종료되지 않았습니다. 기존 앱을 유지합니다.", helper.subject))
    }
    fn reopen(&self, app: &Path) -> Result<(), String> {
        self.launch(app)?;
        let started = Instant::now();
        while started.elapsed() < OPEN_DEADLINE {
            if !exact_running(self.0, app).is_empty() { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(format!("업데이트한 {}의 재실행을 확인하지 못했습니다.", self.0.label))
    }
    fn launch(&self, app: &Path) -> Result<(), String> {
        self.instances(app).check_open(self.0)?;
        open_independent(self.0, app)
    }
    /// The inode change time: a rename into place updates it, and an update in flight renames its backup last.
    fn settled(&self, app: &Path) -> bool {
        let Ok(metadata) = std::fs::symlink_metadata(app) else { return false };
        #[cfg(unix)]
        let changed = {
            use std::os::unix::fs::MetadataExt;
            u64::try_from(metadata.ctime()).ok().and_then(|seconds| std::time::UNIX_EPOCH.checked_add(Duration::from_secs(seconds)))
        };
        #[cfg(not(unix))]
        let changed = metadata.modified().ok();
        changed.and_then(|at| std::time::SystemTime::now().duration_since(at).ok()).is_some_and(|age| age >= BACKUP_SETTLE)
    }
}

struct StagingDirectory(PathBuf, bool);
impl Drop for StagingDirectory {
    fn drop(&mut self) { if self.1 { let _ = std::fs::remove_dir_all(&self.0); } }
}

fn transaction_token(helper: &Helper) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("{} 설치 식별자를 만들지 못했습니다: {error}", helper.label))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn rename_new(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
        let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
        if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 { Ok(()) }
        else { Err(std::io::Error::last_os_error()) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if std::fs::symlink_metadata(to).is_ok() { return Err(std::io::ErrorKind::AlreadyExists.into()); }
        std::fs::rename(from, to)
    }
}

/// Where the installed helper now stands. Every outcome names the app to open; none of them is an error.
#[derive(Debug, PartialEq)]
enum InstallOutcome {
    /// The carried helper is installed (copied now, or already the same signed bundle).
    Installed(PathBuf),
    /// The installed helper has a higher CFBundleVersion than the one carried here, so it stays (SR-35).
    KeptNewer(PathBuf),
    /// A CFBundleVersion could not be read, so the two cannot be ordered: the installed, signature-checked helper stays
    /// (fail closed) and is still the one opened.
    KeptUnordered(PathBuf),
    /// The installed helper is running and may not be stopped; the update is tried again later (SR-35).
    Deferred(PathBuf),
}

impl InstallOutcome {
    fn path(&self) -> &Path {
        match self { Self::Installed(path) | Self::KeptNewer(path) | Self::KeptUnordered(path) | Self::Deferred(path) => path }
    }
}

/// Copies only the signed app. Keychain, pairing, approved networks, TCC and login-item settings are never touched.
fn install_payload(helper: &Helper, source: &Path, destination: &Path, actions: &impl InstallActions) -> Result<InstallOutcome, String> {
    let label = helper.label;
    reject_bundle_links(helper, source)?;
    let source_hash = actions.verify(source)?;
    reject_symlink_components(helper, destination)?;
    let had_destination = path_exists(helper, destination)?;
    let previous_hash = if had_destination { reject_bundle_links(helper, destination)?; Some(actions.verify(destination)?) } else { None };
    if previous_hash.as_ref() == Some(&source_hash) { return Ok(InstallOutcome::Installed(destination.to_path_buf())); }
    if had_destination {
        // Never to a lower build: an older main app (a rollback, a stale copy) must not take back a newer helper.
        match (actions.version(source), actions.version(destination)) {
            (Ok(incoming), Ok(current)) if incoming < current => {
                log::info!("[{label}] 설치된 버전 {current}이 함께 든 버전 {incoming}보다 높아 그대로 둡니다.");
                return Ok(InstallOutcome::KeptNewer(destination.to_path_buf()));
            }
            (Ok(_), Ok(_)) => (),
            // Not an error: the installed helper passed the signature check and stays openable.
            (Err(error), _) | (_, Err(error)) => {
                log::warn!("[{label}] 번들 버전을 비교하지 못해 설치된 앱을 그대로 둡니다: {error}");
                return Ok(InstallOutcome::KeptUnordered(destination.to_path_buf()));
            }
        }
    }
    if helper.defer_while_running && actions.instances(destination).blocks_install() {
        return Ok(InstallOutcome::Deferred(destination.to_path_buf()));
    }
    let parent = destination.parent().ok_or_else(|| format!("{label} 설치 폴더가 없습니다."))?;
    if !path_exists(helper, parent)? {
        std::fs::create_dir(parent).map_err(|error| format!("{label} 설치 폴더를 만들지 못했습니다: {error}"))?;
    }
    reject_symlink_components(helper, parent)?;
    let token = transaction_token(helper)?;
    let stem = helper.app_name.trim_end_matches(".app");
    let staged = parent.join(format!(".{stem}-installing-{token}.app"));
    let backup = parent.join(format!(".{stem}-backup-{token}.app"));
    if path_exists(helper, &staged)? || path_exists(helper, &backup)? { return Err(format!("{label} 설치 임시 경로가 이미 있습니다.")); }
    std::fs::create_dir(&staged).map_err(|error| format!("{} 설치할 권한이 없거나 공간이 부족합니다: {error}", helper.object))?;
    let mut cleanup = StagingDirectory(staged.clone(), true);
    actions.copy(source, &staged)?;
    reject_bundle_links(helper, &staged)?;
    if actions.verify(&staged)? != source_hash { return Err(format!("복사한 {}의 서명 지문이 원본과 다릅니다. 기존 앱을 유지합니다.", label)); }
    reject_symlink_components(helper, destination)?;
    if path_exists(helper, destination)? != had_destination || (had_destination && Some(actions.verify(destination)?) != previous_hash) {
        return Err(format!("설치 중 {} 변경되었습니다. 기존 앱을 유지합니다.", helper.subject));
    }
    // Legacy rollback support, disabled for both deployed helpers. Neither installer may stop or restart a helper.
    let running = if helper.defer_while_running { Vec::new() } else { actions.running(destination) };
    if !running.is_empty() {
        if let Err(error) = actions.stop(destination, &running) {
            let _ = actions.reopen(destination);
            return Err(error);
        }
        reject_symlink_components(helper, destination)?;
        if path_exists(helper, destination)? != had_destination || (had_destination && Some(actions.verify(destination)?) != previous_hash) {
            let _ = actions.reopen(destination);
            return Err(format!("실행 종료 대기 중 {} 변경되었습니다. 설치를 중단합니다.", helper.subject));
        }
    }
    // The last look, with nothing slow between it and the swap: opened while the copy was made or checked, it
    // keeps its files. The staging copy is removed and the update waits.
    if helper.defer_while_running && actions.instances(destination).blocks_install() {
        return Ok(InstallOutcome::Deferred(destination.to_path_buf()));
    }
    if had_destination {
        if let Err(error) = rename_new(destination, &backup) {
            if !running.is_empty() { let _ = actions.reopen(destination); }
            return Err(format!("기존 {} 백업하지 못했습니다: {error}", helper.object));
        }
    }
    let activation = rename_new(&staged, destination);
    let moved_new_app = activation.is_ok();
    let relaunch = helper.reopen_after_update && !running.is_empty();
    let activated = activation.map_err(|error| error.to_string())
        .and_then(|_| if relaunch { actions.reopen(destination) } else { Ok(()) });
    let short = helper.short;
    if let Err(error) = activated {
        if had_destination {
            // Keep both app bundles if rollback itself fails. Never delete an installed or backup app.
            if moved_new_app {
                reject_bundle_links(helper, destination)?;
                if actions.verify(destination)? != source_hash { return Err(format!("{short} 업데이트 실패: {error}. 설치 경로가 변경되어 이전 앱 백업을 유지합니다: {}", backup.display())); }
                actions.stop(destination, &actions.running(destination))?;
                rename_new(destination, &staged).map_err(|rollback| format!("{short} 업데이트 실패: {error}. 새 앱을 옮기지 못해 백업을 유지합니다: {rollback}"))?;
            } else if path_exists(helper, destination)? {
                return Err(format!("{short} 업데이트 실패: {error}. 다른 항목이 설치 경로에 생겨 덮어쓰지 않았습니다. 이전 앱 백업: {}", backup.display()));
            }
            if let Err(rollback) = rename_new(&backup, destination) {
                cleanup.1 = false;
                return Err(format!("{short} 업데이트 실패: {error}. 이전 앱 복원 실패: {rollback}. 백업: {}", backup.display()));
            }
            if !running.is_empty() { let _ = actions.reopen(destination); }
        }
        return Err(if had_destination { format!("{label} 업데이트에 실패해 이전 앱을 복원했습니다: {error}") }
            else { format!("{} 설치하지 못했습니다: {error}", helper.object) });
    }
    if let Some(previous_hash) = previous_hash {
        // Only this transaction's verified old bundle is disposable, and only when its process state is known.
        // A copy someone opened just before the swap runs from the backup now: it keeps its files.
        // Cleanup failure leaves a recoverable backup; it must not turn a successful installation into a failure.
        let cleanup_backup = || -> Result<(), String> {
            reject_bundle_links(helper, &backup)?;
            if actions.verify(&backup)? != previous_hash { return Err("백업의 서명 지문이 달라 삭제하지 않았습니다.".into()); }
            let instances = actions.instances(&backup);
            if instances.unknown || !instances.expected.is_empty() { return Err("이전 앱의 종료를 확인하지 못해 삭제하지 않았습니다.".into()); }
            std::fs::remove_dir_all(&backup).map_err(|error| error.to_string())
        };
        if let Err(error) = cleanup_backup() { log::warn!("[{label}] 설치는 완료됐지만 이번 설치의 백업을 유지합니다: {error}"); }
    }
    Ok(InstallOutcome::Installed(destination.to_path_buf()))
}

fn bundled_payload(helper: &Helper, executable: &Path) -> Option<PathBuf> {
    if executable.file_name()? != "app" || executable.parent()?.file_name()? != "MacOS" { return None; }
    let contents = executable.parent()?.parent()?;
    if contents.file_name()? != "Contents" || contents.parent()?.file_name()? != "AgentsToZ_byCS.app" { return None; }
    let payload = contents.join("Helpers").join(helper.app_name);
    // Broken links are present too, and will be refused instead of treated as an absent developer payload.
    std::fs::symlink_metadata(&payload).ok().map(|_| payload)
}

/// Installs `source` (None: a source development build, which never replaces an installed helper) at the existing place,
/// or in the person's Applications folder. Remembers a put-off update for the periodic check; callers hold the lock.
fn ensure_with(helper: &Helper, source: Option<PathBuf>, places: &[PathBuf], actions: &impl InstallActions) -> Result<Option<InstallOutcome>, String> {
    let mut existing = None;
    for place in places { if path_exists(helper, place)? { existing = Some(place.clone()); break; } }
    let result = match source {
        None => Ok(existing.map(InstallOutcome::Installed)),
        Some(source) => match existing.or_else(|| places.get(1).cloned()) {
            None => Err("사용자 Applications 폴더를 찾을 수 없습니다.".to_string()),
            Some(destination) => install_payload(helper, &source, &destination, actions).map(Some),
        },
    };
    // A failure is not retried every ten minutes; the next start or open tries again.
    helper.deferred.store(matches!(result, Ok(Some(InstallOutcome::Deferred(_)))), Ordering::Release);
    let again = match &result { Ok(Some(outcome)) => sweep_backups(helper, outcome.path(), actions), _ => false };
    helper.kept_backup.store(again, Ordering::Release);
    result
}

/// `.{stem}-backup-<token>.app` exactly as `install_payload` names its backups: nothing else is ever removed.
fn is_backup_name(helper: &Helper, name: &str) -> bool {
    let stem = helper.app_name.trim_end_matches(".app");
    name.strip_prefix('.').and_then(|rest| rest.strip_prefix(stem)).and_then(|rest| rest.strip_prefix("-backup-"))
        .and_then(|rest| rest.strip_suffix(".app"))
        .is_some_and(|token| token.len() == 32 && token.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
}

/// What became of one leftover backup.
enum Leftover { Removed, KeptForNow, KeptNewer }

/// An update keeps its backup when the old helper still runs from it or the backup could not be checked. Left there, an
/// older team-signed bundle with the same identifier stays launchable beside the installed one (SR-35), so later passes
/// remove it: only a bundle named as this module names backups that passes the team signature, has settled, is not
/// running and is not newer than the installed helper. Anything else stays. Returns whether one was kept only for now
/// (running, or just made), so the periodic check comes back. Nothing is checked when there is no backup; callers hold
/// the lock.
fn sweep_backups(helper: &Helper, installed: &Path, actions: &impl InstallActions) -> bool {
    let label = helper.label;
    let Some(parent) = installed.parent() else { return false };
    let Ok(entries) = std::fs::read_dir(parent) else { return false };
    let backups: Vec<PathBuf> = entries.filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| is_backup_name(helper, name)))
        .map(|entry| entry.path()).take(64).collect();
    if backups.is_empty() { return false; }
    // Ordering needs the installed helper's own signed version; without it nothing is removed.
    let current = match reject_bundle_links(helper, installed).and_then(|()| actions.verify(installed)).and_then(|_| actions.version(installed)) {
        Ok(current) => current,
        Err(error) => { log::warn!("[{label}] 설치된 앱을 확인하지 못해 이전 앱 백업을 그대로 둡니다: {error}"); return false; }
    };
    let mut again = false;
    for backup in backups {
        let leftover = (|| -> Result<Leftover, String> {
            if !actions.settled(&backup) { return Ok(Leftover::KeptForNow); }
            reject_bundle_links(helper, &backup)?;
            actions.verify(&backup)?;
            let instances = actions.instances(&backup);
            if instances.unknown || !instances.expected.is_empty() { return Ok(Leftover::KeptForNow); }
            if actions.version(&backup)? > current { return Ok(Leftover::KeptNewer); }
            std::fs::remove_dir_all(&backup).map_err(|error| error.to_string())?;
            Ok(Leftover::Removed)
        })();
        match leftover {
            Ok(Leftover::Removed) => log::info!("[{label}] 남아 있던 이전 앱 백업을 지웠습니다: {}", backup.display()),
            Ok(Leftover::KeptForNow) => again = true,
            Ok(Leftover::KeptNewer) => log::info!("[{label}] 설치된 앱보다 새 백업이라 그대로 둡니다: {}", backup.display()),
            Err(error) => log::warn!("[{label}] 이전 앱 백업을 그대로 둡니다({}): {error}", backup.display()),
        }
    }
    again
}

fn ensure_independent_install(helper: &'static Helper) -> Result<Option<InstallOutcome>, String> {
    let source = std::env::current_exe().ok().and_then(|executable| bundled_payload(helper, &executable));
    ensure_with(helper, source, &installation_places(helper, home().as_deref()), &NativeInstall(helper))
}

/// The periodic pass: nothing at all unless an earlier attempt was put off, or kept an older backup only for now.
fn retry_deferred(helper: &Helper, attempt: impl FnOnce() -> Result<Option<InstallOutcome>, String>) -> Option<Result<Option<InstallOutcome>, String>> {
    let pending = || helper.deferred.load(Ordering::Acquire) || helper.kept_backup.load(Ordering::Acquire);
    if !pending() { return None; }
    let _guard = lock(helper);
    // Done by a start or an open while this pass waited for the lock.
    if !pending() { return None; }
    Some(attempt())
}

fn report(helper: &Helper, result: Result<Option<InstallOutcome>, String>) {
    match result {
        Err(error) => log::warn!("[{}] {error}", helper.label),
        Ok(Some(InstallOutcome::Deferred(_))) => log::info!("[{}] 실행 중이라 업데이트를 미룹니다. 닫힌 뒤 다시 확인합니다.", helper.label),
        Ok(_) => (),
    }
}

fn supported() -> bool {
    if !cfg!(target_os = "macos") { return false; }
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| native_command(&SCREEN, Command::new("/usr/bin/sw_vers").arg("-productVersion")).ok()
        .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok()).map(|major| major >= 14).unwrap_or(false))
}

fn recheck_deferred_forever() {
    loop {
        std::thread::sleep(DEFERRED_RECHECK);
        for helper in [&SCREEN, &VIEWER] {
            if let Some(result) = retry_deferred(helper, || ensure_independent_install(helper)) { report(helper, result); }
        }
    }
}

fn start_deferred_recheck() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let spawned = std::thread::Builder::new().name("agentstoz-helper-update".into()).spawn(recheck_deferred_forever);
        if let Err(error) = spawned { log::warn!("[AgentsToZ Viewer] 미룬 업데이트 확인을 시작하지 못했습니다: {error}"); }
    });
}

/// Startup does not wait on file copying or codesign, and a helper error never stops the main app.
pub(crate) fn install_bundled_on_startup() {
    if !cfg!(target_os = "macos") { return; }
    for helper in [&SCREEN, &VIEWER] {
        tauri::async_runtime::spawn_blocking(move || {
            if !supported() { return; }
            let _guard = lock(helper);
            report(helper, ensure_independent_install(helper));
        });
    }
    start_deferred_recheck();
}

fn status() -> ScreenHelperStatus {
    if !supported() {
        return ScreenHelperStatus { supported: false, installed: false, running: false, update_pending: false,
            other_instance_running: false, instance_status_unknown: false, state: None };
    }
    let (installed, instances) = installation_observation(&SCREEN, &installation_places(&SCREEN, home().as_deref()), &NativeInstall(&SCREEN));
    let running = &instances.expected;
    let state = home()
        .map(|home| home.join("Library/Application Support/AgentsToZ Screen/status.json"))
        .and_then(|path| read_state(&path, running));
    ScreenHelperStatus { supported: true, installed, running: !running.is_empty(), state,
        update_pending: SCREEN.deferred.load(Ordering::Acquire), other_instance_running: instances.other,
        instance_status_unknown: instances.unknown }
}

fn installation_observation(helper: &Helper, places: &[PathBuf], actions: &impl InstallActions) -> (bool, InstanceObservation) {
    for place in places {
        match path_exists(helper, place) {
            Ok(true) => {
                let complete = place.join("Contents/MacOS").join(helper.executable).is_file();
                let mut instances = actions.instances(place);
                if !complete { instances.unknown = true; }
                return (complete, instances);
            },
            Ok(false) => (),
            Err(_) => return (false, InstanceObservation { unknown: true, ..Default::default() }),
        }
    }
    match places.get(1).or_else(|| places.first()) {
        Some(place) => (false, actions.instances(place)),
        None => (false, InstanceObservation { unknown: true, ..Default::default() }),
    }
}

fn viewer_status() -> ViewerHelperStatus {
    if !supported() {
        return ViewerHelperStatus { supported: false, installed: false, bundled: false, running: false, update_pending: false,
            other_instance_running: false, instance_status_unknown: false };
    }
    let bundled = std::env::current_exe().ok().and_then(|executable| bundled_payload(&VIEWER, &executable)).is_some();
    let (installed, instances) = installation_observation(&VIEWER, &installation_places(&VIEWER, home().as_deref()), &NativeInstall(&VIEWER));
    ViewerHelperStatus {
        supported: true,
        installed,
        bundled,
        running: !instances.expected.is_empty(),
        other_instance_running: instances.other,
        instance_status_unknown: instances.unknown,
        update_pending: VIEWER.deferred.load(Ordering::Acquire),
    }
}

/// No arguments: a helper built before `--show` existed exited on it, and `open` still reported success. A fresh launch
/// that is not a login-item launch shows the status window; a running helper gets the reopen event and shows it then.
/// The Viewer is opened the same way: nothing chooses a Mac or starts a session for the person (SR-23).
fn open(helper: &'static Helper) -> Result<OpenResult, String> {
    if !supported() { return Err(helper.unsupported.into()); }
    let _guard = lock(helper);
    open_with(helper, ensure_independent_install(helper), &NativeInstall(helper), OPEN_DEADLINE)
}

/// The 3-state answer (DESIGN 5.4): seen running (`verified`), asked but not seen running before `deadline`, or an error
/// that says why. Whatever the install step left in place, kept or updated, is opened only after its signature check.
fn open_with(helper: &Helper, installed: Result<Option<InstallOutcome>, String>, actions: &impl InstallActions, deadline: Duration) -> Result<OpenResult, String> {
    let outcome = installed?.ok_or(helper.missing)?;
    let app = outcome.path();
    actions.instances(app).check_open(helper)?;
    actions.verify(app)?;
    actions.instances(app).check_open(helper)?;
    actions.launch(app)?;
    let started = Instant::now();
    loop {
        let instances = actions.instances(app);
        instances.check_open(helper)?;
        if !instances.expected.is_empty() { return Ok(OpenResult { verified: true }); }
        if started.elapsed() >= deadline { return Ok(OpenResult { verified: false }); }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// pgrep and open are other processes, so both commands leave the UI thread.
async fn blocking<T: Send + 'static>(helper: &'static Helper, work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("{} 확인 실패: {e}", helper.label))?
}

#[tauri::command]
pub(crate) async fn get_screen_helper() -> Result<ScreenHelperStatus, String> { blocking(&SCREEN, || Ok(status())).await }

#[tauri::command]
pub(crate) async fn open_screen_helper() -> Result<OpenResult, String> { blocking(&SCREEN, || open(&SCREEN)).await }

#[tauri::command]
pub(crate) async fn get_viewer_helper() -> Result<ViewerHelperStatus, String> { blocking(&VIEWER, || Ok(viewer_status())).await }

/// 「다른 Mac 화면 보기」: install or update the Viewer if it is not running, then open it. Takes no arguments, so no
/// caller can name a Mac, a route or a session; connecting stays in the Viewer behind Touch ID (DESIGN 5.4, SR-23).
#[tauri::command]
pub(crate) async fn open_viewer_helper() -> Result<OpenResult, String> { blocking(&VIEWER, || open(&VIEWER)).await }

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const BUNDLED: &str = "100.0.0";

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("atz-screen-install-{}", transaction_token(&SCREEN).unwrap()));
            std::fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn app(&self, name: &str, hash: &str) -> PathBuf { self.helper_app(&SCREEN, name, hash, BUNDLED) }
        fn helper_app(&self, helper: &Helper, name: &str, hash: &str, version: &str) -> PathBuf {
            let app = self.0.join(name);
            std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
            std::fs::write(app.join("Contents/MacOS").join(helper.executable), hash).unwrap();
            std::fs::write(app.join("hash"), hash).unwrap();
            std::fs::write(app.join("version"), version).unwrap();
            app
        }
        fn leftovers(&self, stem: &str) -> usize {
            std::fs::read_dir(&self.0).unwrap().filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().starts_with(&format!(".{stem}"))).count()
        }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn copy_tree(source: &Path, destination: &Path) {
        std::fs::create_dir_all(destination).unwrap();
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let target = destination.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() { copy_tree(&entry.path(), &target); } else { std::fs::copy(entry.path(), target).unwrap(); }
        }
    }

    #[derive(Default)]
    struct FakeInstall {
        copied: Cell<usize>,
        stopped: Cell<usize>,
        reopened: Cell<usize>,
        /// The installed app (never a hidden staging or backup bundle) is running.
        is_running: bool,
        other_running: bool,
        observation_unknown: bool,
        foreign_on_installed_verify: usize,
        foreign_launched: Cell<bool>,
        /// Someone opens the installed app while the new one is being copied.
        launched_during_copy: bool,
        /// The old app keeps running from its backup after the swap.
        backup_running: bool,
        launched: Cell<bool>,
        corrupt_copy: bool,
        copy_failure: bool,
        launch_failure: bool,
        backup_verification_failure: bool,
        /// `open` (`launch`) was asked; with `starts_on_open` the app is then seen running.
        opened: Cell<usize>,
        starts_on_open: bool,
        open_failure: bool,
        /// Every backup looks freshly made, as if an update in flight still owned it.
        unsettled: bool,
        /// Someone opens the installed app while it is signature-checked for the Nth time (0: never).
        launch_on_installed_verify: usize,
        installed_verifies: Cell<usize>,
        /// `verify <file name>` and `running <file name>`, in order.
        events: RefCell<Vec<String>>,
    }
    fn event(kind: &str, app: &Path) -> String { format!("{kind} {}", app.file_name().unwrap().to_string_lossy()) }
    fn count(events: &[String], wanted: &str) -> usize { events.iter().filter(|event| *event == wanted).count() }
    impl InstallActions for FakeInstall {
        fn verify(&self, app: &Path) -> Result<String, String> {
            self.events.borrow_mut().push(event("verify", app));
            if app.file_name().unwrap().to_string_lossy().starts_with("AgentsToZ") {
                self.installed_verifies.set(self.installed_verifies.get() + 1);
                if self.installed_verifies.get() == self.launch_on_installed_verify { self.launched.set(true); }
                if self.installed_verifies.get() == self.foreign_on_installed_verify { self.foreign_launched.set(true); }
            }
            if self.backup_verification_failure && app.file_name().unwrap().to_string_lossy().contains("-backup-") {
                return Err("backup signature unavailable".into());
            }
            let hash = std::fs::read_to_string(app.join("hash")).map_err(|error| error.to_string())?;
            if hash == "foreign-team" { return Err("wrong signing identity".into()); }
            Ok(hash)
        }
        fn version(&self, app: &Path) -> Result<BundleVersion, String> {
            BundleVersion::parse(&std::fs::read_to_string(app.join("version")).map_err(|error| error.to_string())?).ok_or_else(|| "unreadable version".into())
        }
        fn copy(&self, source: &Path, destination: &Path) -> Result<(), String> {
            self.copied.set(self.copied.get() + 1);
            if self.launched_during_copy { self.launched.set(true); }
            copy_tree(source, destination);
            if self.corrupt_copy { std::fs::write(destination.join("hash"), "different-source").unwrap(); }
            if self.copy_failure { Err("copy failed after partial write".into()) } else { Ok(()) }
        }
        fn running(&self, app: &Path) -> Vec<i32> {
            self.events.borrow_mut().push(event("running", app));
            let hidden = app.file_name().unwrap().to_string_lossy().starts_with('.');
            let running = if hidden { self.backup_running && app.to_string_lossy().contains("-backup-") } else { self.is_running || self.launched.get() };
            if running { vec![42] } else { vec![] }
        }
        fn instances(&self, app: &Path) -> InstanceObservation {
            InstanceObservation { expected: self.running(app), other: self.other_running || self.foreign_launched.get(), unknown: self.observation_unknown }
        }
        fn stop(&self, _app: &Path, _pids: &[i32]) -> Result<(), String> { self.stopped.set(self.stopped.get() + 1); Ok(()) }
        fn reopen(&self, app: &Path) -> Result<(), String> {
            self.reopened.set(self.reopened.get() + 1);
            if self.launch_failure && std::fs::read_to_string(app.join("hash")).unwrap() == "new" { Err("new helper could not start".into()) }
            else { Ok(()) }
        }
        fn launch(&self, _app: &Path) -> Result<(), String> {
            self.opened.set(self.opened.get() + 1);
            if self.open_failure { return Err("open could not start the helper".into()); }
            if self.starts_on_open { self.launched.set(true); }
            Ok(())
        }
        fn settled(&self, _app: &Path) -> bool { !self.unsettled }
    }

    fn hash(app: &Path) -> String { std::fs::read_to_string(app.join("hash")).unwrap() }

    #[test]
    fn installs_independent_signed_payload_without_launching_or_touching_pairing() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let applications = root.0.join("Applications");
        let destination = applications.join(SCREEN.app_name);
        let state = root.0.join("pairing-sentinel");
        std::fs::write(&state, "keep private state").unwrap();
        let actions = FakeInstall::default();
        assert_eq!(install_payload(&SCREEN, &source, &destination, &actions).unwrap(), InstallOutcome::Installed(destination.clone()));
        assert_eq!(hash(&destination), "new");
        assert_eq!(std::fs::read_to_string(state).unwrap(), "keep private state");
        assert_eq!(actions.reopened.get(), 0);
        assert_eq!(std::fs::read_dir(applications).unwrap().count(), 1);
    }

    #[test]
    fn identical_signed_helper_is_not_copied_stopped_or_reopened() {
        let root = Scratch::new();
        let source = root.app("source.app", "same");
        let destination = root.app(SCREEN.app_name, "same");
        let actions = FakeInstall { is_running: true, ..Default::default() };
        install_payload(&SCREEN, &source, &destination, &actions).unwrap();
        assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get()), (0, 0, 0));
    }

    #[test]
    fn existing_foreign_identity_is_never_overwritten() {
        for helper in [&SCREEN, &VIEWER] {
            let root = Scratch::new();
            let source = root.helper_app(helper, "source.app", "new", BUNDLED);
            let destination = root.helper_app(helper, helper.app_name, "foreign-team", BUNDLED);
            let actions = FakeInstall::default();
            assert!(install_payload(helper, &source, &destination, &actions).is_err());
            assert_eq!(hash(&destination), "foreign-team");
            assert_eq!(actions.copied.get(), 0);
        }
    }

    #[test]
    fn partial_copy_or_changed_signature_keeps_the_old_app_and_removes_staging() {
        for corrupt_copy in [false, true] {
            let root = Scratch::new();
            let source = root.app("source.app", "new");
            let destination = root.app(SCREEN.app_name, "old");
            let actions = FakeInstall { corrupt_copy, copy_failure: !corrupt_copy, is_running: false, ..Default::default() };
            assert!(install_payload(&SCREEN, &source, &destination, &actions).is_err());
            assert_eq!(hash(&destination), "old");
            assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
            assert_eq!(root.leftovers("AgentsToZ"), 0);
        }
    }

    #[test]
    fn a_running_screen_cannot_trigger_a_relaunch_failure_or_change_its_bundle() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(SCREEN.app_name, "old");
        let actions = FakeInstall { is_running: true, launch_failure: true, ..Default::default() };
        assert_eq!(install_payload(&SCREEN, &source, &destination, &actions).unwrap(), InstallOutcome::Deferred(destination.clone()));
        assert_eq!(hash(&destination), "old");
        assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get(), actions.opened.get()), (0, 0, 0, 0));
        assert_eq!(root.leftovers("AgentsToZ"), 0);
    }

    #[test]
    fn a_stopped_screen_update_cleans_only_its_own_verified_backup_without_opening() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(SCREEN.app_name, "old");
        let unrelated = root.app(".AgentsToZ Screen-backup-previous.app", "older");
        let actions = FakeInstall { is_running: false, ..Default::default() };
        install_payload(&SCREEN, &source, &destination, &actions).unwrap();
        assert_eq!(hash(&destination), "new");
        assert_eq!(hash(&unrelated), "older");
        assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
        assert_eq!(root.leftovers("AgentsToZ Screen-backup-"), 1);
    }

    #[test]
    fn backup_cleanup_verification_failure_keeps_the_backup_and_successful_install() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(SCREEN.app_name, "old");
        let actions = FakeInstall { is_running: false, backup_verification_failure: true, ..Default::default() };
        assert!(install_payload(&SCREEN, &source, &destination, &actions).is_ok());
        assert_eq!(hash(&destination), "new");
        let backup = std::fs::read_dir(&root.0).unwrap().find_map(|entry| {
            let entry = entry.unwrap();
            entry.file_name().to_string_lossy().starts_with(".AgentsToZ Screen-backup-").then(|| entry.path())
        }).unwrap();
        assert_eq!(hash(&backup), "old");
        assert_eq!(actions.reopened.get(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn redirected_app_or_applications_folder_is_refused_without_touching_the_victim() {
        use std::os::unix::fs::symlink;
        for redirected_parent in [false, true] {
            let root = Scratch::new();
            let source = root.app("source.app", "new");
            let victim = root.app("victim.app", "old");
            let destination = if redirected_parent {
                let real = root.0.join("real");
                std::fs::create_dir(&real).unwrap();
                symlink(&real, root.0.join("Applications")).unwrap();
                root.0.join("Applications").join(SCREEN.app_name)
            } else {
                let destination = root.0.join(SCREEN.app_name);
                symlink(&victim, &destination).unwrap();
                destination
            };
            let actions = FakeInstall::default();
            assert!(install_payload(&SCREEN, &source, &destination, &actions).is_err());
            assert_eq!(hash(&victim), "old");
            assert_eq!(actions.copied.get(), 0);
        }
    }

    #[test]
    fn installed_apps_are_not_replaced_by_an_unbundled_developer_executable() {
        for helper in [&SCREEN, &VIEWER] {
            assert_eq!(bundled_payload(helper, Path::new("/usr/local/bin/AgentsToZScreen")), None);
            assert_eq!(bundled_payload(helper, Path::new("/tmp/target/debug/app")), None);
        }
    }

    #[test]
    fn activation_does_not_overwrite_a_path_that_appeared_after_staging() {
        let root = Scratch::new();
        let incoming = root.app("incoming.app", "new");
        let destination = root.app(SCREEN.app_name, "other app");
        assert!(rename_new(&incoming, &destination).is_err());
        assert_eq!(hash(&incoming), "new");
        assert_eq!(hash(&destination), "other app");
    }

    /// SR-35: a main app carrying an older build (a rollback, a stale copy) never takes back a newer helper, running
    /// or not, Screen or Viewer. Opening still uses the installed one.
    #[test]
    fn a_lower_bundle_version_never_replaces_a_newer_helper() {
        for helper in [&SCREEN, &VIEWER] {
            for is_running in [false, true] {
                let root = Scratch::new();
                let source = root.helper_app(helper, "source.app", "older-build", "1690.0.0");
                let destination = root.helper_app(helper, helper.app_name, "newer-build", "1700.0.0");
                let actions = FakeInstall { is_running, ..Default::default() };
                assert_eq!(install_payload(helper, &source, &destination, &actions).unwrap(), InstallOutcome::KeptNewer(destination.clone()));
                assert_eq!(hash(&destination), "newer-build");
                assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get()), (0, 0, 0));
                assert_eq!(root.leftovers(helper.app_name.trim_end_matches(".app")), 0);
            }
        }
    }

    #[test]
    fn a_higher_or_equal_bundle_version_with_a_new_signature_updates() {
        for (installed, carried) in [("1690.0.0", "1700.0.0"), ("1700.0.0", "1700.0.0"), ("2", "1700.0.0")] {
            let root = Scratch::new();
            let source = root.helper_app(&VIEWER, "source.app", "new", carried);
            let destination = root.helper_app(&VIEWER, VIEWER.app_name, "old", installed);
            let actions = FakeInstall::default();
            assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Installed(destination.clone()));
            assert_eq!(hash(&destination), "new");
        }
    }

    /// Without a readable version neither side can be ordered, so the installed app stays (fail closed). It passed the
    /// signature check, so it is not an error: the button still opens it.
    #[test]
    fn an_unreadable_bundle_version_keeps_the_installed_helper_and_still_opens_it() {
        for helper in [&screen(), &viewer()] {
            for (installed, carried) in [("1700.0.0", "dev"), ("", "1700.0.0"), ("1.2.3.4", "1700.0.0")] {
                let root = Scratch::new();
                let source = root.helper_app(helper, "source.app", "new", carried);
                let destination = root.helper_app(helper, helper.app_name, "old", installed);
                let actions = FakeInstall { is_running: true, ..Default::default() };
                assert_eq!(install_payload(helper, &source, &destination, &actions).unwrap(), InstallOutcome::KeptUnordered(destination.clone()));
                assert_eq!(hash(&destination), "old");
                assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get()), (0, 0, 0));
                let opened = open_with(helper, ensure_with(helper, Some(source), std::slice::from_ref(&destination), &actions), &actions, Duration::ZERO);
                assert_eq!(opened, Ok(OpenResult { verified: true }));
                assert_eq!((actions.opened.get(), actions.copied.get()), (1, 0));
                assert_eq!(hash(&destination), "old");
            }
        }
    }

    #[test]
    fn bundle_versions_compare_as_numbers() {
        let v = |text: &str| BundleVersion::parse(text).unwrap();
        assert!(v("1675.0.0") > v("1674.9.9"));
        assert!(v("10.0.0") > v("9.0.0"));
        assert!(v("2") < v("1675.0.0"));
        assert!(v("0.2") < v("2"));
        assert_eq!(v("1675"), v("1675.0.0"));
        assert_eq!(v(" 1675.0.0\n"), v("1675.0.0"));
        assert_eq!(v("1675.0.0").to_string(), "1675.0.0");
        for bad in ["", "dev", "1..2", "1.2.3.4", "+1", "-1", "1.a", "1 .2", "1234567890", "１"] {
            assert_eq!(BundleVersion::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn viewer_installs_like_screen_without_launching() {
        let root = Scratch::new();
        let source = root.helper_app(&VIEWER, "source.app", "new", BUNDLED);
        let destination = root.0.join("Applications").join(VIEWER.app_name);
        let actions = FakeInstall::default();
        assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Installed(destination.clone()));
        assert_eq!(hash(&destination), "new");
        assert!(destination.join("Contents/MacOS").join(VIEWER.executable).is_file());
        assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
    }

    #[test]
    fn a_stopped_viewer_is_updated_but_never_opened_by_the_update() {
        let root = Scratch::new();
        let source = root.helper_app(&VIEWER, "source.app", "new", BUNDLED);
        let destination = root.helper_app(&VIEWER, VIEWER.app_name, "old", "99.0.0");
        let actions = FakeInstall::default();
        assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Installed(destination.clone()));
        assert_eq!(hash(&destination), "new");
        assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
        assert_eq!(root.leftovers("AgentsToZ Viewer"), 0);
    }

    /// SR-35: the person may be looking at another Mac, so a running Viewer is never stopped. The update waits and is
    /// made at the next check that finds it closed; a pass with nothing put off does nothing.
    #[test]
    fn a_running_viewer_is_left_alone_and_replaced_at_the_next_check() {
        let root = Scratch::new();
        let helper = viewer();
        let source = root.helper_app(&helper, "source.app", "new", BUNDLED);
        let applications = root.0.join("Applications");
        std::fs::create_dir(&applications).unwrap();
        let destination = root.helper_app(&helper, &format!("Applications/{}", helper.app_name), "old", "99.0.0");
        let places = [root.0.join("System Applications").join(helper.app_name), destination.clone()];
        assert_eq!(retry_deferred(&helper, || panic!("nothing was put off")), None);

        let running = FakeInstall { is_running: true, ..Default::default() };
        assert_eq!(ensure_with(&helper, Some(source.clone()), &places, &running).unwrap(), Some(InstallOutcome::Deferred(destination.clone())));
        assert_eq!(hash(&destination), "old");
        assert_eq!((running.copied.get(), running.stopped.get(), running.reopened.get()), (0, 0, 0));
        assert!(helper.deferred.load(Ordering::Acquire));

        // Still open at the next check: still waiting.
        let still = retry_deferred(&helper, || ensure_with(&helper, Some(source.clone()), &places, &running)).unwrap();
        assert_eq!(still.unwrap(), Some(InstallOutcome::Deferred(destination.clone())));
        assert!(helper.deferred.load(Ordering::Acquire));

        let closed = FakeInstall::default();
        let done = retry_deferred(&helper, || ensure_with(&helper, Some(source.clone()), &places, &closed)).unwrap();
        assert_eq!(done.unwrap(), Some(InstallOutcome::Installed(destination.clone())));
        assert_eq!(hash(&destination), "new");
        assert_eq!((closed.stopped.get(), closed.reopened.get()), (0, 0));
        assert!(!helper.deferred.load(Ordering::Acquire));
        assert_eq!(retry_deferred(&helper, || panic!("the update was made")), None);
        assert_eq!(std::fs::read_dir(&applications).unwrap().count(), 1);
    }

    #[test]
    fn a_viewer_opened_while_the_update_was_copied_is_not_replaced_under_it() {
        let root = Scratch::new();
        let source = root.helper_app(&VIEWER, "source.app", "new", BUNDLED);
        let destination = root.helper_app(&VIEWER, VIEWER.app_name, "old", "99.0.0");
        let actions = FakeInstall { launched_during_copy: true, ..Default::default() };
        assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Deferred(destination.clone()));
        assert_eq!(actions.copied.get(), 1);
        assert_eq!(hash(&destination), "old");
        assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
        assert_eq!(root.leftovers("AgentsToZ Viewer"), 0, "the staging copy is removed");
    }

    /// A copy opened just before the swap runs from the backup bundle afterwards; deleting it would pull its files.
    #[test]
    fn a_backup_still_running_is_kept() {
        let root = Scratch::new();
        let source = root.helper_app(&VIEWER, "source.app", "new", BUNDLED);
        let destination = root.helper_app(&VIEWER, VIEWER.app_name, "old", "99.0.0");
        let actions = FakeInstall { backup_running: true, ..Default::default() };
        assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Installed(destination.clone()));
        assert_eq!(hash(&destination), "new");
        assert_eq!(root.leftovers("AgentsToZ Viewer-backup-"), 1);
    }

    /// Nothing slow sits between the Viewer's last running check and the swap, so a Viewer opened during any signature
    /// check is seen and keeps its files; the update waits.
    #[test]
    fn the_viewers_running_check_is_the_last_step_before_the_swap() {
        let installed = |kind: &str| format!("{kind} {}", VIEWER.app_name);
        let root = Scratch::new();
        let source = root.helper_app(&VIEWER, "source.app", "new", BUNDLED);
        let destination = root.helper_app(&VIEWER, VIEWER.app_name, "old", "99.0.0");
        let actions = FakeInstall::default();
        assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Installed(destination.clone()));
        let events = actions.events.borrow().clone();
        let last = |wanted: &str| events.iter().rposition(|event| event == wanted).unwrap();
        assert!(last(&installed("running")) > last(&installed("verify")), "{events:?}");
        let checks = count(&events, &installed("verify"));
        assert_eq!(checks, 2, "checked before the copy and after it, never again after the running check: {events:?}");

        for opened_at in 1..=checks {
            let root = Scratch::new();
            let source = root.helper_app(&VIEWER, "source.app", "new", BUNDLED);
            let destination = root.helper_app(&VIEWER, VIEWER.app_name, "old", "99.0.0");
            let actions = FakeInstall { launch_on_installed_verify: opened_at, ..Default::default() };
            assert_eq!(install_payload(&VIEWER, &source, &destination, &actions).unwrap(), InstallOutcome::Deferred(destination.clone()), "opened during check {opened_at}");
            assert_eq!(hash(&destination), "old");
            assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
            assert_eq!(root.leftovers("AgentsToZ Viewer"), 0, "no staging copy and no backup are left");
        }
    }

    #[test]
    fn screen_busy_state_preserves_the_bundle_and_stopped_state_still_rechecks_its_signature() {
        for is_running in [false, true] {
            let root = Scratch::new();
            let source = root.app("source.app", "new");
            let destination = root.app(SCREEN.app_name, "old");
            let actions = FakeInstall { is_running, ..Default::default() };
            install_payload(&SCREEN, &source, &destination, &actions).unwrap();
            assert_eq!(hash(&destination), if is_running { "old" } else { "new" });
            assert_eq!(count(&actions.events.borrow(), &format!("verify {}", SCREEN.app_name)), if is_running { 1 } else { 2 });
            assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
        }
    }

    /// SR-35: an older team-signed Viewer must not stay launchable beside the installed one. The backup an update kept
    /// because the old Viewer still ran from it goes at the next pass that finds it closed, within ten minutes.
    #[test]
    fn a_backup_kept_while_it_ran_is_removed_by_the_next_check_that_finds_it_closed() {
        let root = Scratch::new();
        let helper = viewer();
        let source = root.helper_app(&helper, "source.app", "new", BUNDLED);
        let destination = root.helper_app(&helper, &format!("Applications/{}", helper.app_name), "old", "99.0.0");
        let applications = root.0.join("Applications");
        let places = [root.0.join("System Applications").join(helper.app_name), destination.clone()];
        let backups = || std::fs::read_dir(&applications).unwrap().filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().starts_with(".AgentsToZ Viewer-backup-")).count();

        let still_running = FakeInstall { backup_running: true, ..Default::default() };
        assert_eq!(ensure_with(&helper, Some(source.clone()), &places, &still_running).unwrap(), Some(InstallOutcome::Installed(destination.clone())));
        assert_eq!((hash(&destination), backups()), ("new".to_string(), 1));
        assert!(helper.kept_backup.load(Ordering::Acquire));
        assert!(!helper.deferred.load(Ordering::Acquire), "nothing waits to be installed, so the panel says nothing");

        let again = retry_deferred(&helper, || ensure_with(&helper, Some(source.clone()), &places, &still_running)).unwrap();
        assert_eq!(again.unwrap(), Some(InstallOutcome::Installed(destination.clone())));
        assert_eq!(backups(), 1, "still running from the backup: kept");
        assert!(helper.kept_backup.load(Ordering::Acquire));

        let closed = FakeInstall::default();
        let done = retry_deferred(&helper, || ensure_with(&helper, Some(source.clone()), &places, &closed)).unwrap();
        assert_eq!(done.unwrap(), Some(InstallOutcome::Installed(destination.clone())));
        assert_eq!(backups(), 0);
        assert_eq!(hash(&destination), "new");
        assert!(!helper.kept_backup.load(Ordering::Acquire));
        assert_eq!(retry_deferred(&helper, || panic!("nothing is left to do")), None);
        assert_eq!(closed.copied.get(), 0, "the installed Viewer was already the carried one");
    }

    /// Only a backup this module named, that passes the team signature, has settled, is not running and is not newer than
    /// the installed helper is removed. A startup with a source build removes them too; it still installs nothing.
    #[test]
    fn only_this_modules_settled_signed_older_backups_are_removed() {
        let root = Scratch::new();
        let helper = viewer();
        let token = |digit: char| digit.to_string().repeat(32);
        let installed = root.helper_app(&helper, &format!("Applications/{}", helper.app_name), "new", "100.0.0");
        let older = root.helper_app(&helper, &format!("Applications/.AgentsToZ Viewer-backup-{}.app", token('a')), "old", "99.0.0");
        let same = root.helper_app(&helper, &format!("Applications/.AgentsToZ Viewer-backup-{}.app", token('b')), "new", "100.0.0");
        let kept = [
            root.helper_app(&helper, &format!("Applications/.AgentsToZ Viewer-backup-{}.app", token('c')), "newer", "101.0.0"),
            root.helper_app(&helper, &format!("Applications/.AgentsToZ Viewer-backup-{}.app", token('d')), "foreign-team", "1.0.0"),
            root.helper_app(&helper, &format!("Applications/.AgentsToZ Viewer-backup-{}.app", token('E')), "old", "99.0.0"),
            root.helper_app(&helper, "Applications/.AgentsToZ Viewer-backup-previous.app", "old", "99.0.0"),
            root.helper_app(&helper, &format!("Applications/.AgentsToZ Viewer-installing-{}.app", token('f')), "old", "99.0.0"),
            root.helper_app(&SCREEN, &format!("Applications/.AgentsToZ Screen-backup-{}.app", token('1')), "old", "99.0.0"),
            root.helper_app(&helper, "Applications/AgentsToZ Viewer copy.app", "old", "99.0.0"),
        ];
        let places = [installed.clone()];

        let fresh = FakeInstall { unsettled: true, ..Default::default() };
        assert_eq!(ensure_with(&helper, None, &places, &fresh).unwrap(), Some(InstallOutcome::Installed(installed.clone())));
        assert!(older.exists() && same.exists(), "just made: an update in flight may still own it");
        assert!(helper.kept_backup.load(Ordering::Acquire));

        let actions = FakeInstall::default();
        assert_eq!(ensure_with(&helper, None, &places, &actions).unwrap(), Some(InstallOutcome::Installed(installed.clone())));
        assert!(!older.exists() && !same.exists());
        for path in &kept { assert!(path.exists(), "{}", path.display()); }
        assert_eq!(hash(&installed), "new");
        assert!(!helper.kept_backup.load(Ordering::Acquire), "what stays is not retried every ten minutes");
        assert_eq!(actions.copied.get(), 0);
    }

    #[test]
    fn backups_stay_when_the_installed_helper_cannot_be_checked() {
        let root = Scratch::new();
        let helper = viewer();
        let installed = root.helper_app(&helper, helper.app_name, "foreign-team", "100.0.0");
        let backup = root.helper_app(&helper, &format!(".AgentsToZ Viewer-backup-{}.app", "0".repeat(32)), "old", "99.0.0");
        assert_eq!(ensure_with(&helper, None, &[installed.clone()], &FakeInstall::default()).unwrap(), Some(InstallOutcome::Installed(installed)));
        assert!(backup.exists());
        assert!(!helper.kept_backup.load(Ordering::Acquire));
    }

    /// DESIGN 5.4: `open` answers seen running, asked but not seen running, or an error that says why. Nothing that is
    /// not the signed helper is ever opened.
    #[test]
    fn opening_answers_in_three_states() {
        let root = Scratch::new();
        let helper = viewer();
        let installed = root.helper_app(&helper, helper.app_name, "same", BUNDLED);
        let places = [installed.clone()];
        let open = |actions: &FakeInstall, places: &[PathBuf]| open_with(&helper, ensure_with(&helper, None, places, actions), actions, Duration::ZERO);

        let starts = FakeInstall { starts_on_open: true, ..Default::default() };
        assert_eq!(open(&starts, &places), Ok(OpenResult { verified: true }));
        assert_eq!(starts.opened.get(), 1);

        let not_seen = FakeInstall::default();
        assert_eq!(open(&not_seen, &places), Ok(OpenResult { verified: false }), "requested, not confirmed");
        assert_eq!(not_seen.opened.get(), 1);

        let failing = FakeInstall { open_failure: true, ..Default::default() };
        assert_eq!(open(&failing, &places), Err("open could not start the helper".to_string()));

        let nothing = FakeInstall::default();
        assert_eq!(open(&nothing, &[root.0.join("nowhere").join(helper.app_name)]), Err(helper.missing.to_string()));
        let foreign = root.helper_app(&helper, &format!("elsewhere/{}", helper.app_name), "foreign-team", BUNDLED);
        assert_eq!(open(&nothing, &[foreign]), Err("wrong signing identity".to_string()));
        let install_failed = open_with(&helper, Err("설치 실패".to_string()), &nothing, Duration::ZERO);
        assert_eq!(install_failed, Err("설치 실패".to_string()));
        assert_eq!(nothing.opened.get(), 0, "nothing was opened");
        assert_eq!(hash(&installed), "same");
    }

    /// 「다른 Mac 화면 보기」 updates a closed Viewer before opening it, and opens a running one as it is.
    #[test]
    fn opening_updates_a_closed_viewer_first_and_never_stops_a_running_one() {
        for is_running in [false, true] {
            let root = Scratch::new();
            let helper = viewer();
            let source = root.helper_app(&helper, "source.app", "new", BUNDLED);
            let destination = root.helper_app(&helper, helper.app_name, "old", "99.0.0");
            let actions = FakeInstall { is_running, starts_on_open: true, ..Default::default() };
            let opened = open_with(&helper, ensure_with(&helper, Some(source), std::slice::from_ref(&destination), &actions), &actions, Duration::ZERO);
            assert_eq!(opened, Ok(OpenResult { verified: true }));
            assert_eq!(hash(&destination), if is_running { "old" } else { "new" });
            assert_eq!(helper.deferred.load(Ordering::Acquire), is_running, "a running Viewer's update is said to wait");
            assert_eq!((actions.opened.get(), actions.stopped.get(), actions.reopened.get()), (1, 0, 0));
        }
    }

    #[test]
    fn a_failed_attempt_is_not_retried_by_the_periodic_check() {
        let root = Scratch::new();
        let helper = viewer();
        let source = root.helper_app(&helper, "source.app", "new", BUNDLED);
        let destination = root.helper_app(&helper, helper.app_name, "foreign-team", "99.0.0");
        helper.deferred.store(true, Ordering::Release);
        let result = retry_deferred(&helper, || ensure_with(&helper, Some(source.clone()), &[destination.clone()], &FakeInstall::default())).unwrap();
        assert!(result.is_err());
        assert!(!helper.deferred.load(Ordering::Acquire));
        assert_eq!(hash(&destination), "foreign-team");
    }

    #[test]
    fn a_source_build_without_a_bundled_viewer_keeps_what_is_installed() {
        let root = Scratch::new();
        let helper = viewer();
        let installed = root.helper_app(&helper, helper.app_name, "old", "99.0.0");
        let places = [root.0.join("nowhere").join(helper.app_name), installed.clone()];
        assert_eq!(ensure_with(&helper, None, &places, &FakeInstall::default()).unwrap(), Some(InstallOutcome::Installed(installed.clone())));
        assert_eq!(ensure_with(&helper, None, &places[..1], &FakeInstall::default()).unwrap(), None);
        assert_eq!(hash(&installed), "old");
    }

    #[test]
    fn the_viewer_payload_is_found_beside_screen_in_the_main_app() {
        let root = Scratch::new();
        let contents = root.0.join("AgentsToZ_byCS.app/Contents");
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        let executable = contents.join("MacOS/app");
        assert_eq!(bundled_payload(&VIEWER, &executable), None, "an app without a Viewer offers none");
        root.helper_app(&VIEWER, "AgentsToZ_byCS.app/Contents/Helpers/AgentsToZ Viewer.app", "new", BUNDLED);
        assert_eq!(bundled_payload(&VIEWER, &executable), Some(contents.join("Helpers").join(VIEWER.app_name)));
        assert_eq!(bundled_payload(&SCREEN, &executable), None);
    }

    #[test]
    fn running_screen_is_unchanged_across_startup_and_retry_then_human_open_installs_once() {
        let root = Scratch::new();
        let helper = screen();
        let source = root.app("source.app", "new");
        let destination = root.app(helper.app_name, "old");
        let places = [destination.clone()];
        let key = root.0.join("private-key-sentinel");
        std::fs::write(&key, "preserve enrollment and helper keys").unwrap();
        let running = FakeInstall { is_running: true, ..Default::default() };
        for _ in 0..2 {
            assert_eq!(ensure_with(&helper, Some(source.clone()), &places, &running).unwrap(), Some(InstallOutcome::Deferred(destination.clone())));
            assert_eq!(hash(&destination), "old");
            assert_eq!((running.copied.get(), running.stopped.get(), running.reopened.get(), running.opened.get()), (0, 0, 0, 0));
        }
        assert!(helper.deferred.load(Ordering::Acquire));
        let still = retry_deferred(&helper, || ensure_with(&helper, Some(source.clone()), &places, &running)).unwrap().unwrap();
        assert_eq!(still, Some(InstallOutcome::Deferred(destination.clone())));
        assert_eq!(hash(&destination), "old");
        // The person fully quit the old Screen, then explicitly pressed Open.
        let closed = FakeInstall { starts_on_open: true, ..Default::default() };
        let result = open_with(&helper, ensure_with(&helper, Some(source), &places, &closed), &closed, Duration::ZERO);
        assert_eq!(result, Ok(OpenResult { verified: true }));
        assert_eq!(hash(&destination), "new");
        assert_eq!((closed.copied.get(), closed.stopped.get(), closed.reopened.get(), closed.opened.get()), (1, 0, 0, 1));
        assert!(!helper.deferred.load(Ordering::Acquire));
        assert_eq!(std::fs::read_to_string(key).unwrap(), "preserve enrollment and helper keys");
        assert_eq!(root.leftovers("AgentsToZ Screen-backup-"), 0);
    }

    #[test]
    fn another_path_or_unknown_instance_never_installs_or_launches_a_helper() {
        for helper in [screen(), viewer()] {
            for unknown in [false, true] {
                for already_installed in [false, true] {
                    let root = Scratch::new();
                    let source = root.helper_app(&helper, "source.app", "new", BUNDLED);
                    let destination = root.0.join(helper.app_name);
                    if already_installed { root.helper_app(&helper, helper.app_name, "old", "99.0.0"); }
                    let actions = FakeInstall { other_running: !unknown, observation_unknown: unknown, ..Default::default() };
                    let places = [root.0.join("System Applications").join(helper.app_name), destination.clone()];
                    let outcome = ensure_with(&helper, Some(source), &places, &actions);
                    assert_eq!(outcome.as_ref().unwrap(), &Some(InstallOutcome::Deferred(destination.clone())));
                    let error = open_with(&helper, outcome, &actions, Duration::ZERO).unwrap_err();
                    assert!(error.contains(if unknown { "확인하지 못했습니다" } else { "다른 위치" }));
                    assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get(), actions.opened.get()), (0, 0, 0, 0));
                    assert_eq!(destination.exists(), already_installed);
                    if already_installed { assert_eq!(hash(&destination), "old"); }
                }
            }
        }
    }

    #[test]
    fn an_identical_or_newer_install_still_refuses_opening_another_path_instance() {
        for helper in [screen(), viewer()] {
            for (source_hash, source_version) in [("same", BUNDLED), ("older", "1.0.0")] {
                let root = Scratch::new();
                let source = root.helper_app(&helper, "source.app", source_hash, source_version);
                let destination = root.helper_app(&helper, helper.app_name, "same", BUNDLED);
                let actions = FakeInstall { other_running: true, ..Default::default() };
                let outcome = ensure_with(&helper, Some(source), std::slice::from_ref(&destination), &actions);
                assert!(!helper.deferred.load(Ordering::Acquire), "no update is owed when the installed bytes are current/newer");
                assert!(open_with(&helper, outcome, &actions, Duration::ZERO).unwrap_err().contains("다른 위치"));
                assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get(), actions.opened.get()), (0, 0, 0, 0));
                assert_eq!(hash(&destination), "same");
            }
        }
    }

    #[test]
    fn another_path_opened_during_verification_prevents_the_swap_and_explicit_launch() {
        for helper in [screen(), viewer()] {
            let root = Scratch::new();
            let source = root.helper_app(&helper, "source.app", "new", BUNDLED);
            let destination = root.helper_app(&helper, helper.app_name, "old", "99.0.0");
            let actions = FakeInstall { foreign_on_installed_verify: 2, ..Default::default() };
            let result = ensure_with(&helper, Some(source), std::slice::from_ref(&destination), &actions);
            assert_eq!(result.as_ref().unwrap(), &Some(InstallOutcome::Deferred(destination.clone())));
            assert_eq!(hash(&destination), "old");
            assert!(open_with(&helper, result, &actions, Duration::ZERO).unwrap_err().contains("다른 위치"));
            assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get(), actions.opened.get()), (1, 0, 0, 0));
            assert_eq!(root.leftovers("AgentsToZ"), 0);
        }
    }

    #[test]
    fn process_observation_separates_expected_other_and_unknown_without_conveying_authority() {
        let expected = Path::new("/Applications/Expected.app/Contents/MacOS/Helper");
        let observed = classify_instances(Ok(vec![42, 43, 44]), expected, |pid| match pid {
            42 => Some(expected.to_path_buf()),
            43 => Some(PathBuf::from("/QA/Helper.app/Contents/MacOS/Helper")),
            _ => None,
        });
        assert_eq!(observed.expected, vec![42]);
        assert!(observed.other && observed.unknown && observed.blocks_install());
        assert!(observed.check_open(&SCREEN).is_err());
        for code in [Some(2), None, Some(0)] { assert!(parse_running_helpers(code, b"").is_err()); }
        for bytes in [b"0\n".as_slice(), b"1\n", b"-42\n", b"garbage\n", b"42\ninvalid\n", &[0xff]] {
            assert!(parse_running_helpers(Some(0), bytes).is_err());
        }
        assert_eq!(parse_running_helpers(Some(1), b"").unwrap(), Vec::<i32>::new());
        assert_eq!(parse_running_helpers(Some(0), b"42\n43\n").unwrap(), vec![42, 43]);
        let unavailable = classify_instances(Err(()), expected, |_| panic!("no PID path is trusted"));
        assert!(unavailable.unknown && !unavailable.other && unavailable.expected.is_empty());
    }

    #[test]
    fn unknown_process_observation_preserves_backups_and_status_does_not_claim_a_running_helper() {
        let root = Scratch::new();
        let helper = screen();
        let destination = root.helper_app(&helper, helper.app_name, "new", BUNDLED);
        let backup = root.helper_app(&helper, ".AgentsToZ Screen-backup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.app", "old", "99.0.0");
        let unknown = FakeInstall { observation_unknown: true, ..Default::default() };
        assert!(sweep_backups(&helper, &destination, &unknown));
        assert!(backup.exists());
        let (installed, observed) = installation_observation(&helper, std::slice::from_ref(&destination), &unknown);
        assert!(installed && observed.unknown && observed.expected.is_empty() && !observed.other);
        let other = FakeInstall { other_running: true, ..Default::default() };
        let (_, observed) = installation_observation(&helper, std::slice::from_ref(&destination), &other);
        assert!(observed.other && observed.expected.is_empty() && !observed.unknown);
        assert!(!sweep_backups(&helper, &destination, &FakeInstall::default()));
        assert!(!backup.exists());
    }

    #[test]
    fn screen_status_serializes_pending_and_instance_blocks_independently() {
        let status = serde_json::to_value(ScreenHelperStatus { supported: true, installed: true, running: false,
            state: None, update_pending: true, other_instance_running: true, instance_status_unknown: false }).unwrap();
        assert_eq!(status, serde_json::json!({"supported":true,"installed":true,"running":false,"state":null,
            "updatePending":true,"otherInstanceRunning":true,"instanceStatusUnknown":false}));
    }

    #[test]
    fn an_incomplete_bundle_is_not_advertised_as_installed_or_safe_to_open() {
        let root = Scratch::new();
        let destination = root.0.join(SCREEN.app_name);
        std::fs::create_dir_all(&destination).unwrap();
        let (installed, instances) = installation_observation(&SCREEN, &[destination], &FakeInstall::default());
        assert!(!installed && instances.unknown);
        assert!(instances.check_open(&SCREEN).is_err());
    }

    #[test]
    fn the_two_helpers_differ_only_where_they_must() {
        for helper in [&SCREEN, &VIEWER] {
            assert!(helper.executable.len() < 16, "pgrep -x sees at most MAXCOMLEN bytes");
            assert!(helper.app_name.ends_with(".app") && helper.app_name.starts_with(helper.label));
            assert!(helper.bundle_id.starts_with("com.intenet.agentstozbycs."));
            assert!(signature_requirement(helper).contains(&format!("identifier \"{}\"", helper.bundle_id)));
            assert!(signature_requirement(helper).contains("certificate leaf[subject.OU] = \"DA8QKAQ2C9\""));
            assert!(helper.defer_while_running && !helper.reopen_after_update);
            for text in [helper.subject, helper.object, helper.missing, helper.unsupported] { assert!(text.starts_with(helper.label)); }
        }
        assert!(SCREEN.defer_while_running && !SCREEN.reopen_after_update);
        assert!(VIEWER.defer_while_running && !VIEWER.reopen_after_update);
        assert_eq!(VIEWER.bundle_id, "com.intenet.agentstozbycs.viewer");
        // The status keys the panel reads (src/useViewerHelper.ts).
        let status = serde_json::to_value(ViewerHelperStatus { supported: true, installed: true, bundled: false, running: false, update_pending: true, other_instance_running: false, instance_status_unknown: true }).unwrap();
        assert_eq!(status, serde_json::json!({"supported": true, "installed": true, "bundled": false, "running": false, "updatePending": true, "otherInstanceRunning": false, "instanceStatusUnknown": true}));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn same_identifier_adhoc_signature_cannot_impersonate_the_developer_id_helper() {
        for helper in [&SCREEN, &VIEWER] {
            let root = Scratch::new();
            let app = root.helper_app(helper, helper.app_name, "fixture", BUNDLED);
            std::fs::remove_file(app.join("hash")).unwrap();
            std::fs::remove_file(app.join("version")).unwrap();
            std::fs::copy("/usr/bin/true", app.join("Contents/MacOS").join(helper.executable)).unwrap();
            std::fs::write(app.join("Contents/Info.plist"), format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{}</string><key>CFBundleExecutable</key><string>{}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>", helper.bundle_id, helper.executable)).unwrap();
            native_command(helper, Command::new("/usr/bin/codesign").args(["--force", "--sign", "-", "--identifier", helper.bundle_id]).arg(&app)).unwrap();
            native_command(helper, Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&app)).unwrap();
            assert!(NativeInstall(helper).verify(&app).is_err());
        }
    }

    /// A backup just renamed into place may belong to an update still in flight; a missing one is never "settled".
    #[test]
    fn a_fresh_or_missing_backup_has_not_settled() {
        let root = Scratch::new();
        let backup = root.helper_app(&VIEWER, &format!(".AgentsToZ Viewer-backup-{}.app", "0".repeat(32)), "old", "99.0.0");
        assert!(!NativeInstall(&VIEWER).settled(&backup));
        assert!(!NativeInstall(&VIEWER).settled(&root.0.join("missing.app")));
    }

    /// The version comes from the bundle's own Info.plist, XML or binary, through plutil.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_native_version_is_the_info_plist_bundle_version() {
        let root = Scratch::new();
        let app = root.helper_app(&VIEWER, VIEWER.app_name, "fixture", BUNDLED);
        let plist = app.join("Contents/Info.plist");
        std::fs::write(&plist, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>1675.0.0</string><key>CFBundleVersion</key><string>1676.0.0</string></dict></plist>").unwrap();
        assert_eq!(NativeInstall(&VIEWER).version(&app).unwrap(), BundleVersion([1676, 0, 0]));
        native_command(&VIEWER, Command::new("/usr/bin/plutil").args(["-convert", "binary1"]).arg(&plist)).unwrap();
        assert_eq!(NativeInstall(&VIEWER).version(&app).unwrap(), BundleVersion([1676, 0, 0]));
        std::fs::write(&plist, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleVersion</key><string>next</string></dict></plist>").unwrap();
        assert!(NativeInstall(&VIEWER).version(&app).is_err());
        std::fs::write(&plist, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict></dict></plist>").unwrap();
        assert!(NativeInstall(&VIEWER).version(&app).is_err());
    }

    /// Explicit local opt-in only: a signed build in the temporary directory, never an installed app or a launch.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires AGENTSTOZ_SCREEN_SIGNED_TEST_APP pointing to a temporary Developer ID signed payload"]
    fn signed_payload_installs_in_scratch_applications_and_identical_retry_is_a_noop() {
        use std::os::unix::fs::MetadataExt;
        let source = PathBuf::from(std::env::var_os("AGENTSTOZ_SCREEN_SIGNED_TEST_APP").expect("explicit signed fixture is required")).canonicalize().unwrap();
        assert!(source.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert_eq!(source.file_name().unwrap(), SCREEN.app_name);
        let root = Scratch::new();
        let applications = root.0.join("Applications");
        let destination = applications.join(SCREEN.app_name);
        let native = NativeInstall(&SCREEN);
        assert!(native.running(&destination).is_empty());
        install_payload(&SCREEN, &source, &destination, &native).unwrap();
        assert_eq!(native.verify(&destination).unwrap(), native.verify(&source).unwrap());
        let executable = destination.join("Contents/MacOS").join(SCREEN.executable);
        let before = std::fs::metadata(&executable).unwrap();
        install_payload(&SCREEN, &source, &destination, &native).unwrap();
        let after = std::fs::metadata(executable).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(std::fs::read_dir(applications).unwrap().count(), 1);
        assert!(native.running(&destination).is_empty());
    }

    /// The sample the Swift side is checked against (scripts/check-screen-control.ts), so both ends read one shape.
    const CONTRACT: &str = include_str!("../../native/screen-control/Tests/StatusContract/status.json");

    #[test]
    fn reads_the_helpers_own_file() {
        let state = parse_state(CONTRACT, &[4242]).expect("the contract sample parses");
        assert_eq!(state, HelperState { power: "on", viewing: true, devices: 2, capture: true, control: false, login_item: "approval" });
    }

    /// On, but off an approved network: the panel must not show it as ready for devices (ScreenStatusFile.swift
    /// writes `waiting`; scripts/check-screen-control.ts checks that spelling on the Swift side).
    #[test]
    fn reads_waiting_for_an_approved_network() {
        let waiting = CONTRACT.replacen("\"power\":\"on\"", "\"power\":\"waiting\"", 1);
        assert_ne!(waiting, CONTRACT);
        assert_eq!(parse_state(&waiting, &[4242]).map(|state| state.power), Some("waiting"));
    }

    #[test]
    fn a_file_left_by_a_helper_that_is_gone_is_not_shown() {
        assert_eq!(parse_state(CONTRACT, &[]), None);
        assert_eq!(parse_state(CONTRACT, &[1, 2]), None);
    }

    #[test]
    fn values_it_does_not_know_are_refused_but_new_keys_are_not() {
        let with = |from: &str, to: &str| CONTRACT.replacen(from, to, 1);
        assert_eq!(parse_state(&with("\"on\"", "\"sideways\""), &[4242]), None);
        assert_eq!(parse_state(&with("\"approval\"", "\"maybe\""), &[4242]), None);
        assert_eq!(parse_state(&with("\"version\":1", "\"version\":2"), &[4242]), None);
        assert_eq!(parse_state("not json", &[4242]), None);
        let newer = CONTRACT.replacen('{', "{\"displays\":2,", 1);
        assert!(parse_state(&newer, &[4242]).is_some());
    }

    #[test]
    fn an_oversized_or_missing_file_is_not_read() {
        let dir = std::env::temp_dir().join(format!("atz-screen-status-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("status.json");
        assert_eq!(read_state(&path, &[4242]), None);
        std::fs::write(&path, format!("{}{}", CONTRACT, " ".repeat(STATUS_LIMIT as usize))).unwrap();
        assert_eq!(read_state(&path, &[4242]), None);
        std::fs::write(&path, CONTRACT).unwrap();
        assert!(read_state(&path, &[4242]).is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
