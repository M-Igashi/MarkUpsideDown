use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, Implementation, ServerCapabilities, ServerInfo};
use rmcp::schemars;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;

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
        _ => None,
    }
}

fn get_worker_url(env_url: Option<&str>, bridge_url: Option<&str>) -> Result<String, String> {
    env_url
        .or(bridge_url)
        .map(|s| s.to_string())
        .ok_or_else(|| {
            "Worker URL not configured. Set MARKUPSIDEDOWN_WORKER_URL env var or configure in app Settings.".to_string()
        })
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
    #[schemars(description = "JSON Schema defining the output structure when formats includes \"json\" (passed as a JSON string)")]
    pub response_format: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExtractJsonParams {
    #[schemars(description = "URL of the web page to extract structured data from")]
    pub url: String,
    #[schemars(description = "Natural language description of what to extract (e.g., \"Extract all product names and prices\")")]
    pub prompt: Option<String>,
    #[schemars(description = "JSON Schema defining the expected output structure (passed as a JSON string)")]
    pub response_format: Option<String>,
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
pub struct CrawlSaveParams {
    #[schemars(description = "Array of pages to save, each with url and markdown fields")]
    pub pages: Vec<CrawlSavePageParam>,
    #[schemars(description = "Base directory to save files into")]
    pub base_dir: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
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
    #[schemars(description = "Array of documents to index. Each document needs an 'id' (unique identifier, e.g. file path) and 'content' (Markdown text). Optional 'metadata' object for additional context.")]
    pub documents: Vec<IndexDocumentEntry>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct IndexDocumentEntry {
    #[schemars(description = "Unique document identifier (e.g., file path or URL)")]
    pub id: String,
    #[schemars(description = "Markdown content to index")]
    pub content: String,
    #[schemars(description = "Optional metadata key-value pairs")]
    pub metadata: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct RemoveDocumentParams {
    #[schemars(description = "Document ID to remove from the Vectorize index")]
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
pub struct SubmitBatchParams {
    #[schemars(description = "Array of files to convert. Each needs 'name' (filename with extension) and 'content' (base64-encoded file content).")]
    pub files: Vec<BatchFileEntry>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BatchFileEntry {
    #[schemars(description = "Filename with extension (e.g., 'report.pdf')")]
    pub name: String,
    #[schemars(description = "Base64-encoded file content")]
    pub content: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetBatchStatusParams {
    #[schemars(description = "Batch ID returned by submit_batch")]
    pub batch_id: String,
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
    pub tool_router: ToolRouter<Self>,
    bridge: BridgeClient,
    http: reqwest::Client,
    worker_url_env: Option<String>,
    cached_worker_url: std::sync::Mutex<Option<(String, std::time::Instant)>>,
}

#[tool_router]
impl McpTools {
    pub fn new() -> Self {
        let worker_url_env = std::env::var("MARKUPSIDEDOWN_WORKER_URL").ok();
        let http = reqwest::Client::new();
        Self {
            tool_router: Self::tool_router(),
            bridge: BridgeClient::new(http.clone()),
            http,
            worker_url_env,
            cached_worker_url: std::sync::Mutex::new(None),
        }
    }

    async fn resolve_worker_url(&self) -> Result<String, String> {
        if let Some(ref url) = self.worker_url_env {
            return Ok(url.clone());
        }
        // Check cache (TTL: 60 seconds)
        {
            let cache = self.cached_worker_url.lock().unwrap();
            if let Some((ref url, ref ts)) = *cache {
                if ts.elapsed() < std::time::Duration::from_secs(60) {
                    return Ok(url.clone());
                }
            }
        }
        let bridge_state = self.bridge.get_editor_state().await.ok();
        let url = get_worker_url(
            None,
            bridge_state.as_ref().and_then(|s| s.worker_url.as_deref()),
        )?;
        *self.cached_worker_url.lock().unwrap() = Some((url.clone(), std::time::Instant::now()));
        Ok(url)
    }

    // --- Window Tools ---

    #[tool(name = "list_windows", description = "List all open MarkUpsideDown windows with their labels and project root paths. Shows which window is currently focused. Useful for multi-window workflows.", annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_windows(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.list_windows().await {
            Ok((windows, focused)) => {
                let json = serde_json::json!({ "windows": windows, "focused": focused });
                let text = serde_json::to_string_pretty(&json).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Editor Tools (require running app) ---

    #[tool(name = "get_editor_content", description = "Get current Markdown content from the editor", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_editor_content(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_editor_content().await {
            Ok(content) => Ok(CallToolResult::success(vec![Content::text(content)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "set_editor_content", description = "Replace the editor content with the provided Markdown", annotations(read_only_hint = false, open_world_hint = false))]
    async fn set_editor_content(
        &self,
        Parameters(params): Parameters<SetContentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.set_editor_content(&params.markdown).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("Editor content updated")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "insert_text", description = "Insert text at cursor position, start, or end of the editor", annotations(read_only_hint = false, open_world_hint = false))]
    async fn insert_text(
        &self,
        Parameters(params): Parameters<InsertTextParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.insert_text(&params.text, params.position.as_deref()).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("Text inserted")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Conversion Tools (use Worker, no app needed) ---

    #[tool(name = "fetch_markdown", description = "Fetch a URL as Markdown (static only, no JS rendering). Use get_markdown instead for automatic SPA detection.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn fetch_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let response = self
                .http
                .get(&params.url)
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

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "render_markdown", description = "Fetch a JavaScript-rendered page as Markdown via Browser Rendering (explicit). Use get_markdown instead for automatic SPA detection.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn render_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;

            let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&params.url));
            let response = self.http.get(&render_url).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|e| e.to_string())?;

            #[derive(Deserialize)]
            struct Resp {
                markdown: Option<String>,
                error: Option<String>,
            }
            let data: Resp = response.json().await.map_err(|e| e.to_string())?;
            if let Some(err) = data.error {
                return Err(err);
            }
            Ok(data.markdown.unwrap_or_default())
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_markdown", description = "Fetch a URL and return its content as Markdown. Automatically detects JavaScript-rendered pages and uses Browser Rendering when available. Recommended over fetch_markdown/render_markdown for most use cases.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn get_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            // 1. Try Markdown for Agents (direct fetch)
            let response = self
                .http
                .get(&params.url)
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
            let body = response.text().await.map_err(|e| e.to_string())?;

            if content_type.contains("text/markdown") {
                return Ok(format!("--- Markdown for Agents ---\n\n{body}"));
            }

            // 2. Try Worker /fetch with SPA detection
            let worker_url = self.resolve_worker_url().await;
            if let Ok(worker_url) = worker_url {
                #[derive(Deserialize)]
                struct FetchResp {
                    markdown: Option<String>,
                    spa_detected: Option<bool>,
                    error: Option<String>,
                }

                let fetch_resp = self
                    .http
                    .post(format!("{worker_url}/fetch"))
                    .json(&serde_json::json!({ "url": params.url }))
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;

                let data: FetchResp = fetch_resp.json().await.map_err(|e| e.to_string())?;
                if let Some(err) = data.error {
                    return Err(err);
                }

                let markdown = data.markdown.unwrap_or_default();
                let spa_detected = data.spa_detected.unwrap_or(false);

                // 2a. If SPA detected, try Browser Rendering
                if spa_detected {
                    #[derive(Deserialize)]
                    struct RenderResp {
                        markdown: Option<String>,
                        error: Option<String>,
                    }

                    let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&params.url));
                    if let Ok(resp) = self.http.get(&render_url).timeout(std::time::Duration::from_secs(30)).send().await {
                        if let Ok(rdata) = resp.json::<RenderResp>().await {
                            if rdata.error.is_none() {
                                if let Some(rendered) = rdata.markdown {
                                    return Ok(format!("--- Browser Rendering (auto) ---\n\n{rendered}"));
                                }
                            }
                        }
                    }
                    // Render failed — return fetch result
                }

                return Ok(format!("--- AI.toMarkdown ---\n\n{markdown}"));
            }

            // 3. Fallback: raw HTML
            Ok(format!("--- raw HTML (no Worker) ---\n\n{body}"))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "convert_to_markdown", description = "Convert a local document (PDF, DOCX, XLSX, HTML, CSV, XML, images) to Markdown via Workers AI", annotations(read_only_hint = true, open_world_hint = false))]
    async fn convert_to_markdown(
        &self,
        Parameters(params): Parameters<FilePathParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;

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

            let response = self
                .http
                .post(format!("{worker_url}/convert"))
                .header("Content-Type", mime)
                .timeout(std::time::Duration::from_secs(60))
                .body(bytes)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            #[derive(Deserialize)]
            struct Resp {
                markdown: Option<String>,
                error: Option<String>,
                warning: Option<String>,
            }
            let data: Resp = response.json().await.map_err(|e| e.to_string())?;
            if let Some(err) = data.error {
                return Err(err);
            }
            let md = data.markdown.unwrap_or_default();
            match data.warning {
                Some(w) => Ok(format!("⚠ {w}\n\n{md}")),
                None => Ok(md),
            }
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- File Tools (require running app) ---

    #[tool(name = "open_file", description = "Open a Markdown file in the editor", annotations(read_only_hint = false, open_world_hint = false))]
    async fn open_file(
        &self,
        Parameters(params): Parameters<OpenFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.open_file(&params.path).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Opened: {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "save_file", description = "Save the current editor content to a file", annotations(read_only_hint = false, open_world_hint = false))]
    async fn save_file(
        &self,
        Parameters(params): Parameters<SaveFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.save_file(params.path.as_deref()).await {
            Ok(()) => {
                let msg = match &params.path {
                    Some(p) => format!("Saved to: {p}"),
                    None => "File saved".to_string(),
                };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "normalize_document", description = "Normalize the current editor content: fix heading hierarchy, reformat tables, clean up whitespace, remove broken links, standardize list markers, and add CJK emphasis spacing", annotations(read_only_hint = false, open_world_hint = false))]
    async fn normalize_document(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.normalize_document().await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("Document normalized")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "lint_document", description = "Run structural lint checks on the current editor content. Returns diagnostics with line number, severity (error/warning/info), and message. Checks: headings, links, tables, frontmatter, lists, emphasis (CommonMark flanking), code blocks, footnotes, HTML comments, blank lines.", annotations(read_only_hint = true, open_world_hint = false))]
    async fn lint_document(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.lint_document().await {
            Ok(diagnostics) => {
                let json = serde_json::to_string_pretty(&diagnostics).unwrap_or_default();
                if diagnostics.as_array().map_or(true, |a| a.is_empty()) {
                    Ok(CallToolResult::success(vec![Content::text("No lint issues found")]))
                } else {
                    Ok(CallToolResult::success(vec![Content::text(json)]))
                }
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_document_structure", description = "Get the current document's structural information (heading tree, links, frontmatter, stats) as JSON. More efficient than parsing raw Markdown — reduces token usage for structure-aware operations.", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_document_structure(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_document_structure().await {
            Ok(structure) => {
                let json = serde_json::to_string_pretty(&structure).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_editor_state", description = "Get the current editor state: file path, cursor position (byte offset, line, column), and Worker URL", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_editor_state(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_editor_state().await {
            Ok(state) => {
                let json = serde_json::to_string_pretty(&state).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Project Context Tools (require running app) ---

    #[tool(name = "list_directory", description = "List files and directories in the project. Respects .gitignore. Returns name, path, is_dir, extension for each entry.", annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_directory(
        &self,
        Parameters(params): Parameters<ListDirectoryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.list_files(params.path.as_deref(), params.recursive.unwrap_or(false)).await {
            Ok(mut entries) => {
                let max = params.max_entries.unwrap_or(1000);
                let truncated = entries.len() > max;
                if truncated {
                    entries.truncate(max);
                }
                let json = serde_json::to_string_pretty(&entries).unwrap_or_default();
                let header = if truncated {
                    format!("{} entries (truncated, limit: {max})", entries.len())
                } else {
                    format!("{} entries", entries.len())
                };
                Ok(CallToolResult::success(vec![Content::text(format!("{header}\n\n{json}"))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_open_tabs", description = "List all open editor tabs with their path, name, and dirty (unsaved) status", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_open_tabs(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_tabs().await {
            Ok(tabs) => {
                let json = serde_json::to_string_pretty(&tabs).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_project_root", description = "Get the current project root directory path", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_project_root(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_project_root().await {
            Ok(Some(path)) => Ok(CallToolResult::success(vec![Content::text(path)])),
            Ok(None) => Ok(CallToolResult::error(vec![Content::text("No project root set (no folder opened in sidebar)")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "read_file", description = "Read a text file from the project. Works for any file, not just the active editor tab.", annotations(read_only_hint = true, open_world_hint = false))]
    async fn read_file(
        &self,
        Parameters(params): Parameters<ReadFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.read_file(&params.path).await {
            Ok(content) => Ok(CallToolResult::success(vec![Content::text(content)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_dirty_files", description = "List files with unsaved changes (dirty tabs)", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_dirty_files(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_dirty_files().await {
            Ok(files) => {
                if files.is_empty() {
                    Ok(CallToolResult::success(vec![Content::text("No unsaved changes")]))
                } else {
                    let json = serde_json::to_string_pretty(&files).unwrap_or_default();
                    Ok(CallToolResult::success(vec![Content::text(format!("{} files with unsaved changes\n\n{json}", files.len()))]))
                }
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "switch_tab", description = "Switch the active editor tab by file path or tab ID", annotations(read_only_hint = false, open_world_hint = false))]
    async fn switch_tab(
        &self,
        Parameters(params): Parameters<SwitchTabParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.switch_tab(params.path.as_deref(), params.tab_id.as_deref()).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("Tab switched")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_status", description = "Get git status of the project: branch, file changes (staged/unstaged), ahead/behind counts", annotations(read_only_hint = true, open_world_hint = false))]
    async fn git_status(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_status().await {
            Ok(status) => {
                let json = serde_json::to_string_pretty(&status).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "search_files", description = "Search file names (not content) in the project by substring match. Does not search file contents. Returns matching file entries with path, name, and metadata.", annotations(read_only_hint = true, open_world_hint = false))]
    async fn search_files(
        &self,
        Parameters(params): Parameters<SearchFilesParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.search_files(&params.query, params.path.as_deref()).await {
            Ok(matches) => {
                if matches.is_empty() {
                    Ok(CallToolResult::success(vec![Content::text("No matching files found")]))
                } else {
                    let json = serde_json::to_string_pretty(&matches).unwrap_or_default();
                    Ok(CallToolResult::success(vec![Content::text(format!("{} matches\n\n{json}", matches.len()))]))
                }
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "create_file", description = "Create a new empty file. Fails if the file already exists.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn create_file(
        &self,
        Parameters(params): Parameters<CreateFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.create_file(&params.path).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Created: {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "create_directory", description = "Create a new directory. Fails if it already exists.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn create_directory(
        &self,
        Parameters(params): Parameters<CreateDirectoryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.create_directory(&params.path).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Created directory: {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "rename_entry", description = "Rename or move a file or directory", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn rename_entry(
        &self,
        Parameters(params): Parameters<RenameEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.rename_entry(&params.from, &params.to).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Renamed: {} -> {}", params.from, params.to))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "delete_entry", description = "Delete a file or directory (moved to system trash, recoverable)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn delete_entry(
        &self,
        Parameters(params): Parameters<DeleteEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.delete_entry(&params.path, params.is_dir.unwrap_or(false)).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Deleted (moved to trash): {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Crawl Tools (use Worker, no app needed) ---

    #[tool(name = "extract_json", description = "Extract structured JSON data from a web page using AI (Workers AI LLM). Requires at least one of prompt or response_format. Note: uses LLM inference per call.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn extract_json(
        &self,
        Parameters(params): Parameters<ExtractJsonParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            if params.prompt.is_none() && params.response_format.is_none() {
                return Err("At least one of 'prompt' or 'response_format' is required".to_string());
            }

            let worker_url = self.resolve_worker_url().await?;
            let json_url = format!("{}/json", worker_url.trim_end_matches('/'));

            let mut body = serde_json::json!({ "url": params.url });
            if let Some(ref p) = params.prompt {
                body["prompt"] = serde_json::json!(p);
            }
            if let Some(ref rf) = params.response_format {
                let schema: serde_json::Value = serde_json::from_str(rf)
                    .map_err(|e| format!("Invalid response_format JSON: {e}"))?;
                body["response_format"] = schema;
            }

            let response = self
                .http
                .post(&json_url)
                .timeout(std::time::Duration::from_secs(120))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            #[derive(Deserialize)]
            struct Resp {
                data: Option<serde_json::Value>,
                error: Option<String>,
            }
            let status = response.status();
            let data: Resp = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;
            if !status.is_success() {
                return Err(data.error.unwrap_or_else(|| format!("Worker returned {status}")));
            }
            let result = data.data.ok_or("No data in response")?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string()))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "crawl_website", description = "Start a website crawl job via Browser Rendering. Returns a job_id to poll with crawl_status. Supports markdown and/or json output formats.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn crawl_website(
        &self,
        Parameters(params): Parameters<CrawlWebsiteParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let crawl_url = format!("{}/crawl", worker_url.trim_end_matches('/'));

            let mut body = serde_json::json!({
                "url": params.url,
                "depth": params.depth.unwrap_or(1),
                "limit": params.limit.unwrap_or(10),
                "render": params.render.unwrap_or(false),
            });

            if let Some(ref formats) = params.formats {
                body["formats"] = serde_json::json!(formats);
            }
            if let Some(ref rf) = params.response_format {
                let schema: serde_json::Value = serde_json::from_str(rf)
                    .map_err(|e| format!("Invalid response_format JSON: {e}"))?;
                body["response_format"] = schema;
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

            let response = self
                .http
                .post(&crawl_url)
                .timeout(std::time::Duration::from_secs(30))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            #[derive(Deserialize)]
            struct Resp {
                job_id: Option<String>,
                error: Option<String>,
            }
            let status = response.status();
            let data: Resp = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;
            if !status.is_success() {
                return Err(data.error.unwrap_or_else(|| format!("Worker returned {status}")));
            }
            let job_id = data.job_id.ok_or("No job_id in response")?;
            Ok(format!("Crawl started. job_id: {job_id}\n\nUse crawl_status with this job_id to poll for results."))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "crawl_status", description = "Poll a crawl job's status and retrieve completed pages. Returns status, progress, pages (with markdown and/or json depending on crawl formats), and a cursor for pagination.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn crawl_status(
        &self,
        Parameters(params): Parameters<CrawlStatusParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let limit = params.limit.unwrap_or(10);
            let mut status_url = format!(
                "{}/crawl/{}?limit={limit}&status=completed",
                worker_url.trim_end_matches('/'),
                params.job_id,
            );
            if let Some(ref c) = params.cursor {
                status_url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
            }

            let response = self
                .http
                .get(&status_url)
                .timeout(std::time::Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(format!("Worker returned {status}: {body}"));
            }

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
                error: Option<String>,
            }
            let body = response.bytes().await.map_err(|e| format!("Failed to read response: {e}"))?;
            let data: Resp = serde_json::from_slice(&body).map_err(|e| format!("Failed to parse response: {e}"))?;
            if let Some(err) = data.error {
                return Err(err);
            }
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
                            let preview_len = md.len().min(200);
                            output.push_str(&format!("\n{}", &md[..preview_len]));
                            if md.len() > 200 {
                                output.push_str("...");
                            }
                        }
                        if let Some(ref json) = r.json {
                            let json_str = serde_json::to_string_pretty(json).unwrap_or_else(|_| json.to_string());
                            let preview_len = json_str.len().min(500);
                            output.push_str(&format!("\n```json\n{}", &json_str[..preview_len]));
                            if json_str.len() > 500 {
                                output.push_str("...");
                            }
                            output.push_str("\n```");
                        }
                    }
                }
            }

            Ok(output)
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Content & Asset Tools ---

    #[tool(name = "download_image", description = "Download an image from a URL and save it to a local file path", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = false))]
    async fn download_image(
        &self,
        Parameters(params): Parameters<DownloadImageParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.download_image(&params.url, &params.dest_path).await {
            Ok(path) => Ok(CallToolResult::success(vec![Content::text(format!("Downloaded to: {path}"))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "fetch_page_title", description = "Extract the <title> from a web page. Useful for generating [Title](url) Markdown links.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn fetch_page_title(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.fetch_page_title(&params.url).await {
            Ok(title) => Ok(CallToolResult::success(vec![Content::text(title)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- File Copy/Duplicate ---

    #[tool(name = "copy_entry", description = "Copy a file or directory to another directory", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn copy_entry(
        &self,
        Parameters(params): Parameters<CopyEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.copy_entry(&params.from, &params.to_dir).await {
            Ok(dest) => Ok(CallToolResult::success(vec![Content::text(format!("Copied to: {dest}"))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "duplicate_entry", description = "Duplicate a file or directory with auto-naming (e.g., 'file copy.md', 'file copy 2.md')", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn duplicate_entry(
        &self,
        Parameters(params): Parameters<DuplicateEntryParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.duplicate_entry(&params.path).await {
            Ok(dest) => Ok(CallToolResult::success(vec![Content::text(format!("Duplicated to: {dest}"))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Crawl Save ---

    #[tool(name = "crawl_save", description = "Save crawled pages as local Markdown files. Use with crawl_status results.", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = false))]
    async fn crawl_save(
        &self,
        Parameters(params): Parameters<CrawlSaveParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let pages: Vec<crate::bridge::CrawlSavePage> = params
            .pages
            .into_iter()
            .map(|p| crate::bridge::CrawlSavePage {
                url: p.url,
                markdown: p.markdown,
            })
            .collect();
        match self.bridge.crawl_save(&pages, &params.base_dir).await {
            Ok(result) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Saved {} files to {}",
                result.saved_count, result.base_dir
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Git Write Operations ---

    #[tool(name = "git_stage", description = "Stage a file for commit (git add)", annotations(read_only_hint = false, open_world_hint = false))]
    async fn git_stage(
        &self,
        Parameters(params): Parameters<GitFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_stage(&params.path).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Staged: {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_unstage", description = "Unstage a file (git reset HEAD)", annotations(read_only_hint = false, open_world_hint = false))]
    async fn git_unstage(
        &self,
        Parameters(params): Parameters<GitFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_unstage(&params.path).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Unstaged: {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_commit", description = "Commit staged changes with a message", annotations(read_only_hint = false, open_world_hint = false))]
    async fn git_commit(
        &self,
        Parameters(params): Parameters<GitCommitParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_commit(&params.message).await {
            Ok(output) => Ok(CallToolResult::success(vec![Content::text(output)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_push", description = "Push commits to the remote repository", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn git_push(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_push().await {
            Ok(output) => {
                let msg = if output.is_empty() { "Push completed".to_string() } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_pull", description = "Pull changes from the remote repository", annotations(read_only_hint = false, open_world_hint = true))]
    async fn git_pull(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_pull().await {
            Ok(output) => {
                let msg = if output.is_empty() { "Pull completed".to_string() } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_fetch", description = "Fetch updates from the remote repository without merging", annotations(read_only_hint = true, open_world_hint = true))]
    async fn git_fetch(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_fetch().await {
            Ok(output) => {
                let msg = if output.is_empty() { "Fetch completed".to_string() } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_diff", description = "Get the diff for a specific file (staged or unstaged)", annotations(read_only_hint = true, open_world_hint = false))]
    async fn git_diff(
        &self,
        Parameters(params): Parameters<GitDiffParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_diff(&params.path, params.staged.unwrap_or(false)).await {
            Ok(diff) => {
                let msg = if diff.is_empty() { "No changes".to_string() } else { diff };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_discard", description = "Discard changes for a specific file (checkout tracked, delete untracked)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn git_discard(
        &self,
        Parameters(params): Parameters<GitFileParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_discard(&params.path).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(format!("Discarded: {}", params.path))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_discard_all", description = "Discard all uncommitted changes (restore tracked files and remove untracked files)", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn git_discard_all(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_discard_all().await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("All changes discarded")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_log", description = "Get recent commit history", annotations(read_only_hint = true, open_world_hint = false))]
    async fn git_log(
        &self,
        Parameters(params): Parameters<GitLogParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_log(params.limit).await {
            Ok(entries) => {
                if entries.is_empty() {
                    return Ok(CallToolResult::success(vec![Content::text("No commits found")]));
                }
                let text = entries.iter().map(|e| {
                    format!("{} {} ({}, {})", e.short_hash, e.message, e.author, e.relative_time)
                }).collect::<Vec<_>>().join("\n");
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_revert", description = "Revert a commit by creating a new revert commit", annotations(read_only_hint = false, open_world_hint = false))]
    async fn git_revert(
        &self,
        Parameters(params): Parameters<GitRevertParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_revert(&params.commit_hash).await {
            Ok(output) => {
                let msg = if output.is_empty() { "Revert completed".to_string() } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Tag Tools (require running app) ---

    #[tool(name = "list_tags", description = "List all tag definitions and file-tag assignments in the project", annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_tags(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_tags().await {
            Ok(data) => {
                let text = serde_json::to_string_pretty(&data).unwrap_or_default();
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_file_tags", description = "Get the tags assigned to a specific file or directory", annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_file_tags(
        &self,
        Parameters(params): Parameters<GetFileTagsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.get_tags().await {
            Ok(data) => {
                // Resolve relative path from project root
                let root = self.bridge.get_project_root().await.ok().flatten().unwrap_or_default();
                let rel_path = if !root.is_empty() && params.path.starts_with(&root) {
                    params.path[root.len()..].trim_start_matches('/').to_string()
                } else {
                    params.path.clone()
                };
                let tags = data.get("files")
                    .and_then(|f| f.get(&rel_path))
                    .cloned()
                    .unwrap_or(serde_json::json!([]));
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string(&tags).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "set_file_tags", description = "Set the tags for a specific file or directory (replaces existing tags)", annotations(read_only_hint = false, open_world_hint = false))]
    async fn set_file_tags(
        &self,
        Parameters(params): Parameters<SetFileTagsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let tags_result = self.bridge.get_tags().await;
        let mut data = match tags_result {
            Ok(d) => d,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };

        let root = self.bridge.get_project_root().await.ok().flatten().unwrap_or_default();
        let rel_path = if !root.is_empty() && params.path.starts_with(&root) {
            params.path[root.len()..].trim_start_matches('/').to_string()
        } else {
            params.path.clone()
        };

        // Validate that all tags exist
        if let Some(tag_defs) = data.get("tags").and_then(|t| t.as_object()) {
            for tag in &params.tags {
                if !tag_defs.contains_key(tag) {
                    return Ok(CallToolResult::error(vec![Content::text(
                        format!("Tag '{}' does not exist. Create it first with create_tag.", tag),
                    )]));
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

        match self.bridge.set_tags(&data).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(
                format!("Tags for '{}' updated to {:?}", rel_path, params.tags),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "create_tag", description = "Create a new tag definition with a color", annotations(read_only_hint = false, open_world_hint = false))]
    async fn create_tag(
        &self,
        Parameters(params): Parameters<CreateTagParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        if params.name.is_empty() || params.name.len() > 24 {
            return Ok(CallToolResult::error(vec![Content::text(
                "Tag name must be 1-24 characters",
            )]));
        }

        let tags_result = self.bridge.get_tags().await;
        let mut data = match tags_result {
            Ok(d) => d,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };

        let color = params.color.unwrap_or_else(|| "#d94545".to_string());

        if let Some(tags) = data.get_mut("tags").and_then(|t| t.as_object_mut()) {
            if tags.contains_key(&params.name) {
                return Ok(CallToolResult::error(vec![Content::text(
                    format!("Tag '{}' already exists", params.name),
                )]));
            }
            tags.insert(params.name.clone(), serde_json::json!({ "color": color }));
        }

        match self.bridge.set_tags(&data).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(
                format!("Tag '{}' created with color {}", params.name, color),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "delete_tag", description = "Delete a tag definition and remove it from all files", annotations(read_only_hint = false, open_world_hint = false, destructive_hint = true))]
    async fn delete_tag(
        &self,
        Parameters(params): Parameters<DeleteTagParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let tags_result = self.bridge.get_tags().await;
        let mut data = match tags_result {
            Ok(d) => d,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };

        // Remove tag definition
        let removed = if let Some(tags) = data.get_mut("tags").and_then(|t| t.as_object_mut()) {
            tags.remove(&params.name).is_some()
        } else {
            false
        };

        if !removed {
            return Ok(CallToolResult::error(vec![Content::text(
                format!("Tag '{}' not found", params.name),
            )]));
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

        match self.bridge.set_tags(&data).await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text(
                format!("Tag '{}' deleted", params.name),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Worker-direct Tools (publish, embed, batch) ---

    #[tool(name = "index_documents", description = "Index documents into Vectorize for semantic search. Each document is chunked and embedded automatically. Requires Vectorize binding in the Worker.", annotations(read_only_hint = false, open_world_hint = true))]
    async fn index_documents(
        &self,
        Parameters(params): Parameters<IndexDocumentsParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let embed_url = format!("{}/embed", worker_url.trim_end_matches('/'));

            let documents: Vec<serde_json::Value> = params.documents.iter().map(|d| {
                let mut doc = serde_json::json!({ "id": d.id, "content": d.content });
                if let Some(ref meta) = d.metadata {
                    doc["metadata"] = serde_json::json!(meta);
                }
                doc
            }).collect();

            let response = self
                .http
                .post(&embed_url)
                .timeout(std::time::Duration::from_secs(60))
                .json(&serde_json::json!({ "documents": documents }))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            let data: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;

            if !status.is_success() {
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            let indexed = data["indexed"].as_u64().unwrap_or(0);
            let chunks = data["chunks"].as_u64().unwrap_or(0);
            Ok(format!("Indexed {indexed} documents ({chunks} chunks)"))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "remove_document", description = "Remove a document from the Vectorize index. Deletes all chunks associated with the document ID.", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn remove_document(
        &self,
        Parameters(params): Parameters<RemoveDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let delete_url = format!("{}/embed/{}", worker_url.trim_end_matches('/'), urlencoding::encode(&params.id));

            let response = self
                .http
                .delete(&delete_url)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            if !status.is_success() {
                let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            Ok(format!("Removed document: {}", params.id))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "publish_document", description = "Publish Markdown content to a public URL via R2 storage. Returns the public URL. Supports permanent or time-limited publishing.", annotations(read_only_hint = false, open_world_hint = true))]
    async fn publish_document(
        &self,
        Parameters(params): Parameters<PublishDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let publish_url = format!("{}/publish", worker_url.trim_end_matches('/'));

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

            let response = self
                .http
                .put(&publish_url)
                .timeout(std::time::Duration::from_secs(30))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            let data: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;

            if !status.is_success() {
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            let url = data["url"].as_str().unwrap_or("unknown");
            let expires = data["expiresAt"].as_str();
            match expires {
                Some(exp) => Ok(format!("Published: {url}\nExpires: {exp}")),
                None => Ok(format!("Published (permanent): {url}")),
            }
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "unpublish_document", description = "Remove a published document from R2 storage", annotations(read_only_hint = false, open_world_hint = true, destructive_hint = true))]
    async fn unpublish_document(
        &self,
        Parameters(params): Parameters<UnpublishDocumentParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let delete_url = format!("{}/publish/{}", worker_url.trim_end_matches('/'), urlencoding::encode(&params.key));

            let response = self
                .http
                .delete(&delete_url)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            if !status.is_success() {
                let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            Ok(format!("Unpublished: {}", params.key))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "list_published", description = "List all published documents in R2 storage. Returns key, size, and upload timestamp for each.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn list_published(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let list_url = format!("{}/published", worker_url.trim_end_matches('/'));

            let response = self
                .http
                .get(&list_url)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            let data: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;

            if !status.is_success() {
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            let files = data["files"].as_array();
            match files {
                Some(arr) if !arr.is_empty() => {
                    let json = serde_json::to_string_pretty(&data["files"]).unwrap_or_default();
                    Ok(format!("{} published documents\n\n{json}", arr.len()))
                }
                _ => Ok("No published documents.".to_string()),
            }
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "submit_batch", description = "Submit multiple files for parallel batch conversion to Markdown via Queue. Returns a batch_id to poll with get_batch_status. Requires Queue and KV bindings in the Worker.", annotations(read_only_hint = false, open_world_hint = true))]
    async fn submit_batch(
        &self,
        Parameters(params): Parameters<SubmitBatchParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let batch_url = format!("{}/batch", worker_url.trim_end_matches('/'));

            let files: Vec<serde_json::Value> = params.files.iter().map(|f| {
                serde_json::json!({ "name": f.name, "content": f.content })
            }).collect();

            let response = self
                .http
                .post(&batch_url)
                .timeout(std::time::Duration::from_secs(30))
                .json(&serde_json::json!({ "files": files }))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            let data: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;

            if !status.is_success() {
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            let batch_id = data["batch_id"].as_str().unwrap_or("unknown");
            Ok(format!("Batch submitted. batch_id: {batch_id}\n\nUse get_batch_status with this batch_id to poll for results."))
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "get_batch_status", description = "Poll the status of a batch conversion job. Returns overall progress and per-file status (queued/done/failed).", annotations(read_only_hint = true, open_world_hint = true))]
    async fn get_batch_status(
        &self,
        Parameters(params): Parameters<GetBatchStatusParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let status_url = format!("{}/batch/{}", worker_url.trim_end_matches('/'), params.batch_id);

            let response = self
                .http
                .get(&status_url)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            let data: serde_json::Value = response.json().await.map_err(|e| format!("Failed to parse response: {e}"))?;

            if !status.is_success() {
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            let json = serde_json::to_string_pretty(&data).unwrap_or_default();
            Ok(json)
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Git Extended Tools ---

    #[tool(name = "git_stage_all", description = "Stage all changes for commit (git add -A). Stages new, modified, and deleted files.", annotations(read_only_hint = false, open_world_hint = false))]
    async fn git_stage_all(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_stage_all().await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("All changes staged")])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_show", description = "Show the patch (diff) for a specific commit", annotations(read_only_hint = true, open_world_hint = false))]
    async fn git_show(
        &self,
        Parameters(params): Parameters<GitShowParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_show(&params.commit_hash).await {
            Ok(output) => {
                let msg = if output.is_empty() { "No output".to_string() } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_clone", description = "Clone a git repository to a local directory", annotations(read_only_hint = false, open_world_hint = true))]
    async fn git_clone(
        &self,
        Parameters(params): Parameters<GitCloneParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_clone(&params.url, &params.dest).await {
            Ok(output) => {
                let msg = if output.is_empty() { format!("Cloned to: {}", params.dest) } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(name = "git_init", description = "Initialize a new git repository in the specified directory", annotations(read_only_hint = false, open_world_hint = false))]
    async fn git_init(
        &self,
        Parameters(params): Parameters<GitInitParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.git_init(&params.path).await {
            Ok(output) => {
                let msg = if output.is_empty() { format!("Initialized: {}", params.path) } else { output };
                Ok(CallToolResult::success(vec![Content::text(msg)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    // --- Semantic Search ---

    #[tool(name = "semantic_search", description = "Search across indexed Markdown documents using natural language. Returns ranked results with file paths and relevance scores. Requires Vectorize to be configured in the Worker.", annotations(read_only_hint = true, open_world_hint = true))]
    async fn semantic_search(
        &self,
        Parameters(params): Parameters<SemanticSearchParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;
            let search_url = format!("{}/search", worker_url.trim_end_matches('/'));

            let body = serde_json::json!({
                "query": params.query,
                "limit": params.limit.unwrap_or(10),
            });

            let response = self
                .http
                .post(&search_url)
                .timeout(std::time::Duration::from_secs(30))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Request failed: {e}"))?;

            let status = response.status();
            let data: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {e}"))?;

            if !status.is_success() {
                let err = data["error"].as_str().unwrap_or("Unknown error");
                return Err(format!("Worker returned {status}: {err}"));
            }

            let results = data["results"].as_array();
            match results {
                Some(arr) if !arr.is_empty() => {
                    let mut output = format!("Found {} results:\n\n", arr.len());
                    for r in arr {
                        let id = r["id"].as_str().unwrap_or("?");
                        // Strip chunk suffix (e.g., "file.md#2" → "file.md")
                        let doc_id = if let Some(pos) = id.rfind('#') { &id[..pos] } else { id };
                        let score = r["score"].as_f64().unwrap_or(0.0);
                        output.push_str(&format!("- **{}** (score: {:.2})\n", doc_id, score));
                    }
                    Ok(output)
                }
                _ => Ok("No results found.".to_string()),
            }
        }
        .await;

        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
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
