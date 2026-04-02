use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

// --- Shared Editor State (for MCP bridge) ---

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct TabInfo {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub is_dirty: bool,
}

#[derive(Clone, Default)]
pub struct EditorStateInner {
    pub content: String,
    pub file_path: Option<String>,
    pub cursor_pos: usize,
    pub cursor_line: usize,
    pub cursor_column: usize,
    pub worker_url: Option<String>,
    pub document_structure: Option<String>, // JSON string from frontend
    pub lint_diagnostics: Option<String>,   // JSON string from frontend
    pub root_path: Option<String>,
    pub tabs: Vec<TabInfo>,
}

/// Per-window editor state, keyed by window label.
/// Also tracks which window is currently focused for bridge routing.
pub struct EditorStates {
    pub map: Mutex<std::collections::HashMap<String, EditorStateInner>>,
    pub focused: Mutex<Option<String>>,
}

impl Default for EditorStates {
    fn default() -> Self {
        Self {
            map: Mutex::new(std::collections::HashMap::new()),
            focused: Mutex::new(None),
        }
    }
}

impl EditorStates {
    /// Get a clone of the focused window's state, or the first available window's state.
    pub fn get_focused_state(&self) -> Option<EditorStateInner> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let focused = self.focused.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(label) = focused.as_ref() {
            if let Some(state) = map.get(label) {
                return Some(state.clone());
            }
        }
        // Fallback: return first available window's state
        map.values().next().cloned()
    }

    /// Remove a window's state entry.
    pub fn remove_window(&self, label: &str) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }

    /// Set the focused window label.
    pub fn set_focused(&self, label: String) {
        *self.focused.lock().unwrap_or_else(|e| e.into_inner()) = Some(label);
    }

    /// Get the focused window label.
    pub fn get_focused_label(&self) -> Option<String> {
        self.focused
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Get a single field from the focused window's state without cloning the entire struct.
    fn get_focused_field<T>(&self, f: impl FnOnce(&EditorStateInner) -> T) -> Option<T> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let focused = self.focused.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(label) = focused.as_ref() {
            if let Some(state) = map.get(label) {
                return Some(f(state));
            }
        }
        map.values().next().map(f)
    }

    pub fn get_focused_root_path(&self) -> Option<String> {
        self.get_focused_field(|s| s.root_path.clone()).flatten()
    }
}


#[tauri::command]
pub fn sync_editor_state(
    window: tauri::Window,
    content: String,
    file_path: Option<String>,
    cursor_pos: Option<usize>,
    cursor_line: Option<usize>,
    cursor_column: Option<usize>,
    worker_url: Option<String>,
    document_structure: Option<String>,
    lint_diagnostics: Option<String>,
    root_path: Option<String>,
    tabs: Option<Vec<TabInfo>>,
    state: tauri::State<'_, std::sync::Arc<EditorStates>>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut map = state.map.lock().unwrap_or_else(|e| e.into_inner());
    let s = map.entry(label).or_default();
    s.content = content;
    s.file_path = file_path;
    if let Some(pos) = cursor_pos {
        s.cursor_pos = pos;
    }
    if let Some(line) = cursor_line {
        s.cursor_line = line;
    }
    if let Some(col) = cursor_column {
        s.cursor_column = col;
    }
    s.worker_url = worker_url;
    if let Some(ds) = document_structure {
        s.document_structure = Some(ds);
    }
    if let Some(ld) = lint_diagnostics {
        s.lint_diagnostics = Some(ld);
    }
    if let Some(rp) = root_path {
        s.root_path = Some(rp);
    }
    if let Some(t) = tabs {
        s.tabs = t;
    }
    Ok(())
}

// --- Worker Health Check ---

/// Must match WORKER_VERSION in worker/src/index.ts.
const EXPECTED_WORKER_VERSION: u32 = 5;

#[derive(Serialize)]
pub struct WorkerStatus {
    pub reachable: bool,
    pub convert_available: bool,
    pub render_available: bool,
    pub json_available: bool,
    pub crawl_available: bool,
    pub cache_available: bool,
    pub batch_available: bool,
    pub publish_available: bool,
    pub search_available: bool,
    pub worker_version: Option<u32>,
    pub update_available: bool,
    pub error: Option<String>,
}

impl WorkerStatus {
    fn unreachable(error: String) -> Self {
        Self {
            reachable: false,
            convert_available: false,
            render_available: false,
            json_available: false,
            crawl_available: false,
            cache_available: false,
            batch_available: false,
            publish_available: false,
            search_available: false,
            worker_version: None,
            update_available: false,
            error: Some(error),
        }
    }
}

#[derive(Deserialize)]
struct HealthCapabilities {
    convert: Option<bool>,
    render: Option<bool>,
    json: Option<bool>,
    crawl: Option<bool>,
    cache: Option<bool>,
    batch: Option<bool>,
    publish: Option<bool>,
    search: Option<bool>,
}

