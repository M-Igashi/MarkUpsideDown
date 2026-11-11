use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::{Client, Method};
use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::tools::CrawlSavePageParam;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Network and CLI-backed routes (git remotes, gh, downloads, crawl save).
const LONG_TIMEOUT: Duration = Duration::from_secs(300);

fn timeout_for(path: &str) -> Duration {
    const LONG: &[&str] = &[
        "/git/push",
        "/git/pull",
        "/git/fetch",
        "/git/clone",
        "/github/",
        "/content/",
        "/crawl/",
    ];
    if LONG.iter().any(|p| path.starts_with(p)) { LONG_TIMEOUT } else { TIMEOUT }
}

static CACHED_BRIDGE_URL: Mutex<Option<String>> = Mutex::new(None);

fn port_file_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".markupsidedown-bridge-port")
}

fn discover_bridge_url() -> Option<String> {
    let port = std::fs::read_to_string(port_file_path()).ok()?;
    let port = port.trim();
    if port.is_empty() {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

fn get_bridge_url() -> Result<String, String> {
    let mut cached = CACHED_BRIDGE_URL.lock().unwrap();
    if let Some(ref url) = *cached {
        return Ok(url.clone());
    }
    let url = discover_bridge_url()
        .ok_or_else(|| "MarkUpsideDown app is not running (no bridge port file found)".to_string())?;
    *cached = Some(url.clone());
    Ok(url)
}

/// Clear the cached bridge URL so the next call re-discovers it from the port file.
fn clear_bridge_url_cache() {
    *CACHED_BRIDGE_URL.lock().unwrap() = None;
}

pub struct BridgeClient {
    client: Client,
}

impl BridgeClient {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// Send a request, parse the JSON response (empty body -> Null), and
    /// surface the bridge's `error` field as Err.
    async fn request_json(&self, method: Method, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let url = format!("{}{path}", get_bridge_url()?);
        let mut req = self.client.request(method, url).timeout(timeout_for(path));
        if let Some(body) = body {
            req = req.json(&body);
        }

        let response = req.send().await.map_err(|e| {
            if e.is_timeout() {
                return format!("Timed out waiting for the app ({path}); the operation may still be running");
            }
            clear_bridge_url_cache();
            "MarkUpsideDown app is not reachable".to_string()
        })?;

        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let detail = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
            return Err(match detail {
                Some(err) => format!("Bridge returned {status}: {err}"),
                None => format!("Bridge returned {status}"),
            });
        }

        let json: serde_json::Value = if text.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&text).map_err(|e| e.to_string())?
        };
        if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        Ok(json)
    }

    /// Like `request_json`, deserializing the whole response.
    async fn request_as<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<serde_json::Value>) -> Result<T, String> {
        let json = self.request_json(method, path, body).await?;
        serde_json::from_value(json).map_err(|e| e.to_string())
    }

    /// Like `request_json`, deserializing a single field (missing field -> Null).
    async fn request_field<T: DeserializeOwned>(&self, method: Method, path: &str, field: &str) -> Result<T, String> {
        let mut json = self.request_json(method, path, None).await?;
        let value = json.get_mut(field).map(serde_json::Value::take).unwrap_or_default();
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// Like `request_json`, extracting a single string field from the response
    /// (missing field -> empty string).
    async fn request_str(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        field: &str,
    ) -> Result<String, String> {
        let json = self.request_json(method, path, body).await?;
        Ok(json.get(field).and_then(|v| v.as_str()).unwrap_or("").to_string())
    }

    async fn post_check_error(&self, path: &str, body: serde_json::Value) -> Result<(), String> {
        self.request_json(Method::POST, path, Some(body)).await.map(|_| ())
    }

    pub async fn get_editor_content(&self) -> Result<String, String> {
        self.request_field(Method::GET, "/editor/content", "content").await
    }

    pub async fn set_editor_content(&self, content: &str) -> Result<(), String> {
        self.post_check_error("/editor/content", serde_json::json!({ "content": content })).await
    }

    pub async fn insert_text(&self, text: &str, position: Option<&str>) -> Result<(), String> {
        self.post_check_error("/editor/insert", serde_json::json!({ "text": text, "position": position })).await
    }

    pub async fn get_editor_state(&self) -> Result<EditorState, String> {
        self.request_as(Method::GET, "/editor/state", None).await
    }

    pub async fn get_worker_config(&self) -> Result<WorkerConfig, String> {
        self.request_as(Method::GET, "/worker", None).await
    }

    pub async fn open_file(&self, path: &str) -> Result<(), String> {
        self.post_check_error("/editor/open-file", serde_json::json!({ "path": path })).await
    }

    pub async fn save_file(&self, path: Option<&str>) -> Result<(), String> {
        self.post_check_error("/editor/save-file", serde_json::json!({ "path": path })).await
    }

    pub async fn normalize_document(&self) -> Result<(), String> {
        self.request_json(Method::POST, "/editor/normalize", None).await.map(|_| ())
    }

    pub async fn lint_document(&self) -> Result<serde_json::Value, String> {
        self.request_field(Method::GET, "/editor/lint", "diagnostics").await
    }

    pub async fn get_document_structure(&self) -> Result<serde_json::Value, String> {
        self.request_json(Method::GET, "/editor/structure", None).await
    }

    pub async fn get_tabs(&self) -> Result<Vec<TabInfo>, String> {
        self.request_field(Method::GET, "/editor/tabs", "tabs").await
    }

    pub async fn get_project_root(&self) -> Result<Option<String>, String> {
        self.request_field(Method::GET, "/editor/root", "root_path").await
    }

    pub async fn get_dirty_files(&self) -> Result<Vec<TabInfo>, String> {
        Ok(self.get_tabs().await?.into_iter().filter(|t| t.is_dirty).collect())
    }

    pub async fn switch_tab(&self, path: Option<&str>, tab_id: Option<&str>) -> Result<(), String> {
        self.post_check_error("/editor/switch-tab", serde_json::json!({ "path": path, "tab_id": tab_id })).await
    }

    pub async fn list_files(&self, path: Option<&str>, recursive: bool) -> Result<Vec<FileEntry>, String> {
        let mut query = String::from("/files/list?");
        if let Some(p) = path {
            query.push_str(&format!("path={}&", urlencoding::encode(p)));
        }
        if recursive {
            query.push_str("recursive=true");
        }
        self.request_field(Method::GET, &query, "entries").await
    }

    pub async fn read_file(&self, path: &str) -> Result<String, String> {
        let query = format!("/files/read?path={}", urlencoding::encode(path));
        self.request_str(Method::GET, &query, None, "content").await
    }

    pub async fn search_files(&self, query_str: &str, path: Option<&str>) -> Result<Vec<FileEntry>, String> {
        let mut query = format!("/files/search?query={}", urlencoding::encode(query_str));
        if let Some(p) = path {
            query.push_str(&format!("&path={}", urlencoding::encode(p)));
        }
        self.request_field(Method::GET, &query, "matches").await
    }

    pub async fn git_status(&self) -> Result<GitStatus, String> {
        self.request_as(Method::GET, "/git/status", None).await
    }

    pub async fn create_file(&self, path: &str) -> Result<(), String> {
        self.post_check_error("/files/create", serde_json::json!({ "path": path })).await
    }

    pub async fn create_directory(&self, path: &str) -> Result<(), String> {
        self.post_check_error("/files/create-directory", serde_json::json!({ "path": path })).await
    }

    pub async fn rename_entry(&self, from: &str, to: &str) -> Result<(), String> {
        self.post_check_error("/files/rename", serde_json::json!({ "from": from, "to": to })).await
    }

    pub async fn delete_entry(&self, path: &str, is_dir: bool) -> Result<(), String> {
        self.post_check_error("/files/delete", serde_json::json!({ "path": path, "is_dir": is_dir })).await
    }

    pub async fn copy_entry(&self, from: &str, to_dir: &str) -> Result<String, String> {
        self.request_str(Method::POST, "/files/copy", Some(serde_json::json!({ "from": from, "to_dir": to_dir })), "path").await
    }

    pub async fn duplicate_entry(&self, path: &str) -> Result<String, String> {
        self.request_str(Method::POST, "/files/duplicate", Some(serde_json::json!({ "path": path })), "path").await
    }

    // --- Git write operations ---

    pub async fn git_stage(&self, path: &str) -> Result<(), String> {
        self.post_check_error("/git/stage", serde_json::json!({ "path": path })).await
    }

    pub async fn git_unstage(&self, path: &str) -> Result<(), String> {
        self.post_check_error("/git/unstage", serde_json::json!({ "path": path })).await
    }

    pub async fn git_commit(&self, message: &str) -> Result<String, String> {
        self.request_str(Method::POST, "/git/commit", Some(serde_json::json!({ "message": message })), "output").await
    }

    pub async fn git_push(&self) -> Result<String, String> {
        self.request_str(Method::POST, "/git/push", None, "output").await
    }

    pub async fn git_pull(&self) -> Result<String, String> {
        self.request_str(Method::POST, "/git/pull", None, "output").await
    }

    pub async fn git_fetch(&self) -> Result<String, String> {
        self.request_str(Method::POST, "/git/fetch", None, "output").await
    }

    pub async fn git_diff(&self, path: &str, staged: bool) -> Result<String, String> {
        let query = format!("/git/diff?path={}&staged={}", urlencoding::encode(path), staged);
        self.request_str(Method::GET, &query, None, "diff").await
    }

    pub async fn git_discard(&self, path: &str) -> Result<(), String> {
        self.post_check_error("/git/discard", serde_json::json!({ "path": path })).await
    }

    pub async fn git_discard_all(&self) -> Result<(), String> {
        self.post_check_error("/git/discard-all", serde_json::json!({})).await
    }

    pub async fn git_log(&self, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
        let query = match limit {
            Some(l) => format!("/git/log?limit={}", l),
            None => "/git/log".to_string(),
        };
        self.request_field(Method::GET, &query, "entries").await
    }

    pub async fn git_revert(&self, commit_hash: &str) -> Result<String, String> {
        self.request_str(Method::POST, "/git/revert", Some(serde_json::json!({ "commit_hash": commit_hash })), "output").await
    }

    // --- GitHub (issues / pull requests via the gh CLI) ---

    pub async fn github_status(&self) -> Result<serde_json::Value, String> {
        self.request_json(Method::GET, "/github/status", None).await
    }

    pub async fn github_list(
        &self,
        kind: &str,
        state: &str,
        limit: Option<u32>,
        search: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let mut query = format!(
            "/github/list?kind={}&state={}",
            urlencoding::encode(kind),
            urlencoding::encode(state)
        );
        if let Some(limit) = limit {
            query.push_str(&format!("&limit={limit}"));
        }
        if let Some(search) = search.filter(|s| !s.trim().is_empty()) {
            query.push_str(&format!("&search={}", urlencoding::encode(search)));
        }
        let json = self.request_json(Method::GET, &query, None).await?;
        Ok(json.get("items").cloned().unwrap_or(json))
    }

    pub async fn github_view(&self, kind: &str, number: u64) -> Result<serde_json::Value, String> {
        let query = format!("/github/view?kind={}&number={number}", urlencoding::encode(kind));
        self.request_json(Method::GET, &query, None).await
    }

    pub async fn github_update(
        &self,
        kind: &str,
        number: u64,
        title: &str,
        body: &str,
        expected_body: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let payload = serde_json::json!({
            "kind": kind,
            "number": number,
            "title": title,
            "body": body,
            "expected_body": expected_body,
        });
        self.request_json(Method::POST, "/github/update", Some(payload)).await
    }

    // --- Crawl save ---

    pub async fn crawl_save(&self, pages: &[CrawlSavePageParam], base_dir: &str) -> Result<CrawlSaveResult, String> {
        let body = serde_json::json!({ "pages": pages, "base_dir": base_dir });
        self.request_as(Method::POST, "/crawl/save", Some(body)).await
    }

    // --- Content & assets ---

    pub async fn download_image(&self, url: &str, dest_path: &str) -> Result<String, String> {
        let body = serde_json::json!({ "url": url, "dest_path": dest_path });
        self.request_str(Method::POST, "/content/download-image", Some(body), "path").await
    }

    pub async fn fetch_page_title(&self, url: &str) -> Result<String, String> {
        let body = serde_json::json!({ "url": url });
        self.request_str(Method::POST, "/content/fetch-title", Some(body), "title").await
    }

    // --- Tags ---

    pub async fn get_tags(&self) -> Result<serde_json::Value, String> {
        self.request_json(Method::GET, "/tags/list", None).await
    }

    pub async fn set_tags(&self, data: &serde_json::Value) -> Result<(), String> {
        self.post_check_error("/tags/set", serde_json::json!({ "tags": data })).await
    }

    // --- Git extended operations ---

    pub async fn git_stage_all(&self) -> Result<(), String> {
        self.post_check_error("/git/stage-all", serde_json::json!({})).await
    }

    pub async fn git_show(&self, commit_hash: &str) -> Result<String, String> {
        let query = format!("/git/show?commit_hash={}", urlencoding::encode(commit_hash));
        self.request_str(Method::GET, &query, None, "output").await
    }

    pub async fn git_clone(&self, url: &str, dest: &str) -> Result<String, String> {
        let body = serde_json::json!({ "url": url, "dest": dest });
        self.request_str(Method::POST, "/git/clone", Some(body), "output").await
    }

    pub async fn git_init(&self, path: &str) -> Result<String, String> {
        self.request_str(Method::POST, "/git/init", Some(serde_json::json!({ "path": path })), "output").await
    }

    // --- Window management ---

    pub async fn list_windows(&self) -> Result<serde_json::Value, String> {
        self.request_json(Method::GET, "/windows", None).await
    }
}

#[derive(Deserialize, Default)]
pub struct WorkerConfig {
    pub url: Option<String>,
    pub key: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
pub struct EditorState {
    pub file_path: Option<String>,
    pub worker_url: Option<String>,
    pub cursor_pos: usize,
    pub cursor_line: usize,
    pub cursor_column: usize,
}

#[derive(Deserialize, serde::Serialize)]
pub struct TabInfo {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub is_dirty: bool,
}

#[derive(Deserialize, serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub extension: Option<String>,
    pub modified_at: Option<u64>,
}

#[derive(Deserialize, serde::Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub added_lines: u32,
    pub removed_lines: u32,
}

#[derive(Deserialize, serde::Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub is_repo: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Deserialize, serde::Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub relative_time: String,
}

#[derive(Deserialize, serde::Serialize)]
pub struct CrawlSaveResult {
    pub saved_count: u32,
    pub base_dir: String,
}
