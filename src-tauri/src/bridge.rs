use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
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
    fn emit_to_focused<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        crate::util::emit_to_focused(&self.app, event, payload);
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
        .route("/worker", get(get_worker))
        .route("/editor/open-file", post(open_file))
        .route("/editor/save-file", post(save_file))
        .route("/editor/structure", get(get_structure))
        .route("/editor/normalize", post(normalize_document))
        .route("/editor/lint", get(get_lint))
        .route("/editor/tabs", get(get_tabs))
        .route("/editor/root", get(get_root))
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
        .route("/github/status", get(github_status))
        .route("/github/list", get(github_list))
        .route("/github/view", get(github_view))
        .route("/github/update", post(github_update))
        // crawl_save and set_editor_content can exceed axum's 2 MB default
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
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

/// Error body `{ "error": msg }` with 200 OK, since the MCP client checks the
/// `error` field. Pair it with a `StatusCode` to send another status.
struct BridgeError(String);

impl From<AppError> for BridgeError {
    fn from(e: AppError) -> Self {
        Self(e.to_string())
    }
}

impl From<&str> for BridgeError {
    fn from(msg: &str) -> Self {
        Self(msg.to_string())
    }
}

impl IntoResponse for BridgeError {
    fn into_response(self) -> Response {
        Json(serde_json::json!({ "error": self.0 })).into_response()
    }
}

type BridgeResult = Result<Json<serde_json::Value>, BridgeError>;

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
        .editor
        .with_state(wq.window.as_deref(), |s| s.content.clone())
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

#[derive(Serialize, Default)]
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
    let resp = state
        .editor
        .with_state(wq.window.as_deref(), |s| EditorStateResponse {
            file_path: s.file_path.clone(),
            worker_url: s.worker_url.clone(),
            cursor_pos: s.cursor_pos,
            cursor_line: s.cursor_line,
            cursor_column: s.cursor_column,
        })
        .unwrap_or_default();
    Json(resp)
}

/// Worker URL and API key for the MCP server. Kept out of /editor/state so the
/// key never appears in `get_editor_state` tool output.
#[derive(Serialize, Default)]
struct WorkerConfigResponse {
    url: Option<String>,
    key: Option<String>,
}

