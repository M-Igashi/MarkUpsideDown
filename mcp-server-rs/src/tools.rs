use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock as Content, Implementation, ServerCapabilities, ServerInfo};
use rmcp::schemars;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::{Deserialize, Serialize};

use crate::bridge::BridgeClient;

/// MIME map (sync with commands.rs and worker SUPPORTED_TYPES)
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

/// Truncate to at most `max` characters, respecting UTF-8 char boundaries.
fn truncate_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Wrap a tool outcome: Ok text becomes a success result, Err an error result.
fn text_result(r: Result<impl Into<String>, String>) -> Result<CallToolResult, rmcp::ErrorData> {
    Ok(match r {
        Ok(text) => CallToolResult::success(vec![Content::text(text)]),
        Err(e) => CallToolResult::error(vec![Content::text(e)]),
    })
}

/// Like `text_result`, rendering the Ok value as pretty-printed JSON.
fn json_result(r: Result<impl Serialize, String>) -> Result<CallToolResult, rmcp::ErrorData> {
    text_result(r.map(|v| pretty_json(&v)))
}

/// Like `text_result`, replacing empty command output with `default`.
fn output_result(r: Result<String, String>, default: impl Into<String>) -> Result<CallToolResult, rmcp::ErrorData> {
    text_result(r.map(|out| if out.is_empty() { default.into() } else { out }))
}

