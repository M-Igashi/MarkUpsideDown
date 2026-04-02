use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{self, EditorStates};
use crate::error::AppError;

const PORT_RANGE_START: u16 = 31415;
const PORT_RANGE_END: u16 = 31420;

struct BridgeState {
    editor: Arc<EditorStates>,
    app: AppHandle,
    http: reqwest::Client,
}

impl BridgeState {
    /// Emit an event to the focused window, or broadcast if no window is focused.
    fn emit_to_focused<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(label) = self.editor.get_focused_label() {
            if let Some(win) = self.app.webview_windows().get(&label) {
                let _ = win.emit(event, payload);
                return;
            }
        }
        // Fallback: broadcast to all windows
        let _ = self.app.emit(event, payload);
    }

    /// Emit an event to a specific window (or focused if None).
    #[allow(dead_code)]
    fn emit_to_window<S: serde::Serialize + Clone>(&self, window: Option<&str>, event: &str, payload: S) {
        if let Some(label) = window {
            if let Some(win) = self.app.webview_windows().get(label) {
                let _ = win.emit(event, payload);
                return;
            }
        }
        self.emit_to_focused(event, payload);
    }

    /// Get state for a specific window, or fall back to focused.
    fn get_state_for(&self, window: Option<&str>) -> Option<commands::EditorStateInner> {
        if let Some(label) = window {
            if let Some(state) = self.editor.get_window_state(label) {
                return Some(state);
            }
        }
        self.editor.get_focused_state()
    }

    /// Get root path for a specific window, or fall back to focused.
    fn get_root_for(&self, window: Option<&str>) -> Option<String> {
        self.get_state_for(window).and_then(|s| s.root_path)
    }
}

fn port_file_path() -> PathBuf {
    crate::util::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".markupsidedown-bridge-port")
}

pub fn start(app: AppHandle, editor_state: Arc<EditorStates>) {
    let port = find_available_port().expect("No available port for MCP bridge");
    std::fs::write(port_file_path(), port.to_string()).ok();

    let http: reqwest::Client = app.state::<reqwest::Client>().inner().clone();
    let state = Arc::new(BridgeState {
        editor: editor_state,
        app,
        http,
    });

    let router = Router::new()
        .route("/health", get(health))
        .route("/windows", get(get_windows))
        .route("/editor/content", get(get_content).post(set_content))
        .route("/editor/insert", post(insert_text))
        .route("/editor/state", get(get_state))
        .route("/editor/open-file", post(open_file))
        .route("/editor/save-file", post(save_file))
        .route("/editor/structure", get(get_structure))
        .route("/editor/normalize", post(normalize_document))
        .route("/editor/lint", get(get_lint))
        .route("/editor/tabs", get(get_tabs))
        .route("/editor/root", get(get_root))
        .route("/editor/dirty-files", get(get_dirty_files))
        .route("/editor/switch-tab", post(switch_tab))
        .route("/files/list", get(list_files))
        .route("/files/read", get(read_file))
        .route("/files/search", get(search_files))
        .route("/files/create", post(create_file))
        .route("/files/create-directory", post(create_directory))
        .route("/files/rename", post(rename_entry))
        .route("/files/delete", post(delete_entry))
        .route("/git/status", get(git_status))
        .route("/git/stage", post(git_stage))
        .route("/git/unstage", post(git_unstage))
        .route("/git/commit", post(git_commit))
        .route("/git/push", post(git_push))
        .route("/git/pull", post(git_pull))
        .route("/git/fetch", post(git_fetch))
        .route("/git/diff", get(git_diff))
        .route("/git/discard", post(git_discard))
        .route("/git/discard-all", post(git_discard_all))
        .route("/git/log", get(git_log))
        .route("/git/revert", post(git_revert))
        .route("/files/copy", post(copy_entry))
        .route("/files/duplicate", post(duplicate_entry))
        .route("/crawl/save", post(crawl_save))
        .route("/content/download-image", post(download_image))
        .route("/content/fetch-title", post(fetch_page_title))
        .route("/tags/list", get(tags_list))
        .route("/tags/set", post(tags_set))
        .route("/git/stage-all", post(git_stage_all))
        .route("/git/show", get(git_show))
        .route("/git/clone", post(git_clone))
        .route("/git/init", post(git_init))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
            .await
            .expect("Failed to bind MCP bridge");
        axum::serve(listener, router).await.ok();
    });

    log::info!("MCP bridge started on port {port}");
}

pub fn cleanup() {
    std::fs::remove_file(port_file_path()).ok();
}