#[derive(Deserialize)]
struct HealthResponse {
    _status: Option<String>,
    version: Option<u32>,
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
                        json: None,
                        crawl: None,
                        cache: None,
                        batch: None,
                        publish: None,
                        search: None,
                    });
                    let version = body.version;
                    let update_available = match version {
                        Some(v) => v < EXPECTED_WORKER_VERSION,
                        None => true, // No version field means old Worker
                    };
                    WorkerStatus {
                        reachable: true,
                        convert_available: caps.convert.unwrap_or(false),
                        render_available: caps.render.unwrap_or(false),
                        json_available: caps.json.unwrap_or(false),
                        crawl_available: caps.crawl.unwrap_or(false),
                        cache_available: caps.cache.unwrap_or(false),
                        batch_available: caps.batch.unwrap_or(false),
                        publish_available: caps.publish.unwrap_or(false),
                        search_available: caps.search.unwrap_or(false),
                        worker_version: version,
                        update_available,
                        error: None,
                    }
                }
                Err(e) => WorkerStatus {
                    reachable: true,
                    convert_available: false,
                    render_available: false,
                    json_available: false,
                    crawl_available: false,
                    cache_available: false,
                    batch_available: false,
                    publish_available: false,
                    search_available: false,
                    worker_version: None,
                    update_available: true,
                    error: Some(format!("Unexpected response format: {e}")),
                }
            }
        }
        Ok(resp) => WorkerStatus {
            reachable: true,
            convert_available: false,
            render_available: false,
            json_available: false,
            crawl_available: false,
            cache_available: false,
            batch_available: false,
            publish_available: false,
            search_available: false,
            worker_version: None,
            update_available: false,
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

// --- Fetch URL via Worker (AI.toMarkdown() conversion) ---

#[derive(Serialize, Deserialize)]
pub struct WorkerFetchResult {
    pub markdown: String,
    pub source: String,
    pub spa_detected: bool,
}

#[derive(Deserialize)]
struct FetchWorkerResponse {
    markdown: Option<String>,
    source: Option<String>,
    spa_detected: Option<bool>,
    error: Option<String>,
}

#[tauri::command]
pub async fn fetch_url_via_worker(
    url: String,
    worker_url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<WorkerFetchResult, String> {
    let fetch_url = format!("{}/fetch", worker_url.trim_end_matches('/'));

    let response = client
        .post(&fetch_url)
        .timeout(Duration::from_secs(60))
        .json(&serde_json::json!({ "url": url }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body: FetchWorkerResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(body.error.unwrap_or_else(|| format!("Worker returned {status}")));
    }

    Ok(WorkerFetchResult {
        markdown: body.markdown.ok_or_else(|| "No markdown in response".to_string())?,
        source: body.source.unwrap_or_else(|| "ai-to-markdown".to_string()),
        spa_detected: body.spa_detected.unwrap_or(false),
    })
}

// --- JSON Extraction via Browser Rendering /json API ---

#[derive(Deserialize)]
struct JsonWorkerResponse {
    data: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct JsonExtractResult {
    pub data: serde_json::Value,
}

#[tauri::command]
pub async fn fetch_json_via_worker(
    url: String,
    worker_url: String,
    prompt: Option<String>,
    response_format: Option<serde_json::Value>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<JsonExtractResult, String> {
    let json_url = format!("{}/json", worker_url.trim_end_matches('/'));

    let mut body = serde_json::json!({ "url": url });
    if let Some(ref p) = prompt {
        body["prompt"] = serde_json::json!(p);
    }
    if let Some(ref rf) = response_format {
        body["response_format"] = rf.clone();
    }

    let response = client
        .post(&json_url)
        .timeout(Duration::from_secs(60))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let resp: JsonWorkerResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(resp.error.unwrap_or_else(|| format!("Worker returned {status}")));
    }

    Ok(JsonExtractResult {
        data: resp.data.ok_or_else(|| "No data in response".to_string())?,
    })
}

// --- Website Crawl via Browser Rendering /crawl API ---

#[derive(Deserialize)]
struct CrawlStartWorkerResponse {
    job_id: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct CrawlStartResult {
    pub job_id: String,
}

#[tauri::command]
pub async fn crawl_website(
    url: String,
    worker_url: String,
    depth: u32,
    limit: u32,
    render: bool,
    include_patterns: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    formats: Option<Vec<String>>,
    response_format: Option<serde_json::Value>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<CrawlStartResult, String> {
    let crawl_url = format!("{}/crawl", worker_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "url": url,
        "depth": depth,
        "limit": limit,
        "render": render,
    });
    if let Some(ref f) = formats {
        body["formats"] = serde_json::json!(f);
    }
    if let Some(ref rf) = response_format {
        body["response_format"] = rf.clone();
    }

    if let Some(ref patterns) = include_patterns {
        if !patterns.is_empty() {
            body["includePatterns"] = serde_json::json!(patterns);
        }
    }
    if let Some(ref patterns) = exclude_patterns {
        if !patterns.is_empty() {
            body["excludePatterns"] = serde_json::json!(patterns);
        }
    }

    let response = client
        .post(&crawl_url)
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let resp: CrawlStartWorkerResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(resp.error.unwrap_or_else(|| format!("Worker returned {status}")));
    }

    Ok(CrawlStartResult {
        job_id: resp.job_id.ok_or("No job_id in response")?,
    })
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct CrawlRecord {
    url: Option<String>,
    status: Option<String>,
    markdown: Option<String>,
    json: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct CrawlResultInner {
    status: Option<String>,
    total: Option<u32>,
    finished: Option<u32>,
    cursor: Option<String>,
    records: Option<Vec<CrawlRecord>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct CrawlStatusWorkerResponse {
    success: Option<bool>,
    result: Option<CrawlResultInner>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct CrawlPage {
    pub url: String,
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct CrawlStatusResult {
    pub status: String,
    pub total: u32,
    pub finished: u32,
    pub cursor: Option<String>,
    pub pages: Vec<CrawlPage>,
}

#[tauri::command]
pub async fn crawl_status(
    job_id: String,
    worker_url: String,
    cursor: Option<String>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<CrawlStatusResult, String> {
    let mut status_url = format!(
        "{}/crawl/{}?limit=100&status=completed",
        worker_url.trim_end_matches('/'),
        job_id
    );
    if let Some(ref c) = cursor {
        status_url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
    }

    let response = client
        .get(&status_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let resp: CrawlStatusWorkerResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        return Err(resp.error.unwrap_or_else(|| format!("Worker returned {status}")));
    }

    let result = resp.result.ok_or("No result in response")?;

    let pages: Vec<CrawlPage> = result
        .records
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            Some(CrawlPage {
                url: r.url?,
                markdown: r.markdown.unwrap_or_default(),
                json: r.json,
            })
        })
        .collect();

    Ok(CrawlStatusResult {
        status: result.status.unwrap_or_else(|| "unknown".to_string()),
        total: result.total.unwrap_or(0),
        finished: result.finished.unwrap_or(0),
        cursor: result.cursor,
        pages,
    })
}

#[derive(Serialize)]
pub struct CrawlSaveResult {
    pub saved_count: u32,
    pub base_dir: String,
}

#[tauri::command]
pub async fn crawl_save(
    pages: Vec<CrawlPage>,
    base_dir: String,
) -> Result<CrawlSaveResult, String> {
    let mut saved_count = 0u32;

    for page in &pages {
        let file_path = url_to_filepath(&page.url, &base_dir);
        if let Some(parent) = std::path::Path::new(&file_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        }
        tokio::fs::write(&file_path, &page.markdown)
            .await
            .map_err(|e| format!("Failed to write {file_path}: {e}"))?;
        saved_count += 1;
    }

    Ok(CrawlSaveResult {
        saved_count,
        base_dir,
    })
}

fn url_to_filepath(url: &str, base_dir: &str) -> String {
    // Simple URL parsing without the `url` crate
    let without_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let (host_port, path) = match without_scheme.find('/') {
        Some(i) => (&without_scheme[..i], &without_scheme[i..]),
        None => (without_scheme, "/"),
    };
    let host = host_port.split(':').next().unwrap_or("unknown");
    // Strip query string and fragment
    let path = path.split('?').next().unwrap_or(path);
    let path = path.split('#').next().unwrap_or(path);

    let path = path.trim_matches('/');
    let segments: Vec<&str> = if path.is_empty() {
        vec!["index"]
    } else {
        path.split('/').collect()
    };

    let mut file_path = std::path::PathBuf::from(base_dir);
    file_path.push(sanitize_filename(host));

    for (i, seg) in segments.iter().enumerate() {
        let clean = sanitize_filename(seg);
        if clean.is_empty() {
            continue;
        }
        if i == segments.len() - 1 {
            // Last segment: add .md extension if not present
            if clean.ends_with(".md") {
                file_path.push(&clean);
            } else {
                file_path.push(format!("{clean}.md"));
            }
        } else {
            file_path.push(&clean);
        }
    }

    file_path.to_string_lossy().to_string()
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

// --- Fetch Page Title ---

pub async fn fetch_page_title_with(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let validated_url = validate_url(url)?;
    let response = client
        .get(validated_url)
        .timeout(Duration::from_secs(10))
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read body: {e}"))?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(65536)]);

    crate::util::extract_html_title(&text)
}

#[tauri::command]
pub async fn fetch_page_title(
    url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String, String> {
    fetch_page_title_with(&client, &url).await
}

// --- Download Image to Local File ---

pub async fn download_image_with(
    client: &reqwest::Client,
    url: &str,
    dest_path: &str,
) -> Result<String, String> {
    let validated_url = validate_url(url)?;
    let validated_path = validate_path(dest_path)?;
    let dest_path = validated_path.to_str().ok_or("Invalid path encoding")?;
    let response = client
        .get(validated_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch image: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read image: {e}"))?;

    if let Some(parent) = std::path::Path::new(dest_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    tokio::fs::write(dest_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write image: {e}"))?;

    Ok(dest_path.to_string())
}

#[tauri::command]
pub async fn download_image(
    url: String,
    dest_path: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String, String> {
    download_image_with(&client, &url, &dest_path).await
}

// --- Document to Markdown via Workers AI ---

#[derive(Deserialize)]
struct ConvertWorkerResponse {
    markdown: Option<String>,
    is_image: Option<bool>,
    error: Option<String>,
    warning: Option<String>,
}

#[derive(Serialize)]
pub struct ConvertResponse {
    pub markdown: String,
    pub is_image: bool,
    pub original_size: usize,
    pub warning: Option<String>,
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
        warning: body.warning,
    })
}

#[tauri::command]
pub fn detect_file_is_image(file_path: String) -> Result<bool, String> {
    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    Ok(mime_from_extension(ext).is_some_and(|m| m.starts_with("image/")))
}

fn mime_from_extension(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "html" | "htm" => Some("text/html"),
        "csv" => Some("text/csv"),
        "xml" => Some("application/xml"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
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
    let result = strip_script_tags(svg);
    let result = strip_event_handlers(&result);
    let lower = result.to_ascii_lowercase();
    strip_js_hrefs(&result, &lower)
}

/// Case-insensitive byte sequence search.
fn find_ascii_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w.iter().zip(needle).all(|(a, b)| a.eq_ignore_ascii_case(b)))
}

/// Remove `<script>...</script>` blocks (case-insensitive).
fn strip_script_tags(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut pos = 0;

    while pos < bytes.len() {
        let Some(tag_offset) = find_ascii_ci(&bytes[pos..], b"<script") else {
            out.push_str(&input[pos..]);
            break;
        };
        let abs = pos + tag_offset;
        let after = abs + 7; // b"<script".len()

        // Must be followed by whitespace or '>'
        match bytes.get(after) {
            Some(b' ' | b'\t' | b'\n' | b'\r' | b'>') => {}
            _ => {
                out.push_str(&input[pos..after]);
                pos = after;
                continue;
            }
        }

        out.push_str(&input[pos..abs]);

        if let Some(end_offset) = find_ascii_ci(&bytes[abs..], b"</script>") {
            pos = abs + end_offset + 9; // b"</script>".len()
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
            && bytes[i + 1].eq_ignore_ascii_case(&b'o')
            && bytes[i + 2].eq_ignore_ascii_case(&b'n')
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

// --- Path Validation ---

/// Validate and sanitize a user-provided path to prevent path traversal attacks.
/// Ensures the resolved path is under the user's home directory.
fn validate_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);

    // Try to canonicalize the full path first; if the file doesn't exist yet,
    // canonicalize the parent directory and append the file name.
    let resolved = match p.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            let parent = p
                .parent()
                .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
            let file_name = p
                .file_name()
                .ok_or_else(|| "Invalid path: no file name".to_string())?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("Invalid parent path: {e}"))?;
            canonical_parent.join(file_name)
        }
    };

    let home = crate::util::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    if !resolved.starts_with(&home) {
        return Err(format!(
            "Access denied: path must be under {}",
            home.display()
        ));
    }

    Ok(resolved)
}

/// Parse and validate a URL, ensuring only http/https schemes are used.
/// Returns a new `reqwest::Url` to break the taint chain from raw user input.
fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        scheme => Err(format!(
            "Invalid URL scheme '{scheme}': only http and https are allowed"
        )),
    }
}

// --- File Tree ---

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub extension: Option<String>,
    pub modified_at: Option<u64>,
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let path = validate_path(&path)?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let path = validate_path(&path)?;
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let extension = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        let modified_at = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        entries.push(FileEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            extension,
            modified_at,
        });
    }

    // Filter out well-known build artifact and dependency directories.
    const HIDDEN_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];
    entries.retain(|e| !(e.is_dir && HIDDEN_DIRS.contains(&e.name.as_str())));

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));

    Ok(entries)
}


#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
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
    let p = validate_path(&path)?;
    match tokio::fs::create_dir(&p).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("Directory already exists".to_string())
        }
        Err(e) => Err(format!("Failed to create directory: {e}")),
    }
}

