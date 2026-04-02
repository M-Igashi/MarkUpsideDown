# MCP Server Reference

Technical reference for MarkUpsideDown's MCP server. For getting started, see the [AI Integration Guide](ai-integration.md).

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

## Standalone Mode (No App Required)

The MCP server can run **without the desktop app** for conversion and crawl workflows. This is useful for headless/CI usage or agents that only need document conversion.

### Requirements

- The MCP binary (bundled in the `.app` or built from `mcp-server-rs/`)
- `MARKUPSIDEDOWN_WORKER_URL` environment variable pointing to your deployed Worker

### What works without the app

| Tool | Works standalone? |
|------|-------------------|
| `fetch_markdown` | Yes (calls URL directly, no Worker needed) |
| `render_markdown`, `convert_to_markdown` | Yes (calls Worker directly via env var) |
| `extract_json` | Yes (calls Worker directly via env var) |
| `crawl_website`, `crawl_status` | Yes (calls Worker directly via env var) |
| `crawl_save` | No (saves files via the app bridge) |
| Editor, file, git, content tools | No (require the running app) |

### Example config (standalone)

```json
{
  "mcpServers": {
    "markupsidedown": {
      "command": "/Applications/MarkUpsideDown.app/Contents/MacOS/markupsidedown-mcp",
      "env": {
        "MARKUPSIDEDOWN_WORKER_URL": "https://markupsidedown-XXXXXX.YOUR_SUBDOMAIN.workers.dev"
      }
    }
  }
}
```

> **Tip:** You can verify the binary version with `markupsidedown-mcp --version`.

When `MARKUPSIDEDOWN_WORKER_URL` is set, the MCP server uses it directly without contacting the app bridge. Editor/file/git tools will return an error if the app is not running, but conversion and crawl tools work normally.

## Configuration

### Worker URL Resolution

The MCP server resolves the Worker URL in this order:

1. `MARKUPSIDEDOWN_WORKER_URL` environment variable (set in MCP config)
2. Worker URL configured in the app's Settings (read via bridge `/editor/state`)

### Worker Version Compatibility

The MCP server's conversion and crawl tools require a compatible Worker. If tools like `extract_json` or `crawl_website` return endpoint errors, your Worker may need redeployment:

```bash
cd worker && wrangler deploy
```

Check Worker health and version: `curl https://your-worker-url/health`

### Bridge Port

The Tauri app listens on `localhost:31415` by default (fallback: 31416–31420). The port file `~/.markupsidedown-bridge-port` is created on startup and removed on exit.

## Available Tools (61)

<details>
<summary><strong>Editor Tools</strong> — 9 tools (require the app to be running)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_editor_content` | Get current Markdown from the editor | — |
| `set_editor_content` | Replace editor content | `markdown: string` |
| `insert_text` | Insert text at cursor, start, or end | `text: string`, `position?: "cursor" \| "start" \| "end"` |
| `get_editor_state` | Get editor state (file path, cursor position/line/column, Worker URL) | — |
| `get_document_structure` | Get document structure (headings, links, stats) as JSON | — |
| `normalize_document` | Normalize headings, tables, list markers, whitespace, CJK emphasis spacing | — |
| `lint_document` | Run structural lint checks (headings, links, tables, emphasis, code blocks, footnotes, blank lines) | — |
| `open_file` | Open a Markdown file in the editor | `path: string` |
| `save_file` | Save content to a file | `path?: string` (uses current file if omitted) |

</details>

<details>
<summary><strong>Project Context Tools</strong> — 8 tools (require the app to be running)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_directory` | List files and directories (respects .gitignore) | `path?: string`, `recursive?: boolean`, `max_entries?: number` (default: 1000) |
| `read_file` | Read a text file from the project | `path: string` |
| `get_open_tabs` | List all open editor tabs with dirty status | — |
| `get_project_root` | Get the current project root directory path | — |
| `get_dirty_files` | List files with unsaved changes | — |
| `switch_tab` | Switch the active editor tab | `path?: string`, `tab_id?: string` |
| `git_status` | Get git status (branch, files, ahead/behind) | — |
| `search_files` | Search file names (not content) by substring match | `query: string`, `path?: string` |

</details>

<details>
<summary><strong>File Mutation Tools</strong> — 6 tools (require the app to be running)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_file` | Create a new empty file | `path: string` |
| `create_directory` | Create a new directory | `path: string` |
| `rename_entry` | Rename or move a file or directory | `from: string`, `to: string` |
| `delete_entry` | Delete a file or directory (moved to trash) | `path: string`, `is_dir?: boolean` |
| `copy_entry` | Copy a file or directory to another directory | `from: string`, `to_dir: string` |
| `duplicate_entry` | Duplicate with auto-naming (e.g., "file copy.md") | `path: string` |

</details>

<details>
<summary><strong>Content & Asset Tools</strong> — 3 tools</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `extract_json` | Extract structured JSON data from a web page using AI (Workers AI LLM) | `url: string`, `prompt?: string`, `response_format?: string` (JSON Schema) |
| `download_image` | Download an image from URL to a local file | `url: string`, `dest_path: string` |
| `fetch_page_title` | Extract `<title>` from a web page | `url: string` |

`extract_json` requires at least one of `prompt` or `response_format`. Uses LLM inference per call. Requires Worker URL with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

</details>

<details>
<summary><strong>Conversion Tools</strong> — 4 tools (require Worker URL)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_markdown` | Fetch a URL as Markdown with automatic SPA detection and fallback | `url: string` |
| `fetch_markdown` | Fetch a URL as Markdown via Markdown for Agents (static only) | `url: string` |
| `render_markdown` | Fetch a JS-rendered page as Markdown via Browser Rendering | `url: string` |
| `convert_to_markdown` | Convert a local file to Markdown via Workers AI | `file_path: string` |

