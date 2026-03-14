use anyhow::Result;

/// Fetch a URL using Cloudflare's Markdown for Agents.
///
/// Sends a request with `Accept: text/markdown` header, which triggers
/// Cloudflare's on-the-fly HTML-to-Markdown conversion for supported sites.
pub async fn fetch_as_markdown(url: &str) -> Result<MarkdownResponse> {
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("Accept", "text/markdown")
        .send()
        .await?;

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

    let body = response.text().await?;

    Ok(MarkdownResponse {
        body,
        token_count,
        is_markdown: content_type.contains("text/markdown"),
    })
}

pub struct MarkdownResponse {
    pub body: String,
    pub token_count: Option<u64>,
    /// Whether the server actually returned markdown (vs plain HTML).
    pub is_markdown: bool,
}