#[tauri::command]
pub async fn rename_entry(from: String, to: String) -> Result<(), String> {
    let from = validate_path(&from)?;
    let to = validate_path(&to)?;
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| format!("Failed to rename: {e}"))
}

#[tauri::command]
pub async fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    let dest = validate_path(&path)?;
    if dest.exists() {
        return Err(format!(
            "'{}' already exists",
            dest.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        ));
    }
    tokio::fs::write(&dest, &data)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub async fn save_image(path: String, data: Vec<u8>) -> Result<(), String> {
    let dest = validate_path(&path)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    tokio::fs::write(&dest, &data)
        .await
        .map_err(|e| format!("Failed to save image: {e}"))
}

#[tauri::command]
pub async fn delete_entry(path: String, is_dir: bool) -> Result<(), String> {
    let _ = is_dir; // trash::delete handles both files and directories
    let validated = validate_path(&path)?;
    let path_clone = validated.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        trash::delete(&path_clone).map_err(|e| format!("Failed to move to trash: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn copy_entry(from: String, to_dir: String) -> Result<String, String> {
    let src = validate_path(&from)?;
    let to_dir = validate_path(&to_dir)?;
    let file_name = src
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy()
        .to_string();
    let dest = to_dir.join(&file_name);
    if dest.exists() {
        return Err(format!("'{}' already exists in destination", file_name));
    }
    if src.is_dir() {
        copy_dir_recursive(&src, &dest).await?;
    } else {
        tokio::fs::copy(&src, &dest)
            .await
            .map_err(|e| format!("Failed to copy: {e}"))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn duplicate_entry(path: String) -> Result<String, String> {
    let validated = validate_path(&path)?;
    let path_clone = validated.to_string_lossy().to_string();
    let dest = tokio::task::spawn_blocking(move || {
        let src = std::path::Path::new(&path_clone);
        let parent = src.parent().ok_or("No parent directory")?;
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let ext = src.extension().and_then(|s| s.to_str());

        // Find a unique name: "file copy.md", "file copy 2.md", ...
        let mut n = 0u32;
        loop {
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
                break Ok::<_, String>(candidate);
            }
            n += 1;
            if n > 100 {
                break Err("Too many copies exist".to_string());
            }
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))??;

    let src = &validated;
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

#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let dir = if std::path::Path::new(&path).is_dir() {
        path
    } else {
        std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path)
    };
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d {dir}")])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
        let mut opened = false;
        for term in &terminals {
            if std::process::Command::new(term)
                .current_dir(&dir)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err("No terminal emulator found".to_string());
        }
    }
    Ok(())
}

// --- MCP Sidecar ---

#[tauri::command]
pub fn get_mcp_binary_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let triple = tauri::utils::platform::target_triple()
        .map_err(|e| format!("Failed to get target triple: {e}"))?;
    let bin_name_with_triple = format!("markupsidedown-mcp-{triple}");

    // Production (.app bundle): Contents/MacOS/markupsidedown-mcp (no triple suffix)
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri places sidecar binaries in Contents/MacOS/ (sibling of Contents/Resources/)
        if let Some(contents_dir) = resource_dir.parent() {
            let macos_path = contents_dir.join("MacOS").join("markupsidedown-mcp");
            if macos_path.exists() {
                return Ok(macos_path.to_string_lossy().to_string());
            }
        }
    }

    // Dev mode: src-tauri/binaries/ (with triple suffix)
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&bin_name_with_triple);
    if dev_path.exists() {
        return Ok(dev_path.to_string_lossy().to_string());
    }

    Err(format!("MCP binary 'markupsidedown-mcp' not found"))
}

