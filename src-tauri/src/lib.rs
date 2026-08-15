use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use tauri::{State, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PortInfo {
    id: String,
    name: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(rename = "commandPath")]
    command_path: Option<String>,
    #[serde(rename = "folderPath")]
    folder_path: Option<String>,
    #[serde(rename = "deployUrl")]
    deploy_url: Option<String>,
    #[serde(rename = "githubUrl")]
    github_url: Option<String>,
    // Keep the legacy primary githubUrl above while preserving every repository
    // URL that the frontend stores in githubUrls during a save_ports round-trip.
    #[serde(rename = "githubUrls", default, skip_serializing_if = "Option::is_none")]
    github_urls: Option<Vec<String>>,
    #[serde(rename = "worktreePath", default)]
    worktree_path: Option<String>,
    #[serde(rename = "manualPath", default, skip_serializing_if = "Option::is_none")]
    manual_path: Option<String>,
    #[serde(rename = "logFilePath", default, skip_serializing_if = "Option::is_none")]
    log_file_path: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "aiName", default, skip_serializing_if = "Option::is_none")]
    ai_name: Option<String>,
    #[serde(rename = "isRunning", default)]
    is_running: bool,
    #[serde(default)]
    favorite: bool,
    #[serde(rename = "terminalCommand", default, skip_serializing_if = "Option::is_none")]
    terminal_command: Option<String>,
    #[serde(rename = "sourceDeviceId", default, skip_serializing_if = "Option::is_none")]
    source_device_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ManagedProcess {
    pid: u32,
    generation: u64,
    leader_exited: bool,
    terminating: bool,
}

static NEXT_MANAGED_PROCESS_GENERATION: AtomicU64 = AtomicU64::new(1);

struct AppState {
    processes: Arc<Mutex<HashMap<String, ManagedProcess>>>,
    launching: Mutex<HashSet<String>>,
    api_sidecar: Mutex<Option<Child>>,
    api_supervisor_stop: Arc<AtomicBool>,
}

struct PortLaunchClaim<'a> {
    launching: &'a Mutex<HashSet<String>>,
    port_id: String,
}

impl Drop for PortLaunchClaim<'_> {
    fn drop(&mut self) {
        let mut launching = self.launching.lock().unwrap_or_else(|error| error.into_inner());
        launching.remove(&self.port_id);
    }
}

fn claim_port_launch<'a>(
    launching: &'a Mutex<HashSet<String>>,
    port_id: &str,
) -> Result<PortLaunchClaim<'a>, String> {
    let mut claims = launching.lock().unwrap_or_else(|error| error.into_inner());
    if !claims.insert(port_id.to_string()) {
        return Err("이 프로젝트의 실행, 중지 또는 재실행이 이미 진행 중입니다.".to_string());
    }
    drop(claims);
    Ok(PortLaunchClaim { launching, port_id: port_id.to_string() })
}

fn reject_live_tracked_process<F, G>(
    processes: &mut HashMap<String, ManagedProcess>,
    port_id: &str,
    mut leader_pid_exists: F,
    mut process_group_exists: G,
) -> Result<(), String>
where
    F: FnMut(u32) -> bool,
    G: FnMut(u32) -> bool,
{
    let Some(tracked) = processes.get(port_id).copied() else {
        return Ok(());
    };
    if !tracked.leader_exited {
        return Err(format!(
            "이미 실행 중인 tracked process가 있습니다 (PID {}). 먼저 중지하거나 강제 재실행하세요.",
            tracked.pid
        ));
    }

    // Once wait()/try_wait() has observed the original leader's exit, a live
    // process at the same PID is necessarily a reused, foreign process. Never
    // retain it as ownership or send a tree/group kill to it.
    if leader_pid_exists(tracked.pid) {
        processes.remove(port_id);
        return Ok(());
    }
    if process_group_exists(tracked.pid) {
        return Err(format!(
            "tracked leader는 종료됐지만 managed process group이 아직 실행 중입니다 (PGID {}). 먼저 중지하세요.",
            tracked.pid
        ));
    }
    processes.remove(port_id);
    Ok(())
}

#[cfg(target_os = "windows")]
fn tracked_pid_alive(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    let expected = pid.to_string();
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut columns = line.trim().trim_matches('"').split("\",\"");
        let _image_name = columns.next();
        columns.next() == Some(expected.as_str())
    })
}

#[cfg(not(target_os = "windows"))]
fn tracked_pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return true; };
    if pid <= 1 { return true; }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserProfile {
    id: String,
    browser_id: String,
    browser_name: String,
    profile_directory: String,
    profile_name: String,
    account_label: Option<String>,
}

const LOCAL_API_ADDR: &str = "127.0.0.1:3001";
const LOCAL_API_CONTRACT_JSON: &str = include_str!("../../context-api-contract.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalApiHealth {
    Compatible,
    Incompatible,
    Foreign,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalApiSupervisorDecision {
    Adopt,
    WaitForOwnedChild,
    Blocked,
    Spawn,
}

fn classify_local_api_health(response: Option<&str>) -> LocalApiHealth {
    let Some(response) = response else {
        return LocalApiHealth::Unavailable;
    };
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return LocalApiHealth::Foreign;
    };
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok());
    let Ok(health) = serde_json::from_str::<serde_json::Value>(body) else {
        return LocalApiHealth::Foreign;
    };
    if health.get("service").and_then(|value| value.as_str()) != Some("agentstoz-api") {
        return LocalApiHealth::Foreign;
    }
    if !matches!(status, Some(200..=299)) {
        return LocalApiHealth::Incompatible;
    }
    let Ok(contract) = serde_json::from_str::<serde_json::Value>(LOCAL_API_CONTRACT_JSON) else {
        return LocalApiHealth::Incompatible;
    };
    let Some(required_schema) = contract.get("schemaVersion").and_then(|value| value.as_u64()) else {
        return LocalApiHealth::Incompatible;
    };
    let Some(detected_schema) = health.get("schemaVersion").and_then(|value| value.as_u64()) else {
        return LocalApiHealth::Incompatible;
    };
    if detected_schema < required_schema {
        return LocalApiHealth::Incompatible;
    }
    let Some(capabilities) = health.get("capabilities").and_then(|value| value.as_array()) else {
        return LocalApiHealth::Incompatible;
    };
    let has_capability = |required: &str| {
        capabilities.iter().any(|value| value.as_str() == Some(required))
    };
    let all_required = contract
        .get("requiredCapabilities")
        .and_then(|value| value.as_array())
        .map(|required| {
            required.iter().all(|value| {
                value.as_str().map(&has_capability).unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let windows_supervisor_compatible = !cfg!(target_os = "windows")
        || has_capability("process.windows-job-supervisor");
    if all_required && windows_supervisor_compatible {
        LocalApiHealth::Compatible
    } else {
        LocalApiHealth::Incompatible
    }
}

fn local_api_supervisor_decision(
    health: LocalApiHealth,
    owned_child_running: bool,
    port_open: bool,
) -> LocalApiSupervisorDecision {
    match health {
        LocalApiHealth::Compatible => LocalApiSupervisorDecision::Adopt,
        LocalApiHealth::Incompatible | LocalApiHealth::Foreign => LocalApiSupervisorDecision::Blocked,
        LocalApiHealth::Unavailable if owned_child_running => LocalApiSupervisorDecision::WaitForOwnedChild,
        LocalApiHealth::Unavailable if port_open => LocalApiSupervisorDecision::Blocked,
        LocalApiHealth::Unavailable => LocalApiSupervisorDecision::Spawn,
    }
}

/// Reads the complete health response. Classification is kept pure so adoption
/// and occupied-port behavior can be verified without binding a real port.
fn local_api_health_response() -> Option<String> {
    let addr: SocketAddr = match LOCAL_API_ADDR.parse() {
        Ok(addr) => addr,
        Err(_) => return None,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(180)) {
        Ok(stream) => stream,
        Err(_) => return None,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(350)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:3001\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return None;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() && response.is_empty() {
        return None;
    }
    Some(response)
}

fn local_api_port_open() -> bool {
    let addr: SocketAddr = match LOCAL_API_ADDR.parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok()
}

fn local_api_post_json(path: &str, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let addr: SocketAddr = LOCAL_API_ADDR.parse().map_err(|e| format!("로컬 API 주소 오류: {}", e))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("AgentsToZ 로컬 API 연결 실패: {}", e))?;
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(35))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path,
        LOCAL_API_ADDR,
        body.len(),
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(&body).map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).map_err(|e| e.to_string())?;
    let split = response.windows(4).position(|part| part == b"\r\n\r\n")
        .ok_or_else(|| "AgentsToZ 로컬 API 응답 형식이 올바르지 않습니다.".to_string())?;
    let head = String::from_utf8_lossy(&response[..split]);
    let status = head.lines().next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "AgentsToZ 로컬 API 상태 코드를 읽지 못했습니다.".to_string())?;
    let parsed: serde_json::Value = serde_json::from_slice(&response[split + 4..])
        .map_err(|e| format!("AgentsToZ 로컬 API JSON 오류: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(parsed.get("error").and_then(|value| value.as_str())
            .unwrap_or("AgentsToZ 로컬 API 요청 실패").to_string());
    }
    Ok(parsed)
}

fn bundled_api_sidecar_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app_handle.path().resource_dir().map_err(|e| e.to_string())?;
    let filename = if cfg!(target_os = "windows") {
        "agentstoz-api-sidecar.exe"
    } else {
        "agentstoz-api-sidecar"
    };
    let candidates = [
        resource_dir.join("resources").join(filename),
        resource_dir.join(filename),
    ];
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("번들된 로컬 API를 찾을 수 없습니다: {}", filename))
}

fn spawn_bundled_api_sidecar(app_handle: &tauri::AppHandle) -> Result<Child, String> {
    let executable = bundled_api_sidecar_path(app_handle)?;
    let app_data_dir = ensure_app_data_dir(app_handle)?;
    let logs_dir = app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    let log_path = logs_dir.join("api-sidecar.log");
    truncate_log_if_oversized(&log_path);
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;

    let mut command = Command::new(&executable);
    command
        .env("API_PORT", "3001")
        .env("APP_DATA_DIR", &app_data_dir)
        .env("PORTMGR_PARENT_PID", std::process::id().to_string())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(not(target_os = "windows"))]
    command.env("PATH", build_path_env());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    command.spawn().map_err(|e| {
        format!(
            "번들된 로컬 API 실행 실패 ({}): {}",
            executable.display(),
            e
        )
    })
}

fn maintain_local_api_sidecar(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    let health_response = local_api_health_response();
    let health = classify_local_api_health(health_response.as_deref());
    let owned_child_running = {
        let mut child_guard = state.api_sidecar.lock().unwrap_or_else(|e| e.into_inner());
        let running = if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) | Err(_) => false,
            }
        } else {
            false
        };
        if !running {
            *child_guard = None;
        }
        running
    };

    let port_open = !matches!(health, LocalApiHealth::Unavailable) || local_api_port_open();
    match local_api_supervisor_decision(health, owned_child_running, port_open) {
        LocalApiSupervisorDecision::Adopt => return,
        LocalApiSupervisorDecision::WaitForOwnedChild => return,
        LocalApiSupervisorDecision::Blocked => {
            let reason = match health {
                LocalApiHealth::Incompatible => "an incompatible AgentsToZ API",
                LocalApiHealth::Foreign => "a foreign service",
                LocalApiHealth::Unavailable => "an unresponsive service",
                LocalApiHealth::Compatible => "a compatible AgentsToZ API",
            };
            eprintln!("[API sidecar] port 3001 is occupied by {}; leaving it untouched", reason);
            return;
        }
        LocalApiSupervisorDecision::Spawn => {}
    }

    match spawn_bundled_api_sidecar(app_handle) {
        Ok(child) => {
            println!("[API sidecar] started pid={}", child.id());
            let mut child_guard = state.api_sidecar.lock().unwrap_or_else(|e| e.into_inner());
            *child_guard = Some(child);
        }
        Err(error) => eprintln!("[API sidecar] {}", error),
    }
}

fn start_local_api_supervisor(app_handle: tauri::AppHandle) {
    maintain_local_api_sidecar(&app_handle);
    let stop = app_handle.state::<AppState>().api_supervisor_stop.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            for _ in 0..10 {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            maintain_local_api_sidecar(&app_handle);
        }
    });
}

fn shutdown_local_api_sidecar(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    state.api_supervisor_stop.store(true, Ordering::Relaxed);
    let mut child_guard = state.api_sidecar.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

struct SpawnArgs<'a> {
    port_id: &'a str,
    command_path: &'a str,
    is_file_path: bool,
    folder_path: Option<&'a str>,
    log_file: &'a std::path::Path,
    port: Option<u16>,
    #[cfg(target_os = "windows")]
    supervisor_script: Option<&'a std::path::Path>,
}

fn normalized_spawn_port(port: Option<u16>) -> Option<u16> {
    port.filter(|value| *value > 0)
}

fn spawn_port_env(port: Option<u16>) -> Vec<(&'static str, String)> {
    let Some(port) = normalized_spawn_port(port) else {
        return Vec::new();
    };
    let mut env = vec![("PORT", port.to_string())];
    if port < u16::MAX {
        env.push(("API_PORT", (port as u32 + 1).to_string()));
    }
    env
}

fn apply_spawn_port_env(command: &mut Command, port: Option<u16>) {
    for (key, value) in spawn_port_env(port) {
        command.env(key, value);
    }
}

fn build_path_env() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let additions = [
            format!("{}\\.bun\\bin", userprofile),
            format!("{}\\.cargo\\bin", userprofile),
            format!("{}\\npm", appdata),
        ];
        let sep = ";";
        if existing.is_empty() {
            additions.join(sep)
        } else {
            format!("{}{}{}", additions.join(sep), sep, existing)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let additions = [
            format!("{}/.cargo/bin", home),
            format!("{}/.bun/bin", home),
            format!("{}/.local/bin", home),
            format!("{}/bin", home),
            "/usr/local/bin".to_string(),
            "/usr/bin".to_string(),
            "/bin".to_string(),
            "/usr/sbin".to_string(),
            "/sbin".to_string(),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/go/bin".to_string(),
        ];
        if existing.is_empty() {
            additions.join(":")
        } else {
            format!("{}:{}", additions.join(":"), existing)
        }
    }
}

/// 로그 파일 읽기(read_log_content) 시 한 번에 반환하는 최대 바이트 수.
const MAX_TAIL_BYTES: u64 = 256 * 1024;
/// 로그 파일이 이 크기를 넘으면 spawn 전에 잘라낸다 (무한 디스크 증가 방지).
const LOG_TRUNCATE_THRESHOLD: u64 = 10 * 1024 * 1024;
/// 잘라낼 때 보존하는 마지막 바이트 수 (대략 최근 1MB).
const LOG_KEEP_BYTES: u64 = 1024 * 1024;

/// 로그 파일이 LOG_TRUNCATE_THRESHOLD를 초과하면 마지막 LOG_KEEP_BYTES만 남기고 재작성.
/// 실패해도 spawn을 막지 않도록 조용히 무시한다.
fn truncate_log_if_oversized(log_file: &std::path::Path) {
    use std::io::{Read, Seek, SeekFrom};
    let size = match fs::metadata(log_file) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if size <= LOG_TRUNCATE_THRESHOLD {
        return;
    }
    let mut file = match fs::File::open(log_file) {
        Ok(f) => f,
        Err(_) => return,
    };
    if file.seek(SeekFrom::Start(size.saturating_sub(LOG_KEEP_BYTES))).is_err() {
        return;
    }
    let mut tail = Vec::with_capacity(LOG_KEEP_BYTES as usize);
    if file.read_to_end(&mut tail).is_err() {
        return;
    }
    drop(file);
    let _ = fs::write(log_file, &tail);
}

/// fire-and-forget 자식 프로세스의 PID를 가져온 뒤, 분리된 스레드에서 wait()로 reap한다.
/// (Child를 wait 없이 drop하면 앱 수명 동안 좀비 프로세스가 누적됨)
fn reap_detached(mut child: std::process::Child) -> u32 {
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    pid
}

fn register_managed_process(
    processes: &Arc<Mutex<HashMap<String, ManagedProcess>>>,
    port_id: &str,
    mut child: Child,
) -> Result<u32, String> {
    let pid = child.id();
    let generation = NEXT_MANAGED_PROCESS_GENERATION.fetch_add(1, Ordering::Relaxed);
    {
        let mut tracked = processes.lock().unwrap_or_else(|error| error.into_inner());
        if tracked.contains_key(port_id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("tracked process ownership이 이미 있어 새 프로세스를 등록하지 않았습니다.".into());
        }
        tracked.insert(
            port_id.to_string(),
            ManagedProcess { pid, generation, leader_exited: false, terminating: false },
        );
    }

    let tracked_processes = Arc::clone(processes);
    let tracked_port_id = port_id.to_string();
    std::thread::spawn(move || loop {
        // Keep the ownership mutex through try_wait(). A stop/restart claim can
        // therefore never mark `terminating` in the gap after this reaper has
        // decided it may reap but before the child PID becomes reusable.
        let mut tracked = tracked_processes.lock().unwrap_or_else(|error| error.into_inner());
        let Some(record) = tracked.get(&tracked_port_id).copied() else {
            drop(tracked);
            let _ = child.wait();
            return;
        };
        if record.generation != generation {
            drop(tracked);
            let _ = child.wait();
            return;
        }
        if record.terminating {
            drop(tracked);
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }

        match child.try_wait() {
            Ok(None) => {
                drop(tracked);
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                drop(tracked);
                eprintln!("[ManagedProcess] PID {} wait 검사 실패: {}", pid, error);
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(Some(_status)) => {
                let Some(record) = tracked.get_mut(&tracked_port_id) else { return; };
                if record.generation != generation { return; }
                record.leader_exited = true;
                drop(tracked);

                loop {
                    let mut tracked = tracked_processes.lock().unwrap_or_else(|error| error.into_inner());
                    let Some(record) = tracked.get(&tracked_port_id).copied() else { return; };
                    if record.generation != generation { return; }
                    if record.terminating {
                        drop(tracked);
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }

                    #[cfg(target_os = "windows")]
                    let ownership_finished = true;
                    #[cfg(not(target_os = "windows"))]
                    let ownership_finished = tracked_pid_alive(pid) || !managed_process_group_alive(pid);

                    if ownership_finished {
                        tracked.remove(&tracked_port_id);
                        return;
                    }
                    drop(tracked);
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });
    Ok(pid)
}

fn mark_managed_process_terminating(
    processes: &mut HashMap<String, ManagedProcess>,
    port_id: &str,
) -> Option<ManagedProcess> {
    let record = processes.get(port_id).copied()?;
    let stale = if record.leader_exited {
        #[cfg(target_os = "windows")]
        { true }
        #[cfg(not(target_os = "windows"))]
        { tracked_pid_alive(record.pid) || !managed_process_group_alive(record.pid) }
    } else {
        false
    };
    if stale {
        processes.remove(port_id);
        return None;
    }
    if let Some(record) = processes.get_mut(port_id) {
        record.terminating = true;
        return Some(*record);
    }
    None
}

fn restore_managed_process_after_failed_termination(
    processes: &mut HashMap<String, ManagedProcess>,
    port_id: &str,
    expected: ManagedProcess,
) {
    if let Some(record) = processes.get_mut(port_id) {
        if record.generation == expected.generation {
            record.terminating = false;
        }
    }
}

fn remove_matching_managed_process(
    processes: &mut HashMap<String, ManagedProcess>,
    port_id: &str,
    expected: ManagedProcess,
) {
    if processes.get(port_id).map(|record| record.generation) == Some(expected.generation) {
        processes.remove(port_id);
    }
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
struct WindowsCommandPlan {
    program: String,
    args: Vec<String>,
    command_file: Option<String>,
    work_dir: Option<String>,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
struct WindowsSupervisorPlan {
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
}

#[cfg(any(target_os = "windows", test))]
fn windows_supervisor_plan(
    supervisor_script: &str,
    child_program: &str,
    child_args: &[String],
) -> WindowsSupervisorPlan {
    let mut env = HashMap::new();
    env.insert("AGENTSTOZ_SUPERVISOR_PROGRAM".to_string(), child_program.to_string());
    env.insert(
        "AGENTSTOZ_SUPERVISOR_ARGS_JSON".to_string(),
        serde_json::to_string(child_args).expect("Windows child argv must serialize"),
    );
    env.insert("AGENTSTOZ_SUPERVISOR_CWD".to_string(), String::new());
    WindowsSupervisorPlan {
        program: "powershell.exe".to_string(),
        args: vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-WindowStyle".to_string(),
            "Hidden".to_string(),
            "-File".to_string(),
            supervisor_script.to_string(),
        ],
        env,
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_command_plan(
    command_path: &str,
    is_file_path: bool,
    folder_path: Option<&str>,
) -> WindowsCommandPlan {
    if is_file_path {
        let is_powershell_script = std::path::Path::new(command_path)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ps1"));
        let mut powershell_args = [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        if is_powershell_script {
            powershell_args.extend(["-File".to_string(), command_path.to_string()]);
        } else {
            // cmd.exe has a special /C quote parser that conflicts with the Job
            // supervisor's normal Windows argv encoding. PowerShell invokes .cmd
            // and .bat files without reparsing percent signs in their path.
            powershell_args.extend([
                "-Command".to_string(),
                "Start-Process -FilePath $env:AGENTSTOZ_COMMAND_FILE -Wait -NoNewWindow".to_string(),
            ]);
        }
        return WindowsCommandPlan {
            program: "powershell.exe".to_string(),
            args: powershell_args,
            command_file: (!is_powershell_script).then(|| command_path.to_string()),
            work_dir: None,
        };
    }
    let work_dir = folder_path.map(str::trim).filter(|path| !path.is_empty());
    WindowsCommandPlan {
        program: "cmd.exe".to_string(),
        args: vec![
            "/D".to_string(),
            "/S".to_string(),
            "/C".to_string(),
            work_dir
                .map(|_| format!("pushd \"%AGENTSTOZ_WORK_DIR%\" && {}", command_path))
                .unwrap_or_else(|| command_path.to_string()),
        ],
        command_file: None,
        work_dir: work_dir.map(str::to_string),
    }
}

#[cfg(target_os = "windows")]
fn windows_process_supervisor_script(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(configured) = std::env::var("AGENTSTOZ_PROCESS_SUPERVISOR") {
        if !configured.trim().is_empty() { candidates.push(std::path::PathBuf::from(configured)); }
    }
    candidates.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/windows-process-supervisor.ps1"));
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir.join("windows-process-supervisor.ps1"));
        candidates.push(resource_dir.join("resources/windows-process-supervisor.ps1"));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("windows-process-supervisor.ps1"));
            candidates.push(parent.join("resources/windows-process-supervisor.ps1"));
            if let Some(grandparent) = parent.parent() {
                candidates.push(grandparent.join("Resources/windows-process-supervisor.ps1"));
            }
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file()).ok_or_else(|| {
        "Windows process supervisor resource를 찾을 수 없습니다. 앱을 다시 빌드하세요.".to_string()
    })
}

#[cfg(target_os = "windows")]
fn spawn_process(args: SpawnArgs) -> Result<Child, String> {
    use std::os::windows::process::CommandExt;

    let new_path = build_path_env();
    truncate_log_if_oversized(args.log_file);
    let log_out = fs::OpenOptions::new()
        .create(true).append(true).open(args.log_file)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_err = fs::OpenOptions::new()
        .create(true).append(true).open(args.log_file)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    let plan = windows_command_plan(args.command_path, args.is_file_path, args.folder_path);
    let supervisor_script = args.supervisor_script.ok_or_else(|| {
        "Windows process supervisor resource path가 전달되지 않았습니다.".to_string()
    })?;
    let supervisor = windows_supervisor_plan(
        &supervisor_script.to_string_lossy(),
        &plan.program,
        &plan.args,
    );
    let mut cmd = Command::new(&supervisor.program);
    cmd.args(&supervisor.args).envs(&supervisor.env);
    if let Some(command_file) = plan.command_file { cmd.env("AGENTSTOZ_COMMAND_FILE", command_file); }
    if let Some(work_dir) = plan.work_dir { cmd.env("AGENTSTOZ_WORK_DIR", work_dir); }
    cmd.stdout(log_out)
        .stderr(log_err)
        .env("PATH", &new_path)
        .creation_flags(0x08000000); // CREATE_NO_WINDOW

    apply_spawn_port_env(&mut cmd, args.port);

    let child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;
    println!("[spawn_process] port={} pid={} cmd={}", args.port_id, child.id(), args.command_path);
    Ok(child)
}

#[cfg(not(target_os = "windows"))]
fn spawn_process(args: SpawnArgs) -> Result<Child, String> {
    let new_path = build_path_env();
    let home = std::env::var("HOME").unwrap_or_default();

    if args.is_file_path {
        let _ = Command::new("chmod").arg("+x").arg(args.command_path).output();
    }

    truncate_log_if_oversized(args.log_file);

    let log_out = fs::OpenOptions::new()
        .create(true).append(true).open(args.log_file)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    let log_err = fs::OpenOptions::new()
        .create(true).append(true).open(args.log_file)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    let mut cmd = if args.is_file_path {
        let mut c = Command::new("bash");
        c.arg(args.command_path);
        c
    } else {
        let mut c = Command::new("bash");
        c.arg("-c").arg(args.command_path);
        if let Some(fp) = args.folder_path {
            if !fp.is_empty() { c.current_dir(fp); }
        }
        c
    };
    cmd.stdout(log_out).stderr(log_err)
        .env("PATH", &new_path)
        .env("HOME", &home);

    apply_spawn_port_env(&mut cmd, args.port);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;
    println!("[spawn_process] port={} pid={} cmd={}", args.port_id, child.id(), args.command_path);
    Ok(child)
}

/// Keep the established macOS data location stable even though the bundle ID is
/// unique to AgentsToZ. Linux follows XDG so the Tauri process and API sidecar
/// cannot silently split ports/settings across two different directories.
fn legacy_app_data_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    let data_dir = {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "HOME을 찾지 못해 앱 데이터 폴더를 열 수 없습니다.".to_string())?;
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.portmanager.portmanager")
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let data_dir = {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "HOME을 찾지 못해 앱 데이터 폴더를 열 수 없습니다.".to_string())?;
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(home).join(".config"));
        base.join("com.portmanager.portmanager")
    };

    #[cfg(target_os = "windows")]
    let data_dir = {
        let base = std::env::var_os("APPDATA")
            .or_else(|| std::env::var_os("USERPROFILE").map(|home| std::path::PathBuf::from(home).join("AppData").join("Roaming").into_os_string()))
            .ok_or_else(|| "APPDATA를 찾지 못해 앱 데이터 폴더를 열 수 없습니다.".to_string())?;
        std::path::PathBuf::from(base).join("com.portmanager.portmanager")
    };

    Ok(data_dir)
}

fn ensure_app_data_dir(_app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = legacy_app_data_dir()?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create app data directory: {}", e))?;

    Ok(data_dir)
}

#[tauri::command]
fn load_ports(app_handle: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;

    let ports_file = app_data_dir.join("ports.json");

    if ports_file.exists() {
        let content = fs::read_to_string(&ports_file)
            .map_err(|e| e.to_string())?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| e.to_string())?;
        if let Some(ports) = payload.as_array() {
            return Ok(ports.clone());
        }
        if let Some(ports) = payload.get("ports").and_then(|value| value.as_array()) {
            eprintln!("[LoadPorts] Recovering ports array from a wrapped save payload");
            return Ok(ports.clone());
        }
        return Err("ports.json 형식이 배열이 아닙니다.".into());
    }

    Ok(Vec::new())
}

struct PortsFileLock {
    path: std::path::PathBuf,
}

impl Drop for PortsFileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_ports_file_lock(lock_path: &std::path::Path) -> Result<PortsFileLock, String> {
    for _ in 0..150 {
        match fs::OpenOptions::new().write(true).create_new(true).open(lock_path) {
            Ok(_) => return Ok(PortsFileLock { path: lock_path.to_path_buf() }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(lock_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|time| time.elapsed().ok())
                    .map(|elapsed| elapsed > Duration::from_secs(15))
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(lock_path);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(format!("ports.json 잠금 생성 실패: {}", error)),
        }
    }
    Err("ports.json 저장 잠금을 3초 안에 획득하지 못했습니다.".into())
}

fn port_id(value: &serde_json::Value) -> Option<&str> {
    value.get("id").and_then(|id| id.as_str())
}

fn record_changed_from_base(base: &serde_json::Value, desired: &serde_json::Value) -> bool {
    let Some(base_object) = base.as_object() else { return base != desired; };
    let Some(desired_object) = desired.as_object() else { return base != desired; };
    let keys: HashSet<&String> = base_object.keys().chain(desired_object.keys()).collect();
    keys.into_iter().any(|key| {
        key != "id" && base_object.get(key) != desired_object.get(key)
    })
}

fn merge_record_fields(
    base: &serde_json::Value,
    desired: &serde_json::Value,
    current: &serde_json::Value,
) -> serde_json::Value {
    let Some(base_object) = base.as_object() else { return desired.clone(); };
    let Some(desired_object) = desired.as_object() else { return desired.clone(); };
    let Some(current_object) = current.as_object() else { return desired.clone(); };
    let mut merged = current_object.clone();
    let keys: HashSet<&String> = base_object.keys().chain(desired_object.keys()).collect();
    for key in keys {
        if key == "id" || base_object.get(key) == desired_object.get(key) {
            continue;
        }
        match desired_object.get(key) {
            Some(value) => { merged.insert(key.clone(), value.clone()); }
            None => { merged.remove(key); }
        }
    }
    serde_json::Value::Object(merged)
}

fn merge_port_snapshots(
    base: &[serde_json::Value],
    desired: &[serde_json::Value],
    current: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let base_by_id: HashMap<&str, &serde_json::Value> =
        base.iter().filter_map(|value| port_id(value).map(|id| (id, value))).collect();
    let desired_by_id: HashMap<&str, &serde_json::Value> =
        desired.iter().filter_map(|value| port_id(value).map(|id| (id, value))).collect();
    let current_by_id: HashMap<&str, &serde_json::Value> =
        current.iter().filter_map(|value| port_id(value).map(|id| (id, value))).collect();
    let deleted_ids: HashSet<&str> = base_by_id.keys()
        .copied()
        .filter(|id| !desired_by_id.contains_key(id))
        .collect();
    let mut merged_by_id: HashMap<String, serde_json::Value> = HashMap::new();

    for value in current {
        if let Some(id) = port_id(value) {
            if !deleted_ids.contains(id) {
                merged_by_id.insert(id.to_string(), value.clone());
            }
        }
    }

    for desired_value in desired {
        let Some(id) = port_id(desired_value) else { continue; };
        match (base_by_id.get(id), current_by_id.get(id)) {
            (None, _) => { merged_by_id.insert(id.to_string(), desired_value.clone()); }
            (Some(base_value), None) => {
                if record_changed_from_base(base_value, desired_value) {
                    merged_by_id.insert(id.to_string(), desired_value.clone());
                }
            }
            (Some(base_value), Some(current_value)) => {
                merged_by_id.insert(
                    id.to_string(),
                    merge_record_fields(base_value, desired_value, current_value),
                );
            }
        }
    }

    let mut order: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add_id = |id: &str| {
        if merged_by_id.contains_key(id) && seen.insert(id.to_string()) {
            order.push(id.to_string());
        }
    };
    for value in desired {
        if let Some(id) = port_id(value) {
            if !base_by_id.contains_key(id) { add_id(id); }
        }
    }
    for value in current {
        if let Some(id) = port_id(value) {
            if !base_by_id.contains_key(id) && !desired_by_id.contains_key(id) { add_id(id); }
        }
    }
    for value in desired {
        if let Some(id) = port_id(value) {
            if base_by_id.contains_key(id) { add_id(id); }
        }
    }
    for value in current {
        if let Some(id) = port_id(value) { add_id(id); }
    }
    order.into_iter().filter_map(|id| merged_by_id.remove(&id)).collect()
}

fn merge_legacy_port_save(
    desired: &[serde_json::Value],
    current: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let desired_ids: HashSet<&str> = desired.iter().filter_map(port_id).collect();
    desired.iter().cloned()
        .chain(current.iter().filter(|value| {
            port_id(value).map(|id| !desired_ids.contains(id)).unwrap_or(false)
        }).cloned())
        .collect()
}

fn read_ports_json(path: &std::path::Path) -> Result<Vec<serde_json::Value>, String> {
    if !path.exists() { return Ok(Vec::new()); }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let payload: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| error.to_string())?;
    if let Some(ports) = payload.as_array() {
        return Ok(ports.clone());
    }
    if let Some(ports) = payload.get("ports").and_then(|value| value.as_array()) {
        return Ok(ports.clone());
    }
    Err("ports.json 형식이 배열이 아닙니다.".into())
}

fn write_ports_atomically(
    app_data_dir: &std::path::Path,
    ports: &[serde_json::Value],
    source: &str,
) -> Result<(), String> {
    let ports_file = app_data_dir.join("ports.json");
    let backup_file = app_data_dir.join("ports.json.bak");
    let temporary_file = app_data_dir.join(format!(
        "ports.json.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    ));
    if ports_file.exists() {
        fs::copy(&ports_file, &backup_file).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(ports).map_err(|error| error.to_string())?;
    fs::write(&temporary_file, content).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    if ports_file.exists() {
        fs::remove_file(&ports_file).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary_file, &ports_file).map_err(|error| {
        let _ = fs::remove_file(&temporary_file);
        error.to_string()
    })?;
    let audit_file = app_data_dir.join("ports-save-audit.jsonl");
    let audit = serde_json::json!({
        "atUnixMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        "pid": std::process::id(),
        "source": source,
        "savedCount": ports.len(),
    });
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(audit_file) {
        let _ = writeln!(file, "{}", audit);
    }
    Ok(())
}

#[tauri::command]
fn save_ports(app_handle: tauri::AppHandle, ports: Vec<serde_json::Value>) -> Result<(), String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let ports_file = app_data_dir.join("ports.json");
    let _lock = acquire_ports_file_lock(&app_data_dir.join("ports.json.lock"))?;
    let current = read_ports_json(&ports_file)?;
    let merged = merge_legacy_port_save(&ports, &current);
    write_ports_atomically(&app_data_dir, &merged, "legacy-tauri")?;
    Ok(())
}

#[tauri::command]
fn save_ports_merged(
    app_handle: tauri::AppHandle,
    ports: Vec<serde_json::Value>,
    base_ports: Vec<serde_json::Value>,
    source: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let ports_file = app_data_dir.join("ports.json");
    let _lock = acquire_ports_file_lock(&app_data_dir.join("ports.json.lock"))?;
    let current = read_ports_json(&ports_file)?;
    let merged = merge_port_snapshots(&base_ports, &ports, &current);
    write_ports_atomically(
        &app_data_dir,
        &merged,
        source.as_deref().unwrap_or("three-way-tauri"),
    )?;
    Ok(merged)
}

// 웹(api-server.ts)과 동일한 last-visits.json 파일을 공유 — 앱/웹 어느 쪽에서 실행해도 같이 반영됨
#[tauri::command]
fn load_last_visits(app_handle: tauri::AppHandle) -> Result<HashMap<String, i64>, String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let file = app_data_dir.join("last-visits.json");

    if file.exists() {
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let data: HashMap<String, i64> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        return Ok(data);
    }

    Ok(HashMap::new())
}

#[tauri::command]
fn save_last_visit(app_handle: tauri::AppHandle, port_id: String, timestamp: i64) -> Result<HashMap<String, i64>, String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let file = app_data_dir.join("last-visits.json");

    let mut data: HashMap<String, i64> = if file.exists() {
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        HashMap::new()
    };

    // 더 최신 값만 반영 — 동시 기록 시 과거 값으로 덮어쓰지 않음
    let is_newer = data.get(&port_id).map_or(true, |&existing| timestamp > existing);
    if is_newer {
        data.insert(port_id, timestamp);
        let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        fs::write(&file, content).map_err(|e| e.to_string())?;
    }

    Ok(data)
}

#[tauri::command]
fn scan_command_files(folder_path: String) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Ok(vec![]);
    }
    let exec_exts = [".command", ".bat", ".cmd", ".ps1", ".sh", ".html"];
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    let files: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let lower = name.to_string_lossy().to_lowercase();
            exec_exts.iter().any(|ext| lower.ends_with(ext))
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    Ok(files)
}

#[tauri::command]
fn open_app_data_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(app_data_dir.to_str().unwrap_or(""))
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    std::process::Command::new("open")
        .arg(&app_data_dir)
        .spawn()
        .map(reap_detached)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_portal(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let file = app_data_dir.join("portal.json");
    if file.exists() {
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        return Ok(val);
    }
    Ok(serde_json::json!({ "items": [], "categories": [] }))
}

