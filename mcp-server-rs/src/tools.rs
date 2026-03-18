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

// --- Server ---

pub struct McpTools {
    pub tool_router: ToolRouter<Self>,
    bridge: BridgeClient,
    http: reqwest::Client,
    worker_url_env: Option<String>,
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
        }
    }

    async fn resolve_worker_url(&self) -> Result<String, String> {
        if let Some(ref url) = self.worker_url_env {
            return Ok(url.clone());
        }
        let bridge_state = self.bridge.get_editor_state().await.ok();
        get_worker_url(
            None,
            bridge_state.as_ref().and_then(|s| s.worker_url.as_deref()),
        )
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

    #[tool(name = "fetch_markdown", description = "Fetch a URL and return its content as Markdown using Cloudflare Markdown for Agents", annotations(read_only_hint = true, open_world_hint = true))]
    async fn fetch_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let response = self
                .http
                .get(&params.url)
                .header("Accept", "text/markdown")
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

    #[tool(name = "render_markdown", description = "Fetch a JavaScript-rendered page as Markdown via Browser Rendering", annotations(read_only_hint = true, open_world_hint = true))]
    async fn render_markdown(
        &self,
        Parameters(params): Parameters<UrlParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let result = async {
            let worker_url = self.resolve_worker_url().await?;

            let render_url = format!("{worker_url}/render?url={}", urlencoding::encode(&params.url));
            let response = self.http.get(&render_url).send().await.map_err(|e| e.to_string())?;

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

    #[tool(name = "convert_to_markdown", description = "Convert a local document (PDF, DOCX, XLSX, PPTX, HTML, CSV, XML, images) to Markdown via Workers AI", annotations(read_only_hint = true, open_world_hint = false))]
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

    #[tool(name = "export_pdf", description = "Export the current editor content as PDF (opens print dialog in the app)", annotations(read_only_hint = false, open_world_hint = false))]
    async fn export_pdf(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.bridge.export_pdf().await {
            Ok(()) => Ok(CallToolResult::success(vec![Content::text("PDF export triggered")])),
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
