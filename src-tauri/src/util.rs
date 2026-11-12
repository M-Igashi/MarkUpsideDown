use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

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

/// Wait for a child spawned with piped stdout and stderr, killing it once
/// `timeout` passes (reported as `ErrorKind::TimedOut`) so a stalled network
/// or a credential prompt cannot hang the caller forever.
pub fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    let stdout = child.stdout.take().map(read_in_thread);
    let stderr = child.stderr.take().map(read_in_thread);
    let deadline = Instant::now() + timeout;
    // Back off from 1 ms so quick commands (git status) return promptly.
    let mut poll = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(poll);
                poll = (poll * 2).min(Duration::from_millis(50));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(result.err().unwrap_or_else(|| std::io::ErrorKind::TimedOut.into()));
            }
        }
    };
    let collect =
        |h: Option<JoinHandle<Vec<u8>>>| h.and_then(|h| h.join().ok()).unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout: collect(stdout),
        stderr: collect(stderr),
    })
}

/// Drain a pipe on its own thread so a full pipe buffer cannot block the child.
fn read_in_thread<R: Read + Send + 'static>(mut reader: R) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        buf
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn kills_a_child_that_outlives_the_timeout() {
        let spawn = |cmd: &str, arg: &str| {
            Command::new(cmd)
                .arg(arg)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        };
        let started = Instant::now();
        let err = wait_with_timeout(spawn("sleep", "30"), Duration::from_millis(200)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));

        let output = wait_with_timeout(spawn("echo", "ok"), Duration::from_secs(5)).unwrap();
        assert_eq!(output.stdout, b"ok\n");
    }
}
