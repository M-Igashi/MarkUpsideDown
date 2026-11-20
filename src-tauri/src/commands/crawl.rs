use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::web::{worker_request, HasWorkerError};
use crate::error::{AppError, Result};

// --- Website Crawl via Browser Rendering /crawl API ---

#[derive(Deserialize)]
struct CrawlStartWorkerResponse {
    job_id: Option<String>,
    error: Option<String>,
}

impl HasWorkerError for CrawlStartWorkerResponse {
    fn take_error(&mut self) -> Option<String> { self.error.take() }
}

#[derive(Serialize)]
pub struct CrawlStartResult {
    pub job_id: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn crawl_website(
    url: String,
    worker_url: String,
    worker_key: Option<String>,
    depth: u32,
    limit: u32,
    render: bool,
    include_patterns: Option<Vec<String>>,
    exclude_patterns: Option<Vec<String>>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<CrawlStartResult> {
    let crawl_url = format!("{}/crawl", worker_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "url": url,
        "depth": depth,
        "limit": limit,
        "render": render,
    });

    if let Some(ref patterns) = include_patterns
        && !patterns.is_empty()
    {
        body["includePatterns"] = serde_json::json!(patterns);
    }
    if let Some(ref patterns) = exclude_patterns
        && !patterns.is_empty()
    {
        body["excludePatterns"] = serde_json::json!(patterns);
    }

    let resp: CrawlStartWorkerResponse = worker_request(
        client
            .post(&crawl_url)
            .timeout(Duration::from_secs(30))
            .json(&body),
        worker_key.as_deref(),
    )
    .await?;

    Ok(CrawlStartResult {
        job_id: resp
            .job_id
            .ok_or(AppError::Worker("No job_id in response".into()))?,
    })
}

#[derive(Deserialize)]
struct CrawlRecord {
    url: Option<String>,
    markdown: Option<String>,
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
struct CrawlStatusWorkerResponse {
    result: Option<CrawlResultInner>,
    error: Option<String>,
}

impl HasWorkerError for CrawlStatusWorkerResponse {
    fn take_error(&mut self) -> Option<String> { self.error.take() }
}

#[derive(Serialize, Deserialize)]
pub struct CrawlPage {
    pub url: String,
    pub markdown: String,
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
    worker_key: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<CrawlStatusResult> {
    let mut status_url = format!(
        "{}/crawl/{}?limit={}&status=completed",
        worker_url.trim_end_matches('/'),
        job_id,
        limit.unwrap_or(100)
    );
    if let Some(ref c) = cursor {
        status_url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
    }

    let resp: CrawlStatusWorkerResponse = worker_request(
        client.get(&status_url).timeout(Duration::from_secs(30)),
        worker_key.as_deref(),
    )
    .await?;

    let result = resp
        .result
        .ok_or(AppError::Worker("No result in response".into()))?;

    let pages: Vec<CrawlPage> = result
        .records
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            Some(CrawlPage {
                url: r.url?,
                markdown: r.markdown.unwrap_or_default(),
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
    /// Saved file path of each page, in input order.
    pub paths: Vec<String>,
}

#[tauri::command]
pub async fn crawl_save(
    pages: Vec<CrawlPage>,
    base_dir: String,
) -> Result<CrawlSaveResult> {
    // Also reachable from AI agents via the MCP bridge, so confine writes like
    // every other write command does.
    let base = super::validate_path(&base_dir)?;
    let base = base.to_string_lossy();
    let mut saved_count = 0u32;
    let mut paths: Vec<String> = Vec::new();

    for page in &pages {
        let file_path = unique_path(url_to_filepath(&page.url, &base), &paths);
        if let Some(parent) = std::path::Path::new(&file_path).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;
        }
        // Write beside the target and rename, so an interrupted save never
        // leaves a truncated page where a complete one used to be.
        let tmp_path = format!("{file_path}.tmp-{}", std::process::id());
        let written = match tokio::fs::write(&tmp_path, &page.markdown).await {
            Ok(()) => tokio::fs::rename(&tmp_path, &file_path).await,
            Err(e) => Err(e),
        };
        if let Err(e) = written {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(AppError::Io(format!("Failed to write {file_path}: {e}")));
        }
        saved_count += 1;
        paths.push(file_path);
    }

    Ok(CrawlSaveResult {
        saved_count,
        base_dir,
        paths,
    })
}

/// Two URLs of one crawl can still map to the same file (names differing only
/// in characters that sanitizing replaces, or in case). Number the later ones
/// instead of letting them overwrite the earlier page.
fn unique_path(path: String, taken: &[String]) -> String {
    let is_taken = |p: &str| taken.iter().any(|t| t.eq_ignore_ascii_case(p));
    if !is_taken(&path) {
        return path;
    }
    let stem = path.strip_suffix(".md").unwrap_or(&path);
    (2..)
        .map(|n| format!("{stem}-{n}.md"))
        .find(|p| !is_taken(p))
        .unwrap_or(path)
}

fn url_to_filepath(url: &str, base_dir: &str) -> String {
    // Simple URL parsing without the `url` crate
    let without_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let (host_port, path) = match without_scheme.find(['/', '?', '#']) {
        Some(i) => (&without_scheme[..i], &without_scheme[i..]),
        None => (without_scheme, "/"),
    };
    let host = host_port.split(':').next().unwrap_or("unknown");
    // Drop the fragment. The query string stays in the file name, because
    // `/item?id=1` and `/item?id=2` are different pages.
    let path = path.split('#').next().unwrap_or(path);
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let query: String = sanitize_filename(query).chars().take(80).collect();

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
            // Last segment: append the query and the .md extension
            let stem = clean.strip_suffix(".md").unwrap_or(&clean);
            if query.is_empty() {
                file_path.push(format!("{stem}.md"));
            } else {
                file_path.push(format!("{stem}_{query}.md"));
            }
        } else {
            file_path.push(&clean);
        }
    }

    file_path.to_string_lossy().to_string()
}

fn sanitize_filename(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    // Reject dot-only segments ("." / "..") to prevent path traversal
    if cleaned.chars().all(|c| c == '.') {
        return String::new();
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_strings_map_to_different_files() {
        let a = url_to_filepath("https://example.com/item?id=1#top", "/base");
        let b = url_to_filepath("https://example.com/item?id=2", "/base");
        assert_eq!(a, "/base/example.com/item_id_1.md");
        assert_eq!(b, "/base/example.com/item_id_2.md");
        assert_eq!(url_to_filepath("https://example.com/docs/a.md", "/base"), "/base/example.com/docs/a.md");
        assert_eq!(url_to_filepath("https://example.com", "/base"), "/base/example.com/index.md");
        assert_eq!(url_to_filepath("https://example.com?p=2", "/base"), "/base/example.com/index_p_2.md");
    }

    #[test]
    fn colliding_paths_are_numbered() {
        let taken = vec!["/base/a.md".to_string(), "/base/a-2.md".to_string()];
        assert_eq!(unique_path("/base/A.md".into(), &taken), "/base/A-3.md");
        assert_eq!(unique_path("/base/b.md".into(), &taken), "/base/b.md");
    }
}