#[tauri::command]
fn save_portal(app_handle: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let file = app_data_dir.join("portal.json");
    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_workspace_roots(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let file = app_data_dir.join("workspace-roots.json");
    if file.exists() {
        let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        return Ok(val);
    }
    Ok(serde_json::Value::Array(vec![]))
}

#[tauri::command]
fn save_workspace_roots(app_handle: tauri::AppHandle, roots: serde_json::Value) -> Result<(), String> {
    let app_data_dir = ensure_app_data_dir(&app_handle)?;
    let file = app_data_dir.join("workspace-roots.json");
    let content = serde_json::to_string_pretty(&roots).map_err(|e| e.to_string())?;
    fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn validate_folder_path(folder_path: String) -> Result<String, String> {
    let trimmed = folder_path.trim();
    if !is_absolute_path(trimmed) {
        return Err("절대 폴더 경로가 필요합니다.".to_string());
    }
    let is_root = trimmed == "/"
        || (trimmed.len() == 3
            && trimmed.as_bytes()[1] == b':'
            && (trimmed.ends_with('\\') || trimmed.ends_with('/')));
    let normalized = if is_root {
        trimmed
    } else {
        trimmed.trim_end_matches(|c| c == '/' || c == '\\')
    };
    let path = std::path::Path::new(normalized);
    if !path.exists() || !path.is_dir() {
        return Err("선택한 경로가 폴더가 아니거나 존재하지 않습니다.".to_string());
    }
    Ok(normalized.to_string())
}

#[tauri::command]
fn create_folder(folder_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&folder_path);
    if path.exists() {
        return Err("이미 존재하는 폴더입니다".to_string());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    println!("[CreateFolder] Created: {}", folder_path);
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&folder_path)
        .spawn()
        .ok();
    #[cfg(not(target_os = "windows"))]
    std::process::Command::new("open")
        .arg(&folder_path)
        .spawn()
        .map(reap_detached)
        .ok();
    Ok(folder_path)
}

/// git 의 stderr 를 그대로 보여주면 원인이 묻힌다. 웹 API 의 `describeCloneFailure` 와
/// 같은 문구를 쓴다 — 같은 실패가 앱과 웹에서 다르게 읽히면 안 된다.
fn describe_clone_failure(stderr: &str) -> String {
    let text = stderr.trim();
    let lower = text.to_lowercase();
    if lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("authentication failed")
        || lower.contains("permission denied (publickey)")
    {
        return format!(
            "저장소에 접근하지 못했습니다. private 저장소라면 이 PC의 git 인증(SSH 키 또는 gh 로그인)을 먼저 설정하세요.\n{}",
            text
        );
    }
    if lower.contains("not found") || lower.contains("could not resolve host") || lower.contains("does not exist") {
        return format!(
            "저장소를 찾지 못했습니다. 주소가 맞는지, private 저장소라면 접근 권한이 있는지 확인하세요.\n{}",
            text
        );
    }
    if text.is_empty() { "git clone 실패".to_string() } else { text.to_string() }
}

/// 저장소를 새 폴더로 clone 한다.
///
/// ⚠️ `async` 여야 한다 — clone 은 수 분이 걸릴 수 있고, sync 커맨드면 그동안 IPC/메인
/// 스레드가 막혀 앱 창 전체가 얼어붙는다(CLAUDE.md의 터미널 커맨드 규칙과 같은 이유).
#[tauri::command(async)]
fn clone_repository(repository_url: String, folder_path: String) -> Result<String, String> {
    let clone_url = repository_url.trim().to_string();
    let target = folder_path.trim().to_string();
    if clone_url.is_empty() || target.is_empty() {
        return Err("repositoryUrl과 folderPath가 모두 필요합니다".to_string());
    }
    // 옵션 모양의 주소는 `git clone --upload-pack=…` 같은 인자 주입이 된다. UI 정규화에서는
    // 나올 수 없는 값이지만 이 커맨드는 그 정규화를 안 거친 입력도 받는다.
    if clone_url.starts_with('-') {
        return Err("저장소 주소가 올바르지 않습니다".to_string());
    }
    let path = std::path::Path::new(&target);
    if !path.is_absolute() {
        return Err("절대경로가 필요합니다".to_string());
    }
    if path.exists() {
        return Err("이미 존재하는 폴더입니다".to_string());
    }
    // 자격증명 프롬프트는 GUI 에 뜨지 않는다. 물어보게 두면 영원히 매달린다.
    let git_bin = resolve_bin("git");
    let output = Command::new(&git_bin)
        .args(["clone", "--", &clone_url, &target])
        .env("PATH", build_path_env())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        // 부분 생성된 폴더를 남기면 다음 시도가 "이미 존재하는 폴더입니다"로 막힌다.
        // 위에서 부재를 확인하고 들어왔으므로 이 요청이 만든 경로다.
        let _ = fs::remove_dir_all(path);
        return Err(describe_clone_failure(&String::from_utf8_lossy(&output.stderr)));
    }
    println!("[CloneRepository] Cloned {} → {}", clone_url, target);
    Ok(target)
}

#[tauri::command]
fn execute_command(
    port_id: String,
    command_path: String,
    folder_path: Option<String>,
    port: Option<u16>,
    state: State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    validate_log_id(&port_id)?;
    let _launch_claim = claim_port_launch(&state.launching, &port_id)?;
    {
        let mut processes = state.processes.lock().unwrap_or_else(|error| error.into_inner());
        #[cfg(target_os = "windows")]
        reject_live_tracked_process(&mut processes, &port_id, tracked_pid_alive, |_| false)?;
        #[cfg(not(target_os = "windows"))]
        reject_live_tracked_process(
            &mut processes,
            &port_id,
            tracked_pid_alive,
            managed_process_group_alive,
        )?;
    }
    // 파일 경로인지 raw 커맨드인지 판별 (절대경로 = 파일, 아니면 shell 커맨드)
    // is_absolute_path()는 POSIX '/'와 Windows 'C:\' / 'C:/' 둘 다 처리함
    let is_file_path = is_absolute_path(&command_path) || command_path.starts_with('~');
    let command_path_buf = std::path::PathBuf::from(&command_path);
    if is_file_path && !command_path_buf.exists() {
        println!("[ExecuteCommand] Command file not found: {}", command_path);
        return Err(format!("Command file not found: {}", command_path));
    }
    if is_file_path {
        println!("[ExecuteCommand] Command file exists: {}", command_path);
    } else {
        println!("[ExecuteCommand] Raw shell command: {}", command_path);
    }

    // .html 파일은 기본 브라우저로 열기 (open -a Chrome은 로컬 파일 경로에서 실패할 수 있음)
    if command_path.to_lowercase().ends_with(".html") {
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(&command_path).spawn()
                .map(reap_detached)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer.exe").arg(&command_path).spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Command::new("xdg-open").arg(&command_path).spawn()
                .map(reap_detached)
                .map_err(|e| e.to_string())?;
        }
        return Ok("Opened HTML file in browser".to_string());
    }

    // 로그 파일 경로 생성
    let logs_dir = ensure_app_data_dir(&app_handle)?.join("logs");
    fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;

    let log_file = logs_dir.join(format!("{}.log", port_id));
    println!("[ExecuteCommand] Log file: {:?}", log_file);

    // raw 커맨드(폴더/워크트리 dev 실행)면 실행 직전 의존성 self-heal —
    // node_modules/.venv가 없으면 dev 서버가 ./node_modules/.bin/vite ENOENT로 즉시 죽는다.
    // 백그라운드 설치 실패/미완료/기존 깨진 워크트리를 모두 여기서 복구한다.
    if !is_file_path {
        if let Some(fp) = folder_path.as_deref() {
            if !fp.is_empty() { ensure_dependencies_sync(fp); }
        }
    }

    #[cfg(target_os = "windows")]
    let supervisor_script = windows_process_supervisor_script(&app_handle)?;
    let child = spawn_process(SpawnArgs {
        port_id: &port_id,
        command_path: &command_path,
        is_file_path,
        folder_path: folder_path.as_deref(),
        log_file: &log_file,
        port: normalized_spawn_port(port),
        #[cfg(target_os = "windows")]
        supervisor_script: Some(supervisor_script.as_path()),
    })?;
    let pid = register_managed_process(&state.processes, &port_id, child)?;

    println!("[ExecuteCommand] Started process with PID: {}", pid);

    Ok(format!("Started process with PID: {} (logs: {:?})", pid, log_file))
}

/// 종료 대상 = 포트에서 찾은 PID ∪ 추적 맵의 PID (중복 제거, lsof 순서 우선).
///
/// macOS 분기는 맵의 PID를 맵에서 지우기만 하고 아무 시그널도 보내지 않은 채
/// "Process stopped (was in tracking map)"으로 성공을 반환했다. 아직 포트를
/// 바인딩하지 않아 lsof에 안 잡히는 프로세스는 그대로 살아남고 UI만 중지로 바뀐다.
/// 대상 선정을 한 곳으로 모아 모든 플랫폼이 같은 목록을 죽이게 한다.
fn stop_targets(lsof_pids: &[u32], pid_from_map: Option<u32>) -> Vec<u32> {
    let mut targets: Vec<u32> = Vec::new();
    for pid in lsof_pids.iter().copied().chain(pid_from_map) {
        if !targets.contains(&pid) {
            targets.push(pid);
        }
    }
    targets
}

/// 포트를 LISTEN 중인 PID 목록. -sTCP:LISTEN is mandatory: without it lsof also
/// returns every process merely CONNECTED to the port — measured, that includes
/// this app's own WebKit renderer — and the caller SIGKILLs what it is given.
#[cfg(not(target_os = "windows"))]
fn listen_pids_by_port(port: u16) -> Vec<u32> {
    let output = Command::new("lsof")
        .arg("-ti")
        .arg(format!(":{}", port))
        .arg("-sTCP:LISTEN")
        .output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect(),
        Ok(_) => Vec::new(),
        Err(e) => {
            println!("[StopCommand] Error running lsof: {}", e);
            Vec::new()
        }
    }
}

fn collect_descendant_pids_with<F>(root: u32, mut children_of: F) -> Vec<u32>
where
    F: FnMut(u32) -> Vec<u32>,
{
    let mut seen = HashSet::from([root]);
    let mut pending = vec![root];
    let mut descendants = Vec::new();
    while let Some(parent) = pending.pop() {
        for child in children_of(parent) {
            if child <= 1 || !seen.insert(child) {
                continue;
            }
            descendants.push(child);
            pending.push(child);
        }
    }
    descendants
}

