//! AgentsToZ Screen: the separate menu bar app that alone holds screen recording and Accessibility permission
//! (docs/design/screen-control-2026-10-24/DESIGN.md). A signed payload ships inside the main app, but is installed and
//! opened as an independent app with its own bundle and keychain identity. The panel reads
//! the helper's small status file and never switches the helper: turning on and registering a device stay in the
//! helper, at the Mac, behind Touch ID. The file decides nothing about security; a wrong value only misleads a label.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const BUNDLE_ID: &str = "com.intenet.agentstozbycs.screen";
/// The process name `pgrep -x` sees (under the 16-byte `MAXCOMLEN`).
const EXECUTABLE: &str = "AgentsToZScreen";
const APP_NAME: &str = "AgentsToZ Screen.app";
const TEAM_ID: &str = "DA8QKAQ2C9";
static INSTALL_LOCK: Mutex<()> = Mutex::new(());
/// The helper writes a few hundred bytes; anything larger is not its file.
const STATUS_LIMIT: u64 = 4096;
/// How long `open` gets before the answer is 「requested, not confirmed」 (the 3-state contract).
const OPEN_DEADLINE: Duration = Duration::from_secs(4);

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
    /** None while running means the state could not be read (an older helper, or the file is not its own). */
    state: Option<HelperState>,
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

fn running_helpers() -> Vec<i32> {
    let Ok(output) = Command::new("/usr/bin/pgrep").args(["-x", EXECUTABLE]).output() else { return Vec::new() };
    String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| line.trim().parse().ok()).collect()
}

fn home() -> Option<PathBuf> { std::env::var_os("HOME").map(PathBuf::from) }

fn installation_places(home: Option<&Path>) -> Vec<PathBuf> {
    let mut places = vec![Path::new("/Applications").join(APP_NAME)];
    if let Some(home) = home { places.push(home.join("Applications").join(APP_NAME)); }
    places
}

fn installed() -> bool {
    installation_places(home().as_deref()).iter()
        .any(|place| place.join("Contents/MacOS").join(EXECUTABLE).is_file())
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("AgentsToZ Screen 설치 경로를 확인하지 못했습니다: {error}")),
    }
}

/// Neither an Applications alias nor a redirected app/binary may become an installer destination.
fn reject_symlink_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute() { return Err("AgentsToZ Screen 설치 경로가 절대 경로가 아닙니다.".into()); }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Normal(_) => current.push(component.as_os_str()),
            _ => return Err("AgentsToZ Screen 설치 경로에 허용되지 않는 구성 요소가 있습니다.".into()),
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err("AgentsToZ Screen 설치 경로의 심볼릭 링크는 허용하지 않습니다.".into()),
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("AgentsToZ Screen 설치 경로를 확인하지 못했습니다: {error}")),
        }
    }
    Ok(())
}

fn reject_bundle_links(path: &Path) -> Result<(), String> {
    reject_symlink_components(path)?;
    let mut pending = vec![(path.to_path_buf(), 0usize)];
    let mut count = 0usize;
    while let Some((current, depth)) = pending.pop() {
        count += 1;
        if count > 4096 || depth > 16 { return Err("AgentsToZ Screen 번들의 크기 제한을 초과했습니다.".into()); }
        let metadata = std::fs::symlink_metadata(&current).map_err(|error| format!("AgentsToZ Screen 번들을 확인하지 못했습니다: {error}"))?;
        if metadata.file_type().is_symlink() { return Err("AgentsToZ Screen 번들의 심볼릭 링크는 허용하지 않습니다.".into()); }
        if metadata.is_dir() {
            for entry in std::fs::read_dir(&current).map_err(|error| error.to_string())? {
                pending.push((entry.map_err(|error| error.to_string())?.path(), depth + 1));
            }
        } else if !metadata.is_file() { return Err("AgentsToZ Screen 번들에 일반 파일이 아닌 항목이 있습니다.".into()); }
    }
    Ok(())
}

fn signature_requirement() -> String {
    format!("=identifier \"{BUNDLE_ID}\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"{TEAM_ID}\"")
}

trait InstallActions {
    fn verify(&self, app: &Path) -> Result<String, String>;
    fn copy(&self, source: &Path, destination: &Path) -> Result<(), String>;
    fn running(&self, app: &Path) -> Vec<i32>;
    fn stop(&self, app: &Path, pids: &[i32]) -> Result<(), String>;
    fn reopen(&self, app: &Path) -> Result<(), String>;
}

