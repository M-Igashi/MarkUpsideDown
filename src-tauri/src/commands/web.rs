use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

use super::files::validate_path;
use crate::error::{AppError, Result};

/// Reject responses whose Content-Length exceeds `max_bytes`.
/// If the header is absent the response is allowed through (post-read checks still apply).
fn reject_oversized_response(response: &reqwest::Response, max_bytes: u64) -> Result<()> {
    if let Some(len) = response.content_length() {
        if len > max_bytes {
            return Err(AppError::Validation(format!(
                "Response too large ({len} bytes, max {max_bytes})"
            )));
        }
    }
    Ok(())
}

// --- Shared Worker Request Helper ---

/// Trait for Worker API responses that carry an optional error field.
pub(crate) trait HasWorkerError {
    fn take_error(&mut self) -> Option<String>;
}

/// Send a request to the Worker, parse the JSON response, and check for errors.
pub(crate) async fn worker_request<T: DeserializeOwned + HasWorkerError>(
    request: reqwest::RequestBuilder,
) -> Result<T> {
    let response = request
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Request failed: {e}")))?;

    let status = response.status();
    let mut body: T = response
        .json()
        .await
        .map_err(|e| AppError::Network(format!("Failed to parse response: {e}")))?;

    if !status.is_success() {
        return Err(AppError::Worker(
            body.take_error()
                .unwrap_or_else(|| format!("Worker returned {status}")),
        ));
    }

    Ok(body)
}

// --- Worker Health Check ---

/// Must match WORKER_VERSION in worker/src/index.ts.
const EXPECTED_WORKER_VERSION: u32 = 6;

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
) -> Result<WorkerStatus> {
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
) -> Result<MarkdownResponse> {
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(30))
        .header("Accept", "text/markdown")
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

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

    let body = response
        .text()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

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

impl HasWorkerError for RenderWorkerResponse {
    fn take_error(&mut self) -> Option<String> { self.error.take() }
}

#[tauri::command]
pub async fn fetch_rendered_url_as_markdown(
    url: String,
    worker_url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String> {
    let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&url));

    let body: RenderWorkerResponse = worker_request(
        client.get(&render_url).timeout(Duration::from_secs(60)),
    )
    .await?;

    body.markdown
        .ok_or_else(|| AppError::Worker("No markdown in response".into()))
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

impl HasWorkerError for FetchWorkerResponse {
    fn take_error(&mut self) -> Option<String> { self.error.take() }
}

#[tauri::command]
pub async fn fetch_url_via_worker(
    url: String,
    worker_url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<WorkerFetchResult> {
    let fetch_url = format!("{}/fetch", worker_url.trim_end_matches('/'));

    let body: FetchWorkerResponse = worker_request(
        client
            .post(&fetch_url)
            .timeout(Duration::from_secs(60))
            .json(&serde_json::json!({ "url": url })),
    )
    .await?;

    Ok(WorkerFetchResult {
        markdown: body
            .markdown
            .ok_or_else(|| AppError::Worker("No markdown in response".into()))?,
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

impl HasWorkerError for JsonWorkerResponse {
    fn take_error(&mut self) -> Option<String> { self.error.take() }
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
) -> Result<JsonExtractResult> {
    let json_url = format!("{}/json", worker_url.trim_end_matches('/'));

    let mut req_body = serde_json::json!({ "url": url });
    if let Some(ref p) = prompt {
        req_body["prompt"] = serde_json::json!(p);
    }
    if let Some(ref rf) = response_format {
        req_body["response_format"] = rf.clone();
    }

    let resp: JsonWorkerResponse = worker_request(
        client
            .post(&json_url)
            .timeout(Duration::from_secs(60))
            .json(&req_body),
    )
    .await?;

    Ok(JsonExtractResult {
        data: resp
            .data
            .ok_or_else(|| AppError::Worker("No data in response".into()))?,
    })
}

// --- Fetch Page Title ---

const MAX_TITLE_FETCH_SIZE: u64 = 65_536; // 64 KB

pub async fn fetch_page_title_with(client: &reqwest::Client, url: &str) -> Result<String> {
    let validated_url = validate_url(url)?;
    let response = client
        .get(validated_url)
        .timeout(Duration::from_secs(10))
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Failed to fetch: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::Network(format!("HTTP {}", response.status())));
    }

    reject_oversized_response(&response, MAX_TITLE_FETCH_SIZE)?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Network(format!("Failed to read body: {e}")))?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_TITLE_FETCH_SIZE as usize)]);

    crate::util::extract_html_title(&text)
}

