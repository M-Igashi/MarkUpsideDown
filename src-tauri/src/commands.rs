use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;

// --- Shared Editor State (for MCP bridge) ---

#[derive(Default)]
pub struct EditorState {
    pub content: Mutex<String>,
    pub file_path: Mutex<Option<String>>,
    pub cursor_pos: Mutex<usize>,
    pub worker_url: Mutex<Option<String>>,
}

#[tauri::command]
pub fn sync_editor_state(
    content: String,
    file_path: Option<String>,
    cursor_pos: Option<usize>,
    worker_url: Option<String>,
    state: tauri::State<'_, std::sync::Arc<EditorState>>,
) -> Result<(), String> {
    *state.content.lock().unwrap() = content;
    *state.file_path.lock().unwrap() = file_path;
    if let Some(pos) = cursor_pos {
        *state.cursor_pos.lock().unwrap() = pos;
    }
    *state.worker_url.lock().unwrap() = worker_url;
    Ok(())
}

// --- Cloudflare Markdown for Agents ---

#[derive(Serialize)]
pub struct MarkdownResponse {
    pub body: String,
    pub token_count: Option<u64>,
    pub is_markdown: bool,
}

#[tauri::command]
pub async fn fetch_url_as_markdown(url: String) -> Result<MarkdownResponse, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Accept", "text/markdown")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let token_count = response
        .headers()
        .get("x-markdown-tokens")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let body = response.text().await.map_err(|e| e.to_string())?;

    Ok(MarkdownResponse {
        body,
        token_count,
        is_markdown: content_type.contains("text/markdown"),
    })
}

// --- Browser Rendering (JS-rendered pages) ---

#[derive(Deserialize)]
struct RenderWorkerResponse {
    markdown: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn fetch_rendered_url_as_markdown(
    url: String,
    worker_url: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&url));

    let response = client
        .get(&render_url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body: RenderWorkerResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(body.error.unwrap_or_else(|| format!("Worker returned {status}")));
    }

    body.markdown.ok_or_else(|| "No markdown in response".to_string())
}

// --- Document to Markdown via Workers AI ---

#[derive(Deserialize)]
struct ConvertWorkerResponse {
    markdown: Option<String>,
    is_image: Option<bool>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct ConvertResponse {
    pub markdown: String,
    pub is_image: bool,
}

#[tauri::command]
pub async fn convert_file_to_markdown(
    file_path: String,
    worker_url: String,
) -> Result<ConvertResponse, String> {
    let path = std::path::Path::new(&file_path);
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;

    let mime_type = mime_from_extension(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or(""),
    )
    .ok_or_else(|| format!("Unsupported file extension: {}", file_path))?;

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{worker_url}/convert"))
        .header("Content-Type", mime_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body: ConvertWorkerResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(body.error.unwrap_or_else(|| format!("Worker returned {status}")));
    }

    Ok(ConvertResponse {
        markdown: body.markdown.unwrap_or_default(),
        is_image: body.is_image.unwrap_or(false),
    })
}

#[tauri::command]
pub fn detect_file_is_image(file_path: String) -> Result<bool, String> {
    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    Ok(matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "tif"
    ))
}

fn mime_from_extension(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "html" | "htm" => Some("text/html"),
        "csv" => Some("text/csv"),
        "xml" => Some("application/xml"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        _ => None,
    }
}

// --- GitHub via gh CLI ---

#[tauri::command]
pub async fn github_fetch_issue(owner: String, repo: String, number: u64) -> Result<String, String> {
    let output = Command::new("gh")
        .args(["issue", "view", &number.to_string()])
        .args(["--repo", &format!("{owner}/{repo}")])
        .args(["--json", "body"])
        .args(["--jq", ".body"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn github_fetch_pr(owner: String, repo: String, number: u64) -> Result<String, String> {
    let output = Command::new("gh")
        .args(["pr", "view", &number.to_string()])
        .args(["--repo", &format!("{owner}/{repo}")])
        .args(["--json", "body"])
        .args(["--jq", ".body"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn github_list_repos() -> Result<Vec<String>, String> {
    let output = Command::new("gh")
        .args(["repo", "list", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let repos = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(repos)
}
