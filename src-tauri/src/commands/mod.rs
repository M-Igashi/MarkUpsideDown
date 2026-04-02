mod crawl;
mod editor;
mod files;
mod git;
mod web;

pub use crawl::*;
pub use editor::*;
pub use files::*;
pub use git::*;
pub use web::*;

use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

// --- Shared Editor State (for MCP bridge) ---

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct TabInfo {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub is_dirty: bool,
}

#[derive(Clone, Default)]
pub struct EditorStateInner {
    pub content: String,
    pub file_path: Option<String>,
    pub cursor_pos: usize,
    pub cursor_line: usize,
    pub cursor_column: usize,
    pub worker_url: Option<String>,
    pub document_structure: Option<String>, // JSON string from frontend
    pub lint_diagnostics: Option<String>,   // JSON string from frontend
    pub root_path: Option<String>,
    pub tabs: Vec<TabInfo>,
}

/// Per-window editor state, keyed by window label.
/// Also tracks which window is currently focused for bridge routing.
pub struct EditorStates {
    pub map: std::sync::Mutex<std::collections::HashMap<String, EditorStateInner>>,
    pub focused: std::sync::Mutex<Option<String>>,
}

impl Default for EditorStates {
    fn default() -> Self {
        Self {
            map: std::sync::Mutex::new(std::collections::HashMap::new()),
            focused: std::sync::Mutex::new(None),
        }
    }
}

impl EditorStates {
    /// Get a clone of the focused window's state, or the first available window's state.
    pub fn get_focused_state(&self) -> Option<EditorStateInner> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let focused = self.focused.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(label) = focused.as_ref() {
            if let Some(state) = map.get(label) {
                return Some(state.clone());
            }
        }
        // Fallback: return first available window's state
        map.values().next().cloned()
    }

    /// Remove a window's state entry.
    pub fn remove_window(&self, label: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }

    /// Set the focused window label.
    pub fn set_focused(&self, label: String) {
        *self.focused.lock().unwrap_or_else(|e| e.into_inner()) = Some(label);
    }

    /// Get the focused window label.
    pub fn get_focused_label(&self) -> Option<String> {
        self.focused
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Get a single field from the focused window's state without cloning the entire struct.
    fn get_focused_field<T>(&self, f: impl FnOnce(&EditorStateInner) -> T) -> Option<T> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let focused = self.focused.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(label) = focused.as_ref() {
            if let Some(state) = map.get(label) {
                return Some(f(state));
            }
        }
        map.values().next().map(f)
    }

    pub fn get_focused_root_path(&self) -> Option<String> {
        self.get_focused_field(|s| s.root_path.clone()).flatten()
    }

    /// Get the state for a specific window by label.
    pub fn get_window_state(&self, label: &str) -> Option<EditorStateInner> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.get(label).cloned()
    }

    /// Get all window labels and their root paths.
    pub fn get_all_windows(&self) -> Vec<(String, Option<String>)> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.iter()
            .map(|(label, state)| (label.clone(), state.root_path.clone()))
            .collect()
    }
}

// --- Window Registry (for session restoration) ---

const WINDOW_REGISTRY_STORE: &str = "window-registry.json";
const WINDOW_REGISTRY_KEY: &str = "windows";

#[derive(Clone, Serialize, Deserialize)]
pub struct WindowRegistryEntry {
    pub label: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn save_window_registry(
    handle: tauri::AppHandle,
    windows: Vec<WindowRegistryEntry>,
) -> Result<(), String> {
    let store = handle
        .store(WINDOW_REGISTRY_STORE)
        .map_err(|e| e.to_string())?;
    store.set(
        WINDOW_REGISTRY_KEY,
        serde_json::to_value(&windows).map_err(|e| e.to_string())?,
    );
    Ok(())
}

#[tauri::command]
pub fn load_window_registry(
    handle: tauri::AppHandle,
) -> Result<Vec<WindowRegistryEntry>, String> {
    let store = handle
        .store(WINDOW_REGISTRY_STORE)
        .map_err(|e| e.to_string())?;
    let entries = store
        .get(WINDOW_REGISTRY_KEY)
        .and_then(|v| serde_json::from_value::<Vec<WindowRegistryEntry>>(v.clone()).ok())
        .unwrap_or_default();
    Ok(entries)
}