async fn get_worker(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<WorkerConfigResponse> {
    let resp = state
        .editor
        .with_state(wq.window.as_deref(), |s| WorkerConfigResponse {
            url: s.worker_url.clone(),
            key: s.worker_key.clone(),
        })
        .unwrap_or_default();
    Json(resp)
}

#[derive(Deserialize)]
struct OpenFileRequest {
    path: String,
}

async fn open_file(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<OpenFileRequest>,
) -> Result<StatusCode, (StatusCode, BridgeError)> {
    commands::validate_path(&body.path)
        .map_err(|e| (StatusCode::BAD_REQUEST, BridgeError::from(e)))?;
    state.emit_to_focused("bridge:open-file", &body.path);
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
struct SaveFileRequest {
    path: Option<String>,
}

async fn save_file(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<SaveFileRequest>,
) -> Result<StatusCode, (StatusCode, BridgeError)> {
    if let Some(ref path) = body.path {
        commands::validate_path(path)
            .map_err(|e| (StatusCode::BAD_REQUEST, BridgeError::from(e)))?;
    }
    state.emit_to_focused("bridge:save-file", &body.path);
    Ok(StatusCode::OK)
}

async fn normalize_document(State(state): State<Arc<BridgeState>>) -> StatusCode {
    state.emit_to_focused("bridge:normalize", ());
    StatusCode::OK
}

async fn get_lint(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let s = state
        .editor
        .with_state(wq.window.as_deref(), |s| s.lint_diagnostics.clone());
    match s.flatten() {
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
) -> BridgeResult {
    let json_str = state
        .editor
        .with_state(wq.window.as_deref(), |s| s.document_structure.clone())
        .flatten()
        .ok_or("No structure data available")?;
    let val = serde_json::from_str(&json_str).map_err(|_| "Invalid structure data")?;
    Ok(Json(val))
}

// --- Project context handlers ---

async fn get_tabs(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let tabs = state
        .editor
        .with_state(wq.window.as_deref(), |s| s.tabs.clone())
        .unwrap_or_default();
    Json(serde_json::json!({ "tabs": tabs }))
}

async fn get_root(
    State(state): State<Arc<BridgeState>>,
    Query(wq): Query<WindowQuery>,
) -> Json<serde_json::Value> {
    let root_path = state
        .editor
        .with_state(wq.window.as_deref(), |s| s.root_path.clone())
        .flatten();
    Json(serde_json::json!({ "root_path": root_path }))
}

#[derive(Deserialize, Serialize)]
struct SwitchTabRequest {
    path: Option<String>,
    tab_id: Option<String>,
}

async fn switch_tab(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<SwitchTabRequest>,
) -> StatusCode {
    state.emit_to_focused("bridge:switch-tab", &body);
    StatusCode::OK
}

// --- File system handlers ---

/// Use the given path, or the focused project root, once it passes validation.
fn resolve_path(state: &BridgeState, path: Option<String>) -> Result<String, BridgeError> {
    let path = path
        .or_else(|| state.editor.get_focused_root_path())
        .ok_or("No path specified and no project root available")?;
    commands::validate_path(&path)?;
    Ok(path)
}

#[derive(Deserialize)]
struct ListFilesQuery {
    path: Option<String>,
    recursive: Option<bool>,
}

async fn list_files(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<ListFilesQuery>,
) -> BridgeResult {
    let path = resolve_path(&state, query.path)?;
    let entries = if query.recursive.unwrap_or(false) {
        commands::list_recursive(&path).await?
    } else {
        commands::list_directory(path, None).await?
    };
    Ok(Json(serde_json::json!({ "entries": entries })))
}

#[derive(Deserialize)]
struct ReadFileQuery {
    path: String,
}

async fn read_file(Query(query): Query<ReadFileQuery>) -> BridgeResult {
    // Bridge callers never go through a file dialog, so confine reads to the
    // home directory like every other bridge file endpoint.
    let path = commands::validate_path(&query.path)?;
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Io(format!("Failed to read file: {e}")))?;
    Ok(Json(serde_json::json!({ "content": content })))
}

#[derive(Deserialize)]
struct SearchFilesQuery {
    query: String,
    path: Option<String>,
}

async fn search_files(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<SearchFilesQuery>,
) -> BridgeResult {
    let search_path = resolve_path(&state, query.path)?;

    // Fast path: use git ls-files for git repos
    if let Some(matches) = git_search_files(&search_path, &query.query).await {
        return Ok(Json(serde_json::json!({ "matches": matches })));
    }

    // Fallback: recursive directory walk for non-git directories
    let entries = commands::list_recursive(&search_path).await?;
    let query_lower = query.query.to_lowercase();
    let matches: Vec<&commands::FileEntry> = entries
        .iter()
        .filter(|e| e.name.to_lowercase().contains(&query_lower))
        .collect();
    Ok(Json(serde_json::json!({ "matches": matches })))
}

/// Fast file name search using `git ls-files` for git repositories.
/// Returns `None` if the path is not a git repo or git fails.
async fn git_search_files(search_path: &str, query: &str) -> Option<Vec<commands::FileEntry>> {
    // Validate path to prevent path traversal before any filesystem access
    let validated = commands::validate_path(search_path).ok()?;
    if !validated.join(".git").exists() {
        return None;
    }

    let search_path_str = validated.to_string_lossy().to_string();
    let query = query.to_string();

    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("git")
            .args(["-C", &search_path_str, "ls-files", "--cached", "--others", "--exclude-standard"])
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
                let full_path = format!("{search_path_str}/{line}");
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
                    fold_chain: None,
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

async fn create_file(Json(body): Json<CreateFileRequest>) -> BridgeResult {
    commands::create_file(body.path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct CreateDirectoryRequest {
    path: String,
}

async fn create_directory(Json(body): Json<CreateDirectoryRequest>) -> BridgeResult {
    commands::create_directory(body.path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RenameEntryRequest {
    from: String,
    to: String,
}

async fn rename_entry(Json(body): Json<RenameEntryRequest>) -> BridgeResult {
    commands::rename_entry(body.from, body.to).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DeleteEntryRequest {
    path: String,
    is_dir: Option<bool>,
}

async fn delete_entry(Json(body): Json<DeleteEntryRequest>) -> BridgeResult {
    commands::delete_entry(body.path, body.is_dir.unwrap_or(false)).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- Git handlers ---

fn get_repo_path(state: &BridgeState) -> Result<String, BridgeError> {
    state
        .editor
        .get_focused_root_path()
        .ok_or_else(|| "No project root available".into())
}

/// Respond with `{ "output": … }` for git commands that return CLI output.
async fn output_json(
    op: impl std::future::Future<Output = crate::error::Result<String>>,
) -> BridgeResult {
    Ok(Json(serde_json::json!({ "output": op.await? })))
}

async fn git_status(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    let status = commands::git_status(get_repo_path(&state)?, None).await?;
    Ok(Json(serde_json::json!(status)))
}

#[derive(Deserialize)]
struct GitFileRequest {
    path: String,
}

async fn git_stage(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitFileRequest>,
) -> BridgeResult {
    commands::git_stage(get_repo_path(&state)?, body.path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_unstage(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitFileRequest>,
) -> BridgeResult {
    commands::git_unstage(get_repo_path(&state)?, body.path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct GitCommitRequest {
    message: String,
}

async fn git_commit(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitCommitRequest>,
) -> BridgeResult {
    output_json(commands::git_commit(get_repo_path(&state)?, body.message)).await
}

async fn git_push(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    output_json(commands::git_push(get_repo_path(&state)?)).await
}

async fn git_pull(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    output_json(commands::git_pull(get_repo_path(&state)?)).await
}

async fn git_fetch(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    output_json(commands::git_fetch(get_repo_path(&state)?)).await
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
) -> BridgeResult {
    let repo_path = get_repo_path(&state)?;
    let diff = commands::git_diff(repo_path, query.path, query.staged.unwrap_or(false)).await?;
    Ok(Json(serde_json::json!({ "diff": diff })))
}

async fn git_discard(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitFileRequest>,
) -> BridgeResult {
    commands::git_discard(get_repo_path(&state)?, body.path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_discard_all(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    commands::git_discard_all(get_repo_path(&state)?).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct GitLogQuery {
    limit: Option<u32>,
}

async fn git_log(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitLogQuery>,
) -> BridgeResult {
    let entries = commands::git_log(get_repo_path(&state)?, query.limit).await?;
    Ok(Json(serde_json::json!({ "entries": entries })))
}

// --- GitHub handlers ---

/// Resolve the focused project's `owner/name`, or an error response when the
/// project has no GitHub remote.
async fn get_gh_repo(state: &BridgeState) -> Result<String, BridgeError> {
    commands::gh_repo(get_repo_path(state)?)
        .await?
        .ok_or_else(|| "Project has no GitHub remote".into())
}

async fn github_status(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    let status = commands::gh_status(get_repo_path(&state)?).await?;
    Ok(Json(serde_json::json!(status)))
}

#[derive(Deserialize)]
struct GitHubListQuery {
    kind: Option<String>,
    state: Option<String>,
    limit: Option<u32>,
    search: Option<String>,
}

async fn github_list(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitHubListQuery>,
) -> BridgeResult {
    let repo = get_gh_repo(&state).await?;
    let kind = query.kind.unwrap_or_else(|| "issue".to_string());
    let item_state = query.state.unwrap_or_else(|| "open".to_string());
    let items = commands::gh_list(repo, kind, item_state, query.limit, query.search).await?;
    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Deserialize)]
struct GitHubViewQuery {
    kind: Option<String>,
    number: u64,
}

async fn github_view(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitHubViewQuery>,
) -> BridgeResult {
    let repo = get_gh_repo(&state).await?;
    let kind = query.kind.unwrap_or_else(|| "issue".to_string());
    let detail = commands::gh_view(repo, kind, query.number).await?;
    Ok(Json(serde_json::json!(detail)))
}

#[derive(Deserialize)]
struct GitHubUpdateRequest {
    kind: Option<String>,
    number: u64,
    title: String,
    body: String,
    expected_body: Option<String>,
}

async fn github_update(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitHubUpdateRequest>,
) -> BridgeResult {
    let repo = get_gh_repo(&state).await?;
    let kind = body.kind.unwrap_or_else(|| "issue".to_string());
    let detail = commands::gh_update(
        repo,
        kind,
        body.number,
        body.title,
        body.body,
        body.expected_body,
    )
    .await?;
    Ok(Json(serde_json::json!(detail)))
}

#[derive(Deserialize)]
struct GitRevertRequest {
    commit_hash: String,
}

async fn git_revert(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<GitRevertRequest>,
) -> BridgeResult {
    output_json(commands::git_revert(get_repo_path(&state)?, body.commit_hash)).await
}

// --- File copy/duplicate handlers ---

#[derive(Deserialize)]
struct CopyEntryRequest {
    from: String,
    to_dir: String,
}

async fn copy_entry(Json(body): Json<CopyEntryRequest>) -> BridgeResult {
    let dest = commands::copy_entry(body.from, body.to_dir).await?;
    Ok(Json(serde_json::json!({ "path": dest })))
}

#[derive(Deserialize)]
struct DuplicateEntryRequest {
    path: String,
}

async fn duplicate_entry(Json(body): Json<DuplicateEntryRequest>) -> BridgeResult {
    let dest = commands::duplicate_entry(body.path).await?;
    Ok(Json(serde_json::json!({ "path": dest })))
}

// --- Crawl save handler ---

async fn crawl_save(Json(body): Json<CrawlSaveRequest>) -> BridgeResult {
    let result = commands::crawl_save(body.pages, body.base_dir).await?;
    Ok(Json(serde_json::json!({
        "saved_count": result.saved_count,
        "base_dir": result.base_dir,
    })))
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
) -> BridgeResult {
    let path = commands::download_image_with(&state.http, &body.url, &body.dest_path).await?;
    Ok(Json(serde_json::json!({ "path": path })))
}

#[derive(Deserialize)]
struct FetchTitleRequest {
    url: String,
}

async fn fetch_page_title(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<FetchTitleRequest>,
) -> BridgeResult {
    let title = commands::fetch_page_title_with(&state.http, &body.url).await?;
    Ok(Json(serde_json::json!({ "title": title })))
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

async fn write_tags(root: &str, data: &serde_json::Value) -> crate::error::Result<()> {
    let dir = format!("{root}/.markupsidedown");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;
    let json = serde_json::to_string_pretty(data).map_err(|e| AppError::Io(e.to_string()))?;
    tokio::fs::write(tags_file_path(root), json)
        .await
        .map_err(|e| AppError::Io(format!("Failed to write tags: {e}")))
}

async fn tags_list(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    Ok(Json(read_tags(&get_repo_path(&state)?).await))
}

#[derive(Deserialize)]
struct TagsSetRequest {
    tags: serde_json::Value,
}

async fn tags_set(
    State(state): State<Arc<BridgeState>>,
    Json(body): Json<TagsSetRequest>,
) -> BridgeResult {
    write_tags(&get_repo_path(&state)?, &body.tags).await?;
    // Tags are per project, so every window refreshes its view
    let _ = state.app.emit("bridge:tags-changed", ());
    Ok(Json(serde_json::json!({ "ok": true })))
}

// --- Git extended handlers ---

async fn git_stage_all(State(state): State<Arc<BridgeState>>) -> BridgeResult {
    commands::git_stage_all(get_repo_path(&state)?).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct GitShowQuery {
    commit_hash: String,
}

async fn git_show(
    State(state): State<Arc<BridgeState>>,
    Query(query): Query<GitShowQuery>,
) -> BridgeResult {
    output_json(commands::git_show(get_repo_path(&state)?, query.commit_hash)).await
}

#[derive(Deserialize)]
struct GitCloneRequest {
    url: String,
    dest: String,
}

async fn git_clone(Json(body): Json<GitCloneRequest>) -> BridgeResult {
    output_json(commands::git_clone(body.url, body.dest)).await
}

#[derive(Deserialize)]
struct GitInitRequest {
    path: String,
}

async fn git_init(Json(body): Json<GitInitRequest>) -> BridgeResult {
    output_json(commands::git_init(body.path)).await
}