fn find_available_port() -> Option<u16> {
    (PORT_RANGE_START..=PORT_RANGE_END)
        .find(|&port| TcpListener::bind(("127.0.0.1", port)).is_ok())
}

// --- Error helpers ---

/// Trait for converting error types into categorized bridge JSON responses.
trait BridgeError {
    fn to_bridge_json(&self) -> Json<serde_json::Value>;
}

impl BridgeError for AppError {
    fn to_bridge_json(&self) -> Json<serde_json::Value> {
        let error_type = match self {
            AppError::Io(_) => "io",
            AppError::Network(_) => "network",
            AppError::Git(_) => "git",
            AppError::Worker(_) => "worker",
            AppError::Validation(_) => "validation",
            AppError::Store(_) => "store",
            AppError::Wrangler(_) => "wrangler",
            AppError::Task(_) => "task",
        };
        Json(serde_json::json!({
            "error": self.to_string(),
            "error_type": error_type,
        }))
    }
}

impl BridgeError for String {
    fn to_bridge_json(&self) -> Json<serde_json::Value> {
        Json(serde_json::json!({ "error": self, "error_type": "internal" }))
    }
}

fn not_found_json(msg: &str) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "error": msg, "error_type": "not_found" }))
}

// --- Handlers ---

/// Common query parameter for targeting a specific window.
#[derive(Deserialize, Default)]
struct WindowQuery {
    window: Option<String>,
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn get_windows(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let windows: Vec<serde_json::Value> = state
        .editor
        .get_all_windows()
        .into_iter()
        .map(|(label, root)| serde_json::json!({ "label": label, "root": root }))
        .collect();
    let focused = state.editor.get_focused_label();
    Json(serde_json::json!({ "windows": windows, "focused": focused }))
}

async fn get_content(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let content = state
        .get_state_for(wq.window.as_deref())
        .map(|s| s.content)
        .unwrap_or_default();
    Json(serde_json::json!({ "content": content }))
}

#[derive(Deserialize)]
struct SetContentRequest {
    content: String,
}

async fn set_content(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<SetContentRequest>,
) -> StatusCode {
    // Update focused window's state
    if let Some(label) = state.editor.get_focused_label() {
        let mut map = state.editor.map.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = map.get_mut(&label) {
            s.content = body.content.clone();
        }
    }
    state.emit_to_focused("bridge:set-content", &body.content);
    StatusCode::OK
}

#[derive(Deserialize)]
struct InsertTextRequest {
    text: String,
    position: Option<String>, // "cursor", "start", "end"
}

async fn insert_text(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<InsertTextRequest>,
) -> StatusCode {
    #[derive(Serialize)]
    struct InsertPayload {
        text: String,
        position: String,
    }
    let payload = InsertPayload {
        text: body.text,
        position: body.position.unwrap_or_else(|| "end".to_string()),
    };
    state.emit_to_focused("bridge:insert-text", &payload);
    StatusCode::OK
}

#[derive(Serialize)]
struct EditorStateResponse {
    file_path: Option<String>,
    worker_url: Option<String>,
    cursor_pos: usize,
    cursor_line: usize,
    cursor_column: usize,
}

async fn get_state(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<EditorStateResponse> {
    let s = state.get_state_for(wq.window.as_deref()).unwrap_or_default();
    Json(EditorStateResponse {
        file_path: s.file_path,
        worker_url: s.worker_url,
        cursor_pos: s.cursor_pos,
        cursor_line: s.cursor_line,
        cursor_column: s.cursor_column,
    })
}

#[derive(Deserialize)]
struct OpenFileRequest {
    path: String,
}

async fn open_file(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<OpenFileRequest>,
) -> StatusCode {
    state.emit_to_focused("bridge:open-file", &body.path);
    StatusCode::OK
}

#[derive(Deserialize)]
struct SaveFileRequest {
    path: Option<String>,
}

async fn save_file(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<SaveFileRequest>,
) -> StatusCode {
    state.emit_to_focused("bridge:save-file", &body.path);
    StatusCode::OK
}

async fn normalize_document(State(state): State<Arc<BridgeState>>) -> StatusCode {
    state.emit_to_focused("bridge:normalize", ());
    StatusCode::OK
}

async fn get_lint(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let s = state.get_state_for(wq.window.as_deref());
    match s.and_then(|s| s.lint_diagnostics) {
        Some(json_str) => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                Json(serde_json::json!({ "diagnostics": val }))
            } else {
                Json(serde_json::json!({ "diagnostics": [] }))
            }
        }
        None => Json(serde_json::json!({ "diagnostics": [] })),
    }
}

