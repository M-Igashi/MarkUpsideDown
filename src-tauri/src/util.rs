use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::commands::EditorStates;

/// Emit an event to a single window: the focused one, else "main", else any.
/// `Emitter::emit` would reach every window, so with several windows open an
/// MCP edit or a file-open would land in all of them.
pub fn emit_to_focused<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let windows = app.webview_windows();
    let focused = app
        .try_state::<Arc<EditorStates>>()
        .and_then(|s| s.get_focused_label());
    let label = focused
        .filter(|l| windows.contains_key(l))
        .or_else(|| windows.contains_key("main").then(|| "main".to_string()))
        .or_else(|| windows.keys().next().cloned());
    if let Some(label) = label {
        let _ = app.emit_to(label.as_str(), event, payload);
    }
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Extract the page title from an HTML string.
/// Looks for `<title>...</title>` (case-insensitive) and decodes common HTML entities.
pub fn extract_html_title(html: &str) -> crate::error::Result<String> {
    use crate::error::AppError;
    let lower = html.to_ascii_lowercase();
    let start = lower
        .find("<title")
        .and_then(|i| lower[i..].find('>').map(|j| i + j + 1));
    let end = lower.find("</title>");
    match (start, end) {
        (Some(s), Some(e)) if s < e => {
            let title = html[s..e].trim().to_string();
            let title = title
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&#x27;", "'")
                .replace("&apos;", "'");
            if title.is_empty() {
                Err(AppError::Validation("Empty title".into()))
            } else {
                Ok(title)
            }
        }
        _ => Err(AppError::Validation("No title found".into())),
    }
}

/// Builder for an extra app window, derived from the main window in
/// tauri.conf.json so every window gets the same title bar and settings.
pub fn app_window_builder<'a, M: Manager<Wry>>(
    manager: &'a M,
    label: &str,
    url: WebviewUrl,
) -> tauri::Result<WebviewWindowBuilder<'a, Wry, M>> {
    let mut config = manager
        .config()
        .app
        .windows
        .first()
        .cloned()
        .unwrap_or_default();
    config.label = label.to_string();
    config.url = url;
    WebviewWindowBuilder::from_config(manager, &config)
}
