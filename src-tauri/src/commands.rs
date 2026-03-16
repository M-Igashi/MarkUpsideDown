use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

// --- Shared Editor State (for MCP bridge) ---

#[derive(Default)]
pub struct EditorStateInner {
    pub content: String,
    pub file_path: Option<String>,
    pub cursor_pos: usize,
    pub worker_url: Option<String>,
}

pub struct EditorState {
    pub inner: Mutex<EditorStateInner>,
}

impl Default for EditorState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(EditorStateInner::default()),
        }
    }
}

#[tauri::command]
pub fn sync_editor_state(
    content: String,
    file_path: Option<String>,
    cursor_pos: Option<usize>,
    worker_url: Option<String>,
    state: tauri::State<'_, std::sync::Arc<EditorState>>,
) -> Result<(), String> {
    let mut s = state.inner.lock().unwrap();
    s.content = content;
    s.file_path = file_path;
    if let Some(pos) = cursor_pos {
        s.cursor_pos = pos;
    }
    s.worker_url = worker_url;
    Ok(())
}

// --- Worker Health Check ---

#[derive(Serialize)]
pub struct WorkerStatus {
    pub reachable: bool,
    pub convert_available: bool,
    pub render_available: bool,
    pub error: Option<String>,
}

impl WorkerStatus {
    fn unreachable(error: String) -> Self {
        Self {
            reachable: false,
            convert_available: false,
            render_available: false,
            error: Some(error),
        }
    }
}

#[derive(Deserialize)]
struct HealthCapabilities {
    convert: Option<bool>,
    render: Option<bool>,
}

#[derive(Deserialize)]
struct HealthResponse {
    #[allow(dead_code)]
    status: Option<String>,
    capabilities: Option<HealthCapabilities>,
}

#[tauri::command]
pub async fn test_worker_url(
    worker_url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<WorkerStatus, String> {
    let health_url = format!("{}/health", worker_url.trim_end_matches('/'));

    Ok(match client.get(&health_url).timeout(Duration::from_secs(10)).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<HealthResponse>().await {
                Ok(body) => {
                    let caps = body.capabilities.unwrap_or(HealthCapabilities {
                        convert: None,
                        render: None,
                    });
                    WorkerStatus {
                        reachable: true,
                        convert_available: caps.convert.unwrap_or(false),
                        render_available: caps.render.unwrap_or(false),
                        error: None,
                    }
                }
                Err(e) => WorkerStatus {
                    reachable: true,
                    convert_available: false,
                    render_available: false,
                    error: Some(format!("Unexpected response format: {e}")),
                }
            }
        }
        Ok(resp) => WorkerStatus {
            reachable: true,
            convert_available: false,
            render_available: false,
            error: Some(format!("Worker returned status {}", resp.status())),
        },
        Err(e) => WorkerStatus::unreachable(format!("Cannot reach worker: {e}")),
    })
}

// --- Cloudflare Markdown for Agents ---

#[derive(Serialize)]
pub struct MarkdownResponse {
    pub body: String,
    pub token_count: Option<u64>,
    pub is_markdown: bool,
}

#[tauri::command]
pub async fn fetch_url_as_markdown(
    url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<MarkdownResponse, String> {
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(30))
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
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String, String> {
    let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&url));

    let response = client
        .get(&render_url)
        .timeout(Duration::from_secs(60))
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
    pub original_size: usize,
}

#[tauri::command]
pub async fn convert_file_to_markdown(
    file_path: String,
    worker_url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<ConvertResponse, String> {
    let path = std::path::Path::new(&file_path);
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("Failed to read file: {e}"))?;
    let original_size = bytes.len();

    let mime_type = mime_from_extension(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or(""),
    )
    .ok_or_else(|| format!("Unsupported file extension: {}", file_path))?;

    let response = client
        .post(format!("{worker_url}/convert"))
        .timeout(Duration::from_secs(120))
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
        original_size,
    })
}

