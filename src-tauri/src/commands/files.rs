use serde::Serialize;

use crate::error::{AppError, Result};

// --- Path Validation ---

/// Canonicalize a path without restricting to a specific directory.
fn resolve_path(path: &str) -> Result<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    match p.canonicalize() {
        Ok(canonical) => Ok(canonical),
        Err(_) => {
            let parent = p
                .parent()
                .ok_or_else(|| AppError::Validation("Invalid path: no parent directory".into()))?;
            let file_name = p
                .file_name()
                .ok_or_else(|| AppError::Validation("Invalid path: no file name".into()))?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| AppError::Io(format!("Invalid parent path: {e}")))?;
            Ok(canonical_parent.join(file_name))
        }
    }
}

/// Validate and sanitize a user-provided path to prevent path traversal attacks.
/// Ensures the resolved path is under the user's home directory.
pub fn validate_path(path: &str) -> Result<std::path::PathBuf> {
    let resolved = resolve_path(path)?;

    let home =
        crate::util::home_dir().ok_or_else(|| AppError::Io("Cannot determine home directory".into()))?;
    if !resolved.starts_with(&home) {
        return Err(AppError::Validation(format!(
            "Access denied: path must be under {}",
            home.display()
        )));
    }

    Ok(resolved)
}

/// Validate a path for read-only access. Allows any location since the user
/// explicitly chose the file (e.g. via the native file dialog).
pub fn validate_read_path(path: &str) -> Result<std::path::PathBuf> {
    resolve_path(path)
}

// --- File Tree ---

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub extension: Option<String>,
    pub modified_at: Option<u64>,
    /// Paths of successive lone child directories (single-child chains),
    /// used by the sidebar to render folded directory names like "a/b/c".
    /// Only populated when `list_directory` is called with `fold_info`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fold_chain: Option<Vec<String>>,
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    let path = validate_read_path(&path)?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Io(format!("Failed to read file: {e}")))
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<()> {
    let path = validate_path(&path)?;
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("Failed to write file: {e}")))
}

#[tauri::command]
pub async fn copy_to_clipboard(text: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::Io(format!("pbcopy failed: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| AppError::Io(format!("pbcopy write failed: {e}")))?;
        }
        child
            .wait()
            .map_err(|e| AppError::Io(format!("pbcopy failed: {e}")))?;
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response> {
    let path = validate_path(&path)?;
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Io(format!("Failed to read file: {e}")))?;
    // Raw IPC response — the frontend receives an ArrayBuffer instead of a
    // JSON number array.
    Ok(tauri::ipc::Response::new(data))
}

/// Extract the percent-encoded `path` header and raw binary body from a
/// raw-IPC request (used by commands that receive file bytes from JS).
fn raw_request_parts<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<(String, &'a [u8])> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(AppError::Validation("Expected raw binary request body".into()));
    };
    let encoded = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Validation("Missing path header".into()))?;
    let path = urlencoding::decode(encoded)
        .map_err(|e| AppError::Validation(format!("Invalid path header: {e}")))?
        .into_owned();
    Ok((path, data.as_slice()))
}

#[tauri::command]
pub async fn list_directory(path: String, fold_info: Option<bool>) -> Result<Vec<FileEntry>> {
    let path = validate_path(&path)?;
    let mut entries = read_dir_entries(&path).await?;
    if fold_info.unwrap_or(false) {
        for entry in entries.iter_mut().filter(|e| e.is_dir) {
            entry.fold_chain = compute_fold_chain(&entry.path).await;
        }
    }
    Ok(entries)
}

/// Walk down single-child directory chains starting at `start`.
/// Returns the paths of successive lone child directories, or `None`
/// when `start` contains anything other than exactly one directory.
async fn compute_fold_chain(start: &str) -> Option<Vec<String>> {
    const MAX_CHAIN: usize = 16; // guard against symlink loops
    let mut chain = Vec::new();
    let mut current = std::path::PathBuf::from(start);
    while chain.len() < MAX_CHAIN {
        let Ok(entries) = read_dir_entries(&current).await else {
            break;
        };
        if entries.len() != 1 || !entries[0].is_dir {
            break;
        }
        chain.push(entries[0].path.clone());
        current = std::path::PathBuf::from(&entries[0].path);
    }
    (!chain.is_empty()).then_some(chain)
}

