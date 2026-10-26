//! One app-owned power assertion, shared by main and voice windows. Never persisted or auto-enabled.
//! The optional closed-lid hold (lid.rs) is a system-wide switch that outlives the process, so every path that
//! ends or replaces a session releases it explicitly, and the worker drops it when the battery or temperature says so.
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

mod lid;
mod power;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LidStatus {
    supported: bool,
    granted: bool,
    /** off · active · lowBattery (nearly empty: the Mac may sleep normally again) · hot (stopped for this
     *  session) · external (another app already holds the switch; never touched) */
    state: &'static str,
    error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    supported: bool,
    revision: u64,
    ends_at: Option<u64>,
    keep_display_on: bool,
    /** Active with no end time ("연중무휴") until stopped or the app exits. */
    always_on: bool,
    lid: LidStatus,
}

/** The closed-lid part of a session. Only `Held` owns the system switch. */
#[derive(Clone, Copy, PartialEq, Debug)]
enum Lid { Off, Held, LowBattery, Hot, External }
struct Session<L> {
    _lease: L,
    /** None: always on. Never persisted, so an app restart still starts switched off. */
    deadline: Option<(Instant, u64)>,
    keep_display_on: bool,
    lid: Lid,
}
pub(crate) enum Request { Stop, For(Duration), AlwaysOn }
struct State<L> {
    session: Option<Session<L>>, revision: u64, closed: bool,
    /** None until first asked; computed off the UI thread. */
    granted: Option<bool>,
    /** A grant or revoke is waiting on the macOS password sheet; no new hold may start meanwhile. */
    granting: bool,
    lid_error: Option<String>,
}
struct Service<L> { state: Mutex<State<L>>, changed: Condvar, host: Arc<dyn lid::Host> }
type NativeService = Service<power::Lease>;
static SERVICE: OnceLock<Arc<NativeService>> = OnceLock::new();
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

