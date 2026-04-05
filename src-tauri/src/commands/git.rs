use serde::Serialize;
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use crate::error::{AppError, Result};

// --- CLI Command Runner ---

fn run_cli(cmd: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| AppError::Git(format!("Failed to run {cmd}: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            format!("{cmd} command failed")
        } else {
            stderr
        }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// --- Git Operations ---

/// Unquote a git-quoted path (e.g. `"path with spaces"` -> `path with spaces`).
/// Handles backslash escapes: `\\`, `\"`, `\t`, `\n`, and octal (`\303\251` etc.).
fn unquote_git_path(s: &str) -> String {
    let inner = &s[1..s.len() - 1]; // strip surrounding quotes
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'\\' => { out.push(b'\\'); i += 2; }
                b'"' => { out.push(b'"'); i += 2; }
                b't' => { out.push(b'\t'); i += 2; }
                b'n' => { out.push(b'\n'); i += 2; }
                b'r' => { out.push(b'\r'); i += 2; }
                b'a' => { out.push(b'\x07'); i += 2; }
                b'b' => { out.push(b'\x08'); i += 2; }
                c if c.is_ascii_digit() => {
                    // Octal escape (up to 3 digits)
                    let mut val: u8 = c - b'0';
                    let mut j = i + 2;
                    let end = (i + 4).min(bytes.len());
                    while j < end {
                        if bytes[j].is_ascii_digit() && bytes[j] <= b'7' {
                            val = val * 8 + (bytes[j] - b'0');
                            j += 1;
                        } else {
                            break;
                        }
                    }
                    out.push(val);
                    i = j;
                }
                _ => { out.push(bytes[i]); i += 1; }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Serialize all git CLI calls so concurrent operations (e.g. status polling
/// during a multi-step revert) don't race on the index file.
static GIT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn run_git(repo_path: &str, args: &[&str]) -> Result<String> {
    let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    run_git_unlocked(repo_path, args)
}

/// Run git without acquiring GIT_LOCK -- caller must hold the lock.
fn run_git_unlocked(repo_path: &str, args: &[&str]) -> Result<String> {
    let mut full_args = vec!["-C", repo_path];
    full_args.extend_from_slice(args);
    run_cli("git", &full_args)
}

/// Run a blocking closure on the tokio thread pool, mapping join errors.
async fn spawn_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(f).await?
}

#[derive(Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,   // "M", "A", "D", "?", "R", etc.
    pub staged: bool,
    pub added_lines: u32,
    pub removed_lines: u32,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub is_repo: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus> {
    spawn_blocking(move || {
        // Hold lock for all three commands to avoid racing with multi-step
        // operations like git_revert (stash -> revert -> pop).
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let status_result = run_git_unlocked(&repo_path, &["status", "-b", "--porcelain=v1"]).ok();
        let unstaged_raw = run_git_unlocked(&repo_path, &["diff", "--numstat"]).ok();
        let staged_raw = run_git_unlocked(&repo_path, &["diff", "--cached", "--numstat"]).ok();

        let output = match status_result {
            Some(o) => o,
            None => {
                return Ok(GitStatus {
                    branch: String::new(),
                    files: Vec::new(),
                    is_repo: false,
                    ahead: 0,
                    behind: 0,
                });
            }
        };

        let mut lines = output.lines();
        // First line: "## branch...tracking [ahead N, behind M]" or "## HEAD (no branch)"
        let first_line = lines
            .next()
            .and_then(|line| line.strip_prefix("## "))
            .unwrap_or("");
        let branch = first_line.split("...").next().unwrap_or(first_line).to_string();
        let mut ahead: u32 = 0;
        let mut behind: u32 = 0;
        if let Some(bracket) = first_line.find('[') {
            let info = &first_line[bracket..];
            if let Some(n) = info
                .find("ahead ")
                .and_then(|i| info[i + 6..].split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|s| s.parse().ok())
            {
                ahead = n;
            }
            if let Some(n) = info
                .find("behind ")
                .and_then(|i| info[i + 7..].split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|s| s.parse().ok())
            {
                behind = n;
            }
        }

        let mut unstaged_stats: std::collections::HashMap<String, (u32, u32)> =
            std::collections::HashMap::new();
        let mut staged_stats: std::collections::HashMap<String, (u32, u32)> =
            std::collections::HashMap::new();

        if let Some(numstat) = unstaged_raw {
            for line in numstat.lines() {
                if let Some((added, removed, path)) = parse_numstat_line(line) {
                    unstaged_stats.insert(path, (added, removed));
                }
            }
        }
        if let Some(numstat) = staged_raw {
            for line in numstat.lines() {
                if let Some((added, removed, path)) = parse_numstat_line(line) {
                    staged_stats.insert(path, (added, removed));
                }
            }
        }

        let mut files = Vec::new();
        for line in lines {
            let bytes = line.as_bytes();
            if bytes.len() < 4 {
                continue;
            }
            let index_status = bytes[0] as char;
            let work_status = bytes[1] as char;
            let raw_path = &line[3..];
            let file_path = if raw_path.starts_with('"') && raw_path.ends_with('"') {
                unquote_git_path(raw_path)
            } else {
                raw_path.to_string()
            };

            // Staged changes
            if index_status != ' ' && index_status != '?' {
                let (added, removed) = staged_stats
                    .get(&file_path)
                    .copied()
                    .unwrap_or((0, 0));
                files.push(GitFileStatus {
                    path: file_path.clone(),
                    status: index_status.to_string(),
                    staged: true,
                    added_lines: added,
                    removed_lines: removed,
                });
            }

            // Unstaged changes
            if work_status != ' ' {
                let status = if index_status == '?' {
                    "?".to_string()
                } else {
                    work_status.to_string()
                };
                let (added, removed) = unstaged_stats
                    .get(&file_path)
                    .copied()
                    .unwrap_or((0, 0));
                files.push(GitFileStatus {
                    path: file_path,
                    status,
                    staged: false,
                    added_lines: added,
                    removed_lines: removed,
                });
            }
        }

        Ok(GitStatus {
            branch,
            files,
            is_repo: true,
            ahead,
            behind,
        })
    })
    .await
}

fn parse_numstat_line(line: &str) -> Option<(u32, u32, String)> {
    let mut parts = line.split('\t');
    let added = parts.next()?.parse::<u32>().ok()?;
    let removed = parts.next()?.parse::<u32>().ok()?;
    let path = parts.next()?.to_string();
    Some((added, removed, path))
}

#[tauri::command]
pub async fn git_stage_all(repo_path: String) -> Result<()> {
    spawn_blocking(move || {
        run_git(&repo_path, &["add", "-A"])?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_stage(repo_path: String, file_path: String) -> Result<()> {
    spawn_blocking(move || {
        run_git(&repo_path, &["add", "--", &file_path])?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, file_path: String) -> Result<()> {
    spawn_blocking(move || {
        run_git(&repo_path, &["reset", "HEAD", "--", &file_path])?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String> {
    spawn_blocking(move || {
        let output = run_git(&repo_path, &["commit", "-m", &message])?;
        Ok(output.trim().to_string())
    })
    .await
}

async fn git_remote_command(repo_path: String, cmd: &'static str) -> Result<String> {
    spawn_blocking(move || {
        let output = run_git(&repo_path, &[cmd])?;
        Ok(output.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String> {
    git_remote_command(repo_path, "push").await
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String> {
    git_remote_command(repo_path, "pull").await
}

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<String> {
    git_remote_command(repo_path, "fetch").await
}

// --- Diff ---

#[tauri::command]
pub async fn git_diff(repo_path: String, file_path: String, staged: bool) -> Result<String> {
    spawn_blocking(move || {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&file_path);
        run_git(&repo_path, &args)
    })
    .await
}

// --- Discard ---

#[tauri::command]
pub async fn git_discard(repo_path: String, file_path: String) -> Result<()> {
    spawn_blocking(move || {
        // Hold GIT_LOCK for the entire check-then-act to prevent TOCTOU races
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let status_output =
            run_git_unlocked(&repo_path, &["status", "--porcelain", "--", &file_path])?;
        let is_untracked = status_output.lines().any(|l| l.starts_with("??"));

        if is_untracked {
            let full_path = std::path::Path::new(&repo_path).join(&file_path);
            std::fs::remove_file(&full_path)
                .map_err(|e| AppError::Io(format!("Failed to delete {}: {e}", file_path)))?;
        } else {
            run_git_unlocked(&repo_path, &["checkout", "--", &file_path])?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_discard_all(repo_path: String) -> Result<()> {
    spawn_blocking(move || {
        // Unstage everything first (handles staged deletions)
        let _ = run_git(&repo_path, &["reset", "HEAD", "--", "."]);
        // Restore all tracked files
        let _ = run_git(&repo_path, &["checkout", "--", "."]);
        // Remove all untracked files and directories
        run_git(&repo_path, &["clean", "-fd"])?;
        Ok(())
    })
    .await
}

// --- Log ---

#[derive(Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub relative_time: String,
}

#[tauri::command]
pub async fn git_log(repo_path: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>> {
    let limit = limit.unwrap_or(10);
    spawn_blocking(move || {
        let limit_str = format!("-{}", limit);
        let output = run_git(
            &repo_path,
            &["log", &limit_str, "--format=%H%x00%h%x00%s%x00%an%x00%ar"],
        )?;
        let entries = output
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(5, '\0').collect();
                if parts.len() == 5 {
                    Some(GitLogEntry {
                        hash: parts[0].to_string(),
                        short_hash: parts[1].to_string(),
                        message: parts[2].to_string(),
                        author: parts[3].to_string(),
                        relative_time: parts[4].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        Ok(entries)
    })
    .await
}

// --- Revert ---

#[tauri::command]
pub async fn git_revert(repo_path: String, commit_hash: String) -> Result<String> {
    spawn_blocking(move || {
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Require clean working tree
        let status = run_git_unlocked(&repo_path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Err(AppError::Git(
                "Commit or discard changes before reverting.".into(),
            ));
        }

        let short = if commit_hash.len() >= 7 { &commit_hash[..7] } else { &commit_hash };

        // Restore entire working tree to the target commit's state:
        // 1. Remove all tracked files from index and working tree
        let _ = run_git_unlocked(&repo_path, &["rm", "-rf", "--quiet", "."]);
        // 2. Restore all files from the target commit
        run_git_unlocked(&repo_path, &["checkout", &commit_hash, "--", "."])?;
        // 3. Commit the result as a new commit
        let commit_result = run_git_unlocked(
            &repo_path,
            &["commit", "--allow-empty", "-m", &format!("Revert to {short}")],
        )?;

        Ok(commit_result.trim().to_string())
    })
    .await
}

// --- Show commit diff ---

#[tauri::command]
pub async fn git_show(repo_path: String, commit_hash: String) -> Result<String> {
    spawn_blocking(move || {
        run_git(&repo_path, &["show", "--patch", "--format=", &commit_hash])
    })
    .await
}

// --- Clone ---

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<String> {
    spawn_blocking(move || {
        run_cli("git", &["clone", &url, &dest]).map(|s| s.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_init(repo_path: String) -> Result<String> {
    spawn_blocking(move || {
        run_cli("git", &["init", &repo_path]).map(|s| s.trim().to_string())
    })
    .await
}
