use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

use super::files::validate_path;
use crate::error::{AppError, Result};

fn too_large(max_bytes: usize) -> AppError {
    AppError::Validation(format!("Response too large (max {max_bytes} bytes)"))
}

/// Read the body chunk by chunk, since Content-Length may be absent (chunked
/// encoding). Past `max_bytes` it fails, or with `truncate` keeps the first
/// `max_bytes` and stops reading.
async fn read_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
    truncate: bool,
) -> Result<Vec<u8>> {
    if !truncate
        && response
            .content_length()
            .is_some_and(|len| len > max_bytes as u64)
    {
        return Err(too_large(max_bytes));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::Network(format!("Failed to read body: {e}")))?
    {
        if body.len() + chunk.len() > max_bytes {
            if !truncate {
                return Err(too_large(max_bytes));
            }
            body.extend_from_slice(&chunk[..max_bytes - body.len()]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

// --- Shared Worker Request Helper ---

/// Trait for Worker API responses that carry an optional error field.
pub(crate) trait HasWorkerError {
    fn take_error(&mut self) -> Option<String>;
}

/// Attach the Worker API key, if configured, as a bearer token.
fn with_worker_key(request: reqwest::RequestBuilder, worker_key: Option<&str>) -> reqwest::RequestBuilder {
    match worker_key.filter(|k| !k.is_empty()) {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

/// Send a request to the Worker, parse the JSON response, and check for errors.
pub(crate) async fn worker_request<T: DeserializeOwned + HasWorkerError>(
    request: reqwest::RequestBuilder,
    worker_key: Option<&str>,
) -> Result<T> {
    let response = with_worker_key(request, worker_key)
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

/// Must match WORKER_VERSION in worker/src/config.ts.
const EXPECTED_WORKER_VERSION: u32 = 15;

#[derive(Serialize, Default)]
pub struct WorkerStatus {
    pub reachable: bool,
    pub convert_available: bool,
    pub render_available: bool,
    pub json_available: bool,
    pub crawl_available: bool,
    pub publish_available: bool,
    pub search_available: bool,
    pub worker_version: Option<u32>,
    pub update_available: bool,
    /// API key check result from /health: "valid", "invalid", "missing", or
    /// "unconfigured". None for Workers older than v12 (no auth support).
    pub auth: Option<String>,
    pub error: Option<String>,
}

impl WorkerStatus {
    fn unreachable(error: String) -> Self {
        Self {
            error: Some(error),
            ..Default::default()
        }
    }
}

#[derive(Deserialize, Default)]
struct HealthCapabilities {
    convert: Option<bool>,
    render: Option<bool>,
    json: Option<bool>,
    crawl: Option<bool>,
    publish: Option<bool>,
    search: Option<bool>,
}

#[derive(Deserialize)]
struct HealthResponse {
    version: Option<u32>,
    auth: Option<String>,
    capabilities: Option<HealthCapabilities>,
}

#[tauri::command]
pub async fn test_worker_url(
    worker_url: String,
    worker_key: Option<String>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<WorkerStatus> {
    let health_url = format!("{}/health", worker_url.trim_end_matches('/'));
    let request = with_worker_key(client.get(&health_url), worker_key.as_deref());

    Ok(match request.timeout(Duration::from_secs(10)).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<HealthResponse>().await {
                Ok(body) => {
                    let caps = body.capabilities.unwrap_or_default();
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
                        publish_available: caps.publish.unwrap_or(false),
                        search_available: caps.search.unwrap_or(false),
                        worker_version: version,
                        update_available,
                        auth: body.auth,
                        error: None,
                    }
                }
                Err(e) => WorkerStatus {
                    reachable: true,
                    update_available: true,
                    error: Some(format!("Unexpected response format: {e}")),
                    ..Default::default()
                }
            }
        }
        Ok(resp) => WorkerStatus {
            reachable: true,
            error: Some(format!("Worker returned status {}", resp.status())),
            ..Default::default()
        },
        Err(e) => WorkerStatus::unreachable(format!("Cannot reach worker: {e}")),
    })
}

// --- Cloudflare Markdown for Agents ---

#[derive(Serialize)]
pub struct MarkdownResponse {
    pub body: String,
    pub is_markdown: bool,
}

const MAX_MARKDOWN_FETCH_SIZE: usize = 20 * 1_024 * 1_024; // 20 MB

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

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let body = read_body_limited(response, MAX_MARKDOWN_FETCH_SIZE, false).await?;

    Ok(MarkdownResponse {
        body: String::from_utf8_lossy(&body).into_owned(),
        is_markdown: content_type.contains("text/markdown"),
    })
}

// --- Browser Run (JS-rendered pages) ---

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
    worker_key: Option<String>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<String> {
    let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&url));

    let body: RenderWorkerResponse = worker_request(
        client.get(&render_url).timeout(Duration::from_secs(60)),
        worker_key.as_deref(),
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
    worker_key: Option<String>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<WorkerFetchResult> {
    let fetch_url = format!("{}/fetch", worker_url.trim_end_matches('/'));

    let body: FetchWorkerResponse = worker_request(
        client
            .post(&fetch_url)
            .timeout(Duration::from_secs(60))
            .json(&serde_json::json!({ "url": url })),
        worker_key.as_deref(),
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

// --- Fetch Page Title ---

const MAX_TITLE_FETCH_SIZE: usize = 65_536; // 64 KB

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

    let bytes = read_body_limited(response, MAX_TITLE_FETCH_SIZE, true).await?;
    let text = String::from_utf8_lossy(&bytes);

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

const MAX_IMAGE_SIZE: usize = 50 * 1_024 * 1_024; // 50 MB

pub async fn download_image_with(
    client: &reqwest::Client,
    url: &str,
    dest_path: &str,
) -> Result<String> {
    let validated_url = validate_url(url)?;
    let validated_path = validate_path(dest_path)?;
    let response = client
        .get(validated_url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| AppError::Network(format!("Failed to fetch image: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::Network(format!("HTTP {}", response.status())));
    }

    let bytes = read_body_limited(response, MAX_IMAGE_SIZE, false).await?;

    if let Some(parent) = validated_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;
    }

    tokio::fs::write(&validated_path, &bytes)
        .await
        .map_err(|e| AppError::Io(format!("Failed to write image: {e}")))?;

    Ok(validated_path.to_string_lossy().to_string())
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
    worker_key: Option<String>,
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
        worker_key.as_deref(),
    )
    .await?;

    Ok(ConvertResponse {
        markdown: body.markdown.unwrap_or_default(),
        is_image: body.is_image.unwrap_or(false),
        original_size,
        warning: body.warning,
    })
}

/// MIME map (sync with mcp-server-rs/src/tools.rs and worker SUPPORTED_TYPES)
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
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

// --- SVG Fetch & Sanitize ---

const MAX_SVG_SIZE: usize = 1_024 * 1_024; // 1 MB

/// Loopback, private, link-local, and other non-public addresses.
fn is_non_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64) // 100.64.0.0/10
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_non_public_ip(v4.into());
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00 // fc00::/7 unique local
                || (first & 0xffc0) == 0xfe80 // fe80::/10 link-local
        }
    }
}

/// True for URLs whose host is a non-public IP literal or a local name.
fn is_local_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return true };
    // IPv6 literals keep their brackets in host_str()
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return is_non_public_ip(ip);
    }
    let d = host.trim_end_matches('.').to_ascii_lowercase();
    d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local")
}

