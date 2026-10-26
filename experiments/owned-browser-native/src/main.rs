//! Native feasibility gate: no installed app data, credentials or external sites.
mod control;
mod fixture;
use cef::*;
use control::{Control, Owner};
use serde_json::{json, Value};
use std::{cell::RefCell, ffi::c_void, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};

extern "C" {
    fn atz_install_cef_protocol();
    fn atz_create_container(window: *mut c_void, x: f64, y: f64, width: f64, height: f64) -> *mut c_void;
    fn atz_container_input(view: *mut c_void, enabled: bool);
    fn atz_container_frame(view: *mut c_void, x: f64, y: f64, width: f64, height: f64);
    fn atz_container_hidden(view: *mut c_void, hidden: bool);
    fn atz_release_container(view: *mut c_void);
    fn atz_start_pump(callback: extern "C" fn());
    fn atz_stop_pump();
}
#[derive(Default)]
struct Shared { control: Control, observations: [Option<Value>; 2], blocked_requests: usize, closed: usize, task_container: usize }
struct View { browser: Browser, container: *mut c_void, _context: RequestContext }
struct Runtime { shared: Arc<Mutex<Shared>>, views: Vec<View>, origin: String }
thread_local! { static RUNTIME: RefCell<Option<Runtime>> = const { RefCell::new(None) }; }
static CONTEXT_READY: AtomicBool = AtomicBool::new(false);
wrap_browser_process_handler! {
    struct Process;
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) { CONTEXT_READY.store(true, Ordering::SeqCst); }
    }
}
wrap_app! {
    struct CefApp;
    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(Process::new()) }
        fn on_before_command_line_processing(&self, _process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            // Test fixture only; do not touch the user's login Keychain.
            if let Some(line) = command_line { line.append_switch(Some(&CefString::from("use-mock-keychain"))); line.append_switch(Some(&CefString::from("force-renderer-accessibility"))); }
        }
    }
}
wrap_display_handler! {
    struct Display { shared: Arc<Mutex<Shared>>, index: usize, }
    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let Some(title) = title else { return; };
            let text = title.to_string();
            if text.len() > 8192 { return; }
            if let Some(raw) = text.strip_prefix("ATZ:") {
                if let Ok(value) = serde_json::from_str::<Value>(raw) {
                    let mut shared = self.shared.lock().unwrap();
                    if self.index == 1 {
                        if let Some(epoch) = value.get("epoch").and_then(Value::as_u64) {
                            if value["barrier"] == "take" && shared.control.confirm_human(epoch) {
                                unsafe { atz_container_input(shared.task_container as *mut c_void, true); }
                            } else if value["barrier"] == "observe" { shared.control.observed(epoch); }
                        }
                    }
                    shared.observations[self.index] = Some(value);
                }
            }
        }
    }
}
wrap_focus_handler! {
    struct Focus { shared: Arc<Mutex<Shared>>, index: usize, }
    impl FocusHandler {
        fn on_set_focus(&self, _browser: Option<&mut Browser>, source: FocusSource) -> i32 {
            i32::from(source == FocusSource::NAVIGATION || (self.index == 1 && self.shared.lock().unwrap().control.owner != Owner::Human))
        }
    }
}
wrap_resource_request_handler! {
    struct ResourceGuard { origin: String, shared: Arc<Mutex<Shared>>, }
    impl ResourceRequestHandler {
        fn on_before_resource_load(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, request: Option<&mut Request>, _callback: Option<&mut Callback>) -> ReturnValue {
            let allowed = request.map(|r| CefString::from(&r.url()).to_string()).is_some_and(|url| fixture::allowed(&self.origin, &url));
            if allowed { ReturnValue::CONTINUE } else { self.shared.lock().unwrap().blocked_requests += 1; ReturnValue::CANCEL }
        }
    }
}
wrap_request_handler! {
    struct RequestGuard { origin: String, shared: Arc<Mutex<Shared>>, index: usize, }
    impl RequestHandler {
        fn on_before_browse(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, request: Option<&mut Request>, _user_gesture: i32, _is_redirect: i32) -> i32 {
            let allowed = request.map(|r| CefString::from(&r.url()).to_string()).is_some_and(|url| fixture::allowed(&self.origin, &url));
            let mut shared = self.shared.lock().unwrap();
            if !allowed { shared.blocked_requests += 1; return 1; }
            if self.index == 1 && frame.is_some_and(|f| f.is_main() == 1) { shared.control.navigating(); }
            0
        }
        fn resource_request_handler(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _request: Option<&mut Request>, _is_navigation: i32, _is_download: i32, _request_initiator: Option<&CefString>, _disable_default_handling: Option<&mut i32>) -> Option<ResourceRequestHandler> {
            Some(ResourceGuard::new(self.origin.clone(), self.shared.clone()))
        }
        fn on_open_urlfrom_tab(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _target_url: Option<&CefString>, _target_disposition: WindowOpenDisposition, _user_gesture: i32) -> i32 { 1 }
    }
}
wrap_life_span_handler! {
    struct Life { shared: Arc<Mutex<Shared>>, }
    impl LifeSpanHandler {
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _popup_id: i32, _target_url: Option<&CefString>, _target_frame_name: Option<&CefString>, _target_disposition: WindowOpenDisposition, _user_gesture: i32, _popup_features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>, _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>, _extra_info: Option<&mut Option<DictionaryValue>>, _no_javascript_access: Option<&mut i32>) -> i32 {
            self.shared.lock().unwrap().blocked_requests += 1; 1
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) { self.shared.lock().unwrap().closed += 1; }
    }
}
wrap_client! {
    struct PageClient { shared: Arc<Mutex<Shared>>, origin: String, index: usize, }
    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> { Some(Display::new(self.shared.clone(), self.index)) }
        fn focus_handler(&self) -> Option<FocusHandler> { Some(Focus::new(self.shared.clone(), self.index)) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(RequestGuard::new(self.origin.clone(), self.shared.clone(), self.index)) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(Life::new(self.shared.clone())) }
    }
}
impl Runtime {
    fn create_views(&mut self, window: *mut c_void) -> Result<(), String> {
        if !CONTEXT_READY.load(Ordering::SeqCst) { return Err("Chromium context is preparing".into()); }
        if !self.views.is_empty() { return Ok(()); }
        for index in 0..2 {
            let container = unsafe { atz_create_container(window, 360.0, 170.0 + index as f64 * 310.0, 900.0, 290.0) };
            let info = WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() }.set_as_child(container, &Rect { x: 0, y: 0, width: 900, height: 290 });
            // An empty cache_path creates a fresh in-memory context, not the global context.
            let mut context = request_context_create_context(Some(&RequestContextSettings::default()), None).ok_or("context unavailable")?;
            let mut client = PageClient::new(self.shared.clone(), self.origin.clone(), index);
            let url = format!("{}/fixture/{}", self.origin, if index == 0 { "personal" } else { "task" });
            let browser = browser_host_create_browser_sync(Some(&info), Some(&mut client), Some(&CefString::from(url.as_str())), Some(&BrowserSettings::default()), None, Some(&mut context)).ok_or("embedded browser unavailable")?;
            unsafe { atz_container_input(container, index == 0); }
            if index == 1 { self.shared.lock().unwrap().task_container = container as usize; }
            self.views.push(View { browser, container, _context: context });
        }
        Ok(())
    }
    fn script(&self, index: usize, source: &str) -> Result<(), String> {
        let frame = self.views.get(index).and_then(|v| v.browser.main_frame()).ok_or("open browser views first")?;
        frame.execute_java_script(Some(&CefString::from(source)), Some(&CefString::from("agentstoz://trusted-fixture-probe")), 1);
        Ok(())
    }
    fn observe(&self, index: usize) -> Result<(), String> {
        self.script(index, &format!("window.__atzEpoch={0};window.probe({0},'observe')", self.shared.lock().unwrap().control.epoch))
    }
    fn action(&mut self, op: &str, epoch: Option<u64>, text: Option<String>, window: *mut c_void) -> Result<Value, String> {
        match op {
            "open" => self.create_views(window)?,
            "observe" => { self.observe(0)?; self.observe(1)?; }
            "layout" => {
                let rects: Vec<[f64;4]> = serde_json::from_str(text.as_deref().ok_or("rectangles required")?).map_err(|_| "invalid rectangles")?;
                if rects.len()!=2 || rects.iter().flatten().any(|v|!v.is_finite()||*v<0.0||*v>10000.0) { return Err("invalid bounds".into()); }
                for (view, r) in self.views.iter().zip(rects) { unsafe { atz_container_frame(view.container,r[0],r[1],r[2],r[3]); } }
            }
            "take" => {
                let task = self.views.get(1).ok_or("open views first")?;
                self.shared.lock().unwrap().control.take();
                unsafe { atz_container_input(task.container, false); }
                let epoch = self.shared.lock().unwrap().control.epoch;
                self.script(1, &format!("window.__atzEpoch={epoch};window.probe({epoch},'take')"))?;
            }
            "return" => {
                let task = self.views.get(1).ok_or("open views first")?;
                self.shared.lock().unwrap().control.resume()?;
                unsafe { atz_container_input(task.container, false); }
                if let Some(host) = task.browser.host() { host.set_focus(0); }
                self.observe(1)?;
            }
            "agent-type" => {
                self.shared.lock().unwrap().control.check_agent(epoch.ok_or("expected epoch required")?)?;
                let text = text.ok_or("text required")?;
                if text.len() > 2048 { return Err("text too large".into()); }
                let revision = self.shared.lock().unwrap().control.epoch;
                self.script(1, &format!("if(window.__atzEpoch==={revision}){{document.querySelector('#draft').value={};window.probe({revision},'agent')}}", serde_json::to_string(&text).unwrap()))?;
            }
            "human-fixture-type" => {
                if self.shared.lock().unwrap().control.owner != Owner::Human { return Err("human control required".into()); }
                let text = text.ok_or("text required")?;
                if text.len() > 2048 { return Err("text too large".into()); }
                self.script(1, &format!("document.querySelector('#draft').value={};window.probe(0)", serde_json::to_string(&text).unwrap()))?;
            }
            "hide" | "reopen" => {
                let hidden = op == "hide";
                self.shared.lock().unwrap().control.hidden = hidden;
                for view in &self.views { unsafe { atz_container_hidden(view.container, hidden); } }
            }
            "deny-external" => self.script(1, "location.href='https://example.com/';")?,
            "status" => (),
            _ => return Err("unknown operation".into()),
        }
        let shared = self.shared.lock().unwrap();
        Ok(json!({ "control": shared.control, "observations": shared.observations, "blockedRequests": shared.blocked_requests, "views": self.views.len(), "engine": "CEF", "buildDigest": env!("ATZ_SOURCE_DIGEST"), "sandboxRequested": true, "scope": "local-fixture-only", "smoke": std::env::var("AGENTSTOZ_BROWSER_SMOKE").as_deref()==Ok("1") }))
    }
}
#[tauri::command]
async fn browser_action(app: tauri::AppHandle, window: tauri::WebviewWindow, op: String, epoch: Option<u64>, text: Option<String>) -> Result<Value, String> {
    if window.label() != "main" || window.url().map_err(|e| e.to_string())?.scheme() != "tauri" { return Err("trusted host only".into()); }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let value = window.ns_window().map_err(|e| e.to_string()).and_then(|native| RUNTIME.with(|slot| slot.borrow_mut().as_mut().ok_or("runtime unavailable".to_string())?.action(&op, epoch, text, native)));
        let _ = tx.send(value);
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?
}
extern "C" fn pump() { do_message_loop_work(); }
#[tauri::command]
fn record_smoke(app: tauri::AppHandle, window: tauri::WebviewWindow, report: Value) -> Result<(), String> {
    if window.label() != "main" || window.url().map_err(|e|e.to_string())?.scheme() != "tauri" { return Err("trusted host only".into()); }
    let text = serde_json::to_string(&report).map_err(|e|e.to_string())?;
    if text.len()>65536 { return Err("report too large".into()); }
    println!("ATZ_SMOKE:{text}");
    if std::env::var("AGENTSTOZ_BROWSER_SMOKE").as_deref()==Ok("1") {
        let passed = report["checks"].as_array().is_some_and(|checks|checks.len()>=10&&checks.iter().all(|c|c["pass"]==true));
        app.exit(if passed {0} else {1});
    }
    Ok(())
}
fn main() {
    let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), false);
    assert!(loader.load(), "bundle the official CEF framework and helpers first");
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let server = fixture::Server::start();
    let origin = server.origin.clone();
    let root = server.root.clone();
    let app = tauri::Builder::default().invoke_handler(tauri::generate_handler![browser_action, record_smoke])
        .setup(move |_| {
            unsafe { atz_install_cef_protocol(); }
    let settings = Settings {
        no_sandbox: 0, external_message_pump: 1, command_line_args_disabled: 1,
        root_cache_path: CefString::from(root.to_str().unwrap()),
        log_file: CefString::from(root.join("cef.log").to_str().unwrap()),
        remote_debugging_port: 0, ..Default::default()
    };

            let args = args::Args::new();
            let mut cef_app = CefApp::new();
            assert_eq!(initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), std::ptr::null_mut()), 1);
            RUNTIME.with(|slot| *slot.borrow_mut() = Some(Runtime { shared: Arc::new(Mutex::new(Shared::default())), views: Vec::new(), origin }));
            unsafe { atz_start_pump(pump); }
            Ok(())
        }).build(tauri::generate_context!()).expect("Tauri host");
    let exit_code = app.run_return(|_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            unsafe { atz_stop_pump(); }
            RUNTIME.with(|slot| {
                if let Some(runtime) = slot.borrow_mut().take() {
                    for view in &runtime.views { if let Some(host) = view.browser.host() { host.close_browser(1); } }
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while runtime.shared.lock().unwrap().closed < runtime.views.len() && std::time::Instant::now() < deadline { do_message_loop_work(); std::thread::sleep(std::time::Duration::from_millis(5)); }
                    for view in &runtime.views { unsafe { atz_release_container(view.container); } }
                    drop(runtime);
                }
            });
        }
    });
    // Tao's outer autorelease pool must drain before CEF shuts down. Calling
    // CefShutdown in RunEvent::Exit traps when pooled Chromium objects release.
    shutdown();
    drop(server);
    drop(loader);
    println!("ATZ_CLEAN_EXIT:{exit_code}");
    std::process::exit(exit_code);
}
