//! Bringing the main window forward from the page, without a JS window capability (OPS-11).
//!
//! Receiving OPS work (another community device handed this Mac a task) and the voice window's device choice
//! must show the main window even while it is hidden. JS `getCurrentWindow().show()/setFocus()` would need
//! `core:window:allow-show`/`allow-set-focus` on the main capability; like `workroom_capture_hide_app`, a
//! custom command keeps `capabilities/default.json` unchanged.

use tauri::Manager;

/// Only the main window may ask. Pop-outs and the voice window reach main through their own commands.
pub(crate) fn may_reveal_main_window(label: &str) -> bool {
    label == "main"
}

/// Async: window calls dispatch to the main thread, and a sync command would run them on it while it waits.
#[tauri::command]
pub(crate) async fn reveal_main_window(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    if !may_reveal_main_window(window.label()) {
        return Err("이 창에서는 본창을 앞으로 가져올 수 없습니다.".to_string());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "본창을 찾지 못했습니다.".to_string())?;
    // The same three steps as the Dock reopen and the global shortcut.
    main.show().map_err(|error| error.to_string())?;
    let _ = main.unminimize();
    main.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_may_reveal_main() {
        assert!(may_reveal_main_window("main"));
        for label in ["workroom-1", "voice-dock", "voice-dock-2", "Main", "main ", ""] {
            assert!(!may_reveal_main_window(label), "{}", label);
        }
    }

    #[test]
    fn the_command_is_registered_and_main_capability_stays_unwidened() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("main_window::reveal_main_window"));
        let main: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = main["permissions"].as_array().unwrap();
        for widened in ["core:window:allow-show", "core:window:allow-set-focus"] {
            assert!(!permissions.iter().any(|p| p.as_str() == Some(widened)), "{}", widened);
        }
    }
}
