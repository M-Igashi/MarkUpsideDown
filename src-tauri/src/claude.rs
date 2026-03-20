use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

// --- Types ---

#[derive(Clone, Serialize)]
pub struct ClaudeEvent {
    pub event_type: String,
    pub data: serde_json::Value,
}

#[derive(Default)]
pub struct ClaudeProcess {
    child: Option<Child>,
    stdin: Option<tokio::process::ChildStdin>,
    running: bool,
}

pub type ClaudeState = Arc<Mutex<ClaudeProcess>>;

pub fn new_state() -> ClaudeState {
    Arc::new(Mutex::new(ClaudeProcess::default()))
}

// --- Commands ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStartOptions {
    pub cwd: Option<String>,
    pub api_key: Option<String>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub resume: Option<bool>,
}

#[tauri::command]
pub async fn claude_start(
    options: ClaudeStartOptions,
    state: tauri::State<'_, ClaudeState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut proc = state.lock().await;
    if proc.running {
        return Err("Claude is already running".into());
    }

    // Find claude binary
    let claude_bin = which_claude().ok_or("Claude Code CLI not found. Install it first.")?;

    let mut cmd = Command::new(&claude_bin);
    cmd.arg("--print")
        .arg("--output-format=stream-json")
        .arg("--input-format=stream-json")
        .arg("--verbose");

    if options.resume.unwrap_or(false) {
        cmd.arg("--resume");
    }

    if let Some(ref mode) = options.permission_mode {
        cmd.arg(format!("--permission-mode={mode}"));
    }

    if let Some(ref model) = options.model {
        cmd.arg(format!("--model={model}"));
    }

    if let Some(ref cwd) = options.cwd {
        cmd.current_dir(cwd);
    }

    // API key support
    if let Some(ref key) = options.api_key {
        cmd.env("ANTHROPIC_API_KEY", key);
    }

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {e}"))?;

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;
    let stdin = child.stdin.take().ok_or("No stdin")?;

    proc.child = Some(child);
    proc.stdin = Some(stdin);
    proc.running = true;

    // Clone state for the watcher task
    let state_clone = state.inner().clone();

    // Spawn stdout reader
    let app_stdout = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = json
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let event = ClaudeEvent {
                    event_type: event_type.clone(),
                    data: json,
                };
                let _ = app_stdout.emit(&format!("claude:{event_type}"), &event);
                // Also emit a catch-all event
                let _ = app_stdout.emit("claude:event", &event);
            }
        }
        // Process ended — get exit code and mark not running
        let mut proc = state_clone.lock().await;
        let exit_code = if let Some(ref mut child) = proc.child {
            child.try_wait().ok().flatten().map(|s| s.code())
        } else {
            None
        };
        proc.running = false;
        proc.child = None;
        proc.stdin = None;
        let _ = app_stdout.emit(
            "claude:stopped",
            &serde_json::json!({
                "reason": "process_ended",
                "exit_code": exit_code
            }),
        );
    });

    // Spawn stderr reader (forward as error events)
    let app_stderr = app.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_stderr.emit(
                "claude:stderr",
                &serde_json::json!({"message": line}),
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn claude_stop(state: tauri::State<'_, ClaudeState>) -> Result<(), String> {
    let mut proc = state.lock().await;
    // Drop stdin first to signal EOF
    proc.stdin = None;
    if let Some(ref mut child) = proc.child {
        let _ = child.kill().await;
    }
    proc.running = false;
    proc.child = None;
    Ok(())
}

#[tauri::command]
pub async fn claude_send(
    message: String,
    images: Option<Vec<ImageData>>,
    state: tauri::State<'_, ClaudeState>,
) -> Result<(), String> {
    let mut proc = state.lock().await;
    let stdin = proc.stdin.as_mut().ok_or("Claude is not running")?;

    let content = match images {
        Some(imgs) if !imgs.is_empty() => {
            let mut blocks = vec![serde_json::json!({"type": "text", "text": message})];
            for img in imgs {
                blocks.push(serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.media_type,
                        "data": img.data
                    }
                }));
            }
            serde_json::Value::Array(blocks)
        }
        _ => serde_json::Value::String(message),
    };

    let payload = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content
        }
    });
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {e}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub media_type: String,
    pub data: String, // base64
}

#[tauri::command]
pub async fn claude_is_running(state: tauri::State<'_, ClaudeState>) -> Result<bool, String> {
    let proc = state.lock().await;
    Ok(proc.running)
}

// --- Helpers ---

fn which_claude() -> Option<String> {
    // Check common locations
    let candidates = [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    // Try PATH via `which`
    std::process::Command::new("which")
        .arg("claude")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
}

/// Cleanup: kill the process if still running
pub async fn cleanup(state: &ClaudeState) {
    let mut proc = state.lock().await;
    proc.stdin = None;
    if let Some(ref mut child) = proc.child {
        let _ = child.kill().await;
    }
    proc.running = false;
    proc.child = None;
}
