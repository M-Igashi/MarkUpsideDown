use serde_json::json;
use tauri::menu::{Menu, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "recent-files.json";
const STORE_KEY: &str = "recent";
const MAX_RECENT: usize = 10;

pub fn build(handle: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let recent_files = get_recent_files(handle);

    // macOS app menu
    let app_menu = SubmenuBuilder::new(handle, "MarkUpsideDown")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Open Recent submenu
    let mut recent_builder = SubmenuBuilder::new(handle, "Open Recent");
    if recent_files.is_empty() {
        recent_builder = recent_builder.item(&MenuItem::with_id(
            handle,
            "no_recent",
            "No Recent Files",
            false,
            None::<&str>,
        )?);
    } else {
        for (i, path) in recent_files.iter().enumerate() {
            let label = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            recent_builder = recent_builder.item(&MenuItem::with_id(
                handle,
                format!("recent_{i}"),
                label.as_str(),
                true,
                None::<&str>,
            )?);
        }
        recent_builder = recent_builder.separator();
        recent_builder = recent_builder.item(&MenuItem::with_id(
            handle,
            "clear_recent",
            "Clear Recent",
            true,
            None::<&str>,
        )?);
    }
    let recent_submenu = recent_builder.build()?;

    // File menu
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&MenuItem::with_id(
            handle,
            "new_window",
            "New Window",
            true,
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .separator()
        .item(&recent_submenu)
        .separator()
        .close_window()
        .build()?;

    // Edit menu (standard macOS)
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    Menu::with_items(handle, &[&app_menu, &file_menu, &edit_menu])
}

fn get_recent_files(handle: &AppHandle) -> Vec<String> {
    let Ok(store) = handle.store(STORE_FILE) else {
        return vec![];
    };
    store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default()
}

fn update_recent(handle: &AppHandle, files: &[String]) {
    if let Ok(store) = handle.store(STORE_FILE) {
        store.set(STORE_KEY, json!(files));
    }
    if let Ok(menu) = build(handle) {
        let _ = handle.set_menu(menu);
    }
}

pub fn handle_event(handle: &AppHandle, event: &MenuEvent) {
    let id = event.id().as_ref();

    if id == "new_window" {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let label = format!("main-{ts}");
        let _ = WebviewWindowBuilder::new(handle, &label, WebviewUrl::App("index.html?fresh=1".into()))
            .title("MarkUpsideDown")
            .inner_size(1200.0, 800.0)
            .build();
        return;
    }

    if id == "clear_recent" {
        update_recent(handle, &[]);
        return;
    }

    if let Some(idx_str) = id.strip_prefix("recent_") {
        if let Ok(idx) = idx_str.parse::<usize>() {
            let files = get_recent_files(handle);
            if let Some(path) = files.get(idx) {
                // Emit to focused window if available, otherwise broadcast
                let editor_states = handle
                    .try_state::<std::sync::Arc<crate::commands::EditorStates>>();
                let mut emitted = false;
                if let Some(states) = editor_states {
                    if let Some(label) = states.get_focused_label() {
                        if let Some(win) = handle.webview_windows().get(&label) {
                            let _ = win.emit("menu:open-recent", path.clone());
                            emitted = true;
                        }
                    }
                }
                if !emitted {
                    let _ = handle.emit("menu:open-recent", path.clone());
                }
            }
        }
    }
}

#[tauri::command]
pub fn add_recent_file(handle: AppHandle, path: String) {
    if path.is_empty() {
        return;
    }
    let mut files = get_recent_files(&handle);
    files.retain(|p| p != &path);
    files.insert(0, path);
    files.truncate(MAX_RECENT);
    update_recent(&handle, &files);
}
