use serde::{Deserialize, Serialize};
use std::time::Duration;

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
