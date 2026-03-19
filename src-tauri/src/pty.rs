use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

struct PtySession {
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn portable_pty::Child + Send>>,
}

pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
    next_id: Mutex<u32>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    session_id: String,
}

/// Resolve the full path to the `claude` binary.
/// macOS GUI apps don't inherit shell profile PATH, so we check well-known
/// install locations first, then fall back to a login-shell `which`.
fn find_claude_path() -> Option<String> {
    let candidates = [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ];
    for path in candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    // Fallback: ask a login shell (loads /etc/profile, ~/.zprofile, etc.)
    let output = std::process::Command::new("/bin/zsh")
        .args(["-l", "-c", "which claude"])
        .output()
        .ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
}

#[tauri::command]
pub fn check_claude_installed() -> Result<bool, String> {
    Ok(find_claude_path().is_some())
}

#[tauri::command]
pub fn create_session(state: tauri::State<'_, PtyState>) -> Result<String, String> {
    let mut next_id = state.next_id.lock().unwrap();
    let id = format!("session-{}", *next_id);
    *next_id += 1;

    let session = PtySession {
        writer: None,
        master: None,
        child: None,
    };
    state.sessions.lock().unwrap().insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub fn spawn_claude(
    session_id: String,
    cwd: String,
    api_key: Option<String>,
    mcp_config_path: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    // Kill existing process in this session if any
    kill_session_inner(&state, &session_id);

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let claude_bin = find_claude_path()
        .unwrap_or_else(|| "claude".to_string());
    let mut cmd = CommandBuilder::new(claude_bin);
    if let Some(ref config_path) = mcp_config_path {
        cmd.arg("--mcp-config");
        cmd.arg(config_path);
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    if let Some(ref key) = api_key {
        cmd.env("ANTHROPIC_API_KEY", key);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    // Store handles in session
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.writer = Some(writer);
            session.master = Some(pair.master);
            session.child = Some(child);
        } else {
            return Err(format!("Session {session_id} not found"));
        }
    }

    // Spawn reader thread to relay PTY output to frontend
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app.emit("pty:exit", PtyExitPayload { session_id: sid });
                    break;
                }
                Ok(n) => {
                    let encoded = BASE64.encode(&buf[..n]);
                    let _ = app.emit(
                        "pty:data",
                        PtyDataPayload {
                            session_id: sid.clone(),
                            data: encoded,
                        },
                    );
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(
    session_id: String,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let decoded = BASE64.decode(&data).map_err(|e| e.to_string())?;
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        if let Some(ref mut writer) = session.writer {
            writer
                .write_all(&decoded)
                .map_err(|e: std::io::Error| e.to_string())?;
            writer
                .flush()
                .map_err(|e: std::io::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        if let Some(ref pty) = session.master {
            pty.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn kill_pty(session_id: String, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    kill_session_inner(&state, &session_id);
    // Remove session from map
    state.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

fn kill_session_inner(state: &PtyState, session_id: &str) {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(session_id) {
        // Drop writer and master first to close the PTY
        let _ = session.writer.take();
        let _ = session.master.take();
        // Then kill the child process
        if let Some(mut child) = session.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Kill all sessions (used on window destroy).
pub fn kill_all_sessions(state: tauri::State<'_, PtyState>) {
    let mut sessions = state.sessions.lock().unwrap();
    for (_, session) in sessions.iter_mut() {
        let _ = session.writer.take();
        let _ = session.master.take();
        if let Some(mut child) = session.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    sessions.clear();
}

/// Write a temporary MCP config JSON file and return its path.
#[tauri::command]
pub fn write_mcp_config(config_json: String) -> Result<String, String> {
    let dir = std::env::temp_dir().join("markupsidedown");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("mcp-config.json");
    std::fs::write(&path, config_json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