async fn get_structure(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let s = state.get_state_for(wq.window.as_deref());
    match s.and_then(|s| s.document_structure) {
        Some(json_str) => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                Json(val)
            } else {
                not_found_json("Invalid structure data")
            }
        }
        None => not_found_json("No structure data available"),
    }
}

// --- Project context handlers ---

async fn get_tabs(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let tabs: Vec<serde_json::Value> = state
        .get_state_for(wq.window.as_deref())
        .map(|s| {
            s.tabs
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "path": t.path,
                        "name": t.name,
                        "is_dirty": t.is_dirty,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(serde_json::json!({ "tabs": tabs }))
}

async fn get_root(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "root_path": state.get_root_for(wq.window.as_deref()) }))
}

async fn get_dirty_files(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let dirty: Vec<serde_json::Value> = state
        .get_state_for(wq.window.as_deref())
        .map(|s| {
            s.tabs
                .iter()
                .filter(|t| t.is_dirty)
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "path": t.path,
                        "name": t.name,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(serde_json::json!({ "dirty_files": dirty }))
}

#[derive(Deserialize)]
struct SwitchTabRequest {
    path: Option<String>,
    tab_id: Option<String>,
}

async fn switch_tab(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<SwitchTabRequest>,
) -> StatusCode {
    #[derive(Serialize)]
    struct SwitchPayload {
        path: Option<String>,
        tab_id: Option<String>,
    }
    let payload = SwitchPayload {
        path: body.path,
        tab_id: body.tab_id,
    };
    state.emit_to_focused("bridge:switch-tab", &payload);
    StatusCode::OK
}

// --- File system handlers ---

#[derive(Deserialize)]
struct ListFilesQuery {
    path: Option<String>,
    recursive: Option<bool>,
}

async fn list_files(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<ListFilesQuery>,
) -> Json<serde_json::Value> {
    let path = query.path.or_else(|| state.editor.get_focused_root_path());
    let Some(path) = path else {
        return not_found_json("No path specified and no project root available");
    };

    if query.recursive.unwrap_or(false) {
        match list_recursive(&path).await {
            Ok(entries) => Json(serde_json::json!({ "entries": entries })),
            Err(e) => e.to_bridge_json(),
        }
    } else {
        match commands::list_directory(path.clone()).await {
            Ok(entries) => Json(serde_json::json!({ "entries": entries })),
            Err(e) => e.to_bridge_json(),
        }
    }
}

/// Walk a directory tree recursively, filtering hidden files and git-ignored entries.
/// Limits: max 20 levels deep, max 10 000 entries, skips `.git/`.
async fn list_recursive(root: &str) -> Result<Vec<commands::FileEntry>, String> {
    const MAX_DEPTH: usize = 20;
    const MAX_ENTRIES: usize = 10_000;

    let mut result = Vec::new();
    // (path, depth)
    let mut stack: Vec<(String, usize)> = vec![(root.to_string(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        let entries = commands::list_directory(dir)
            .await
            .map_err(|e| e.to_string())?;
        for entry in entries {
            if entry.is_dir {
                let name = entry.name.as_str();
                if name == ".git" || name == "__pycache__" {
                    continue;
                }
                if depth < MAX_DEPTH {
                    stack.push((entry.path.clone(), depth + 1));
                }
            }
            result.push(entry);
            if result.len() >= MAX_ENTRIES {
                return Ok(result);
            }
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
struct ReadFileQuery {
    path: String,
}

async fn read_file(Query(query): Query<ReadFileQuery>) -> Json<serde_json::Value> {
    match commands::read_text_file(query.path).await {
        Ok(content) => Json(serde_json::json!({ "content": content })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct SearchFilesQuery {
    query: String,
    path: Option<String>,
}

async fn search_files(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<SearchFilesQuery>,
) -> Json<serde_json::Value> {
    let search_path = query.path.or_else(|| state.editor.get_focused_root_path());
    let Some(search_path) = search_path else {
        return not_found_json("No path specified and no project root available");
    };

    // Fast path: use git ls-files for git repos
    if let Some(matches) = git_search_files(&search_path, &query.query).await {
        return Json(serde_json::json!({ "matches": matches }));
    }

    // Fallback: recursive directory walk for non-git directories
    match list_recursive(&search_path).await {
        Ok(entries) => {
            let query_lower = query.query.to_lowercase();
            let matches: Vec<&commands::FileEntry> = entries
                .iter()
                .filter(|e| e.name.to_lowercase().contains(&query_lower))
                .collect();
            Json(serde_json::json!({ "matches": matches }))
        }
        Err(e) => e.to_bridge_json(),
    }
}

/// Fast file name search using `git ls-files` for git repositories.
/// Returns `None` if the path is not a git repo or git fails.
async fn git_search_files(search_path: &str, query: &str) -> Option<Vec<commands::FileEntry>> {
    let git_dir = std::path::Path::new(search_path).join(".git");
    if !git_dir.exists() {
        return None;
    }

    let search_path = search_path.to_string();
    let query = query.to_string();

    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("git")
            .args(["-C", &search_path, "ls-files", "--cached", "--others", "--exclude-standard"])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let query_lower = query.to_lowercase();

        let entries: Vec<commands::FileEntry> = stdout
            .lines()
            .filter(|line| {
                let name = line.rsplit('/').next().unwrap_or(line);
                name.to_lowercase().contains(&query_lower)
            })
            .map(|line| {
                let full_path = format!("{search_path}/{line}");
                let name = line.rsplit('/').next().unwrap_or(line).to_string();
                let extension = std::path::Path::new(line)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_string());
                commands::FileEntry {
                    name,
                    path: full_path,
                    is_dir: false,
                    extension,
                    modified_at: None,
                }
            })
            .collect();

        Some(entries)
    })
    .await
    .ok()
    .flatten()
}

// --- File mutation handlers ---

#[derive(Deserialize)]
struct CreateFileRequest {
    path: String,
}

async fn create_file(Json(body): Json<CreateFileRequest>) -> Json<serde_json::Value> {
    match commands::create_file(body.path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct CreateDirectoryRequest {
    path: String,
}

async fn create_directory(Json(body): Json<CreateDirectoryRequest>) -> Json<serde_json::Value> {
    match commands::create_directory(body.path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct RenameEntryRequest {
    from: String,
    to: String,
}

async fn rename_entry(Json(body): Json<RenameEntryRequest>) -> Json<serde_json::Value> {
    match commands::rename_entry(body.from, body.to).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct DeleteEntryRequest {
    path: String,
    is_dir: Option<bool>,
}

async fn delete_entry(Json(body): Json<DeleteEntryRequest>) -> Json<serde_json::Value> {
    match commands::delete_entry(body.path, body.is_dir.unwrap_or(false)).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

// --- Git handlers ---

async fn git_status(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let Some(repo_path) = state.editor.get_focused_root_path() else {
        return not_found_json("No project root available");
    };

    match commands::git_status(repo_path).await {
        Ok(status) => Json(serde_json::json!(status)),
        Err(e) => e.to_bridge_json(),
    }
}

fn get_repo_path(state: &BridgeState) -> Result<String, Json<serde_json::Value>> {
    state
        .editor
        .get_focused_root_path()
        .ok_or_else(|| not_found_json("No project root available"))
}

#[derive(Deserialize)]
struct GitFileRequest {
    path: String,
}

async fn git_stage(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitFileRequest>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_stage(repo_path, body.path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

async fn git_unstage(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitFileRequest>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_unstage(repo_path, body.path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct GitCommitRequest {
    message: String,
}

async fn git_commit(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitCommitRequest>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_commit(repo_path, body.message).await {
        Ok(output) => Json(serde_json::json!({ "output": output })),
        Err(e) => e.to_bridge_json(),
    }
}

async fn git_remote_op(
    _state: &BridgeState,
    op: impl std::future::Future<Output = crate::error::Result<String>>,
) -> Json<serde_json::Value> {
    match op.await {
        Ok(output) => Json(serde_json::json!({ "output": output })),
        Err(e) => e.to_bridge_json(),
    }
}

async fn git_push(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    git_remote_op(&state, commands::git_push(repo_path)).await
}

async fn git_pull(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    git_remote_op(&state, commands::git_pull(repo_path)).await
}

async fn git_fetch(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    git_remote_op(&state, commands::git_fetch(repo_path)).await
}

// --- Git diff/discard/log/revert handlers ---

#[derive(Deserialize)]
struct GitDiffQuery {
    path: String,
    staged: Option<bool>,
}

async fn git_diff(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitDiffQuery>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_diff(repo_path, query.path, query.staged.unwrap_or(false)).await {
        Ok(diff) => Json(serde_json::json!({ "diff": diff })),
        Err(e) => e.to_bridge_json(),
    }
}

async fn git_discard(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitFileRequest>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_discard(repo_path, body.path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

async fn git_discard_all(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_discard_all(repo_path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct GitLogQuery {
    limit: Option<u32>,
}

async fn git_log(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitLogQuery>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_log(repo_path, query.limit).await {
        Ok(entries) => Json(serde_json::json!({ "entries": entries })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct GitRevertRequest {
    commit_hash: String,
}

async fn git_revert(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitRevertRequest>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_revert(repo_path, body.commit_hash).await {
        Ok(output) => Json(serde_json::json!({ "output": output })),
        Err(e) => e.to_bridge_json(),
    }
}

// --- File copy/duplicate handlers ---

#[derive(Deserialize)]
struct CopyEntryRequest {
    from: String,
    to_dir: String,
}

async fn copy_entry(Json(body): Json<CopyEntryRequest>) -> Json<serde_json::Value> {
    match commands::copy_entry(body.from, body.to_dir).await {
        Ok(dest) => Json(serde_json::json!({ "path": dest })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct DuplicateEntryRequest {
    path: String,
}

async fn duplicate_entry(Json(body): Json<DuplicateEntryRequest>) -> Json<serde_json::Value> {
    match commands::duplicate_entry(body.path).await {
        Ok(dest) => Json(serde_json::json!({ "path": dest })),
        Err(e) => e.to_bridge_json(),
    }
}

// --- Crawl save handler ---

async fn crawl_save(Json(body): Json<CrawlSaveRequest>) -> Json<serde_json::Value> {
    match commands::crawl_save(body.pages, body.base_dir).await {
        Ok(result) => Json(serde_json::json!({
            "saved_count": result.saved_count,
            "base_dir": result.base_dir,
        })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct CrawlSaveRequest {
    pages: Vec<commands::CrawlPage>,
    base_dir: String,
}

// --- Content & asset handlers ---

#[derive(Deserialize)]
struct DownloadImageRequest {
    url: String,
    dest_path: String,
}

async fn download_image(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<DownloadImageRequest>,
) -> Json<serde_json::Value> {
    match commands::download_image_with(&state.http, &body.url, &body.dest_path).await {
        Ok(path) => Json(serde_json::json!({ "path": path })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct FetchTitleRequest {
    url: String,
}

async fn fetch_page_title(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<FetchTitleRequest>,
) -> Json<serde_json::Value> {
    match commands::fetch_page_title_with(&state.http, &body.url).await {
        Ok(title) => Json(serde_json::json!({ "title": title })),
        Err(e) => e.to_bridge_json(),
    }
}

// --- Tag handlers ---

fn tags_file_path(root: &str) -> String {
    format!("{root}/.markupsidedown/tags.json")
}

async fn read_tags(root: &str) -> serde_json::Value {
    let path = tags_file_path(root);
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or(serde_json::json!({ "tags": {}, "files": {} })),
        Err(_) => serde_json::json!({ "tags": {}, "files": {} }),
    }
}

async fn write_tags(root: &str, data: &serde_json::Value) -> Result<(), String> {
    let dir = format!("{root}/.markupsidedown");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))?;
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    tokio::fs::write(tags_file_path(root), json)
        .await
        .map_err(|e| format!("Failed to write tags: {e}"))
}

async fn tags_list(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let Some(root) = state.editor.get_focused_root_path() else {
        return not_found_json("No project root available");
    };
    Json(read_tags(&root).await)
}

#[derive(Deserialize)]
struct TagsSetRequest {
    tags: serde_json::Value,
}

async fn tags_set(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<TagsSetRequest>,
) -> Json<serde_json::Value> {
    let Some(root) = state.editor.get_focused_root_path() else {
        return not_found_json("No project root available");
    };
    match write_tags(&root, &body.tags).await {
        Ok(()) => {
            state.emit_to_focused("bridge:tags-changed", ());
            Json(serde_json::json!({ "ok": true }))
        }
        Err(e) => e.to_bridge_json(),
    }
}

// --- Git extended handlers ---

async fn git_stage_all(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_stage_all(repo_path).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct GitShowQuery {
    commit_hash: String,
}

async fn git_show(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitShowQuery>,
) -> Json<serde_json::Value> {
    let repo_path = match get_repo_path(&state) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match commands::git_show(repo_path, query.commit_hash).await {
        Ok(output) => Json(serde_json::json!({ "output": output })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct GitCloneRequest {
    url: String,
    dest: String,
}

async fn git_clone(Json(body): Json<GitCloneRequest>) -> Json<serde_json::Value> {
    match commands::git_clone(body.url, body.dest).await {
        Ok(output) => Json(serde_json::json!({ "output": output })),
        Err(e) => e.to_bridge_json(),
    }
}

#[derive(Deserialize)]
struct GitInitRequest {
    path: String,
}

async fn git_init(Json(body): Json<GitInitRequest>) -> Json<serde_json::Value> {
    match commands::git_init(body.path).await {
        Ok(output) => Json(serde_json::json!({ "output": output })),
        Err(e) => e.to_bridge_json(),
    }
}

