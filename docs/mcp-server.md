# MCP Server Setup Guide

MarkUpsideDown exposes its editing and conversion capabilities as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, allowing AI agents to use the editor as a tool.

## Architecture

```
AI Agent (Claude Desktop, Claude Code, Cowork)
    ↕ stdio (JSON-RPC)
MCP Server (Rust sidecar binary, bundled in .app)
    ↕ HTTP (localhost:31415)
MarkUpsideDown App (Tauri)
    ↕ Tauri events
Editor (CodeMirror)
```

- The MCP server is a standalone Rust binary bundled as a Tauri sidecar — **no Node.js required**
- **Editor tools** communicate with the running app via the local HTTP bridge
- **Conversion tools** call the Cloudflare Worker directly (app not required if Worker URL is set)

## Available Tools (40)

### Editor Tools (require the app to be running)

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_editor_content` | Get current Markdown from the editor | — |
| `set_editor_content` | Replace editor content | `markdown: string` |
| `insert_text` | Insert text at cursor, start, or end | `text: string`, `position?: "cursor" \| "start" \| "end"` |
| `get_editor_state` | Get editor state (file path, cursor, Worker URL) | — |
| `get_document_structure` | Get document structure (headings, links, stats) as JSON | — |
| `normalize_document` | Normalize headings, tables, list markers, whitespace | — |
| `open_file` | Open a Markdown file in the editor | `path: string` |
| `save_file` | Save content to a file | `path?: string` (uses current file if omitted) |

### Project Context Tools (require the app to be running)

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_directory` | List files and directories (respects .gitignore) | `path?: string`, `recursive?: boolean` |
| `read_file` | Read a text file from the project | `path: string` |
| `get_open_tabs` | List all open editor tabs with dirty status | — |
| `get_project_root` | Get the current project root directory path | — |
| `get_dirty_files` | List files with unsaved changes | — |
| `switch_tab` | Switch the active editor tab | `path?: string`, `tab_id?: string` |
| `git_status` | Get git status (branch, files, ahead/behind) | — |
| `search_files` | Search file names by substring match | `query: string`, `path?: string` |