// --- CLI Command Runner ---

fn run_cli(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {cmd}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{cmd} command failed")
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// --- Git Operations ---

/// Unquote a git-quoted path (e.g. `"path with spaces"` → `path with spaces`).
/// Handles backslash escapes: `\\`, `\"`, `\t`, `\n`, and octal (`\303\251` etc.).
fn unquote_git_path(s: &str) -> String {
    let inner = &s[1..s.len() - 1]; // strip surrounding quotes
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'\\' => { out.push(b'\\'); i += 2; }
                b'"' => { out.push(b'"'); i += 2; }
                b't' => { out.push(b'\t'); i += 2; }
                b'n' => { out.push(b'\n'); i += 2; }
                b'r' => { out.push(b'\r'); i += 2; }
                b'a' => { out.push(b'\x07'); i += 2; }
                b'b' => { out.push(b'\x08'); i += 2; }
                c if c.is_ascii_digit() => {
                    // Octal escape (up to 3 digits)
                    let mut val: u8 = c - b'0';
                    let mut j = i + 2;
                    let end = (i + 4).min(bytes.len());
                    while j < end {
                        if bytes[j].is_ascii_digit() && bytes[j] <= b'7' {
                            val = val * 8 + (bytes[j] - b'0');
                            j += 1;
                        } else {
                            break;
                        }
                    }
                    out.push(val);
                    i = j;
                }
                _ => { out.push(bytes[i]); i += 1; }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Serialize all git CLI calls so concurrent operations (e.g. status polling
/// during a multi-step revert) don't race on the index file.
static GIT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    run_git_unlocked(repo_path, args)
}

/// Run git without acquiring GIT_LOCK — caller must hold the lock.
fn run_git_unlocked(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-C", repo_path];
    full_args.extend_from_slice(args);
    run_cli("git", &full_args)
}

#[derive(Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,   // "M", "A", "D", "?", "R", etc.
    pub staged: bool,
    pub added_lines: u32,
    pub removed_lines: u32,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub is_repo: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus, String> {
    let rp = repo_path;
    tokio::task::spawn_blocking(move || {
        // Hold lock for all three commands to avoid racing with multi-step
        // operations like git_revert (stash → revert → pop).
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let status_result = run_git_unlocked(&rp, &["status", "-b", "--porcelain=v1"]).ok();
        let unstaged_raw = run_git_unlocked(&rp, &["diff", "--numstat"]).ok();
        let staged_raw = run_git_unlocked(&rp, &["diff", "--cached", "--numstat"]).ok();

        let output = match status_result {
            Some(o) => o,
            None => {
                return Ok(GitStatus {
                    branch: String::new(),
                    files: Vec::new(),
                    is_repo: false,
                    ahead: 0,
                    behind: 0,
                });
            }
        };

        let mut lines = output.lines();
        // First line: "## branch...tracking [ahead N, behind M]" or "## HEAD (no branch)"
        let first_line = lines
            .next()
            .and_then(|line| line.strip_prefix("## "))
            .unwrap_or("");
        let branch = first_line.split("...").next().unwrap_or(first_line).to_string();
        let mut ahead: u32 = 0;
        let mut behind: u32 = 0;
        if let Some(bracket) = first_line.find('[') {
            let info = &first_line[bracket..];
            if let Some(n) = info
                .find("ahead ")
                .and_then(|i| info[i + 6..].split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|s| s.parse().ok())
            {
                ahead = n;
            }
            if let Some(n) = info
                .find("behind ")
                .and_then(|i| info[i + 7..].split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|s| s.parse().ok())
            {
                behind = n;
            }
        }

        let mut unstaged_stats: std::collections::HashMap<String, (u32, u32)> =
            std::collections::HashMap::new();
        let mut staged_stats: std::collections::HashMap<String, (u32, u32)> =
            std::collections::HashMap::new();

        if let Some(numstat) = unstaged_raw {
            for line in numstat.lines() {
                if let Some((added, removed, path)) = parse_numstat_line(line) {
                    unstaged_stats.insert(path, (added, removed));
                }
            }
        }
        if let Some(numstat) = staged_raw {
            for line in numstat.lines() {
                if let Some((added, removed, path)) = parse_numstat_line(line) {
                    staged_stats.insert(path, (added, removed));
                }
            }
        }

        let mut files = Vec::new();
        for line in lines {
            let bytes = line.as_bytes();
            if bytes.len() < 4 {
                continue;
            }
            let index_status = bytes[0] as char;
            let work_status = bytes[1] as char;
            let raw_path = &line[3..];
            let file_path = if raw_path.starts_with('"') && raw_path.ends_with('"') {
                unquote_git_path(raw_path)
            } else {
                raw_path.to_string()
            };

            // Staged changes
            if index_status != ' ' && index_status != '?' {
                let (added, removed) = staged_stats
                    .get(&file_path)
                    .copied()
                    .unwrap_or((0, 0));
                files.push(GitFileStatus {
                    path: file_path.clone(),
                    status: index_status.to_string(),
                    staged: true,
                    added_lines: added,
                    removed_lines: removed,
                });
            }

            // Unstaged changes
            if work_status != ' ' {
                let status = if index_status == '?' {
                    "?".to_string()
                } else {
                    work_status.to_string()
                };
                let (added, removed) = unstaged_stats
                    .get(&file_path)
                    .copied()
                    .unwrap_or((0, 0));
                files.push(GitFileStatus {
                    path: file_path,
                    status,
                    staged: false,
                    added_lines: added,
                    removed_lines: removed,
                });
            }
        }

        Ok(GitStatus {
            branch,
            files,
            is_repo: true,
            ahead,
            behind,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

fn parse_numstat_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.split('\t');
    let added = parts.next()?.parse::<u32>().ok()?;
    let removed = parts.next()?.parse::<u32>().ok()?;
    let path = parts.next()?.to_string();
    Some((added, removed, path))
}

#[tauri::command]
pub async fn git_stage_all(repo_path: String) -> Result<(), String> {
    let rp = repo_path;
    tokio::task::spawn_blocking(move || {
        run_git(&rp, &["add", "-A"])?;
        Ok(())
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

async fn git_remote_command(repo_path: String, cmd: &'static str) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = run_git(&repo_path, &[cmd])?;
        Ok(output.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String> {
    git_remote_command(repo_path, "push").await
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String> {
    git_remote_command(repo_path, "pull").await
}

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<String, String> {
    git_remote_command(repo_path, "fetch").await
}

// --- Diff ---

#[tauri::command]
pub async fn git_diff(repo_path: String, file_path: String, staged: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&file_path);
        run_git(&repo_path, &args)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- Discard ---

#[tauri::command]
pub async fn git_discard(repo_path: String, file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Check if the file is untracked
        let status_output = run_git(&repo_path, &["status", "--porcelain", "--", &file_path])?;
        let is_untracked = status_output.lines().any(|l| l.starts_with("??"));

        if is_untracked {
            // Delete untracked file
            let full_path = std::path::Path::new(&repo_path).join(&file_path);
            std::fs::remove_file(&full_path)
                .map_err(|e| format!("Failed to delete {}: {e}", file_path))?;
        } else {
            // Restore tracked file
            run_git(&repo_path, &["checkout", "--", &file_path])?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_discard_all(repo_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        // Restore all tracked files
        run_git(&repo_path, &["checkout", "--", "."])?;
        // Remove all untracked files and directories
        run_git(&repo_path, &["clean", "-fd"])?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- Log ---

#[derive(Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub relative_time: String,
}

#[tauri::command]
pub async fn git_log(repo_path: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let limit = limit.unwrap_or(10);
    tokio::task::spawn_blocking(move || {
        let limit_str = format!("-{}", limit);
        let output = run_git(
            &repo_path,
            &["log", &limit_str, "--format=%H%x00%h%x00%s%x00%an%x00%ar"],
        )?;
        let entries = output
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(5, '\0').collect();
                if parts.len() == 5 {
                    Some(GitLogEntry {
                        hash: parts[0].to_string(),
                        short_hash: parts[1].to_string(),
                        message: parts[2].to_string(),
                        author: parts[3].to_string(),
                        relative_time: parts[4].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- Revert ---

#[tauri::command]
pub async fn git_revert(repo_path: String, commit_hash: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Require clean working tree
        let status = run_git_unlocked(&repo_path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Err("Commit or discard changes before reverting.".to_string());
        }

        let short = if commit_hash.len() >= 7 { &commit_hash[..7] } else { &commit_hash };

        // Restore entire working tree to the target commit's state:
        // 1. Remove all tracked files from index and working tree
        let _ = run_git_unlocked(&repo_path, &["rm", "-rf", "--quiet", "."]);
        // 2. Restore all files from the target commit
        run_git_unlocked(&repo_path, &["checkout", &commit_hash, "--", "."])?;
        // 3. Commit the result as a new commit
        let commit_result = run_git_unlocked(
            &repo_path,
            &["commit", "--allow-empty", "-m", &format!("Revert to {short}")],
        )?;

        Ok(commit_result.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- Show commit diff ---

#[tauri::command]
pub async fn git_show(repo_path: String, commit_hash: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&repo_path, &["show", "--patch", "--format=", &commit_hash])
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- Clone ---

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_cli("git", &["clone", &url, &dest]).map(|s| s.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub async fn git_init(repo_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_cli("git", &["init", &repo_path]).map(|s| s.trim().to_string())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

// --- Claude Desktop MCP Config ---

#[tauri::command]
pub fn install_mcp_to_claude_desktop(
    mcp_binary_path: String,
    worker_url: String,
) -> Result<String, String> {
    use std::fs;

    let config_path = crate::util::home_dir()
        .ok_or("Cannot resolve home directory")?
        .join("Library/Application Support/Claude/claude_desktop_config.json");

    // Read existing config or create new one
    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config: {e}"))?
    } else {
        serde_json::json!({})
    };

    // Build MCP server entry
    let mut entry = serde_json::json!({ "command": mcp_binary_path });
    if !worker_url.is_empty() {
        entry["env"] = serde_json::json!({ "MARKUPSIDEDOWN_WORKER_URL": worker_url });
    }

    // Add/update markupsidedown entry
    let servers = config
        .as_object_mut()
        .ok_or("Config is not a JSON object")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    servers["markupsidedown"] = entry;

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(config_path.to_string_lossy().to_string())
}

// --- Cowork Workspace ---

#[tauri::command]
pub fn create_cowork_workspace(
    folder_path: String,
) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;

    // Expand ~ to home directory
    let expanded = if folder_path.starts_with("~/") {
        crate::util::home_dir()
            .ok_or("Cannot resolve home directory")?
            .join(&folder_path[2..])
    } else {
        PathBuf::from(&folder_path)
    };

    fs::create_dir_all(&expanded)
        .map_err(|e| format!("Failed to create directory: {e}"))?;

    // Generate CLAUDE.md
    let claude_md = r#"# MarkUpsideDown Workspace

This workspace is configured for use with MarkUpsideDown's MCP server.
MarkUpsideDown must be running for editor/file/git tools to work.

## Available MCP Tools (61)

### Editor
| Tool | Description |
|------|-------------|
| `get_editor_content` | Get current Markdown from the editor |
| `set_editor_content` | Replace editor content |
| `insert_text` | Insert text at cursor, start, or end |
| `get_editor_state` | Get editor state (file path, cursor, Worker URL) |
| `switch_tab` | Switch the active editor tab |

### Document
| Tool | Description |
|------|-------------|
| `get_document_structure` | Get document structure (headings, links, stats) as JSON |
| `normalize_document` | Normalize headings, tables, list markers, whitespace, CJK emphasis spacing |
| `lint_document` | Run structural lint checks (headings, links, emphasis, code blocks, etc.) |

### File Operations
| Tool | Description |
|------|-------------|
| `open_file` | Open a Markdown file |
| `save_file` | Save content to a file |
| `read_file` | Read a text file from the project |
| `list_directory` | List files and directories (respects .gitignore) |
| `search_files` | Search file names in the project |
| `create_file` | Create a new empty file |
| `create_directory` | Create a new directory |
| `rename_entry` | Rename or move a file or directory |
| `delete_entry` | Delete a file or directory (moved to trash) |
| `copy_entry` | Copy a file or directory |
| `duplicate_entry` | Duplicate a file or directory |
| `get_open_tabs` | List all open editor tabs |
| `get_project_root` | Get the current project root path |
| `get_dirty_files` | List files with unsaved changes |

### Web Fetching & Conversion
| Tool | Description |
|------|-------------|
| `get_markdown` | Fetch URL as Markdown (auto-detects JS-rendered pages) |
| `fetch_markdown` | Fetch URL as Markdown (static only) |
| `render_markdown` | JS-render a page as Markdown via Browser Rendering |
| `convert_to_markdown` | Convert local file (PDF, DOCX, images, etc.) to Markdown |
| `extract_json` | Extract structured JSON from a web page using AI |
| `download_image` | Download an image from a URL to local path |
| `fetch_page_title` | Extract page title for Markdown links |

### Website Crawling
| Tool | Description |
|------|-------------|
| `crawl_website` | Start a website crawl job (markdown and/or json output) |
| `crawl_status` | Poll crawl job status and retrieve pages |
| `crawl_save` | Save crawled pages as local Markdown files |

### Git
| Tool | Description |
|------|-------------|
| `git_status` | Get git status (branch, changes, ahead/behind) |
| `git_stage` | Stage a file for commit |
| `git_stage_all` | Stage all changes (git add -A) |
| `git_unstage` | Unstage a file |
| `git_commit` | Commit staged changes |
| `git_push` | Push commits to remote |
| `git_pull` | Pull changes from remote |
| `git_fetch` | Fetch updates from remote |
| `git_diff` | Get the diff for a specific file |
| `git_discard` | Discard changes for a specific file |
| `git_discard_all` | Discard all uncommitted changes |
| `git_log` | Get recent commit history |
| `git_show` | Show the patch for a specific commit |
| `git_revert` | Revert a commit |
| `git_clone` | Clone a git repository |
| `git_init` | Initialize a new git repository |

### Tags
| Tool | Description |
|------|-------------|
| `list_tags` | List all tag definitions and file-tag assignments |
| `get_file_tags` | Get tags assigned to a specific file |
| `set_file_tags` | Set tags for a file (replaces existing) |
| `create_tag` | Create a new tag definition with a color |
| `delete_tag` | Delete a tag and remove from all files |

### Search & Indexing
| Tool | Description |
|------|-------------|
| `semantic_search` | Search indexed documents using natural language |
| `index_documents` | Index documents into Vectorize for semantic search |
| `remove_document` | Remove a document from the Vectorize index |

### Publishing
| Tool | Description |
|------|-------------|
| `publish_document` | Publish Markdown to a public URL via R2 |
| `unpublish_document` | Remove a published document from R2 |
| `list_published` | List all published documents in R2 |

### Batch Conversion
| Tool | Description |
|------|-------------|
| `submit_batch` | Submit files for parallel batch conversion |
| `get_batch_status` | Poll batch conversion job status |

## Tips

- Use `get_markdown` (recommended) instead of `fetch_markdown`/`render_markdown` for most URL fetching
- Use `convert_to_markdown` to import PDFs, DOCX, XLSX, HTML, CSV, XML, images
- Use `crawl_website` + `crawl_status` for multi-page site crawls with markdown and/or json output
- Use `extract_json` to extract structured data from web pages via AI
- Use `get_document_structure` instead of parsing raw Markdown for structural analysis
- Use `lint_document` to check for structural issues before committing
- Use `normalize_document` after editing to clean up formatting (includes CJK emphasis spacing)
- Use `publish_document` to share Markdown at a public URL (permanent or time-limited)
- Use `index_documents` + `semantic_search` for AI-powered document retrieval
- Use `submit_batch` + `get_batch_status` for bulk file conversion
"#;
    let claude_md_path = expanded.join("CLAUDE.md");
    if !claude_md_path.exists() {
        fs::write(&claude_md_path, claude_md)
            .map_err(|e| format!("Failed to write CLAUDE.md: {e}"))?;
    }

    Ok(expanded.to_string_lossy().to_string())
}

// --- Update check ---

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub html_url: String,
}

#[tauri::command]
pub async fn check_for_update(
    client: tauri::State<'_, reqwest::Client>,
    current_version: String,
) -> Result<Option<UpdateInfo>, String> {
    let resp = client
        .get("https://api.github.com/repos/M-Igashi/markupsidedown/releases/latest")
        .header("User-Agent", "markupsidedown")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(None);
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = body["tag_name"].as_str().unwrap_or("");
    let latest = tag.strip_prefix('v').unwrap_or(tag);
    let html_url = body["html_url"].as_str().unwrap_or("").to_string();

    if is_newer(latest, &current_version) {
        Ok(Some(UpdateInfo {
            version: latest.to_string(),
            html_url,
        }))
    } else {
        Ok(None)
    }
}

/// Compare dot-separated version strings (e.g. "0.1.104" > "0.1.103").
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.').filter_map(|p| p.parse().ok()).collect()
    };
    let l = parse(latest);
    let c = parse(current);
    for i in 0..l.len().max(c.len()) {
        let lv = l.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if lv != cv {
            return lv > cv;
        }
    }
    false
}

// --- comrak-based CommonMark validation (#140) ---

#[derive(Clone, Serialize, Deserialize)]
pub struct ComrakDiagnostic {
    pub line: usize,
    pub severity: String,
    pub message: String,
}

#[tauri::command]
pub fn validate_markdown(content: String) -> Result<Vec<ComrakDiagnostic>, String> {
    use comrak::{parse_document, Arena, Options};

    let arena = Arena::new();
    let options = Options::default();
    let root = parse_document(&arena, &content, &options);

    let mut diagnostics = Vec::new();

    check_html_blocks(root, &mut diagnostics);
    check_link_nesting(root, &mut diagnostics);
    check_list_continuation(root, &mut diagnostics);
    check_blockquote_boundary(root, &content, &mut diagnostics);

    diagnostics.sort_by_key(|d| d.line);
    Ok(diagnostics)
}

/// Detect HTML blocks that may unintentionally swallow Markdown content.
fn check_html_blocks<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    for node in root.descendants() {
        let ast = node.data.borrow();
        if let NodeValue::HtmlBlock(ref hb) = ast.value {
            // Skip well-known intentional HTML tags
            let trimmed = hb.literal.trim_start().to_lowercase();
            if trimmed.starts_with("<details")
                || trimmed.starts_with("<summary")
                || trimmed.starts_with("<div")
                || trimmed.starts_with("</div")
                || trimmed.starts_with("</details")
                || trimmed.starts_with("<!--")
            {
                continue;
            }

            let start = ast.sourcepos.start.line;
            let end = ast.sourcepos.end.line;
            let span = if start == end {
                format!("line {start}")
            } else {
                format!("lines {start}-{end}")
            };

            diagnostics.push(ComrakDiagnostic {
                line: start,
                severity: "info".into(),
                message: format!(
                    "HTML block detected ({span}) — content inside is not parsed as Markdown"
                ),
            });
        }
    }
}

/// Detect nested links (CommonMark forbids links inside links).
fn check_link_nesting<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    for node in root.descendants() {
        let is_link = matches!(node.data.borrow().value, NodeValue::Link(_));
        if !is_link {
            continue;
        }

        // Check if any descendant is also a Link
        for child in node.descendants().skip(1) {
            if matches!(child.data.borrow().value, NodeValue::Link(_)) {
                let line = child.data.borrow().sourcepos.start.line;
                diagnostics.push(ComrakDiagnostic {
                    line,
                    severity: "info".into(),
                    message: "Nested link detected — CommonMark does not allow links inside links"
                        .into(),
                });
            }
        }
    }
}

/// Detect paragraphs that likely fell out of a list due to incorrect indentation.
fn check_list_continuation<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    for node in root.descendants() {
        let is_list = matches!(node.data.borrow().value, NodeValue::List(_));
        if !is_list {
            continue;
        }

        let list_end = node.data.borrow().sourcepos.end.line;

        // Check next sibling: if it's a paragraph starting right after the list, flag it
        if let Some(next) = node.next_sibling() {
            let next_ast = next.data.borrow();
            if matches!(next_ast.value, NodeValue::Paragraph) {
                let para_start = next_ast.sourcepos.start.line;
                // Paragraph immediately follows list (no blank line or just one blank line)
                if para_start <= list_end + 2 {
                    diagnostics.push(ComrakDiagnostic {
                        line: para_start,
                        severity: "info".into(),
                        message: "Paragraph immediately after list — may be an unintended list continuation (check indentation)".into(),
                    });
                }
            }
        }
    }
}

/// Detect blockquotes immediately followed by a paragraph with no blank line separation.
fn check_blockquote_boundary<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    content: &str,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    let lines: Vec<&str> = content.lines().collect();

    for node in root.descendants() {
        let is_bq = matches!(node.data.borrow().value, NodeValue::BlockQuote);
        if !is_bq {
            continue;
        }

        let bq_end = node.data.borrow().sourcepos.end.line;

        if let Some(next) = node.next_sibling() {
            let next_ast = next.data.borrow();
            if matches!(next_ast.value, NodeValue::Paragraph) {
                let para_start = next_ast.sourcepos.start.line;
                // Check if the line between blockquote end and paragraph start is blank
                let has_blank = (bq_end..para_start.saturating_sub(1)).any(|l| {
                    lines
                        .get(l) // 0-indexed: line l+1 in 1-indexed
                        .is_some_and(|s| s.trim().is_empty())
                });
                if !has_blank && para_start == bq_end + 1 {
                    diagnostics.push(ComrakDiagnostic {
                        line: para_start,
                        severity: "info".into(),
                        message: "Paragraph immediately after blockquote — different parsers may interpret this differently".into(),
                    });
                }
            }
        }
    }
}
