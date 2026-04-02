use std::path::PathBuf;

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Extract the page title from an HTML string.
/// Looks for `<title>...</title>` (case-insensitive) and decodes common HTML entities.
pub fn extract_html_title(html: &str) -> crate::error::Result<String> {
    use crate::error::AppError;
    let lower = html.to_ascii_lowercase();
    let start = lower
        .find("<title")
        .and_then(|i| lower[i..].find('>').map(|j| i + j + 1));
    let end = lower.find("</title>");
    match (start, end) {
        (Some(s), Some(e)) if s < e => {
            let title = html[s..e].trim().to_string();
            let title = title
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&#x27;", "'")
                .replace("&apos;", "'");
            if title.is_empty() {
                Err(AppError::Validation("Empty title".into()))
            } else {
                Ok(title)
            }
        }
        _ => Err(AppError::Validation("No title found".into())),
    }
}