### File Mutation Tools (require the app to be running)

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_file` | Create a new empty file | `path: string` |
| `create_directory` | Create a new directory | `path: string` |
| `rename_entry` | Rename or move a file or directory | `from: string`, `to: string` |
| `delete_entry` | Delete a file or directory (moved to trash) | `path: string`, `is_dir?: boolean` |
| `copy_entry` | Copy a file or directory to another directory | `from: string`, `to_dir: string` |
| `duplicate_entry` | Duplicate with auto-naming (e.g., "file copy.md") | `path: string` |

### Content & Asset Tools (require the app to be running)

| Tool | Description | Parameters |
|------|-------------|------------|
| `download_image` | Download an image from URL to a local file | `url: string`, `dest_path: string` |
| `fetch_page_title` | Extract `<title>` from a web page | `url: string` |

### Conversion Tools (require Worker URL)

| Tool | Description | Parameters |
|------|-------------|------------|
| `fetch_markdown` | Fetch a URL as Markdown via Markdown for Agents | `url: string` |
| `render_markdown` | Fetch a JS-rendered page as Markdown via Browser Rendering | `url: string` |
| `convert_to_markdown` | Convert a local file to Markdown via Workers AI | `file_path: string` |

**Supported formats for `convert_to_markdown`:** PDF, DOCX, XLSX, PPTX, HTML, HTM, CSV, XML, JPG, JPEG, PNG, GIF, WebP, BMP, TIFF, TIF

### Crawl Tools (require Worker URL)

| Tool | Description | Parameters |
|------|-------------|------------|
| `crawl_website` | Start a website crawl job (returns `job_id`) | `url: string`, `depth?: number`, `limit?: number`, `render?: boolean`, `include_patterns?: string[]`, `exclude_patterns?: string[]` |
| `crawl_status` | Poll crawl job status and retrieve Markdown pages | `job_id: string`, `cursor?: string` |
| `crawl_save` | Save crawled pages as local Markdown files | `pages: {url, markdown}[]`, `base_dir: string` |

### Git Operations (require the app to be running)

| Tool | Description | Parameters |
|------|-------------|------------|
| `git_stage` | Stage a file for commit | `path: string` |
| `git_unstage` | Unstage a file | `path: string` |
| `git_commit` | Commit staged changes | `message: string` |
| `git_push` | Push commits to remote | — |
| `git_pull` | Pull changes from remote | — |
| `git_fetch` | Fetch updates from remote without merging | — |

### GitHub Integration (require gh CLI)

| Tool | Description | Parameters |
|------|-------------|------------|
| `github_fetch_issue` | Fetch a GitHub issue body as Markdown | `owner: string`, `repo: string`, `number: number` |
| `github_fetch_pr` | Fetch a GitHub PR body as Markdown | `owner: string`, `repo: string`, `number: number` |
| `github_list_repos` | List accessible GitHub repositories | — |

### Diagnostics

| Tool | Description | Parameters |
|------|-------------|------------|
| `check_worker` | Test Worker URL connectivity and report capabilities | — |

## Setup

### 1. Copy the Config from Settings

Open **Settings** in the app and scroll to **AI Agent Integration**. The MCP binary path is automatically detected. Click **Copy to clipboard** to get the JSON config.

### 2. Configure Your AI Agent

#### Claude Desktop

Paste the copied config into `~/Library/Application Support/Claude/claude_desktop_config.json`.

Example:

```json
{
  "mcpServers": {
    "markupsidedown": {
      "command": "/Applications/MarkUpsideDown.app/Contents/Resources/binaries/markupsidedown-mcp-aarch64-apple-darwin",
      "env": {
        "MARKUPSIDEDOWN_WORKER_URL": "https://markupsidedown-converter.YOUR_SUBDOMAIN.workers.dev"
      }
    }
  }
}
```

#### Claude Code

Paste the copied config into your project's `.mcp.json` or global `~/.claude/settings.json`.

#### Cowork

Use the **Create workspace** button in the Cowork tab of the Settings panel. This creates a folder with `.mcp.json` and `CLAUDE.md` — open it in Cowork as your workspace.

### 3. Start the App

Launch MarkUpsideDown. The app automatically starts the HTTP bridge and writes the port to `~/.markupsidedown-bridge-port`.

### 4. Use with the Agent

- **Editor tools** (`get_editor_content`, `set_editor_content`, etc.) require the app to be running
- **Project context tools** (`list_directory`, `read_file`, `git_status`, etc.) require the app to be running
- **File mutation tools** (`create_file`, `rename_entry`, `copy_entry`, etc.) require the app to be running
- **Git tools** (`git_stage`, `git_commit`, `git_push`, etc.) require the app to be running
- **GitHub tools** (`github_fetch_issue`, `github_fetch_pr`, etc.) require the app and `gh` CLI
- **Content tools** (`download_image`, `fetch_page_title`) require the app to be running
- **Conversion tools** (`fetch_markdown`, `render_markdown`, `convert_to_markdown`) work independently if `MARKUPSIDEDOWN_WORKER_URL` is set

## Configuration

### Worker URL Resolution

The MCP server resolves the Worker URL in this order:

1. `MARKUPSIDEDOWN_WORKER_URL` environment variable (set in MCP config)
2. Worker URL configured in the app's Settings (read via bridge `/editor/state`)

### Bridge Port

The Tauri app listens on `localhost:31415` by default (fallback: 31416–31420). The port file `~/.markupsidedown-bridge-port` is created on startup and removed on exit.

## Troubleshooting

### "MarkUpsideDown app is not running"

Editor tools require the app to be open. Start MarkUpsideDown and try again.

If the app is running but the error persists, check `~/.markupsidedown-bridge-port` exists and contains a valid port number.

### "Worker URL not configured"

Conversion tools need a Worker URL. Either:

- Set `MARKUPSIDEDOWN_WORKER_URL` in your MCP config's `env` block
- Or configure the Worker URL in the app's Settings panel

### Bridge port conflict

If port 31415 is occupied, the app tries 31416–31420. The MCP server reads the actual port from `~/.markupsidedown-bridge-port`, so no manual configuration is needed.

### Conversion tool errors

- **"Unsupported file type"** — Check that the file extension is in the supported list above
- **Network errors** — Verify the Worker URL is correct and the Worker is deployed
- **"AI Neurons" cost** — Image conversion (OCR) uses AI Neurons; document formats are free
