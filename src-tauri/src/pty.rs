use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct PtyState {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn portable_pty::Child + Send>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            writer: Mutex::new(None),
            master: Mutex::new(None),
            child: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub fn check_claude_installed() -> Result<bool, String> {
    let output = std::process::Command::new("which")
        .arg("claude")
        .output()
        .map_err(|e| e.to_string())?;
    Ok(output.status.success())
}

#[tauri::command]
pub fn spawn_claude(
    cwd: String,
    api_key: Option<String>,
    mcp_config_path: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    // Kill existing session if any
    kill_pty_inner(&state);

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new("claude");
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

    // Take writer and clone reader from master
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    // Store handles
    *state.writer.lock().unwrap() = Some(writer);
    *state.master.lock().unwrap() = Some(pair.master);
    *state.child.lock().unwrap() = Some(child);

    // Spawn reader thread to relay PTY output to frontend
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app.emit("pty:exit", ());
                    break;
                }
                Ok(n) => {
                    let encoded = BASE64.encode(&buf[..n]);
                    let _ = app.emit("pty:data", encoded);
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(data: String, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let decoded = BASE64.decode(&data).map_err(|e| e.to_string())?;
    let mut writer_guard = state.writer.lock().unwrap();
    if let Some(ref mut writer) = *writer_guard {
        writer
            .write_all(&decoded)
            .map_err(|e: std::io::Error| e.to_string())?;
        writer
            .flush()
            .map_err(|e: std::io::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(cols: u16, rows: u16, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let master = state.master.lock().unwrap();
    if let Some(ref pty) = *master {
        pty.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn kill_pty(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    kill_pty_inner(&state);
    Ok(())
}

fn kill_pty_inner(state: &PtyState) {
    // Drop writer and master first to close the PTY
    let _ = state.writer.lock().unwrap().take();
    let _ = state.master.lock().unwrap().take();
    // Then kill the child process
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
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
