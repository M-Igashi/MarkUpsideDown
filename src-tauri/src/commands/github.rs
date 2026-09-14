//! GitHub issue and pull request access via the `gh` CLI.
//!
//! Every call is scoped to an explicit `owner/name` repository so the working
//! directory of the app process never influences which repository is touched.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

use super::git::run_cli;
use super::spawn_blocking;
use crate::error::{AppError, Result};

const LIST_FIELDS: &str = "number,title,state,updatedAt,author,labels,url";
const LIST_FIELDS_PR: &str = "number,title,state,updatedAt,author,labels,url,isDraft";
const VIEW_FIELDS: &str = "number,title,state,updatedAt,author,labels,url,body,comments";
const VIEW_FIELDS_PR: &str =
    "number,title,state,updatedAt,author,labels,url,body,comments,isDraft";

// --- gh CLI runner ---

fn gh_command(args: &[&str]) -> Command {
    let mut cmd = Command::new("gh");
    cmd.args(args);
    // GUI launches inherit a minimal PATH and no HOME, so gh would be
    // unfindable and unable to read its auth config.
    crate::cloudflare::setup_gui_env(&mut cmd);
    cmd
}

fn gh_output(output: std::process::Output) -> Result<String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::GitHub(if stderr.is_empty() {
            "gh command failed".to_string()
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_gh(args: &[&str]) -> Result<String> {
    let output = gh_command(args)
        .output()
        .map_err(|e| AppError::GitHub(format!("Failed to run gh: {e}")))?;
    gh_output(output)
}

/// Run gh with `input` piped to stdin (used for `--body-file -`), which keeps
/// issue bodies out of both the argument list and any temporary file.
fn run_gh_with_stdin(args: &[&str], input: &str) -> Result<String> {
    let mut child = gh_command(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::GitHub(format!("Failed to run gh: {e}")))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::GitHub("Failed to open gh stdin".to_string()))?;
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| AppError::GitHub(format!("Failed to write to gh: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::GitHub(format!("gh did not complete: {e}")))?;
    gh_output(output)
}

// --- Input validation ---

/// Reject anything that is not a plain `owner/name` pair so a crafted value
/// can never be read by gh as a flag.
fn validate_repo(repo: &str) -> Result<()> {
    let parts: Vec<&str> = repo.split('/').collect();
    let valid = parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        });
    if valid {
        Ok(())
    } else {
        Err(AppError::Validation(format!("Invalid repository: {repo}")))
    }
}

fn validate_kind(kind: &str) -> Result<&'static str> {
    match kind {
        "issue" => Ok("issue"),
        "pr" => Ok("pr"),
        other => Err(AppError::Validation(format!("Invalid item kind: {other}"))),
    }
}

fn validate_state(state: &str) -> Result<&'static str> {
    match state {
        "open" => Ok("open"),
        "closed" => Ok("closed"),
        "merged" => Ok("merged"),
        "all" => Ok("all"),
        other => Err(AppError::Validation(format!("Invalid state filter: {other}"))),
    }
}

/// Extract `owner/name` from a github.com remote URL (HTTPS or SSH).
fn parse_github_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = ["git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/"]
        .iter()
        .find_map(|prefix| url.strip_prefix(*prefix))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let name = parts.next()?;
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

// --- Response types ---

/// GitHub returns bodies with CRLF line endings, which would otherwise show up
/// as phantom edits the moment a document is loaded into the editor.
fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n")
}

#[derive(Serialize, Deserialize)]
pub struct GhUser {
    #[serde(default)]
    pub login: String,
}

#[derive(Serialize, Deserialize)]
pub struct GhLabel {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: String,
}

#[derive(Serialize, Deserialize)]
pub struct GhComment {
    #[serde(default)]
    pub author: Option<GhUser>,
    #[serde(default)]
    pub body: String,
    #[serde(alias = "createdAt", default)]
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct GhItem {
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(alias = "updatedAt", default)]
    pub updated_at: String,
    #[serde(default)]
    pub author: Option<GhUser>,
    #[serde(default)]
    pub labels: Vec<GhLabel>,
    #[serde(default)]
    pub url: String,
    #[serde(alias = "isDraft", default)]
    pub is_draft: bool,
}

#[derive(Serialize, Deserialize)]
pub struct GhItemDetail {
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(alias = "updatedAt", default)]
    pub updated_at: String,
    #[serde(default)]
    pub author: Option<GhUser>,
    #[serde(default)]
    pub labels: Vec<GhLabel>,
    #[serde(default)]
    pub url: String,
    #[serde(alias = "isDraft", default)]
    pub is_draft: bool,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub comments: Vec<GhComment>,
}

#[derive(Serialize)]
pub struct GhStatus {
    pub cli_available: bool,
    pub authenticated: bool,
    /// `owner/name` when the project's origin remote points at github.com.
    pub repo: Option<String>,
}

// --- Commands ---

fn repo_from_path(repo_path: &str) -> Option<String> {
    run_cli("git", &["-C", repo_path, "remote", "get-url", "origin"])
        .ok()
        .and_then(|url| parse_github_remote(&url))
}

