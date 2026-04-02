use serde::{Deserialize, Serialize};

use super::{EditorStates, TabInfo};
use crate::error::{AppError, Result};

// --- Editor State Sync ---

#[tauri::command]
pub fn sync_editor_state(
    window: tauri::Window,
    content: String,
    file_path: Option<String>,
    cursor_pos: Option<usize>,
    cursor_line: Option<usize>,
    cursor_column: Option<usize>,
    worker_url: Option<String>,
    document_structure: Option<String>,
    lint_diagnostics: Option<String>,
    root_path: Option<String>,
    tabs: Option<Vec<TabInfo>>,
    state: tauri::State<'_, std::sync::Arc<EditorStates>>,
) -> Result<()> {
    let label = window.label().to_string();
    let mut map = state.map.lock().unwrap_or_else(|e| e.into_inner());
    let s = map.entry(label).or_default();
    s.content = content;
    s.file_path = file_path;
    if let Some(pos) = cursor_pos {
        s.cursor_pos = pos;
    }
    if let Some(line) = cursor_line {
        s.cursor_line = line;
    }
    if let Some(col) = cursor_column {
        s.cursor_column = col;
    }
    s.worker_url = worker_url;
    if let Some(ds) = document_structure {
        s.document_structure = Some(ds);
    }
    if let Some(ld) = lint_diagnostics {
        s.lint_diagnostics = Some(ld);
    }
    if let Some(rp) = root_path {
        s.root_path = Some(rp);
    }
    if let Some(t) = tabs {
        s.tabs = t;
    }
    Ok(())
}

// --- MCP Sidecar ---

#[tauri::command]
pub fn get_mcp_binary_path(app: tauri::AppHandle) -> Result<String> {
    use tauri::Manager;
    let triple = tauri::utils::platform::target_triple()
        .map_err(|e| AppError::Io(format!("Failed to get target triple: {e}")))?;
    let bin_name_with_triple = format!("markupsidedown-mcp-{triple}");

    // Production (.app bundle): Contents/MacOS/markupsidedown-mcp (no triple suffix)
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri places sidecar binaries in Contents/MacOS/ (sibling of Contents/Resources/)
        if let Some(contents_dir) = resource_dir.parent() {
            let macos_path = contents_dir.join("MacOS").join("markupsidedown-mcp");
            if macos_path.exists() {
                return Ok(macos_path.to_string_lossy().to_string());
            }
        }
    }

    // Dev mode: src-tauri/binaries/ (with triple suffix)
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&bin_name_with_triple);
    if dev_path.exists() {
        return Ok(dev_path.to_string_lossy().to_string());
    }

    Err(AppError::Io(
        "MCP binary 'markupsidedown-mcp' not found".into(),
    ))
}

// --- Claude Desktop MCP Config ---

#[tauri::command]
pub fn install_mcp_to_claude_desktop(
    mcp_binary_path: String,
    worker_url: String,
) -> Result<String> {
    use std::fs;

    let config_path = crate::util::home_dir()
        .ok_or(AppError::Io("Cannot resolve home directory".into()))?
        .join("Library/Application Support/Claude/claude_desktop_config.json");

    // Read existing config or create new one
    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| AppError::Io(format!("Failed to read config: {e}")))?;
        serde_json::from_str(&content)
            .map_err(|e| AppError::Io(format!("Failed to parse config: {e}")))?
    } else {
        serde_json::json!({})
    };

    // Build MCP server entry
    let mut entry = serde_json::json!({ "command": mcp_binary_path });
    if !worker_url.is_empty() {
        entry["env"] = serde_json::json!({ "MARKUPSIDEDOWN_WORKER_URL": worker_url });
    }

    // Add/update markupsidedown entry
    let servers = config
        .as_object_mut()
        .ok_or(AppError::Validation("Config is not a JSON object".into()))?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    servers["markupsidedown"] = entry;

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .map_err(|e| AppError::Io(format!("Failed to write config: {e}")))?;

    Ok(config_path.to_string_lossy().to_string())
}

// --- Cowork Workspace ---

