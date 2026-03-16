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

#[derive(Default)]
pub struct EditorState {
    pub inner: Mutex<EditorStateInner>,
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
    let lower = svg.to_ascii_lowercase();
    let result = strip_script_tags(svg, &lower);
    let result = strip_event_handlers(&result);
    let lower2 = result.to_ascii_lowercase();
    strip_js_hrefs(&result, &lower2)
}

/// Remove `<script>...</script>` blocks (case-insensitive).
fn strip_script_tags(input: &str, lower: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pos = 0;

    while pos < input.len() {
        let Some(tag_offset) = lower[pos..].find("<script") else {
            out.push_str(&input[pos..]);
            break;
        };
        let abs = pos + tag_offset;
        let after = abs + 7; // "<script".len()

        // Must be followed by whitespace or '>'
        match lower.as_bytes().get(after) {
            Some(b' ' | b'\t' | b'\n' | b'\r' | b'>') => {}
            _ => {
                out.push_str(&input[pos..after]);
                pos = after;
                continue;
            }
        }

        out.push_str(&input[pos..abs]);

        if let Some(end_offset) = lower[abs..].find("</script>") {
            pos = abs + end_offset + 9; // "</script>".len()
        } else {
            break; // no closing tag — drop the rest
        }
    }
    out
}

/// Remove event-handler attributes (`on*="..."`) from tags.
fn strip_event_handlers(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut last = 0;
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace()
            && i + 3 < bytes.len()
            && bytes[i + 1].to_ascii_lowercase() == b'o'
            && bytes[i + 2].to_ascii_lowercase() == b'n'
        {
            let start = i;
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_alphanumeric() {
                j += 1;
            }
            if j == i + 3 {
                i += 1;
                continue;
            }
            let mut k = j;
            while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < bytes.len() && bytes[k] == b'=' {
                k += 1;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k < bytes.len() {
                    match bytes[k] {
                        b'"' => {
                            k += 1;
                            while k < bytes.len() && bytes[k] != b'"' {
                                k += 1;
                            }
                            if k < bytes.len() {
                                k += 1;
                            }
                        }
                        b'\'' => {
                            k += 1;
                            while k < bytes.len() && bytes[k] != b'\'' {
                                k += 1;
                            }
                            if k < bytes.len() {
                                k += 1;
                            }
                        }
                        _ => {
                            while k < bytes.len()
                                && !bytes[k].is_ascii_whitespace()
                                && bytes[k] != b'>'
                            {
                                k += 1;
                            }
                        }
                    }
                }
                out.push_str(&input[last..start]);
                last = k;
                i = k;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&input[last..]);
    out
}

/// Replace `javascript:` URLs in href attributes with `#`.
fn strip_js_hrefs(input: &str, lower: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pos = 0;

    while pos < input.len() {
        let Some(href_offset) = lower[pos..].find("href") else {
            out.push_str(&input[pos..]);
            break;
        };
        let abs = pos + href_offset;
        let mut k = abs + 4; // "href".len()

        // Skip whitespace + '='
        while k < input.len() && input.as_bytes()[k].is_ascii_whitespace() {
            k += 1;
        }
        if k < input.len() && input.as_bytes()[k] == b'=' {
            k += 1;
            while k < input.len() && input.as_bytes()[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < input.len() && matches!(input.as_bytes()[k], b'"' | b'\'') {
                let quote = input.as_bytes()[k];
                let val_start = k + 1;
                if lower[val_start..].starts_with("javascript:") {
                    let mut end = val_start;
                    while end < input.len() && input.as_bytes()[end] != quote {
                        end += 1;
                    }
                    // Keep everything up to and including the opening quote, replace value with '#'
                    out.push_str(&input[pos..=k]);
                    out.push('#');
                    pos = end;
                    continue;
                }
            }
        }
        out.push_str(&input[pos..abs + 4]);
        pos = abs + 4;
    }
    out
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
pub async fn read_text_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn list_directory(
    path: String,
    repo_root: Option<String>,
) -> Result<Vec<FileEntry>, String> {
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

    // Filter out git-ignored entries when inside a git repo
    if let Some(ref root) = repo_root {
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        if !paths.is_empty() {
            let ignored = git_check_ignore(root, &paths);
            entries.retain(|e| !ignored.contains(&e.path));
        }
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

fn git_check_ignore(repo_path: &str, paths: &[&str]) -> std::collections::HashSet<String> {
    let mut ignored = std::collections::HashSet::new();
    let output = Command::new("git")
        .args(["-C", repo_path, "check-ignore"])
        .args(paths)
        .output();
    if let Ok(output) = output {
        // git check-ignore outputs one ignored path per line (exit 0 = some ignored, 1 = none)
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                ignored.insert(trimmed.to_string());
            }
        }
    }
    ignored
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("File already exists".to_string())
        }
        Err(e) => Err(format!("Failed to create file: {e}")),
    }
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    match tokio::fs::create_dir(p).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("Directory already exists".to_string())
        }
        Err(e) => Err(format!("Failed to create directory: {e}")),
    }
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

#[tauri::command]
pub async fn duplicate_entry(path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    let parent = src.parent().ok_or("No parent directory")?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = src.extension().and_then(|s| s.to_str());

    // Find a unique name: "file copy.md", "file copy 2.md", ...
    let mut n = 0u32;
    let dest = loop {
        let suffix = if n == 0 {
            " copy".to_string()
        } else {
            format!(" copy {}", n + 1)
        };
        let name = match ext {
            Some(e) => format!("{stem}{suffix}.{e}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
        if n > 100 {
            return Err("Too many copies exist".to_string());
        }
    };

    if src.is_dir() {
        copy_dir_recursive(src, &dest).await?;
    } else {
        tokio::fs::copy(src, &dest)
            .await
            .map_err(|e| format!("Failed to duplicate: {e}"))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

async fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    tokio::fs::create_dir(dest)
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))?;
    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry: {e}"))?
    {
        let entry_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if entry_path.is_dir() {
            Box::pin(copy_dir_recursive(&entry_path, &dest_path)).await?;
        } else {
            tokio::fs::copy(&entry_path, &dest_path)
                .await
                .map_err(|e| format!("Failed to copy file: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", &path))
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

// --- MCP Sidecar ---

#[tauri::command]
pub fn get_mcp_binary_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?
        .join("binaries")
        .join(format!(
            "markupsidedown-mcp-{}",
            tauri::utils::platform::target_triple()
                .map_err(|e| format!("Failed to get target triple: {e}"))?
        ));
    Ok(resource_path.to_string_lossy().to_string())
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
    let rp = repo_path;
    tokio::task::spawn_blocking(move || {
        // Single command: -b gives branch info, --porcelain=v1 gives file statuses
        let output = match run_git(&rp, &["status", "-b", "--porcelain=v1"]) {
            Ok(o) => o,
            Err(_) => {
                return Ok(GitStatus {
                    branch: String::new(),
                    files: Vec::new(),
                    is_repo: false,
                });
            }
        };

        let mut lines = output.lines();
        // First line: "## branch...tracking" or "## HEAD (no branch)"
        let branch = lines
            .next()
            .and_then(|line| line.strip_prefix("## "))
            .map(|b| b.split("...").next().unwrap_or(b).to_string())
            .unwrap_or_default();

        let mut files = Vec::new();
        for line in lines {
            let bytes = line.as_bytes();
            if bytes.len() < 4 {
                continue;
            }
            let index_status = bytes[0] as char;
            let work_status = bytes[1] as char;
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