#[cfg(not(target_os = "windows"))]
fn descendant_pids(root: u32) -> Vec<u32> {
    collect_descendant_pids_with(root, |parent| {
        Command::new("pgrep")
            .args(["-P", &parent.to_string()])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| line.trim().parse::<u32>().ok())
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// 유예 없는 즉시 종료. 강제 재실행은 500ms 뒤 같은 포트에 새 프로세스를 띄우므로
/// SIGTERM의 정리 시간을 기다려 줄 여유가 없다.
#[cfg(target_os = "windows")]
fn force_kill_pid(pid: u32) -> Result<(), String> {
    win_kill_pid(pid)
}

#[cfg(not(target_os = "windows"))]
fn force_kill_pid(pid: u32) -> Result<(), String> {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
    Ok(())
}

/// SIGTERM → (살아있으면) SIGKILL. Windows는 taskkill 한 방.
#[cfg(target_os = "windows")]
fn terminate_pid(pid: u32) -> Result<(), String> {
    println!("[StopCommand] Killing PID: {} (taskkill)", pid);
    win_kill_pid(pid)
}

#[cfg(not(target_os = "windows"))]
fn terminate_pid(pid: u32) -> Result<(), String> {
    println!("[StopCommand] Killing PID: {}", pid);
    let term_result = Command::new("kill").arg("-15").arg(pid.to_string()).output();
    let graceful = matches!(&term_result, Ok(o) if o.status.success());
    if let Err(e) = &term_result {
        println!("[StopCommand] Error sending SIGTERM to PID {}: {}", pid, e);
    }
    if graceful {
        // 종료할 시간을 주고, 그래도 살아있으면 강제 종료.
        std::thread::sleep(std::time::Duration::from_millis(200));
        let alive = Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !alive {
            return Ok(());
        }
        println!("[StopCommand] Process still alive, sending SIGKILL to PID: {}", pid);
    } else {
        println!("[StopCommand] SIGTERM failed, sending SIGKILL to PID: {}", pid);
    }
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn signal_managed_process_group(process_group_id: u32, signal: i32) -> Result<(), String> {
    let process_group_id = i32::try_from(process_group_id)
        .map_err(|_| "Managed process group ID is outside the supported PID range".to_string())?;
    if process_group_id <= 1 {
        return Err("Refusing to signal an unsafe managed process group ID".to_string());
    }
    let result = unsafe { libc::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(format!(
        "Failed to signal managed process group {}: {}",
        process_group_id, error
    ))
}

#[cfg(not(target_os = "windows"))]
fn managed_process_group_alive(process_group_id: u32) -> bool {
    let Ok(process_group_id) = i32::try_from(process_group_id) else {
        return false;
    };
    if process_group_id <= 1 {
        return false;
    }
    let result = unsafe { libc::kill(-process_group_id, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(target_os = "windows"))]
fn terminate_managed_process_group(process_group_id: u32) -> Result<(), String> {
    println!(
        "[StopCommand] Terminating managed process group: {}",
        process_group_id
    );
    signal_managed_process_group(process_group_id, libc::SIGTERM)?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    if managed_process_group_alive(process_group_id) {
        println!(
            "[StopCommand] Managed process group still alive, sending SIGKILL: {}",
            process_group_id
        );
        signal_managed_process_group(process_group_id, libc::SIGKILL)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn terminate_managed_process_group(pid: u32) -> Result<(), String> {
    terminate_pid(pid)
}

#[cfg(not(target_os = "windows"))]
fn force_kill_managed_process_group(process_group_id: u32) -> Result<(), String> {
    signal_managed_process_group(process_group_id, libc::SIGKILL)
}

#[cfg(target_os = "windows")]
fn force_kill_managed_process_group(pid: u32) -> Result<(), String> {
    force_kill_pid(pid)
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    terminate_pid(pid)
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let descendants = descendant_pids(pid);
    for child in descendants.into_iter().rev() {
        terminate_pid(child)?;
    }
    terminate_pid(pid)
}

#[cfg(target_os = "windows")]
fn force_kill_process_tree(pid: u32) -> Result<(), String> {
    force_kill_pid(pid)
}

#[cfg(not(target_os = "windows"))]
fn force_kill_process_tree(pid: u32) -> Result<(), String> {
    let descendants = descendant_pids(pid);
    for child in descendants.into_iter().rev() {
        force_kill_pid(child)?;
    }
    force_kill_pid(pid)
}

#[tauri::command]
fn stop_command(
    port_id: String,
    port: Option<u16>,
    state: State<AppState>,
) -> Result<String, String> {
    validate_log_id(&port_id)?;
    let _launch_claim = claim_port_launch(&state.launching, &port_id)?;
    let normalized_port = normalized_spawn_port(port);
    println!("[StopCommand] Starting stop for port_id: {}, port: {:?}", port_id, normalized_port);

    let tracked_record = {
        let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
        mark_managed_process_terminating(&mut processes, &port_id)
    };
    let pid_from_map = tracked_record.map(|record| record.pid);

    #[cfg(target_os = "windows")]
    let port_pids = normalized_port.map(win_pids_by_port).unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let port_pids = normalized_port.map(listen_pids_by_port).unwrap_or_default();

    let targets = stop_targets(&port_pids, pid_from_map);
    if targets.is_empty() {
        // 진짜로 죽일 것이 없을 때만 "이미 멈춤"이다.
        println!("[StopCommand] No tracked or listener process found (already stopped)");
        return Ok("No tracked or listener process running (already stopped)".to_string());
    }

    println!("[StopCommand] Stopping {} process(es): {:?}", targets.len(), targets);
    let stop_result: Result<(), String> = (|| {
        for pid in &targets {
            if Some(*pid) == pid_from_map {
                terminate_managed_process_group(*pid)?;
            } else {
                terminate_process_tree(*pid)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = stop_result {
        if let Some(record) = tracked_record {
            let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
            restore_managed_process_after_failed_termination(&mut processes, &port_id, record);
        }
        return Err(error);
    }
    if let Some(record) = tracked_record {
        let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
        remove_matching_managed_process(&mut processes, &port_id, record);
    }

    println!("[StopCommand] Successfully stopped {} process(es): {:?}", targets.len(), targets);
    Ok(format!("Stopped {} process(es) with PIDs: {:?}", targets.len(), targets))
}

#[tauri::command]
fn force_restart_command(
    port_id: String,
    port: Option<u16>,
    command_path: String,
    folder_path: Option<String>,
    state: State<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    validate_log_id(&port_id)?;
    let _launch_claim = claim_port_launch(&state.launching, &port_id)?;
    println!("[ForceRestart] Starting force restart for port_id: {}, port: {:?}", port_id, normalized_spawn_port(port));

    // .html 파일은 기본 브라우저로 열기
    if command_path.to_lowercase().ends_with(".html") {
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(&command_path).spawn()
                .map(reap_detached)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer.exe").arg(&command_path).spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Command::new("xdg-open").arg(&command_path).spawn()
                .map(reap_detached)
                .map_err(|e| e.to_string())?;
        }
        return Ok("Opened HTML file in browser".to_string());
    }

    // Preflight before killing the old server. Missing launchers and dependency
    // repair are recoverable while the existing process is still alive.
    let is_file_path = is_absolute_path(&command_path) || command_path.starts_with('~');
    let command_path_buf = std::path::PathBuf::from(&command_path);
    if is_file_path && !command_path_buf.exists() {
        return Err(format!("Command file not found: {}", command_path));
    }
    if is_file_path {
        println!("[ForceRestart] Command file exists: {}", command_path);
    } else {
        println!("[ForceRestart] Raw shell command: {}", command_path);
        if let Some(fp) = folder_path.as_deref() {
            if !fp.is_empty() { ensure_dependencies_sync(fp); }
        }
    }

    // 1단계: 포트로 실행 중인 모든 프로세스 강제 종료.
    //
    // 포트가 아직 bind되기 전인 tracked PID도 대상에 포함하되, 실제 종료가 확인되기
    // 전에는 맵에서 지우지 않는다. taskkill 실패를 성공으로 오인하면 다음 재시작이
    // 살아 있는 wrapper/자식 프로세스 위에 겹쳐 뜬다.
    let tracked_record = {
        let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
        mark_managed_process_terminating(&mut processes, &port_id)
    };
    let pid_from_map = tracked_record.map(|record| record.pid);

    // -sTCP:LISTEN is mandatory: without it lsof also returns every process
    // merely CONNECTED to the port — measured, that includes this app's own
    // WebKit renderer — and the callers below SIGKILL what they are given.
    // Force-restart was killing the UI and the API server, which surfaced as
    // "TypeError: Failed to fetch" on the in-flight request.
    #[cfg(target_os = "windows")]
    let port_pids = normalized_spawn_port(port).map(win_pids_by_port).unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let port_pids = normalized_spawn_port(port).map(listen_pids_by_port).unwrap_or_default();

    let stop_result: Result<(), String> = (|| {
        for pid in stop_targets(&port_pids, pid_from_map) {
            println!("[ForceRestart] Force killing PID: {}", pid);
            if Some(pid) == pid_from_map {
                force_kill_managed_process_group(pid)?;
            } else {
                force_kill_process_tree(pid)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = stop_result {
        if let Some(record) = tracked_record {
            let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
            restore_managed_process_after_failed_termination(&mut processes, &port_id, record);
        }
        return Err(error);
    }
    if let Some(record) = tracked_record {
        let mut processes = state.processes.lock().unwrap_or_else(|e| e.into_inner());
        remove_matching_managed_process(&mut processes, &port_id, record);
    }

    // 잠시 대기 (프로세스가 완전히 종료될 시간)
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 2단계: 새로운 프로세스 시작
    let logs_dir = ensure_app_data_dir(&app_handle)?.join("logs");
    fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;

    let log_file = logs_dir.join(format!("{}.log", port_id));
    println!("[ForceRestart] Log file: {:?}", log_file);

    #[cfg(target_os = "windows")]
    let supervisor_script = windows_process_supervisor_script(&app_handle)?;
    let child = spawn_process(SpawnArgs {
        port_id: &port_id,
        command_path: &command_path,
        is_file_path,
        folder_path: folder_path.as_deref(),
        log_file: &log_file,
        port: normalized_spawn_port(port),
        #[cfg(target_os = "windows")]
        supervisor_script: Some(supervisor_script.as_path()),
    })?;
    let new_pid = register_managed_process(&state.processes, &port_id, child)?;

    println!("[ForceRestart] Successfully restarted with new PID: {}", new_pid);

    Ok(match normalized_spawn_port(port) {
        Some(port) => format!("Force restarted on port {} with new PID: {}", port, new_pid),
        None => format!("Force restarted tracked process with new PID: {}", new_pid),
    })
}

#[tauri::command]
fn check_port_status(port: u16) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        // Without -sTCP:LISTEN a port that nothing serves still reads as running
        // whenever some process merely holds a connection toward it, so the row
        // would show a green server that is not there.
        let output = Command::new("lsof")
            .arg("-ti")
            .arg(format!(":{}", port))
            .arg("-sTCP:LISTEN")
            .output();

        match output {
            Ok(out) => {
                let is_running = out.status.success() && !out.stdout.is_empty();
                println!("[CheckPort] Port {} is {}", port, if is_running { "RUNNING" } else { "NOT running" });
                Ok(is_running)
            }
            Err(e) => {
                println!("[CheckPort] Error checking port {}: {}", port, e);
                Ok(false) // 에러가 나면 실행 중이 아닌 것으로 간주
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let is_running = !win_pids_by_port(port).is_empty();
        println!("[CheckPort] Port {} is {}", port, if is_running { "RUNNING" } else { "NOT running" });
        Ok(is_running)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = port;
        Ok(false)
    }
}

#[derive(Debug, Serialize)]
struct PortStatusResult {
    port: u16,
    #[serde(rename = "isRunning")]
    is_running: bool,
}

/// 모든 LISTEN 포트를 단일 lsof/netstat 호출로 수집 → 요청된 포트들의 상태를 일괄 응답.
/// 프론트엔드 10초 폴링이 포트당 1회 spawn하던 것을 틱당 1회로 줄임.
#[tauri::command]
fn check_ports_status_batch(ports: Vec<u16>) -> Vec<PortStatusResult> {
    use std::collections::HashSet;

    const MAX_PORTS: usize = 500;
    let ports: Vec<u16> = ports.into_iter().take(MAX_PORTS).collect();

    let mut listening: HashSet<u16> = HashSet::new();

    #[cfg(target_os = "macos")]
    {
        // 단일 lsof 호출로 모든 LISTEN 소켓 조회
        let output = Command::new("lsof")
            .arg("-nP")
            .arg("-iTCP")
            .arg("-sTCP:LISTEN")
            .output();

        match output {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    // NAME 컬럼(마지막 필드)의 마지막 콜론 뒤가 포트 번호
                    // 예: "*:5173 (LISTEN)" 또는 "127.0.0.1:3001 (LISTEN)"
                    if let Some(name) = line.split_whitespace().rev().find(|f| f.contains(':')) {
                        if let Some(idx) = name.rfind(':') {
                            if let Ok(p) = name[idx + 1..].parse::<u16>() {
                                listening.insert(p);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                println!("[CheckPortsBatch] Error running lsof: {}", e);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // 단일 netstat 호출로 모든 LISTENING 소켓 조회
        let output = Command::new("netstat").arg("-ano").output();

        match output {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                for (port, _) in parse_windows_netstat_listeners(&text) {
                    listening.insert(port);
                }
            }
            Err(e) => {
                println!("[CheckPortsBatch] Error running netstat: {}", e);
            }
        }
    }

    println!(
        "[CheckPortsBatch] Checked {} ports, {} listening sockets found",
        ports.len(),
        listening.len()
    );

    ports
        .into_iter()
        .map(|port| PortStatusResult {
            port,
            is_running: listening.contains(&port),
        })
        .collect()
}

#[tauri::command]
fn detect_port(file_path: String) -> Result<Option<u16>, String> {
    let content = fs::read_to_string(&file_path)
        .map_err(|e| e.to_string())?;

    // localhost:포트 패턴 검색
    if let Some(caps) = regex::Regex::new(r"localhost:(\d+)")
        .unwrap()
        .captures(&content) {
        if let Some(port_str) = caps.get(1) {
            if let Ok(port) = port_str.as_str().parse::<u16>() {
                return Ok(Some(port));
            }
        }
    }

    // PORT=포트 또는 port=포트 패턴 검색
    if let Some(caps) = regex::Regex::new(r"(?:PORT|port)\s*=\s*(\d+)")
        .unwrap()
        .captures(&content) {
        if let Some(port_str) = caps.get(1) {
            if let Ok(port) = port_str.as_str().parse::<u16>() {
                return Ok(Some(port));
            }
        }
    }

    Ok(None)
}

#[tauri::command]
fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn open_build_folder() -> Result<String, String> {
    // Windows: USERPROFILE 우선, macOS: HOME
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let bundle_folder = format!("{}\\cargo-targets\\portmanager\\release\\bundle\\nsis", home);
    #[cfg(not(target_os = "windows"))]
    let bundle_folder = format!("{}/cargo-targets/portmanager/release/bundle/dmg", home);

    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(&bundle_folder)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    Command::new("open")
        .arg(&bundle_folder)
        .spawn()
        .map(reap_detached)
        .map_err(|e| e.to_string())?;

    Ok("폴더를 열었습니다".to_string())
}

#[tauri::command]
fn export_dmg() -> Result<String, String> {
    use std::path::Path;

    // Windows: USERPROFILE 우선, macOS: HOME
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    // .cargo/config.toml의 target-dir 설정과 동일한 경로
    let bundle_dir = format!("{}/cargo-targets/portmanager/release/bundle", home);

    // DMG 파일 찾기
    let dmg_paths = vec![
        format!("{}/dmg 2", bundle_dir),
        format!("{}/dmg", bundle_dir),
        format!("{}/macos", bundle_dir),
    ];

    let mut dmg_file: Option<String> = None;

    'outer: for dmg_dir in dmg_paths {
        if let Ok(entries) = fs::read_dir(&dmg_dir) {
            let mut candidates: Vec<(std::time::SystemTime, String)> = entries
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let name = p.file_name()?.to_str()?.to_string();
                    if p.extension()? == "dmg" && !name.starts_with("rw.") {
                        let mtime = p.metadata().ok()?.modified().ok()?;
                        Some((mtime, p.to_string_lossy().to_string()))
                    } else {
                        None
                    }
                })
                .collect();
            if !candidates.is_empty() {
                candidates.sort_by(|a, b| b.0.cmp(&a.0)); // 최신순
                dmg_file = Some(candidates.remove(0).1);
                break 'outer;
            }
        }
    }

    match dmg_file {
        Some(dmg_path) => {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            let desktop = format!("{}/Desktop", home);

            // 원본 파일명 추출 후 vN 형식으로 단순화
            // "CS_Manager_51.0.0_aarch64.dmg" → "CS_Manager_v51.dmg"
            let dmg_filename = Path::new(&dmg_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("CS_Manager.dmg");

            let release_name = {
                let base = dmg_filename.trim_end_matches(".dmg");
                let parts: Vec<&str> = base.split('_').collect();
                let mut found = None;
                let mut product_end = parts.len();
                for (i, part) in parts.iter().enumerate() {
                    let segs: Vec<&str> = part.split('.').collect();
                    if segs.len() == 3 && segs.iter().all(|s| s.parse::<u64>().is_ok()) {
                        found = Some(segs[0].to_string());
                        product_end = i;
                        break;
                    }
                }
                if let Some(major) = found {
                    format!("{}_v{}.dmg", parts[..product_end].join("_"), major)
                } else {
                    dmg_filename.to_string()
                }
            };

            let dest_path = format!("{}/{}", desktop, release_name);

            // 기존 파일이 있으면 삭제
            if Path::new(&dest_path).exists() {
                fs::remove_file(&dest_path)
                    .map_err(|e| format!("기존 파일 삭제 실패: {}", e))?;
            }

            // DMG 복사
            fs::copy(&dmg_path, &dest_path)
                .map_err(|e| format!("DMG 복사 실패: {}", e))?;

            // Desktop 폴더 열기 (Windows: explorer, macOS: open)
            #[cfg(target_os = "windows")]
            Command::new("explorer")
                .arg(&desktop)
                .spawn()
                .map(reap_detached)
                .map_err(|e| e.to_string())?;

            #[cfg(not(target_os = "windows"))]
            Command::new("open")
                .arg(&desktop)
                .spawn()
                .map(reap_detached)
                .map_err(|e| e.to_string())?;

            Ok(format!("DMG를 Desktop에 복사했습니다: {}", dest_path))
        }
        None => Err("DMG 파일을 찾을 수 없습니다. 먼저 빌드를 실행하세요.".to_string())
    }
}

#[tauri::command]
fn open_folder(folder_path: String) -> Result<String, String> {
    if folder_path.is_empty() {
        return Err("경로가 비어 있습니다".to_string());
    }
    if !is_absolute_path(&folder_path) {
        return Err(format!("절대 경로가 필요합니다: \"{}\"", folder_path));
    }
    if !std::path::Path::new(&folder_path).exists() {
        return Err(format!("경로를 찾을 수 없습니다: \"{}\"", folder_path));
    }

    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(&folder_path)
        .spawn()
        .map_err(|e| format!("경로 열기 실패: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    Command::new("open")
        .arg(&folder_path)
        .spawn()
        .map(reap_detached)
        .map_err(|e| format!("경로 열기 실패: {}", e))?;

    Ok(format!("경로를 열었습니다: {}", folder_path))
}

fn percent_encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            other => encoded.push_str(&format!("%{:02X}", other)),
        }
    }
    encoded
}

#[tauri::command]
fn open_code_app(agent: String, folder_path: String) -> Result<String, String> {
    if agent != "codex" && agent != "claude" && agent != "hermes" {
        return Err("agent must be codex, claude, or hermes".to_string());
    }
    if !is_absolute_path(&folder_path) {
        return Err(format!("절대 경로가 필요합니다: \"{}\"", folder_path));
    }
    let path = std::path::Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("폴더를 찾을 수 없습니다: \"{}\"", folder_path));
    }

    if agent == "hermes" {
        let response = local_api_post_json(
            "/api/open-code-app",
            &serde_json::json!({ "agent": "hermes", "folderPath": folder_path }),
        )?;
        if response.get("success").and_then(|value| value.as_bool()) != Some(true) {
            return Err(response.get("error").and_then(|value| value.as_str())
                .unwrap_or("Hermes Desktop 실행을 확인하지 못했습니다.").to_string());
        }
        return Ok(format!("Hermes Desktop에서 프로젝트를 열었습니다: {}", folder_path));
    }

    let encoded_path = percent_encode_query_component(&folder_path);
    let deep_link = if agent == "codex" {
        format!("codex://threads/new?path={}", encoded_path)
    } else {
        format!("claude://code/new?folder={}", encoded_path)
    };

    #[cfg(target_os = "macos")]
    let open_status = Command::new("open")
        .arg(&deep_link)
        .status()
        .map_err(|e| format!("앱 열기 실패: {}", e))?;

    #[cfg(target_os = "windows")]
    let open_status = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &deep_link])
        .status()
        .map_err(|e| format!("앱 열기 실패: {}", e))?;

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let open_status = Command::new("xdg-open")
        .arg(&deep_link)
        .status()
        .map_err(|e| format!("앱 열기 실패: {}", e))?;

    if !open_status.success() {
        return Err(format!("{} 앱 URL 핸들러를 실행하지 못했습니다.", agent));
    }

    if agent == "claude" {
        Ok(format!("Claude Code 앱 열기 요청됨 (폴더 확인 필요): {}", folder_path))
    } else {
        Ok(format!("ChatGPT 앱의 Codex에서 프로젝트를 열었습니다: {}", folder_path))
    }
}

#[tauri::command]
fn open_log(port_id: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    validate_log_id(&port_id)?;
    // 로그 파일 경로 생성
    let logs_dir = ensure_app_data_dir(&app_handle)?.join("logs");
    fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;

    let log_file = logs_dir.join(format!("{}.log", port_id));

    // 로그 파일이 없으면 생성
    if !log_file.exists() {
        fs::write(&log_file, "로그가 아직 생성되지 않았습니다.\n")
            .map_err(|e| format!("Failed to create log file: {}", e))?;
    }

    println!("[OpenLog] Opening log file: {:?}", log_file);

    #[cfg(target_os = "macos")]
    {
        let log_path_str = log_file.to_string_lossy().to_string();
        // `create window with default profile command` 방식: write text와 달리 클립보드 미사용
        let sq_escaped = log_path_str.replace('\'', "'\\''");
        let script = format!(
            "tell application \"iTerm\"\n  activate\n  create window with default profile command \"tail -f '{}'\"\nend tell",
            sq_escaped
        );
        let result = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();
        match result {
            Ok(out) if !out.status.success() => {
                // iTerm 실패 시 Terminal.app으로 폴백
                let fallback = format!(
                    "tell application \"Terminal\"\n  do script \"tail -f '{}'\"\n  activate\nend tell",
                    sq_escaped
                );
                Command::new("osascript")
                    .arg("-e")
                    .arg(&fallback)
                    .spawn()
                    .map(reap_detached)
                    .map_err(|e| format!("Failed to open Terminal: {}", e))?;
            }
            Err(e) => return Err(format!("Failed to open iTerm: {}", e)),
            _ => {}
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: WSL bash로 tail -f (Windows Terminal 사용)
        let log_path_str = log_file.to_string_lossy().to_string();
        let wsl_path = win_to_wsl_path(&log_path_str);
        let bash_cmd = format!("tail -f '{}'", escape_sq(&wsl_path));
        spawn_wt_wsl(&bash_cmd, Some("Log Viewer"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg(log_file.to_string_lossy().to_string())
            .spawn()
            .map(reap_detached)
            .map_err(|e| format!("Failed to open log file: {}", e))?;
    }

    Ok(format!("로그 파일을 열었습니다: {:?}", log_file))
}

#[tauri::command]
fn read_log_content(port_id: String, offset: usize, app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    validate_log_id(&port_id)?;
    let logs_dir = ensure_app_data_dir(&app_handle)?.join("logs");
    let log_file = logs_dir.join(format!("{}.log", port_id));

    if !log_file.exists() {
        return Ok(serde_json::json!({
            "content": "",
            "size": 0,
            "exists": false
        }));
    }

    use std::io::{Read, Seek, SeekFrom};

    // 파일 전체를 읽지 않고 먼저 크기만 stat — 1초 폴링에서 메모리 폭증 방지
    let size = fs::metadata(&log_file)
        .map_err(|e| format!("Failed to read log file: {}", e))?
        .len();
    let byte_offset = offset as u64;

    // 정상 상태 (새 데이터 없음): 빈 content + 실제 size 반환.
    // 파일이 줄어든 경우(size < offset)도 클라이언트가 size < offset 체크로 offset을 리셋한다.
    if byte_offset >= size && size > 0 {
        return Ok(serde_json::json!({
            "content": "",
            "size": size,
            "exists": true,
            "offset": offset
        }));
    }

    // offset == 0 → 마지막 MAX_TAIL_BYTES만 읽기 (초기 로드).
    // 0 < offset < size → delta만 읽되, delta가 cap을 넘으면 size - cap부터 읽기.
    let read_from = if byte_offset == 0 {
        size.saturating_sub(MAX_TAIL_BYTES)
    } else if size - byte_offset > MAX_TAIL_BYTES {
        size - MAX_TAIL_BYTES
    } else {
        byte_offset
    };

    let mut file = fs::File::open(&log_file)
        .map_err(|e| format!("Failed to read log file: {}", e))?;
    file.seek(SeekFrom::Start(read_from))
        .map_err(|e| format!("Failed to read log file: {}", e))?;
    let mut buf = Vec::with_capacity(size.saturating_sub(read_from).min(MAX_TAIL_BYTES) as usize);
    file.take(MAX_TAIL_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read log file: {}", e))?;
    // 바이트 오프셋이 UTF-8 경계를 가를 수 있음 — lossy 변환으로 panic 방지.
    // size는 항상 파일의 바이트 크기를 반환해 클라이언트 offset이 바이트 단위로 유지됨.
    let content = String::from_utf8_lossy(&buf);

    Ok(serde_json::json!({
        "content": content,
        "size": size,
        "exists": true,
        "offset": offset
    }))
}

/// Bypassing permissions runs a different kind of session, so it gets its own
/// tmux name. Every path that builds a Claude tmux command applies this rule,
/// so that "실행" and "새 창" address the same session (`src/tmuxSessionName.ts`
/// is the web/frontend counterpart).
fn tmux_bypass_session_name(session_name: &str, bypass: bool) -> String {
    if bypass { format!("{}-bypass", session_name) } else { session_name.to_string() }
}

/// The worktree a session runs in is part of its identity: two worktrees of one
/// project are different working copies and must not share a session.
/// Mirrors `tmuxWorktreeSuffix` in `src/tmuxSessionName.ts`.
fn tmux_worktree_suffix(worktree_path: Option<&str>) -> String {
    // A comma-joined list means several worktrees; only the first one — the one
    // we cd into — names the session.
    let first = worktree_path
        .and_then(|wt| wt.split(',').next())
        .map(|p| p.trim())
        .unwrap_or("");
    if first.is_empty() {
        return String::new();
    }
    let trimmed = first.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(|c| c == '/' || c == '\\').next() {
        Some(leaf) if !leaf.is_empty() => format!("-{}", leaf),
        _ => String::new(),
    }
}

/// 워크트리 접미사만 붙인 이름 — 창 제목·표시용.
fn tmux_agent_session_name(base_name: &str, worktree_path: Option<&str>) -> String {
    format!("{}{}", base_name, tmux_worktree_suffix(worktree_path))
}

/// The whole rule in one call: base → worktree → bypass.
///
/// 이 함수는 `#[cfg]` 분기 **밖**에 있어야 한다. 예전에는 macOS 분기만 bypass 접미사를
/// 붙이고 Windows(WSL) 분기는 `claude_arg`에만 반영해서, 같은 Windows에서 '실행 ⚡'는
/// `demo-bypass`를, '새 창 ⚡'는 `demo`를 kill/create 했다.
/// 프런트엔드는 접미사 없는 기본 이름만 넘긴다 — 계약은 `tests/fixtures/tmux-session-golden.json`.
fn tmux_session_name(base_name: &str, worktree_path: Option<&str>, bypass: bool) -> String {
    tmux_bypass_session_name(&tmux_agent_session_name(base_name, worktree_path), bypass)
}

/// Escape single quotes for use inside single-quoted shell strings.
/// ' → '\'' (end-quote, literal-apostrophe, re-open-quote)
fn escape_sq(s: &str) -> String {
    s.replace("'", "'\\''")
}

/// Parse plain Windows `netstat -ano` output without assuming English state
/// labels. Listener rows have a wildcard foreign endpoint on port zero;
/// `-q` must not be used because it additionally emits BOUND non-listeners.
#[cfg(any(target_os = "windows", test))]
fn parse_windows_netstat_listeners(output: &str) -> Vec<(u16, u32)> {
    let mut listeners = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 || !parts[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        let foreign = parts[2];
        if foreign != "0.0.0.0:0" && foreign != "[::]:0" {
            continue;
        }
        let state = parts[parts.len() - 2].to_ascii_uppercase();
        if matches!(
            state.as_str(),
            "BOUND" | "CLOSED" | "CLOSE_WAIT" | "CLOSING" | "DELETE_TCB"
                | "ESTABLISHED" | "FIN_WAIT_1" | "FIN_WAIT_2" | "LAST_ACK"
                | "SYN_RECEIVED" | "SYN_SENT" | "TIME_WAIT"
        ) {
            continue;
        }
        let Some(port_text) = parts[1].rsplit(':').next() else {
            continue;
        };
        let (Ok(port), Ok(pid)) = (
            port_text.parse::<u16>(),
            parts[parts.len() - 1].parse::<u32>(),
        ) else {
            continue;
        };
        if pid > 1 && !listeners.contains(&(port, pid)) {
            listeners.push((port, pid));
        }
    }
    listeners
}

#[cfg(any(target_os = "windows", test))]
fn windows_taskkill_args(pid: u32) -> Vec<String> {
    vec![
        "/F".to_string(),
        "/T".to_string(),
        "/PID".to_string(),
        pid.to_string(),
    ]
}

/// Windows: 포트를 점유 중인 고유 PID 목록 조회 (netstat 파싱 — PowerShell보다 ~6배 빠름)
/// WHY: PowerShell Get-NetTCPConnection은 기동 오버헤드 ~300-500ms, netstat은 ~50ms.
#[cfg(target_os = "windows")]
fn win_pids_by_port(port: u16) -> Vec<u32> {
    let out = Command::new("netstat").arg("-ano").output();
    let mut pids: Vec<u32> = Vec::new();
    if let Ok(o) = out {
        for (listener_port, pid) in parse_windows_netstat_listeners(&String::from_utf8_lossy(&o.stdout)) {
            if listener_port == port && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// Windows: wrapper 아래 dev server까지 종료하고 실패를 호출자에게 전파한다.
#[cfg(target_os = "windows")]
fn win_kill_pid(pid: u32) -> Result<(), String> {
    let args = windows_taskkill_args(pid);
    let output = Command::new("taskkill")
        .args(&args)
        .output()
        .map_err(|error| format!("taskkill 실행 실패 (PID {}): {}", pid, error))?;
    if output.status.success() {
        return Ok(());
    }
    // Closing the Windows Job Object may terminate the supervisor before
    // taskkill observes it. That is already the requested end state, not a
    // failure that should surface to the UI or trigger a duplicate retry.
    if !tracked_pid_alive(pid) {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if detail.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        detail
    };
    Err(format!(
        "taskkill이 PID {} 프로세스 트리를 종료하지 못했습니다{}",
        pid,
        if detail.is_empty() { String::new() } else { format!(": {}", detail) },
    ))
}

#[cfg(target_os = "windows")]
fn win_to_wsl_path(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        let drive = path.chars().next().unwrap().to_ascii_lowercase();
        let rest = path[2..].replace('\\', "/");
        format!("/mnt/{}{}", drive, rest)
    } else {
        path.replace('\\', "/")
    }
}

// Windows 레지스트리에서 WSL distro 목록 조회 (reg.exe — PowerShell보다 ~10배 빠름)
// WHY: PowerShell 기동 오버헤드 ~300-500ms vs reg.exe ~30-50ms.
#[cfg(target_os = "windows")]
fn find_wsl_distro() -> Option<String> {
    let out = Command::new("reg")
        .args(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s", "/v", "DistributionName"])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    // reg 출력 형식: "    DistributionName    REG_SZ    Ubuntu"
    for line in text.lines() {
        if !line.contains("DistributionName") { continue; }
        // "REG_SZ" 뒤의 값 추출
        if let Some(idx) = line.find("REG_SZ") {
            let name = line[idx + 6..].trim();
            if !name.is_empty() && !name.to_lowercase().contains("docker") {
                return Some(name.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn spawn_wt_wsl(bash_cmd: &str, title: Option<&str>) -> Result<(), String> {
    let distro = find_wsl_distro().ok_or_else(|| "WSL Ubuntu distro를 찾을 수 없습니다.".to_string())?;
    let wt = resolve_windows_terminal_path();
    let mut command;
    if let Some(path) = wt {
        command = Command::new(path);
        if let Some(value) = title { command.args(["--title", value]); }
        command.args(["--", "wsl.exe", "-d", &distro, "--", "bash", "-c", bash_cmd]);
    } else {
        // A GUI parent gives the console executable its own visible console;
        // direct argv avoids percent/metacharacter expansion in titles.
        command = Command::new("wsl.exe");
        command.args(["-d", &distro, "--", "bash", "-c", bash_cmd]);
    }
    command.spawn().map_err(|e| format!("Windows Terminal/WSL 실행 실패: {}", e))?;
    Ok(())
}

/// 창/탭 타이틀 빌더: 이모지 prefix + 프로젝트명 › 워크트리
/// ⚡️ tmux+bypass  🔷🆕 tmux+fresh  🔷 tmux  🛡️ bypass  🪟 normal
fn build_window_title(session: &str, worktree_path: Option<&str>, is_tmux: bool, is_bypass: bool, is_fresh: bool) -> String {
    let wt_name = worktree_path
        .and_then(|wt| wt.split(',').next())
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| path_basename(p));
    let base = match wt_name {
        Some(n) => format!("{} \u{203A} {}", session, n),
        None => session.to_string(),
    };
    let prefix = match (is_tmux, is_bypass, is_fresh) {
        (true, true, _)      => "\u{26A1}\u{FE0F} ",
        (true, false, true)  => "\u{1F537}\u{1F195} ",
        (true, false, false) => "\u{1F537} ",
        (false, true, _)     => "\u{1F6E1}\u{FE0F} ",
        _                    => "\u{1FA9F} ",
    };
    format!("{}{}", prefix, base)
}

#[tauri::command]
fn check_wsl() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let wsl_exists = Command::new("where")
            .arg("wsl.exe")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !wsl_exists {
            return Ok(serde_json::json!({ "status": "not_installed" }));
        }
        // bash timeout이 Windows/WSL에서 불가능 → 목록 확인만으로 판단
        let distro = match find_wsl_distro() {
            Some(d) => d,
            None => return Ok(serde_json::json!({ "status": "no_distro" })),
        };
        let _ = distro;
        return Ok(serde_json::json!({ "status": "ready" }));
    }
    #[cfg(not(target_os = "windows"))]
    Ok(serde_json::json!({ "status": "ready" }))
}

#[tauri::command]
fn install_wsl() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("powershell")
            .args([
                "-Command",
                "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit', '-Command', 'wsl --install; Write-Host \"설치 완료. PC를 재시작하세요.\"; pause'"
            ])
            .spawn()
            .map_err(|e| format!("관리자 PowerShell 실행 실패: {}", e))?;
        return Ok("WSL2 설치 창이 열렸습니다. UAC 허용 후 설치가 시작됩니다.".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    Ok("".to_string())
}

#[tauri::command]
fn install_wsl_tmux() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let distro = find_wsl_distro().ok_or_else(|| "Ubuntu WSL distro를 찾을 수 없습니다.".to_string())?;
        // root인 경우 sudo 불필요
        let whoami = Command::new("wsl").args(["-d", &distro, "--", "bash", "-c", "whoami"]).output().ok();
        let is_root = whoami.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).trim() == "root").unwrap_or(false);
        let install_cmd = if is_root {
            "apt-get update -qq && apt-get install -y tmux"
        } else {
            "sudo apt-get update -qq && sudo apt-get install -y tmux"
        };
        let out = Command::new("wsl")
            .args(["-d", &distro, "--", "bash", "-c", install_cmd])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok("tmux 설치 완료".to_string());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tmux 설치 실패: {}", stderr));
    }
    #[cfg(not(target_os = "windows"))]
    Ok("".to_string())
}

/// 터미널 실행이 확인됐는지 여부. `Unverified`는 실패가 아니라 "아직 모름"이다.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalLaunchOutcome {
    Verified,
    Unverified,
}

/// 짧은 deadline 안에 osascript가 끝나면 exit code로 정직하게 판정하고,
/// 넘기면 **죽이지 않고** Unverified로 돌려준다.
///
/// iTerm/Terminal의 main run loop가 막히면(실측 2026-08-02: 같은 앱이 `get version`은
/// 0.05s에 답하면서 `create window`/`count windows`는 25s+ 무응답) AppleEvent가 반환되지
/// 않는다. 전체 대기를 명령에 묶으면 사용자는 창도 못 보고 오래 기다린 끝에 에러만 받는다 —
/// 이전의 fire-and-forget 가짜 성공보다 오히려 나쁘다. 전달 중인 AppleEvent가 창을 열 수도
/// 있으므로 프로세스는 그대로 두고, backstop을 넘겨서까지 살아 있을 때만 SIGKILL 한다.
#[cfg(target_os = "macos")]
fn run_osascript_checked(applescript: &str, deadline_ms: u64) -> Result<TerminalLaunchOutcome, String> {
    const BACKSTOP_MS: u64 = 120_000;
    let child = Command::new("osascript")
        .arg("-e")
        .arg(applescript)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("터미널 자동화 실행 실패: {}", e))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(std::time::Duration::from_millis(deadline_ms)) {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("터미널 자동화 실행 실패: {}", error)),
        Err(_) => {
            // deadline 초과 — 죽이지 않고 백그라운드에 맡긴다. backstop 이후에만 정리.
            std::thread::spawn(move || {
                if rx
                    .recv_timeout(std::time::Duration::from_millis(BACKSTOP_MS))
                    .is_err()
                {
                    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
                }
            });
            return Ok(TerminalLaunchOutcome::Unverified);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("터미널 자동화 실패 ({})", output.status)
        } else {
            stderr
        });
    }
    Ok(TerminalLaunchOutcome::Verified)
}

/// 터미널이 응답했는지 판정하기까지 기다리는 시간. 이 이상은 사용자를 붙잡지 않는다.
#[cfg(target_os = "macos")]
const TERMINAL_LAUNCH_DEADLINE_MS: u64 = 4_000;

/// 확인되지 않은 실행에 붙일 사용자 경고 문구.
#[cfg(target_os = "macos")]
const TERMINAL_UNVERIFIED_WARNING: &str =
    "터미널이 제때 응답하지 않아 실행 여부를 확인하지 못했습니다. 창이 열리지 않으면 iTerm/Terminal을 재시작한 뒤 다시 시도해주세요.";

#[cfg(target_os = "macos")]
impl TerminalLaunchOutcome {
    /// 확인되지 않은 실행이면 사용자 메시지 뒤에 붙일 경고. 확인됐으면 빈 문자열.
    fn warning_suffix(self) -> String {
        match self {
            TerminalLaunchOutcome::Verified => String::new(),
            TerminalLaunchOutcome::Unverified => format!(" — {}", TERMINAL_UNVERIFIED_WARNING),
        }
    }
}

/// 선택된 터미널 앱으로 스크립트를 실행한다.
#[cfg(target_os = "macos")]
fn launch_terminal_script(cmd: &str, terminal_app: Option<&str>) -> Result<TerminalLaunchOutcome, String> {
    if terminal_app == Some("terminal") {
        open_terminal_app_with_script(cmd)
    } else {
        open_iterm_with_script(cmd)
    }
}

/// macOS: 임시 스크립트 파일로 iTerm을 열어 클립보드 오염 없이 명령 실행
#[cfg(target_os = "macos")]
fn open_iterm_with_script(cmd: &str) -> Result<TerminalLaunchOutcome, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let script_path = format!("/tmp/portmanager_{}.sh", ts);
    // rm -f "$0": zsh가 파일을 fd로 연 채 실행하므로 첫 줄에서 자기 자신을 삭제해도 안전.
    fs::write(&script_path, format!("#!/bin/zsh -l\nrm -f \"$0\"\n{}\n", cmd))
        .map_err(|e| format!("Failed to write script: {}", e))?;
    let _ = Command::new("chmod").args(["+x", &script_path]).output();
    let sq_path = script_path.replace('\'', "'\\''");
    let applescript = format!(
        "tell application \"iTerm\"\n  activate\n  create window with default profile command \"/bin/zsh -l '{}'\"\nend tell",
        sq_path
    );
    run_osascript_checked(&applescript, TERMINAL_LAUNCH_DEADLINE_MS)
}

/// macOS Terminal.app variant used when the user explicitly selects `terminal`.
#[cfg(target_os = "macos")]
fn open_terminal_app_with_script(cmd: &str) -> Result<TerminalLaunchOutcome, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let script_path = format!("/tmp/portmanager_terminal_{}.sh", ts);
    fs::write(&script_path, format!("#!/bin/zsh -l\nrm -f \"$0\"\n{}\n", cmd))
        .map_err(|e| format!("Failed to write script: {}", e))?;
    let _ = Command::new("chmod").args(["+x", &script_path]).output();
    let shell_command = format!("/bin/zsh -l '{}'", escape_sq(&script_path));
    let applescript = format!(
        "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
        shell_command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    run_osascript_checked(&applescript, TERMINAL_LAUNCH_DEADLINE_MS)
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_terminal_at_folder(folder_path: String, title: Option<String>, terminal_app: Option<String>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let expanded_path = if folder_path == "~" { home.clone() }
            else if let Some(rest) = folder_path.strip_prefix("~/") { format!("{}/{}", home, rest) }
            else { folder_path.clone() };
        if !std::path::Path::new(&expanded_path).is_dir() {
            return Err(format!("폴더를 찾을 수 없습니다: {}", expanded_path));
        }
        let display_title = title.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| expanded_path.clone());
        let command = format!("cd '{}' && printf '\\033]0;{}\\007'", escape_sq(&expanded_path), escape_sq(&display_title));
        if terminal_app.as_deref() == Some("terminal") {
            let outcome = open_terminal_app_with_script(&command)?;
            return Ok(format!("Terminal 터미널 열림{}", outcome.warning_suffix()));
        }
        let outcome = open_iterm_with_script(&command)?;
        return Ok(format!("iTerm 터미널 열림{}", outcome.warning_suffix()));
    }
    #[cfg(target_os = "windows")]
    {
        let display_title = title.unwrap_or_else(|| folder_path.clone());
        spawn_wt_cmd("", Some(&folder_path), &display_title)?;
        Ok("Windows Terminal 열림".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (folder_path, title, terminal_app);
        Err("이 기능은 macOS 또는 Windows에서만 지원됩니다".to_string())
    }
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_tmux_claude(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, terminal_app: Option<String>) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    // session_name은 접미사 없는 기본 이름 — 접미사는 여기서 한 번만 붙인다.
    #[allow(unused_variables)]
    let display_name = tmux_agent_session_name(&session_name, worktree_path.as_deref());
    let session_id = tmux_session_name(&session_name, worktree_path.as_deref(), false);
    #[cfg(target_os = "macos")]
    {
        let esc_session = escape_sq(&session_id);
        let esc_display = escape_sq(&display_name);
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, false, false);
        let esc_title_sq = escape_sq(&title);
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007'; tmux new-session -d -s '{}' -n '{}' \"claude\" 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", escape_sq(cd), esc_title_sq, esc_session, esc_display, esc_session, esc_session, esc_display, esc_session)
        } else {
            format!("printf '\\033]0;{}\\007'; tmux new-session -d -s '{}' -n '{}' \"claude\" 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", esc_title_sq, esc_session, esc_display, esc_session, esc_session, esc_display, esc_session)
        };

        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let cd_path = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .or_else(|| folder_path.clone())
            .map(|p| win_to_wsl_path(&p));
        let cd_part = cd_path.map(|p| format!("cd '{}' && ", escape_sq(&p))).unwrap_or_default();
        let bash_cmd = format!("{}tmux new-session -A -s '{}' 'claude || bash -l'", cd_part, escape_sq(&session_id));
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, false, false);
        spawn_wt_wsl(&bash_cmd, Some(&title))?;
    }

    Ok(format!("tmux + Claude 실행 중 (세션: {}){}", session_id, launch_warning))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_tmux_claude_fresh(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    let bypass = bypass.unwrap_or(false);
    let claude_cli = if bypass { "claude --dangerously-skip-permissions" } else { "claude" };
    // Bypass sessions live under their own name, so "새 창" has to target that
    // one — otherwise it replaces a session nobody is attached to and the next
    // "실행" silently rejoins the original. 이 계산은 cfg 분기 밖에 있어야
    // macOS와 Windows가 같은 세션을 가리킨다.
    #[allow(unused_variables)]
    let display_name = tmux_agent_session_name(&session_name, worktree_path.as_deref());
    let session_id = tmux_session_name(&session_name, worktree_path.as_deref(), bypass);
    #[cfg(target_os = "macos")]
    {
        let esc_session = escape_sq(&session_id);
        let esc_display = escape_sq(&display_name);
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, bypass, true);
        let esc_title_sq = escape_sq(&title);
        let kill_cmd = format!("tmux kill-session -t '{}' 2>/dev/null || true", esc_session);
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let new_cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007'; tmux new-session -d -s '{}' -n '{}' \"zsh -l -c '{}'\"; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", escape_sq(cd), esc_title_sq, esc_session, esc_display, claude_cli, esc_session, esc_session, esc_display, esc_session)
        } else {
            format!("printf '\\033]0;{}\\007'; tmux new-session -d -s '{}' -n '{}' \"zsh -l -c '{}'\"; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", esc_title_sq, esc_session, esc_display, claude_cli, esc_session, esc_session, esc_display, esc_session)
        };
        let cmd = format!("{}; {}", kill_cmd, new_cmd);
        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let cd_path = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .or_else(|| folder_path.clone())
            .map(|p| win_to_wsl_path(&p));
        let cd_part = cd_path.map(|p| format!("cd '{}' && ", escape_sq(&p))).unwrap_or_default();
        let claude_arg = if bypass { "claude --dangerously-skip-permissions || bash -l" } else { "claude || bash -l" };
        let bash_cmd = format!(
            "{}(tmux kill-session -t '{}' 2>/dev/null || :) && tmux new-session -s '{}' '{}'",
            cd_part, escape_sq(&session_id), escape_sq(&session_id), claude_arg
        );
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, bypass, true);
        spawn_wt_wsl(&bash_cmd, Some(&title))?;
    }

    Ok(format!("tmux 새 세션 시작 (세션: {}){}", session_id, launch_warning))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_tmux_claude_bypass(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, terminal_app: Option<String>) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    // -bypass 접미사를 포맷 문자열에 리터럴로 박아 두면 워크트리 접미사가 그 앞에
    // 끼어들 자리를 잃는다 — 이름 전체를 한 함수로 계산한다.
    #[allow(unused_variables)]
    let display_name = tmux_agent_session_name(&session_name, worktree_path.as_deref());
    let session_id = tmux_session_name(&session_name, worktree_path.as_deref(), true);
    #[cfg(target_os = "macos")]
    {
        let esc_session = escape_sq(&session_id);
        let esc_display = escape_sq(&display_name);
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, true, false);
        let esc_title_sq = escape_sq(&title);
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007'; tmux new-session -d -s '{}' -n '{}' \"zsh -l -c 'claude --dangerously-skip-permissions'\" 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", escape_sq(cd), esc_title_sq, esc_session, esc_display, esc_session, esc_session, esc_display, esc_session)
        } else {
            format!("printf '\\033]0;{}\\007'; tmux new-session -d -s '{}' -n '{}' \"zsh -l -c 'claude --dangerously-skip-permissions'\" 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", esc_title_sq, esc_session, esc_display, esc_session, esc_session, esc_display, esc_session)
        };
        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let cd_path = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .or_else(|| folder_path.clone())
            .map(|p| win_to_wsl_path(&p));
        let cd_part = cd_path.map(|p| format!("cd '{}' && ", escape_sq(&p))).unwrap_or_default();
        let bash_cmd = format!(
            "{}tmux new-session -A -s '{}' 'claude --dangerously-skip-permissions || bash -l'",
            cd_part, escape_sq(&session_id)
        );
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, true, false);
        spawn_wt_wsl(&bash_cmd, Some(&title))?;
    }

    Ok(format!("tmux + Claude (bypass) 실행 중 (세션: {}){}", session_id, launch_warning))
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
struct WindowsTerminalPlan {
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
}

#[cfg(any(target_os = "windows", test))]
fn windows_terminal_plan(
    windows_terminal_path: Option<&str>,
    shell_cmd: &str,
    work_dir: Option<&str>,
    title: &str,
) -> WindowsTerminalPlan {
    let work_dir = work_dir.map(str::trim).filter(|value| !value.is_empty());
    let inner = if work_dir.is_some() {
        r#"pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%"#
    } else {
        "%AGENTSTOZ_SHELL_COMMAND%"
    };
    let mut env = HashMap::new();
    if let Some(path) = work_dir { env.insert("AGENTSTOZ_WORK_DIR".to_string(), path.to_string()); }
    env.insert(
        "AGENTSTOZ_SHELL_COMMAND".to_string(),
        if shell_cmd.is_empty() { "rem".to_string() } else { shell_cmd.to_string() },
    );
    if let Some(path) = windows_terminal_path.map(str::trim).filter(|value| !value.is_empty()) {
        return WindowsTerminalPlan {
            program: path.to_string(),
            args: ["--title", title, "--", "cmd.exe", "/D", "/V:OFF", "/K", inner]
                .into_iter().map(str::to_string).collect(),
            env,
        };
    }
    let safe_title: String = title.chars()
        .map(|ch| if matches!(ch, '"' | '\r' | '\n') { ' ' } else { ch })
        .collect();
    env.insert("AGENTSTOZ_WINDOW_TITLE".to_string(), safe_title);
    WindowsTerminalPlan {
        program: "cmd.exe".to_string(),
        args: [
            "/D", "/V:OFF", "/K",
            if work_dir.is_some() {
                r#"title "%AGENTSTOZ_WINDOW_TITLE%" && pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%"#
            } else {
                r#"title "%AGENTSTOZ_WINDOW_TITLE%" && %AGENTSTOZ_SHELL_COMMAND%"#
            },
        ].into_iter().map(str::to_string).collect(),
        env,
    }
}

#[cfg(target_os = "windows")]
fn resolve_windows_terminal_path() -> Option<String> {
    let output = Command::new("where").arg("wt.exe").output().ok()?;
    if !output.status.success() { return None; }
    String::from_utf8_lossy(&output.stdout).lines()
        .map(str::trim).find(|line| !line.is_empty()).map(str::to_string)
}

/// Windows: launch a terminal without putting title/cwd values through an outer
/// `cmd /c start` parse. `pushd` supports UNC paths and env expansion is one pass.
#[cfg(target_os = "windows")]
fn spawn_wt_cmd(shell_cmd: &str, work_dir: Option<&str>, title: &str) -> Result<(), String> {
    let wt = resolve_windows_terminal_path();
    let plan = windows_terminal_plan(wt.as_deref(), shell_cmd, work_dir, title);
    Command::new(&plan.program)
        .args(&plan.args)
        .envs(&plan.env)
        .spawn()
        .map_err(|e| format!("Windows 터미널 실행 실패: {}", e))?;
    Ok(())
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_terminal_claude_bypass(folder_path: Option<String>, name: Option<String>, worktree_path: Option<String>, terminal_app: Option<String>) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    #[cfg(target_os = "macos")]
    {
        let title = build_window_title(name.as_deref().unwrap_or("Claude"), worktree_path.as_deref(), false, true, false);
        let esc_title_sq = escape_sq(&title);
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007' && claude --dangerously-skip-permissions", escape_sq(cd), esc_title_sq)
        } else {
            format!("printf '\\033]0;{}\\007' && claude --dangerously-skip-permissions", esc_title_sq)
        };
        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let wt_first = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| !p.is_empty() && is_absolute_path(p));
        let work_dir = wt_first.or_else(|| folder_path.clone());
        let title = build_window_title(name.as_deref().unwrap_or("Claude"), worktree_path.as_deref(), false, true, false);
        let claude_command = native_terminal_agent_command("claude", "--dangerously-skip-permissions");
        spawn_wt_cmd(&claude_command, work_dir.as_deref(), &title)?;
    }
    Ok(format!("Claude (bypass) 실행{}", launch_warning))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_terminal_claude(folder_path: Option<String>, name: Option<String>, worktree_path: Option<String>, terminal_app: Option<String>) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    #[cfg(target_os = "macos")]
    {
        let title = build_window_title(name.as_deref().unwrap_or("Claude"), worktree_path.as_deref(), false, false, false);
        let esc_title_sq = escape_sq(&title);
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007' && claude", escape_sq(cd), esc_title_sq)
        } else {
            format!("printf '\\033]0;{}\\007' && claude", esc_title_sq)
        };
        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let wt_first = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| !p.is_empty() && is_absolute_path(p));
        let work_dir = wt_first.or_else(|| folder_path.clone());
        let title = build_window_title(name.as_deref().unwrap_or("Claude"), worktree_path.as_deref(), false, false, false);
        let claude_command = native_terminal_agent_command("claude", "");
        spawn_wt_cmd(&claude_command, work_dir.as_deref(), &title)?;
    }
    Ok(format!("Claude 실행{}", launch_warning))
}