#[tauri::command]
pub fn create_cowork_workspace(
    folder_path: String,
) -> Result<String> {
    use std::fs;
    use std::path::PathBuf;

    // Expand ~ to home directory
    let expanded = if folder_path.starts_with("~/") {
        crate::util::home_dir()
            .ok_or(AppError::Io("Cannot resolve home directory".into()))?
            .join(&folder_path[2..])
    } else {
        PathBuf::from(&folder_path)
    };

    fs::create_dir_all(&expanded)
        .map_err(|e| AppError::Io(format!("Failed to create directory: {e}")))?;

    // Generate CLAUDE.md
    let claude_md = r#"# MarkUpsideDown Workspace

This workspace is configured for use with MarkUpsideDown's MCP server.
MarkUpsideDown must be running for editor/file/git tools to work.

## Available MCP Tools (62)

### Windows
| Tool | Description |
|------|-------------|
| `list_windows` | List all open windows with labels and project roots |

### Editor
| Tool | Description |
|------|-------------|
| `get_editor_content` | Get current Markdown from the editor |
| `set_editor_content` | Replace editor content |
| `insert_text` | Insert text at cursor, start, or end |
| `get_editor_state` | Get editor state (file path, cursor, Worker URL) |
| `switch_tab` | Switch the active editor tab |

### Document
| Tool | Description |
|------|-------------|
| `get_document_structure` | Get document structure (headings, links, stats) as JSON |
| `normalize_document` | Normalize headings, tables, list markers, whitespace, CJK emphasis spacing |
| `lint_document` | Run structural lint checks (headings, links, emphasis, code blocks, etc.) |

### File Operations
| Tool | Description |
|------|-------------|
| `open_file` | Open a Markdown file |
| `save_file` | Save content to a file |
| `read_file` | Read a text file from the project |
| `list_directory` | List files and directories (respects .gitignore) |
| `search_files` | Search file names in the project |
| `create_file` | Create a new empty file |
| `create_directory` | Create a new directory |
| `rename_entry` | Rename or move a file or directory |
| `delete_entry` | Delete a file or directory (moved to trash) |
| `copy_entry` | Copy a file or directory |
| `duplicate_entry` | Duplicate a file or directory |
| `get_open_tabs` | List all open editor tabs |
| `get_project_root` | Get the current project root path |
| `get_dirty_files` | List files with unsaved changes |

### Web Fetching & Conversion
| Tool | Description |
|------|-------------|
| `get_markdown` | Fetch URL as Markdown (auto-detects JS-rendered pages) |
| `fetch_markdown` | Fetch URL as Markdown (static only) |
| `render_markdown` | JS-render a page as Markdown via Browser Rendering |
| `convert_to_markdown` | Convert local file (PDF, DOCX, images, etc.) to Markdown |
| `extract_json` | Extract structured JSON from a web page using AI |
| `download_image` | Download an image from a URL to local path |
| `fetch_page_title` | Extract page title for Markdown links |

### Website Crawling
| Tool | Description |
|------|-------------|
| `crawl_website` | Start a website crawl job (markdown and/or json output) |
| `crawl_status` | Poll crawl job status and retrieve pages |
| `crawl_save` | Save crawled pages as local Markdown files |

### Git
| Tool | Description |
|------|-------------|
| `git_status` | Get git status (branch, changes, ahead/behind) |
| `git_stage` | Stage a file for commit |
| `git_stage_all` | Stage all changes (git add -A) |
| `git_unstage` | Unstage a file |
| `git_commit` | Commit staged changes |
| `git_push` | Push commits to remote |
| `git_pull` | Pull changes from remote |
| `git_fetch` | Fetch updates from remote |
| `git_diff` | Get the diff for a specific file |
| `git_discard` | Discard changes for a specific file |
| `git_discard_all` | Discard all uncommitted changes |
| `git_log` | Get recent commit history |
| `git_show` | Show the patch for a specific commit |
| `git_revert` | Revert a commit |
| `git_clone` | Clone a git repository |
| `git_init` | Initialize a new git repository |

### Tags
| Tool | Description |
|------|-------------|
| `list_tags` | List all tag definitions and file-tag assignments |
| `get_file_tags` | Get tags assigned to a specific file |
| `set_file_tags` | Set tags for a file (replaces existing) |
| `create_tag` | Create a new tag definition with a color |
| `delete_tag` | Delete a tag and remove from all files |

### Search & Indexing
| Tool | Description |
|------|-------------|
| `semantic_search` | Search indexed documents using natural language |
| `index_documents` | Index documents into Vectorize for semantic search |
| `remove_document` | Remove a document from the Vectorize index |

### Publishing
| Tool | Description |
|------|-------------|
| `publish_document` | Publish Markdown to a public URL via R2 |
| `unpublish_document` | Remove a published document from R2 |
| `list_published` | List all published documents in R2 |

### Batch Conversion
| Tool | Description |
|------|-------------|
| `submit_batch` | Submit files for parallel batch conversion |
| `get_batch_status` | Poll batch conversion job status |

## Tips

- Use `get_markdown` (recommended) instead of `fetch_markdown`/`render_markdown` for most URL fetching
- Use `convert_to_markdown` to import PDFs, DOCX, XLSX, HTML, CSV, XML, images
- Use `crawl_website` + `crawl_status` for multi-page site crawls with markdown and/or json output
- Use `extract_json` to extract structured data from web pages via AI
- Use `get_document_structure` instead of parsing raw Markdown for structural analysis
- Use `lint_document` to check for structural issues before committing
- Use `normalize_document` after editing to clean up formatting (includes CJK emphasis spacing)
- Use `publish_document` to share Markdown at a public URL (permanent or time-limited)
- Use `index_documents` + `semantic_search` for AI-powered document retrieval
- Use `submit_batch` + `get_batch_status` for bulk file conversion
"#;
    let claude_md_path = expanded.join("CLAUDE.md");
    if !claude_md_path.exists() {
        fs::write(&claude_md_path, claude_md)
            .map_err(|e| AppError::Io(format!("Failed to write CLAUDE.md: {e}")))?;
    }

    Ok(expanded.to_string_lossy().to_string())
}

