use serde::Serialize;

// --- Path Validation ---

/// Validate and sanitize a user-provided path to prevent path traversal attacks.
/// Ensures the resolved path is under the user's home directory.
pub(crate) fn validate_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);

    // Try to canonicalize the full path first; if the file doesn't exist yet,
    // canonicalize the parent directory and append the file name.
    let resolved = match p.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            let parent = p
                .parent()
                .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
            let file_name = p
                .file_name()
                .ok_or_else(|| "Invalid path: no file name".to_string())?;
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| format!("Invalid parent path: {e}"))?;
            canonical_parent.join(file_name)
        }
    };

    let home = crate::util::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    if !resolved.starts_with(&home) {
        return Err(format!(
            "Access denied: path must be under {}",
            home.display()
        ));
    }

    Ok(resolved)
}

// --- File Tree ---

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub extension: Option<String>,
    pub modified_at: Option<u64>,
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let path = validate_path(&path)?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = validate_path(&path)?;
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let path = validate_path(&path)?;
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let path = validate_path(&path)?;
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type().await.map_err(|e| e.to_string())?;
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
pub async fn create_file(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("File already exists".to_string())
        }
        Err(e) => Err(format!("Failed to create file: {e}")),
    }
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    match tokio::fs::create_dir(&p).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("Directory already exists".to_string())
        }
        Err(e) => Err(format!("Failed to create directory: {e}")),
    }
}

#[tauri::command]
pub async fn rename_entry(from: String, to: String) -> Result<(), String> {
    let from = validate_path(&from)?;
    let to = validate_path(&to)?;
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| format!("Failed to rename: {e}"))
}

#[tauri::command]
pub async fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    let dest = validate_path(&path)?;
    if dest.exists() {
        return Err(format!(
            "'{}' already exists",
            dest.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        ));
    }
    tokio::fs::write(&dest, &data)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub async fn save_image(path: String, data: Vec<u8>) -> Result<(), String> {
    let dest = validate_path(&path)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    tokio::fs::write(&dest, &data)
        .await
        .map_err(|e| format!("Failed to save image: {e}"))
}

#[tauri::command]
pub async fn delete_entry(path: String, is_dir: bool) -> Result<(), String> {
    let _ = is_dir; // trash::delete handles both files and directories
    let validated = validate_path(&path)?;
    let path_clone = validated.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        trash::delete(&path_clone).map_err(|e| format!("Failed to move to trash: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn copy_entry(from: String, to_dir: String) -> Result<String, String> {
    let src = validate_path(&from)?;
    let to_dir = validate_path(&to_dir)?;
    let file_name = src
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy()
        .to_string();
    let dest = to_dir.join(&file_name);
    if dest.exists() {
        return Err(format!("'{}' already exists in destination", file_name));
    }
    if src.is_dir() {
        copy_dir_recursive(&src, &dest).await?;
    } else {
        tokio::fs::copy(&src, &dest)
            .await
            .map_err(|e| format!("Failed to copy: {e}"))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn duplicate_entry(path: String) -> Result<String, String> {
    let validated = validate_path(&path)?;
    let path_clone = validated.to_string_lossy().to_string();
    let dest = tokio::task::spawn_blocking(move || {
        let src = std::path::Path::new(&path_clone);
        let parent = src.parent().ok_or("No parent directory")?;
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
                break Ok::<_, String>(candidate);
            }
            n += 1;
            if n > 100 {
                break Err("Too many copies exist".to_string());
            }
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))??;

    let src = &validated;
    if src.is_dir() {
        copy_dir_recursive(src, &dest).await?;
    } else {
        tokio::fs::copy(src, &dest)
            .await
            .map_err(|e| format!("Failed to duplicate: {e}"))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

async fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    tokio::fs::create_dir(dest)
        .await
        .map_err(|e| format!("Failed to create directory: {e}"))?;
    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| format!("Failed to read directory: {e}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read entry: {e}"))?
    {
        let entry_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if entry_path.is_dir() {
            Box::pin(copy_dir_recursive(&entry_path, &dest_path)).await?;
        } else {
            tokio::fs::copy(&entry_path, &dest_path)
                .await
                .map_err(|e| format!("Failed to copy file: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", &path))
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {e}"))?;
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
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
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
            .map_err(|e| format!("Failed to open Terminal: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d {dir}")])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {e}"))?;
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
            return Err("No terminal emulator found".to_string());
        }
    }
    Ok(())
}