/// 공통: iTerm/wt 창에서 agent CLI(codex/agy 등) 실행 — open_terminal_claude 미러
fn open_terminal_agent(
    folder_path: Option<String>,
    name: Option<String>,
    worktree_path: Option<String>,
    bypass: bool,
    agent_cli: &str,
    default_name: &str,
    label: &str,
    terminal_app: Option<String>,
) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    #[cfg(target_os = "macos")]
    {
        let title = build_window_title(name.as_deref().unwrap_or(default_name), worktree_path.as_deref(), false, bypass, false);
        let esc_title_sq = escape_sq(&title);
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007' && {}", escape_sq(cd), esc_title_sq, agent_cli)
        } else {
            format!("printf '\\033]0;{}\\007' && {}", esc_title_sq, agent_cli)
        };
        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let wt_first = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| !p.is_empty() && is_absolute_path(p));
        let work_dir = wt_first.or_else(|| folder_path.clone());
        let title = build_window_title(name.as_deref().unwrap_or(default_name), worktree_path.as_deref(), false, bypass, false);
        spawn_wt_cmd(agent_cli, work_dir.as_deref(), &title)?;
    }
    Ok(format!("{}{} 실행{}", label, if bypass { " (bypass)" } else { "" }, launch_warning))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_terminal_codex(folder_path: Option<String>, name: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>) -> Result<String, String> {
    let bypass = bypass.unwrap_or(false);
    let agent_cli = native_terminal_agent_command("codex", if bypass { "--dangerously-bypass-approvals-and-sandbox" } else { "" });
    open_terminal_agent(folder_path, name, worktree_path, bypass, &agent_cli, "Codex", "Codex", terminal_app)
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_terminal_agy(folder_path: Option<String>, name: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>) -> Result<String, String> {
    let bypass = bypass.unwrap_or(false);
    let agent_cli = native_terminal_agent_command("agy", if bypass { "--dangerously-skip-permissions" } else { "" });
    open_terminal_agent(folder_path, name, worktree_path, bypass, &agent_cli, "Antigravity", "Antigravity", terminal_app)
}

#[tauri::command(async)]
fn open_terminal_hermes(folder_path: Option<String>, name: Option<String>, worktree_path: Option<String>, terminal_app: Option<String>) -> Result<String, String> {
    let agent_cli = native_terminal_agent_command("hermes", "");
    open_terminal_agent(folder_path, name, worktree_path, false, &agent_cli, "Hermes", "Hermes", terminal_app)
}

/// 공통: tmux 세션에서 agent CLI(codex/agy 등) 실행 — open_tmux_claude 미러
fn open_tmux_agent(
    session_name: String,
    folder_path: Option<String>,
    worktree_path: Option<String>,
    bypass: bool,
    agent_cli: &str,
    label: &str,
    terminal_app: Option<String>,
    fresh: bool,
) -> Result<String, String> {
    #[allow(unused_mut, unused_assignments)]
    let mut launch_warning = String::new();
    // Claude와 같은 규칙 — 예전엔 Codex/agy만 bare 이름을 써서 메인트리와 워크트리가
    // 한 세션을 공유했고 ⚡(bypass)가 일반 세션에 조용히 attach 됐다.
    #[allow(unused_variables)]
    let display_name = tmux_agent_session_name(&session_name, worktree_path.as_deref());
    let session_id = tmux_session_name(&session_name, worktree_path.as_deref(), bypass);
    #[cfg(target_os = "macos")]
    {
        let esc_session = escape_sq(&session_id);
        let esc_display = escape_sq(&display_name);
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, bypass, fresh);
        let esc_title_sq = escape_sq(&title);
        // "새 창"은 같은 이름의 기존 세션을 먼저 없애야 실제로 새 세션이 된다. 기본
        // 실행은 new-session 실패를 무시하고 attach — 있으면 기존 창, 없으면 새 창.
        let kill_prefix = if fresh {
            format!("tmux kill-session -t '{}' 2>/dev/null || true; ", esc_session)
        } else {
            String::new()
        };
        let cd_target = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .filter(|p| p.starts_with('/'))
            .or_else(|| folder_path.clone());
        let cmd = if let Some(ref cd) = cd_target {
            format!("cd '{}' && printf '\\033]0;{}\\007'; {}tmux new-session -d -s '{}' -n '{}' \"zsh -l -c '{}'\" 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", escape_sq(cd), esc_title_sq, kill_prefix, esc_session, esc_display, agent_cli, esc_session, esc_session, esc_display, esc_session)
        } else {
            format!("printf '\\033]0;{}\\007'; {}tmux new-session -d -s '{}' -n '{}' \"zsh -l -c '{}'\" 2>/dev/null || true; tmux set-option -g set-titles on 2>/dev/null; tmux set-option -g set-titles-string '#W' 2>/dev/null; tmux set-window-option -t '{}' automatic-rename off 2>/dev/null; tmux rename-window -t '{}' '{}' 2>/dev/null; tmux attach-session -t '{}'", esc_title_sq, kill_prefix, esc_session, esc_display, agent_cli, esc_session, esc_session, esc_display, esc_session)
        };
        launch_warning = launch_terminal_script(&cmd, terminal_app.as_deref())?.warning_suffix();
    }

    #[cfg(target_os = "windows")]
    {
        let cd_path = worktree_path.as_ref()
            .and_then(|wt| wt.split(',').next().map(|p| p.trim().to_string()))
            .or_else(|| folder_path.clone())
            .map(|p| win_to_wsl_path(&p));
        let cd_part = cd_path.map(|p| format!("cd '{}' && ", escape_sq(&p))).unwrap_or_default();
        let kill_part = if fresh {
            format!("tmux kill-session -t '{}' 2>/dev/null || true; ", escape_sq(&session_id))
        } else {
            String::new()
        };
        let bash_cmd = format!("{}{}tmux new-session -A -s '{}' '{} || bash -l'", cd_part, kill_part, escape_sq(&session_id), agent_cli);
        let title = build_window_title(&display_name, worktree_path.as_deref(), true, bypass, fresh);
        spawn_wt_wsl(&bash_cmd, Some(&title))?;
    }

    Ok(format!(
        "tmux + {} {} (세션: {}){}",
        label,
        if fresh { "새 세션 시작" } else { "실행 중" },
        session_id,
        launch_warning
    ))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_tmux_codex(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>, fresh: Option<bool>) -> Result<String, String> {
    let bypass = bypass.unwrap_or(false);
    let agent_cli = format!("{}{}", resolve_agent_bin("codex"), if bypass { " --dangerously-bypass-approvals-and-sandbox" } else { "" });
    open_tmux_agent(session_name, folder_path, worktree_path, bypass, &agent_cli, "Codex", terminal_app, fresh.unwrap_or(false))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_tmux_agy(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>, fresh: Option<bool>) -> Result<String, String> {
    let bypass = bypass.unwrap_or(false);
    let agent_cli = format!("{}{}", resolve_agent_bin("agy"), if bypass { " --dangerously-skip-permissions" } else { "" });
    open_tmux_agent(session_name, folder_path, worktree_path, bypass, &agent_cli, "Antigravity", terminal_app, fresh.unwrap_or(false))
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn run_claude_with_prompt(folder_path: Option<String>, prompt: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // 프롬프트를 CLI 인자로 직접 전달 — keystroke 주입(delay 후 write text) 방식은
        // claude가 늦게 뜨거나 없으면 프롬프트 텍스트가 셸 명령으로 실행되는 위험이 있음
        let cd_part = folder_path
            .as_deref()
            .map(|fp| format!("cd '{}' && ", escape_sq(fp)))
            .unwrap_or_default();
        let cmd = format!("{}claude '{}'", cd_part, escape_sq(&prompt));
        let outcome = open_iterm_with_script(&cmd)?;
        Ok(format!("iTerm에서 Claude 실행 (프롬프트 인자 전달){}", outcome.warning_suffix()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (folder_path, prompt);
        Err("macOS 전용 기능입니다".to_string())
    }
}

fn chrome_profile_directory_is_safe(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(|ch| ch.is_control())
}

fn discover_chrome_profiles_at(user_data_dir: &std::path::Path) -> Vec<BrowserProfile> {
    let raw = match fs::read_to_string(user_data_dir.join("Local State")) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let document: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(document) => document,
        Err(_) => return Vec::new(),
    };
    let info_cache = match document
        .pointer("/profile/info_cache")
        .and_then(|value| value.as_object())
    {
        Some(info_cache) => info_cache,
        None => return Vec::new(),
    };

    let mut profiles = info_cache
        .iter()
        .filter(|(directory, _)| {
            chrome_profile_directory_is_safe(directory)
                && user_data_dir.join(directory).is_dir()
        })
        .map(|(directory, value)| {
            let profile_name = value
                .get("name")
                .and_then(|name| name.as_str())
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(directory)
                .to_string();
            let account_label = value
                .get("user_name")
                .and_then(|account| account.as_str())
                .map(str::trim)
                .filter(|account| !account.is_empty())
                .map(str::to_string);
            BrowserProfile {
                id: format!("chrome:{}", directory),
                browser_id: "chrome".to_string(),
                browser_name: "Chrome".to_string(),
                profile_directory: directory.to_string(),
                profile_name,
                account_label,
            }
        })
        .collect::<Vec<_>>();
    profiles.sort_by(|left, right| {
        let rank = |directory: &str| if directory == "Default" { 0 } else { 1 };
        rank(&left.profile_directory)
            .cmp(&rank(&right.profile_directory))
            .then_with(|| left.profile_directory.cmp(&right.profile_directory))
    });
    profiles
}

fn chrome_user_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|home| {
            std::path::PathBuf::from(home)
                .join("Library/Application Support/Google/Chrome")
        });
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("LOCALAPPDATA").map(|base| {
            std::path::PathBuf::from(base).join("Google/Chrome/User Data")
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
            return Some(std::path::PathBuf::from(config).join("google-chrome"));
        }
        std::env::var_os("HOME").map(|home| {
            std::path::PathBuf::from(home).join(".config/google-chrome")
        })
    }
}

#[tauri::command]
fn list_browser_profiles() -> Result<Vec<BrowserProfile>, String> {
    Ok(chrome_user_data_dir()
        .as_deref()
        .map(discover_chrome_profiles_at)
        .unwrap_or_default())
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsBrowserLaunchPlan {
    program: String,
    args: Vec<String>,
}

#[cfg(any(target_os = "windows", test))]
fn windows_browser_launch_plan(
    url: &str,
    profile_directory: Option<&str>,
    chrome_executable: Option<&str>,
) -> Result<WindowsBrowserLaunchPlan, String> {
    if url.trim().is_empty() || url.chars().any(|character| character.is_control()) {
        return Err("열 URL이 비어 있거나 올바르지 않습니다.".to_string());
    }
    if let Some(profile) = profile_directory {
        let program = chrome_executable
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| "Chrome 실행 파일을 찾을 수 없습니다.".to_string())?;
        return Ok(WindowsBrowserLaunchPlan {
            program: program.to_string(),
            args: vec![format!("--profile-directory={}", profile), url.to_string()],
        });
    }
    if let Some(program) = chrome_executable.filter(|path| !path.trim().is_empty()) {
        return Ok(WindowsBrowserLaunchPlan {
            program: program.to_string(),
            args: vec![url.to_string()],
        });
    }
    Ok(WindowsBrowserLaunchPlan {
        program: "rundll32.exe".to_string(),
        args: vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
    })
}

#[cfg(target_os = "windows")]
fn windows_chrome_executable() -> Option<String> {
    for base in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(base) {
            let candidate = std::path::PathBuf::from(root)
                .join("Google/Chrome/Application/chrome.exe");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    let output = Command::new("where.exe").arg("chrome.exe").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[tauri::command]
fn open_in_chrome(url: String, profile_directory: Option<String>) -> Result<String, String> {
    if url.is_empty() {
        return Err("URL이 비어 있습니다".to_string());
    }

    if let Some(profile_directory) = profile_directory.as_deref() {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("프로필로 여는 URL은 http 또는 https 주소여야 합니다".to_string());
        }
        if !chrome_profile_directory_is_safe(profile_directory) {
            return Err("안전하지 않은 Chrome 프로필입니다".to_string());
        }
        let known = list_browser_profiles()?
            .into_iter()
            .any(|profile| profile.profile_directory == profile_directory);
        if !known {
            return Err("선택한 Chrome 프로필을 이 기기에서 찾을 수 없습니다. 배포 브라우저를 다시 선택해주세요.".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(profile_directory) = profile_directory.as_deref() {
            let user_executable = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .map(|home| home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
            let executable = user_executable
                .filter(|path| path.is_file())
                .unwrap_or_else(|| std::path::PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
            Command::new(executable)
                .arg(format!("--profile-directory={}", profile_directory))
                .arg(&url)
                .spawn()
                .map(reap_detached)
                .map_err(|e| format!("선택한 Chrome 프로필 열기 실패: {}", e))?;
        } else {
            Command::new("open")
                .arg("-a")
                .arg("Google Chrome")
                .arg(&url)
                .spawn()
                .map(reap_detached)
                .map_err(|e| format!("Chrome 열기 실패: {}", e))?;
        }
    }

    #[cfg(target_os = "windows")]
    {
        let chrome = windows_chrome_executable();
        let plan = windows_browser_launch_plan(&url, profile_directory.as_deref(), chrome.as_deref())?;
        Command::new(&plan.program)
            .args(&plan.args)
            .spawn()
            .map(reap_detached)
            .map_err(|e| format!("Chrome 열기 실패: {}", e))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut command = Command::new("google-chrome");
        if let Some(profile_directory) = profile_directory.as_deref() {
            command.arg(format!("--profile-directory={}", profile_directory));
        }
        command.arg(&url)
            .spawn()
            .map(reap_detached)
            .map_err(|e| format!("Chrome 열기 실패: {}", e))?;
    }

    Ok(format!("Chrome에서 열었습니다: {}", url))
}

#[tauri::command]
fn import_ports_from_file(file_path: String) -> Result<Vec<PortInfo>, String> {
    // 파일이 존재하는지 확인
    let path = std::path::PathBuf::from(&file_path);
    if !path.exists() {
        return Err("파일이 존재하지 않습니다".to_string());
    }

    // 파일 읽기
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("파일 읽기 실패: {}", e))?;

    // JSON 파싱
    let ports: Vec<PortInfo> = serde_json::from_str(&content)
        .map_err(|e| format!("JSON 파싱 실패: {}", e))?;

    Ok(ports)
}

#[tauri::command]
async fn build_app(build_type: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = ensure_app_data_dir(&app_handle)?
        .parent()
        .ok_or("Cannot get parent directory")?
        .parent()
        .ok_or("Cannot get project directory")?
        .to_path_buf();

    let command = if build_type == "dmg" {
        vec!["bun", "run", "tauri:build:dmg"]
    } else {
        vec!["bun", "run", "tauri:build"]
    };

    std::thread::spawn(move || {
        // 이미 백그라운드 스레드이므로 직접 wait()로 reap (좀비 방지)
        if let Ok(mut child) = Command::new(command[0])
            .args(&command[1..])
            .current_dir(app_dir)
            .spawn()
        {
            let _ = child.wait();
        }
    });

    Ok(format!("{} 빌드가 백그라운드에서 시작되었습니다", build_type))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WorktreeInfo {
    path: String,
    branch: Option<String>,
    /// Commit reported by `git worktree list --porcelain` (also available for detached HEAD).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    head: Option<String>,
    /// Git only sets this when porcelain explicitly reports `detached`; an absent branch in
    /// an unborn/bare repository is not silently treated as a branch named `main`.
    #[serde(default)]
    detached: bool,
    is_main: bool,
    #[serde(default)]
    locked: bool,
    #[serde(rename = "lockedReason", default, skip_serializing_if = "Option::is_none")]
    locked_reason: Option<String>,
    #[serde(rename = "aheadCount", default, skip_serializing_if = "Option::is_none")]
    ahead_count: Option<i64>,
    #[serde(rename = "changedFiles", default)]
    changed_files: i64,
    #[serde(rename = "stagedFiles", default)]
    staged_files: i64,
    #[serde(rename = "untrackedFiles", default)]
    untracked_files: i64,
    #[serde(rename = "conflictedFiles", default)]
    conflicted_files: i64,
    #[serde(rename = "hasCommits", default)]
    has_commits: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    #[serde(rename = "hasUpstream", default)]
    has_upstream: bool,
    #[serde(rename = "remoteBranchExists", default)]
    remote_branch_exists: bool,
    #[serde(rename = "githubConnected", default)]
    github_connected: bool,
    #[serde(default)]
    ahead: i64,
    #[serde(default)]
    behind: i64,
    #[serde(rename = "statusError", default, skip_serializing_if = "Option::is_none")]
    status_error: Option<String>,
    #[serde(rename = "remoteRefreshError", default, skip_serializing_if = "Option::is_none")]
    remote_refresh_error: Option<String>,
    /// 워크트리가 만들어진 시각 (ISO) — `.git` 표식의 생성 시각
    #[serde(rename = "createdAt", default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    /// 이 워크트리 브랜치의 마지막 커밋 시각 (ISO)
    #[serde(rename = "lastCommitAt", default, skip_serializing_if = "Option::is_none")]
    last_commit_at: Option<String>,
}

fn is_windows_drive_absolute(p: &str) -> bool {
    let bytes = p.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn has_unc_server_and_share(rest: &str) -> bool {
    let mut parts = rest.split(['\\', '/']).filter(|part| !part.is_empty());
    parts.next().is_some() && parts.next().is_some()
}

/// POSIX, drive-letter Windows, and UNC share paths are absolute. Windows
/// device namespaces (`\\.\...`) stay rejected; only filesystem forms used by
/// project folders and command files are accepted.
fn is_absolute_path(p: &str) -> bool {
    if p.starts_with('/') { return true; }
    if is_windows_drive_absolute(p) { return true; }
    if let Some(extended) = p.strip_prefix(r"\\?\") {
        if let Some(prefix) = extended.get(..4) {
            if prefix.eq_ignore_ascii_case("UNC\\") {
                return has_unc_server_and_share(&extended[4..]);
            }
        }
        return is_windows_drive_absolute(extended);
    }
    p.strip_prefix(r"\\")
        .filter(|rest| !rest.starts_with(r".\"))
        .is_some_and(has_unc_server_and_share)
}

/// 로그 파일명으로 사용하는 ID는 단일 안전 경로 세그먼트만 허용한다.
/// 경로 구분자, 유니코드 유사 문자, 제어문자를 모두 거부해 `logs/` 밖으로
/// 빠져나가는 경로 탐색과 플랫폼별 파일명 해석 차이를 막는다.
fn validate_log_id(port_id: &str) -> Result<(), String> {
    if port_id.is_empty() {
        return Err("port_id가 비어 있습니다.".to_string());
    }
    if port_id.len() > 128 {
        return Err("port_id는 128자를 넘을 수 없습니다.".to_string());
    }
    if !port_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("port_id에는 영문자, 숫자, '.', '_', '-'만 사용할 수 있습니다.".to_string());
    }
    Ok(())
}

/// 비교 전 절대경로를 어휘적으로 정규화한 뒤, 가장 가까운 기존 상위 경로를
/// canonicalize한다. 아직 생성되지 않은 대상도 비교하면서 `/var` → `/private/var`
/// 같은 심볼릭 링크 별칭으로 동일한 경로를 우회하는 경우도 정확히 판별한다.
fn normalized_absolute_path(path: &str) -> Result<std::path::PathBuf, String> {
    use std::path::{Component, Path, PathBuf};

    if !is_absolute_path(path) {
        return Err(format!("절대경로가 필요합니다: {}", path));
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("경로가 루트 밖으로 벗어납니다: {}", path));
                }
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    let mut existing = normalized.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Ok(normalized);
        };
        suffix.push(name.to_os_string());
        let Some(parent) = existing.parent() else {
            return Ok(normalized);
        };
        existing = parent;
    }
    let Ok(mut canonical) = std::fs::canonicalize(existing) else {
        return Ok(normalized);
    };
    for segment in suffix.iter().rev() {
        canonical.push(segment);
    }
    Ok(canonical)
}

fn normalized_path_key(path: &str) -> Result<String, String> {
    let value = normalized_absolute_path(path)?
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        Ok(value.to_ascii_lowercase())
    } else {
        Ok(value)
    }
}

#[derive(Debug, Clone)]
struct RegisteredWorktree {
    path: String,
    branch: Option<String>,
    locked: bool,
}

/// Git 자신이 등록한 워크트리만 신뢰한다. 호출자가 넘긴 경로에서 `.git` 파일을
/// 역추적하거나 상위 폴더를 추측하지 않는다.
fn registered_worktrees(folder_path: &str, git_bin: &str) -> Result<Vec<RegisteredWorktree>, String> {
    let output = Command::new(git_bin)
        .args(["worktree", "list", "--porcelain"])
        .current_dir(folder_path)
        .output()
        .map_err(|e| format!("git worktree list 실행 실패: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(stderr.if_empty_then("Git 워크트리 목록을 확인하지 못했습니다."));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut current_locked = false;
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(previous_path) = current_path.replace(path.to_string()) {
                entries.push(RegisteredWorktree {
                    path: previous_path,
                    branch: current_branch.take(),
                    locked: current_locked,
                });
            }
            current_locked = false;
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(branch.to_string());
        } else if line == "locked" || line.starts_with("locked ") {
            current_locked = true;
        }
    }
    if let Some(path) = current_path {
        entries.push(RegisteredWorktree {
            path,
            branch: current_branch,
            locked: current_locked,
        });
    }
    if entries.is_empty() {
        return Err("Git 저장소에 등록된 워크트리가 없습니다.".to_string());
    }
    Ok(entries)
}

/// 경로 basename (Windows \ 와 POSIX / 둘 다 지원)
fn path_basename(p: &str) -> &str {
    p.trim_end_matches(|c| c == '/' || c == '\\')
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("project")
}

fn is_github_remote_url(remote_url: &str) -> bool {
    let trimmed = remote_url.trim();
    if trimmed.to_ascii_lowercase().starts_with("git@github.com:") {
        return true;
    }
    let Some((_, remainder)) = trimmed.split_once("://") else {
        return false;
    };
    let authority = remainder.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    host.split(':').next().unwrap_or(host).eq_ignore_ascii_case("github.com")
}

#[tauri::command]
fn detect_git_remote_url(folder_path: String) -> Result<String, String> {
    if !is_absolute_path(&folder_path) {
        return Err("folder_path must be absolute".to_string());
    }
    let output = std::process::Command::new("git")
        .args(["remote", "-v"])
        .current_dir(&folder_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(error.if_empty_then("Git 저장소를 확인할 수 없습니다."));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut fallback: Option<String> = None;
    for line in stdout.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 || fields[2] != "(fetch)" {
            continue;
        }
        let remote_name = fields[0];
        let remote_url = fields[1];
        if !is_github_remote_url(remote_url) {
            continue;
        }
        if remote_name == "origin" {
            return Ok(remote_url.to_string());
        }
        if fallback.is_none() {
            fallback = Some(remote_url.to_string());
        }
    }
    fallback.ok_or_else(|| "연결된 GitHub 원격 저장소가 없습니다.".to_string())
}

fn git_auto_stage_exclusions() -> [&'static str; 10] {
    [
        ":(exclude).playwright-cli/**",
        ":(exclude)output/playwright/**",
        ":(exclude).DS_Store",
        ":(exclude)**/.DS_Store",
        ":(exclude).agent-memory/backups/**",
        // 활동 훅이 AI 프롬프트마다 다시 쓰는 런타임 상태 — 제외하지 않으면 AI를 한 번만
        // 써도 "커밋되지 않은 변경"이 생겨 워크트리 생성이 막힌다. git-worktree-status.ts의
        // GIT_VOLATILE_ARTIFACT_PATHSPECS와 목록이 일치해야 한다(웹/앱 동일 동작).
        ":(exclude).agent-memory/activity.json",
        ":(exclude).env",
        ":(exclude).env.*",
        ":(exclude)**/.env",
        ":(exclude)**/.env.*",
    ]
}

fn create_initial_snapshot_commit(folder_path: &str, git_bin: &str) -> Result<(), String> {
    let mut add_args = vec!["add", "-A", "--", "."];
    add_args.extend(git_auto_stage_exclusions());
    let add = Command::new(git_bin).args(&add_args).current_dir(folder_path).output()
        .map_err(|e| format!("초기 프로젝트 파일 스테이징 실패: {}", e))?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string()
            .if_empty_then("초기 프로젝트 파일을 스테이징하지 못했습니다."));
    }
    let commit = Command::new(git_bin)
        .args(["commit", "--allow-empty", "-m", "Initial commit"])
        .current_dir(folder_path)
        .output()
        .map_err(|e| format!("초기 커밋 실패: {}", e))?;
    if !commit.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&commit.stdout),
            String::from_utf8_lossy(&commit.stderr),
        ).trim().to_string();
        return Err(detail.if_empty_then("초기 커밋을 만들지 못했습니다."));
    }
    Ok(())
}

fn ensure_local_worktree_exclude(folder_path: &str, git_bin: &str) -> Result<(), String> {
    let result = Command::new(git_bin)
        .args(["rev-parse", "--git-path", "info/exclude"])
        .current_dir(folder_path)
        .output()
        .map_err(|e| format!("Git exclude 경로 확인 실패: {}", e))?;
    if !result.status.success() { return Ok(()); }
    let raw = String::from_utf8_lossy(&result.stdout).trim().to_string();
    if raw.is_empty() { return Ok(()); }
    let raw_path = std::path::PathBuf::from(raw);
    let exclude_path = if raw_path.is_absolute() {
        raw_path
    } else {
        std::path::Path::new(folder_path).join(raw_path)
    };
    let patterns = ["/.claude/worktrees/", "/worktrees/", ".DS_Store", "/.agent-memory/backups/"];
    let content = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let missing: Vec<&str> = patterns.into_iter()
        .filter(|pattern| !content.lines().any(|line| line.trim() == *pattern))
        .collect();
    if missing.is_empty() { return Ok(()); }
    if let Some(parent) = exclude_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Git exclude 폴더 생성 실패: {}", e))?;
    }
    let suffix = format!("{}\n", missing.join("\n"));
    let next = if content.is_empty() { suffix } else { format!("{}\n{}", content.trim_end(), suffix) };
    std::fs::write(&exclude_path, next).map_err(|e| format!("Git exclude 저장 실패: {}", e))
}

#[tauri::command(async)]
fn git_init(folder_path: String, check_only: bool) -> Result<serde_json::Value, String> {
    use std::process::Command;
    if !is_absolute_path(&folder_path) {
        return Err("folder_path must be absolute".to_string());
    }
    let project_path = std::path::Path::new(&folder_path);
    if !project_path.exists() || !project_path.is_dir() {
        return Err(format!("프로젝트 폴더가 없습니다: {}", folder_path));
    }
    // is it already a git repo?
    let git_bin = resolve_bin("git");
    let check = Command::new(&git_bin).args(["rev-parse", "--git-dir"])
        .current_dir(&folder_path).output().map_err(|e| e.to_string())?;
    let is_git = check.status.success();
    if is_git {
        let log = Command::new(&git_bin).args(["log", "--oneline", "-1"])
            .current_dir(&folder_path).output().map_err(|e| e.to_string())?;
        let has_commit = log.status.success();
        if check_only {
            return Ok(serde_json::json!({ "alreadyGit": true, "hasCommit": has_commit }));
        }
        if has_commit {
            return Ok(serde_json::json!({ "alreadyGit": true, "hasCommit": true }));
        }
        create_initial_snapshot_commit(&folder_path, &git_bin)?;
        return Ok(serde_json::json!({ "alreadyGit": true, "hasCommit": true }));
    }
    if check_only {
        return Ok(serde_json::json!({ "alreadyGit": false, "hasCommit": false }));
    }
    let init = Command::new(&git_bin).args(["init"]).current_dir(&folder_path).output().map_err(|e| e.to_string())?;
    if !init.status.success() {
        let err = String::from_utf8_lossy(&init.stderr).trim().to_string();
        return Err(err.if_empty_then("git init failed"));
    }
    create_initial_snapshot_commit(&folder_path, &git_bin)?;
    Ok(serde_json::json!({ "initialized": true, "hasCommit": true }))
}

#[tauri::command]
fn git_reinitialize(folder_path: String, confirmed: bool) -> Result<serde_json::Value, String> {
    if !is_absolute_path(&folder_path) {
        return Err("folder_path must be absolute".to_string());
    }
    let project_path = std::path::Path::new(&folder_path);
    if !project_path.exists() || !project_path.is_dir() {
        return Err(format!("프로젝트 폴더가 없습니다: {}", folder_path));
    }
    if !confirmed {
        return Err("explicit confirmation required".to_string());
    }
    let git_path = std::path::Path::new(&folder_path).join(".git");
    if git_path.exists() {
        let metadata = std::fs::symlink_metadata(&git_path).map_err(|e| e.to_string())?;
        // .git 파일은 다른 저장소에 연결된 worktree이므로 원본 저장소 보호를 위해 거부한다.
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Git worktree 또는 심볼릭 링크는 초기화할 수 없습니다.".to_string());
        }
        std::fs::remove_dir_all(&git_path).map_err(|e| format!("기존 .git 제거 실패: {}", e))?;
    }
    let git_bin = resolve_bin("git");
    let init = Command::new(&git_bin).args(["init"]).current_dir(&folder_path).output().map_err(|e| e.to_string())?;
    if !init.status.success() {
        let err = String::from_utf8_lossy(&init.stderr).trim().to_string();
        return Err(err.if_empty_then("git init failed"));
    }
    create_initial_snapshot_commit(&folder_path, &git_bin)?;
    Ok(serde_json::json!({ "initialized": true, "hasCommit": true }))
}

trait IfEmptyThen {
    fn if_empty_then(self, fallback: &str) -> String;
}
impl IfEmptyThen for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() { fallback.to_string() } else { self }
    }
}

#[tauri::command(async)]
fn git_worktree_add(folder_path: String, branch_name: String, worktree_path: Option<String>, orca_managed: Option<bool>) -> Result<serde_json::Value, String> {
    if !is_absolute_path(&folder_path) {
        return Err("folder_path must be absolute".to_string());
    }
    if !std::path::Path::new(&folder_path).is_dir() {
        return Err(format!("Git 저장소 폴더가 없습니다: {}", folder_path));
    }
    // A linked worktree contains only committed Git state. Creating one while the
    // visible main tree is dirty makes it look as if the app opened the wrong
    // project (and can omit AGENTS/CLAUDE/project-memory files entirely).
    let git_bin = resolve_bin("git");
    let registered = registered_worktrees(&folder_path, &git_bin)?;
    // `git worktree list --porcelain`의 첫 항목이 primary worktree다. 호출이 어느
    // 연결 워크트리에서 시작됐든 새 워크트리는 항상 primary 옆에 생성한다.
    let primary_path = registered[0].path.clone();
    if !std::path::Path::new(&primary_path).is_dir() {
        return Err(format!("메인 워크트리 폴더가 없습니다: {}", primary_path));
    }
    ensure_local_worktree_exclude(&primary_path, &git_bin)?;
    let mut source_status_args = vec!["status", "--porcelain=v1", "--untracked-files=all", "--", "."];
    source_status_args.extend(git_auto_stage_exclusions());
    let source_status = Command::new(&git_bin)
        .args(&source_status_args)
        .current_dir(&primary_path)
        .output()
        .map_err(|e| format!("Git 상태 확인 실패: {}", e))?;
    if !source_status.status.success() {
        return Err(String::from_utf8_lossy(&source_status.stderr).trim().to_string()
            .if_empty_then("Git 상태를 확인하지 못했습니다."));
    }
    let source_stdout = String::from_utf8_lossy(&source_status.stdout);
    let source_changes: Vec<&str> = source_stdout
        .lines()
        .filter(|line| {
            let path = line.get(3..).unwrap_or(line).trim_matches('"');
            !path.is_empty()
                && !path.starts_with(".claude/worktrees/")
                && !path.starts_with("worktrees/")
        })
        .collect();
    if !source_changes.is_empty() {
        return Err(format!(
            "메인트리에 커밋되지 않은 변경 {}개가 있습니다. main의 커밋을 완료한 뒤 워크트리를 만드세요.",
            source_changes.len()
        ));
    }
    // Allow Unicode branch names — only strip truly invalid git branch chars
    let safe_branch: String = branch_name.chars()
        .map(|c| if c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\') { '-' } else { c })
        .collect();
    let safe_branch = safe_branch.trim_matches('-').to_string();
    // Directory name must be ASCII-only — claude -w rejects non-ASCII paths
    let dir_safe_branch: String = safe_branch.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let dir_safe_branch = dir_safe_branch.trim_matches('-').to_string();
    let dir_safe_branch = if dir_safe_branch.is_empty() {
        format!("wt{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() % 1000000)
    } else { dir_safe_branch };
    if orca_managed.unwrap_or(false) {
        if worktree_path.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_some() {
            return Err("Orca 관리 워크트리는 Orca가 안전한 경로를 선택하므로 별도 worktreePath를 지정할 수 없습니다.".into());
        }
        if let Some(existing) = registered.iter().find(|entry| entry.branch.as_deref() == Some(safe_branch.as_str())) {
            return Err(format!("브랜치 '{}'가 이미 다른 워크트리에서 사용 중입니다: {}", safe_branch, existing.path));
        }
        let branch_exists = Command::new(&git_bin)
            .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", safe_branch)])
            .current_dir(&primary_path)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        let managed_name = if branch_exists {
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() % 100_000;
            format!("{}-{:x}", dir_safe_branch, suffix)
        } else {
            dir_safe_branch.clone()
        };
        // 주 워크트리의 현재 브랜치를 base로 쓴다. detached HEAD 등으로 이름을 못 얻었을 때
        // "main" 문자열로 넘기면 사용자가 보고 있는 커밋이 아니라 엉뚱한 곳에서 갈라진다.
        let base_branch = registered
            .first()
            .and_then(|entry| entry.branch.clone())
            .ok_or_else(|| "주 워크트리가 브랜치에 있지 않아(detached HEAD 등) Orca 관리 워크트리의 기준 브랜치를 정할 수 없습니다. 브랜치를 체크아웃한 뒤 다시 시도해주세요.".to_string())?;
        let cli = resolve_orca_cli().ok_or_else(bootstrap_orca_install)?;
        let _guard = ORCA_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        orca_ensure_ready(&cli)?;
        orca_run_json_retry(&cli, &["repo", "add", "--path", &primary_path], 3, ORCA_TIMEOUT_MS, ORCA_BACKOFF_MS)
            .map_err(|error| format!("Orca repo 등록 실패: {}", error))?;
        let created = orca_run_json_retry(
            &cli,
            &[
                "worktree", "create",
                "--repo", &format!("path:{}", primary_path),
                "--name", &managed_name,
                "--base-branch", &base_branch,
                "--setup", "inherit",
                "--no-parent",
            ],
            2,
            30_000,
            700,
        ).map_err(|error| format!("Orca 관리 워크트리 생성 실패: {}", error))?;
        let created_path = created.pointer("/result/worktree/path")
            .and_then(|value| value.as_str())
            .filter(|value| std::path::Path::new(value).is_dir())
            .ok_or_else(|| "Orca 관리 워크트리 생성 경로를 확인하지 못했습니다.".to_string())?
            .to_string();
        let created_branch = created.pointer("/result/worktree/branch")
            .and_then(|value| value.as_str())
            .unwrap_or(&managed_name)
            .trim_start_matches("refs/heads/")
            .to_string();
        let repo_selector = format!("path:{}", primary_path);
        let listed = orca_run_json_retry(
            &cli,
            &["worktree", "list", "--repo", &repo_selector],
            3,
            10_000,
            300,
        );
        let created_key = normalized_path_key(&created_path)?;
        let path_in_list = |listed: &Result<serde_json::Value, String>| -> bool {
            listed.as_ref().ok()
            .and_then(|value| value.pointer("/result/worktrees"))
            .and_then(|value| value.as_array())
            .map(|items| items.iter().any(|item| {
                item.get("path").and_then(|value| value.as_str())
                    .and_then(|path| normalized_path_key(path).ok())
                    .as_deref() == Some(created_key.as_str())
            }))
            .unwrap_or(false)
        };
        // ⚠️ "안 보임"으로 잘못 판정하면 **방금 만든 워크트리를 지운다.** 목록 반영이
        // 늦을 수 있으므로 등장할 때까지 몇 번 더 조회한다.
        let mut visible = path_in_list(&listed);
        for attempt in 1..4u64 {
            if visible { break; }
            std::thread::sleep(std::time::Duration::from_millis(400 * attempt));
            visible = path_in_list(&orca_run_json_retry(
                &cli,
                &["worktree", "list", "--repo", &repo_selector],
                2,
                10_000,
                300,
            ));
        }
        if !visible {
            let selector = format!("path:{}", created_path);
            let _ = orca_run_json(&cli, &["worktree", "rm", "--worktree", &selector, "--force"], ORCA_TIMEOUT_MS);
            return Err("워크트리는 만들어졌지만 Orca 목록 노출을 확인하지 못해 생성 작업을 되돌렸습니다.".into());
        }
        seed_worktree_local_config(&primary_path, &created_path);
        spawn_dependency_install(&created_path);
        return Ok(serde_json::json!({
            "path": created_path,
            "branch": created_branch,
            "orcaManaged": true,
            // `renamedFrom`은 UI에서 "옛 브랜치에 main에 없는 커밋이 있어 보존했다"는 뜻이라
            // 여기 쓰면 거짓말이 된다. Orca가 이름을 정하므로(ASCII 강제, 중복 시 접미사)
            // 사용자가 입력한 이름과 다를 때만 그 사실을 알린다.
            "requestedBranch": if created_branch == safe_branch { None::<String> } else { Some(safe_branch) },
        }));
    }
    // ⚠️ `.claude/` 같은 숨김 폴더 아래면 Orca가 스캔에서 제외된다. 또한 현재
    // 워크트리를 기준으로 경로를 만들면 `worktrees/a/worktrees/b`처럼 중첩된다.
    // 서버가 primary 기준의 단일 대상만 계산하고 호출자 지정 경로는 정확히 일치할
    // 때만 받아들인다.
    let expected_target = std::path::Path::new(&primary_path)
        .join("worktrees")
        .join(&dir_safe_branch)
        .to_string_lossy()
        .to_string();
    if let Some(supplied_target) = worktree_path.as_deref().filter(|path| !path.is_empty()) {
        let supplied_key = normalized_path_key(supplied_target)?;
        let expected_key = normalized_path_key(&expected_target)?;
        if supplied_key != expected_key {
            return Err(format!(
                "워크트리 경로는 메인 저장소 기준 경로만 사용할 수 있습니다: {}",
                expected_target
            ));
        }
    }
    let target = expected_target;
    // 워크트리 없이 브랜치만 남아있는 경우(과거 워크트리를 지웠지만 브랜치는 그대로) 그대로
    // 재사용하면, main이 그 뒤로 아무리 진행돼도 항상 그 시점 스냅샷으로 고정된 워크트리가
    // 만들어져 "지우고 다시 만들어도 계속 오래된 상태"인 버그가 재현된다(장기기억 설정
    // 누락 등). main에 이미 반영된(ancestor) 브랜치라면 잃을 게 없으니 HEAD로 안전하게
    // 되감고, main에 없는 고유 커밋이 있다면(진짜 진행 중이던 작업) 건드리지 않고 새
    // 이름으로 우회한다.
    let mut effective_branch = branch_name.clone();
    let mut renamed_from: Option<String> = None;
    let branch_exists = Command::new(&git_bin)
        .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", effective_branch)])
        .current_dir(&primary_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if branch_exists {
        let is_ancestor = Command::new(&git_bin)
            .args(["merge-base", "--is-ancestor", &effective_branch, "HEAD"])
            .current_dir(&primary_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if is_ancestor {
            let _ = Command::new(&git_bin)
                .args(["branch", "-f", &effective_branch, "HEAD"])
                .current_dir(&primary_path)
                .output();
        } else {
            renamed_from = Some(effective_branch.clone());
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() % 100_000_000;
            effective_branch = format!("{}-{:x}", effective_branch, suffix);
        }
    }
    // Use --no-checkout on iCloud paths to avoid SIGBUS (signal 10)
    let is_icloud = primary_path.contains("com~apple~CloudDocs") || primary_path.contains("Mobile Documents");
    let mut base_args: Vec<&str> = vec!["worktree", "add"];
    if is_icloud { base_args.push("--no-checkout"); }
    // Try existing branch first
    let mut args1 = base_args.clone();
    args1.extend([target.as_str(), effective_branch.as_str()]);
    let output = Command::new(&git_bin)
        .args(&args1)
        .current_dir(&primary_path)
        .output()
        .map_err(|e| format!("git not found: {}", e))?;
    if output.status.success() {
        seed_worktree_local_config(&primary_path, &target);
        spawn_dependency_install(&target);
        return Ok(serde_json::json!({ "path": target, "branch": effective_branch, "renamedFrom": renamed_from }));
    }
    // Fallback: create new branch
    let mut args2 = base_args.clone();
    args2.extend(["-b", effective_branch.as_str(), target.as_str()]);
    let output2 = Command::new(&git_bin)
        .args(&args2)
        .current_dir(&primary_path)
        .output()
        .map_err(|e| format!("git not found: {}", e))?;
    if !output2.status.success() {
        return Err(String::from_utf8_lossy(&output2.stderr).trim().to_string());
    }
    seed_worktree_local_config(&primary_path, &target);
    spawn_dependency_install(&target);
    Ok(serde_json::json!({ "path": target, "branch": effective_branch, "renamedFrom": renamed_from }))
}

/// 의존성 매니저 결정: (program, args, 설치 완료 여부를 나타내는 marker 경로).
/// node → bun install (marker: node_modules/.bin), python → uv sync (marker: .venv).
fn dependency_installer(target: &str) -> Option<(&'static str, &'static [&'static str], std::path::PathBuf)> {
    let path = std::path::Path::new(target);
    if path.join("package.json").exists() {
        Some(("bun", &["install"], path.join("node_modules").join(".bin")))
    } else if path.join("pyproject.toml").exists() {
        Some(("uv", &["sync"], path.join(".venv")))
    } else {
        None
    }
}

/// bare 프로그램명을 절대경로로 해석 — Finder 실행(GUI PATH desert)에서도 bun/uv를 찾도록.
/// build_path_env()의 후보 디렉토리에서 실행 파일을 찾고, 없으면 원래 이름을 그대로 반환.
fn resolve_bin(program: &str) -> String {
    let path_str = build_path_env();
    let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
    for dir in path_str.split(sep) {
        if dir.is_empty() { continue; }
        let candidate = std::path::Path::new(dir).join(program);
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
        // On Windows also check with .exe extension
        #[cfg(target_os = "windows")]
        {
            let candidate_exe = std::path::Path::new(dir).join(format!("{}.exe", program));
            if candidate_exe.is_file() {
                return candidate_exe.to_string_lossy().to_string();
            }
        }
    }
    program.to_string()
}

/// 에이전트 CLI(codex / agy / claude)를 절대경로로 해석한다.
/// ⚠️ agy는 `~/.local/bin`에 설치되는데 이 경로는 GUI 실행(PATH desert)에도,
/// Orca/cmux가 띄우는 셸의 PATH에도 없다 — bare `agy`를 보내면 "command not found"로
/// 조용히 실패한다. 알려진 설치 경로를 먼저 훑고, 없으면 resolve_bin()(login shell PATH
/// 기반 탐색)으로 폴백, 그래도 없으면 원래 이름을 그대로 반환한다.
fn resolve_agent_bin(name: &str) -> String {
    use std::path::Path;
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
        let mut candidates = Vec::new();
        match name {
            "claude" => {
                if !user_profile.is_empty() {
                    candidates.push(Path::new(&user_profile).join(".local/bin/claude.exe"));
                }
                candidates.push(Path::new(&appdata).join("npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
                candidates.push(Path::new(&appdata).join("npm/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe"));
            }
            "agy" => candidates.push(Path::new(&localappdata).join("agy/bin/agy.exe")),
            "hermes" => {
                let hermes_home = std::env::var("HERMES_HOME")
                    .unwrap_or_else(|_| Path::new(&localappdata).join("hermes").to_string_lossy().to_string());
                candidates.push(Path::new(&hermes_home).join("hermes-agent/bin/hermes.exe"));
                candidates.push(Path::new(&hermes_home).join("hermes-agent/venv/Scripts/hermes.exe"));
            }
            _ => {}
        }
        for candidate in candidates {
            if candidate.is_file() { return candidate.to_string_lossy().to_string(); }
        }

        if let Ok(output) = Command::new("where").arg(name).output() {
            let arch = if cfg!(target_arch = "aarch64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" };
            let package = if cfg!(target_arch = "aarch64") { "codex-win32-arm64" } else { "codex-win32-x64" };
            for line in String::from_utf8_lossy(&output.stdout).lines().map(str::trim).filter(|line| !line.is_empty()) {
                let path = Path::new(line);
                if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("exe")) == Some(true) && path.is_file() {
                    return path.to_string_lossy().to_string();
                }
                if name == "codex" {
                    let shim_dir = path.parent().unwrap_or_else(|| Path::new(""));
                    let node_modules = if shim_dir.file_name().and_then(|v| v.to_str()) == Some(".bin") {
                        shim_dir.parent().unwrap_or(shim_dir)
                    } else { shim_dir };
                    let candidate = node_modules.join("@openai").join(package).join("vendor").join(arch).join("bin/codex.exe");
                    if candidate.is_file() { return candidate.to_string_lossy().to_string(); }
                }
            }
        }
        return name.to_string();
    }

    #[cfg(not(target_os = "windows"))]
    {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates = vec![
        format!("{}/.local/bin/{}", home, name),
        format!("/opt/homebrew/bin/{}", name),
        format!("/usr/local/bin/{}", name),
        format!("{}/.bun/bin/{}", home, name),
        format!("{}/.npm-global/bin/{}", home, name),
        format!("{}/.volta/bin/{}", home, name),
    ];
    // The ChatGPT desktop app (and the legacy Codex app) bundle the Codex CLI outside
    // every conventional package-manager path. Finder-launched Tauri apps do not inherit
    // the interactive shell PATH that normally points at this executable.
    if name == "codex" {
        candidates.insert(0, "/Applications/ChatGPT.app/Contents/Resources/codex".to_string());
        candidates.insert(1, "/Applications/Codex.app/Contents/Resources/codex".to_string());
    }
    for c in candidates.iter() {
        if Path::new(c).is_file() { return c.clone(); }
    }
    let resolved = resolve_bin(name);
    if resolved != name && Path::new(&resolved).is_file() {
        return resolved;
    }
    // Keep the Tauri path resolver in parity with api-server.ts. User-managed installs
    // (mise/asdf/nvm, custom aliases exported as PATH entries, etc.) may only become
    // visible after the login profile is sourced.
    if let Ok(output) = Command::new("/bin/zsh")
        .args(["-l", "-c", &format!("command -v -- {}", name)])
        .output()
    {
        if output.status.success() {
            if let Some(found) = String::from_utf8_lossy(&output.stdout).lines().next().map(str::trim) {
                if Path::new(found).is_file() { return found.to_string(); }
            }
        }
    }
    name.to_string()
    }
}

/// 대화형 셸에 그대로 입력될 문자열이므로, 쿼팅이 필요한 문자가 있으면 싱글쿼트로 감싼다.
fn shell_quote_if_needed(s: &str) -> String {
    let safe = !s.is_empty() && s.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+' | '=' | ':' | ',' | '@' | '%')
    });
    if safe { s.to_string() } else { format!("'{}'", s.replace('\'', "'\\''")) }
}

#[cfg(any(target_os = "windows", test))]
fn windows_cmd_agent_command(executable: &str, arguments: &str) -> String {
    let executable = format!("\"{}\"", executable.replace('"', "\"\""));
    if arguments.trim().is_empty() {
        executable
    } else {
        format!("{} {}", executable, arguments.trim())
    }
}

fn native_terminal_agent_command(name: &str, arguments: &str) -> String {
    let executable = resolve_agent_bin(name);
    #[cfg(target_os = "windows")]
    {
        let command = windows_cmd_agent_command(&executable, arguments);
        if name == "codex" { format!("set \"CODEX_HOME=\" && {}", command) } else { command }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let executable = shell_quote_if_needed(&executable);
        if arguments.trim().is_empty() { executable } else { format!("{} {}", executable, arguments.trim()) }
    }
}

#[cfg(target_os = "windows")]
fn orca_agent_command(bin: &str, flag: &str, bypass: bool, use_wsl_shell: bool) -> Option<String> {
    let path = resolve_agent_bin(bin);
    if path == bin { return None; }
    let base = if use_wsl_shell {
        let executable = shell_quote_if_needed(&win_to_wsl_path(&path));
        if bin == "codex" { format!("env -u CODEX_HOME {}", executable) } else { executable }
    } else {
        let executable = format!("\"{}\"", path.replace('"', "\"\""));
        if bin == "codex" { format!("set \"CODEX_HOME=\" && {}", executable) } else { executable }
    };
    Some(if bypass { format!("{} {}", base, flag) } else { base })
}

#[cfg(not(target_os = "windows"))]
fn orca_agent_command(bin: &str, flag: &str, bypass: bool, _use_wsl_shell: bool) -> Option<String> {
    let path = resolve_agent_bin(bin);
    if path == bin || !std::path::Path::new(&path).is_file() { return None; }
    let executable = shell_quote_if_needed(&path);
    Some(if bypass { format!("{} {}", executable, flag) } else { executable })
}

#[cfg(target_os = "windows")]
fn build_orca_terminal_command(cd_path: &str, command: Option<&str>, use_wsl_shell: bool) -> String {
    if use_wsl_shell {
        let cd = format!("cd '{}'", escape_sq(&win_to_wsl_path(cd_path)));
        command.map(|value| format!("{} && {}", cd, value)).unwrap_or(cd)
    } else {
        let cd = format!("cd /d \"{}\"", cd_path.replace('"', "\"\""));
        command.map(|value| format!("{} && {}", cd, value)).unwrap_or(cd)
    }
}

#[cfg(not(target_os = "windows"))]
fn build_orca_terminal_command(cd_path: &str, command: Option<&str>, _use_wsl_shell: bool) -> String {
    let cd = format!("cd '{}'", escape_sq(cd_path));
    command.map(|value| format!("{} && {}", cd, value)).unwrap_or(cd)
}

// 새 워크트리에는 node_modules/.venv가 없어 dev 서버가 즉시 ENOENT로 죽는 문제를 방지 —
// 워크트리 생성 직후 백그라운드로 의존성 설치를 미리 시작해둔다 (실행 버튼을 기다리지 않음).
// ⚠️ Finder 실행(Tauri GUI)은 최소 PATH(/usr/bin:/bin)라 bare `bun`/`uv`가 ENOENT로 조용히 실패한다 —
// 반드시 build_path_env()로 PATH를 보강하고 절대경로로 실행해야 한다 (CEO 노하우 #17).
/// 링크된 워크트리에는 **커밋된 파일만** 실체화된다 — .gitignore된 로컬 설정은 따라오지 않는다.
/// 그래서 Codex는 `.codex/hooks.json`이 추적 파일이라 워크트리에서도 멀쩡한데, Claude는
/// `.claude/`가 gitignore라 활동 훅(settings.json)·권한 허용목록(settings.local.json)·
/// 스킬(/remember-session)이 통째로 빠진 반쪽 상태로 뜬다. `.env`도 마찬가지로 빠진다.
///
/// node_modules를 자동 설치해주는 것과 같은 취지로 메인의 로컬 설정을 워크트리에 심는다.
/// 이미 있는 파일은 덮어쓰지 않는다(워크트리에서 수정했을 수 있음).
/// `.claude/worktrees/`는 반드시 제외한다 — 워크트리 자신이 그 아래 있어 재귀 복사가 된다.
/// api-server.ts의 seedWorktreeLocalConfig()와 동작이 일치해야 한다(웹/앱 모드 동일 결과).
fn seed_worktree_local_config(main_path: &str, target_path: &str) {
    fn copy_tree(src: &std::path::Path, dest: &std::path::Path, depth: usize) {
        if depth > 8 { return; }
        let Ok(entries) = fs::read_dir(src) else { return; };
        for entry in entries.flatten() {
            let name = entry.file_name();
            // depth 0 == .claude 바로 아래. 여기의 worktrees/ 가 재귀의 원인이다.
            if depth == 0 && name == std::ffi::OsStr::new("worktrees") { continue; }
            let Ok(file_type) = entry.file_type() else { continue; };
            let to = dest.join(&name);
            if file_type.is_dir() {
                if fs::create_dir_all(&to).is_err() { continue; }
                copy_tree(&entry.path(), &to, depth + 1);
            } else if file_type.is_file() && !to.exists() {
                let _ = fs::copy(entry.path(), &to);
            }
        }
    }
    let claude_src = std::path::Path::new(main_path).join(".claude");
    if claude_src.is_dir() {
        let claude_dest = std::path::Path::new(target_path).join(".claude");
        if fs::create_dir_all(&claude_dest).is_ok() {
            copy_tree(&claude_src, &claude_dest, 0);
        }
    }
    if let Ok(entries) = fs::read_dir(main_path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else { continue; };
            if name_str != ".env" && !name_str.starts_with(".env.") { continue; }
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
            let to = std::path::Path::new(target_path).join(name_str);
            if !to.exists() { let _ = fs::copy(entry.path(), &to); }
        }
    }
}

fn spawn_dependency_install(target: &str) {
    let Some((program, args, _marker)) = dependency_installer(target) else { return; };
    let _ = Command::new(resolve_bin(program))
        .args(args)
        .current_dir(target)
        .env("PATH", build_path_env())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// 실행(execute) 직전 self-heal: 의존성 marker(node_modules/.bin 또는 .venv)가 없으면
/// 동기적으로 설치를 마친 뒤 리턴한다. 백그라운드 설치 실패/미완료/기존 깨진 워크트리를 모두 복구.
/// 이미 설치돼 있으면 즉시 리턴(비용 0). 설치 실패해도 실행은 계속(에러 삼키지 않고 로그만).
fn ensure_dependencies_sync(target: &str) {
    let Some((program, args, marker)) = dependency_installer(target) else { return; };
    if marker.exists() { return; }
    println!("[ensure_deps] {} 의존성 없음 → {} {:?} 동기 실행", target, program, args);
    match Command::new(resolve_bin(program))
        .args(args)
        .current_dir(target)
        .env("PATH", build_path_env())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(st) => println!("[ensure_deps] 완료 status={:?} marker_exists={}", st.code(), marker.exists()),
        Err(e) => println!("[ensure_deps] 설치 실패(무시하고 실행 계속): {}", e),
    }
}

/// 레거시(숨김) `.claude/worktrees/<name>` 워크트리를 현행 비숨김 `worktrees/<name>` 로 이동.
/// 대상 경로는 **여기서 재계산**한다(호출자 값 신뢰 금지). api-server.ts 의
/// `/api/move-git-worktree` 와 동작이 일치해야 한다(웹/앱 동일 결과).
#[tauri::command(async)]
fn git_worktree_move(folder_path: String, from: String) -> Result<serde_json::Value, String> {
    if !is_absolute_path(&folder_path) || !is_absolute_path(&from) {
        return Err("folderPath/from 절대경로가 필요합니다.".to_string());
    }
    let norm = |v: &str| v.replace('\\', "/").trim_end_matches('/').to_string();
    let root = norm(&folder_path);
    let src = norm(&from);
    // 앱이 만든 레거시 워크트리만 이동 허용 — Orca/외부 워크트리는 앱이 옮기면 안 된다.
    if !src.starts_with(&format!("{}/.claude/worktrees/", root)) {
        return Err("이 앱이 만든 구경로(.claude/worktrees/) 워크트리만 옮길 수 있습니다.".to_string());
    }
    let name = src.rsplit('/').next().unwrap_or("").to_string();
    if name.is_empty() || name.contains("..") {
        return Err("워크트리 이름을 확인할 수 없습니다.".to_string());
    }
    let to = format!("{}/worktrees/{}", root, name);
    // ⚠️ 대상이 이미 있으면 git worktree move가 rc=0으로 그 **안에** 중첩시킨다(실측). 반드시 선차단.
    if std::path::Path::new(&to).exists() {
        return Err(format!("이미 {} 가 존재합니다. 먼저 정리한 뒤 다시 시도하세요.", to));
    }
    let git_bin = resolve_bin("git");
    // 잠긴(locked) 워크트리는 강제로 옮기지 않는다 — 잠금은 보통 의도적 보호다.
    if let Ok(list) = Command::new(&git_bin)
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&root)
        .output()
    {
        let stdout = String::from_utf8_lossy(&list.stdout).to_string();
        for block in stdout.split("\n\n") {
            if block.contains(&format!("worktree {}", src))
                && block.lines().any(|l| l == "locked" || l.starts_with("locked "))
            {
                return Err("세션이 사용 중(locked)인 워크트리는 옮길 수 없습니다. 세션을 종료한 뒤 다시 시도하세요.".to_string());
            }
        }
    }
    // 대상 부모 폴더가 없으면 git worktree move가 실패한다(실측).
    std::fs::create_dir_all(format!("{}/worktrees", root)).map_err(|e| e.to_string())?;
    let out = Command::new(&git_bin)
        .args(["worktree", "move", &src, &to])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("워크트리 이동 실패: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .to_string()
            .if_empty_then("워크트리 이동에 실패했습니다."));
    }
    // 빈 레거시 폴더 잔재 정리 (비어 있을 때만 성공)
    let _ = std::fs::remove_dir(format!("{}/.claude/worktrees", root));
    let _ = ensure_local_worktree_exclude(&root, &git_bin);
    seed_worktree_local_config(&root, &to);
    Ok(serde_json::json!({ "success": true, "from": src, "to": to }))
}

