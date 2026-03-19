use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::{self, EditorState};

const PORT_RANGE_START: u16 = 31415;
const PORT_RANGE_END: u16 = 31420;

struct BridgeState {
    editor: Arc<EditorState>,
    app: AppHandle,
}

fn port_file_path() -> PathBuf {
    crate::util::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".markupsidedown-bridge-port")
}

pub fn start(app: AppHandle, editor_state: Arc<EditorState>) {
    let port = find_available_port().expect("No available port for MCP bridge");
    std::fs::write(port_file_path(), port.to_string()).ok();

    let state = Arc::new(BridgeState {
        editor: editor_state,
        app,
    });

    let router = Router::new()
        .route("/health", get(health))
        .route("/editor/content", get(get_content).post(set_content))
        .route("/editor/insert", post(insert_text))
        .route("/editor/state", get(get_state))
        .route("/editor/open-file", post(open_file))
        .route("/editor/save-file", post(save_file))
        .route("/editor/export-pdf", post(export_pdf))
        .route("/editor/structure", get(get_structure))
        .route("/editor/normalize", post(normalize_document))
        .route("/editor/tabs", get(get_tabs))
        .route("/editor/root", get(get_root))
        .route("/editor/dirty-files", get(get_dirty_files))
        .route("/editor/switch-tab", post(switch_tab))
        .route("/files/list", get(list_files))
        .route("/files/read", get(read_file))
        .route("/files/search", get(search_files))
        .route("/git/status", get(git_status))
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

// --- Handlers ---

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn get_content(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let content = state.editor.inner.lock().unwrap().content.clone();
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
    state.editor.inner.lock().unwrap().content = body.content.clone();
    state.app.emit("bridge:set-content", &body.content).ok();
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
    state.app.emit("bridge:insert-text", &payload).ok();
    StatusCode::OK
}

#[derive(Serialize)]
struct EditorStateResponse {
    file_path: Option<String>,
    worker_url: Option<String>,
    cursor_pos: usize,
}

async fn get_state(State(state): State<Arc<BridgeState>>) -> Json<EditorStateResponse> {
    let s = state.editor.inner.lock().unwrap();
    Json(EditorStateResponse {
        file_path: s.file_path.clone(),
        worker_url: s.worker_url.clone(),
        cursor_pos: s.cursor_pos,
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
    state.app.emit("bridge:open-file", &body.path).ok();
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
    state.app.emit("bridge:save-file", &body.path).ok();
    StatusCode::OK
}

async fn export_pdf(State(state): State<Arc<BridgeState>>) -> StatusCode {
    state.app.emit("bridge:export-pdf", ()).ok();
    StatusCode::OK
}

async fn normalize_document(State(state): State<Arc<BridgeState>>) -> StatusCode {
    state.app.emit("bridge:normalize", ()).ok();
    StatusCode::OK
}

async fn get_structure(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let s = state.editor.inner.lock().unwrap();
    match &s.document_structure {
        Some(json_str) => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                Json(val)
            } else {
                Json(serde_json::json!({ "error": "Invalid structure data" }))
            }
        }
        None => Json(serde_json::json!({ "error": "No structure data available" })),
    }
}

// --- Project context handlers ---

async fn get_tabs(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let s = state.editor.inner.lock().unwrap();
    let tabs: Vec<serde_json::Value> = s
        .tabs
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "path": t.path,
                "name": t.name,
                "is_dirty": t.is_dirty,
            })
        })
        .collect();
    Json(serde_json::json!({ "tabs": tabs }))
}

async fn get_root(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let s = state.editor.inner.lock().unwrap();
    Json(serde_json::json!({ "root_path": s.root_path }))
}

async fn get_dirty_files(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let s = state.editor.inner.lock().unwrap();
    let dirty: Vec<serde_json::Value> = s
        .tabs
        .iter()
        .filter(|t| t.is_dirty)
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "path": t.path,
                "name": t.name,
            })
        })
        .collect();
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
    state.app.emit("bridge:switch-tab", &payload).ok();
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
    let root_path = state.editor.inner.lock().unwrap().root_path.clone();
    let path = query.path.or(root_path);
    let Some(path) = path else {
        return Json(serde_json::json!({ "error": "No path specified and no project root available" }));
    };

    if query.recursive.unwrap_or(false) {
        match list_recursive(&path).await {
            Ok(entries) => Json(serde_json::json!({ "entries": entries })),
            Err(e) => Json(serde_json::json!({ "error": e })),
        }
    } else {
        match commands::list_directory(path.clone(), root_path_for_gitignore(&path)).await {
            Ok(entries) => Json(serde_json::json!({ "entries": entries })),
            Err(e) => Json(serde_json::json!({ "error": e })),
        }
    }
}

/// Walk a directory tree recursively, filtering hidden files and git-ignored entries.
async fn list_recursive(root: &str) -> Result<Vec<commands::FileEntry>, String> {
    let mut result = Vec::new();
    let mut stack = vec![root.to_string()];
    let repo_root = root_path_for_gitignore(root);

    while let Some(dir) = stack.pop() {
        let entries = commands::list_directory(dir, repo_root.clone()).await?;
        for entry in entries {
            if entry.is_dir {
                stack.push(entry.path.clone());
            }
            result.push(entry);
        }
    }
    Ok(result)
}

/// Detect git repo root for gitignore filtering.
fn root_path_for_gitignore(path: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(path)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

#[derive(Deserialize)]
struct ReadFileQuery {
    path: String,
}

async fn read_file(Query(query): Query<ReadFileQuery>) -> Json<serde_json::Value> {
    match commands::read_text_file(query.path).await {
        Ok(content) => Json(serde_json::json!({ "content": content })),
        Err(e) => Json(serde_json::json!({ "error": e })),
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
    let root_path = state.editor.inner.lock().unwrap().root_path.clone();
    let search_path = query.path.or(root_path);
    let Some(search_path) = search_path else {
        return Json(serde_json::json!({ "error": "No path specified and no project root available" }));
    };

    match list_recursive(&search_path).await {
        Ok(entries) => {
            let query_lower = query.query.to_lowercase();
            let matches: Vec<&commands::FileEntry> = entries
                .iter()
                .filter(|e| e.name.to_lowercase().contains(&query_lower))
                .collect();
            Json(serde_json::json!({ "matches": matches }))
        }
        Err(e) => Json(serde_json::json!({ "error": e })),
    }
}

// --- Git handler ---

async fn git_status(State(state): State<Arc<BridgeState>>) -> Json<serde_json::Value> {
    let root_path = state.editor.inner.lock().unwrap().root_path.clone();
    let Some(repo_path) = root_path else {
        return Json(serde_json::json!({ "error": "No project root available" }));
    };

    match commands::git_status(repo_path).await {
        Ok(status) => Json(serde_json::json!(status)),
        Err(e) => Json(serde_json::json!({ "error": e })),
    }
}