/// Walk a directory tree recursively, applying the same hidden-entry
/// filtering as `list_directory`. Limits: max 20 levels deep,
/// max 10 000 entries, skips `.git/` and `__pycache__/`.
pub async fn list_recursive(root: &str) -> Result<Vec<FileEntry>> {
    const MAX_DEPTH: usize = 20;
    const MAX_ENTRIES: usize = 10_000;

    let mut result = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(validate_path(root)?, 0)];

    while let Some((dir, depth)) = stack.pop() {
        let entries = read_dir_entries(&dir).await?;
        for entry in entries {
            if entry.is_dir {
                let name = entry.name.as_str();
                if name == ".git" || name == "__pycache__" {
                    continue;
                }
                if depth < MAX_DEPTH {
                    stack.push((std::path::PathBuf::from(&entry.path), depth + 1));
                }
            }
            result.push(entry);
            if result.len() >= MAX_ENTRIES {
                return Ok(result);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn list_directory_recursive(path: String) -> Result<Vec<FileEntry>> {
    list_recursive(&path).await
}

async fn read_dir_entries(path: &std::path::Path) -> Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(path)
        .await
        .map_err(|e| AppError::Io(format!("Failed to read directory: {e}")))?;

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;
        let entry_path = entry.path();
        let extension = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        let modified_at = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        entries.push(FileEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            extension,
            modified_at,
            fold_chain: None,
        });
    }

    // Filter out well-known build artifact and dependency directories.
    const HIDDEN_DIRS: &[&str] = &["node_modules", "target", "dist", "build"];
    // Filter out OS-generated junk files.
    const HIDDEN_FILES: &[&str] = &[".DS_Store", "Thumbs.db"];
    entries.retain(|e| {
        !(e.is_dir && HIDDEN_DIRS.contains(&e.name.as_str()))
            && !(!e.is_dir && HIDDEN_FILES.contains(&e.name.as_str()))
    });

    // Sort: directories first, then alphabetically (case-insensitive)
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));

    Ok(entries)
}


#[tauri::command]
pub async fn create_file(path: String) -> Result<()> {
    let p = validate_path(&path)?;
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::Io("File already exists".into()))
        }
        Err(e) => Err(AppError::Io(format!("Failed to create file: {e}"))),
    }
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<()> {
    let p = validate_path(&path)?;
    match tokio::fs::create_dir(&p).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::Io("Directory already exists".into()))
        }
        Err(e) => Err(AppError::Io(format!("Failed to create directory: {e}"))),
    }
}

#[tauri::command]
pub async fn rename_entry(from: String, to: String) -> Result<()> {
    let from = validate_path(&from)?;
    let to = validate_path(&to)?;
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| AppError::Io(format!("Failed to rename: {e}")))
}

#[tauri::command]
pub async fn write_file_bytes(request: tauri::ipc::Request<'_>) -> Result<()> {
    let (path, data) = raw_request_parts(&request)?;
    let dest = validate_path(&path)?;
    if dest.exists() {
        return Err(AppError::Io(format!(
            "'{}' already exists",
            dest.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        )));
    }
    tokio::fs::write(&dest, data)
        .await
        .map_err(|e| AppError::Io(format!("Failed to write file: {e}")))
}

#[tauri::command]
pub async fn save_image(request: tauri::ipc::Request<'_>) -> Result<()> {
    let (path, data) = raw_request_parts(&request)?;
    let dest = validate_path(&path)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;
    }
    tokio::fs::write(&dest, data)
        .await
        .map_err(|e| AppError::Io(format!("Failed to save image: {e}")))
}

#[tauri::command]
pub async fn delete_entry(path: String, is_dir: bool) -> Result<()> {
    let _ = is_dir; // trash::delete handles both files and directories
    let validated = validate_path(&path)?;
    let path_clone = validated.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        trash::delete(&path_clone).map_err(|e| AppError::Io(format!("Failed to move to trash: {e}")))
    })
    .await?
}