#[tauri::command(async)]
fn git_worktree_remove(folder_path: String, worktree_path: String, orca_managed: Option<bool>) -> Result<(), String> {
    if !is_absolute_path(&folder_path) || !is_absolute_path(&worktree_path) {
        return Err("folder_path와 worktree_path의 절대경로가 필요합니다.".to_string());
    }
    if !std::path::Path::new(&folder_path).is_dir() {
        return Err(format!("Git 저장소 폴더가 없습니다: {}", folder_path));
    }

    let git_bin = resolve_bin("git");
    let registered = registered_worktrees(&folder_path, &git_bin)?;
    let requested_key = normalized_path_key(&worktree_path)?;
    let mut target_index: Option<usize> = None;
    for (index, entry) in registered.iter().enumerate() {
        if normalized_path_key(&entry.path)? == requested_key {
            target_index = Some(index);
            break;
        }
    }
    let target_index = target_index.ok_or_else(|| {
        "이 저장소에 정확히 등록된 워크트리만 삭제할 수 있습니다.".to_string()
    })?;
    if target_index == 0 {
        return Err("메인 워크트리는 삭제할 수 없습니다.".to_string());
    }

    let primary_path = registered[0].path.clone();
    let target = registered[target_index].clone();
    if target.locked {
        return Err(
            "세션이 사용 중(locked)인 워크트리는 삭제할 수 없습니다. 세션을 종료하거나 직접 잠금을 해제한 뒤 다시 시도하세요."
                .to_string(),
        );
    }

    let registration_remains = |entries: &[RegisteredWorktree]| -> Result<bool, String> {
        for entry in entries {
            if normalized_path_key(&entry.path)? == requested_key {
                return Ok(true);
            }
        }
        Ok(false)
    };

    // 폴더가 이미 없을 때만 Git의 안전한 메타데이터 정리 명령을 사용한다.
    // 등록되지 않은 임의 경로를 직접 삭제하는 폴백은 두지 않는다.
    if !std::path::Path::new(&target.path).exists() {
        let prune = Command::new(&git_bin)
            .args(["worktree", "prune", "--expire", "now"])
            .current_dir(&primary_path)
            .output()
            .map_err(|e| format!("git worktree prune 실행 실패: {}", e))?;
        if !prune.status.success() {
            let stderr = String::from_utf8_lossy(&prune.stderr).trim().to_string();
            return Err(stderr.if_empty_then("사라진 워크트리 등록을 정리하지 못했습니다."));
        }
        let after = registered_worktrees(&primary_path, &git_bin)?;
        if registration_remains(&after)? {
            return Err(
                "워크트리 폴더는 없지만 Git 등록이 남아 있습니다. 잠금 또는 Git 메타데이터를 확인하세요."
                    .to_string(),
            );
        }
        return Ok(());
    }

    // UI 확인만으로 미커밋 파일까지 강제 삭제하지 않는다. 백엔드가 삭제 직전
    // 실제 상태를 다시 검사해 clean 워크트리만 일반 `git worktree remove`로 지운다.
    let dirty = Command::new(&git_bin)
        .args(["status", "--porcelain=v1", "--untracked-files=all", "--", "."])
        .current_dir(&target.path)
        .output()
        .map_err(|e| format!("삭제 전 Git 상태 확인 실패: {}", e))?;
    if !dirty.status.success() {
        let stderr = String::from_utf8_lossy(&dirty.stderr).trim().to_string();
        return Err(stderr.if_empty_then("삭제 전 워크트리 상태를 확인하지 못했습니다."));
    }
    if !String::from_utf8_lossy(&dirty.stdout).trim().is_empty() {
        return Err(
            "미커밋 변경 또는 추적되지 않은 파일이 있는 워크트리는 삭제하지 않습니다. 먼저 커밋하거나 직접 정리하세요."
                .to_string(),
        );
    }

    // Orca 관리 워크트리는 Orca CLI로 지워야 Orca 그래프에도 반영된다. 다만
    // **Orca를 못 쓴다고 사용자의 삭제가 막히면 안 된다** — 미설치/미기동/CLI 실패는
    // 아래의 일반 `git worktree remove`로 이어서 진행한다. 더티/잠금/주 워크트리
    // 가드는 이 지점 이전에 이미 통과했으므로 폴백이 덜 안전하지 않다.
    if orca_managed.unwrap_or(false) {
        let removed_by_orca = resolve_orca_cli().is_some_and(|cli| {
            let _guard = ORCA_LOCK.lock().unwrap_or_else(|error| error.into_inner());
            if orca_run_json_retry(&cli, &["open"], 3, ORCA_OPEN_TIMEOUT_MS, ORCA_BACKOFF_MS).is_err() {
                return false;
            }
            let selector = format!("path:{}", target.path);
            orca_run_json_retry(
                &cli,
                &["worktree", "rm", "--worktree", &selector, "--force"],
                2,
                20_000,
                500,
            )
            .is_ok()
        });
        if removed_by_orca {
            let after = registered_worktrees(&primary_path, &git_bin)?;
            if registration_remains(&after)? || std::path::Path::new(&target.path).exists() {
                return Err("Orca 관리 워크트리 제거 후 경로 또는 Git 등록이 남아 있습니다.".to_string());
            }
            return Ok(());
        }
    }

    let remove = Command::new(&git_bin)
        .args(["worktree", "remove", target.path.as_str()])
        .current_dir(&primary_path)
        .output()
        .map_err(|e| format!("git worktree remove 실행 실패: {}", e))?;
    let remove_error = String::from_utf8_lossy(&remove.stderr).trim().to_string();

    let after = registered_worktrees(&primary_path, &git_bin)?;
    let still_registered = registration_remains(&after)?;
    let folder_still_exists = std::path::Path::new(&target.path).exists();
    if still_registered {
        return Err(remove_error.if_empty_then("Git 워크트리 등록을 삭제하지 못했습니다."));
    }
    if folder_still_exists {
        return Err(format!(
            "Git 워크트리 등록은 제거됐지만 폴더가 남아 있습니다(부분 처리): {}",
            target.path
        ));
    }
    if !remove.status.success() {
        // Git이 비정상 종료했어도 등록과 폴더가 모두 사라졌다면 최종 상태는 안전하게
        // 완료된 것이다. 오류를 성공으로 숨기지 않도록 진단 로그는 남긴다.
        eprintln!(
            "[git_worktree_remove] git exited non-zero after completing removal: {}",
            remove_error
        );
    }
    Ok(())
}

#[tauri::command(async)]
fn git_merge_branch(folder_path: String, branch_name: String) -> Result<String, String> {
    if !is_absolute_path(&folder_path) {
        return Err("folder_path must be absolute".to_string());
    }
    // --autostash: 변경 사항 자동 스태시 후 머지, 이후 자동 팝
    let output = Command::new("git")
        .args(["merge", "--no-ff", "--no-edit", "--autostash", &branch_name])
        .current_dir(&folder_path)
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git not found: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.contains("signal: 10") || stderr.contains("SIGBUS") {
            "iCloud 동기화로 머지 실패. Finder에서 iCloud 다운로드를 강제하거나 메인 레포를 iCloud 밖으로 이동하세요.".to_string()
        } else if stderr.contains("CONFLICT") {
            format!("충돌 발생: {}\n→ git merge --abort 로 취소 가능", stderr)
        } else {
            stderr
        };
        return Err(msg);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Default)]
struct GitCheckoutStatus {
    changed_files: i64,
    staged_files: i64,
    untracked_files: i64,
    conflicted_files: i64,
    has_commits: bool,
    upstream: Option<String>,
    has_upstream: bool,
    remote_branch_exists: bool,
    github_connected: bool,
    ahead: i64,
    behind: i64,
    status_error: Option<String>,
}

fn parse_git_checkout_status(text: &str) -> GitCheckoutStatus {
    let mut status = GitCheckoutStatus::default();
    for line in text.lines() {
        if let Some(oid) = line.strip_prefix("# branch.oid ") {
            status.has_commits = oid.trim() != "(initial)";
        } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
            let value = upstream.trim();
            if !value.is_empty() {
                status.upstream = Some(value.to_string());
                status.has_upstream = true;
                status.remote_branch_exists = true;
            }
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            for token in ab.split_whitespace() {
                if let Some(value) = token.strip_prefix('+') {
                    status.ahead = value.parse::<i64>().unwrap_or(0);
                } else if let Some(value) = token.strip_prefix('-') {
                    status.behind = value.parse::<i64>().unwrap_or(0);
                }
            }
        } else if line.starts_with("? ") {
            status.changed_files += 1;
            status.untracked_files += 1;
        } else if line.starts_with("u ") {
            status.changed_files += 1;
            status.conflicted_files += 1;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            status.changed_files += 1;
            if let Some(xy) = line.get(2..).and_then(|rest| rest.split_whitespace().next()) {
                if xy.as_bytes().first().map(|b| *b != b'.').unwrap_or(false) {
                    status.staged_files += 1;
                }
            }
        }
    }
    status
}

fn read_git_checkout_status(path: &str, branch: Option<&str>) -> GitCheckoutStatus {
    let output = Command::new("git")
        .args([
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
            "--",
            ".",
            ":(exclude).playwright-cli/**",
            ":(exclude)output/playwright/**",
        ])
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            let mut status = GitCheckoutStatus::default();
            status.status_error = Some(String::from_utf8_lossy(&output.stderr).trim().to_string());
            return status;
        }
        Err(error) => {
            let mut status = GitCheckoutStatus::default();
            status.status_error = Some(error.to_string());
            return status;
        }
    };

    let mut status = parse_git_checkout_status(&String::from_utf8_lossy(&output.stdout));
    status.github_connected = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|result| result.status.success())
        .map(|result| is_github_remote_url(&String::from_utf8_lossy(&result.stdout)))
        .unwrap_or(false);
    if !status.has_upstream {
        if let Some(branch) = branch {
            let remote_ref = format!("refs/remotes/origin/{}", branch);
            let remote_exists = Command::new("git")
                .args(["show-ref", "--verify", "--quiet", &remote_ref])
                .current_dir(path)
                .status()
                .map(|result| result.success())
                .unwrap_or(false);
            if remote_exists {
                let fallback_upstream = format!("origin/{}", branch);
                status.remote_branch_exists = true;
                status.upstream = Some(fallback_upstream.clone());
                if let Ok(counts) = Command::new("git")
                    .args(["rev-list", "--left-right", "--count", &format!("HEAD...{}", fallback_upstream)])
                    .current_dir(path)
                    .output()
                {
                    if counts.status.success() {
                        let output = String::from_utf8_lossy(&counts.stdout);
                        let mut values = output.split_whitespace();
                        status.ahead = values.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                        status.behind = values.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                    }
                }
            }
        }
    }
    status
}

fn fetch_origin_with_timeout(folder_path: &str) -> Result<(), String> {
    let has_origin = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(folder_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !has_origin {
        return Err("origin 원격 저장소가 없습니다".to_string());
    }

    let mut child = Command::new("git")
        .args(["fetch", "--prune", "origin"])
        .current_dir(folder_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("원격 상태 확인 실패 ({})", status)),
            Ok(None) if started.elapsed() < std::time::Duration::from_secs(15) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("원격 상태 확인 시간 초과".to_string());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}


/// 워크트리 생성 시각. git이 기록하지 않으므로 `.git` 표식의 생성 시각을 쓴다.
/// 연결 워크트리에서 `.git`은 생성 시점에 쓰이는 파일이고, 주 워크트리에서는
/// `.git` 디렉터리가 곧 저장소가 만들어진 시각이다.
fn worktree_created_at(worktree_path: &str) -> Option<String> {
    let marker = std::path::Path::new(worktree_path).join(".git");
    let target = if marker.exists() { marker } else { std::path::PathBuf::from(worktree_path) };
    let meta = std::fs::metadata(target).ok()?;
    let time = meta.created().or_else(|_| meta.modified()).ok()?;
    let secs = time.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(format_unix_seconds_iso(secs))
}

/// UNIX 초 → ISO8601 UTC. chrono 의존성을 새로 들이지 않으려고 직접 계산한다.
fn format_unix_seconds_iso(secs: u64) -> String {
    let days_total = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 1970-01-01 기준 civil-from-days (Howard Hinnant 알고리즘)
    let z = days_total + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, m, d, hour, minute, second)
}

// ⚠️ `(async)` 필수. 이 함수는 워크트리마다 git을 여러 번 spawn하므로 sync 커맨드로 두면
// Tauri가 메인 스레드에서 실행해 IPC·창 렌더까지 수 초간 멈춘다. 커밋 직후의 목록 갱신이
// 바로 이 경로라, 앱에서만 "커밋 버튼을 눌러도 아무 일도 안 일어난 것처럼" 보였다.
// 같은 이유로 이 파일의 git_* 커맨드도 모두 async다 — 새로 추가할 때도 async로 둘 것.
#[tauri::command(async)]
fn list_git_worktrees(folder_path: String, fetch_remote: Option<bool>) -> Result<Vec<WorktreeInfo>, String> {
    let remote_refresh_error = if fetch_remote.unwrap_or(false) {
        fetch_origin_with_timeout(&folder_path).err()
    } else {
        None
    };
    let git_bin = resolve_bin("git");
    let output = std::process::Command::new(&git_bin)
        // Match the web API: paths with non-ASCII characters must stay usable paths rather
        // than Git's C-style escaped text, otherwise a post-refresh row is falsely stale.
        .args(["-c", "core.quotePath=false", "worktree", "list", "--porcelain"])
        .current_dir(&folder_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        // git 저장소가 아닌 폴더는 실패가 아니라 "워크트리 없음"이다. api-server.ts의
        // /api/list-git-worktrees 와 동작을 맞춘다(웹/앱 동일 결과).
        // 폴더가 없을 때는 git이 cwd 때문에 실패하므로 그때는 오류를 유지한다.
        if std::path::Path::new(&folder_path).is_dir() {
            let inside_repo = std::process::Command::new("git")
                .args(["rev-parse", "--is-inside-work-tree"])
                .current_dir(&folder_path)
                .output();
            let is_repo = inside_repo.map(|o| o.status.success()).unwrap_or(false);
            if !is_repo {
                return Ok(Vec::new());
            }
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(stderr.if_empty_then("Git 워크트리 목록을 확인하지 못했습니다."));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut current_detached = false;
    let mut current_locked: bool = false;
    let mut current_locked_reason: Option<String> = None;
    let mut is_first = true;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            if let Some(path) = current_path.take() {
                let is_main = is_first;
                if is_first { is_first = false; }
                worktrees.push(WorktreeInfo {
                    path,
                    branch: current_branch.take(),
                    head: current_head.take(),
                    detached: current_detached,
                    is_main,
                    locked: current_locked,
                    locked_reason: current_locked_reason.take(),
                    ahead_count: None,
                    changed_files: 0,
                    staged_files: 0,
                    untracked_files: 0,
                    conflicted_files: 0,
                    has_commits: false,
                    upstream: None,
                    has_upstream: false,
                    remote_branch_exists: false,
                    github_connected: false,
                    ahead: 0,
                    behind: 0,
                    status_error: None,
                    created_at: None,
                    last_commit_at: None,
                    remote_refresh_error: remote_refresh_error.clone(),
                });
                current_detached = false;
                current_locked = false;
                current_locked_reason = None;
            }
            current_path = Some(line["worktree ".len()..].to_string());
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            let value = head.trim();
            current_head = if value.is_empty() { None } else { Some(value.to_string()) };
        } else if line.starts_with("branch refs/heads/") {
            let value = line["branch refs/heads/".len()..].trim();
            current_branch = if value.is_empty() { None } else { Some(value.to_string()) };
        } else if line == "detached" {
            current_detached = true;
        } else if line == "locked" || line.starts_with("locked ") {
            current_locked = true;
            let reason = line.strip_prefix("locked").unwrap_or("").trim().to_string();
            current_locked_reason = if reason.is_empty() { None } else { Some(reason) };
        }
    }
    // flush last entry
    if let Some(path) = current_path {
        worktrees.push(WorktreeInfo {
            path,
            branch: current_branch,
            head: current_head,
            detached: current_detached,
            is_main: is_first,
            locked: current_locked,
            locked_reason: current_locked_reason,
            ahead_count: None,
            changed_files: 0,
            staged_files: 0,
            untracked_files: 0,
            conflicted_files: 0,
            has_commits: false,
            upstream: None,
            has_upstream: false,
            remote_branch_exists: false,
            github_connected: false,
            ahead: 0,
            behind: 0,
            status_error: None,
            created_at: None,
            last_commit_at: None,
            remote_refresh_error: remote_refresh_error.clone(),
        });
    }
    // `git worktree list`가 돌려준 항목은 전부 이 저장소의 워크트리다. 프로젝트 폴더 바깥이라는
    // 이유로 숨기면 Orca가 만든 워크트리(~/orca/workspaces/…)나 터미널에서 직접 만든 워크트리가
    // 앱에 보이지 않아 관리가 불가능해진다. 물리 디렉터리가 남아 있는 것만 표시(orphan 메타 숨김).
    // ⚠️ 물리 삭제(cleanup_stale_worktrees)는 여전히 .claude/worktrees/ 하위로만 제한할 것 —
    //    앱이 만들지 않은 외부 경로 워크트리를 앱이 지워서는 안 된다.
    // api-server.ts의 /api/list-git-worktrees 필터와 동작이 일치해야 한다(웹/앱 동일 결과).
    // Git's first porcelain record is the primary worktree.  The request itself may start
    // from a persisted linked-worktree row, so `rev-parse HEAD` in `folder_path` is not a
    // valid replacement for this branch.  Keep it before stale paths are filtered: refs can
    // still be compared safely even when Git has a prunable on-disk record.
    let main_branch_name = worktrees.iter()
        .find(|wt| wt.is_main)
        .and_then(|wt| wt.branch.clone());

    let mut valid: Vec<WorktreeInfo> = worktrees.into_iter().filter(|wt| {
        std::path::Path::new(&wt.path).is_dir()
    }).collect();

    // 브랜치별 마지막 커밋 시각 — 워크트리마다 git을 부르지 않고 for-each-ref 한 번으로 모은다.
    let mut branch_dates: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(refs_out) = std::process::Command::new("git")
        .args(["for-each-ref", "--format=%(refname:short)\t%(committerdate:iso-strict)", "refs/heads"])
        .current_dir(&folder_path)
        .output()
    {
        if refs_out.status.success() {
            for line in String::from_utf8_lossy(&refs_out.stdout).lines() {
                if let Some((branch, date)) = line.split_once('\t') {
                    if !branch.is_empty() && !date.is_empty() {
                        branch_dates.insert(branch.to_string(), date.to_string());
                    }
                }
            }
        }
    }
    for wt in valid.iter_mut() {
        wt.created_at = worktree_created_at(&wt.path);
        wt.last_commit_at = wt.branch.as_ref().and_then(|b| branch_dates.get(b).cloned());
    }

    // 메인 브랜치 대비 머지 안 된 커밋 수 (0 = 이미 머지됨) — non-main 워크트리만 계산
    let mut with_merge_status: Vec<WorktreeInfo> = valid.into_iter().map(|mut wt| {
        if wt.is_main || main_branch_name.is_none() {
            return wt;
        }
        if let Some(branch) = wt.branch.clone() {
            if Some(&branch) == main_branch_name.as_ref() {
                return wt;
            }
            let count_out = std::process::Command::new("git")
                .args(["rev-list", "--count", &format!("{}..{}", main_branch_name.as_deref().unwrap_or_default(), branch)])
                .current_dir(&folder_path)
                .output();
            if let Ok(out) = count_out {
                if out.status.success() {
                    if let Ok(n) = String::from_utf8_lossy(&out.stdout).trim().parse::<i64>() {
                        wt.ahead_count = Some(n);
                    }
                }
            }
        }
        wt
    }).collect();

    for wt in &mut with_merge_status {
        let status = read_git_checkout_status(&wt.path, wt.branch.as_deref());
        wt.changed_files = status.changed_files;
        wt.staged_files = status.staged_files;
        wt.untracked_files = status.untracked_files;
        wt.conflicted_files = status.conflicted_files;
        wt.has_commits = status.has_commits;
        wt.upstream = status.upstream;
        wt.has_upstream = status.has_upstream;
        wt.remote_branch_exists = status.remote_branch_exists;
        wt.github_connected = status.github_connected;
        wt.ahead = status.ahead;
        wt.behind = status.behind;
        wt.status_error = status.status_error;
    }

    Ok(with_merge_status)
}

/// AI 이름 추천 (folderPath 기반, login shell에서 claude -p 호출)
#[tauri::command]
fn suggest_name(folder_path: String) -> Result<Vec<String>, String> {
    use std::fs;

    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err(format!("폴더 없음: {}", folder_path));
    }

    // 디렉토리 파일 목록 (최대 30개)
    let files: Vec<String> = fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .take(30)
                .collect()
        })
        .unwrap_or_default();

    // package.json 내용 (있으면 최대 500자)
    let pkg_json = fs::read_to_string(path.join("package.json"))
        .map(|s| s.chars().take(500).collect::<String>())
        .unwrap_or_default();

    let prompt = format!(
        "Project files: {}\npackage.json: {}\n\nSuggest 3 concise project names (2-4 words, English). Reply with JSON array only: [\"name1\",\"name2\",\"name3\"]",
        files.join(", "),
        pkg_json
    );

    let claude_cli = resolve_claude_cli();

    #[cfg(target_os = "windows")]
    let out = {
        std::process::Command::new(&claude_cli)
            .args(["--safe-mode", "-p", "--model", "haiku", &prompt])
            .current_dir(&folder_path)
            .output()
            .map_err(|e| format!("Claude CLI 실행 실패: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let out = {
        // login shell로 실행 — ~/.zshrc 소싱 → 올바른 PATH + claude 인증 토큰 자동 로드
        let escaped_prompt = prompt.replace('\'', "'\"'\"'");
        let shell_cmd = format!(
            "cd '{}' && '{}' --safe-mode -p --model haiku '{}'",
            escape_sq(&folder_path),
            claude_cli,
            escaped_prompt
        );
        std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &shell_cmd])
            .output()
            .map_err(|e| format!("shell 실행 실패: {}", e))?
    };

    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err_raw = String::from_utf8_lossy(&out.stderr).trim().to_string();

    // 실패 시 stderr/stdout 포함한 에러 반환 (디버깅용)
    if !out.status.success() || raw.is_empty() {
        return Err(format!("claude 실패 (exit={}) stdout='{}' stderr='{}'",
            out.status.code().unwrap_or(-1),
            &raw[..raw.len().min(300)],
            &err_raw[..err_raw.len().min(300)]));
    }

    // JSON 배열 추출
    if let Some(start) = raw.find('[') {
        if let Some(end) = raw.rfind(']') {
            let json_str = &raw[start..=end];
            if let Ok(suggestions) = serde_json::from_str::<Vec<String>>(json_str) {
                return Ok(suggestions);
            }
        }
    }
    // JSON 파싱 실패 시 raw 출력 포함 에러 (claude가 마크다운 등으로 응답했을 가능성)
    Err(format!("JSON 파싱 실패 (raw='{}')", &raw[..raw.len().min(300)]))
}

