//! Workroom attachments in the app (S3, 2026-10-16): Finder drops into pop-out windows and the native picker.
//!
//! Pop-outs (`workroom-*`) may only set their title and request native confirmation, so their pages cannot listen to
//! Tauri's drag-drop events. Instead Rust watches the pop-out's DragDrop window events, keeps the dropped paths
//! per window label (30 s, at most 32), and tells the page with an `eval`'d CustomEvent that carries only
//! numbers — never a path. The page then calls `workroom_take_drop` once, which returns and clears only its own
//! window's paths. The picker runs from Rust too, so no window needs a JS file-dialog permission.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const DROP_STASH_TTL: Duration = Duration::from_secs(30);
pub(crate) const DROP_STASH_MAX_PATHS: usize = 32;
const PICK_MAX_PATHS: usize = 16;
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"];

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct TakenDrop {
    pub paths: Vec<String>,
    /// Everything that was dropped, including items without a usable path and those beyond the cap.
    pub total: usize,
}

struct StashEntry {
    paths: Vec<String>,
    total: usize,
    at: Instant,
}

#[derive(Default)]
pub(crate) struct DropStash {
    entries: HashMap<String, StashEntry>,
}

impl DropStash {
    /// Replaces the window's previous drop. Paths that are not valid UTF-8 cannot be named in a request and are
    /// counted but not kept.
    pub(crate) fn put(&mut self, label: &str, paths: &[PathBuf], now: Instant) -> usize {
        let kept: Vec<String> = paths.iter().filter_map(|path| path.to_str().map(str::to_string)).take(DROP_STASH_MAX_PATHS).collect();
        self.entries.insert(label.to_string(), StashEntry { paths: kept, total: paths.len(), at: now });
        paths.len()
    }

    /// Once: the entry is removed whether or not it was still fresh.
    pub(crate) fn take(&mut self, label: &str, now: Instant) -> TakenDrop {
        match self.entries.remove(label) {
            Some(entry) if now.saturating_duration_since(entry.at) <= DROP_STASH_TTL => TakenDrop { paths: entry.paths, total: entry.total },
            _ => TakenDrop { paths: Vec::new(), total: 0 },
        }
    }

    pub(crate) fn forget(&mut self, label: &str) {
        self.entries.remove(label);
    }
}

fn stash() -> &'static Mutex<DropStash> {
    static STASH: OnceLock<Mutex<DropStash>> = OnceLock::new();
    STASH.get_or_init(|| Mutex::new(DropStash::default()))
}

pub(crate) fn may_use_workroom_attachments(label: &str) -> bool {
    label == "main" || crate::workroom_popout::is_workroom_popout_label(label)
}

/// macOS (wry) reports drag positions in view points; the other platforms report physical pixels.
pub(crate) fn logical_drop_position(x: f64, y: f64, scale: f64, positions_are_logical: bool) -> (f64, f64) {
    if positions_are_logical || !(scale > 0.0) { (x, y) } else { (x / scale, y / scale) }
}

fn finite(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

/// The page-side notice. Numbers only: no path, no string from the drag, so nothing dropped reaches script.
pub(crate) fn drop_event_script(kind: &str, x: f64, y: f64, width: f64, count: usize) -> String {
    let (event, extra) = match kind {
        "drop" => ("agentstoz-drop", format!(",count:{}", count)),
        "leave" => ("agentstoz-drag", String::from(",type:\"leave\"")),
        // How many paths the drag carries: a text or link drag carries none and must not show the attach overlay.
        "enter" => ("agentstoz-drag", format!(",type:\"enter\",count:{}", count)),
        _ => ("agentstoz-drag", String::from(",type:\"over\"")),
    };
    format!(
        "window.dispatchEvent(new CustomEvent(\"{}\",{{detail:{{x:{},y:{},width:{}{}}}}}))",
        event, finite(x), finite(y), finite(width), extra
    )
}

/// Wires one pop-out window: its drops are stashed under its label and announced to its page.
pub(crate) fn watch_popout_drops(window: &tauri::WebviewWindow) {
    let target = window.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        let geometry = || {
            let scale = target.scale_factor().unwrap_or(1.0);
            let width = target.inner_size().map(|size| size.width as f64 / scale).unwrap_or(0.0);
            (scale, width)
        };
        match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { paths, position }) => {
                let (scale, width) = geometry();
                let (x, y) = logical_drop_position(position.x, position.y, scale, cfg!(target_os = "macos"));
                let _ = target.eval(&drop_event_script("enter", x, y, width, paths.len()));
            }
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Over { position }) => {
                let (scale, width) = geometry();
                let (x, y) = logical_drop_position(position.x, position.y, scale, cfg!(target_os = "macos"));
                let _ = target.eval(&drop_event_script("over", x, y, width, 0));
            }
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) => {
                let (scale, width) = geometry();
                let (x, y) = logical_drop_position(position.x, position.y, scale, cfg!(target_os = "macos"));
                let count = stash().lock().map(|mut stash| stash.put(&label, paths, Instant::now())).unwrap_or(0);
                let _ = target.eval(&drop_event_script("drop", x, y, width, count));
            }
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => {
                let _ = target.eval(&drop_event_script("leave", 0.0, 0.0, 0.0, 0));
            }
            tauri::WindowEvent::Destroyed => {
                if let Ok(mut stash) = stash().lock() { stash.forget(&label); }
            }
            _ => {}
        }
    });
}

