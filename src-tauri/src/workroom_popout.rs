//! Workroom pop-out windows (VOC 2026-09-25).
//!
//! The main window asks for a pop-out; Rust creates the webview so no window
//! needs a JS window-creation permission. The pop-out loads the same bundle with
//! a query that renders only the Workroom. The query grammar is shared with
//! `src/workroomPopout.ts` through `tests/fixtures/workroom-popout-golden.json`.
//! Closing a pop-out only destroys that webview; CLI sessions live in the sidecar.

use std::sync::atomic::{AtomicU64, Ordering};

const KEYS: [&str; 5] = ["workroom-popout", "session", "target", "agent", "bypass"];
const AGENTS: [&str; 4] = ["codex", "claude", "hermes", "agy"];

static NEXT_POPOUT: AtomicU64 = AtomicU64::new(1);

fn is_opaque_id(value: &str) -> bool {
    (8..=160).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Exactly the five keys, each once, opaque ids only. Anything else is refused.
pub(crate) fn validate_workroom_popout_query(query: &str) -> Result<(), String> {
    let reject = || Err("분리할 워크룸 세션 정보가 올바르지 않습니다.".to_string());
    if query.is_empty() || query.contains(['#', '%', '+']) {
        return reject();
    }
    let mut seen: Vec<&str> = Vec::with_capacity(KEYS.len());
    let mut values: [&str; 5] = [""; 5];
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { return reject() };
        let Some(index) = KEYS.iter().position(|k| *k == key) else { return reject() };
        if seen.contains(&key) {
            return reject();
        }
        seen.push(key);
        values[index] = value;
    }
    if seen.len() != KEYS.len()
        || values[0] != "1"
        || !is_opaque_id(values[1])
        || !is_opaque_id(values[2])
        || !AGENTS.contains(&values[3])
        || !(values[4] == "0" || values[4] == "1")
    {
        return reject();
    }
    Ok(())
}

/// Pop-out labels are `workroom-<n>` — the glob the pop-out capability is scoped to.
pub(crate) fn is_workroom_popout_label(label: &str) -> bool {
    let Some(number) = label.strip_prefix("workroom-") else { return false };
    (1..=6).contains(&number.len())
        && !number.starts_with('0')
        && number.bytes().all(|b| b.is_ascii_digit())
}

pub(crate) fn sanitize_workroom_popout_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let short: String = cleaned.chars().take(120).collect();
    if short.is_empty() { "워크룸".to_string() } else { short }
}

/// Dock click (macOS Reopen): bring back the main window whenever it is hidden.
/// `has_visible_windows` alone is not enough once pop-outs exist — a visible
/// pop-out would otherwise leave a closed (hidden) main window unreachable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn should_restore_main_on_reopen(has_visible_windows: bool, main_visible: bool) -> bool {
    !has_visible_windows || !main_visible
}

/// Offset of a new pop-out from the window that opened it. Each open pop-out pushes the next one
/// further down-right (wrapping after 8) so a new window never lands exactly on top of an earlier
/// one — in the real app that read as "the button did nothing".
pub(crate) fn popout_cascade_offset(open_popouts: usize) -> f64 {
    32.0 + 28.0 * (open_popouts % 8) as f64
}