#[tauri::command]
pub fn detect_file_is_image(file_path: String) -> Result<bool, String> {
    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    Ok(mime_from_extension(ext).map_or(false, |m| m.starts_with("image/")))
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

// --- SVG Fetch & Sanitize ---

const MAX_SVG_SIZE: usize = 1_024 * 1_024; // 1 MB

#[tauri::command]
pub async fn fetch_svg(
    url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String, String> {
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch SVG: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !content_type.contains("svg") && !content_type.contains("xml") {
        return Err(format!("Not an SVG (content-type: {content_type})"));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;

    if bytes.len() > MAX_SVG_SIZE {
        return Err(format!(
            "SVG too large ({} bytes, max {})",
            bytes.len(),
            MAX_SVG_SIZE
        ));
    }

    let svg_text = String::from_utf8(bytes.to_vec())
        .map_err(|_| "SVG contains invalid UTF-8".to_string())?;

    Ok(sanitize_svg(&svg_text))
}

fn sanitize_svg(svg: &str) -> String {
    use std::sync::LazyLock;

    static RE_SCRIPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?is)<script[\s>].*?</script>").unwrap());
    static RE_EVENTS: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"(?i)\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)"#).unwrap());
    static RE_JS_HREF: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"(?i)(href\s*=\s*["'])javascript:[^"']*"#).unwrap());

    let result = RE_SCRIPT.replace_all(svg, "");
    let result = RE_EVENTS.replace_all(&result, "");
    let result = RE_JS_HREF.replace_all(&result, "${1}#");

    result.into_owned()
}

// --- File Tree ---

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub extension: Option<String>,
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let path = std::path::Path::new(&path);
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(path)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files/directories
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let extension = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        entries.push(FileEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            extension,
        });
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return Err("File already exists".to_string());
    }
    tokio::fs::write(p, "")
        .await
        .map_err(|e| format!("Failed to create file: {e}"))
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return Err("Directory already exists".to_string());
    }
    tokio::fs::create_dir_all(p)
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))
}

#[tauri::command]
pub async fn rename_entry(from: String, to: String) -> Result<(), String> {
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| format!("Failed to rename: {e}"))
}

#[tauri::command]
pub async fn delete_entry(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        tokio::fs::remove_dir_all(&path)
            .await
            .map_err(|e| format!("Failed to delete directory: {e}"))
    } else {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("Failed to delete file: {e}"))
    }
}

// --- Git Operations ---

fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", repo_path])
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git command failed".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,   // "M", "A", "D", "?", "R", etc.
    pub staged: bool,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub is_repo: bool,
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus, String> {
    let rp = repo_path.clone();
    tokio::task::spawn_blocking(move || {
        // Check if it's a git repo
        if run_git(&rp, &["rev-parse", "--is-inside-work-tree"]).is_err() {
            return Ok(GitStatus {
                branch: String::new(),
                files: Vec::new(),
                is_repo: false,
            });
        }

        // Get branch name
        let branch = run_git(&rp, &["branch", "--show-current"])
            .unwrap_or_default()
            .trim()
            .to_string();

        // Get file statuses with porcelain format
        let output = run_git(&rp, &["status", "--porcelain=v1"])?;
        let mut files = Vec::new();

        for line in output.lines() {
            if line.len() < 4 {
                continue;
            }
            let index_status = line.chars().nth(0).unwrap_or(' ');
            let work_status = line.chars().nth(1).unwrap_or(' ');
            let file_path = line[3..].to_string();

            // Staged changes
            if index_status != ' ' && index_status != '?' {
                files.push(GitFileStatus {
                    path: file_path.clone(),
                    status: index_status.to_string(),
                    staged: true,
                });
            }

            // Unstaged changes
            if work_status != ' ' {
                let status = if index_status == '?' {
                    "?".to_string()
                } else {
                    work_status.to_string()
                };
                files.push(GitFileStatus {
                    path: file_path,
                    status,
                    staged: false,
                });
            }
        }

        Ok(GitStatus {
            branch,
            files,
            is_repo: true,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_stage(repo_path: String, file_path: String) -> Result<(), String> {
    let rp = repo_path;
    let fp = file_path;
    tokio::task::spawn_blocking(move || {
        run_git(&rp, &["add", "--", &fp])?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, file_path: String) -> Result<(), String> {
    let rp = repo_path;
    let fp = file_path;
    tokio::task::spawn_blocking(move || {
        run_git(&rp, &["reset", "HEAD", "--", &fp])?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    let rp = repo_path;
    let msg = message;
    tokio::task::spawn_blocking(move || {
        let output = run_git(&rp, &["commit", "-m", &msg])?;
        Ok(output.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String> {
    let rp = repo_path;
    tokio::task::spawn_blocking(move || {
        let output = run_git(&rp, &["push"])?;
        Ok(output.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String> {
    let rp = repo_path;
    tokio::task::spawn_blocking(move || {
        let output = run_git(&rp, &["pull"])?;
        Ok(output.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<String, String> {
    let rp = repo_path;
    tokio::task::spawn_blocking(move || {
        let output = run_git(&rp, &["fetch"])?;
        Ok(output.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- GitHub via gh CLI ---

fn run_gh(args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn github_fetch_issue(owner: String, repo: String, number: u64) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let num = number.to_string();
        let repo_arg = format!("{owner}/{repo}");
        run_gh(&["issue", "view", &num, "--repo", &repo_arg, "--json", "body", "--jq", ".body"])
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn github_fetch_pr(owner: String, repo: String, number: u64) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let num = number.to_string();
        let repo_arg = format!("{owner}/{repo}");
        run_gh(&["pr", "view", &num, "--repo", &repo_arg, "--json", "body", "--jq", ".body"])
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn github_list_repos() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let output = run_gh(&["repo", "list", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"])?;
        Ok(output.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}