fn pretty_json(value: &impl Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// Send a Worker request and surface the Worker's `error` field on
/// non-success status. Tolerates empty or non-JSON bodies (e.g. DELETE
/// responses) by returning Null.
async fn worker_send(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let response = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    if !status.is_success() {
        let err = data["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("Worker returned {status}: {err}"));
    }
    Ok(data)
}

/// Worker base URL plus the API key it requires on non-public routes.
#[derive(Clone)]
struct WorkerTarget {
    url: String,
    key: Option<String>,
}

impl WorkerTarget {
    fn request(&self, http: &reqwest::Client, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let req = http.request(method, format!("{}{path}", self.url.trim_end_matches('/')));
        match &self.key {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }
}

/// Accept a JSON Schema as either an object or a JSON-encoded string.
/// MCP clients vary in how they pass nested schemas, so we tolerate both.
fn parse_schema_param(value: serde_json::Value) -> Result<serde_json::Value, String> {
    match value {
        serde_json::Value::String(s) => serde_json::from_str(&s)
            .map_err(|e| format!("Invalid response_format JSON string: {e}")),
        other => Ok(other),
    }
}

// --- Parameter types ---

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetContentParams {
    #[schemars(description = "Markdown content to set")]
    pub markdown: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct InsertTextParams {
    #[schemars(description = "Text to insert")]
    pub text: String,
    #[schemars(description = "Where to insert: cursor, start, or end (default: end)")]
    pub position: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UrlParams {
    #[schemars(description = "URL to fetch")]
    pub url: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct FilePathParams {
    #[schemars(description = "Absolute path to the file to convert")]
    pub file_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenFileParams {
    #[schemars(description = "Absolute path to the Markdown file")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SaveFileParams {
    #[schemars(description = "File path to save to (uses current file if omitted)")]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CrawlWebsiteParams {
    #[schemars(description = "URL to start crawling from")]
    pub url: String,
    #[schemars(description = "Maximum crawl depth (default: 1)")]
    pub depth: Option<u32>,
    #[schemars(description = "Maximum number of pages to crawl (default: 10)")]
    pub limit: Option<u32>,
    #[schemars(description = "Whether to use JavaScript rendering for crawled pages (default: false)")]
    pub render: Option<bool>,
    #[schemars(description = "URL patterns to include (glob syntax)")]
    pub include_patterns: Option<Vec<String>>,
    #[schemars(description = "URL patterns to exclude (glob syntax)")]
    pub exclude_patterns: Option<Vec<String>>,
    #[schemars(description = "Output formats: [\"markdown\"], [\"json\"], or [\"markdown\", \"json\"] (default: [\"markdown\"])")]
    pub formats: Option<Vec<String>>,
    #[schemars(description = "JSON Schema defining the output structure when formats includes \"json\". Accepts either a JSON object or a JSON-encoded string.")]
    pub response_format: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExtractJsonParams {
    #[schemars(description = "URL of the web page to extract structured data from")]
    pub url: String,
    #[schemars(description = "Natural language description of what to extract (e.g., \"Extract all product names and prices\")")]
    pub prompt: Option<String>,
    #[schemars(description = "JSON Schema defining the expected output structure. Accepts either a JSON object or a JSON-encoded string.")]
    pub response_format: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CrawlStatusParams {
    #[schemars(description = "Job ID returned by crawl_website")]
    pub job_id: String,
    #[schemars(description = "Pagination cursor from a previous crawl_status response")]
    pub cursor: Option<String>,
    #[schemars(description = "Max number of records per page (default 10, max 100)")]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CrawlCancelParams {
    #[schemars(description = "Job ID returned by crawl_website")]
    pub job_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListDirectoryParams {
    #[schemars(description = "Directory path (absolute or relative to project root). Defaults to project root.")]
    pub path: Option<String>,
    #[schemars(description = "Whether to list recursively (default: false)")]
    pub recursive: Option<bool>,
    #[schemars(description = "Maximum number of entries to return (default: 1000)")]
    pub max_entries: Option<usize>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadFileParams {
    #[schemars(description = "File path (absolute or relative to project root)")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SwitchTabParams {
    #[schemars(description = "File path of the tab to switch to")]
    pub path: Option<String>,
    #[schemars(description = "Tab ID to switch to")]
    pub tab_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchFilesParams {
    #[schemars(description = "Search query (substring match against file names)")]
    pub query: String,
    #[schemars(description = "Directory to search in (defaults to project root)")]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateFileParams {
    #[schemars(description = "Absolute path for the new file")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateDirectoryParams {
    #[schemars(description = "Absolute path for the new directory")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RenameEntryParams {
    #[schemars(description = "Current absolute path")]
    pub from: String,
    #[schemars(description = "New absolute path")]
    pub to: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DeleteEntryParams {
    #[schemars(description = "Absolute path to delete (moved to trash)")]
    pub path: String,
    #[schemars(description = "Whether the entry is a directory (default: false)")]
    pub is_dir: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CopyEntryParams {
    #[schemars(description = "Absolute path of the source file or directory")]
    pub from: String,
    #[schemars(description = "Absolute path of the destination directory")]
    pub to_dir: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DuplicateEntryParams {
    #[schemars(description = "Absolute path to duplicate")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitFileParams {
    #[schemars(description = "File path to stage/unstage (relative to repo root)")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitCommitParams {
    #[schemars(description = "Commit message")]
    pub message: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitDiffParams {
    #[schemars(description = "File path (relative to repo root)")]
    pub path: String,
    #[schemars(description = "If true, show staged diff; otherwise show unstaged diff")]
    pub staged: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitLogParams {
    #[schemars(description = "Number of recent commits to return (default: 10)")]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitRevertParams {
    #[schemars(description = "Full commit hash to revert")]
    pub commit_hash: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitHubListParams {
    #[schemars(description = "Item kind: issue or pr (default: issue)")]
    pub kind: Option<String>,
    #[schemars(description = "State filter: open, closed, merged (pr only), or all (default: open)")]
    pub state: Option<String>,
    #[schemars(description = "Maximum number of items to return (default: 50, max: 200)")]
    pub limit: Option<u32>,
    #[schemars(description = "GitHub search query, e.g. \"label:bug author:octocat\"")]
    pub search: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitHubViewParams {
    #[schemars(description = "Item kind: issue or pr (default: issue)")]
    pub kind: Option<String>,
    #[schemars(description = "Issue or pull request number")]
    pub number: u64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitHubUpdateParams {
    #[schemars(description = "Item kind: issue or pr (default: issue)")]
    pub kind: Option<String>,
    #[schemars(description = "Issue or pull request number")]
    pub number: u64,
    #[schemars(description = "New title")]
    pub title: String,
    #[schemars(description = "New body in Markdown (replaces the existing body)")]
    pub body: String,
    #[schemars(
        description = "Body the update is based on. When given, the update is rejected if the body changed on GitHub in the meantime."
    )]
    pub expected_body: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CrawlSaveParams {
    #[schemars(description = "Array of pages to save, each with url and markdown fields")]
    pub pages: Vec<CrawlSavePageParam>,
    #[schemars(description = "Base directory to save files into")]
    pub base_dir: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct CrawlSavePageParam {
    #[schemars(description = "URL of the page")]
    pub url: String,
    #[schemars(description = "Markdown content of the page")]
    pub markdown: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DownloadImageParams {
    #[schemars(description = "URL of the image to download")]
    pub url: String,
    #[schemars(description = "Local file path to save the image to")]
    pub dest_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetFileTagsParams {
    #[schemars(description = "Absolute path to the file or directory")]
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetFileTagsParams {
    #[schemars(description = "Absolute path to the file or directory")]
    pub path: String,
    #[schemars(description = "Tag names to assign (replaces existing tags for this file)")]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateTagParams {
    #[schemars(description = "Tag name (max 24 characters)")]
    pub name: String,
    #[schemars(description = "Tag color as hex string (e.g., \"#d94545\"). Defaults to red if omitted.")]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DeleteTagParams {
    #[schemars(description = "Tag name to delete (also removes from all files)")]
    pub name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SemanticSearchParams {
    #[schemars(description = "Natural language search query")]
    pub query: String,
    #[schemars(description = "Maximum number of results to return (default: 10)")]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct IndexDocumentsParams {
    #[schemars(description = "Array of documents to index. Each document needs an 'id' (unique identifier, e.g. file path) and 'content' (Markdown text). Re-indexing an id replaces its previous content.")]
    pub documents: Vec<IndexDocumentEntry>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct IndexDocumentEntry {
    #[schemars(description = "Unique document identifier (e.g., file path or URL)")]
    pub id: String,
    #[schemars(description = "Markdown content to index")]
    pub content: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RemoveDocumentParams {
    #[schemars(description = "Document ID to remove from the search index")]
    pub id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PublishDocumentParams {
    #[schemars(description = "Unique key for the published document (used in the public URL)")]
    pub key: String,
    #[schemars(description = "Markdown content to publish")]
    pub content: String,
    #[schemars(description = "Display filename (default: untitled.md)")]
    pub filename: Option<String>,
    #[schemars(description = "Time-to-live in seconds (omit or 0 for permanent). Examples: 3600 = 1h, 86400 = 24h, 604800 = 7d")]
    pub expires_in: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UnpublishDocumentParams {
    #[schemars(description = "Key of the published document to remove")]
    pub key: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitShowParams {
    #[schemars(description = "Full commit hash to show")]
    pub commit_hash: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitCloneParams {
    #[schemars(description = "Repository URL to clone")]
    pub url: String,
    #[schemars(description = "Local directory path to clone into")]
    pub dest: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitInitParams {
    #[schemars(description = "Directory path to initialize as a git repository")]
    pub path: String,
}

// --- Server ---

pub struct McpTools {
    bridge: BridgeClient,
    http: reqwest::Client,
    worker_url_env: Option<String>,
    worker_key_env: Option<String>,
    cached_worker: std::sync::Mutex<Option<(WorkerTarget, std::time::Instant)>>,
}

#[tool_router]
impl McpTools {
    pub fn new() -> Self {
        let env = |name| std::env::var(name).ok().filter(|v: &String| !v.is_empty());
        let http = reqwest::Client::new();
        Self {
            bridge: BridgeClient::new(http.clone()),
            http,
            worker_url_env: env("MARKUPSIDEDOWN_WORKER_URL"),
            worker_key_env: env("MARKUPSIDEDOWN_WORKER_KEY"),
            cached_worker: std::sync::Mutex::new(None),
        }
    }

    /// Resolve the Worker URL and API key. Env vars win; anything missing is
    /// taken from the running app via the bridge (cached for 60 seconds).
    async fn resolve_worker(&self) -> Result<WorkerTarget, String> {
        if let (Some(url), Some(key)) = (&self.worker_url_env, &self.worker_key_env) {
            return Ok(WorkerTarget { url: url.clone(), key: Some(key.clone()) });
        }
        {
            let cache = self.cached_worker.lock().unwrap();
            if let Some((ref target, ref ts)) = *cache {
                if ts.elapsed() < std::time::Duration::from_secs(60) {
                    return Ok(target.clone());
                }
            }
        }
        let bridge = self.bridge.get_worker_config().await.unwrap_or_default();
        let url = self.worker_url_env.clone().or(bridge.url).ok_or_else(|| {
            "Worker URL not configured. Set MARKUPSIDEDOWN_WORKER_URL env var or configure in app Settings.".to_string()
        })?;
        let target = WorkerTarget { url, key: self.worker_key_env.clone().or(bridge.key) };
        *self.cached_worker.lock().unwrap() = Some((target.clone(), std::time::Instant::now()));
        Ok(target)
    }

    /// Call a Worker endpoint with an optional JSON body (see `worker_send`).
    async fn worker_call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        timeout_secs: u64,
    ) -> Result<serde_json::Value, String> {
        let mut req = self
            .resolve_worker()
            .await?
            .request(&self.http, method, path)
            .timeout(std::time::Duration::from_secs(timeout_secs));
        if let Some(body) = body {
            req = req.json(&body);
        }
        worker_send(req).await
    }

    /// GET /render for a URL via the Worker and return the rendered Markdown.
    async fn render_via_worker(&self, url: &str) -> Result<String, String> {
        let data = self
            .worker_call(
                reqwest::Method::GET,
                &format!("/render?url={}", urlencoding::encode(url)),
                None,
                60,
            )
            .await?;
        Ok(data["markdown"].as_str().unwrap_or_default().to_string())
    }

    /// Resolve an absolute path to a path relative to the project root
    /// (used by the tag tools, which key files by relative path).
    async fn resolve_rel_path(&self, path: &str) -> String {
        let root = self.bridge.get_project_root().await.ok().flatten().unwrap_or_default();
        if !root.is_empty() && path.starts_with(&root) {
            path[root.len()..].trim_start_matches('/').to_string()
        } else {
            path.to_string()
        }
    }

    /// GET a URL with `Accept: text/markdown` (Markdown for Agents).
    /// Returns (content_type, x-markdown-tokens header, body).
    async fn fetch_with_markdown_accept(
        &self,
        url: &str,
    ) -> Result<(String, Option<String>, String), String> {
        let response = self
            .http
            .get(url)
            .header("Accept", "text/markdown")
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let tokens = response
            .headers()
            .get("x-markdown-tokens")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = response.text().await.map_err(|e| e.to_string())?;
        Ok((content_type, tokens, body))
    }

    // --- Editor Tools (require running app) ---

    #[tool(name = "get_editor_content", description = "Get current Markdown content from the editor", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_editor_content(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.get_editor_content().await)
    }

    #[tool(name = "set_editor_content", description = "Replace the editor content with the provided Markdown", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn set_editor_content(
        &self,
        Parameters(params): Parameters<SetContentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.set_editor_content(&params.markdown).await.map(|()| "Editor content updated"))
    }

    #[tool(name = "insert_text", description = "Insert text at cursor position, start, or end of the editor", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn insert_text(
        &self,
        Parameters(params): Parameters<InsertTextParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.insert_text(&params.text, params.position.as_deref()).await.map(|()| "Text inserted"))
    }

    // --- Conversion Tools (use Worker, no app needed) ---

    #[tool(name = "fetch_markdown", description = "Fetch a URL as Markdown (static only, no JS rendering). Use get_markdown instead for automatic SPA detection.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn fetch_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let (content_type, tokens, body) = self.fetch_with_markdown_accept(&params.url).await?;

            let is_markdown = content_type.contains("text/markdown");
            let mut info = if is_markdown {
                "Markdown".to_string()
            } else {
                "HTML (no Markdown for Agents support)".to_string()
            };
            if let Some(t) = tokens {
                info.push_str(&format!(" | {t} tokens"));
            }

            Ok::<_, String>(format!("--- {info} ---\n\n{body}"))
        }
        .await;

        text_result(result)
    }

    #[tool(name = "render_markdown", description = "Fetch a JavaScript-rendered page as Markdown via Browser Run (explicit). Use get_markdown instead for automatic SPA detection.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn render_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.render_via_worker(&params.url).await)
    }

    #[tool(name = "get_markdown", description = "Fetch a URL and return its content as Markdown. Automatically detects JavaScript-rendered pages and uses Browser Run when available. Recommended over fetch_markdown/render_markdown for most use cases.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn get_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        // 1. Worker /fetch: passes Markdown for Agents through, otherwise
        //    converts HTML with AI.toMarkdown and reports SPA detection.
        let worker_err = match self.resolve_worker().await {
            Err(_) => None,
            Ok(_) => {
                let body = serde_json::json!({ "url": params.url });
                match self.worker_call(reqwest::Method::POST, "/fetch", Some(body), 30).await {
                    Ok(data) => {
                        let markdown = data["markdown"].as_str().unwrap_or_default();
                        if data["source"] == "markdown-for-agents" {
                            return text_result(Ok(format!("--- Markdown for Agents ---\n\n{markdown}")));
                        }
                        // SPA detected: try Browser Run, falling back to the fetch result
                        if data["spa_detected"] == true
                            && let Ok(rendered) = self.render_via_worker(&params.url).await
                            && !rendered.is_empty()
                        {
                            return text_result(Ok(format!("--- Browser Run (auto) ---\n\n{rendered}")));
                        }
                        return text_result(Ok(format!("--- AI.toMarkdown ---\n\n{markdown}")));
                    }
                    Err(e) => Some(e),
                }
            }
        };

        // 2. No Worker, or the Worker failed (e.g. its SSRF check rejected an
        //    intranet URL): fetch directly, still asking for Markdown for Agents.
        let result = self.fetch_with_markdown_accept(&params.url).await.map(|(content_type, _, body)| {
            let label = match &worker_err {
                _ if content_type.contains("text/markdown") => "Markdown for Agents".to_string(),
                None => "raw HTML (no Worker)".to_string(),
                Some(e) => format!("raw HTML (Worker failed: {e})"),
            };
            format!("--- {label} ---\n\n{body}")
        });
        text_result(result.map_err(|e| match worker_err {
            Some(w) => format!("{e} (Worker failed: {w})"),
            None => e,
        }))
    }

    #[tool(name = "convert_to_markdown", description = "Convert a local document (PDF, DOCX, XLSX, HTML, CSV, XML, images) to Markdown via Workers AI. The file is uploaded to the Cloudflare Worker for conversion.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn convert_to_markdown(
        &self,
        Parameters(params): Parameters<FilePathParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker = self.resolve_worker().await?;

            let ext = std::path::Path::new(&params.file_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let mime = mime_from_extension(&ext)
                .ok_or_else(|| format!("Unsupported file type: .{ext}"))?;

            let bytes = tokio::fs::read(&params.file_path)
                .await
                .map_err(|e| format!("Failed to read file: {e}"))?;

            let req = worker
                .request(&self.http, reqwest::Method::POST, "/convert")
                .header("Content-Type", mime)
                .timeout(std::time::Duration::from_secs(60))
                .body(bytes);
            let data = worker_send(req).await?;

            let md = data["markdown"].as_str().unwrap_or_default();
            match data["warning"].as_str() {
                Some(w) => Ok(format!("⚠ {w}\n\n{md}")),
                None => Ok(md.to_string()),
            }
        }
        .await;

        text_result(result)
    }

    // --- File Tools (require running app) ---

    #[tool(name = "open_file", description = "Open a Markdown file in the editor", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn open_file(
        &self,
        Parameters(params): Parameters<OpenFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.open_file(&params.path).await.map(|()| format!("Opened: {}", params.path)))
    }

    #[tool(name = "save_file", description = "Save the current editor content to a file", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn save_file(
        &self,
        Parameters(params): Parameters<SaveFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.save_file(params.path.as_deref()).await.map(|()| match &params.path {
            Some(p) => format!("Saved to: {p}"),
            None => "File saved".to_string(),
        }))
    }

    #[tool(name = "normalize_document", description = "Normalize the current editor content: fix heading hierarchy, reformat tables, clean up whitespace, remove broken links, standardize list markers, and add CJK emphasis spacing", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn normalize_document(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.normalize_document().await.map(|()| "Document normalized"))
    }

    #[tool(name = "lint_document", description = "Run structural lint checks on the current editor content. Returns diagnostics with line number, severity (error/warning/info), and message. Checks: headings, links, tables, frontmatter, lists, emphasis (CommonMark flanking), code blocks, footnotes, HTML comments, blank lines.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn lint_document(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.lint_document().await.map(|diagnostics| {
            if diagnostics.as_array().map_or(true, |a| a.is_empty()) {
                "No lint issues found".to_string()
            } else {
                pretty_json(&diagnostics)
            }
        }))
    }

    #[tool(name = "get_document_structure", description = "Get the current document's structural information (heading tree, links, frontmatter, stats) as JSON. More efficient than parsing raw Markdown — reduces token usage for structure-aware operations.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_document_structure(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.get_document_structure().await)
    }

    #[tool(name = "get_editor_state", description = "Get the current editor state: file path, cursor position (byte offset, line, column), and Worker URL", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_editor_state(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.get_editor_state().await)
    }

    // --- Project Context Tools (require running app) ---

    #[tool(name = "list_directory", description = "List files and directories in the project. Respects .gitignore. Returns name, path, is_dir, extension for each entry.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn list_directory(
        &self,
        Parameters(params): Parameters<ListDirectoryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.list_files(params.path.as_deref(), params.recursive.unwrap_or(false)).await.map(|mut entries| {
            let max = params.max_entries.unwrap_or(1000);
            let truncated = entries.len() > max;
            entries.truncate(max);
            let header = if truncated {
                format!("{} entries (truncated, limit: {max})", entries.len())
            } else {
                format!("{} entries", entries.len())
            };
            format!("{header}\n\n{}", pretty_json(&entries))
        }))
    }

    #[tool(name = "get_open_tabs", description = "List all open editor tabs with their path, name, and dirty (unsaved) status", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_open_tabs(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.get_tabs().await)
    }

    #[tool(name = "get_project_root", description = "Get the current project root directory path", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_project_root(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.get_project_root().await.and_then(|root| {
            root.ok_or_else(|| "No project root set (no folder opened in sidebar)".to_string())
        }))
    }

    #[tool(name = "read_file", description = "Read a text file from the project. Works for any file, not just the active editor tab.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn read_file(
        &self,
        Parameters(params): Parameters<ReadFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.read_file(&params.path).await)
    }

    #[tool(name = "get_dirty_files", description = "List files with unsaved changes (dirty tabs)", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_dirty_files(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.get_dirty_files().await.map(|files| {
            if files.is_empty() {
                "No unsaved changes".to_string()
            } else {
                format!("{} files with unsaved changes\n\n{}", files.len(), pretty_json(&files))
            }
        }))
    }

    #[tool(name = "switch_tab", description = "Switch the active editor tab by file path or tab ID", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn switch_tab(
        &self,
        Parameters(params): Parameters<SwitchTabParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.switch_tab(params.path.as_deref(), params.tab_id.as_deref()).await.map(|()| "Tab switched"))
    }

    #[tool(name = "git_status", description = "Get git status of the project: branch, file changes (staged/unstaged), ahead/behind counts", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn git_status(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.git_status().await)
    }

    #[tool(name = "search_files", description = "Search file names (not content) in the project by substring match. Does not search file contents. Returns matching file entries with path, name, and metadata.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn search_files(
        &self,
        Parameters(params): Parameters<SearchFilesParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.search_files(&params.query, params.path.as_deref()).await.map(|matches| {
            if matches.is_empty() {
                "No matching files found".to_string()
            } else {
                format!("{} matches\n\n{}", matches.len(), pretty_json(&matches))
            }
        }))
    }

    #[tool(name = "create_file", description = "Create a new empty file. Fails if the file already exists.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn create_file(
        &self,
        Parameters(params): Parameters<CreateFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.create_file(&params.path).await.map(|()| format!("Created: {}", params.path)))
    }

    #[tool(name = "create_directory", description = "Create a new directory. Fails if it already exists.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn create_directory(
        &self,
        Parameters(params): Parameters<CreateDirectoryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.create_directory(&params.path).await.map(|()| format!("Created directory: {}", params.path)))
    }

    #[tool(name = "rename_entry", description = "Rename or move a file or directory", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn rename_entry(
        &self,
        Parameters(params): Parameters<RenameEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.rename_entry(&params.from, &params.to).await.map(|()| format!("Renamed: {} -> {}", params.from, params.to)))
    }

    #[tool(name = "delete_entry", description = "Delete a file or directory (moved to system trash, recoverable)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn delete_entry(
        &self,
        Parameters(params): Parameters<DeleteEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.delete_entry(&params.path, params.is_dir.unwrap_or(false)).await.map(|()| format!("Deleted (moved to trash): {}", params.path)))
    }

    // --- Crawl Tools (use Worker, no app needed) ---

    #[tool(name = "extract_json", description = "Extract structured JSON data from a web page using AI (Workers AI LLM). Requires at least one of prompt or response_format. Note: uses LLM inference per call.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn extract_json(
        &self,
        Parameters(params): Parameters<ExtractJsonParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            if params.prompt.is_none() && params.response_format.is_none() {
                return Err("At least one of 'prompt' or 'response_format' is required".to_string());
            }

            let mut body = serde_json::json!({ "url": params.url });
            if let Some(ref p) = params.prompt {
                body["prompt"] = serde_json::json!(p);
            }
            if let Some(rf) = params.response_format {
                body["response_format"] = parse_schema_param(rf)?;
            }

            let data = self
                .worker_call(reqwest::Method::POST, "/json", Some(body), 120)
                .await?;
            let result = data
                .get("data")
                .filter(|v| !v.is_null())
                .ok_or_else(|| "No data in response".to_string())?;
            Ok(pretty_json(result))
        }
        .await;

        text_result(result)
    }

    #[tool(name = "crawl_website", description = "Start a website crawl job via Browser Run. Returns a job_id to poll with crawl_status, or stop it with crawl_cancel. Supports markdown and/or json output formats.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn crawl_website(
        &self,
        Parameters(params): Parameters<CrawlWebsiteParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result: Result<String, String> = async {
            let mut body = serde_json::json!({
                "url": params.url,
                "depth": params.depth.unwrap_or(1),
                "limit": params.limit.unwrap_or(10),
                "render": params.render.unwrap_or(false),
            });

            if let Some(ref formats) = params.formats {
                body["formats"] = serde_json::json!(formats);
            }
            if let Some(rf) = params.response_format {
                body["response_format"] = parse_schema_param(rf)?;
            }

            if let Some(ref patterns) = params.include_patterns {
                if !patterns.is_empty() {
                    body["includePatterns"] = serde_json::json!(patterns);
                }
            }
            if let Some(ref patterns) = params.exclude_patterns {
                if !patterns.is_empty() {
                    body["excludePatterns"] = serde_json::json!(patterns);
                }
            }

            let data = self
                .worker_call(reqwest::Method::POST, "/crawl", Some(body), 30)
                .await?;
            let job_id = data["job_id"]
                .as_str()
                .ok_or_else(|| "No job_id in response".to_string())?;
            Ok(format!("Crawl started. job_id: {job_id}\n\nUse crawl_status with this job_id to poll for results."))
        }
        .await;

        text_result(result)
    }

    #[tool(name = "crawl_status", description = "Poll a crawl job's status and retrieve completed pages. Returns status, progress, pages (with markdown and/or json depending on crawl formats), and a cursor for pagination.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn crawl_status(
        &self,
        Parameters(params): Parameters<CrawlStatusParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let limit = params.limit.unwrap_or(10);
            let mut status_path = format!("/crawl/{}?limit={limit}&status=completed", params.job_id);
            if let Some(ref c) = params.cursor {
                status_path.push_str(&format!("&cursor={}", urlencoding::encode(c)));
            }
            let data = self.worker_call(reqwest::Method::GET, &status_path, None, 120).await?;

            #[derive(Deserialize)]
            struct Record {
                url: Option<String>,
                markdown: Option<String>,
                json: Option<serde_json::Value>,
            }
            #[derive(Deserialize)]
            struct ResultInner {
                status: Option<String>,
                total: Option<u32>,
                finished: Option<u32>,
                cursor: Option<String>,
                records: Option<Vec<Record>>,
            }
            #[derive(Deserialize)]
            struct Resp {
                result: Option<ResultInner>,
            }
            let data: Resp = serde_json::from_value(data).map_err(|e| format!("Failed to parse response: {e}"))?;
            let inner = data.result.ok_or("No result in response")?;

            let crawl_status = inner.status.as_deref().unwrap_or("unknown");
            let total = inner.total.unwrap_or(0);
            let finished = inner.finished.unwrap_or(0);

            let mut output = format!("Status: {crawl_status} | Progress: {finished}/{total}");
            if let Some(ref cursor) = inner.cursor {
                output.push_str(&format!("\nNext cursor: {cursor}"));
            }

            let records = inner.records.unwrap_or_default();
            if !records.is_empty() {
                output.push_str(&format!("\n\n--- {} pages ---", records.len()));
                for r in &records {
                    if let Some(ref url) = r.url {
                        output.push_str(&format!("\n\n## {url}"));
                        if let Some(ref md) = r.markdown {
                            let preview = truncate_chars(md, 200);
                            output.push_str(&format!("\n{preview}"));
                            if preview.len() < md.len() {
                                output.push_str("...");
                            }
                        }
                        if let Some(ref json) = r.json {
                            let json_str = pretty_json(json);
                            let preview = truncate_chars(&json_str, 500);
                            output.push_str(&format!("\n```json\n{preview}"));
                            if preview.len() < json_str.len() {
                                output.push_str("...");
                            }
                            output.push_str("\n```");
                        }
                    }
                }
            }

            Ok::<_, String>(output)
        }
        .await;

        text_result(result)
    }

    #[tool(name = "crawl_cancel", description = "Cancel a running crawl job so it stops crawling and using browser time. Pages already crawled stay available through crawl_status.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = false))]
    async fn crawl_cancel(
        &self,
        Parameters(params): Parameters<CrawlCancelParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let path = format!("/crawl/{}", urlencoding::encode(&params.job_id));
        let result = self.worker_call(reqwest::Method::DELETE, &path, None, 30).await;
        text_result(result.map(|_| format!("Cancelled crawl job: {}", params.job_id)))
    }

    // --- Content & Asset Tools ---

    #[tool(name = "download_image", description = "Download an image from a URL and save it to a local file path. Overwrites an existing file at that path.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn download_image(
        &self,
        Parameters(params): Parameters<DownloadImageParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.download_image(&params.url, &params.dest_path).await.map(|path| format!("Downloaded to: {path}")))
    }

    #[tool(name = "fetch_page_title", description = "Extract the <title> from a web page. Useful for generating [Title](url) Markdown links.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn fetch_page_title(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.fetch_page_title(&params.url).await)
    }

    // --- File Copy/Duplicate ---

    #[tool(name = "copy_entry", description = "Copy a file or directory to another directory", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn copy_entry(
        &self,
        Parameters(params): Parameters<CopyEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.copy_entry(&params.from, &params.to_dir).await.map(|dest| format!("Copied to: {dest}")))
    }

    #[tool(name = "duplicate_entry", description = "Duplicate a file or directory with auto-naming (e.g., 'file copy.md', 'file copy 2.md')", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn duplicate_entry(
        &self,
        Parameters(params): Parameters<DuplicateEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.duplicate_entry(&params.path).await.map(|dest| format!("Duplicated to: {dest}")))
    }

    // --- Crawl Save ---

    #[tool(name = "crawl_save", description = "Save crawled pages as local Markdown files. Use with crawl_status results. Overwrites existing files at the same paths.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn crawl_save(
        &self,
        Parameters(params): Parameters<CrawlSaveParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.crawl_save(&params.pages, &params.base_dir).await.map(|result| {
            format!("Saved {} files to {}", result.saved_count, result.base_dir)
        }))
    }

    // --- Git Write Operations ---

    #[tool(name = "git_stage", description = "Stage a file for commit (git add)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn git_stage(
        &self,
        Parameters(params): Parameters<GitFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.git_stage(&params.path).await.map(|()| format!("Staged: {}", params.path)))
    }

    #[tool(name = "git_unstage", description = "Unstage a file (git reset HEAD)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn git_unstage(
        &self,
        Parameters(params): Parameters<GitFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.git_unstage(&params.path).await.map(|()| format!("Unstaged: {}", params.path)))
    }

    #[tool(name = "git_commit", description = "Commit staged changes with a message", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn git_commit(
        &self,
        Parameters(params): Parameters<GitCommitParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.git_commit(&params.message).await)
    }

    #[tool(name = "git_push", description = "Push commits to the remote repository", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn git_push(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_push().await, "Push completed")
    }

    #[tool(name = "git_pull", description = "Pull changes from the remote repository", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = false))]
    async fn git_pull(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_pull().await, "Pull completed")
    }

    #[tool(name = "git_fetch", description = "Fetch updates from the remote repository without merging", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn git_fetch(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_fetch().await, "Fetch completed")
    }

    #[tool(name = "git_diff", description = "Get the diff for a specific file (staged or unstaged)", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn git_diff(
        &self,
        Parameters(params): Parameters<GitDiffParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_diff(&params.path, params.staged.unwrap_or(false)).await, "No changes")
    }

    #[tool(name = "git_discard", description = "Discard changes for a specific file (checkout tracked, delete untracked)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn git_discard(
        &self,
        Parameters(params): Parameters<GitFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.git_discard(&params.path).await.map(|()| format!("Discarded: {}", params.path)))
    }

    #[tool(name = "git_discard_all", description = "Discard all uncommitted changes (restore tracked files and remove untracked files)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn git_discard_all(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.git_discard_all().await.map(|()| "All changes discarded"))
    }

    #[tool(name = "git_log", description = "Get recent commit history", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn git_log(
        &self,
        Parameters(params): Parameters<GitLogParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = self.bridge.git_log(params.limit).await.map(|entries| {
            entries.iter().map(|e| {
                format!("{} {} ({}, {})", e.short_hash, e.message, e.author, e.relative_time)
            }).collect::<Vec<_>>().join("\n")
        });
        output_result(result, "No commits found")
    }

    #[tool(name = "git_revert", description = "Revert a commit by creating a new revert commit", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn git_revert(
        &self,
        Parameters(params): Parameters<GitRevertParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_revert(&params.commit_hash).await, "Revert completed")
    }

    // --- Tag Tools (require running app) ---

    #[tool(name = "list_tags", description = "List all tag definitions and file-tag assignments in the project", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn list_tags(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.get_tags().await)
    }

    #[tool(name = "get_file_tags", description = "Get the tags assigned to a specific file or directory", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn get_file_tags(
        &self,
        Parameters(params): Parameters<GetFileTagsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let data = self.bridge.get_tags().await?;
            let rel_path = self.resolve_rel_path(&params.path).await;
            let tags = data.get("files").and_then(|f| f.get(&rel_path));
            Ok::<_, String>(tags.map_or_else(|| "[]".to_string(), |t| t.to_string()))
        }
        .await;

        text_result(result)
    }

    #[tool(name = "set_file_tags", description = "Set the tags for a specific file or directory (replaces existing tags)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn set_file_tags(
        &self,
        Parameters(params): Parameters<SetFileTagsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let mut data = self.bridge.get_tags().await?;
            let rel_path = self.resolve_rel_path(&params.path).await;

            // Validate that all tags exist
            if let Some(tag_defs) = data.get("tags").and_then(|t| t.as_object()) {
                for tag in &params.tags {
                    if !tag_defs.contains_key(tag) {
                        return Err(format!("Tag '{}' does not exist. Create it first with create_tag.", tag));
                    }
                }
            }

            if let Some(files) = data.get_mut("files").and_then(|f| f.as_object_mut()) {
                if params.tags.is_empty() {
                    files.remove(&rel_path);
                } else {
                    files.insert(rel_path.clone(), serde_json::json!(params.tags));
                }
            }

            self.bridge.set_tags(&data).await?;
            Ok(format!("Tags for '{}' updated to {:?}", rel_path, params.tags))
        }
        .await;

        text_result(result)
    }

    #[tool(name = "create_tag", description = "Create a new tag definition with a color", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn create_tag(
        &self,
        Parameters(params): Parameters<CreateTagParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            if params.name.is_empty() || params.name.len() > 24 {
                return Err("Tag name must be 1-24 characters".to_string());
            }

            let mut data = self.bridge.get_tags().await?;
            let color = params.color.unwrap_or_else(|| "#d94545".to_string());

            if let Some(tags) = data.get_mut("tags").and_then(|t| t.as_object_mut()) {
                if tags.contains_key(&params.name) {
                    return Err(format!("Tag '{}' already exists", params.name));
                }
                tags.insert(params.name.clone(), serde_json::json!({ "color": color }));
            }

            self.bridge.set_tags(&data).await?;
            Ok(format!("Tag '{}' created with color {}", params.name, color))
        }
        .await;

        text_result(result)
    }

    #[tool(name = "delete_tag", description = "Delete a tag definition and remove it from all files", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn delete_tag(
        &self,
        Parameters(params): Parameters<DeleteTagParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let mut data = self.bridge.get_tags().await?;

            // Remove tag definition
            let removed = if let Some(tags) = data.get_mut("tags").and_then(|t| t.as_object_mut()) {
                tags.remove(&params.name).is_some()
            } else {
                false
            };

            if !removed {
                return Err(format!("Tag '{}' not found", params.name));
            }

            // Remove tag from all file assignments
            if let Some(files) = data.get_mut("files").and_then(|f| f.as_object_mut()) {
                let mut empty_paths = Vec::new();
                for (path, tags) in files.iter_mut() {
                    if let Some(arr) = tags.as_array_mut() {
                        arr.retain(|t| t.as_str() != Some(&params.name));
                        if arr.is_empty() {
                            empty_paths.push(path.clone());
                        }
                    }
                }
                for path in empty_paths {
                    files.remove(&path);
                }
            }

            self.bridge.set_tags(&data).await?;
            Ok(format!("Tag '{}' deleted", params.name))
        }
        .await;

        text_result(result)
    }

    // --- Worker-direct Tools (publish, embed) ---

    #[tool(name = "index_documents", description = "Index documents into AI Search for semantic search. Each document is chunked and embedded automatically (multilingual), and indexing finishes in the background. Requires the AI Search binding in the Worker.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = false))]
    async fn index_documents(
        &self,
        Parameters(params): Parameters<IndexDocumentsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let data = self
                .worker_call(reqwest::Method::POST, "/embed", Some(serde_json::json!({ "documents": params.documents })), 60)
                .await?;

            let indexed = data["indexed"].as_u64().unwrap_or(0);
            let mut output = format!("Indexed {indexed} documents");
            if let Some(errors) = data["errors"].as_array() {
                for e in errors.iter().filter_map(|e| e.as_str()) {
                    output.push_str(&format!("\nFailed: {e}"));
                }
            }
            Ok::<_, String>(output)
        }
        .await;

        text_result(result)
    }

    #[tool(name = "remove_document", description = "Remove a document from the semantic search index. Deletes all chunks associated with the document ID.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn remove_document(
        &self,
        Parameters(params): Parameters<RemoveDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let path = format!("/embed/{}", urlencoding::encode(&params.id));
        let result = self.worker_call(reqwest::Method::DELETE, &path, None, 30).await;
        text_result(result.map(|_| format!("Removed document: {}", params.id)))
    }

    #[tool(name = "publish_document", description = "Publish Markdown content to a public URL via R2 storage. Returns the public URL. Supports permanent or time-limited publishing.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = false))]
    async fn publish_document(
        &self,
        Parameters(params): Parameters<PublishDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let mut body = serde_json::json!({
                "key": params.key,
                "content": params.content,
                "filename": params.filename.unwrap_or_else(|| "untitled.md".to_string()),
            });
            if let Some(ttl) = params.expires_in {
                if ttl > 0 {
                    body["expires_in"] = serde_json::json!(ttl);
                }
            }

            let data = self.worker_call(reqwest::Method::PUT, "/publish", Some(body), 30).await?;

            let url = data["url"].as_str().unwrap_or("unknown");
            let expires = data["expiresAt"].as_str();
            match expires {
                Some(exp) => Ok::<_, String>(format!("Published: {url}\nExpires: {exp}")),
                None => Ok(format!("Published (permanent): {url}")),
            }
        }
        .await;

        text_result(result)
    }

    #[tool(name = "unpublish_document", description = "Remove a published document from R2 storage", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn unpublish_document(
        &self,
        Parameters(params): Parameters<UnpublishDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let path = format!("/publish/{}", urlencoding::encode(&params.key));
        let result = self.worker_call(reqwest::Method::DELETE, &path, None, 30).await;
        text_result(result.map(|_| format!("Unpublished: {}", params.key)))
    }

    #[tool(name = "list_published", description = "List all published documents in R2 storage. Returns key, size, and upload timestamp for each.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn list_published(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = self.worker_call(reqwest::Method::GET, "/published", None, 30).await;
        text_result(result.map(|data| match data["files"].as_array() {
            Some(arr) if !arr.is_empty() => format!("{} published documents\n\n{}", arr.len(), pretty_json(arr)),
            _ => "No published documents.".to_string(),
        }))
    }

    // --- Git Extended Tools ---

    #[tool(name = "git_stage_all", description = "Stage all changes for commit (git add -A). Stages new, modified, and deleted files.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn git_stage_all(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        text_result(self.bridge.git_stage_all().await.map(|()| "All changes staged"))
    }

    #[tool(name = "git_show", description = "Show the patch (diff) for a specific commit", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn git_show(
        &self,
        Parameters(params): Parameters<GitShowParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_show(&params.commit_hash).await, "No output")
    }

    #[tool(name = "git_clone", description = "Clone a git repository to a local directory", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = false))]
    async fn git_clone(
        &self,
        Parameters(params): Parameters<GitCloneParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_clone(&params.url, &params.dest).await, format!("Cloned to: {}", params.dest))
    }

    #[tool(name = "git_init", description = "Initialize a new git repository in the specified directory", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn git_init(
        &self,
        Parameters(params): Parameters<GitInitParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        output_result(self.bridge.git_init(&params.path).await, format!("Initialized: {}", params.path))
    }

    // --- Semantic Search ---

    #[tool(name = "semantic_search", description = "Search across indexed Markdown documents using natural language (hybrid keyword + vector search, multilingual). Returns ranked results with file paths, relevance scores, and the best-matching passage. Requires the AI Search binding in the Worker.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn semantic_search(
        &self,
        Parameters(params): Parameters<SemanticSearchParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let body = serde_json::json!({
                "query": params.query,
                "limit": params.limit.unwrap_or(10),
            });

            let data = self.worker_call(reqwest::Method::POST, "/search", Some(body), 30).await?;

            let results = data["results"].as_array();
            match results {
                Some(arr) if !arr.is_empty() => {
                    let mut output = format!("Found {} results:\n\n", arr.len());
                    for r in arr {
                        let doc_id = r["id"].as_str().unwrap_or("?");
                        let score = r["score"].as_f64().unwrap_or(0.0);
                        output.push_str(&format!("- **{}** (score: {:.2})\n", doc_id, score));
                        if let Some(text) = r["text"].as_str() {
                            let snippet = truncate_chars(text, 200).replace('\n', " ");
                            output.push_str(&format!("  {snippet}\n"));
                        }
                    }
                    Ok::<_, String>(output)
                }
                _ => Ok("No results found.".to_string()),
            }
        }
        .await;

        text_result(result)
    }

    // --- GitHub Tools (issues / pull requests) ---

    #[tool(name = "github_status", description = "Check GitHub integration availability for the current project: whether the gh CLI is installed and authenticated, and which owner/name repository the project's origin remote points at.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn github_status(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.github_status().await)
    }

    #[tool(name = "github_list", description = "List issues or pull requests for the current project's GitHub repository. Returns number, title, state, labels, author, and URL for each item. Use github_view to read a body.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn github_list(
        &self,
        Parameters(params): Parameters<GitHubListParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let kind = params.kind.as_deref().unwrap_or("issue");
        let state = params.state.as_deref().unwrap_or("open");
        json_result(self.bridge.github_list(kind, state, params.limit, params.search.as_deref()).await)
    }

    #[tool(name = "github_view", description = "Read a single issue or pull request including its Markdown body and all comments.", annotations(read_only_hint = true, open_world_hint = true, destructive_hint = false))]
    async fn github_view(
        &self,
        Parameters(params): Parameters<GitHubViewParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let kind = params.kind.as_deref().unwrap_or("issue");
        json_result(self.bridge.github_view(kind, params.number).await)
    }

    #[tool(name = "github_update", description = "Replace the title and Markdown body of an issue or pull request on GitHub. Comments are not affected. Pass expected_body to abort when the body changed on GitHub since it was read.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn github_update(
        &self,
        Parameters(params): Parameters<GitHubUpdateParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let kind = params.kind.as_deref().unwrap_or("issue");
        let result = self
            .bridge
            .github_update(
                kind,
                params.number,
                &params.title,
                &params.body,
                params.expected_body.as_deref(),
            )
            .await;
        text_result(result.map(|detail| {
            let url = detail.get("url").and_then(|v| v.as_str()).unwrap_or("");
            format!("Updated {kind} #{}: {url}", params.number)
        }))
    }

    // --- Window Tools ---

    #[tool(name = "list_windows", description = "List all open MarkUpsideDown windows with their labels and project root paths. Shows which window is currently focused. Useful for multi-window workflows.", annotations(read_only_hint = true, open_world_hint = false, destructive_hint = false))]
    async fn list_windows(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        json_result(self.bridge.list_windows().await)
    }
}

#[tool_handler]
impl ServerHandler for McpTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                env!("CARGO_PKG_NAME"),
                env!("CARGO_PKG_VERSION"),
            ))
    }
}