impl<L: Send + 'static> Service<L> {
    fn new(notify: impl Fn(Status) + Send + 'static, host: Arc<dyn lid::Host>) -> Arc<Self> {
        let service = Arc::new(Self {
            state: Mutex::new(State { session: None, revision: 0, closed: false, granted: None, granting: false, lid_error: None }),
            changed: Condvar::new(), host,
        });
        let worker = service.clone();
        std::thread::spawn(move || {
            let mut state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
            // A marker from an earlier run means that run left the switch on; sessions never persist, so restore it.
            // Skipped if a window already started a session: its marker is live, not left over.
            if state.session.is_none() { state.lid_error = worker.host.recover().err(); }
            state.granted = Some(worker.host.granted()); state.revision += 1;
            let status = worker.status(&state); drop(state); notify(status);
            state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
            while !state.closed {
                if worker.expire(&mut state) | worker.guard(&mut state) {
                    let status = worker.status(&state);
                    drop(state); notify(status);
                    state = worker.state.lock().unwrap_or_else(|e| e.into_inner());
                    continue;
                }
                let lid = state.session.as_ref().is_some_and(|s| !matches!(s.lid, Lid::Off | Lid::Hot));
                state = if let Some((deadline, ends_at)) = state.session.as_ref().and_then(|s| s.deadline) {
                    // The wall-clock bound also expires a session after suspend; no UI timer owns the lease.
                    let wait = deadline.saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(ends_at.saturating_sub(now_ms())))
                        .min(if lid { lid::HEARTBEAT } else { Duration::from_secs(30) });
                    worker.changed.wait_timeout(state, wait).unwrap_or_else(|e| e.into_inner()).0
                } else if lid {
                    worker.changed.wait_timeout(state, lid::HEARTBEAT).unwrap_or_else(|e| e.into_inner()).0
                } else {
                    worker.changed.wait(state).unwrap_or_else(|e| e.into_inner())
                };
            }
        });
        service
    }
    fn status(&self, state: &State<L>) -> Status {
        let lid = state.session.as_ref().map_or(Lid::Off, |s| s.lid);
        Status { supported: power::supported(), revision: state.revision,
            ends_at: state.session.as_ref().and_then(|s| s.deadline).map(|(_, ends_at)| ends_at),
            keep_display_on: state.session.as_ref().is_some_and(|s| s.keep_display_on),
            always_on: state.session.as_ref().is_some_and(|s| s.deadline.is_none()),
            lid: LidStatus { supported: self.host.supported(), granted: state.granted.unwrap_or(false),
                state: match lid { Lid::Off => "off", Lid::Held => "active", Lid::LowBattery => "lowBattery", Lid::Hot => "hot", Lid::External => "external" },
                error: state.lid_error.clone() } }
    }
    /** Every session that ends or is replaced passes through here, so a held switch is never orphaned. */
    fn end(&self, state: &mut State<L>, old: Option<Session<L>>) {
        if old.is_some_and(|s| s.lid == Lid::Held) { state.lid_error = self.host.release().err(); }
    }
    fn expire(&self, state: &mut State<L>) -> bool {
        if state.session.as_ref().and_then(|s| s.deadline).is_some_and(|(deadline, ends_at)| Instant::now() >= deadline || now_ms() >= ends_at) {
            let old = state.session.take(); self.end(state, old); state.revision += 1; true
        } else { false }
    }
    /** Charge first (a Mac about to cut out should sleep instead), then heat, then a switch another app may already hold. */
    fn arm(&self) -> Result<Lid, String> {
        if self.host.battery_low() { return Ok(Lid::LowBattery); }
        if self.host.hot() { return Ok(Lid::Hot); }
        if self.host.disabled()? { return Ok(Lid::External); }
        self.host.hold().map(|_| Lid::Held)
    }
    /** One heartbeat-sized step of the closed-lid rules. Returns whether the visible status changed. */
    fn guard(&self, state: &mut State<L>) -> bool {
        let Some(lid) = state.session.as_ref().map(|s| s.lid) else { return false };
        let (next, error) = match lid {
            Lid::Off | Lid::Hot => return false,
            // The guard (after a stalled heartbeat) or a person may have switched it off: say so instead of fighting,
            // and never let the heartbeat recreate a marker for a switch that is no longer on.
            Lid::Held if !self.host.disabled().unwrap_or(true) => {
                let _ = self.host.release();
                (Lid::Off, Some("덮개 닫힘 근무가 밖에서 꺼졌어요. 다시 적용하면 켜져요.".into()))
            }
            Lid::Held => {
                self.host.beat();
                let next = if self.host.battery_low() { Lid::LowBattery } else if self.host.hot() { Lid::Hot } else { return false };
                // A failed release keeps `Held` and retries next beat; only a new error counts as a change.
                match self.host.release() { Ok(()) => (next, None), Err(error) => (Lid::Held, Some(error)) }
            }
            Lid::LowBattery if self.host.battery_low() => return false,
            Lid::External if self.host.disabled().unwrap_or(true) => return false,
            Lid::LowBattery | Lid::External => match self.arm() { Ok(next) => (next, None), Err(error) => (Lid::Off, Some(error)) },
        };
        if next == lid && error == state.lid_error { return false; }
        if let Some(session) = state.session.as_mut() { session.lid = next; }
        state.lid_error = error; state.revision += 1; true
    }
    #[cfg(test)]
    fn tick(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.expire(&mut state) | self.guard(&mut state)
    }
    fn read(&self) -> Status {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.expire(&mut state); self.status(&state)
    }
    fn set(&self, request: Request, display: bool, closed_lid: bool, acquire: impl FnOnce(bool) -> Result<L, String>) -> Result<Status, String> {
        let mut state = self.state.lock().map_err(|_| "근무 모드 상태를 읽지 못했습니다.")?;
        if state.closed { return Err("앱을 종료하고 있습니다.".into()); }
        self.expire(&mut state);
        let wants = closed_lid && !matches!(request, Request::Stop);
        if wants {
            if !self.host.supported() { return Err("덮개 닫힘 근무는 Mac에서만 지원합니다.".into()); }
            if state.granting { return Err("허용 설정을 바꾸는 중이에요. 잠시 뒤 다시 시도하세요.".into()); }
            if !*state.granted.get_or_insert_with(|| self.host.granted()) { return Err("먼저 「처음 한 번 허용」을 눌러 주세요.".into()); }
        }
        // Acquire first: a failed replacement must not discard the running mode.
        let lease = match request { Request::Stop => None, _ => Some(acquire(display)?) };
        // Carry an existing hold instead of flipping the system switch off and on.
        let carried = wants && state.session.as_ref().is_some_and(|s| s.lid == Lid::Held);
        let lid = if !wants { Lid::Off } else if carried { Lid::Held } else { self.arm()? };
        let session = lease.map(|lease| Session { _lease: lease, keep_display_on: display, lid,
            deadline: match request { Request::For(duration) => Some((Instant::now() + duration, now_ms() + duration.as_millis() as u64)), _ => None } });
        let old = std::mem::replace(&mut state.session, session);
        // A fresh or carried hold proves sudo works now, so an older lid error no longer describes the switch.
        if carried || lid == Lid::Held { state.lid_error = None; } else { self.end(&mut state, old); }
        state.revision += 1;
        self.changed.notify_one(); Ok(self.status(&state))
    }
    /** The password sheet blocks for as long as the person takes, so the state lock is not held across it. */
    fn change_grant(&self, revoke: bool, prompt: &str) -> Result<Status, String> {
        {
            let mut state = self.state.lock().map_err(|_| "근무 모드 상태를 읽지 못했습니다.")?;
            if state.granting { return Err("이미 허용 설정을 바꾸는 중이에요.".into()); }
            if revoke && state.session.as_ref().is_some_and(|s| s.lid != Lid::Off) { return Err("덮개 닫힘 근무를 끈 뒤에 허용을 지우세요.".into()); }
            state.granting = true;
        }
        let result = if revoke { self.host.revoke(prompt) } else { self.host.grant(prompt) };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.granting = false; state.granted = Some(self.host.granted()); state.revision += 1;
        if result.is_ok() { state.lid_error = None; }
        result.map(|_| self.status(&state))
    }
    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let old = state.session.take(); self.end(&mut state, old);
        state.closed = true; self.changed.notify_one();
    }
}
fn service(app: &tauri::AppHandle) -> &'static Arc<NativeService> {
    SERVICE.get_or_init(|| {
        let app = app.clone();
        let marker = crate::legacy_app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("work-mode-closed-lid.owner");
        Service::new(move |status| { let _ = app.emit("work-mode:changed", status); }, Arc::new(lid::Native::new(marker)))
    })
}
/** Started with the app so a switch left on by a crashed run is restored before any window asks. */
pub(crate) fn init(app: &tauri::AppHandle) { service(app); }
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
/** Lid work runs sudo, pmset and osascript, so every command leaves the UI thread. */
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| format!("근무 모드 작업 실패: {e}"))?
}
#[tauri::command]
pub(crate) async fn get_work_mode(app: tauri::AppHandle, window: tauri::Window) -> Result<Status, String> {
    authorize(window.label())?; let service = service(&app).clone();
    blocking(move || Ok(service.read())).await
}
#[tauri::command]
pub(crate) async fn set_work_mode(app: tauri::AppHandle, window: tauri::Window, minutes: u32, keep_display_on: bool, always_on: Option<bool>, closed_lid: Option<bool>) -> Result<Status, String> {
    authorize(window.label())?;
    let request = request(minutes, always_on.unwrap_or(false))?; let service = service(&app).clone();
    let status = blocking(move || service.set(request, keep_display_on, closed_lid.unwrap_or(false), power::Lease::acquire)).await?;
    let _ = app.emit("work-mode:changed", &status); Ok(status)
}
/** `prompt` is the localized line on macOS's own password sheet; the app never sees the password. */
#[tauri::command]
pub(crate) async fn set_closed_lid_grant(app: tauri::AppHandle, window: tauri::Window, granted: bool, prompt: String) -> Result<Status, String> {
    authorize(window.label())?; let service = service(&app).clone();
    let status = blocking(move || service.change_grant(!granted, &prompt)).await?;
    let _ = app.emit("work-mode:changed", &status); Ok(status)
}
pub(crate) fn shutdown() { if let Some(service) = SERVICE.get() { service.shutdown(); } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    struct Lease(Arc<AtomicUsize>);
    impl Drop for Lease { fn drop(&mut self) { self.0.fetch_sub(1, SeqCst); } }
    fn acquire(count: &Arc<AtomicUsize>) -> Result<Lease, String> {
        count.fetch_add(1, SeqCst); Ok(Lease(count.clone()))
    }
    /** A Mac with charge to spare and the grant, whose switch is a flag. `marker` mirrors the owner file. */
    #[derive(Default)]
    struct Fake { supported: AtomicBool, granted: AtomicBool, low_battery: AtomicBool, hot: AtomicBool, external: AtomicBool,
        fail_hold: AtomicBool, fail_release: AtomicBool, on: AtomicBool, marker: AtomicBool, holds: AtomicUsize, releases: AtomicUsize, beats: AtomicUsize }
    impl lid::Host for Fake {
        fn supported(&self) -> bool { self.supported.load(SeqCst) }
        fn granted(&self) -> bool { self.granted.load(SeqCst) }
        fn battery_low(&self) -> bool { self.low_battery.load(SeqCst) }
        fn hot(&self) -> bool { self.hot.load(SeqCst) }
        fn disabled(&self) -> Result<bool, String> { Ok(self.external.load(SeqCst) || self.on.load(SeqCst)) }
        fn hold(&self) -> Result<(), String> {
            if self.fail_hold.load(SeqCst) { return Err("sudo pmset 실패".into()); }
            self.marker.store(true, SeqCst); self.on.store(true, SeqCst); self.holds.fetch_add(1, SeqCst); Ok(())
        }
        fn beat(&self) { self.beats.fetch_add(1, SeqCst); }
        fn release(&self) -> Result<(), String> {
            if self.fail_release.load(SeqCst) { return Err("sudo pmset 실패".into()); }
            self.on.store(false, SeqCst); self.marker.store(false, SeqCst); self.releases.fetch_add(1, SeqCst); Ok(())
        }
        fn recover(&self) -> Result<(), String> { if self.marker.load(SeqCst) { self.release() } else { Ok(()) } }
        fn grant(&self, _: &str) -> Result<(), String> { self.granted.store(true, SeqCst); Ok(()) }
        fn revoke(&self, _: &str) -> Result<(), String> { self.granted.store(false, SeqCst); Ok(()) }
    }
    fn mac() -> Arc<Fake> { let fake = Fake::default(); fake.supported.store(true, SeqCst); fake.granted.store(true, SeqCst); Arc::new(fake) }
    fn windows() -> Arc<Fake> { Arc::new(Fake::default()) }
    /** These tests advance each guard step themselves. A real worker could consume a fake
     *  battery/heat transition before their explicit tick; worker behavior is covered separately. */
    fn stepped_service(host: Arc<Fake>) -> Arc<Service<Lease>> {
        Arc::new(Service {
            state: Mutex::new(State { session: None, revision: 1, closed: false,
                granted: Some(lid::Host::granted(host.as_ref())), granting: false, lid_error: None }),
            changed: Condvar::new(), host,
        })
    }
    /** The worker announces its startup recovery once; tests that count notifications skip it. */
    fn started(receive: &std::sync::mpsc::Receiver<Status>) { receive.recv_timeout(Duration::from_secs(2)).unwrap(); }
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
        let count = Arc::new(AtomicUsize::new(0)); let (send, receive) = std::sync::mpsc::channel();
        let service = Service::new(move |status| { let _ = send.send(status); }, windows()); started(&receive);
        let first = service.set(request(1440, false).unwrap(), false, false, |_| acquire(&count)).unwrap();
        assert!(first.ends_at.is_some()); assert!(!first.keep_display_on); assert_eq!(first.lid.state, "off"); assert!(!first.lid.supported);
        let next = service.set(request(1, false).unwrap(), true, false, |_| acquire(&count)).unwrap();
        assert!(next.revision > first.revision); assert!(next.keep_display_on);
        assert_eq!(count.load(SeqCst), 1);
        assert!(service.set(request(2, false).unwrap(), false, false, |_| Err("denied".into())).is_err());
        assert_eq!(service.read().revision, next.revision);
        assert!(service.set(request(2, false).unwrap(), false, true, |_| acquire(&count)).is_err(), "closed lid is Mac-only");
        assert_eq!(service.read().ends_at, next.ends_at);
        assert!(service.set(Request::Stop, false, false, |_| panic!("stop must not acquire")).unwrap().ends_at.is_none());
        assert_eq!(count.load(SeqCst), 0);
        service.set(request(1, false).unwrap(), false, false, |_| acquire(&count)).unwrap();
        service.shutdown(); assert_eq!(count.load(SeqCst), 0);
        assert!(service.set(request(1, false).unwrap(), false, false, |_| acquire(&count)).is_err());
    }
    #[test]
    fn expiry_releases_without_a_renderer_and_emits_status() {
        let count = Arc::new(AtomicUsize::new(0)); let (send, receive) = std::sync::mpsc::channel(); let host = mac();
        let service = Service::new(move |status| { let _ = send.send(status); }, host.clone()); started(&receive);
        let held = service.set(Request::For(Duration::from_millis(40)), true, true, |_| acquire(&count)).unwrap();
        assert_eq!(held.lid.state, "active");
        let expired = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(expired.ends_at.is_none()); assert!(!expired.keep_display_on); assert_eq!(expired.lid.state, "off");
        assert_eq!(count.load(SeqCst), 0); assert_eq!(host.releases.load(SeqCst), 1, "expiry also restores the lid switch");
        service.shutdown();
    }
    #[test]
    fn always_on_never_expires_until_stopped_or_shutdown() {
        let count = Arc::new(AtomicUsize::new(0)); let (send, receive) = std::sync::mpsc::channel();
        let service = Service::new(move |status| { let _ = send.send(status); }, windows()); started(&receive);
        let on = service.set(Request::AlwaysOn, true, false, |_| acquire(&count)).unwrap();
        assert!(on.always_on); assert!(on.ends_at.is_none()); assert!(on.keep_display_on);
        // No deadline: the worker emits nothing and keeps the single lease.
        assert!(receive.recv_timeout(Duration::from_millis(150)).is_err());
        assert!(service.read().always_on); assert_eq!(count.load(SeqCst), 1);
        // Switching to a timed session replaces the lease instead of stacking it.
        let timed = service.set(request(1, false).unwrap(), false, false, |_| acquire(&count)).unwrap();
        assert!(!timed.always_on); assert!(timed.ends_at.is_some()); assert_eq!(count.load(SeqCst), 1);
        service.set(Request::AlwaysOn, false, false, |_| acquire(&count)).unwrap();
        let off = service.set(Request::Stop, false, false, |_| panic!("stop must not acquire")).unwrap();
        assert!(!off.always_on); assert_eq!(count.load(SeqCst), 0);
        service.set(Request::AlwaysOn, false, false, |_| acquire(&count)).unwrap();
        service.shutdown(); assert_eq!(count.load(SeqCst), 0);
    }
    #[test]
    fn closed_lid_holds_once_and_releases_on_every_end() {
        let count = Arc::new(AtomicUsize::new(0)); let host = mac(); let service = Service::new(|_| {}, host.clone());
        let on = service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap();
        assert_eq!((on.lid.state, on.lid.granted), ("active", true)); assert_eq!(host.holds.load(SeqCst), 1);
        // Re-applying with the lid kept carries the hold: the system switch never flips off in between.
        service.set(request(60, false).unwrap(), true, true, |_| acquire(&count)).unwrap();
        assert_eq!((host.holds.load(SeqCst), host.releases.load(SeqCst)), (1, 0)); assert!(host.on.load(SeqCst));
        let plain = service.set(request(60, false).unwrap(), false, false, |_| acquire(&count)).unwrap();
        assert_eq!(plain.lid.state, "off"); assert_eq!(host.releases.load(SeqCst), 1); assert!(!host.on.load(SeqCst));
        service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap();
        service.set(Request::Stop, false, true, |_| panic!("stop must not acquire")).unwrap();
        assert_eq!((host.holds.load(SeqCst), host.releases.load(SeqCst)), (2, 2));
        service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap();
        service.shutdown(); assert_eq!(host.releases.load(SeqCst), 3); assert!(!host.marker.load(SeqCst));
        assert_eq!(count.load(SeqCst), 0);
    }
    #[test]
    fn closed_lid_needs_the_grant_and_a_failed_hold_keeps_the_running_mode() {
        let count = Arc::new(AtomicUsize::new(0)); let host = mac(); host.granted.store(false, SeqCst);
        let service = Service::new(|_| {}, host.clone());
        let running = service.set(request(30, false).unwrap(), false, false, |_| acquire(&count)).unwrap();
        assert!(service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap_err().contains("허용"));
        assert_eq!(service.read().ends_at, running.ends_at); assert_eq!(count.load(SeqCst), 1);
        assert_eq!(service.change_grant(false, "prompt").unwrap().lid.granted, true);
        host.fail_hold.store(true, SeqCst);
        assert!(service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).is_err());
        assert_eq!(service.read().ends_at, running.ends_at, "the timed mode survives a failed hold"); assert_eq!(count.load(SeqCst), 1);
        host.fail_hold.store(false, SeqCst);
        service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap();
        assert!(service.change_grant(true, "prompt").unwrap_err().contains("끈 뒤"), "revoking under a live hold would strand the switch");
        service.set(Request::Stop, false, false, |_| panic!("stop must not acquire")).unwrap();
        assert_eq!(service.change_grant(true, "prompt").unwrap().lid.granted, false);
    }
    #[test]
    fn a_flat_battery_releases_charging_rearms_and_heat_stops_for_the_session() {
        let count = Arc::new(AtomicUsize::new(0)); let host = mac(); let service = stepped_service(host.clone());
        let on = service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap();
        assert!(!service.tick(), "a quiet beat changes nothing"); assert!(host.beats.load(SeqCst) >= 1);
        host.low_battery.store(true, SeqCst);
        assert!(service.tick()); let waiting = service.read();
        assert_eq!(waiting.lid.state, "lowBattery"); assert!(waiting.always_on, "the session itself continues");
        assert_eq!(host.releases.load(SeqCst), 1); assert!(!host.on.load(SeqCst)); assert!(!service.tick());
        host.low_battery.store(false, SeqCst);
        assert!(service.tick()); assert_eq!(service.read().lid.state, "active"); assert_eq!(host.holds.load(SeqCst), 2);
        host.hot.store(true, SeqCst);
        assert!(service.tick()); assert_eq!(service.read().lid.state, "hot"); assert_eq!(host.releases.load(SeqCst), 2);
        host.hot.store(false, SeqCst);
        assert!(!service.tick()); assert_eq!(service.read().lid.state, "hot", "cooling down does not re-arm by itself");
        assert!(service.read().revision > on.revision);
        // A release that fails keeps reporting the hold and retries without spinning.
        service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap(); host.fail_release.store(true, SeqCst); host.low_battery.store(true, SeqCst);
        assert!(service.tick()); let stuck = service.read();
        assert_eq!(stuck.lid.state, "active"); assert!(stuck.lid.error.is_some()); assert!(!service.tick());
        host.fail_release.store(false, SeqCst);
        assert!(service.tick()); assert_eq!(service.read().lid.state, "lowBattery"); assert!(service.read().lid.error.is_none());
        // Switched off elsewhere while held: reported, not silently re-armed, and no fresh heartbeat is written.
        host.low_battery.store(false, SeqCst); assert!(service.tick()); assert_eq!(service.read().lid.state, "active");
        host.on.store(false, SeqCst); let beats = host.beats.load(SeqCst);
        assert!(service.tick()); let lost = service.read();
        assert_eq!(lost.lid.state, "off"); assert!(lost.lid.error.unwrap().contains("밖에서")); assert_eq!(host.beats.load(SeqCst), beats);
        assert!(lost.always_on, "the session continues without the lid"); assert!(!service.tick());
    }
    /** The point of allowing battery power: unplugging alone no longer ends closed-lid work. */
    #[test]
    fn running_on_the_battery_keeps_the_hold_until_it_is_nearly_empty() {
        let count = Arc::new(AtomicUsize::new(0)); let host = mac(); let service = stepped_service(host.clone());
        assert_eq!(service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap().lid.state, "active");
        for _ in 0..3 { assert!(!service.tick(), "charge left means the Mac keeps working"); }
        assert_eq!(host.releases.load(SeqCst), 0); assert!(host.on.load(SeqCst));
        host.low_battery.store(true, SeqCst);
        assert!(service.tick()); assert_eq!(service.read().lid.state, "lowBattery");
        assert_eq!(host.releases.load(SeqCst), 1); assert!(!host.on.load(SeqCst));
        service.shutdown();
    }
    #[test]
    fn starting_on_a_flat_battery_waits_and_another_apps_switch_is_never_touched() {
        let count = Arc::new(AtomicUsize::new(0)); let host = mac(); let service = stepped_service(host.clone());
        host.low_battery.store(true, SeqCst);
        assert_eq!(service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap().lid.state, "lowBattery");
        assert_eq!(host.holds.load(SeqCst), 0);
        host.low_battery.store(false, SeqCst); host.external.store(true, SeqCst);
        assert!(service.tick()); assert_eq!(service.read().lid.state, "external"); assert_eq!(host.holds.load(SeqCst), 0);
        service.set(Request::Stop, false, false, |_| panic!("stop must not acquire")).unwrap();
        assert_eq!(host.releases.load(SeqCst), 0, "the other app's switch stays on");
        assert_eq!(service.set(Request::AlwaysOn, false, true, |_| acquire(&count)).unwrap().lid.state, "external");
        host.external.store(false, SeqCst);
        assert!(service.tick()); assert_eq!(service.read().lid.state, "active", "takes over once the other app lets go");
        service.shutdown(); assert_eq!(host.releases.load(SeqCst), 1);
    }
    #[test]
    fn startup_restores_a_switch_left_by_an_earlier_run() {
        let host = mac(); host.marker.store(true, SeqCst); host.on.store(true, SeqCst);
        let (send, receive) = std::sync::mpsc::channel();
        let service: Arc<Service<Lease>> = Service::new(move |status| { let _ = send.send(status); }, host.clone());
        let first = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(first.lid.granted); assert_eq!(first.lid.state, "off");
        assert_eq!(host.releases.load(SeqCst), 1); assert!(!host.on.load(SeqCst)); assert!(!host.marker.load(SeqCst));
        service.shutdown();
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_acquires_both_real_power_assertions_and_releases_them() {
        for display in [false, true] { drop(power::Lease::acquire(display).unwrap()); }
    }
}
