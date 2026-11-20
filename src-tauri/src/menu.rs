use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, Wry};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "recent-files.json";
const STORE_KEY: &str = "recent";
const MAX_RECENT: usize = 10;
const FILE_MENU_ID: &str = "file_menu";
const RECENT_SUBMENU_ID: &str = "open_recent";

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
        // Not the predefined Quit item: that one terminates the process
        // without giving the windows a chance to save or ask.
        .item(&MenuItem::with_id(
            handle,
            "quit",
            "Quit MarkUpsideDown",
            true,
            Some("CmdOrCtrl+Q"),
        )?)
        .build()?;

    // Open Recent submenu
    let recent_submenu =
        SubmenuBuilder::with_id(handle, RECENT_SUBMENU_ID, "Open Recent").build()?;
    populate_recent_submenu(handle, &recent_submenu, &recent_files)?;

    // File menu
    let file_menu = SubmenuBuilder::with_id(handle, FILE_MENU_ID, "File")
        .item(&MenuItem::with_id(
            handle,
            "new_window",
            "New Window",
            true,
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .separator()
        .item(&action_item(handle, "open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&action_item(handle, "open-folder", "Open Folder…", Some("CmdOrCtrl+Shift+O"))?)
        .item(&recent_submenu)
        .separator()
        .item(&action_item(handle, "save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&action_item(handle, "import", "Import Document…", Some("CmdOrCtrl+Shift+I"))?)
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

/// A File menu item handled by the focused window's frontend (`menu:action` event).
fn action_item(
    handle: &AppHandle,
    action: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(handle, format!("action:{action}"), label, true, accelerator)
}

/// Replace the contents of the "Open Recent" submenu with `files`.
fn populate_recent_submenu(
    handle: &AppHandle,
    submenu: &Submenu<Wry>,
    files: &[String],
) -> tauri::Result<()> {
    while matches!(submenu.remove_at(0), Ok(Some(_))) {}

    if files.is_empty() {
        submenu.append(&MenuItem::with_id(
            handle,
            "no_recent",
            "No Recent Files",
            false,
            None::<&str>,
        )?)?;
        return Ok(());
    }

    for (i, path) in files.iter().enumerate() {
        let label = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        submenu.append(&MenuItem::with_id(
            handle,
            format!("recent_{i}"),
            label.as_str(),
            true,
            None::<&str>,
        )?)?;
    }
    submenu.append(&PredefinedMenuItem::separator(handle)?)?;
    submenu.append(&MenuItem::with_id(
        handle,
        "clear_recent",
        "Clear Recent",
        true,
        None::<&str>,
    )?)?;
    Ok(())
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
    // Update just the Open Recent submenu instead of rebuilding and
    // replacing the entire native menu on every file open.
    let recent_submenu = handle
        .menu()
        .and_then(|m| m.get(FILE_MENU_ID))
        .and_then(|file| file.as_submenu().and_then(|f| f.get(RECENT_SUBMENU_ID)))
        .and_then(|kind| kind.as_submenu().cloned());
    if let Some(submenu) = recent_submenu {
        let _ = populate_recent_submenu(handle, &submenu, files);
        return;
    }
    // Fallback: rebuild the whole menu
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
        let url = WebviewUrl::App("index.html?fresh=1".into());
        if let Ok(builder) = crate::util::app_window_builder(handle, &label, url) {
            let _ = builder.build();
        }
        return;
    }

    if id == "quit" {
        request_quit(handle);
        return;
    }

    if let Some(action) = id.strip_prefix("action:") {
        crate::util::emit_to_focused(handle, "menu:action", action.to_string());
        return;
    }

    if id == "clear_recent" {
        update_recent(handle, &[]);
        return;
    }

    if let Some(idx_str) = id.strip_prefix("recent_")
        && let Ok(idx) = idx_str.parse::<usize>()
        && let Some(path) = get_recent_files(handle).get(idx)
    {
        crate::util::emit_to_focused(handle, "menu:open-recent", path.clone());
    }
}

/// Windows that still have to agree before the app quits. The last one is
/// the window being asked.
#[derive(Default)]
pub struct QuitQueue(Mutex<Vec<String>>);

/// Ask every window with a loaded frontend to run its unsaved-changes check
/// (`app:quit-requested`), one at a time, starting with the focused window.
fn request_quit(handle: &AppHandle) {
    let editor = handle.state::<Arc<crate::commands::EditorStates>>();
    let focused = editor.get_focused_label();
    let mut labels: Vec<String> = editor.get_all_windows().into_iter().map(|(l, _)| l).collect();
    labels.sort_by_key(|l| Some(l) == focused.as_ref());
    *handle.state::<QuitQueue>().0.lock().unwrap() = labels;
    continue_quit(handle);
}

/// Ask the next window in the queue, or exit once none is left.
fn continue_quit(handle: &AppHandle) {
    {
        let queue = handle.state::<QuitQueue>();
        let mut queue = queue.0.lock().unwrap();
        while let Some(label) = queue.last() {
            if handle.get_webview_window(label).is_some()
                && handle.emit_to(label.as_str(), "app:quit-requested", ()).is_ok()
            {
                return;
            }
            queue.pop();
        }
    }
    crate::bridge::cleanup();
    handle.exit(0);
}

/// A window's answer to `app:quit-requested`. `ok: false` cancels the quit.
#[tauri::command]
pub fn quit_response(window: tauri::WebviewWindow, queue: tauri::State<'_, QuitQueue>, ok: bool) {
    {
        let mut queue = queue.0.lock().unwrap();
        if queue.last().map(String::as_str) != Some(window.label()) {
            return;
        }
        if !ok {
            queue.clear();
            return;
        }
        queue.pop();
    }
    continue_quit(window.app_handle());
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
