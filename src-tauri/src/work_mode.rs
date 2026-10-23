//! One app-owned power assertion, shared by main and voice windows. Never persisted or auto-enabled.
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

mod power;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    supported: bool,
    revision: u64,
    ends_at: Option<u64>,
    keep_display_on: bool,
    /** Active with no end time ("연중무휴") until stopped or the app exits. */
    always_on: bool,
}

struct Session<L> {
    _lease: L,
    /** None: always on. Never persisted, so an app restart still starts switched off. */
    deadline: Option<(Instant, u64)>,
    keep_display_on: bool,
}
pub(crate) enum Request { Stop, For(Duration), AlwaysOn }
struct State<L> { session: Option<Session<L>>, revision: u64, closed: bool }
struct Service<L> { state: Mutex<State<L>>, changed: Condvar }
type NativeService = Service<power::Lease>;
static SERVICE: OnceLock<Arc<NativeService>> = OnceLock::new();
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

impl<L: Send + 'static> Service<L> {
    fn new(notify: impl Fn(Status) + Send + 'static) -> Arc<Self> {
        let service = Arc::new(Self {
            state: Mutex::new(State { session: None, revision: 0, closed: false }), changed: Condvar::new(),
        });
        let worker = service.clone();
        std::thread::spawn(move || {
            let mut state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
            while !state.closed {
                if Self::expire(&mut state) {
                    let status = Self::status(&state);
                    drop(state); notify(status);
                    state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                state = if let Some((deadline, ends_at)) = state.session.as_ref().and_then(|s| s.deadline) {
                    // The wall-clock bound also expires a session after suspend; no UI timer owns the lease.
                    let wait = deadline.saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(ends_at.saturating_sub(now_ms())))
                        .min(Duration::from_secs(30));
                    worker.changed.wait_timeout(state, wait).unwrap_or_else(|e| e.into_inner()).0
                } else {
                    worker.changed.wait(state).unwrap_or_else(|e| e.into_inner())
                };
            }
        });
        service
    }
    fn status(state: &State<L>) -> Status {
        Status { supported: power::supported(), revision: state.revision,
            ends_at: state.session.as_ref().and_then(|s| s.deadline).map(|(_, ends_at)| ends_at),
            keep_display_on: state.session.as_ref().is_some_and(|s| s.keep_display_on),
            always_on: state.session.as_ref().is_some_and(|s| s.deadline.is_none()) }
    }
    fn expire(state: &mut State<L>) -> bool {
        if state.session.as_ref().and_then(|s| s.deadline).is_some_and(|(deadline, ends_at)| Instant::now() >= deadline || now_ms() >= ends_at) {
            state.session = None; state.revision += 1; true
        } else { false }
    }
    fn read(&self) -> Status {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Self::expire(&mut state); Self::status(&state)
    }
    fn set(&self, request: Request, display: bool, acquire: impl FnOnce(bool) -> Result<L, String>) -> Result<Status, String> {
        let mut state = self.state.lock().map_err(|_| "근무 모드 상태를 읽지 못했습니다.")?;
        if state.closed { return Err("앱을 종료하고 있습니다.".into()); }
        Self::expire(&mut state);
        // Acquire first: a failed replacement must not discard the running mode.
        let session = match request {
            Request::Stop => None,
            Request::For(duration) => Some(Session { _lease: acquire(display)?,
                deadline: Some((Instant::now() + duration, now_ms() + duration.as_millis() as u64)), keep_display_on: display }),
            Request::AlwaysOn => Some(Session { _lease: acquire(display)?, deadline: None, keep_display_on: display }),
        };
        state.session = session; state.revision += 1;
        self.changed.notify_one(); Ok(Self::status(&state))
    }
    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.session = None; state.closed = true; self.changed.notify_one();
    }
}
fn service(app: &tauri::AppHandle) -> &'static Arc<NativeService> {
    SERVICE.get_or_init(|| {
        let app = app.clone();
        Service::new(move |status| { let _ = app.emit("work-mode:changed", status); })
    })
}
fn authorize(label: &str) -> Result<(), String> {
    if matches!(label, "main" | "voice-dock") { Ok(()) }
    else { Err("본창 또는 아젠투지 호출 창에서 근무 모드를 변경하세요.".into()) }
}
fn request(minutes: u32, always_on: bool) -> Result<Request, String> {
    match (always_on, minutes) {
        (true, 0) => Ok(Request::AlwaysOn),
        (true, _) => Err("연중무휴는 근무 시간을 함께 지정하지 않습니다.".into()),
        (false, 0) => Ok(Request::Stop),
        (false, 1..=1440) => Ok(Request::For(Duration::from_secs(u64::from(minutes) * 60))),
        _ => Err("근무 시간은 1분부터 24시간까지 선택하세요.".into()),
    }
}
#[tauri::command]
pub(crate) fn get_work_mode(app: tauri::AppHandle, window: tauri::Window) -> Result<Status, String> {
    authorize(window.label())?; Ok(service(&app).read())
}
#[tauri::command]
pub(crate) fn set_work_mode(app: tauri::AppHandle, window: tauri::Window, minutes: u32, keep_display_on: bool, always_on: Option<bool>) -> Result<Status, String> {
    authorize(window.label())?;
    let request = request(minutes, always_on.unwrap_or(false))?;
    let status = service(&app).set(request, keep_display_on, power::Lease::acquire)?;
    let _ = app.emit("work-mode:changed", &status); Ok(status)
}
pub(crate) fn shutdown() { if let Some(service) = SERVICE.get() { service.shutdown(); } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Lease(Arc<AtomicUsize>);
    impl Drop for Lease { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
    fn acquire(count: &Arc<AtomicUsize>) -> Result<Lease, String> {
        count.fetch_add(1, Ordering::SeqCst); Ok(Lease(count.clone()))
    }
    #[test]
    fn validates_time_and_local_windows() {
        assert!(matches!(request(0, false).unwrap(), Request::Stop));
        assert!(matches!(request(1440, false).unwrap(), Request::For(d) if d == Duration::from_secs(86400)));
        assert!(request(1441, false).is_err()); assert!(request(u32::MAX, false).is_err());
        assert!(matches!(request(0, true).unwrap(), Request::AlwaysOn));
        assert!(request(60, true).is_err());
        for label in ["main", "voice-dock"] { assert!(authorize(label).is_ok()); }
        for label in ["", "workroom-1", "remote", "voice-dock-1"] { assert!(authorize(label).is_err()); }
    }
    #[test]
    fn replaces_stops_preserves_on_failure_and_releases_on_exit() {
        let count = Arc::new(AtomicUsize::new(0)); let service = Service::new(|_| {});
        let first = service.set(request(1440, false).unwrap(), false, |_| acquire(&count)).unwrap();
        assert!(first.ends_at.is_some()); assert!(!first.keep_display_on);
        let next = service.set(request(1, false).unwrap(), true, |_| acquire(&count)).unwrap();
        assert!(next.revision > first.revision); assert!(next.keep_display_on);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(service.set(request(2, false).unwrap(), false, |_| Err("denied".into())).is_err());
        assert_eq!(service.read().revision, next.revision);
        assert!(service.set(Request::Stop, false, |_| panic!("stop must not acquire")).unwrap().ends_at.is_none());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        service.set(request(1, false).unwrap(), false, |_| acquire(&count)).unwrap();
        service.shutdown(); assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(service.set(request(1, false).unwrap(), false, |_| acquire(&count)).is_err());
    }
    #[test]
    fn expiry_releases_without_a_renderer_and_emits_status() {
        let count = Arc::new(AtomicUsize::new(0)); let (send, receive) = std::sync::mpsc::channel();
        let service = Service::new(move |status| { let _ = send.send(status); });
        service.set(Request::For(Duration::from_millis(40)), true, |_| acquire(&count)).unwrap();
        let expired = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(expired.ends_at.is_none()); assert!(!expired.keep_display_on);
        assert_eq!(count.load(Ordering::SeqCst), 0); service.shutdown();
    }
    #[test]
    fn always_on_never_expires_until_stopped_or_shutdown() {
        let count = Arc::new(AtomicUsize::new(0)); let (send, receive) = std::sync::mpsc::channel();
        let service = Service::new(move |status| { let _ = send.send(status); });
        let on = service.set(Request::AlwaysOn, true, |_| acquire(&count)).unwrap();
        assert!(on.always_on); assert!(on.ends_at.is_none()); assert!(on.keep_display_on);
        // No deadline: the worker emits nothing and keeps the single lease.
        assert!(receive.recv_timeout(Duration::from_millis(150)).is_err());
        assert!(service.read().always_on); assert_eq!(count.load(Ordering::SeqCst), 1);
        // Switching to a timed session replaces the lease instead of stacking it.
        let timed = service.set(request(1, false).unwrap(), false, |_| acquire(&count)).unwrap();
        assert!(!timed.always_on); assert!(timed.ends_at.is_some()); assert_eq!(count.load(Ordering::SeqCst), 1);
        service.set(Request::AlwaysOn, false, |_| acquire(&count)).unwrap();
        let off = service.set(Request::Stop, false, |_| panic!("stop must not acquire")).unwrap();
        assert!(!off.always_on); assert_eq!(count.load(Ordering::SeqCst), 0);
        service.set(Request::AlwaysOn, false, |_| acquire(&count)).unwrap();
        service.shutdown(); assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_acquires_both_real_power_assertions_and_releases_them() {
        for display in [false, true] { drop(power::Lease::acquire(display).unwrap()); }
    }
}