**Supported formats:** PDF, DOCX, XLSX, HTML, HTM, CSV, XML, JPG, JPEG, PNG, WebP, SVG

</details>

<details>
<summary><strong>Crawl Tools</strong> — 3 tools (require Worker URL)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `crawl_website` | Start a website crawl job (returns `job_id`). Supports markdown and/or JSON output. | `url: string`, `depth?: number`, `limit?: number`, `render?: boolean`, `include_patterns?: string[]`, `exclude_patterns?: string[]`, `formats?: string[]`, `response_format?: string` (JSON Schema) |
| `crawl_status` | Poll crawl job status and retrieve pages (markdown and/or JSON) | `job_id: string`, `cursor?: string`, `limit?: number` (default 10, max 100) |
| `crawl_save` | Save crawled pages as local Markdown files | `pages: {url, markdown}[]`, `base_dir: string` |

</details>

<details>
<summary><strong>Git Operations</strong> — 15 tools (require the app to be running)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `git_stage` | Stage a file for commit | `path: string` |
| `git_stage_all` | Stage all changes (git add -A) | — |
| `git_unstage` | Unstage a file | `path: string` |
| `git_commit` | Commit staged changes | `message: string` |
| `git_push` | Push commits to remote | — |
| `git_pull` | Pull changes from remote | — |
| `git_fetch` | Fetch updates from remote without merging | — |
| `git_diff` | Get the diff for a specific file | `path: string`, `staged?: boolean` |
| `git_discard` | Discard changes for a specific file | `path: string` |
| `git_discard_all` | Discard all uncommitted changes | — |
| `git_log` | Get recent commit history | `limit?: number` |
| `git_show` | Show the patch for a specific commit | `commit_hash: string` |
| `git_revert` | Revert a commit by creating a new revert commit | `commit_hash: string` |
| `git_clone` | Clone a git repository | `url: string`, `dest: string` |
| `git_init` | Initialize a new git repository | `path: string` |

</details>

<details>
<summary><strong>Tag Tools</strong> — 5 tools (require the app to be running)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_tags` | List all tag definitions and file-tag assignments | — |
| `get_file_tags` | Get tags assigned to a specific file or directory | `path: string` |
| `set_file_tags` | Set tags for a file or directory (replaces existing) | `path: string`, `tags: string[]` |
| `create_tag` | Create a new tag definition with a color | `name: string`, `color?: string` (hex, default: `#d94545`) |
| `delete_tag` | Delete a tag and remove it from all files | `name: string` |

Tags are stored in `.markupsidedown/tags.json` per project. Changes made via MCP are automatically synced to the frontend UI.

</details>

<details>
<summary><strong>Search & Indexing</strong> — 3 tools (require Worker URL + Vectorize)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `semantic_search` | Search indexed documents using natural language | `query: string`, `limit?: number` |
| `index_documents` | Index documents into Vectorize for semantic search | `documents: {id, content, metadata?}[]` |
| `remove_document` | Remove a document from the Vectorize index | `id: string` |

Requires Vectorize to be configured in the Worker. Documents are auto-indexed when crawled or imported/converted via the app. Use `index_documents` for manual indexing and `remove_document` to clean up stale entries.

</details>

<details>
<summary><strong>Publishing</strong> — 3 tools (require Worker URL + R2)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `publish_document` | Publish Markdown to a public URL via R2 | `key: string`, `content: string`, `filename?: string`, `expires_in?: number` (seconds, 0 = permanent) |
| `unpublish_document` | Remove a published document from R2 | `key: string` |
| `list_published` | List all published documents in R2 | — |

Published documents are accessible at `{worker_url}/p/{key}` as `text/markdown`.

</details>

<details>
<summary><strong>Batch Conversion</strong> — 2 tools (require Worker URL + Queue + KV)</summary>

| Tool | Description | Parameters |
|------|-------------|------------|
| `submit_batch` | Submit files for parallel batch conversion | `files: {name, content}[]` (content is base64-encoded) |
| `get_batch_status` | Poll batch conversion job status | `batch_id: string` |

Batch conversion uses Queue-based parallel processing. Submit files with `submit_batch`, then poll with `get_batch_status` until all files are `done` or `failed`.

</details>

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

### MCP tools not working after app update

MCP server processes are started when a Claude Code session begins and run for the duration of that session. **Updating the app does not replace running MCP server processes.** After updating MarkUpsideDown:

1. Restart Zed (or your IDE) to start a new Claude Code session
2. Or start a new Claude Code session in the terminal

You can verify the running binary version with:

```bash
/Applications/MarkUpsideDown.app/Contents/MacOS/markupsidedown-mcp --version
```

### `extract_json` timeout

`extract_json` with `response_format` on JS-heavy pages can take over 60 seconds due to Browser Rendering + LLM inference. The MCP server uses a 120-second timeout. If you encounter timeouts:

- Try without `response_format` (prompt-only mode is faster)
- Use `get_markdown` as a fallback and let the AI agent parse the Markdown

### Conversion tool errors

- **"Unsupported file type"** — Check that the file extension is in the supported list above
- **Network errors** — Verify the Worker URL is correct and the Worker is deployed
- **"AI Neurons" cost** — Image conversion (OCR) uses AI Neurons; document formats are free