/// Opens one more Workroom window. Callable only from the main window or another pop-out.
#[tauri::command]
pub(crate) async fn open_workroom_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    query: String,
    title: String,
) -> Result<String, String> {
    use tauri::Manager;
    if window.label() != "main" && !is_workroom_popout_label(window.label()) {
        return Err("이 창에서는 워크룸을 분리할 수 없습니다.".to_string());
    }
    validate_workroom_popout_query(&query)?;
    let label = loop {
        let n = NEXT_POPOUT.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("workroom-{}", n);
        if !is_workroom_popout_label(&candidate) {
            return Err("워크룸 창을 더 열 수 없습니다. 앱을 다시 시작해 주세요.".to_string());
        }
        if app.get_webview_window(&candidate).is_none() {
            break candidate;
        }
    };
    let open_popouts = app
        .webview_windows()
        .keys()
        .filter(|existing| is_workroom_popout_label(existing))
        .count();
    let origin = window
        .outer_position()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(position, scale)| position.to_logical::<f64>(scale));
    let url = tauri::WebviewUrl::App(format!("index.html?{}", query).into());
    let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(sanitize_workroom_popout_title(&title))
        .inner_size(960.0, 980.0)
        .min_inner_size(520.0, 480.0)
        .resizable(true);
    if let Some(origin) = origin {
        let offset = popout_cascade_offset(open_popouts);
        builder = builder.position(origin.x + offset, origin.y + offset);
    }
    builder
        .build()
        .map_err(|error| format!("워크룸 창을 열지 못했습니다: {}", error))?;
    Ok(label)
}

/// Steps the whole app aside while the person picks what to capture for a Workroom request (VOC 2026-10-02),
/// then brings it back. Hiding every window (like ⌘H) frees the app behind, which the main window could
/// still cover while only a pop-out hid. A custom command, so no window capability is widened for it.
#[tauri::command]
pub(crate) async fn workroom_capture_hide_app(
    app: tauri::AppHandle,
    window: tauri::Window,
    hidden: bool,
) -> Result<(), String> {
    if window.label() != "main" && !is_workroom_popout_label(window.label()) {
        return Err("이 창에서는 화면 캡처를 할 수 없습니다.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        if hidden {
            app.hide().map_err(|error| error.to_string())?;
        } else {
            app.show().map_err(|error| error.to_string())?;
            let _ = window.set_focus();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, hidden);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/workroom-popout-golden.json")).unwrap()
    }

    #[test]
    fn each_new_popout_lands_further_down_right_and_wraps() {
        assert_eq!(popout_cascade_offset(0), 32.0);
        assert!(popout_cascade_offset(1) > popout_cascade_offset(0));
        assert!(popout_cascade_offset(7) > popout_cascade_offset(6));
        assert_eq!(popout_cascade_offset(8), popout_cascade_offset(0));
    }

    #[test]
    fn workroom_popout_query_matches_shared_golden() {
        for case in golden()["queries"].as_array().unwrap() {
            let query = case["query"].as_str().unwrap();
            let valid = case["valid"].as_bool().unwrap();
            assert_eq!(validate_workroom_popout_query(query).is_ok(), valid, "{}", query);
        }
    }

    #[test]
    fn workroom_popout_labels_match_shared_golden() {
        for case in golden()["labels"].as_array().unwrap() {
            let label = case["label"].as_str().unwrap();
            assert_eq!(is_workroom_popout_label(label), case["valid"].as_bool().unwrap(), "{}", label);
        }
    }

    #[test]
    fn workroom_popout_capability_is_scoped_to_popout_labels() {
        let popout: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/workroom-popout.json")).unwrap();
        assert_eq!(popout["windows"], serde_json::json!(["workroom-*"]));
        assert_eq!(popout["permissions"], serde_json::json!(["core:window:allow-set-title"]));
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(main["windows"], serde_json::json!(["main"]));
        assert!(!main.to_string().contains("create-webview"));
    }

    #[test]
    fn dock_reopen_restores_a_hidden_main_window_even_with_a_popout_visible() {
        assert!(should_restore_main_on_reopen(false, false));
        assert!(should_restore_main_on_reopen(true, false), "a visible pop-out must not strand the hidden main window");
        assert!(!should_restore_main_on_reopen(true, true));
    }

    #[test]
    fn workroom_popout_title_is_clean_and_bounded() {
        assert_eq!(sanitize_workroom_popout_title("A\u{0}\nB  · codex"), "A B · codex");
        assert_eq!(sanitize_workroom_popout_title("   "), "워크룸");
        assert_eq!(sanitize_workroom_popout_title(&"가".repeat(500)).chars().count(), 120);
    }
}