/// The paths last dropped on the calling window, once. Callable only from the main window and Workroom pop-outs,
/// and only ever for the caller's own label.
#[tauri::command]
pub(crate) async fn workroom_take_drop(window: tauri::Window) -> Result<TakenDrop, String> {
    if !may_use_workroom_attachments(window.label()) {
        return Err("이 창에서는 끌어 놓은 파일을 받을 수 없습니다.".to_string());
    }
    let mut stash = stash().lock().map_err(|_| "끌어 놓은 파일을 읽지 못했습니다.".to_string())?;
    Ok(stash.take(window.label(), Instant::now()))
}

/// What a pick hands to the page: at most PICK_MAX_PATHS usable paths, and how many were picked in all, so the
/// page can say what it left out (beyond the cap, or a path that is not valid UTF-8) instead of dropping it silently.
pub(crate) fn picked_paths(picked: Vec<Option<PathBuf>>) -> TakenDrop {
    let total = picked.len();
    let paths = picked
        .into_iter()
        .flatten()
        .filter_map(|path| path.to_str().map(str::to_string))
        .take(PICK_MAX_PATHS)
        .collect();
    TakenDrop { paths, total }
}

/// The native picker for 「사진 첨부」 (images) and 「파일 첨부」 (any file), several at once. Run from Rust so the
/// page gets real paths (files are referenced in place) and the image filter applies — the webview's own
/// `<input type=file>` panel ignores `accept`. No paths and a total of 0 means the person cancelled.
#[tauri::command]
pub(crate) async fn workroom_pick_attachments(app: tauri::AppHandle, window: tauri::Window, kind: String) -> Result<TakenDrop, String> {
    use tauri_plugin_dialog::DialogExt;
    if !may_use_workroom_attachments(window.label()) {
        return Err("이 창에서는 파일을 고를 수 없습니다.".to_string());
    }
    let images = match kind.as_str() {
        "image" => true,
        "file" => false,
        _ => return Err("고를 항목의 종류가 올바르지 않습니다.".to_string()),
    };
    let mut builder = app.dialog().file().set_title(if images { "첨부할 사진 고르기" } else { "첨부할 파일 고르기" });
    if images {
        builder = builder.add_filter("이미지", &IMAGE_EXTENSIONS);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_files())
        .await
        .map_err(|_| "파일 선택 창을 열지 못했습니다.".to_string())?;
    Ok(picked_paths(picked.unwrap_or_default().into_iter().map(|path| path.into_path().ok()).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drop_is_taken_once_by_its_own_window_only() {
        let mut stash = DropStash::default();
        let now = Instant::now();
        stash.put("workroom-1", &[PathBuf::from("/tmp/a.pdf"), PathBuf::from("/tmp/b.png")], now);
        assert_eq!(stash.take("workroom-2", now), TakenDrop { paths: vec![], total: 0 }, "another window gets nothing");
        assert_eq!(stash.take("workroom-1", now), TakenDrop { paths: vec!["/tmp/a.pdf".into(), "/tmp/b.png".into()], total: 2 });
        assert_eq!(stash.take("workroom-1", now), TakenDrop { paths: vec![], total: 0 }, "taken once");
    }

    #[test]
    fn a_stale_drop_is_discarded() {
        let mut stash = DropStash::default();
        let then = Instant::now();
        stash.put("workroom-1", &[PathBuf::from("/tmp/a.pdf")], then);
        assert_eq!(stash.take("workroom-1", then + DROP_STASH_TTL + Duration::from_millis(1)).paths.len(), 0);
        stash.put("workroom-1", &[PathBuf::from("/tmp/a.pdf")], then);
        assert_eq!(stash.take("workroom-1", then + DROP_STASH_TTL).paths.len(), 1, "exactly at the limit still counts");
    }

    #[test]
    fn the_stash_keeps_at_most_32_paths_but_counts_all() {
        let mut stash = DropStash::default();
        let now = Instant::now();
        let many: Vec<PathBuf> = (0..40).map(|i| PathBuf::from(format!("/tmp/{}.txt", i))).collect();
        assert_eq!(stash.put("workroom-1", &many, now), 40);
        let taken = stash.take("workroom-1", now);
        assert_eq!(taken.paths.len(), DROP_STASH_MAX_PATHS);
        assert_eq!(taken.total, 40);
    }

    #[test]
    fn a_new_drop_replaces_the_previous_one_and_forget_clears_it() {
        let mut stash = DropStash::default();
        let now = Instant::now();
        stash.put("workroom-1", &[PathBuf::from("/tmp/old.txt")], now);
        stash.put("workroom-1", &[PathBuf::from("/tmp/new.txt")], now);
        assert_eq!(stash.take("workroom-1", now).paths, vec!["/tmp/new.txt".to_string()]);
        stash.put("workroom-1", &[PathBuf::from("/tmp/x.txt")], now);
        stash.forget("workroom-1");
        assert_eq!(stash.take("workroom-1", now).total, 0);
    }

    #[test]
    fn a_pick_beyond_the_cap_reports_the_whole_count() {
        let many: Vec<Option<PathBuf>> = (0..20).map(|i| Some(PathBuf::from(format!("/tmp/{}.pdf", i)))).collect();
        let picked = picked_paths(many);
        assert_eq!(picked.paths.len(), PICK_MAX_PATHS);
        assert_eq!(picked.total, 20, "the four left out are counted, not lost");
        let unusable = picked_paths(vec![Some(PathBuf::from("/tmp/a.pdf")), None]);
        assert_eq!(unusable, TakenDrop { paths: vec!["/tmp/a.pdf".into()], total: 2 });
        assert_eq!(picked_paths(Vec::new()), TakenDrop { paths: vec![], total: 0 }, "a cancelled pick");
    }

    #[cfg(unix)]
    #[test]
    fn a_picked_path_that_is_not_utf8_is_counted_but_not_kept() {
        use std::os::unix::ffi::OsStrExt;
        let odd = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\xff.pdf"));
        assert_eq!(picked_paths(vec![Some(odd), Some(PathBuf::from("/tmp/ok.pdf"))]), TakenDrop { paths: vec!["/tmp/ok.pdf".into()], total: 2 });
    }

    #[test]
    fn only_the_main_window_and_workroom_popouts_may_take_or_pick() {
        assert!(may_use_workroom_attachments("main"));
        assert!(may_use_workroom_attachments("workroom-3"));
        assert!(!may_use_workroom_attachments("voice"));
        assert!(!may_use_workroom_attachments("workroom-"));
        assert!(!may_use_workroom_attachments("settings"));
    }

    #[test]
    fn the_page_notice_carries_numbers_and_never_a_path() {
        let drop = drop_event_script("drop", 120.5, 40.0, 1120.0, 3);
        assert_eq!(drop, "window.dispatchEvent(new CustomEvent(\"agentstoz-drop\",{detail:{x:120.5,y:40,width:1120,count:3}}))");
        assert_eq!(drop_event_script("over", f64::NAN, f64::INFINITY, 10.0, 0), "window.dispatchEvent(new CustomEvent(\"agentstoz-drag\",{detail:{x:0,y:0,width:10,type:\"over\"}}))");
        assert!(drop_event_script("leave", 0.0, 0.0, 0.0, 0).contains("type:\"leave\""));
        assert_eq!(drop_event_script("enter", 5.0, 6.0, 10.0, 0), "window.dispatchEvent(new CustomEvent(\"agentstoz-drag\",{detail:{x:5,y:6,width:10,type:\"enter\",count:0}}))", "a text drag says it carries no path");
        assert!(drop_event_script("enter", 5.0, 6.0, 10.0, 2).ends_with("type:\"enter\",count:2}}))"));
    }

    #[test]
    fn physical_drop_positions_become_logical_points() {
        assert_eq!(logical_drop_position(200.0, 100.0, 2.0, false), (100.0, 50.0));
        assert_eq!(logical_drop_position(200.0, 100.0, 2.0, true), (200.0, 100.0), "macOS already reports points");
        assert_eq!(logical_drop_position(200.0, 100.0, 0.0, false), (200.0, 100.0));
    }

    #[test]
    fn the_popout_capability_excludes_drag_and_file_dialog_privileges() {
        let popout: serde_json::Value = serde_json::from_str(include_str!("../capabilities/workroom-popout.json")).unwrap();
        assert_eq!(popout["permissions"], serde_json::json!(["core:window:allow-set-title", "dialog:allow-confirm"]));
    }
}
