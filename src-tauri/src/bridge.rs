use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::EditorState;

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