/// Resolve just the `owner/name` of a project, skipping the CLI and auth
/// probes that `gh_status` performs.
pub async fn gh_repo(repo_path: String) -> Result<Option<String>> {
    spawn_blocking(move || Ok(repo_from_path(&repo_path))).await
}

#[tauri::command]
pub async fn gh_status(repo_path: String) -> Result<GhStatus> {
    spawn_blocking(move || {
        let cli_available = run_gh(&["--version"]).is_ok();
        Ok(GhStatus {
            cli_available,
            authenticated: cli_available && run_gh(&["auth", "status"]).is_ok(),
            repo: repo_from_path(&repo_path),
        })
    })
    .await
}

#[tauri::command]
pub async fn gh_list(
    repo: String,
    kind: String,
    state: String,
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<GhItem>> {
    spawn_blocking(move || {
        validate_repo(&repo)?;
        let kind = validate_kind(&kind)?;
        let state = validate_state(&state)?;
        let limit = limit.unwrap_or(50).clamp(1, 200).to_string();
        let fields = if kind == "pr" { LIST_FIELDS_PR } else { LIST_FIELDS };

        let search = search
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(|q| format!("--search={q}"));

        let mut args = vec![
            kind,
            "list",
            "--repo",
            repo.as_str(),
            "--state",
            state,
            "--limit",
            limit.as_str(),
            "--json",
            fields,
        ];
        if let Some(ref s) = search {
            args.push(s.as_str());
        }

        let output = run_gh(&args)?;
        let mut items: Vec<GhItem> = serde_json::from_str(&output)
            .map_err(|e| AppError::GitHub(format!("Failed to parse gh output: {e}")))?;
        for item in &mut items {
            item.title = normalize_newlines(&item.title);
        }
        Ok(items)
    })
    .await
}

fn fetch_detail(repo: &str, kind: &str, number: u64) -> Result<GhItemDetail> {
    let fields = if kind == "pr" { VIEW_FIELDS_PR } else { VIEW_FIELDS };
    let number = number.to_string();
    let output = run_gh(&[kind, "view", number.as_str(), "--repo", repo, "--json", fields])?;
    let mut detail: GhItemDetail = serde_json::from_str(&output)
        .map_err(|e| AppError::GitHub(format!("Failed to parse gh output: {e}")))?;
    detail.title = normalize_newlines(&detail.title);
    detail.body = normalize_newlines(&detail.body);
    for comment in &mut detail.comments {
        comment.body = normalize_newlines(&comment.body);
    }
    Ok(detail)
}

#[tauri::command]
pub async fn gh_view(repo: String, kind: String, number: u64) -> Result<GhItemDetail> {
    spawn_blocking(move || {
        validate_repo(&repo)?;
        let kind = validate_kind(&kind)?;
        fetch_detail(&repo, kind, number)
    })
    .await
}

/// Update the title and body, returning the refreshed item.
///
/// `expected_body` is the body the editor was opened with. Comparing bodies
/// rather than timestamps means a new comment never looks like a conflict.
#[tauri::command]
pub async fn gh_update(
    repo: String,
    kind: String,
    number: u64,
    title: String,
    body: String,
    expected_body: Option<String>,
) -> Result<GhItemDetail> {
    spawn_blocking(move || {
        validate_repo(&repo)?;
        let kind = validate_kind(&kind)?;

        if let Some(expected) = expected_body {
            let current = fetch_detail(&repo, kind, number)?;
            if current.body != expected {
                return Err(AppError::GitHub(
                    "This has been edited on GitHub since it was opened. Reload before saving."
                        .to_string(),
                ));
            }
        }

        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::Validation("Title cannot be empty".to_string()));
        }

        let number_arg = number.to_string();
        let title_arg = format!("--title={title}");
        run_gh_with_stdin(
            &[
                kind,
                "edit",
                number_arg.as_str(),
                "--repo",
                repo.as_str(),
                title_arg.as_str(),
                "--body-file",
                "-",
            ],
            &body,
        )?;

        fetch_detail(&repo, kind, number)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remotes() {
        for url in [
            "https://github.com/M-Igashi/markupsidedown.git",
            "https://github.com/M-Igashi/markupsidedown",
            "git@github.com:M-Igashi/markupsidedown.git",
            "ssh://git@github.com/M-Igashi/markupsidedown.git",
        ] {
            assert_eq!(
                parse_github_remote(url).as_deref(),
                Some("M-Igashi/markupsidedown")
            );
        }
    }

    #[test]
    fn rejects_non_github_remotes() {
        for url in [
            "https://gitlab.com/owner/repo.git",
            "git@bitbucket.org:owner/repo.git",
            "https://github.com/owner",
        ] {
            assert_eq!(parse_github_remote(url), None);
        }
    }

    #[test]
    fn rejects_flag_like_repositories() {
        assert!(validate_repo("owner/repo").is_ok());
        assert!(validate_repo("--repo=evil/repo").is_err());
        assert!(validate_repo("owner/repo/extra").is_err());
        assert!(validate_repo("owner").is_err());
    }
}
