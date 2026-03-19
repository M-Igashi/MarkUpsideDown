use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

const TIMEOUT: Duration = Duration::from_secs(5);

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

    async fn request(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<Option<serde_json::Value>, String> {
        let base_url = get_bridge_url()?;
        let url = format!("{}{path}", base_url);

        let mut req = match method {
            "POST" => self.client.post(&url),
            _ => self.client.get(&url),
        };
        req = req.timeout(TIMEOUT);

        if let Some(body) = body {
            req = req.json(&body);
        }

        let response = req.send().await.map_err(|_| {
            clear_bridge_url_cache();
            "MarkUpsideDown app is not reachable".to_string()
        })?;

        if !response.status().is_success() {
            return Err(format!("Bridge returned {}", response.status()));
        }

        let text = response.text().await.map_err(|e| e.to_string())?;
        if text.is_empty() {
            Ok(None)
        } else {
            serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
        }
    }

    pub async fn get_editor_content(&self) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Resp {
            content: String,
        }
        let val = self.request("GET", "/editor/content", None).await?;
        let resp: Resp = serde_json::from_value(val.unwrap_or_default()).map_err(|e| e.to_string())?;
        Ok(resp.content)
    }

    pub async fn set_editor_content(&self, content: &str) -> Result<(), String> {
        self.request("POST", "/editor/content", Some(serde_json::json!({ "content": content }))).await?;
        Ok(())
    }

    pub async fn insert_text(&self, text: &str, position: Option<&str>) -> Result<(), String> {
        self.request("POST", "/editor/insert", Some(serde_json::json!({ "text": text, "position": position }))).await?;
        Ok(())
    }

    pub async fn get_editor_state(&self) -> Result<EditorState, String> {
        let val = self.request("GET", "/editor/state", None).await?;
        serde_json::from_value(val.unwrap_or_default()).map_err(|e| e.to_string())
    }

    pub async fn open_file(&self, path: &str) -> Result<(), String> {
        self.request("POST", "/editor/open-file", Some(serde_json::json!({ "path": path }))).await?;
        Ok(())
    }

    pub async fn save_file(&self, path: Option<&str>) -> Result<(), String> {
        self.request("POST", "/editor/save-file", Some(serde_json::json!({ "path": path }))).await?;
        Ok(())
    }

    pub async fn export_pdf(&self) -> Result<(), String> {
        self.request("POST", "/editor/export-pdf", None).await?;
        Ok(())
    }

    pub async fn normalize_document(&self) -> Result<(), String> {
        self.request("POST", "/editor/normalize", None).await?;
        Ok(())
    }

    pub async fn get_document_structure(&self) -> Result<serde_json::Value, String> {
        let val = self.request("GET", "/editor/structure", None).await?;
        let json = val.unwrap_or_default();
        if json.get("error").is_some() {
            return Err(json["error"].as_str().unwrap_or("Unknown error").to_string());
        }
        Ok(json)
    }

    pub async fn get_tabs(&self) -> Result<Vec<TabInfo>, String> {
        let val = self.request("GET", "/editor/tabs", None).await?;
        let json = val.unwrap_or_default();
        #[derive(Deserialize)]
        struct Resp { tabs: Vec<TabInfo> }
        let resp: Resp = serde_json::from_value(json).map_err(|e| e.to_string())?;
        Ok(resp.tabs)
    }

    pub async fn get_project_root(&self) -> Result<Option<String>, String> {
        let val = self.request("GET", "/editor/root", None).await?;
        let json = val.unwrap_or_default();
        Ok(json.get("root_path").and_then(|v| v.as_str()).map(|s| s.to_string()))
    }

    pub async fn get_dirty_files(&self) -> Result<Vec<TabInfo>, String> {
        let val = self.request("GET", "/editor/dirty-files", None).await?;
        let json = val.unwrap_or_default();
        #[derive(Deserialize)]
        struct Resp { dirty_files: Vec<TabInfo> }
        let resp: Resp = serde_json::from_value(json).map_err(|e| e.to_string())?;
        Ok(resp.dirty_files)
    }

    pub async fn switch_tab(&self, path: Option<&str>, tab_id: Option<&str>) -> Result<(), String> {
        self.request("POST", "/editor/switch-tab", Some(serde_json::json!({ "path": path, "tab_id": tab_id }))).await?;
        Ok(())
    }

    pub async fn list_files(&self, path: Option<&str>, recursive: bool) -> Result<Vec<FileEntry>, String> {
        let mut query = String::from("/files/list?");
        if let Some(p) = path {
            query.push_str(&format!("path={}&", urlencoding::encode(p)));
        }
        if recursive {
            query.push_str("recursive=true");
        }
        let val = self.request("GET", &query, None).await?;
        let json = val.unwrap_or_default();
        if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        #[derive(Deserialize)]
        struct Resp { entries: Vec<FileEntry> }
        let resp: Resp = serde_json::from_value(json).map_err(|e| e.to_string())?;
        Ok(resp.entries)
    }

    pub async fn read_file(&self, path: &str) -> Result<String, String> {
        let query = format!("/files/read?path={}", urlencoding::encode(path));
        let val = self.request("GET", &query, None).await?;
        let json = val.unwrap_or_default();
        if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        Ok(json.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string())
    }

    pub async fn search_files(&self, query_str: &str, path: Option<&str>) -> Result<Vec<FileEntry>, String> {
        let mut query = format!("/files/search?query={}", urlencoding::encode(query_str));
        if let Some(p) = path {
            query.push_str(&format!("&path={}", urlencoding::encode(p)));
        }
        let val = self.request("GET", &query, None).await?;
        let json = val.unwrap_or_default();
        if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        #[derive(Deserialize)]
        struct Resp { matches: Vec<FileEntry> }
        let resp: Resp = serde_json::from_value(json).map_err(|e| e.to_string())?;
        Ok(resp.matches)
    }

    pub async fn git_status(&self) -> Result<GitStatus, String> {
        let val = self.request("GET", "/git/status", None).await?;
        let json = val.unwrap_or_default();
        if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        serde_json::from_value(json).map_err(|e| e.to_string())
    }
}

#[derive(Deserialize, serde::Serialize)]
pub struct EditorState {
    pub file_path: Option<String>,
    pub worker_url: Option<String>,
    pub cursor_pos: usize,
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