/// AI 이름 일괄 추천 (여러 포트를 한 번의 claude -p 호출로 처리)
#[tauri::command]
fn suggest_names_batch(ports: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    use std::fs;

    if ports.is_empty() {
        return Ok(serde_json::json!({}));
    }

    let mut project_lines: Vec<String> = Vec::new();
    let mut valid_ids: Vec<String> = Vec::new();

    for port in &ports {
        let id = port.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let folder_path = port.get("folderPath").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if id.is_empty() || folder_path.is_empty() {
            continue;
        }
        let path = std::path::Path::new(&folder_path);
        if !path.exists() {
            continue;
        }

        let files: Vec<String> = fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .take(20)
                    .collect()
            })
            .unwrap_or_default();

        let pkg_json = fs::read_to_string(path.join("package.json"))
            .map(|s| s.chars().take(300).collect::<String>())
            .unwrap_or_default();

        project_lines.push(format!(
            "id={} files=[{}] package.json={}",
            id,
            files.join(", "),
            if pkg_json.is_empty() { "none".to_string() } else { pkg_json }
        ));
        valid_ids.push(id);
    }

    if valid_ids.is_empty() {
        return Ok(serde_json::json!({}));
    }

    let prompt = format!(
        "For each project below, suggest a concise English project name (2-4 words) and a category (single lowercase word describing WHAT it does, e.g. converter, dashboard, manager, tracker, bot, guide, calculator, automation, monitor, generator).\nReply ONLY with a JSON object mapping each id to {{\"name\":...,\"category\":...}}: {{\"id1\": {{\"name\": \"Name One\", \"category\": \"manager\"}}}}\n\n{}",
        project_lines.join("\n")
    );

    let claude_cli = resolve_claude_cli();

    #[cfg(target_os = "windows")]
    let out = {
        std::process::Command::new(&claude_cli)
            .args(["--safe-mode", "-p", "--model", "haiku", &prompt])
            .output()
            .map_err(|e| format!("Claude CLI 실행 실패: {}", e))?
    };

    // --safe-mode: hooks/plugin sync/CLAUDE.md 자동탐색을 건너뛰어 CLI 부팅 오버헤드 제거
    // --model haiku: 이름/카테고리 분류처럼 가벼운 작업에는 무거운 기본 모델이 불필요
    #[cfg(not(target_os = "windows"))]
    let out = {
        let escaped_prompt = prompt.replace('\'', "'\"'\"'");
        let shell_cmd = format!("'{}' --safe-mode -p --model haiku '{}'", claude_cli, escaped_prompt);
        std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &shell_cmd])
            .output()
            .map_err(|e| format!("shell 실행 실패: {}", e))?
    };

    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err_raw = String::from_utf8_lossy(&out.stderr).trim().to_string();

    if !out.status.success() || raw.is_empty() {
        return Err(format!("claude 실패 (exit={}) stdout='{}' stderr='{}'",
            out.status.code().unwrap_or(-1),
            &raw[..raw.len().min(300)],
            &err_raw[..err_raw.len().min(300)]));
    }

    if let Some(start) = raw.find('{') {
        if let Some(end) = raw.rfind('}') {
            let json_str = &raw[start..=end];
            if let Ok(result) = serde_json::from_str::<serde_json::Value>(json_str) {
                return Ok(result);
            }
        }
    }

    Err(format!("JSON 파싱 실패 (raw='{}')", &raw[..raw.len().min(300)]))
}

// ──────────────────── cmux (Mac-only terminal multiplexer) ────────────────────
// cmux invocation lives in Rust because the Bun api-server's long-running
// Bun.serve handler context degrades cmux subprocess calls over time
// (Broken pipe on every cmux ping after a few minutes), while identical calls
// from any other context — shell, nohup bash, standalone bun — remain reliable.

fn resolve_cmux_cli() -> Option<String> {
    use std::path::Path;
    if Path::new("/Applications/cmux.app/Contents/Resources/bin/cmux").exists() {
        return Some("/Applications/cmux.app/Contents/Resources/bin/cmux".into());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home_app = format!("{}/Applications/cmux.app/Contents/Resources/bin/cmux", home.to_string_lossy());
        if Path::new(&home_app).exists() { return Some(home_app); }
    }
    if Path::new("/opt/homebrew/bin/cmux").exists() {
        return Some("/opt/homebrew/bin/cmux".into());
    }
    None
}

fn resolve_claude_cli() -> String {
    use std::path::Path;
    use std::process::Command;

    #[cfg(target_os = "windows")]
    {
        // where.exe로 PATH에서 탐색
        if let Ok(out) = Command::new("where").arg("claude").output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().split('\n').next().unwrap_or("").trim().to_string();
            if !p.is_empty() && Path::new(&p).exists() {
                return p;
            }
        }
        // 알려진 설치 경로
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let p = format!("{}\\Programs\\claude\\claude.exe", local);
            if Path::new(&p).exists() { return p; }
        }
        if let Ok(local) = std::env::var("APPDATA") {
            let p = format!("{}\\npm\\claude.cmd", local);
            if Path::new(&p).exists() { return p; }
        }
        return "claude".into();
    }

    #[cfg(not(target_os = "windows"))]
    {
        // login shell로 which claude 실행 — Finder 실행 시 PATH가 제한되므로 zsh -l 필요
        if let Ok(out) = Command::new("/bin/zsh").args(["-l", "-c", "which claude"]).output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().split('\n').next().unwrap_or("").trim().to_string();
            if !p.is_empty() && Path::new(&p).exists() {
                return p;
            }
        }
        // fallback: bash login shell
        if let Ok(out) = Command::new("/bin/bash").args(["-l", "-c", "which claude"]).output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().split('\n').next().unwrap_or("").trim().to_string();
            if !p.is_empty() && Path::new(&p).exists() {
                return p;
            }
        }
        for p in &[
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            "/Applications/cmux.app/Contents/Resources/bin/claude",
        ] {
            if Path::new(p).exists() { return (*p).into(); }
        }
        "claude".into()
    }
}

fn wait_cmux_ready(cli: &str, total: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + total;
    while std::time::Instant::now() < deadline {
        if Command::new(cli).arg("ping").output().map(|o| o.status.success()).unwrap_or(false) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    false
}

/// cmux에 열린 창이 없으면 새 창을 생성한다.
/// TabManager는 열린 창이 있을 때만 활성화된다.
fn ensure_cmux_window(cli: &str) {
    let out = Command::new(cli).args(["list-windows"]).output();
    if let Ok(o) = out {
        let stdout = String::from_utf8_lossy(&o.stdout);
        if stdout.trim() == "No windows" {
            let _ = Command::new(cli).args(["new-window"]).output();
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

fn cmux_install_error() -> String {
    "cmux가 설치되지 않았습니다.\n설치: brew tap manaflow-ai/cmux && brew install --cask cmux".to_string()
}

fn first_worktree(worktree_path: &Option<String>) -> Option<String> {
    worktree_path.as_deref()
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn has_hidden_orca_path_segment(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .any(|segment| segment.len() > 1 && segment.starts_with('.'))
}

fn reject_hidden_orca_worktree(path: &str) -> Result<(), String> {
    if has_hidden_orca_path_segment(path) {
        return Err("이 워크트리는 숨김 경로라 Orca 화면에 연결되지 않는 세션이 생성될 수 있습니다. WORKTREES의 ‘새 경로로 옮기기’를 먼저 실행하세요. 아무 세션도 생성하지 않았습니다.".into());
    }
    Ok(())
}

/// Resolve a saved symlink before giving its path to Orca's sidebar selector.
fn resolve_orca_project_path(path: String) -> String {
    normalized_absolute_path(&path)
        .map(|resolved| resolved.to_string_lossy().to_string())
        .unwrap_or(path)
}

#[tauri::command]
fn get_platform() -> String {
    if cfg!(target_os = "windows") { "windows".to_string() }
    else if cfg!(target_os = "macos") { "macos".to_string() }
    else { "linux".to_string() }
}

#[tauri::command]
fn open_cmux_claude(name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: bool) -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }

    let cd_path = first_worktree(&worktree_path)
        .or(folder_path)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "프로젝트 경로가 없습니다.".to_string())?;

    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();

    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    ensure_cmux_window(&cli);

    let claude_cli = if bypass { "claude --dangerously-skip-permissions" } else { "claude" };
    // Atomic: create a fresh workspace at the project path and run claude there.
    // Title format mirrors tmux (build_window_title): "⚡️ project › worktree" (bypass) or "🔷 project › worktree".
    let title = build_window_title(&name, worktree_path.as_deref(), true, bypass, false);
    let out = Command::new(&cli)
        .args(["new-workspace", "--cwd", &cd_path, "--command", claude_cli, "--name", &title])
        .output()
        .map_err(|e| format!("cmux new-workspace 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux new-workspace 실패: {}", stderr)));
    }
    Ok(format!("cmux Claude{} 실행 중", if bypass { " bypass" } else { "" }))
}

#[tauri::command]
fn open_cmux_claude_new(name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: bool) -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }

    let cd_path = first_worktree(&worktree_path)
        .or(folder_path)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "프로젝트 경로가 없습니다.".to_string())?;

    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();

    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    ensure_cmux_window(&cli);

    let claude_cli = if bypass { "claude --dangerously-skip-permissions" } else { "claude" };
    // is_fresh=true distinguishes the "↺ 새창" button from the regular one.
    let title = build_window_title(&name, worktree_path.as_deref(), true, bypass, true);
    let out = Command::new(&cli)
        .args(["new-workspace", "--cwd", &cd_path, "--command", claude_cli, "--name", &title])
        .output()
        .map_err(|e| format!("cmux new-workspace 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux new-workspace 실패: {}", stderr)));
    }
    Ok(format!("cmux 새창{} 시작 ↺", if bypass { " bypass" } else { "" }))
}

fn cmux_agent_command(executable: &str, arguments: &str) -> String {
    let executable = shell_quote_if_needed(executable);
    let arguments = arguments.trim();
    if arguments.is_empty() {
        executable
    } else {
        format!("{} {}", executable, arguments)
    }
}

/// 공통: cmux workspace에서 agent CLI(codex/agy 등) 실행 — open_cmux_claude 미러
fn open_cmux_agent(
    name: String,
    folder_path: Option<String>,
    worktree_path: Option<String>,
    bypass: bool,
    agent_cli: &str,
    label: &str,
) -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }

    let cd_path = first_worktree(&worktree_path)
        .or(folder_path)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "프로젝트 경로가 없습니다.".to_string())?;

    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();

    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    ensure_cmux_window(&cli);

    let title = build_window_title(&name, worktree_path.as_deref(), true, bypass, false);
    let out = Command::new(&cli)
        .args(["new-workspace", "--cwd", &cd_path, "--command", agent_cli, "--name", &title])
        .output()
        .map_err(|e| format!("cmux new-workspace 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux new-workspace 실패: {}", stderr)));
    }
    Ok(format!("cmux {}{} 실행 중", label, if bypass { " bypass" } else { "" }))
}

#[tauri::command]
fn open_cmux_codex(name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: bool) -> Result<String, String> {
    let agent_cli = cmux_agent_command(
        &resolve_agent_bin("codex"),
        if bypass { "--dangerously-bypass-approvals-and-sandbox" } else { "" },
    );
    open_cmux_agent(name, folder_path, worktree_path, bypass, &agent_cli, "Codex")
}

#[tauri::command]
fn open_cmux_agy(name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: bool) -> Result<String, String> {
    let agent_cli = cmux_agent_command(
        &resolve_agent_bin("agy"),
        if bypass { "--dangerously-skip-permissions" } else { "" },
    );
    open_cmux_agent(name, folder_path, worktree_path, bypass, &agent_cli, "Antigravity")
}

#[tauri::command]
fn open_cmux_hermes(name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: bool) -> Result<String, String> {
    let _ = bypass;
    let agent_cli = cmux_agent_command(&resolve_agent_bin("hermes"), "");
    open_cmux_agent(name, folder_path, worktree_path, false, &agent_cli, "Hermes")
}

#[tauri::command]
fn open_cmux_terminal(name: String, folder_path: Option<String>) -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }

    // Empty/missing path → fall back to $HOME (root area).
    let cd_path = folder_path
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".into());

    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();

    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    ensure_cmux_window(&cli);

    let title = format!("🪟 {}", name);
    let out = Command::new(&cli)
        .args(["new-workspace", "--cwd", &cd_path, "--name", &title])
        .output()
        .map_err(|e| format!("cmux new-workspace 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux new-workspace 실패: {}", stderr)));
    }
    Ok("cmux 터미널 열림".into())
}

#[tauri::command]
fn open_cmux_tmux(name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: bool, fresh: bool) -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }
    let cd_path = worktree_path
        .as_deref()
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| folder_path.clone())
        .filter(|s| !s.trim().is_empty())
        .ok_or("프로젝트 경로가 없습니다.")?;
    let claude_cli = if bypass { "claude --dangerously-skip-permissions" } else { "claude" };
    let session_name = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>();
    let session_name = if session_name.is_empty() { "port".to_string() } else { session_name };
    let tmux_cmd = if fresh {
        format!("tmux kill-session -t {session_name} 2>/dev/null; tmux new-session -s {session_name} -c '{cd_path}' {claude_cli}")
    } else {
        format!("tmux new-session -A -s {session_name} -c '{cd_path}' {claude_cli}")
    };
    let title = format!("{} (tmux){}", name, if bypass { " ⚡" } else { "" });
    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();
    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    let out = Command::new(&cli)
        .args(["new-workspace", "--cwd", &cd_path, "--command", &tmux_cmd, "--name", &title])
        .output()
        .map_err(|e| format!("cmux tmux 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux tmux 실패: {}", stderr)));
    }
    Ok(format!("cmux tmux{} 실행 중", if bypass { " bypass" } else { "" }))
}

#[tauri::command]
fn open_cmux_localhost(port: u16, name: String) -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }
    let url = format!("http://localhost:{}", port);
    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();
    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    let out = Command::new(&cli)
        .args(["new-pane", "--type", "browser", "--url", &url, "--name", &name, "--focus", "true"])
        .output()
        .map_err(|e| format!("cmux browser 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux browser 실패: {}", stderr)));
    }
    Ok(format!("cmux 브라우저로 localhost:{} 열림", port))
}

#[tauri::command]
fn open_cmux_agent_view() -> Result<String, String> {
    if cfg!(windows) { return Err("cmux는 맥에서만 가능합니다".into()); }
    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();
    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    ensure_cmux_window(&cli);
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let out = Command::new(&cli)
        .args(["new-workspace", "--cwd", &home, "--command", &format!("{} agents", resolve_claude_cli()), "--name", "🤖 Agent View"])
        .output()
        .map_err(|e| format!("cmux new-workspace 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!("cmux new-workspace 실패: {}", stderr)));
    }
    Ok("cmux Session Resume 열림".into())
}

// osascript 대기가 sync 커맨드로 IPC/메인 스레드를 막아 앱 전체가 얼었다 → async 실행.
#[tauri::command(async)]
fn open_terminal_agent_view(
    terminal_app: Option<String>,
    bypass: Option<bool>,
    folder_path: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let target_path = folder_path.filter(|path| !path.trim().is_empty());
        let base_name = name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Claude".to_string());
        let title = format!("🤖 {} agents", base_name);
        let arguments = if bypass.unwrap_or(false) {
            "--dangerously-skip-permissions agents"
        } else {
            "agents"
        };
        let command = native_terminal_agent_command("claude", arguments);
        spawn_wt_cmd(&command, target_path.as_deref(), &title)?;
        return Ok(format!("Claude Agents 실행 ({})", base_name));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let raw_path = folder_path
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| home.clone());
        let cd_path = if raw_path == "~" {
            home.clone()
        } else if let Some(rest) = raw_path.strip_prefix("~/") {
            format!("{}/{}", home, rest)
        } else {
            raw_path
        };
        if !std::path::Path::new(&cd_path).is_dir() {
            return Err(format!("폴더를 찾을 수 없습니다: {}", cd_path));
        }
        let base_name = name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                cd_path
                    .split('/')
                    .filter(|part| !part.is_empty())
                    .last()
                    .unwrap_or("project")
                    .to_string()
            });
        let title = format!("🤖 {} agents", base_name);
        let command = format!(
            "cd '{}' && printf '\\033]0;{}\\007' && {}{} agents",
            escape_sq(&cd_path),
            escape_sq(&title),
            resolve_claude_cli(),
            if bypass.unwrap_or(false) {
                " --dangerously-skip-permissions"
            } else {
                ""
            },
        );
        if terminal_app.as_deref() == Some("terminal") {
            let outcome = open_terminal_app_with_script(&command)?;
            Ok(format!(
                "Terminal에서 Claude Agents 실행 ({}){}",
                base_name,
                outcome.warning_suffix()
            ))
        } else {
            let outcome = open_iterm_with_script(&command)?;
            Ok(format!(
                "iTerm에서 Claude Agents 실행 ({}){}",
                base_name,
                outcome.warning_suffix()
            ))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (terminal_app, bypass, folder_path, name);
        Err("이 기능은 macOS 또는 Windows에서만 지원됩니다".to_string())
    }
}

#[tauri::command]
fn open_cmux_project_agents(
    folder_path: Option<String>,
    name: String,
    bypass: Option<bool>,
) -> Result<String, String> {
    if cfg!(windows) {
        return Err("cmux는 맥에서만 가능합니다".into());
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let raw_path = folder_path
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| home.clone());
    let cd_path = if raw_path == "~" {
        home.clone()
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        format!("{}/{}", home, rest)
    } else {
        raw_path
    };
    if !std::path::Path::new(&cd_path).is_dir() {
        return Err(format!("폴더를 찾을 수 없습니다: {}", cd_path));
    }
    let cli = resolve_cmux_cli().ok_or_else(cmux_install_error)?;
    let _ = Command::new("open").args(["-a", "cmux"]).status();
    if !wait_cmux_ready(&cli, std::time::Duration::from_secs(5)) {
        return Err(cmux_access_help_msg("cmux 소켓 준비 대기 시간 초과 (5초)"));
    }
    ensure_cmux_window(&cli);
    let base_name = if !name.trim().is_empty() {
        name.clone()
    } else {
        cd_path
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or("project")
            .to_string()
    };
    let title = format!("🤖 {} agents", base_name);
    let command = format!(
        "{}{} agents",
        resolve_claude_cli(),
        if bypass.unwrap_or(false) {
            " --dangerously-skip-permissions"
        } else {
            ""
        }
    );
    let out = Command::new(&cli)
        .args([
            "new-workspace",
            "--cwd",
            &cd_path,
            "--command",
            &command,
            "--name",
            &title,
        ])
        .output()
        .map_err(|e| format!("cmux new-workspace 실행 실패: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(cmux_access_help_msg(&format!(
            "cmux new-workspace 실패: {}",
            stderr
        )));
    }
    Ok(format!("cmux Agent View 열림 ({})", base_name))
}

// ──────────────── Orca (https://www.onorca.dev) ────────────────
// Electron 앱 + VS Code 스타일 CLI. 워크플로: orca open(멱등, 런타임 대기)
// → repo add(멱등) → terminal create. git 저장소만 등록 가능.

/// 모든 Orca CLI 호출을 직렬화하는 프로세스 전역 락. 실측(api-server.ts 동일 이슈):
/// 더블클릭 등으로 요청이 2~3개 겹치면 완전 블로킹 CLI 호출이 쌓이며 호스트 프로세스가
/// 세그폴트로 죽는 것을 확인 — Orca 작업은 항상 이 락을 통해 한 번에 하나씩만 실행한다.
static ORCA_LOCK: Mutex<()> = Mutex::new(());

/// 일반 CLI 호출 타임아웃. 관측된 데몬 부하 스파이크(7~10s)보다 여유 있게 큰 값.
const ORCA_TIMEOUT_MS: u64 = 15_000;
/// `orca open`은 앱 콜드 스타트 + 런타임 대기까지 포함하므로 더 길게.
const ORCA_OPEN_TIMEOUT_MS: u64 = 30_000;
/// `terminal switch`는 가벼운 UI 전환 — 짧게 끊고 실패해도 무시.
const ORCA_SWITCH_TIMEOUT_MS: u64 = 5_000;
/// 기본 백오프(ms). `terminal create`만 1000ms 사용.
const ORCA_BACKOFF_MS: u64 = 900;
/// 콜드 스타트를 버티되 요청 전체 예산을 넘기지 않는 `orca open` 시도당 상한.
const ORCA_OPEN_AGENT_TIMEOUT_MS: u64 = 20_000;

/// `orca open` — 앱 실행 + 런타임 대기. 20s x 2회.
///
/// 이미 떠 있으면 첫 시도가 ~150ms에 끝나므로 비용이 없고, 콜드 스타트(부팅/종료 직후
/// 첫 클릭)에서는 기동을 기다릴 여지를 남긴다. 5s 단발은 콜드 스타트를 못 버텨 주 동선이
/// 첫 클릭에서 실패했다. 실패해도 창은 앞으로 가져온다 — 다시 눌렀을 때 성공하도록.
fn orca_ensure_ready(cli: &str) -> Result<(), String> {
    let result = orca_run_json_retry(cli, &["open"], 2, ORCA_OPEN_AGENT_TIMEOUT_MS, 500);
    #[cfg(not(target_os = "windows"))]
    let _ = Command::new("open").args(["-a", "Orca"]).status();
    result.map(|_| ()).map_err(|e| {
        format!("Orca를 실행하는 중입니다. 앱 창이 뜨면 다시 시도해주세요.\n({})", e)
    })
}


fn resolve_orca_cli() -> Option<String> {
    use std::path::Path;
    if cfg!(windows) {
        // %LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe (Electron user-install, 소문자/대문자 모두)
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = local.to_string_lossy().into_owned();
            for dir in &["orca", "Orca"] {
                let cli = format!("{}\\Programs\\{}\\resources\\bin\\orca.exe", base, dir);
                if Path::new(&cli).exists() { return Some(cli); }
            }
        }
        // %ProgramFiles%\orca\resources\bin\orca.exe (system-wide install)
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let base = pf.to_string_lossy().into_owned();
            for dir in &["orca", "Orca"] {
                let cli = format!("{}\\{}\\resources\\bin\\orca.exe", base, dir);
                if Path::new(&cli).exists() { return Some(cli); }
            }
        }
        // PATH fallback
        if let Ok(out) = Command::new("where").arg("orca").output() {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
                if !path.is_empty() && Path::new(&path).exists() { return Some(path); }
            }
        }
        return None;
    }
    if Path::new("/Applications/Orca.app/Contents/Resources/bin/orca").exists() {
        return Some("/Applications/Orca.app/Contents/Resources/bin/orca".into());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home_app = format!("{}/Applications/Orca.app/Contents/Resources/bin/orca", home.to_string_lossy());
        if Path::new(&home_app).exists() { return Some(home_app); }
    }
    for p in &["/opt/homebrew/bin/orca", "/usr/local/bin/orca"] {
        if Path::new(p).exists() { return Some((*p).into()); }
    }
    None
}

/// Orca.app이 없을 때 — 설치를 "시작"시켜 준다. Orca CLI는 앱 번들에만 포함되어
/// 있고 정식 배포 채널(brew cask 'orca'는 완전히 다른 앱 — plotly의 이미지 툴)이
/// 없으므로 headless 자동 설치는 불가능. 대신 공식 다운로드 페이지를 자동으로 열어
/// 사용자가 바로 설치를 이어갈 수 있게 한다 (파일 다운로드/실행은 사용자가 직접).
fn bootstrap_orca_install() -> String {
    if cfg!(windows) {
        let _ = Command::new("cmd").args(["/c", "start", "https://www.onorca.dev/download"]).status();
    } else {
        let _ = Command::new("open").arg("https://www.onorca.dev").status();
    }
    "Orca가 설치되지 않아 다운로드 페이지를 열었습니다 (https://www.onorca.dev/download).\n설치 후 다시 시도해주세요.".to_string()
}

/// 확정적 실패(재시도해도 결과가 같음) — repo 등록 거부 등. 이 패턴이면 재시도하지 않는다.
fn orca_is_terminal_error(e: &str) -> bool {
    e.to_lowercase().contains("not a valid git repository")
}

/// 데몬 부하로 인한 일시적 컨텐션(터미널 핸들 등록 지연, IPC 응답 지연 등)을 흡수하는
/// 재시도 래퍼. 실측: 동시 요청 시 단일 CLI 호출이 정상 0.6~1.6s에서 드물게 7~10s까지
/// 튀며 일시 실패로 이어짐 — 확정적 에러가 아니면 백오프 후 재시도.
fn orca_run_json_retry(cli: &str, args: &[&str], attempts: u32, timeout_ms: u64, backoff_ms: u64) -> Result<serde_json::Value, String> {
    let mut last = orca_run_json(cli, args, timeout_ms);
    for i in 1..attempts {
        match &last {
            Err(e) if !orca_is_terminal_error(e) => {
                std::thread::sleep(std::time::Duration::from_millis(backoff_ms * i as u64));
                last = orca_run_json(cli, args, timeout_ms);
            }
            _ => break,
        }
    }
    last
}

/// CLI는 실패도 exit 0 + {ok:false}로 반환하므로 JSON의 ok 필드까지 검사.
/// timeout_ms: std::process::Command에는 타임아웃이 없어 데몬이 멈추면 Tauri 커맨드가
/// 영구 블로킹된다 — 자식을 별도 스레드에서 wait하고 mpsc recv_timeout으로 시한을 건다.
fn orca_run_json(cli: &str, args: &[&str], timeout_ms: u64) -> Result<serde_json::Value, String> {
    let mut full: Vec<&str> = args.to_vec();
    full.push("--json");

    // ⚠️ 앱 프로세스의 env(bun/node_modules PATH, Electron 관련 변수 등)를 그대로 물려주면
    // Orca 데몬의 터미널 생성이 "Timed out waiting for terminal handle"로 실패한다.
    // → env_clear() 후 화이트리스트(HOME/USER/LOGNAME/SHELL/TMPDIR/LANG/PATH)만 전달.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let user = std::env::var("USER").unwrap_or_default();
    let logname = std::env::var("LOGNAME").unwrap_or_else(|_| user.clone());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let tmpdir = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
    let lang = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into());

    let child = Command::new(cli)
        .args(&full)
        .env_clear()
        .env("HOME", &home)
        .env("USER", &user)
        .env("LOGNAME", &logname)
        .env("SHELL", &shell)
        .env("TMPDIR", &tmpdir)
        .env("LANG", &lang)
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("orca 실행 실패: {}", e))?;

    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    // stdout/stderr 파이프를 끝까지 읽어야 자식이 블로킹되지 않으므로 wait_with_output()을 스레드에서 수행
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("orca 실행 실패: {}", e)),
        Err(_) => {
            #[cfg(unix)]
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
            #[cfg(windows)]
            let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).status();
            return Err(format!("orca 응답 시간 초과 ({}초)", timeout_ms / 1000));
        }
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "unknown".into() } else { stderr });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| format!("JSON 파싱 실패: {}", stdout.chars().take(200).collect::<String>()))?;
    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = parsed.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("unknown");
        return Err(msg.to_string());
    }
    Ok(parsed)
}

fn orca_wait_terminal_ready(cli: &str, handle: &str) {
    for _ in 0..12 {
        if let Ok(value) = orca_run_json(cli, &["terminal", "read", "--terminal", handle], 3_000) {
            let output = value.pointer("/result/output").and_then(|value| value.as_str())
                .or_else(|| value.pointer("/result/tail").and_then(|value| value.as_str()))
                .unwrap_or_default();
            if !output.trim().is_empty() { return; }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn orca_verify_agent_started(cli: &str, handle: &str) -> Result<(), String> {
    for _ in 0..4 {
        std::thread::sleep(Duration::from_millis(350));
        let Ok(value) = orca_run_json(cli, &["terminal", "read", "--terminal", handle], 3_000) else { continue; };
        let raw = value.pointer("/result/terminal/tail")
            .or_else(|| value.pointer("/result/terminal/output"))
            .or_else(|| value.pointer("/result/tail"))
            .or_else(|| value.pointer("/result/output"));
        let text = match raw {
            Some(serde_json::Value::Array(lines)) => lines.iter().filter_map(|line| line.as_str()).collect::<Vec<_>>().join("\n"),
            Some(serde_json::Value::String(text)) => text.clone(),
            _ => String::new(),
        };
        let lower = text.to_lowercase();
        if ["command not found", "no such file or directory", "cannot execute", "permission denied",
            "the system cannot find the path specified", "is not recognized as an internal or external command"]
            .iter().any(|pattern| lower.contains(pattern)) {
            let tail = text.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(tail.chars().rev().take(1_200).collect::<String>().chars().rev().collect());
        }
        if !text.trim().is_empty() { return Ok(()); }
    }
    // Full-screen TUIs may not expose a tail even though Orca accepted and started them.
    Ok(())
}

/// Cmd+T는 현재 worktree용이다. Orca의 전용 selector로 Floating tab을 직접 생성한다.
fn orca_create_floating_terminal(cli: &str, title: &str) -> Result<String, String> {
    let created = orca_run_json_retry(
        cli,
        &[
            "terminal", "create",
            "--worktree", "id:global-floating-terminal",
            "--title", title,
        ],
        3,
        ORCA_TIMEOUT_MS,
        700,
    ).map_err(|e| format!("Orca Floating Terminal 생성 실패: {}", e))?;
    let handle = created.pointer("/result/terminal/handle")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Orca가 전용 Floating Terminal 핸들을 반환하지 않았습니다. 일반 프로젝트 터미널에는 명령을 보내지 않았습니다.".to_string())?;
    let worktree_id = created.pointer("/result/terminal/worktreeId")
        .and_then(|value| value.as_str());
    if worktree_id != Some("global-floating-terminal") {
        return Err("Orca가 생성한 터미널이 Floating Workspace 소속이 아닙니다. 일반 프로젝트 터미널에는 명령을 보내지 않았습니다.".into());
    }
    orca_wait_terminal_ready(cli, handle);
    Ok(handle.to_string())
}

/// Floating 탭의 영속 식별자와 제목 마커 모두에 쓰는 경로 정규화다. Node sidecar와
/// 같은 규칙을 써야 두 프로세스가 같은 registry record를 재사용할 수 있다.
fn normalize_orca_floating_terminal_path(folder_path: &str) -> String {
    let slash_normalized = folder_path.trim().replace('\\', "/");
    let without_trailing = slash_normalized.trim_end_matches('/');
    if without_trailing.is_empty() {
        "/".to_string()
    } else {
        without_trailing.to_string()
    }
}

/// A marker in the terminal title lets AgentsToZ safely recognize only the Floating
/// tabs it owns for one exact agent + project pair. It intentionally avoids exposing
/// the complete project path in Orca's tab label.
fn orca_managed_floating_terminal_marker(agent: &str, folder_path: &str) -> String {
    let normalized_path = normalize_orca_floating_terminal_path(folder_path);
    let payload = format!("{}\0{}", agent, normalized_path);
    let mut hash: u32 = 0x811c9dc5;
    for byte in payload.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("[ATZ:{}:{:08x}]", agent, hash)
}

fn orca_managed_floating_terminal_title(
    name: Option<&str>,
    label: &str,
    agent: &str,
    folder_path: &str,
) -> String {
    let display_name = name.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("AgentsToZ");
    format!(
        "{} · {} · {}",
        display_name,
        label,
        orca_managed_floating_terminal_marker(agent, folder_path),
    )
}

/// The API sidecar and the Tauri command both own this file. Keep the macOS location
/// explicit because `open_orca_agent` has no `AppHandle`, and it must match
/// `app_data_dir()` for the `com.portmanager.portmanager` bundle identifier.
fn orca_floating_terminal_registry_dir() -> Result<std::path::PathBuf, String> {
    let data_dir = legacy_app_data_dir()?;

    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Orca Floating Terminal registry 폴더 생성 실패: {}", error))?;
    Ok(data_dir)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OrcaFloatingTerminalRecord {
    agent: String,
    #[serde(rename = "folderPath")]
    folder_path: String,
    handle: String,
    title: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct OrcaFloatingTerminalRegistry {
    #[serde(default)]
    version: u8,
    #[serde(default)]
    terminals: HashMap<String, OrcaFloatingTerminalRecord>,
}

fn empty_orca_floating_terminal_registry() -> OrcaFloatingTerminalRegistry {
    OrcaFloatingTerminalRegistry {
        version: 1,
        terminals: HashMap::new(),
    }
}

fn orca_floating_terminal_registry_paths() -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = orca_floating_terminal_registry_dir()?;
    Ok((
        dir.join("orca-floating-terminals.json"),
        dir.join("orca-floating-terminals.json.lock"),
    ))
}

fn read_orca_floating_terminal_registry(path: &std::path::Path) -> Result<OrcaFloatingTerminalRegistry, String> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            let parsed: serde_json::Value = match serde_json::from_str(&contents) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!(
                        "[Orca Floating] terminal registry parse failed; using title migration lookup: {}",
                        error
                    );
                    return Ok(empty_orca_floating_terminal_registry());
                }
            };
            let Some(records) = parsed.get("terminals").and_then(|value| value.as_object()) else {
                return Ok(empty_orca_floating_terminal_registry());
            };
            let mut terminals = HashMap::new();
            for (key, value) in records {
                let Some(record) = value.as_object() else { continue; };
                let Some(agent) = record.get("agent").and_then(|value| value.as_str()).filter(|value| !value.trim().is_empty()) else { continue; };
                let Some(folder_path) = record.get("folderPath").and_then(|value| value.as_str()).filter(|value| !value.trim().is_empty()) else { continue; };
                let Some(handle) = record.get("handle").and_then(|value| value.as_str()).filter(|value| !value.trim().is_empty()) else { continue; };
                let normalized_path = normalize_orca_floating_terminal_path(folder_path);
                if key != &orca_managed_floating_terminal_marker(agent, &normalized_path) {
                    continue;
                }
                terminals.insert(
                    key.clone(),
                    OrcaFloatingTerminalRecord {
                        agent: agent.to_string(),
                        folder_path: normalized_path,
                        handle: handle.to_string(),
                        title: record.get("title").and_then(|value| value.as_str()).unwrap_or_default().to_string(),
                        updated_at: record.get("updatedAt").and_then(|value| value.as_u64()).unwrap_or(0),
                    },
                );
            }
            Ok(OrcaFloatingTerminalRegistry {
                version: 1,
                terminals,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_orca_floating_terminal_registry()),
        Err(error) => {
            eprintln!(
                "[Orca Floating] terminal registry read failed; using title migration lookup: {}",
                error
            );
            Ok(empty_orca_floating_terminal_registry())
        }
    }
}

fn acquire_orca_floating_terminal_registry_lock(lock_path: &std::path::Path) -> Result<PortsFileLock, String> {
    acquire_ports_file_lock(lock_path)
        .map_err(|error| error.replace("ports.json", "Orca Floating Terminal registry"))
}

fn unix_timestamp_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn write_orca_floating_terminal_registry_atomically(
    path: &std::path::Path,
    registry: &OrcaFloatingTerminalRegistry,
) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(registry)
        .map_err(|error| format!("Orca Floating Terminal registry 직렬화 실패: {}", error))?;
    let parent = path.parent().ok_or_else(|| "Orca Floating Terminal registry 경로가 올바르지 않습니다.".to_string())?;
    let temporary = parent.join(format!(
        ".orca-floating-terminals.{}.{}.tmp",
        std::process::id(),
        unix_timestamp_millis(),
    ));

    fs::write(&temporary, contents)
        .map_err(|error| format!("Orca Floating Terminal registry 임시 저장 실패: {}", error))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Orca Floating Terminal registry 원자적 저장 실패: {}", error));
    }
    Ok(())
}

fn remembered_orca_floating_terminal(
    agent: &str,
    folder_path: &str,
) -> Result<Option<OrcaFloatingTerminalRecord>, String> {
    let (path, _) = orca_floating_terminal_registry_paths()?;
    let registry = read_orca_floating_terminal_registry(&path)?;
    let key = orca_managed_floating_terminal_marker(agent, folder_path);
    let normalized_path = normalize_orca_floating_terminal_path(folder_path);
    Ok(registry.terminals.get(&key).filter(|record| {
        record.agent == agent
            && normalize_orca_floating_terminal_path(&record.folder_path) == normalized_path
            && !record.handle.trim().is_empty()
    }).cloned())
}

fn remember_orca_floating_terminal(
    agent: &str,
    folder_path: &str,
    handle: &str,
    title: &str,
) -> Result<(), String> {
    let (path, lock_path) = orca_floating_terminal_registry_paths()?;
    let _lock = acquire_orca_floating_terminal_registry_lock(&lock_path)?;
    let mut registry = read_orca_floating_terminal_registry(&path)?;
    registry.version = 1;
    registry.terminals.insert(
        orca_managed_floating_terminal_marker(agent, folder_path),
        OrcaFloatingTerminalRecord {
            agent: agent.to_string(),
            folder_path: normalize_orca_floating_terminal_path(folder_path),
            handle: handle.to_string(),
            title: title.to_string(),
            updated_at: unix_timestamp_millis(),
        },
    );
    write_orca_floating_terminal_registry_atomically(&path, &registry)
}

fn forget_orca_floating_terminal(
    agent: &str,
    folder_path: &str,
    handle: &str,
) -> Result<(), String> {
    let (path, lock_path) = orca_floating_terminal_registry_paths()?;
    let _lock = acquire_orca_floating_terminal_registry_lock(&lock_path)?;
    let mut registry = read_orca_floating_terminal_registry(&path)?;
    let key = orca_managed_floating_terminal_marker(agent, folder_path);
    let should_remove = registry.terminals.get(&key)
        .map(|record| record.handle == handle)
        .unwrap_or(false);
    if should_remove {
        registry.terminals.remove(&key);
        write_orca_floating_terminal_registry_atomically(&path, &registry)?;
    }
    Ok(())
}

fn find_orca_floating_terminal_handle_in_value(value: &serde_json::Value, handle: &str) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter()
            .any(|item| find_orca_floating_terminal_handle_in_value(item, handle)),
        serde_json::Value::Object(fields) => {
            let matches_handle = fields.get("handle")
                .and_then(|value| value.as_str())
                .map(|value| value == handle)
                .unwrap_or(false);
            let is_floating = fields.get("worktreeId")
                .and_then(|value| value.as_str())
                == Some("global-floating-terminal");
            if matches_handle && is_floating {
                return true;
            }
            fields
                .values()
                .any(|child| find_orca_floating_terminal_handle_in_value(child, handle))
        }
        _ => false,
    }
}