#[tauri::command]
pub async fn copy_entry(from: String, to_dir: String) -> Result<String> {
    let src = validate_path(&from)?;
    let to_dir = validate_path(&to_dir)?;
    let file_name = src
        .file_name()
        .ok_or(AppError::Validation("Invalid source path".into()))?
        .to_string_lossy()
        .to_string();
    let dest = to_dir.join(&file_name);
    if dest.exists() {
        return Err(AppError::Io(format!(
            "'{}' already exists in destination",
            file_name
        )));
    }
    if src.is_dir() {
        copy_dir_recursive(&src, &dest).await?;
    } else {
        tokio::fs::copy(&src, &dest)
            .await
            .map_err(|e| AppError::Io(format!("Failed to copy: {e}")))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn duplicate_entry(path: String) -> Result<String> {
    let validated = validate_path(&path)?;
    let path_clone = validated.to_string_lossy().to_string();
    let dest = tokio::task::spawn_blocking(move || {
        let src = std::path::Path::new(&path_clone);
        let parent = src
            .parent()
            .ok_or(AppError::Validation("No parent directory".into()))?;
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let ext = src.extension().and_then(|s| s.to_str());

        // Find a unique name: "file copy.md", "file copy 2.md", ...
        let mut n = 0u32;
        loop {
            let suffix = if n == 0 {
                " copy".to_string()
            } else {
                format!(" copy {}", n + 1)
            };
            let name = match ext {
                Some(e) => format!("{stem}{suffix}.{e}"),
                None => format!("{stem}{suffix}"),
            };
            let candidate = parent.join(&name);
            if !candidate.exists() {
                break Ok::<_, AppError>(candidate);
            }
            n += 1;
            if n > 100 {
                break Err(AppError::Io("Too many copies exist".into()));
            }
        }
    })
    .await??;

    let src = &validated;
    if src.is_dir() {
        copy_dir_recursive(src, &dest).await?;
    } else {
        tokio::fs::copy(src, &dest)
            .await
            .map_err(|e| AppError::Io(format!("Failed to duplicate: {e}")))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

async fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<()> {
    let canonical_src = src
        .canonicalize()
        .map_err(|e| AppError::Io(format!("Failed to resolve source path: {e}")))?;
    tokio::fs::create_dir(dest)
        .await
        .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;
    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| AppError::Io(format!("Failed to read directory: {e}")))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::Io(format!("Failed to read entry: {e}")))?
    {
        let entry_path = entry.path();
        // Prevent symlink traversal: ensure the entry resolves within the source directory
        let canonical_entry = entry_path
            .canonicalize()
            .map_err(|e| AppError::Io(format!("Failed to resolve path: {e}")))?;
        if !canonical_entry.starts_with(&canonical_src) {
            return Err(AppError::Validation(format!(
                "Symlink escape detected: {}",
                entry_path.display()
            )));
        }
        let dest_path = dest.join(entry.file_name());
        if canonical_entry.is_dir() {
            Box::pin(copy_dir_recursive(&canonical_entry, &dest_path)).await?;
        } else {
            tokio::fs::copy(&canonical_entry, &dest_path)
                .await
                .map_err(|e| AppError::Io(format!("Failed to copy file: {e}")))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn import_paths(sources: Vec<String>, target_dir: String) -> Result<Vec<String>> {
    let target = validate_path(&target_dir)?;
    if !target.is_dir() {
        return Err(AppError::Validation("Target is not a directory".into()));
    }
    let mut imported = Vec::new();
    for source in &sources {
        let src = validate_read_path(source)?;
        let file_name = src
            .file_name()
            .ok_or(AppError::Validation("Invalid source path".into()))?;
        let dest = target.join(file_name);
        if dest.exists() {
            continue;
        }
        if src.is_dir() {
            copy_dir_recursive(&src, &dest).await?;
        } else {
            tokio::fs::copy(&src, &dest)
                .await
                .map_err(|e| AppError::Io(format!("Failed to copy: {e}")))?;
        }
        imported.push(dest.to_string_lossy().to_string());
    }
    Ok(imported)
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to reveal in Finder: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", &path))
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to reveal in Explorer: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file manager: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<()> {
    let dir = if std::path::Path::new(&path).is_dir() {
        path
    } else {
        std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path)
    };
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&dir)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open Terminal: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d {dir}")])
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open terminal: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        let terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
        let mut opened = false;
        for term in &terminals {
            if std::process::Command::new(term)
                .current_dir(&dir)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err(AppError::Io("No terminal emulator found".into()));
        }
    }
    Ok(())
}