#[tauri::command]
pub async fn fetch_page_title(
    url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String> {
    fetch_page_title_with(&client, &url).await
}

// --- Download Image to Local File ---

const MAX_IMAGE_SIZE: u64 = 50 * 1_024 * 1_024; // 50 MB

pub async fn download_image_with(
    client: &reqwest::Client,
    url: &str,
    dest_path: &str,
) -> Result<String> {
    let validated_url = validate_url(url)?;
    let validated_path = validate_path(dest_path)?;
    let dest_path = validated_path
        .to_str()
        .ok_or(AppError::Validation("Invalid path encoding".into()))?;
    let response = client
        .get(validated_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Failed to fetch image: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::Network(format!("HTTP {}", response.status())));
    }

    reject_oversized_response(&response, MAX_IMAGE_SIZE)?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Network(format!("Failed to read image: {e}")))?;

    if let Some(parent) = std::path::Path::new(dest_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;
    }

    tokio::fs::write(dest_path, &bytes)
        .await
        .map_err(|e| AppError::Io(format!("Failed to write image: {e}")))?;

    Ok(dest_path.to_string())
}

#[tauri::command]
pub async fn download_image(
    url: String,
    dest_path: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String> {
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

impl HasWorkerError for ConvertWorkerResponse {
    fn take_error(&mut self) -> Option<String> { self.error.take() }
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
) -> Result<ConvertResponse> {
    let path = std::path::Path::new(&file_path);
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError::Io(format!("Failed to read file: {e}")))?;
    let original_size = bytes.len();

    let mime_type = mime_from_extension(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or(""),
    )
    .ok_or_else(|| AppError::Validation(format!("Unsupported file extension: {}", file_path)))?;

    let body: ConvertWorkerResponse = worker_request(
        client
            .post(format!("{worker_url}/convert"))
            .timeout(Duration::from_secs(120))
            .header("Content-Type", mime_type)
            .body(bytes),
    )
    .await?;

    Ok(ConvertResponse {
        markdown: body.markdown.unwrap_or_default(),
        is_image: body.is_image.unwrap_or(false),
        original_size,
        warning: body.warning,
    })
}

#[tauri::command]
pub fn detect_file_is_image(file_path: String) -> Result<bool> {
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
) -> Result<String> {
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Failed to fetch SVG: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::Network(format!("HTTP {}", response.status())));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !content_type.contains("svg") && !content_type.contains("xml") {
        return Err(AppError::Validation(format!(
            "Not an SVG (content-type: {content_type})"
        )));
    }

    reject_oversized_response(&response, MAX_SVG_SIZE as u64)?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

    if bytes.len() > MAX_SVG_SIZE {
        return Err(AppError::Validation(format!(
            "SVG too large ({} bytes, max {})",
            bytes.len(),
            MAX_SVG_SIZE
        )));
    }

    let svg_text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::Validation("SVG contains invalid UTF-8".into()))?;

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
            break; // no closing tag -- drop the rest
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

/// Parse and validate a URL, ensuring only http/https schemes are used.
/// Returns a new `reqwest::Url` to break the taint chain from raw user input.
fn validate_url(url: &str) -> Result<reqwest::Url> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| AppError::Validation(format!("Invalid URL: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        scheme => Err(AppError::Validation(format!(
            "Invalid URL scheme '{scheme}': only http and https are allowed"
        ))),
    }
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
) -> Result<Option<UpdateInfo>> {
    let resp = client
        .get("https://api.github.com/repos/M-Igashi/markupsidedown/releases/latest")
        .header("User-Agent", "markupsidedown")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;

    if !resp.status().is_success() {
        return Ok(None);
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;
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