struct NativeInstall;

fn native_command(command: &mut Command) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error| format!("AgentsToZ Screen 설치 명령을 실행하지 못했습니다: {error}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|error| error.to_string())?.is_some() { break; }
        if started.elapsed() >= Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("AgentsToZ Screen 설치 명령의 대기 시간을 초과했습니다.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("AgentsToZ Screen 설치 명령이 실패했습니다: {}", String::from_utf8_lossy(&output.stderr).trim()));
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

fn exact_running(app: &Path) -> Vec<i32> {
    let executable = app.join("Contents/MacOS").join(EXECUTABLE);
    running_helpers().into_iter().filter(|pid| process_executable(*pid).as_deref() == Some(executable.as_path())).collect()
}

fn open_independent(app: &Path) -> Result<(), String> {
    native_command(Command::new("/usr/bin/open").arg(app)).map(|_| ())
}

impl InstallActions for NativeInstall {
    fn verify(&self, app: &Path) -> Result<String, String> {
        reject_bundle_links(app)?;
        if !app.join("Contents/MacOS").join(EXECUTABLE).is_file() { return Err("AgentsToZ Screen 실행 파일이 없습니다.".into()); }
        native_command(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict", "--all-architectures", "-R", &signature_requirement()]).arg(app))?;
        let output = native_command(Command::new("/usr/bin/codesign").args(["--display", "--verbose=4"]).arg(app))?;
        let hashes: Vec<_> = output.lines().filter_map(|line| line.strip_prefix("CDHash=")).collect();
        if hashes.len() != 1 || hashes[0].len() != 40 || !hashes[0].bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("AgentsToZ Screen의 코드 서명 지문을 확인하지 못했습니다.".into());
        }
        Ok(hashes[0].to_string())
    }
    fn copy(&self, source: &Path, destination: &Path) -> Result<(), String> {
        native_command(Command::new("/usr/bin/ditto").arg(source).arg(destination)).map(|_| ())
    }
    fn running(&self, app: &Path) -> Vec<i32> { exact_running(app) }
    fn stop(&self, app: &Path, pids: &[i32]) -> Result<(), String> {
        let executable = app.join("Contents/MacOS").join(EXECUTABLE);
        for pid in pids {
            if process_executable(*pid).as_deref() != Some(executable.as_path()) { continue; }
            #[cfg(unix)]
            if unsafe { libc::kill(*pid, libc::SIGTERM) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err("실행 중인 AgentsToZ Screen을 종료하지 못했습니다. 기존 앱을 유지합니다.".into());
            }
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            if pids.iter().all(|pid| process_executable(*pid).as_deref() != Some(executable.as_path())) { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("실행 중인 AgentsToZ Screen이 종료되지 않았습니다. 기존 앱을 유지합니다.".into())
    }
    fn reopen(&self, app: &Path) -> Result<(), String> {
        open_independent(app)?;
        let started = Instant::now();
        while started.elapsed() < OPEN_DEADLINE {
            if !exact_running(app).is_empty() { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("업데이트한 AgentsToZ Screen의 재실행을 확인하지 못했습니다.".into())
    }
}

struct StagingDirectory(PathBuf, bool);
impl Drop for StagingDirectory {
    fn drop(&mut self) { if self.1 { let _ = std::fs::remove_dir_all(&self.0); } }
}

fn transaction_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("AgentsToZ Screen 설치 식별자를 만들지 못했습니다: {error}"))?;
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

/// Copies only the signed app. Keychain, pairing, approved networks, TCC and login-item settings are never touched.
fn install_payload(source: &Path, destination: &Path, actions: &impl InstallActions) -> Result<PathBuf, String> {
    reject_bundle_links(source)?;
    let source_hash = actions.verify(source)?;
    reject_symlink_components(destination)?;
    let had_destination = path_exists(destination)?;
    let previous_hash = if had_destination { reject_bundle_links(destination)?; Some(actions.verify(destination)?) } else { None };
    if previous_hash.as_ref() == Some(&source_hash) { return Ok(destination.to_path_buf()); }
    let parent = destination.parent().ok_or("AgentsToZ Screen 설치 폴더가 없습니다.")?;
    if !path_exists(parent)? {
        std::fs::create_dir(parent).map_err(|error| format!("AgentsToZ Screen 설치 폴더를 만들지 못했습니다: {error}"))?;
    }
    reject_symlink_components(parent)?;
    let token = transaction_token()?;
    let staged = parent.join(format!(".AgentsToZ Screen-installing-{token}.app"));
    let backup = parent.join(format!(".AgentsToZ Screen-backup-{token}.app"));
    if path_exists(&staged)? || path_exists(&backup)? { return Err("AgentsToZ Screen 설치 임시 경로가 이미 있습니다.".into()); }
    std::fs::create_dir(&staged).map_err(|error| format!("AgentsToZ Screen을 설치할 권한이 없거나 공간이 부족합니다: {error}"))?;
    let mut cleanup = StagingDirectory(staged.clone(), true);
    actions.copy(source, &staged)?;
    reject_bundle_links(&staged)?;
    if actions.verify(&staged)? != source_hash { return Err("복사한 AgentsToZ Screen의 서명 지문이 원본과 다릅니다. 기존 앱을 유지합니다.".into()); }
    reject_symlink_components(destination)?;
    if path_exists(destination)? != had_destination || (had_destination && Some(actions.verify(destination)?) != previous_hash) {
        return Err("설치 중 AgentsToZ Screen이 변경되었습니다. 기존 앱을 유지합니다.".into());
    }
    let running = actions.running(destination);
    if let Err(error) = actions.stop(destination, &running) {
        if !running.is_empty() { let _ = actions.reopen(destination); }
        return Err(error);
    }
    reject_symlink_components(destination)?;
    if path_exists(destination)? != had_destination || (had_destination && Some(actions.verify(destination)?) != previous_hash) {
        if !running.is_empty() { let _ = actions.reopen(destination); }
        return Err("실행 종료 대기 중 AgentsToZ Screen이 변경되었습니다. 설치를 중단합니다.".into());
    }
    if had_destination {
        if let Err(error) = rename_new(destination, &backup) {
            if !running.is_empty() { let _ = actions.reopen(destination); }
            return Err(format!("기존 AgentsToZ Screen을 백업하지 못했습니다: {error}"));
        }
    }
    let activation = rename_new(&staged, destination);
    let moved_new_app = activation.is_ok();
    let activated = activation.map_err(|error| error.to_string())
        .and_then(|_| if running.is_empty() { Ok(()) } else { actions.reopen(destination) });
    if let Err(error) = activated {
        if had_destination {
            // Keep both app bundles if rollback itself fails. Never delete an installed or backup app.
            if moved_new_app {
                reject_bundle_links(destination)?;
                if actions.verify(destination)? != source_hash { return Err(format!("Screen 업데이트 실패: {error}. 설치 경로가 변경되어 이전 앱 백업을 유지합니다: {}", backup.display())); }
                actions.stop(destination, &actions.running(destination))?;
                rename_new(destination, &staged).map_err(|rollback| format!("Screen 업데이트 실패: {error}. 새 앱을 옮기지 못해 백업을 유지합니다: {rollback}"))?;
            } else if path_exists(destination)? {
                return Err(format!("Screen 업데이트 실패: {error}. 다른 항목이 설치 경로에 생겨 덮어쓰지 않았습니다. 이전 앱 백업: {}", backup.display()));
            }
            if let Err(rollback) = rename_new(&backup, destination) {
                cleanup.1 = false;
                return Err(format!("Screen 업데이트 실패: {error}. 이전 앱 복원 실패: {rollback}. 백업: {}", backup.display()));
            }
            if !running.is_empty() { let _ = actions.reopen(destination); }
        }
        return Err(if had_destination { format!("AgentsToZ Screen 업데이트에 실패해 이전 앱을 복원했습니다: {error}") }
            else { format!("AgentsToZ Screen을 설치하지 못했습니다: {error}") });
    }
    if let Some(previous_hash) = previous_hash {
        // Only this transaction's verified old bundle is disposable, and only after a running helper has restarted.
        // Cleanup failure leaves a recoverable backup; it must not turn a successful installation into a failure.
        let cleanup_backup = || -> Result<(), String> {
            reject_bundle_links(&backup)?;
            if actions.verify(&backup)? != previous_hash { return Err("백업의 서명 지문이 달라 삭제하지 않았습니다.".into()); }
            std::fs::remove_dir_all(&backup).map_err(|error| error.to_string())
        };
        if let Err(error) = cleanup_backup() { log::warn!("[AgentsToZ Screen] 설치는 완료됐지만 이번 설치의 백업을 유지합니다: {error}"); }
    }
    Ok(destination.to_path_buf())
}

fn bundled_payload(executable: &Path) -> Option<PathBuf> {
    if executable.file_name()? != "app" || executable.parent()?.file_name()? != "MacOS" { return None; }
    let contents = executable.parent()?.parent()?;
    if contents.file_name()? != "Contents" || contents.parent()?.file_name()? != "AgentsToZ_byCS.app" { return None; }
    let payload = contents.join("Helpers").join(APP_NAME);
    // Broken links are present too, and will be refused instead of treated as an absent developer payload.
    std::fs::symlink_metadata(&payload).ok().map(|_| payload)
}

fn ensure_independent_install() -> Result<Option<PathBuf>, String> {
    let places = installation_places(home().as_deref());
    let mut existing = None;
    for place in &places { if path_exists(place)? { existing = Some(place.clone()); break; } }
    let source = std::env::current_exe().ok().and_then(|executable| bundled_payload(&executable));
    let Some(source) = source else { return Ok(existing); }; // Source development never replaces an installed helper.
    let destination = existing.or_else(|| places.get(1).cloned()).ok_or("사용자 Applications 폴더를 찾을 수 없습니다.")?;
    install_payload(&source, &destination, &NativeInstall).map(Some)
}

fn supported() -> bool {
    if !cfg!(target_os = "macos") { return false; }
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| native_command(Command::new("/usr/bin/sw_vers").arg("-productVersion")).ok()
        .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok()).map(|major| major >= 14).unwrap_or(false))
}

/// Startup does not wait on file copying or codesign, and a helper error never stops the main app.
pub(crate) fn install_bundled_on_startup() {
    if !cfg!(target_os = "macos") { return; }
    tauri::async_runtime::spawn_blocking(|| {
        if !supported() { return; }
        let _guard = INSTALL_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        if let Err(error) = ensure_independent_install() { log::warn!("[AgentsToZ Screen] {error}"); }
    });
}

fn status() -> ScreenHelperStatus {
    if !supported() {
        return ScreenHelperStatus { supported: false, installed: false, running: false, state: None };
    }
    let running = running_helpers();
    let state = home()
        .map(|home| home.join("Library/Application Support/AgentsToZ Screen/status.json"))
        .and_then(|path| read_state(&path, &running));
    ScreenHelperStatus { supported: true, installed: installed(), running: !running.is_empty(), state }
}

/// No arguments: a helper built before `--show` existed exited on it, and `open` still reported success. A fresh launch
/// that is not a login-item launch shows the status window; a running helper gets the reopen event and shows it then.
fn open() -> Result<OpenResult, String> {
    if !supported() { return Err("AgentsToZ Screen은 macOS 14 이상에서 쓸 수 있습니다.".into()); }
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let app = ensure_independent_install()?.ok_or("AgentsToZ Screen이 없습니다. Screen이 포함된 메인 앱을 설치해 주세요.")?;
    NativeInstall.verify(&app)?;
    open_independent(&app)?;
    let started = Instant::now();
    while started.elapsed() < OPEN_DEADLINE {
        if !exact_running(&app).is_empty() { return Ok(OpenResult { verified: true }); }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(OpenResult { verified: false })
}

/// pgrep and open are other processes, so both commands leave the UI thread.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("AgentsToZ Screen 확인 실패: {e}"))?
}

#[tauri::command]
pub(crate) async fn get_screen_helper() -> Result<ScreenHelperStatus, String> { blocking(|| Ok(status())).await }

#[tauri::command]
pub(crate) async fn open_screen_helper() -> Result<OpenResult, String> { blocking(open).await }

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("atz-screen-install-{}", transaction_token().unwrap()));
            std::fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn app(&self, name: &str, hash: &str) -> PathBuf {
            let app = self.0.join(name);
            std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
            std::fs::write(app.join("Contents/MacOS").join(EXECUTABLE), hash).unwrap();
            std::fs::write(app.join("hash"), hash).unwrap();
            app
        }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[derive(Default)]
    struct FakeInstall {
        copied: Cell<usize>,
        stopped: Cell<usize>,
        reopened: Cell<usize>,
        is_running: bool,
        corrupt_copy: bool,
        copy_failure: bool,
        launch_failure: bool,
        backup_verification_failure: bool,
        seen: RefCell<Vec<PathBuf>>,
    }
    impl InstallActions for FakeInstall {
        fn verify(&self, app: &Path) -> Result<String, String> {
            self.seen.borrow_mut().push(app.to_path_buf());
            if self.backup_verification_failure && app.file_name().unwrap().to_string_lossy().starts_with(".AgentsToZ Screen-backup-") {
                return Err("backup signature unavailable".into());
            }
            let hash = std::fs::read_to_string(app.join("hash")).map_err(|error| error.to_string())?;
            if hash == "foreign-team" { return Err("wrong signing identity".into()); }
            Ok(hash)
        }
        fn copy(&self, source: &Path, destination: &Path) -> Result<(), String> {
            self.copied.set(self.copied.get() + 1);
            std::fs::create_dir_all(destination.join("Contents/MacOS")).unwrap();
            std::fs::copy(source.join("Contents/MacOS").join(EXECUTABLE), destination.join("Contents/MacOS").join(EXECUTABLE)).unwrap();
            let hash = if self.corrupt_copy { "different-source".into() } else { std::fs::read_to_string(source.join("hash")).unwrap() };
            std::fs::write(destination.join("hash"), hash).unwrap();
            if self.copy_failure { Err("copy failed after partial write".into()) } else { Ok(()) }
        }
        fn running(&self, _app: &Path) -> Vec<i32> { if self.is_running { vec![42] } else { vec![] } }
        fn stop(&self, _app: &Path, _pids: &[i32]) -> Result<(), String> { self.stopped.set(self.stopped.get() + 1); Ok(()) }
        fn reopen(&self, app: &Path) -> Result<(), String> {
            self.reopened.set(self.reopened.get() + 1);
            if self.launch_failure && std::fs::read_to_string(app.join("hash")).unwrap() == "new" { Err("new helper could not start".into()) }
            else { Ok(()) }
        }
    }

    #[test]
    fn installs_independent_signed_payload_without_launching_or_touching_pairing() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let applications = root.0.join("Applications");
        let destination = applications.join(APP_NAME);
        let state = root.0.join("pairing-sentinel");
        std::fs::write(&state, "keep private state").unwrap();
        let actions = FakeInstall::default();
        assert_eq!(install_payload(&source, &destination, &actions).unwrap(), destination);
        assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(state).unwrap(), "keep private state");
        assert_eq!(actions.reopened.get(), 0);
        assert_eq!(std::fs::read_dir(applications).unwrap().count(), 1);
    }

    #[test]
    fn identical_signed_helper_is_not_copied_stopped_or_reopened() {
        let root = Scratch::new();
        let source = root.app("source.app", "same");
        let destination = root.app(APP_NAME, "same");
        let actions = FakeInstall { is_running: true, ..Default::default() };
        install_payload(&source, &destination, &actions).unwrap();
        assert_eq!((actions.copied.get(), actions.stopped.get(), actions.reopened.get()), (0, 0, 0));
    }

    #[test]
    fn existing_foreign_identity_is_never_overwritten() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(APP_NAME, "foreign-team");
        let actions = FakeInstall::default();
        assert!(install_payload(&source, &destination, &actions).is_err());
        assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "foreign-team");
        assert_eq!(actions.copied.get(), 0);
    }

    #[test]
    fn partial_copy_or_changed_signature_keeps_the_old_app_and_removes_staging() {
        for corrupt_copy in [false, true] {
            let root = Scratch::new();
            let source = root.app("source.app", "new");
            let destination = root.app(APP_NAME, "old");
            let actions = FakeInstall { corrupt_copy, copy_failure: !corrupt_copy, is_running: true, ..Default::default() };
            assert!(install_payload(&source, &destination, &actions).is_err());
            assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "old");
            assert_eq!((actions.stopped.get(), actions.reopened.get()), (0, 0));
            assert!(!std::fs::read_dir(&root.0).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".AgentsToZ")));
        }
    }

    #[test]
    fn failed_running_helper_update_restores_and_reopens_the_old_app() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(APP_NAME, "old");
        let actions = FakeInstall { is_running: true, launch_failure: true, ..Default::default() };
        let error = install_payload(&source, &destination, &actions).unwrap_err();
        assert!(error.contains("복원"));
        assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "old");
        assert_eq!(actions.reopened.get(), 2);
        assert!(!std::fs::read_dir(&root.0).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".AgentsToZ")));
    }

    #[test]
    fn successful_update_cleans_only_its_own_verified_backup_after_reopening() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(APP_NAME, "old");
        let unrelated = root.app(".AgentsToZ Screen-backup-previous.app", "older");
        let actions = FakeInstall { is_running: true, ..Default::default() };
        install_payload(&source, &destination, &actions).unwrap();
        assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(unrelated.join("hash")).unwrap(), "older");
        assert_eq!(actions.reopened.get(), 1);
        assert_eq!(std::fs::read_dir(&root.0).unwrap().filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().starts_with(".AgentsToZ Screen-backup-")).count(), 1);
    }

    #[test]
    fn backup_cleanup_verification_failure_keeps_the_backup_and_successful_install() {
        let root = Scratch::new();
        let source = root.app("source.app", "new");
        let destination = root.app(APP_NAME, "old");
        let actions = FakeInstall { is_running: true, backup_verification_failure: true, ..Default::default() };
        assert!(install_payload(&source, &destination, &actions).is_ok());
        assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "new");
        let backup = std::fs::read_dir(&root.0).unwrap().find_map(|entry| {
            let entry = entry.unwrap();
            entry.file_name().to_string_lossy().starts_with(".AgentsToZ Screen-backup-").then(|| entry.path())
        }).unwrap();
        assert_eq!(std::fs::read_to_string(backup.join("hash")).unwrap(), "old");
        assert_eq!(actions.reopened.get(), 1);
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
                root.0.join("Applications").join(APP_NAME)
            } else {
                let destination = root.0.join(APP_NAME);
                symlink(&victim, &destination).unwrap();
                destination
            };
            let actions = FakeInstall::default();
            assert!(install_payload(&source, &destination, &actions).is_err());
            assert_eq!(std::fs::read_to_string(victim.join("hash")).unwrap(), "old");
            assert_eq!(actions.copied.get(), 0);
        }
    }

    #[test]
    fn installed_apps_are_not_replaced_by_an_unbundled_developer_executable() {
        assert_eq!(bundled_payload(Path::new("/usr/local/bin/AgentsToZScreen")), None);
        assert_eq!(bundled_payload(Path::new("/tmp/target/debug/app")), None);
    }

    #[test]
    fn activation_does_not_overwrite_a_path_that_appeared_after_staging() {
        let root = Scratch::new();
        let incoming = root.app("incoming.app", "new");
        let destination = root.app(APP_NAME, "other app");
        assert!(rename_new(&incoming, &destination).is_err());
        assert_eq!(std::fs::read_to_string(incoming.join("hash")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(destination.join("hash")).unwrap(), "other app");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn same_identifier_adhoc_signature_cannot_impersonate_the_developer_id_helper() {
        let root = Scratch::new();
        let app = root.app(APP_NAME, "fixture");
        std::fs::remove_file(app.join("hash")).unwrap();
        std::fs::copy("/usr/bin/true", app.join("Contents/MacOS").join(EXECUTABLE)).unwrap();
        std::fs::write(app.join("Contents/Info.plist"), format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{BUNDLE_ID}</string><key>CFBundleExecutable</key><string>{EXECUTABLE}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>")).unwrap();
        native_command(Command::new("/usr/bin/codesign").args(["--force", "--sign", "-", "--identifier", BUNDLE_ID]).arg(&app)).unwrap();
        native_command(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&app)).unwrap();
        assert!(NativeInstall.verify(&app).is_err());
    }

    /// Explicit local opt-in only: a signed build in the temporary directory, never an installed app or a launch.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires AGENTSTOZ_SCREEN_SIGNED_TEST_APP pointing to a temporary Developer ID signed payload"]
    fn signed_payload_installs_in_scratch_applications_and_identical_retry_is_a_noop() {
        use std::os::unix::fs::MetadataExt;
        let source = PathBuf::from(std::env::var_os("AGENTSTOZ_SCREEN_SIGNED_TEST_APP").expect("explicit signed fixture is required")).canonicalize().unwrap();
        assert!(source.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert_eq!(source.file_name().unwrap(), APP_NAME);
        let root = Scratch::new();
        let applications = root.0.join("Applications");
        let destination = applications.join(APP_NAME);
        assert!(NativeInstall.running(&destination).is_empty());
        install_payload(&source, &destination, &NativeInstall).unwrap();
        assert_eq!(NativeInstall.verify(&destination).unwrap(), NativeInstall.verify(&source).unwrap());
        let executable = destination.join("Contents/MacOS").join(EXECUTABLE);
        let before = std::fs::metadata(&executable).unwrap();
        install_payload(&source, &destination, &NativeInstall).unwrap();
        let after = std::fs::metadata(executable).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(std::fs::read_dir(applications).unwrap().count(), 1);
        assert!(NativeInstall.running(&destination).is_empty());
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