fn is_orca_stale_terminal_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("terminal_handle_stale")
        || normalized.contains("unknown terminal")
        || normalized.contains("no such terminal")
        || normalized.contains("invalid terminal")
        || (normalized.contains("terminal")
            && (normalized.contains("not found")
                || normalized.contains("does not exist")
                || normalized.contains("missing")
                || normalized.contains("unknown")
                || normalized.contains("stale")))
}

enum RememberedOrcaFloatingTerminalValidation {
    Valid,
    Stale,
    Failed(String),
}

fn validate_remembered_orca_floating_terminal(
    cli: &str,
    handle: &str,
) -> RememberedOrcaFloatingTerminalValidation {
    match orca_run_json_retry(
        cli,
        &["terminal", "show", "--terminal", handle],
        2,
        8_000,
        500,
    ) {
        Ok(value) if find_orca_floating_terminal_handle_in_value(&value, handle) => {
            RememberedOrcaFloatingTerminalValidation::Valid
        }
        Ok(_) => RememberedOrcaFloatingTerminalValidation::Stale,
        Err(error) if is_orca_stale_terminal_error(&error) => {
            RememberedOrcaFloatingTerminalValidation::Stale
        }
        Err(error) => RememberedOrcaFloatingTerminalValidation::Failed(error),
    }
}

fn find_orca_managed_floating_terminal_in_value(
    value: &serde_json::Value,
    marker: &str,
    legacy_title: &str,
    latest_handle: &mut Option<String>,
    legacy_handles: &mut Vec<String>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                find_orca_managed_floating_terminal_in_value(item, marker, legacy_title, latest_handle, legacy_handles);
            }
        }
        serde_json::Value::Object(fields) => {
            let handle = fields.get("handle").and_then(|value| value.as_str());
            let title = fields.get("title").and_then(|value| value.as_str());
            let worktree_id = fields.get("worktreeId").and_then(|value| value.as_str());
            if let Some(handle) = handle.filter(|value| !value.trim().is_empty()) {
                if worktree_id == Some("global-floating-terminal") {
                    if title.map(|value| value.contains(marker)).unwrap_or(false) {
                        *latest_handle = Some(handle.to_string());
                    } else if title == Some(legacy_title) {
                        legacy_handles.push(handle.to_string());
                    }
                }
            }
            for child in fields.values() {
                find_orca_managed_floating_terminal_in_value(child, marker, legacy_title, latest_handle, legacy_handles);
            }
        }
        _ => {}
    }
}

/// Title matching is only a migration/fallback path. A terminal's shell can replace
/// its title, so ordinary reuse must prefer the persisted handle above.
fn find_existing_orca_floating_terminal(
    cli: &str,
    agent: &str,
    folder_path: &str,
    legacy_title: &str,
) -> Result<Option<String>, String> {
    let listed = orca_run_json_retry(
        cli,
        &[
            "terminal", "list",
            "--worktree", "id:global-floating-terminal",
        ],
        2,
        8_000,
        500,
    ).map_err(|error| format!("Orca Floating Terminal 목록 확인 실패: {}", error))?;
    let marker = orca_managed_floating_terminal_marker(agent, folder_path);
    let mut latest_handle = None;
    let mut legacy_handles = Vec::new();
    find_orca_managed_floating_terminal_in_value(&listed, &marker, legacy_title, &mut latest_handle, &mut legacy_handles);
    // Before title markers existed, a same-name project was ambiguous. Migrate only
    // an unambiguous legacy tab and never send it a new command.
    Ok(latest_handle.or_else(|| if legacy_handles.len() == 1 { legacy_handles.pop() } else { None }))
}

/// 재사용할 Floating 탭을 앞으로 가져온다.
///
/// 생성 경로와 달리 **재사용에는 Orca의 자동 포커스가 없다.** 워크스페이스만 띄우면
/// 직전에 보던 다른 프로젝트 탭이 그대로 앞에 남아 사용자에게는 "아무것도 안 열림"으로
/// 보인다(VOC 2026-08-14). 생성 경로가 `terminal switch`를 피하는 이유(메인 워크트리
/// 패널이 빈 저장소를 그린다)는 여기서도 유효하지만, 그쪽은 Orca가 새 탭을 알아서
/// 포커스하므로 switch가 부작용만 남는 반면 이쪽은 탭을 앞으로 낼 다른 방법이 없다.
///
/// ⚠️ 웹 API(`api-server.ts`의 `reuseExistingFloatingTerminal`)와 **같은 규칙이어야 한다.**
/// 앱은 이 Rust 경로로 실행한다 — 한쪽만 고치면 정작 앱에서 증상이 그대로 남는다.
fn orca_focus_reused_floating_terminal(cli: &str, handle: &str) -> Option<String> {
    orca_run_json_retry(cli, &["terminal", "switch", "--terminal", handle], 2, ORCA_SWITCH_TIMEOUT_MS, ORCA_BACKOFF_MS)
        .err()
        .map(|error| format!("재사용할 탭을 앞으로 가져오지 못했습니다. Orca Floating Workspace에서 직접 선택하세요. ({})", error))
}

fn orca_floating_terminal_warning_suffix(
    registry_warning: Option<String>,
    reveal_warning: Option<String>,
) -> String {
    orca_floating_terminal_warning_suffix_with_switch(registry_warning, None, reveal_warning)
}

fn orca_floating_terminal_warning_suffix_with_switch(
    registry_warning: Option<String>,
    switch_warning: Option<String>,
    reveal_warning: Option<String>,
) -> String {
    let mut warnings = Vec::new();
    if let Some(warning) = registry_warning {
        warnings.push(format!("⚠ Orca Floating Terminal 재사용 정보 저장 실패: {}", warning));
    }
    if let Some(warning) = switch_warning {
        warnings.push(format!("⚠ {}", warning));
    }
    if let Some(warning) = reveal_warning {
        warnings.push(format!(
            "⚠ {} Orca에서 Cmd/Ctrl+Alt+A를 눌러 확인하세요.",
            warning
        ));
    }
    if warnings.is_empty() {
        String::new()
    } else {
        format!("\n{}", warnings.join("\n"))
    }
}

/// Mirrors `shouldFallBackToOrcaFloatingTerminal` in `src/orcaWorktreeSupport.ts` — keep
/// both in sync. `selector_not_found` means Orca does not track this path as a worktree
/// at all; a bare `unknown` (after `orca_run_json_retry`'s own attempts are exhausted)
/// means the CLI call returned no parseable output, most often a daemon hiccup under
/// load. Both are indistinguishable from here, and Floating is strictly safer than a
/// hard failure for a worktree the user has opened before without issue. A
/// deterministic error such as "not a valid git repository" would fail in Floating too,
/// so it is deliberately left out and still surfaces as a real error.
fn orca_should_fall_back_to_floating(error: &str) -> bool {
    let trimmed = error.trim();
    trimmed.contains("selector_not_found")
        || trimmed.to_lowercase().ends_with("unknown")
}

fn orca_create_worktree_terminal(cli: &str, title: &str, worktree_path: &str) -> Result<String, String> {
    let selector = format!("path:{}", worktree_path);
    let created = orca_run_json_retry(
        cli,
        &["terminal", "create", "--worktree", &selector, "--title", title],
        3,
        ORCA_TIMEOUT_MS,
        700,
    ).map_err(|e| format!("Orca 워크트리 터미널 생성 실패: {}", e))?;
    let handle = created.pointer("/result/terminal/handle")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Orca가 워크트리 내부 터미널 핸들을 반환하지 않았습니다. Floating Workspace에는 명령을 보내지 않았습니다.".to_string())?;
    if created.pointer("/result/terminal/worktreeId").and_then(|value| value.as_str()) == Some("global-floating-terminal") {
        return Err("Orca가 워크트리 대신 Floating Workspace 터미널을 반환했습니다. 아무 명령도 보내지 않았습니다.".into());
    }
    orca_wait_terminal_ready(cli, handle);
    Ok(handle.to_string())
}

fn collect_orca_accessibility_strings(value: &serde_json::Value, output: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => output.push(text.clone()),
        serde_json::Value::Array(items) => {
            for item in items { collect_orca_accessibility_strings(item, output); }
        }
        serde_json::Value::Object(items) => {
            for item in items.values() { collect_orca_accessibility_strings(item, output); }
        }
        _ => {}
    }
}

fn inspect_orca_floating_visibility(value: &serde_json::Value) -> (bool, Option<u64>) {
    let mut strings = Vec::new();
    collect_orca_accessibility_strings(value, &mut strings);
    let open = strings.iter().any(|text| text.contains("Minimize floating workspace"));
    let mut toggle_index = None;
    for text in &strings {
        for line in text.lines() {
            if !line.contains("Show floating workspace") || !line.contains("toggle button") { continue; }
            let trimmed = line.trim_start();
            let digits: String = trimmed.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if !digits.is_empty() {
                toggle_index = digits.parse::<u64>().ok();
                break;
            }
        }
        if toggle_index.is_some() { break; }
    }
    (open, toggle_index)
}

