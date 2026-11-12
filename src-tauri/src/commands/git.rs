use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use super::spawn_blocking;
use crate::error::{AppError, Result};

// --- CLI Command Runner ---

/// Long enough for a slow push or pull, short enough that a dead connection
/// or a credential prompt does not leave the panel spinning forever.
const CLI_TIMEOUT: Duration = Duration::from_secs(120);
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);

pub(super) fn run_cli(cmd: &str, args: &[&str]) -> Result<String> {
    run_cli_with_timeout(cmd, args, CLI_TIMEOUT)
}

fn run_cli_with_timeout(cmd: &str, args: &[&str], timeout: Duration) -> Result<String> {
    let child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Git(format!("Failed to run {cmd}: {e}")))?;
    let output = crate::util::wait_with_timeout(child, timeout).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            AppError::Git(format!("{cmd} timed out after {} seconds", timeout.as_secs()))
        } else {
            AppError::Git(format!("Failed to run {cmd}: {e}"))
        }
    })?;

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

// --- Argument Validation ---

/// Reject values git would parse as an option instead of a path or revision.
fn reject_option_like(kind: &str, value: &str) -> Result<()> {
    if value.starts_with('-') {
        return Err(AppError::Git(format!("Invalid {kind}: {value}")));
    }
    Ok(())
}

/// Commit hashes always come from `git_log`, so anything that is not a plain
/// hex object name is rejected rather than handed to git as a revision.
fn validate_commit_hash(hash: &str) -> Result<()> {
    if (4..=40).contains(&hash.len()) && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::Git(format!("Invalid commit hash: {hash}")))
    }
}