/// Images in a document are fetched without any user action, so a document
/// must not be able to make the app send requests to localhost (the MCP
/// bridge) or the LAN.
async fn ensure_public_url(url: &reqwest::Url) -> Result<()> {
    let blocked = || AppError::Validation("Refusing to fetch an image from a local or private address".into());
    if is_local_url(url) {
        return Err(blocked());
    }
    let host = url.host_str().unwrap_or_default();
    if !host.starts_with('[') && host.parse::<std::net::IpAddr>().is_err() {
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| AppError::Network(format!("Failed to resolve {host}: {e}")))?;
        if addrs.into_iter().any(|a| is_non_public_ip(a.ip())) {
            return Err(blocked());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn fetch_svg(url: String) -> Result<String> {
    let url = validate_url(&url)?;
    ensure_public_url(&url).await?;
    // Own client so redirects can be checked too
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || is_local_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| AppError::Network(e.to_string()))?;
    let response = client
        .get(url)
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

    let bytes = read_body_limited(response, MAX_SVG_SIZE, false).await?;

    let svg_text = String::from_utf8(bytes)
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

/// Version of the app bundle on disk, which may differ from the running
/// process after a `brew upgrade`. Returns None outside a macOS .app bundle
/// (e.g. dev builds).
#[tauri::command]
pub fn get_bundle_version() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let plist = exe.parent()?.parent()?.join("Info.plist");
    let content = std::fs::read_to_string(plist).ok()?;
    let rest = &content[content.find("<key>CFBundleShortVersionString</key>")?..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = start + rest[start..].find("</string>")?;
    Some(rest[start..end].trim().to_string())
}

#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn local(u: &str) -> bool {
        is_local_url(&reqwest::Url::parse(u).unwrap())
    }

    #[test]
    fn blocks_local_and_private_image_hosts() {
        for u in [
            "http://127.0.0.1:31415/worker?x=.svg",
            "http://localhost/a.svg",
            "http://foo.localhost/a.svg",
            "http://printer.local/a.svg",
            "http://10.0.0.1/a.svg",
            "http://192.168.1.1/a.svg",
            "http://169.254.169.254/a.svg",
            "http://[::1]/a.svg",
            "http://[fd00::1]/a.svg",
            "http://[::ffff:127.0.0.1]/a.svg",
            "http://0.0.0.0/a.svg",
            "http://2130706433/a.svg",
        ] {
            assert!(local(u), "{u} should be blocked");
        }
    }

    #[test]
    fn allows_public_image_hosts() {
        for u in ["https://img.shields.io/badge/a-b-c.svg", "https://1.1.1.1/a.svg", "https://[2606:4700::1111]/a.svg"] {
            assert!(!local(u), "{u} should be allowed");
        }
    }
}