#[cfg(target_os = "macos")]
fn orca_maximize_floating_workspace_shortcut() -> Result<(), String> {
    // Orca의 `floatingWorkspace.maximize` 기본 단축키다. toggle이 아니므로
    // 이미 열린 패널을 닫지 않으며 computer API 런타임이 없어도 사용할 수 있다.
    let script = concat!(
        "tell application \"Orca\" to activate\n",
        "delay 0.15\n",
        "tell application \"System Events\" to keystroke \"a\" using {command down, option down, shift down}"
    );
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Orca 플로팅 최대화 단축키 실행 실패: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let normalized = detail.to_ascii_lowercase();
        let permission_denied = detail.contains("1002")
            || normalized.contains("not allowed to send keystrokes")
            || normalized.contains("assistive access");
        if permission_denied {
            let _ = Command::new("/usr/bin/open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                .output();
        }
        Err(format!(
            "Orca 플로팅 최대화 단축키 전송 실패: {}. macOS 손쉬운 사용 설정{}AgentsToZ_byCS를 허용해주세요.",
            if detail.is_empty() { "unknown" } else { &detail },
            if permission_denied { "을 열었습니다. " } else { "에서 " },
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn orca_maximize_floating_workspace_shortcut() -> Result<(), String> {
    Err("Orca 화면 제어 API를 사용할 수 없습니다.".into())
}

/// `terminal switch`/`tab show`는 최소화된 Floating Workspace를 열지 않는다.
/// Orca 자신의 computer-use 접근성 트리에서 닫힌 토글을 찾아 실제 패널을 표시한다.
fn orca_reveal_floating_workspace(cli: &str) -> Result<(), String> {
    let read_state = || orca_run_json_retry(
        cli,
        &["computer", "get-app-state", "--app", "Orca", "--restore-window", "--no-screenshot"],
        2,
        8_000,
        300,
    );

    let before = match read_state() {
        Ok(value) => value,
        Err(error) => return orca_maximize_floating_workspace_shortcut()
            .map_err(|fallback| format!("Orca 화면 상태 확인 실패: {}; {}", error, fallback)),
    };
    let (already_open, toggle_index) = inspect_orca_floating_visibility(&before);
    if already_open { return Ok(()); }
    let index = match toggle_index {
        Some(value) => value,
        None => return orca_maximize_floating_workspace_shortcut()
            .map_err(|fallback| format!("Orca에서 ‘Show floating workspace’ 버튼을 찾지 못했습니다. {}", fallback)),
    };
    let index_text = index.to_string();
    if let Err(error) = orca_run_json_retry(
        cli,
        &["computer", "click", "--app", "Orca", "--element-index", &index_text, "--restore-window", "--no-screenshot"],
        2,
        8_000,
        300,
    ) {
        return orca_maximize_floating_workspace_shortcut()
            .map_err(|fallback| format!("Orca 플로팅 패널 표시 실패: {}; {}", error, fallback));
    }

    let after = read_state().map_err(|e| format!("Orca 플로팅 패널 확인 실패: {}", e))?;
    if inspect_orca_floating_visibility(&after).0 {
        Ok(())
    } else {
        Err("Orca 터미널은 생성됐지만 플로팅 패널이 열린 것을 확인하지 못했습니다.".into())
    }
}

#[tauri::command]
fn open_orca_agent(agent: Option<String>, name: Option<String>, folder_path: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, floating: Option<bool>, new_window: Option<bool>) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let expand = |p: &str| -> String {
        if p == "~" { home.clone() }
        else if let Some(rest) = p.strip_prefix("~/") { format!("{}/{}", home, rest) }
        else { p.to_string() }
    };
    let repo_path = folder_path.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(expand).map(resolve_orca_project_path);
    let wt_first = first_worktree(&worktree_path).map(|s| resolve_orca_project_path(expand(&s)));
    let cd_path = wt_first.clone().or_else(|| repo_path.clone())
        .ok_or_else(|| "프로젝트 경로가 없습니다.".to_string())?;

    let cli = resolve_orca_cli().ok_or_else(bootstrap_orca_install)?;

    // 동시 요청(더블클릭 등)이 겹치면 블로킹 CLI 호출이 쌓이며 호스트가 죽는 현상을 확인 —
    // open → repo add → terminal create → send → switch 전 구간을 락으로 직렬화한다.
    let _guard = ORCA_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // orca open — 앱 실행 + 런타임 대기 (이미 떠 있으면 ~150ms)
    orca_ensure_ready(&cli)?;

    let use_bypass = bypass.unwrap_or(false);
    let mut use_floating = floating.unwrap_or(true);
    let force_new_window = new_window.unwrap_or(false);
    let agent_kind = agent.as_deref().unwrap_or("claude");
    // ⚠️ bare 이름(agy 등)을 그대로 보내면 Orca가 띄우는 셸의 PATH에 ~/.local/bin이 없어
    // "command not found"가 된다 — 반드시 절대경로로 해석해서 보낸다.
    // Windows Orca 터미널은 WSL bash다. 실제 Windows .exe를 /mnt/<drive>/...로 바꾸면
    // npm shim/PATH 차이 없이 WSL interop으로 Claude/Codex/agy를 동일하게 실행할 수 있다.
    // Windows Floating은 WSL/Linux, worktree-owned terminal은 cmd.exe다.
    let use_wsl_shell = cfg!(target_os = "windows") && use_floating;
    let agent_cmd = |bin: &str, flag: &str| orca_agent_command(bin, flag, use_bypass, use_wsl_shell);
    let (cmd, label, managed_agent): (Option<String>, &str, &str) = match agent_kind {
        "codex" => (agent_cmd("codex", "--dangerously-bypass-approvals-and-sandbox"), "Codex", "codex"),
        "agy" => (agent_cmd("agy", "--dangerously-skip-permissions"), "Antigravity", "agy"),
        "hermes" => (agent_cmd("hermes", ""), "Hermes", "hermes"),
        "agents" => (agent_cmd("claude", "--dangerously-skip-permissions").map(|command| format!("{} agents", command)), "agents", "agents"),
        "terminal" => (None, "터미널", "terminal"),
        _ => (agent_cmd("claude", "--dangerously-skip-permissions"), "Claude", "claude"),
    };
    let display_name = name.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or("AgentsToZ");
    let legacy_terminal_title = format!("{} · {}", display_name, label);
    let mut terminal_title = if use_floating {
        orca_managed_floating_terminal_title(name.as_deref(), label, managed_agent, &cd_path)
    } else {
        legacy_terminal_title.clone()
    };
    // 일반 실행은 기존 앱 관리 탭을 보여주기만 한다. 살아 있는 Claude/Codex/agy
    // TUI에 `cd && agent` 명령을 다시 보내면 프롬프트 입력으로 오인될 수 있다.
    //
    // 제목은 shell/TUI가 바꿀 수 있어 재사용 식별자로 충분하지 않다. 먼저 registry의
    // handle을 `terminal show`로 확인하고, stale일 때만 제목 기반 목록 조회로 마이그레이션
    // 한다. Orca 상태 조회가 일시 실패한 경우 새 탭을 만들면 "실패할 때마다 새창"이 되므로
    // 명시적으로 실패시킨다.
    if use_floating && !force_new_window {
        let remembered = remembered_orca_floating_terminal(managed_agent, &cd_path).map_err(|error| {
            format!(
                "기존 Orca Floating Terminal 재사용 정보를 읽지 못했습니다. 새 탭을 만들지 않았습니다. Orca가 준비된 뒤 다시 시도해주세요.\n({})",
                error
            )
        })?;
        if let Some(record) = remembered {
            match validate_remembered_orca_floating_terminal(&cli, &record.handle) {
                RememberedOrcaFloatingTerminalValidation::Valid => {
                    let switch_warning = orca_focus_reused_floating_terminal(&cli, &record.handle);
                    let reveal_warning = orca_reveal_floating_workspace(&cli).err();
                    return Ok(format!(
                        "Orca Floating Terminal의 기존 {} 탭을 재사용했습니다{}",
                        label,
                        orca_floating_terminal_warning_suffix_with_switch(None, switch_warning, reveal_warning),
                    ));
                }
                RememberedOrcaFloatingTerminalValidation::Stale => {
                    forget_orca_floating_terminal(managed_agent, &cd_path, &record.handle).map_err(|error| {
                        format!(
                            "기존 Orca Floating Terminal 탭이 이미 종료됐지만 재사용 정보를 정리하지 못했습니다. 새 탭을 만들지 않았습니다.\n({})",
                            error
                        )
                    })?;
                }
                RememberedOrcaFloatingTerminalValidation::Failed(error) => {
                    return Err(format!(
                        "기존 Orca Floating Terminal의 {} 탭을 확인하지 못했습니다. 새 탭을 만들지 않았습니다. Orca가 준비된 뒤 다시 시도해주세요.\n({})",
                        label,
                        error
                    ));
                }
            }
        }

        match find_existing_orca_floating_terminal(&cli, managed_agent, &cd_path, &legacy_terminal_title) {
            Ok(Some(handle)) => {
                // 제목 기반으로 발견한 기존 탭은 이후 title 변경에도 재사용되도록 registry에
                // 승격한다. 저장만 실패해도 이미 확인된 탭을 다시 열 수는 있다.
                let registry_warning = remember_orca_floating_terminal(
                    managed_agent,
                    &cd_path,
                    &handle,
                    &terminal_title,
                ).err();
                let switch_warning = orca_focus_reused_floating_terminal(&cli, &handle);
                let reveal_warning = orca_reveal_floating_workspace(&cli).err();
                return Ok(format!(
                    "Orca Floating Terminal의 기존 {} 탭을 재사용했습니다{}",
                    label,
                    orca_floating_terminal_warning_suffix_with_switch(registry_warning, switch_warning, reveal_warning),
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!(
                    "기존 Orca Floating Terminal의 {} 탭 목록을 확인하지 못했습니다. 새 탭을 만들지 않았습니다. Orca가 준비된 뒤 다시 시도해주세요.\n({})",
                    label,
                    error
                ));
            }
        }
    }
    if agent_kind != "terminal" && cmd.is_none() {
        return Err(format!("{} 실행 파일을 찾지 못했습니다. 설치 경로와 로그인 셸 PATH를 확인한 뒤 다시 시도해주세요.", label));
    }
    if !use_floating {
        if let Some(path) = wt_first.as_deref() { reject_hidden_orca_worktree(path)?; }
        let reg_target = repo_path.as_deref().unwrap_or(&cd_path);
        orca_run_json_retry(&cli, &["repo", "add", "--path", reg_target], 3, ORCA_TIMEOUT_MS, ORCA_BACKOFF_MS)
            .map_err(|e| format!("Orca repo 등록 실패: {}", e))?;
    }
    let mut fallback_notice: Option<String> = None;
    let handle = if use_floating {
        orca_create_floating_terminal(&cli, &terminal_title)?
    } else {
        match orca_create_worktree_terminal(&cli, &terminal_title, &cd_path) {
            Ok(h) => h,
            Err(e) if orca_should_fall_back_to_floating(&e) => {
                use_floating = true;
                terminal_title = orca_managed_floating_terminal_title(name.as_deref(), label, managed_agent, &cd_path);
                fallback_notice = Some(format!(
                    "⚠ Orca에 등록된 워크트리가 아니라 워크트리 내부 터미널을 만들 수 없어 Floating Terminal로 열었습니다. ({})\n워크트리 내부에서 열려면 Orca에 해당 저장소를 먼저 추가하세요.",
                    cd_path,
                ));
                orca_create_floating_terminal(&cli, &terminal_title)?
            }
            Err(e) => return Err(e),
        }
    };
    let has_cmd = cmd.is_some();
    let terminal_command = build_orca_terminal_command(&cd_path, cmd.as_deref(), use_wsl_shell);
    let surface_label = if use_floating { "Floating Terminal" } else { "워크트리 터미널" };
    orca_run_json_retry(&cli, &["terminal", "send", "--terminal", &handle, "--text", &terminal_command, "--enter"], 3, ORCA_TIMEOUT_MS, ORCA_BACKOFF_MS)
        .map_err(|e| format!("Orca {} 명령 전송 실패: {}", surface_label, e))?;
    if has_cmd {
        orca_verify_agent_started(&cli, &handle)
            .map_err(|e| format!("Orca {}에서 {} 실행 실패: {}", surface_label, label, e))?;
    }
    // 새 창 강제 실행도 가장 최근 handle을 기록한다. 이후 일반 실행은 이 탭을
    // 재사용하므로 같은 프로젝트·에이전트 조합의 새 창이 계속 늘지 않는다. 저장 실패는
    // 이미 정상적으로 생성·실행된 터미널을 실패로 바꾸지 않고 경고로만 돌려준다.
    let registry_warning = if use_floating {
        remember_orca_floating_terminal(managed_agent, &cd_path, &handle, &terminal_title).err()
    } else {
        None
    };
    // `terminal switch` points Orca's MAIN window at a terminal tab. In floating mode
    // the handle belongs to the `global-floating-terminal` pseudo-worktree, so switching
    // makes the main worktree pane render a worktree with no repo behind it — the
    // floating terminal opens fine while the worktree area goes blank. Floating is
    // surfaced by orca_reveal_floating_workspace() below instead.
    if !use_floating {
        orca_run_json_retry(&cli, &["terminal", "switch", "--terminal", &handle], 2, ORCA_SWITCH_TIMEOUT_MS, ORCA_BACKOFF_MS)
            .map_err(|e| format!("Orca {} 화면 전환 실패: {}", surface_label, e))?;
    }
    let reveal_warning = if use_floating {
        orca_reveal_floating_workspace(&cli).err()
    } else {
        None
    };
    let fallback_suffix = fallback_notice.map(|notice| format!("\n{}", notice)).unwrap_or_default();
    Ok(format!(
        "Orca {}에 {}{} 명령 전송 완료{}{}",
        surface_label,
        label,
        if use_bypass && has_cmd { " ⚡" } else { "" },
        orca_floating_terminal_warning_suffix(registry_warning, reveal_warning),
        fallback_suffix,
    ))
}

/// 선택한 프로젝트/워크트리에 Orca 브라우저 탭으로 localhost를 연다.
/// repo add는 멱등이므로 기존 프로젝트는 재사용하고, 없는 프로젝트만 등록한다.
#[tauri::command]
fn open_orca_localhost(port: u16, folder_path: Option<String>, worktree_path: Option<String>, floating: Option<bool>) -> Result<String, String> {
    if port == 0 { return Err("올바른 포트 번호가 필요합니다.".into()); }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let expand = |p: &str| -> String {
        if p == "~" { home.clone() }
        else if let Some(rest) = p.strip_prefix("~/") { format!("{}/{}", home, rest) }
        else { p.to_string() }
    };
    // 플로팅 모드면 탭도 Orca Floating Workspace에 띄운다 — AI 실행 위치와 같은 규칙.
    // 워크트리가 Orca 사이드바에 안 보이는 저장소에서도 미리보기가 확실히 뜬다는 이점도 있다.
    let use_floating = floating.unwrap_or(false);
    let repo_path = folder_path.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(expand).map(resolve_orca_project_path);
    let wt_first = first_worktree(&worktree_path).map(|s| resolve_orca_project_path(expand(&s)));
    // 숨김 경로 경고는 워크트리 내부 모드에서만 의미가 있다(플로팅은 경로에 매이지 않는다).
    if !use_floating {
        if let Some(path) = wt_first.as_deref() { reject_hidden_orca_worktree(path)?; }
    }
    let cd_path = wt_first.or_else(|| repo_path.clone())
        .ok_or_else(|| "프로젝트 경로가 없습니다.".to_string())?;
    let cli = resolve_orca_cli().ok_or_else(bootstrap_orca_install)?;

    // open → repo add → tab create 전 구간 직렬화. Orca CLI 동시 호출은
    // 런타임 불안정과 호스트 크래시를 유발한 이력이 있다.
    let _guard = ORCA_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    orca_ensure_ready(&cli)?;

    // 플로팅 탭은 저장소에 매이지 않으므로 repo 등록이 필요 없다(= git 아닌 폴더도 동작).
    if !use_floating {
        let reg_target = repo_path.as_deref().unwrap_or(&cd_path);
        if let Err(e) = orca_run_json_retry(&cli, &["repo", "add", "--path", reg_target], 1, 5_000, ORCA_BACKOFF_MS) {
            if orca_is_terminal_error(&e) {
                return Err(format!("Orca는 git 저장소만 지원합니다 ({})\n일반 폴더는 cmux/기본 브라우저를 사용하세요.", reg_target));
            }
            return Err(format!("Orca repo 등록 실패: {}", e));
        }
    }

    let localhost_url = format!("http://localhost:{}", port);
    let worktree_sel = if use_floating {
        "id:global-floating-terminal".to_string()
    } else {
        format!("path:{}", cd_path)
    };
    let mut created = orca_run_json_retry(
        &cli,
        &["tab", "create", "--url", &localhost_url, "--worktree", &worktree_sel],
        1,
        8_000,
        ORCA_BACKOFF_MS,
    );
    // Windows: id:global-floating-terminal 미지원 시 경로 기반 선택자로 fallback.
    if use_floating {
        if let Err(e) = &created {
            if e.contains("selector_not_found") {
                let path_sel = format!("path:{}", cd_path);
                created = orca_run_json_retry(
                    &cli,
                    &["tab", "create", "--url", &localhost_url, "--worktree", &path_sel],
                    1,
                    8_000,
                    ORCA_BACKOFF_MS,
                );
            }
        }
    }
    let created = created.map_err(|e| format!("Orca localhost 탭 생성 실패: {}", e))?;
    let browser_page_id = created.pointer("/result/browserPageId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Orca가 브라우저 page ID를 반환하지 않아 탭 생성을 확인할 수 없습니다.".to_string())?;
    let shown = orca_run_json_retry(
        &cli,
        &["tab", "show", "--page", browser_page_id],
        2,
        2_000,
        200,
    );
    let verified = shown.as_ref().ok().map(|value| {
        let tab = value.pointer("/result/tab").unwrap_or_else(|| value.pointer("/result").unwrap_or(value));
        let shown_id = tab.get("browserPageId").and_then(|value| value.as_str());
        let shown_url = tab.get("url").and_then(|value| value.as_str()).unwrap_or_default().trim_end_matches('/');
        shown_id == Some(browser_page_id) && shown_url == localhost_url.trim_end_matches('/')
    }).unwrap_or(false);
    if !verified {
        let _ = orca_run_json(&cli, &["tab", "close", "--page", browser_page_id], 5_000);
        return Err("Orca가 성공을 반환했지만 실제 브라우저 탭을 확인하지 못했습니다. 이 워크트리가 Orca 사이드바에 표시되는지 확인하거나 Orca 관리 워크트리로 다시 만들어주세요.".to_string());
    }
    let reveal_warning = if use_floating {
        orca_reveal_floating_workspace(&cli).err()
    } else {
        None
    };
    Ok(if use_floating {
        format!(
            "Orca 플로팅 워크스페이스에서 localhost:{} 열림{}",
            port,
            reveal_warning.map(|warning| format!("\n⚠ {} Orca에서 Cmd/Ctrl+Alt+A를 눌러 확인하세요.", warning)).unwrap_or_default(),
        )
    } else {
        format!("Orca 프로젝트에서 localhost:{} 열림", port)
    })
}

/// Orca 워크스페이스만 연다 (repo add, terminal create 없음) — 순수 앱 실행 용도.
#[tauri::command]
fn open_orca_app() -> Result<String, String> {
    let cli = resolve_orca_cli().ok_or_else(bootstrap_orca_install)?;
    let _guard = ORCA_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    orca_run_json_retry(&cli, &["open"], 3, ORCA_OPEN_TIMEOUT_MS, ORCA_BACKOFF_MS)
        .map_err(|e| format!("Orca 실행 실패(open): {}", e))?;
    if cfg!(target_os = "macos") {
        Command::new("open").args(["-a", "Orca"]).spawn().map(reap_detached)
            .map_err(|e| format!("Orca 앱 열기 실패: {}", e))?;
    }
    Ok("Orca 워크스페이스를 열었습니다".into())
}

#[tauri::command]
fn open_claude_bg(folder_path: Option<String>, name: String, bypass: Option<bool>) -> Result<String, String> {
    let use_bypass = bypass.unwrap_or(false);

    // Windows에는 zsh/claude 네이티브 설치가 없으므로 WSL 안에서 claude --bg를 돌린다.
    // terminalApp이 orca든 wsl이든 동일 — bg 모드는 "터미널 탭을 만들지 않는다"는
    // 실행 방식일 뿐 어느 터미널앱을 골랐는지와는 무관하다.
    #[cfg(target_os = "windows")]
    {
        let distro = find_wsl_distro()
            .ok_or_else(|| "WSL Ubuntu distro를 찾을 수 없습니다. wsl 모드 설정 후 다시 시도하세요.".to_string())?;
        let raw_path = folder_path.filter(|s| !s.trim().is_empty());
        let label = if !name.trim().is_empty() {
            name.clone()
        } else {
            raw_path
                .as_deref()
                .and_then(|p| p.split(['/', '\\']).filter(|s| !s.is_empty()).last())
                .unwrap_or("project")
                .to_string()
        };
        let cd_part = raw_path
            .map(|p| format!("cd '{}' && ", escape_sq(&win_to_wsl_path(&p))))
            .unwrap_or_default();
        let escaped_prompt = escape_sq(&format!("{} 작업 시작", label));
        let bg_args = if use_bypass {
            format!("claude --dangerously-skip-permissions --bg '{}'", escaped_prompt)
        } else {
            format!("claude --bg '{}'", escaped_prompt)
        };
        Command::new("wsl")
            .args(["-d", &distro, "--", "bash", "-lc", &format!("{}{}", cd_part, bg_args)])
            .spawn()
            .map(reap_detached)
            .map_err(|e| format!("WSL claude --bg 실행 실패: {}", e))?;
        return Ok(format!("WSL에서 claude --bg 시작 ({})", label));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let raw_path = folder_path.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| home.clone());
        // 싱글 쿼트 안에서 ~ 는 확장되지 않으므로 미리 절대경로로 치환
        let cd_path = if raw_path == "~" {
            home.clone()
        } else if raw_path.starts_with("~/") {
            format!("{}/{}", home, &raw_path[2..])
        } else {
            raw_path
        };
        let label = if !name.trim().is_empty() {
            name.clone()
        } else {
            cd_path.split('/').filter(|s| !s.is_empty()).last().unwrap_or("project").to_string()
        };
        let prompt = format!("{} 작업 시작", label);

        // login shell로 실행 — ~/.zshrc 소싱 → 올바른 PATH + claude 인증 토큰 자동 로드
        // (Tauri 직접 spawn은 Finder 실행 시 최소 PATH만 상속받아 claude/node를 못 찾음)
        let claude_cli = resolve_claude_cli();
        let bypass_flag = if use_bypass { " --dangerously-skip-permissions" } else { "" };
        let escaped_prompt = prompt.replace('\'', "'\"'\"'"); // sh single-quote escape
        let shell_cmd = format!(
            "cd '{}' && '{}'{} --bg '{}'",
            escape_sq(&cd_path),
            claude_cli,
            bypass_flag,
            escaped_prompt
        );

        let out = Command::new("/bin/zsh")
            .args(["-l", "-c", &shell_cmd])
            .output()
            .map_err(|e| format!("claude --bg 실행 실패: {}", e))?;

        if !out.status.success() {
            // 프론트엔드에서 "claude --bg 실패:" 프리픽스를 붙이므로, 여기서는 raw 에러만 반환
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let combined = if !stderr.is_empty() && !stdout.is_empty() {
                format!("{}\n{}", stderr, stdout)
            } else if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "알 수 없는 오류".into()
            };
            return Err(combined);
        }
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok(format!("agent view에 등록됨: {}\n{}", label, stdout));
    }
}

/// If the error pattern suggests access denied (cmuxOnly mode), append guidance.
fn cmux_access_help_msg(base: &str) -> String {
    format!(
        "{}\n\n💡 cmux 설정 확인: cmux 메뉴 → Settings → Socket Control → \"Allow All\"로 변경 후 재시도하세요. (현재 cmuxOnly 모드는 외부 앱의 호출을 차단)",
        base
    )
}

#[tauri::command]
fn get_global_shortcut(app: tauri::AppHandle) -> String {
    let path = ensure_app_data_dir(&app)
        .map(|d| d.join("shortcut.json"));
    path.ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["shortcut"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "CommandOrControl+Alt+P".to_string())
}

#[tauri::command]
fn set_global_shortcut(app: tauri::AppHandle, shortcut: String, old_shortcut: String) -> Result<(), String> {
    if !old_shortcut.is_empty() {
        let _ = app.global_shortcut().unregister(old_shortcut.as_str());
    }
    app.global_shortcut().register(shortcut.as_str())
        .map_err(|e| e.to_string())?;
    let path = ensure_app_data_dir(&app)?.join("shortcut.json");
    let json = serde_json::json!({ "shortcut": shortcut });
    std::fs::write(&path, json.to_string())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
struct DetectedStartCommand {
    command: Option<String>,
    framework: String,
}

// scripts.dev/start의 실제 내용으로 framework 판별 — config 파일 존재 여부만으로 판단하면
// "vite.config.ts는 있지만 dev 스크립트는 커스텀 코디네이터(예: bun dev.ts)"인 프로젝트를
// 잘못 순수 vite/next 프로젝트로 오판해 워크트리 실행 시 잘못된 툴로 덮어쓰게 된다.
fn detect_framework(script_content: Option<&str>) -> String {
    match script_content.map(|s| s.trim()) {
        Some(s) if s.starts_with("next dev") => "next".to_string(),
        Some(s) if s.starts_with("vite") => "vite".to_string(),
        _ => "other".to_string(),
    }
}

#[tauri::command]
fn detect_start_command(folder_path: String) -> DetectedStartCommand {
    let path = std::path::Path::new(&folder_path);

    // package.json → bun run dev / bun run start
    let pkg_path = path.join("package.json");
    if pkg_path.exists() {
        if let Ok(content) = fs::read_to_string(&pkg_path) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(scripts) = pkg.get("scripts") {
                    if let Some(dev) = scripts.get("dev").and_then(|v| v.as_str()) {
                        return DetectedStartCommand { command: Some("bun run dev".to_string()), framework: detect_framework(Some(dev)) };
                    }
                    if let Some(start) = scripts.get("start").and_then(|v| v.as_str()) {
                        return DetectedStartCommand { command: Some("bun run start".to_string()), framework: detect_framework(Some(start)) };
                    }
                }
            }
        }
        return DetectedStartCommand { command: Some("bun run dev".to_string()), framework: "other".to_string() };
    }

    // pyproject.toml → uv run
    if path.join("pyproject.toml").exists() {
        return DetectedStartCommand { command: Some("uv run python main.py".to_string()), framework: "other".to_string() };
    }

    // Cargo.toml → cargo run
    if path.join("Cargo.toml").exists() {
        return DetectedStartCommand { command: Some("cargo run".to_string()), framework: "other".to_string() };
    }

    // 루트에 매니페스트가 없는 프로젝트(실행 대상이 frontend/·backend/ 등 하위에 있고
    // 루트의 플랫폼별 실행 스크립트가 그것들을 함께 띄우는 형태)를 위한 폴백.
    // 규칙은 `src/startCommandDetection.ts`와 같다 — 여러 개면 고르지 않는다.
    if let Some(name) = pick_command_launcher(path) {
        return DetectedStartCommand {
            command: Some(path.join(name).to_string_lossy().to_string()),
            framework: "other".to_string(),
        };
    }

    DetectedStartCommand { command: None, framework: "other".to_string() }
}

/// 루트 플랫폼별 런처 선택. 후보가 여럿이면 이름으로 딱 하나가 가려질 때만 고르고,
/// 그래도 모호하면 아무것도 고르지 않는다 — 엉뚱한 실행보다 명확한 실패가 낫다.
fn pick_command_launcher(dir: &std::path::Path) -> Option<String> {
    let mut candidates: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| {
            let lower = name.to_lowercase();
            if cfg!(target_os = "windows") {
                lower.ends_with(".bat") || lower.ends_with(".cmd") || lower.ends_with(".ps1")
            } else {
                lower.ends_with(".command") || lower.ends_with(".sh")
            }
        })
        .filter(|name| {
            let lower = name.to_lowercase();
            // 이 앱이 설치하는 보조 스크립트는 프로젝트 실행이 아니다.
            !(name.contains("포트에추가") || lower.contains("add-port") || lower.contains("addport") || lower.contains("install"))
        })
        .collect();
    candidates.sort();
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return candidates.into_iter().next();
    }
    let conventional: Vec<String> = candidates
        .into_iter()
        .filter(|name| {
            let lower = name.to_lowercase();
            name.contains("실행")
                || lower.contains("start")
                || lower.contains("run")
                || lower.contains("dev")
                || lower.contains("launch")
                || lower.contains("serve")
        })
        .collect();
    if conventional.len() == 1 {
        return conventional.into_iter().next();
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let window_visible = Arc::new(Mutex::new(true));
  let vis_shortcut = Arc::clone(&window_visible);
  let vis_close = Arc::clone(&window_visible);
  tauri::Builder::default()
    .manage(AppState {
        processes: Arc::new(Mutex::new(HashMap::new())),
        launching: Mutex::new(HashSet::new()),
        api_sidecar: Mutex::new(None),
        api_supervisor_stop: Arc::new(AtomicBool::new(false)),
    })
    .invoke_handler(tauri::generate_handler![
        load_ports,
        save_ports,
        save_ports_merged,
        load_last_visits,
        save_last_visit,
        scan_command_files,
        open_app_data_dir,
        load_portal,
        save_portal,
        load_workspace_roots,
        save_workspace_roots,
        validate_folder_path,
        execute_command,
        detect_start_command,
        stop_command,
        force_restart_command,
        detect_port,
        check_port_status,
        check_ports_status_batch,
        build_app,
        open_build_folder,
        open_folder,
        open_code_app,
        import_ports_from_file,
        list_browser_profiles,
        open_in_chrome,
        open_log,
        read_log_content,
        check_wsl,
        install_wsl,
        install_wsl_tmux,
        open_tmux_claude,
        open_tmux_claude_fresh,
        open_tmux_claude_bypass,
        open_terminal_claude,
        open_terminal_claude_bypass,
        open_terminal_codex,
        open_terminal_agy,
        open_terminal_hermes,
        open_terminal_at_folder,
        open_tmux_codex,
        open_tmux_agy,
        run_claude_with_prompt,
        export_dmg,
        detect_git_remote_url,
        git_init,
        git_reinitialize,
        git_worktree_add,
        git_worktree_move,
        git_worktree_remove,
        git_merge_branch,
        list_git_worktrees,
        check_file_exists,
        create_folder,
        clone_repository,
        suggest_name,
        suggest_names_batch,
        open_cmux_claude,
        open_cmux_claude_new,
        open_cmux_codex,
        open_cmux_agy,
        open_cmux_hermes,
        open_cmux_terminal,
        open_cmux_tmux,
        open_cmux_localhost,
        open_cmux_agent_view,
        open_terminal_agent_view,
        open_cmux_project_agents,
        open_orca_agent,
        open_orca_localhost,
        open_orca_app,
        open_claude_bg,
        get_global_shortcut,
        set_global_shortcut,
        get_platform,
    ])
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app_handle, _shortcut, event| {
          if event.state() == ShortcutState::Pressed {
            if let Some(window) = app_handle.get_webview_window("main") {
              let mut vis = vis_shortcut.lock().unwrap_or_else(|e| e.into_inner());
              if *vis {
                let _ = window.hide();
                *vis = false;
              } else {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                *vis = true;
              }
            }
          }
        })
        .build()
    )
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // 설치 앱에서도 9000 로컬 웹과 동일한 Bun API를 자동으로 사용한다.
      // 이미 개발 서버가 3001에서 실행 중이면 이를 재사용하며, 사라지면 번들된
      // 사이드카를 다시 기동한다.
      start_local_api_supervisor(app.handle().clone());
      // 창 닫기 → 숨김 (백그라운드 유지 — 단축키가 항상 동작하도록)
      if let Some(window) = app.get_webview_window("main") {
        let win = window.clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win.hide();
            *vis_close.lock().unwrap_or_else(|e| e.into_inner()) = false;
          }
        });
      }
      // 저장된 글로벌 단축키 불러와서 등록
      let shortcut_path = ensure_app_data_dir(app.handle())
        .map(|d| d.join("shortcut.json"))
        .ok();
      let saved = shortcut_path.as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["shortcut"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "CommandOrControl+Alt+P".to_string());
      let _ = app.global_shortcut().register(saved.as_str());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if let tauri::RunEvent::Exit = &event {
        shutdown_local_api_sidecar(app_handle);
      }

      // macOS 전용: Dock 아이콘 클릭 시 숨겨진 창 복원 (Reopen variant 는 macOS 만 존재)
      #[cfg(target_os = "macos")]
      {
        if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
          if !*has_visible_windows {
            if let Some(window) = app_handle.get_webview_window("main") {
              let _ = window.show();
              let _ = window.unminimize();
              let _ = window.set_focus();
            }
          }
        }
      }
      #[cfg(not(target_os = "macos"))]
      {
        let _ = (&app_handle, &event); // Windows/Linux 미사용 인자 경고 억제
      }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        chrome_profile_directory_is_safe, cmux_agent_command, discover_chrome_profiles_at,
        find_orca_floating_terminal_handle_in_value, git_worktree_add, git_worktree_remove,
        inspect_orca_floating_visibility, is_absolute_path, list_git_worktrees, normalized_path_key,
        collect_descendant_pids_with, parse_windows_netstat_listeners, reject_hidden_orca_worktree,
        claim_port_launch, classify_local_api_health, reject_live_tracked_process,
        force_kill_managed_process_group, register_managed_process,
        local_api_supervisor_decision, spawn_port_env, stop_targets,
        terminate_managed_process_group,
        LocalApiHealth, LocalApiSupervisorDecision, ManagedProcess,
        tmux_session_name, validate_log_id, windows_browser_launch_plan, windows_cmd_agent_command, windows_command_plan,
        windows_supervisor_plan, windows_terminal_plan,
        windows_taskkill_args, PortInfo,
    };
    #[cfg(not(target_os = "windows"))]
    use super::managed_process_group_alive;
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use std::collections::{HashMap, HashSet};

    fn temp_test_dir(label: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "agentstoz-{}-{}-{}",
            label,
            std::process::id(),
            nonce
        ))
    }

    fn health_response(body: serde_json::Value) -> String {
        let body = serde_json::to_string(&body).expect("health JSON");
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body,
        )
    }

    #[test]
    fn local_api_health_requires_the_shared_schema_and_every_required_capability() {
        let contract: serde_json::Value = serde_json::from_str(include_str!("../../context-api-contract.json"))
            .expect("context API contract should parse");
        let schema = contract["schemaVersion"].as_u64().expect("schemaVersion");
        let mut capabilities = contract["requiredCapabilities"].as_array()
            .expect("requiredCapabilities")
            .clone();
        if cfg!(target_os = "windows") {
            capabilities.push(serde_json::Value::String("process.windows-job-supervisor".to_string()));
        }
        let current = health_response(serde_json::json!({
            "service": "agentstoz-api",
            "schemaVersion": schema,
            "capabilities": capabilities,
        }));
        assert_eq!(classify_local_api_health(Some(&current)), LocalApiHealth::Compatible);

        let old = health_response(serde_json::json!({
            "service": "agentstoz-api",
            "schemaVersion": schema.saturating_sub(1),
            "capabilities": contract["requiredCapabilities"],
        }));
        assert_eq!(classify_local_api_health(Some(&old)), LocalApiHealth::Incompatible);

        let mut missing = contract["requiredCapabilities"].as_array().expect("capabilities").clone();
        missing.pop();
        let incomplete = health_response(serde_json::json!({
            "service": "agentstoz-api",
            "schemaVersion": schema + 1,
            "capabilities": missing,
        }));
        assert_eq!(classify_local_api_health(Some(&incomplete)), LocalApiHealth::Incompatible);
        assert_eq!(classify_local_api_health(Some("HTTP/1.1 200 OK\r\n\r\nnot-json")), LocalApiHealth::Foreign);
        assert_eq!(
            classify_local_api_health(Some(&health_response(serde_json::json!({
                "service": "something-else",
                "schemaVersion": schema,
                "capabilities": contract["requiredCapabilities"],
            })))),
            LocalApiHealth::Foreign,
        );
        assert_eq!(classify_local_api_health(None), LocalApiHealth::Unavailable);
    }

    #[test]
    fn local_api_supervisor_never_adopts_or_replaces_an_incompatible_occupant() {
        for health in [LocalApiHealth::Incompatible, LocalApiHealth::Foreign] {
            assert_eq!(
                local_api_supervisor_decision(health, false, true),
                LocalApiSupervisorDecision::Blocked,
            );
        }
        assert_eq!(
            local_api_supervisor_decision(LocalApiHealth::Compatible, false, true),
            LocalApiSupervisorDecision::Adopt,
        );
        assert_eq!(
            local_api_supervisor_decision(LocalApiHealth::Unavailable, false, false),
            LocalApiSupervisorDecision::Spawn,
        );
    }

    fn git_ok(folder: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(folder)
            .output()
            .expect("git should run in test");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// 세션명 계약은 TypeScript 정본(src/tmuxSessionName.ts)과 이 백엔드가 공유한다.
    /// 표를 파일 하나로 두고 양쪽이 같은 파일을 읽어야 "한 곳뿐"이 검증 가능해진다.
    #[test]
    fn tmux_session_names_match_the_golden_table() {
        let raw = include_str!("../../tests/fixtures/tmux-session-golden.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("golden table should parse");
        let cases = doc["cases"].as_array().expect("cases should be an array");
        assert!(cases.len() >= 18, "golden table should cover 3 agents x 3 worktree shapes x bypass");
        for case in cases {
            let base = case["baseName"].as_str().expect("baseName");
            let worktree = case["worktreePath"].as_str();
            let bypass = case["bypass"].as_bool().expect("bypass");
            let expected = case["expected"].as_str().expect("expected");
            assert_eq!(
                tmux_session_name(base, worktree, bypass),
                expected,
                "agent={} base={} worktree={:?} bypass={}",
                case["agent"], base, worktree, bypass
            );
        }
    }

    #[test]
    fn spawn_port_environment_matches_the_cross_runtime_golden_table() {
        let raw = include_str!("../../tests/fixtures/spawn-port-env-golden.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("golden table should parse");
        let cases = doc["cases"].as_array().expect("cases should be an array");
        for case in cases {
            let input = case["input"]
                .as_u64()
                .and_then(|value| u16::try_from(value).ok());
            let actual = spawn_port_env(input)
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect::<HashMap<_, _>>();
            let expected = case["expected"]
                .as_object()
                .expect("expected should be an object")
                .iter()
                .map(|(key, value)| {
                    (key.clone(), value.as_str().expect("env value").to_string())
                })
                .collect::<HashMap<_, _>>();
            assert_eq!(actual, expected, "input={}", case["input"]);
        }
    }

    /// 재사용('실행')과 파괴('새 창')는 같은 세션을 가리켜야 짝이 성립한다.
    /// 두 경로 모두 이 함수 하나로 이름을 얻으므로, 같은 입력이면 같은 이름이다.
    #[test]
    fn reuse_and_fresh_paths_name_the_same_session() {
        for bypass in [false, true] {
            for worktree in [None, Some("/repo/worktrees/feature"), Some("/repo/wt/a,/repo/wt/b")] {
                let reuse = tmux_session_name("demo", worktree, bypass);
                let fresh = tmux_session_name("demo", worktree, bypass);
                assert_eq!(reuse, fresh);
                // bypass는 정확히 한 번만 붙는다.
                assert_eq!(reuse.matches("-bypass").count(), if bypass { 1 } else { 0 });
            }
        }
    }

    /// 추적 맵의 PID가 목록에서 빠지면, 포트를 아직 바인딩하지 않은 프로세스가
    /// 아무 시그널도 못 받고 살아남는다.
    #[test]
    fn stop_targets_unions_lsof_and_tracked_pids() {
        assert_eq!(stop_targets(&[], Some(123)), vec![123]);
        assert_eq!(stop_targets(&[9], Some(123)), vec![9, 123]);
        assert_eq!(stop_targets(&[], None), Vec::<u32>::new());
        // 같은 프로세스를 두 번 죽이려 들지 않는다.
        assert_eq!(stop_targets(&[9, 123], Some(123)), vec![9, 123]);
    }

    #[test]
    fn descendant_collection_handles_depth_duplicates_and_cycles() {
        let children = HashMap::from([
            (10, vec![11, 12, 11]),
            (11, vec![13]),
            (12, vec![14]),
            (13, vec![10]),
            (14, vec![]),
        ]);
        let descendants = collect_descendant_pids_with(10, |parent| {
            children.get(&parent).cloned().unwrap_or_default()
        });
        assert_eq!(descendants.len(), 4);
        assert_eq!(descendants.into_iter().collect::<HashSet<_>>(), HashSet::from([11, 12, 13, 14]));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn managed_process_group_termination_reaches_term_ignoring_grandchildren() {
        use std::fs;
        use std::os::unix::process::CommandExt;
        use std::time::Duration;

        let dir = temp_test_dir("managed-process-group");
        fs::create_dir_all(&dir).expect("create managed process test directory");
        let pid_file = dir.join("grandchild.pid");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("trap '' TERM; sleep 30 & echo $! > \"$CHILD_PID_FILE\"; wait")
            .env("CHILD_PID_FILE", &pid_file);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut root = command.spawn().expect("spawn isolated process group");
        let root_pid = root.id();
        for _ in 0..50 {
            if pid_file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild_pid: u32 = fs::read_to_string(&pid_file)
            .expect("grandchild pid file")
            .trim()
            .parse()
            .expect("grandchild pid");

        terminate_managed_process_group(root_pid).expect("terminate managed group");
        let _ = root.wait();
        let status = Command::new("ps")
            .args(["-p", &grandchild_pid.to_string(), "-o", "stat="])
            .output()
            .expect("inspect grandchild");
        let state = String::from_utf8_lossy(&status.stdout).trim().to_string();
        assert!(state.is_empty() || state.starts_with('Z'), "grandchild still running: {state}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_netstat_parser_keeps_only_ipv4_and_ipv6_listeners() {
        let output = r#"
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       101
  TCP    [::1]:9000             [::]:0                 LISTENING       202
  TCP    0.0.0.0:43123          0.0.0.0:0              ABHÖREN         4242
  TCP    127.0.0.1:3001         127.0.0.1:52000         ESTABLISHED     303
  TCP    127.0.0.1:4000         0.0.0.0:0              BOUND           404
  TCP    127.0.0.1:3001         127.0.0.1:52001         TIME_WAIT       0
  UDP    0.0.0.0:3001           *:*                                    404
"#;

        assert_eq!(
            parse_windows_netstat_listeners(output),
            vec![(3001, 101), (9000, 202), (43123, 4242)],
        );
    }

    #[test]
    fn windows_taskkill_targets_the_entire_process_tree() {
        assert_eq!(
            windows_taskkill_args(4321),
            vec!["/F", "/T", "/PID", "4321"],
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_taskkill_accepts_a_process_that_already_exited() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "exit 0"])
            .spawn()
            .expect("short-lived Windows process should start");
        let pid = child.id();
        child.wait().expect("short-lived Windows process should exit");
        drop(child);

        assert_eq!(super::win_kill_pid(pid), Ok(()));
    }

    #[test]
    fn windows_agent_command_quotes_the_executable_before_arguments() {
        assert_eq!(
            windows_cmd_agent_command(
                r"C:\Users\Alice Smith\AppData\Local\hermes\hermes-agent\bin\hermes.exe",
                "",
            ),
            r#""C:\Users\Alice Smith\AppData\Local\hermes\hermes-agent\bin\hermes.exe""#,
        );
        assert_eq!(
            windows_cmd_agent_command(r"C:\Program Files\Codex\codex.exe", "--full-auto"),
            r#""C:\Program Files\Codex\codex.exe" --full-auto"#,
        );
    }

    #[test]
    fn cmux_agent_command_quotes_a_resolved_executable_before_flags() {
        assert_eq!(
            cmux_agent_command(
                "/Users/Alice Smith/.hermes/hermes-agent/bin/hermes",
                "--example-flag",
            ),
            "'/Users/Alice Smith/.hermes/hermes-agent/bin/hermes' --example-flag"
        );
        assert_eq!(cmux_agent_command("codex", ""), "codex");
    }

    #[test]
    fn windows_command_plan_quotes_files_and_uses_pushd_for_unc_cwd() {
        let file = windows_command_plan(
            r"C:\Work & Tools\run%prod%.cmd",
            true,
            Some(r"C:\ignored"),
        );
        assert_eq!(file.program, "powershell.exe");
        assert_eq!(file.args.last().map(String::as_str), Some("Start-Process -FilePath $env:AGENTSTOZ_COMMAND_FILE -Wait -NoNewWindow"));
        assert_eq!(file.command_file.as_deref(), Some(r"C:\Work & Tools\run%prod%.cmd"));
        assert_eq!(file.work_dir, None);

        let powershell = windows_command_plan(
            r"C:\Work & Tools\run%prod%.ps1",
            true,
            None,
        );
        assert_eq!(powershell.program, "powershell.exe");
        assert_eq!(powershell.args[powershell.args.len() - 2], "-File");
        assert_eq!(powershell.args.last().map(String::as_str), Some(r"C:\Work & Tools\run%prod%.ps1"));
        assert_eq!(powershell.command_file, None);

        let raw = windows_command_plan(
            "bun run dev",
            false,
            Some(r"\\server\share & team\project"),
        );
        assert_eq!(raw.program, "cmd.exe");
        assert_eq!(raw.args.last().map(String::as_str), Some(r#"pushd "%AGENTSTOZ_WORK_DIR%" && bun run dev"#));
        assert_eq!(raw.work_dir.as_deref(), Some(r"\\server\share & team\project"));
        assert_eq!(raw.command_file, None);
    }

    #[test]
    fn windows_managed_commands_are_wrapped_by_the_job_object_supervisor() {
        let child_args = vec![
            "/D".to_string(),
            "/S".to_string(),
            "/C".to_string(),
            "\"%AGENTSTOZ_COMMAND_FILE%\"".to_string(),
        ];
        let plan = windows_supervisor_plan(
            r"C:\Program Files\AgentsToZ\windows-process-supervisor.ps1",
            "cmd.exe",
            &child_args,
        );
        assert_eq!(plan.program, "powershell.exe");
        assert!(plan.args.contains(&r"C:\Program Files\AgentsToZ\windows-process-supervisor.ps1".to_string()));
        assert_eq!(plan.env.get("AGENTSTOZ_SUPERVISOR_PROGRAM").map(String::as_str), Some("cmd.exe"));
        assert_eq!(
            serde_json::from_str::<Vec<String>>(plan.env.get("AGENTSTOZ_SUPERVISOR_ARGS_JSON").unwrap()).unwrap(),
            child_args,
        );
    }

    #[test]
    fn windows_terminal_plan_keeps_titles_and_unc_paths_out_of_cmd_source() {
        let wt = windows_terminal_plan(
            Some(r"C:\Users\Alice\AppData\Local\Microsoft\WindowsApps\wt.exe"),
            r#""C:\Program Files\Claude\claude.exe""#,
            Some(r"\\server\share%TEMP% & team\repo"),
            "repo%TEMP% & team",
        );
        assert_eq!(wt.program, r"C:\Users\Alice\AppData\Local\Microsoft\WindowsApps\wt.exe");
        assert_eq!(wt.args, vec![
            "--title", "repo%TEMP% & team", "--", "cmd.exe", "/D", "/V:OFF", "/K",
            r#"pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%"#,
        ]);
        assert_eq!(wt.env.get("AGENTSTOZ_WORK_DIR").map(String::as_str), Some(r"\\server\share%TEMP% & team\repo"));
        assert!(!wt.args.join(" ").contains(r"\\server\share%TEMP%"));

        let fallback = windows_terminal_plan(None, "", Some(r"C:\src%TEMP%\repo"), "repo%TEMP%");
        assert_eq!(fallback.program, "cmd.exe");
        assert_eq!(fallback.args, vec![
            "/D", "/V:OFF", "/K",
            r#"title "%AGENTSTOZ_WINDOW_TITLE%" && pushd "%AGENTSTOZ_WORK_DIR%" && %AGENTSTOZ_SHELL_COMMAND%"#,
        ]);
        assert_eq!(fallback.env.get("AGENTSTOZ_SHELL_COMMAND").map(String::as_str), Some("rem"));
        assert!(!fallback.args.join(" ").contains("repo%TEMP%"));
    }

    #[test]
    fn windows_browser_plan_keeps_oauth_query_metacharacters_in_one_argv() {
        let oauth = "https://example.supabase.co/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2F127.0.0.1%3A3001%2Fapi%2Fauth%2Fnative%2Fcallback%3Frequest%3Dabc%25prod%25";
        let default_browser = windows_browser_launch_plan(oauth, None, None).expect("default browser plan");
        assert_eq!(default_browser.program, "rundll32.exe");
        assert_eq!(default_browser.args, vec!["url.dll,FileProtocolHandler", oauth]);
        assert!(!default_browser.args.iter().any(|arg| arg == "/C" || arg == "start"));

        let chrome = windows_browser_launch_plan(
            oauth,
            Some("Profile 1 & %TEMP%"),
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        ).expect("profile plan");
        assert_eq!(chrome.program, r"C:\Program Files\Google\Chrome\Application\chrome.exe");
        assert_eq!(chrome.args, vec!["--profile-directory=Profile 1 & %TEMP%", oauth]);
    }

    #[test]
    fn native_claude_and_wsl_terminal_routes_do_not_bypass_safe_resolution_or_outer_cmd() {
        let source = include_str!("lib.rs");
        let claude_routes = &source[source.find("fn open_terminal_claude_bypass").unwrap()
            ..source.find("fn open_terminal_agent(").unwrap()];
        assert_eq!(claude_routes.matches("native_terminal_agent_command(\"claude\"").count(), 2);
        let wsl = &source[source.find("fn spawn_wt_wsl").unwrap()
            ..source.find("fn build_window_title").unwrap()];
        assert!(!wsl.contains("Command::new(\"cmd.exe\")"));
        assert!(!wsl.contains(".arg(\"start\")"));
    }

    #[test]
    fn windows_unc_and_extended_paths_are_absolute() {
        assert!(is_absolute_path(r"\\server\share\project"));
        assert!(is_absolute_path(r"\\?\UNC\server\share\project"));
        assert!(is_absolute_path(r"\\?\C:\repo"));
        assert!(is_absolute_path(r"C:\repo"));
        assert!(!is_absolute_path(r"server\share\project"));
        assert!(!is_absolute_path(r"\\.\PIPE\agentstoz"));
        assert!(!is_absolute_path(r"\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1"));
        assert!(!is_absolute_path(r"\\?\PIPE\agentstoz"));
    }

    #[test]
    fn poisoned_mutex_recovers() {
        let m = Mutex::new(HashMap::<String, u32>::new());
        let _ = std::panic::catch_unwind(|| {
            let _g = m.lock().unwrap();
            panic!("intentional poison");
        });
        // must not panic — recovers inner value
        let guard = m.lock().unwrap_or_else(|e| e.into_inner());
        assert!(guard.is_empty());
    }

    #[test]
    fn native_port_launch_claim_is_exclusive_and_released_on_drop() {
        let launching = Mutex::new(HashSet::new());
        let first = claim_port_launch(&launching, "project-a").expect("first claim");
        assert!(claim_port_launch(&launching, "project-a").is_err());
        assert!(claim_port_launch(&launching, "project-b").is_ok());
        drop(first);
        assert!(claim_port_launch(&launching, "project-a").is_ok());
    }

    #[test]
    fn native_execute_rejects_a_live_tracked_process_and_clears_only_a_dead_one() {
        let live_record = ManagedProcess {
            pid: 4242,
            generation: 1,
            leader_exited: false,
            terminating: false,
        };
        let mut processes = HashMap::from([("project-1".to_string(), live_record)]);
        let live = reject_live_tracked_process(&mut processes, "project-1", |_| true, |_| true);
        assert!(live.is_err());
        assert_eq!(processes.get("project-1"), Some(&live_record));

        processes.get_mut("project-1").unwrap().leader_exited = true;
        let original_group = reject_live_tracked_process(&mut processes, "project-1", |_| false, |_| true);
        assert!(original_group.is_err());
        assert!(processes.contains_key("project-1"));

        let dead = reject_live_tracked_process(&mut processes, "project-1", |_| false, |_| false);
        assert!(dead.is_ok());
        assert!(!processes.contains_key("project-1"));

        processes.insert("project-1".to_string(), ManagedProcess { leader_exited: true, ..live_record });
        let reused = reject_live_tracked_process(&mut processes, "project-1", |_| true, |_| true);
        assert!(reused.is_ok());
        assert!(!processes.contains_key("project-1"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn managed_reaper_keeps_ownership_until_background_group_members_exit() {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 0.7 </dev/null >/dev/null 2>&1 & exit 0"]);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("spawn managed process group");
        let pid = child.id();
        let processes = Arc::new(Mutex::new(HashMap::new()));
        register_managed_process(&processes, "background-group", child).expect("register process");

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            let leader_exited = processes
                .lock().unwrap_or_else(|error| error.into_inner())
                .get("background-group")
                .map(|record| record.leader_exited)
                .unwrap_or(false);
            if leader_exited { break; }
            assert!(std::time::Instant::now() < deadline, "leader exit was not reaped");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(managed_process_group_alive(pid));
        {
            let mut tracked = processes.lock().unwrap_or_else(|error| error.into_inner());
            assert!(reject_live_tracked_process(
                &mut tracked,
                "background-group",
                |_| false,
                managed_process_group_alive,
            ).is_err());
        }

        let cleanup_deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if !processes.lock().unwrap_or_else(|error| error.into_inner()).contains_key("background-group") {
                break;
            }
            if std::time::Instant::now() >= cleanup_deadline {
                let _ = force_kill_managed_process_group(pid);
                panic!("managed process group ownership was not cleaned up");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn port_info_preserves_manual_and_log_file_paths() {
        let port: PortInfo = serde_json::from_value(serde_json::json!({
            "id": "docs-test",
            "name": "Docs",
            "manualPath": "/tmp/MANUAL.md",
            "logFilePath": "/tmp/logs.html"
        })).expect("document paths should deserialize");

        let serialized = serde_json::to_value(port).expect("port should serialize");
        assert_eq!(serialized["manualPath"], "/tmp/MANUAL.md");
        assert_eq!(serialized["logFilePath"], "/tmp/logs.html");
    }

    #[test]
    fn log_id_allows_only_one_safe_ascii_segment() {
        assert!(validate_log_id("project_01.release-log").is_ok());
        for invalid in ["", "../escape", "nested/path", "name\\path", "한글", "line\nbreak"] {
            assert!(validate_log_id(invalid).is_err(), "accepted invalid id: {invalid:?}");
        }
        assert!(validate_log_id(&"a".repeat(129)).is_err());
    }

    #[test]
    fn chrome_profile_directory_is_one_safe_local_segment() {
        for valid in ["Default", "Profile 3", "Work"] {
            assert!(chrome_profile_directory_is_safe(valid), "rejected valid profile: {valid:?}");
        }
        for invalid in ["", "..", "../escape", "nested/path", "name\\path", " line", "line\nbreak"] {
            assert!(!chrome_profile_directory_is_safe(invalid), "accepted unsafe profile: {invalid:?}");
        }
    }

    #[test]
    fn chrome_profile_discovery_keeps_only_existing_contained_profiles() {
        let root = temp_test_dir("chrome-profile-discovery");
        std::fs::create_dir_all(root.join("Default")).unwrap();
        std::fs::create_dir_all(root.join("Profile 3")).unwrap();
        std::fs::write(root.join("Local State"), serde_json::json!({
            "profile": { "info_cache": {
                "Default": { "name": "Default profile", "user_name": "default@example.test" },
                "Profile 3": { "name": "Deploy", "user_name": "deploy-user@example.test" },
                "../escape": { "name": "unsafe" },
                "Profile 99": { "name": "missing" }
            }}
        }).to_string()).unwrap();

        let profiles = discover_chrome_profiles_at(&root);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].id, "chrome:Default");
        assert_eq!(profiles[1].id, "chrome:Profile 3");
        assert_eq!(profiles[1].profile_name, "Deploy");
        assert_eq!(profiles[1].account_label.as_deref(), Some("deploy-user@example.test"));
    }

    #[test]
    fn normalized_path_comparison_collapses_dot_segments() {
        let first = normalized_path_key("/tmp/project/./worktrees/../worktrees/task").unwrap();
        let second = normalized_path_key("/tmp/project/worktrees/task/").unwrap();
        assert_eq!(first, second);
        assert!(normalized_path_key("relative/worktree").is_err());
    }

    #[test]
    fn hidden_orca_worktree_paths_are_rejected_before_launch() {
        assert!(reject_hidden_orca_worktree("/repo/.claude/worktrees/test").is_err());
        assert!(reject_hidden_orca_worktree(r"C:\repo\.claude\worktrees\test").is_err());
        assert!(reject_hidden_orca_worktree("/repo/worktrees/test").is_ok());
    }

    #[test]
    fn remembered_orca_handle_must_still_be_in_the_floating_workspace() {
        let valid = serde_json::json!({
            "result": {
                "terminal": {
                    "handle": "terminal-live",
                    "worktreeId": "global-floating-terminal"
                }
            }
        });
        let wrong_workspace = serde_json::json!({
            "result": {
                "terminal": {
                    "handle": "terminal-live",
                    "worktreeId": "project-worktree"
                }
            }
        });
        assert!(find_orca_floating_terminal_handle_in_value(&valid, "terminal-live"));
        assert!(!find_orca_floating_terminal_handle_in_value(&valid, "other-handle"));
        assert!(!find_orca_floating_terminal_handle_in_value(&wrong_workspace, "terminal-live"));
    }

    #[test]
    fn orca_floating_visibility_parses_closed_and_open_accessibility_states() {
        let closed = serde_json::json!({
            "result": { "text": "177 toggle button Description: Show floating workspace, Value: 0" }
        });
        assert_eq!(inspect_orca_floating_visibility(&closed), (false, Some(177)));

        let open = serde_json::json!({
            "result": { "text": "177 toggle button Description: Minimize floating workspace, Value: 1" }
        });
        assert_eq!(inspect_orca_floating_visibility(&open), (true, None));
    }

    #[test]
    fn list_worktrees_matches_web_with_empty_result_for_an_existing_non_git_folder() {
        let folder = temp_test_dir("not-a-repo");
        std::fs::create_dir_all(&folder).unwrap();
        let result = list_git_worktrees(folder.to_string_lossy().to_string(), Some(false));
        std::fs::remove_dir_all(&folder).unwrap();
        assert!(result.expect("existing non-git folders should not be an app-only error").is_empty());
    }

    #[test]
    fn list_worktrees_keeps_detached_head_and_uses_the_primary_branch_from_a_linked_request() {
        let root = temp_test_dir("worktree-refresh-branch");
        std::fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init"]);
        git_ok(&root, &["config", "user.email", "test@example.invalid"]);
        git_ok(&root, &["config", "user.name", "AgentsToZ Test"]);
        std::fs::write(root.join("README.md"), "test\n").unwrap();
        git_ok(&root, &["add", "README.md"]);
        git_ok(&root, &["commit", "-m", "initial"]);

        let detached = root.join("worktrees").join("detached");
        git_ok(&root, &[
            "worktree",
            "add",
            "-b",
            "feature/detached",
            detached.to_str().unwrap(),
        ]);
        git_ok(&detached, &["checkout", "--detach"]);

        let stale = root.join("worktrees").join("stale");
        git_ok(&root, &[
            "worktree",
            "add",
            "-b",
            "feature/stale",
            stale.to_str().unwrap(),
        ]);
        std::fs::remove_dir_all(&stale).unwrap();

        let detached_path = detached.to_string_lossy().to_string();
        let stale_path = stale.to_string_lossy().to_string();
        let worktrees = list_git_worktrees(detached_path.clone(), Some(false))
            .expect("linked worktree refresh should succeed");
        let primary = worktrees.iter().find(|worktree| worktree.is_main)
            .expect("primary worktree should remain identifiable");
        assert!(primary.branch.is_some(), "the primary named branch is the merge base");
        assert_ne!(primary.branch.as_deref(), Some("feature/detached"));

        let detached_key = normalized_path_key(&detached_path).unwrap();
        let detached_row = worktrees.iter().find(|worktree| {
            normalized_path_key(&worktree.path).ok().as_deref() == Some(detached_key.as_str())
        })
            .expect("detached linked worktree should stay visible");
        assert!(detached_row.detached);
        assert!(detached_row.branch.is_none());
        assert!(detached_row.head.is_some());
        let stale_key = normalized_path_key(&stale_path).unwrap();
        assert!(worktrees.iter().all(|worktree| {
            normalized_path_key(&worktree.path).ok().as_deref() != Some(stale_key.as_str())
        }));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn worktree_add_uses_primary_root_and_remove_rejects_unregistered_or_locked_paths() {
        let root = temp_test_dir("worktree-safety");
        std::fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init"]);
        git_ok(&root, &["config", "user.email", "test@example.invalid"]);
        git_ok(&root, &["config", "user.name", "AgentsToZ Test"]);
        std::fs::write(root.join("README.md"), "test\n").unwrap();
        git_ok(&root, &["add", "README.md"]);
        git_ok(&root, &["commit", "-m", "initial"]);

        let manual = root.join("worktrees").join("manual");
        git_ok(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "manual",
                manual.to_str().unwrap(),
            ],
        );

        let arbitrary = root.join("arbitrary-target");
        let rejected = git_worktree_add(
            manual.to_string_lossy().to_string(),
            "wrong-target".to_string(),
            Some(arbitrary.to_string_lossy().to_string()),
            None,
        );
        assert!(rejected.is_err());
        assert!(!arbitrary.exists());

        let added = git_worktree_add(
            manual.to_string_lossy().to_string(),
            "nested-check".to_string(),
            None,
            None,
        )
        .expect("worktree should be created from primary root");
        let target = added["path"].as_str().unwrap().to_string();
        let expected = root
            .canonicalize()
            .unwrap()
            .join("worktrees")
            .join("nested-check");
        assert_eq!(
            normalized_path_key(&target).unwrap(),
            normalized_path_key(expected.to_str().unwrap()).unwrap()
        );

        std::fs::write(std::path::Path::new(&target).join("uncommitted.txt"), "keep me\n").unwrap();
        assert!(git_worktree_remove(root.to_string_lossy().to_string(), target.clone(), None).is_err());
        assert!(std::path::Path::new(&target).join("uncommitted.txt").exists());
        std::fs::remove_file(std::path::Path::new(&target).join("uncommitted.txt")).unwrap();

        std::fs::create_dir_all(&arbitrary).unwrap();
        assert!(git_worktree_remove(
            root.to_string_lossy().to_string(),
            arbitrary.to_string_lossy().to_string(),
            None,
        )
        .is_err());
        assert!(arbitrary.exists(), "unregistered folder must never be deleted");

        git_ok(&root, &["worktree", "lock", &target]);
        assert!(git_worktree_remove(root.to_string_lossy().to_string(), target.clone(), None).is_err());
        assert!(std::path::Path::new(&target).exists());
        git_ok(&root, &["worktree", "unlock", &target]);
        git_worktree_remove(root.to_string_lossy().to_string(), target.clone(), None)
            .expect("registered unlocked worktree should be removed");
        assert!(!std::path::Path::new(&target).exists());

        let stale = git_worktree_add(
            root.to_string_lossy().to_string(),
            "stale-check".to_string(),
            None,
            None,
        )
        .expect("stale test worktree should be created")["path"]
            .as_str()
            .unwrap()
            .to_string();
        std::fs::remove_dir_all(&stale).unwrap();
        git_worktree_remove(root.to_string_lossy().to_string(), stale, None)
            .expect("missing registered worktree should be pruned");

        git_worktree_remove(
            root.to_string_lossy().to_string(),
            manual.to_string_lossy().to_string(),
            None,
        )
        .expect("manual linked worktree should be removed");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