// --- comrak-based CommonMark validation (#140) ---

#[derive(Clone, Serialize, Deserialize)]
pub struct ComrakDiagnostic {
    pub line: usize,
    pub severity: String,
    pub message: String,
}

#[tauri::command]
pub fn validate_markdown(content: String) -> Result<Vec<ComrakDiagnostic>> {
    use comrak::{parse_document, Arena, Options};

    let arena = Arena::new();
    let options = Options::default();
    let root = parse_document(&arena, &content, &options);

    let mut diagnostics = Vec::new();

    check_html_blocks(root, &mut diagnostics);
    check_link_nesting(root, &mut diagnostics);
    check_list_continuation(root, &mut diagnostics);
    check_blockquote_boundary(root, &content, &mut diagnostics);

    diagnostics.sort_by_key(|d| d.line);
    Ok(diagnostics)
}

/// Detect HTML blocks that may unintentionally swallow Markdown content.
fn check_html_blocks<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    for node in root.descendants() {
        let ast = node.data.borrow();
        if let NodeValue::HtmlBlock(ref hb) = ast.value {
            // Skip well-known intentional HTML tags
            let trimmed = hb.literal.trim_start().to_lowercase();
            if trimmed.starts_with("<details")
                || trimmed.starts_with("<summary")
                || trimmed.starts_with("<div")
                || trimmed.starts_with("</div")
                || trimmed.starts_with("</details")
                || trimmed.starts_with("<!--")
            {
                continue;
            }

            let start = ast.sourcepos.start.line;
            let end = ast.sourcepos.end.line;
            let span = if start == end {
                format!("line {start}")
            } else {
                format!("lines {start}-{end}")
            };

            diagnostics.push(ComrakDiagnostic {
                line: start,
                severity: "info".into(),
                message: format!(
                    "HTML block detected ({span}) — content inside is not parsed as Markdown"
                ),
            });
        }
    }
}

/// Detect nested links (CommonMark forbids links inside links).
fn check_link_nesting<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    for node in root.descendants() {
        let is_link = matches!(node.data.borrow().value, NodeValue::Link(_));
        if !is_link {
            continue;
        }

        // Check if any descendant is also a Link
        for child in node.descendants().skip(1) {
            if matches!(child.data.borrow().value, NodeValue::Link(_)) {
                let line = child.data.borrow().sourcepos.start.line;
                diagnostics.push(ComrakDiagnostic {
                    line,
                    severity: "info".into(),
                    message: "Nested link detected — CommonMark does not allow links inside links"
                        .into(),
                });
            }
        }
    }
}

/// Detect paragraphs that likely fell out of a list due to incorrect indentation.
fn check_list_continuation<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    for node in root.descendants() {
        let is_list = matches!(node.data.borrow().value, NodeValue::List(_));
        if !is_list {
            continue;
        }

        let list_end = node.data.borrow().sourcepos.end.line;

        // Check next sibling: if it's a paragraph starting right after the list, flag it
        if let Some(next) = node.next_sibling() {
            let next_ast = next.data.borrow();
            if matches!(next_ast.value, NodeValue::Paragraph) {
                let para_start = next_ast.sourcepos.start.line;
                // Paragraph immediately follows list (no blank line or just one blank line)
                if para_start <= list_end + 2 {
                    diagnostics.push(ComrakDiagnostic {
                        line: para_start,
                        severity: "info".into(),
                        message: "Paragraph immediately after list — may be an unintended list continuation (check indentation)".into(),
                    });
                }
            }
        }
    }
}

/// Detect blockquotes immediately followed by a paragraph with no blank line separation.
fn check_blockquote_boundary<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    content: &str,
    diagnostics: &mut Vec<ComrakDiagnostic>,
) {
    use comrak::nodes::NodeValue;

    let lines: Vec<&str> = content.lines().collect();

    for node in root.descendants() {
        let is_bq = matches!(node.data.borrow().value, NodeValue::BlockQuote);
        if !is_bq {
            continue;
        }

        let bq_end = node.data.borrow().sourcepos.end.line;

        if let Some(next) = node.next_sibling() {
            let next_ast = next.data.borrow();
            if matches!(next_ast.value, NodeValue::Paragraph) {
                let para_start = next_ast.sourcepos.start.line;
                // Check if the line between blockquote end and paragraph start is blank
                let has_blank = (bq_end..para_start.saturating_sub(1)).any(|l| {
                    lines
                        .get(l) // 0-indexed: line l+1 in 1-indexed
                        .is_some_and(|s| s.trim().is_empty())
                });
                if !has_blank && para_start == bq_end + 1 {
                    diagnostics.push(ComrakDiagnostic {
                        line: para_start,
                        severity: "info".into(),
                        message: "Paragraph immediately after blockquote — different parsers may interpret this differently".into(),
                    });
                }
            }
        }
    }
}