/// `<helper>::<address>` remotes (`ext::`, `fd::`, ...) make git execute an
/// arbitrary command, so only ordinary transports and local paths are allowed.
fn validate_clone_url(url: &str) -> Result<()> {
    reject_option_like("clone URL", url)?;
    if url.contains("::") {
        return Err(AppError::Git(format!("Unsupported clone URL: {url}")));
    }
    Ok(())
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
    reject_option_like("repository path", repo_path)?;
    let mut full_args = vec!["-C", repo_path];
    full_args.extend_from_slice(args);
    run_cli("git", &full_args)
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
pub async fn git_status(repo_path: String, include_stats: Option<bool>) -> Result<GitStatus> {
    let include_stats = include_stats.unwrap_or(true);
    spawn_blocking(move || {
        // Hold lock for all commands to avoid racing with multi-step
        // operations like git_revert (stash -> revert -> pop).
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let status_result = run_git_unlocked(&repo_path, &["status", "-b", "--porcelain=v1"]).ok();
        // The per-file line counts are only shown in the git panel, so
        // callers can skip the two diff processes when it is hidden.
        let (unstaged_raw, staged_raw) = if include_stats {
            (
                run_git_unlocked(&repo_path, &["diff", "--numstat"]).ok(),
                run_git_unlocked(&repo_path, &["diff", "--cached", "--numstat"]).ok(),
            )
        } else {
            (None, None)
        };

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
            let mut raw_path = &line[3..];
            // Renames and copies are reported as "old -> new"
            if matches!(index_status, 'R' | 'C')
                && let Some((_, new)) = raw_path.split_once(" -> ")
            {
                raw_path = new;
            }
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
        // Fetch and push do not touch the index, so they run outside GIT_LOCK
        // and cannot stall status polling while the network is slow.
        let _guard = (cmd == "pull").then(|| GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner()));
        let output = run_git_unlocked(&repo_path, &[cmd])?;
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
            // Files and whole untracked directories go to the Trash, not oblivion
            let full_path = std::path::Path::new(&repo_path).join(&file_path);
            trash::delete(&full_path)
                .map_err(|e| AppError::Io(format!("Failed to move {file_path} to the Trash: {e}")))?;
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
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Move untracked files and directories to the Trash (what `git clean -fd`
        // would delete permanently)
        let untracked = run_git_unlocked(
            &repo_path,
            &["ls-files", "--others", "--exclude-standard", "--directory", "-z"],
        )?;
        let paths: Vec<_> = untracked
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(|p| std::path::Path::new(&repo_path).join(p.trim_end_matches('/')))
            .collect();
        if !paths.is_empty() {
            trash::delete_all(&paths)
                .map_err(|e| AppError::Io(format!("Failed to move untracked files to the Trash: {e}")))?;
        }
        // Unstage everything first (handles staged deletions)
        let _ = run_git_unlocked(&repo_path, &["reset", "HEAD", "--", "."]);
        // Restore all tracked files
        let _ = run_git_unlocked(&repo_path, &["checkout", "--", "."]);
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
        validate_commit_hash(&commit_hash)?;
        let _guard = GIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // Require clean working tree
        let status = run_git_unlocked(&repo_path, &["status", "--porcelain"])?;
        if !status.trim().is_empty() {
            return Err(AppError::Git(
                "Commit or discard changes before reverting.".into(),
            ));
        }

        let short = if commit_hash.len() >= 7 { &commit_hash[..7] } else { &commit_hash };

        // Fail before touching the tree when the hash does not name a commit
        run_git_unlocked(
            &repo_path,
            &["rev-parse", "--verify", "--quiet", &format!("{commit_hash}^{{commit}}")],
        )
        .map_err(|_| AppError::Git(format!("Unknown commit: {commit_hash}")))?;

        // Restore entire working tree to the target commit's state:
        // 1. Remove all tracked files from index and working tree
        // 2. Restore all files from the target commit
        // 3. Commit the result as a new commit
        // (rm fails harmlessly when HEAD has no tracked files)
        let _ = run_git_unlocked(&repo_path, &["rm", "-rf", "--quiet", "."]);
        let result = run_git_unlocked(&repo_path, &["checkout", &commit_hash, "--", "."])
            .and_then(|_| {
                run_git_unlocked(
                    &repo_path,
                    &["commit", "--allow-empty", "-m", &format!("Revert to {short}")],
                )
            });
        if result.is_err() {
            // The tree was clean before we started, so this restores it exactly
            let _ = run_git_unlocked(&repo_path, &["reset", "--hard", "HEAD"]);
        }
        Ok(result?.trim().to_string())
    })
    .await
}

// --- Show commit diff ---

#[tauri::command]
pub async fn git_show(repo_path: String, commit_hash: String) -> Result<String> {
    spawn_blocking(move || {
        validate_commit_hash(&commit_hash)?;
        run_git(&repo_path, &["show", "--patch", "--format=", &commit_hash])
    })
    .await
}

// --- Clone ---

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<String> {
    spawn_blocking(move || {
        validate_clone_url(&url)?;
        reject_option_like("clone destination", &dest)?;
        run_cli_with_timeout("git", &["clone", "--", &url, &dest], CLONE_TIMEOUT).map(|s| s.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_init(repo_path: String) -> Result<String> {
    spawn_blocking(move || {
        reject_option_like("repository path", &repo_path)?;
        run_cli("git", &["init", "--", &repo_path]).map(|s| s.trim().to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> String {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("mud-git-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_string_lossy().into_owned();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "t"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run_git(&repo, args).unwrap();
        }
        std::fs::write(dir.join("a.md"), "one").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-qm", "init"]).unwrap();
        repo
    }

    #[tokio::test]
    async fn failed_revert_leaves_the_tree_intact() {
        let repo = temp_repo();
        let err = git_revert(repo.clone(), "deadbeefdeadbeef".into()).await;
        assert!(err.is_err());
        assert_eq!(std::fs::read_to_string(format!("{repo}/a.md")).unwrap(), "one");
        assert!(run_git(&repo, &["status", "--porcelain"]).unwrap().is_empty());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[tokio::test]
    async fn status_reports_renames_by_new_path() {
        let repo = temp_repo();
        run_git(&repo, &["mv", "a.md", "b.md"]).unwrap();
        let status = git_status(repo.clone(), None).await.unwrap();
        assert_eq!(status.files[0].path, "b.md");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn rejects_transport_helper_clone_urls() {
        assert!(validate_clone_url("ext::sh -c 'touch /tmp/pwned'").is_err());
        assert!(validate_clone_url("fd::7").is_err());
        assert!(validate_clone_url("--upload-pack=touch /tmp/pwned").is_err());
    }

    #[test]
    fn accepts_ordinary_clone_urls() {
        assert!(validate_clone_url("https://github.com/owner/repo.git").is_ok());
        assert!(validate_clone_url("git@github.com:owner/repo.git").is_ok());
        assert!(validate_clone_url("/Users/me/repos/local").is_ok());
    }

    #[test]
    fn rejects_non_hex_commit_hashes() {
        assert!(validate_commit_hash("--output=/tmp/pwned").is_err());
        assert!(validate_commit_hash("HEAD").is_err());
        assert!(validate_commit_hash("").is_err());
        assert!(validate_commit_hash("99715c3").is_ok());
    }

    #[test]
    fn rejects_option_like_repo_paths() {
        assert!(run_git_unlocked("--exec-path=/tmp", &["status"]).is_err());
        assert!(reject_option_like("repository path", "/Users/me/repo").is_ok());
    }
}
