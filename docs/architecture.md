# Architecture

## Overview

```
AI Agent (Claude Desktop, Claude Code, Cowork)
    ↕ stdio (JSON-RPC)
MCP Server (mcp-server-rs/)
    ↕ HTTP (localhost:31415)
┌──────────────────────────────────────────────────────────┐
│                    MarkUpsideDown                         │
│                                                          │
│  ┌────────────────┐    ┌──────────────────────────────┐  │
│  │   Editor        │    │   Preview                     │  │
│  │  (CodeMirror 6) │◄──►│  (marked + KaTeX + Mermaid   │  │
│  │  + Table Editor │    │   + highlight.js + SVG)       │  │
│  └───────┬────────┘    └──────────────────────────────┘  │
│          │ invoke()          ▲ scroll sync                │
│  ┌───────┴───────────────────┴──────────────────────┐    │
│  │  Tauri Backend (Rust)                             │    │
│  │  ├─ commands/     (IPC: files, web, git, crawl, editor)│  │
│  │  ├─ bridge.rs     (axum HTTP server for MCP)      │    │
│  │  └─ cloudflare.rs (wrangler CLI, auto-setup)      │    │
│  └───────┬──────────────────────────────────────────┘    │
└──────────┼───────────────────────────────────────────────┘
           │ HTTP
           ▼
┌──────────────────────────────────────┐
│  Cloudflare Worker                    │
│  GET  /health   → capability check    │
│  POST /fetch    → AI.toMarkdown()    │
│  POST /convert  → AI.toMarkdown()    │
│  GET  /render   → Browser Rendering   │
│       (/content → AI.toMarkdown())   │
│  POST /crawl    → start site crawl    │
│  GET  /crawl/:id → poll crawl results │
│  POST /batch    → Queue-based batch   │
│  GET  /batch/:id → poll batch results │
│  PUT  /publish  → publish to R2       │
│  GET  /p/:key   → serve published MD  │
│  POST /embed    → index in Vectorize  │
│  POST /search   → semantic search     │
└──────────────────────────────────────┘
```

## Components

### Desktop App (`src-tauri/` + `ui/`)

| Layer | Tech | Location |
|-------|------|----------|
| Desktop shell | Tauri v2 (WebKit on macOS) | `src-tauri/` |
| Editor | CodeMirror 6 (Markdown) | `ui/src/main.ts` |
| Preview | marked.js + KaTeX + Mermaid + highlight.js + idiomorph DOM-diffing | `ui/src/preview-render.ts` |
| Scroll sync | Viewport-based bidirectional sync with cooldown | `ui/src/scroll-sync.ts` |
| Settings | Worker setup (auto + manual), feature status, MCP config | `ui/src/settings.ts` |
| Sidebar | File tree browser with context menu, search, drag & drop, file tagging | `ui/src/sidebar.ts` |
| Tags | File tagging system (CRUD, badges, filter, sort by tag) | `ui/src/tags.ts` |
| Tabs | Multi-tab editing with state persistence, drag reorder | `ui/src/tabs.ts` |
| Git panel | Status, stage/unstage, commit, push/pull with ahead/behind, fetch | `ui/src/git-panel.ts` |
| Clone panel | Repository clone UI (HTTPS/SSH) | `ui/src/clone-panel.ts` |
| Table editor | Spreadsheet grid with undo/redo, paste TSV/CSV | `ui/src/table-editor.ts` |
| Formatting | Markdown shortcuts (bold `__`, italic, link, strikethrough, code, smart code fences) | `ui/src/markdown-commands.ts` |
| Auto link title | Paste URL → auto-fetch title → `[Title](url)` | `ui/src/auto-link-title.ts` |
| Link context menu | Right-click links in preview for Fetch/Render/Crawl | `ui/src/link-context-menu.ts` |
| Smart typography | Auto-convert `...`, `--`, `---` to typographic chars | `ui/src/smart-typography.ts` |
| Crawl | Website crawl UI (options dialog, polling, file saving) | `ui/src/crawl.ts` |
| File operations | Create, rename, delete, import, auto-save | `ui/src/file-ops.ts` |
| File watcher | External file change detection and auto-reload | `ui/src/file-watcher.ts` |
| Clipboard | Rich text / Markdown copy | `ui/src/clipboard.ts` |
| MCP sync | Editor state sync for MCP bridge | `ui/src/mcp-sync.ts` |
| Download images | Download external images to `./assets/` | `ui/src/download-images.ts` |
| Note refactor | Extract selection into new linked file | `ui/src/note-refactor.ts` |
| Normalize | Post-conversion Markdown normalization (CJK emphasis spacing, table alignment, heading hierarchy) | `ui/src/normalize.ts` |
| CJK emphasis | Shared CJK emphasis spacing utility (normalize + preview) | `ui/src/cjk-emphasis.ts` |
| Document structure | Heading tree, links, tables, stats parser | `ui/src/document-structure.ts` |
| Markdown lint | Structural linting (11 checks: headings, links, tables, emphasis flanking, code blocks, footnotes, etc.) | `ui/src/markdown-lint.ts` |
| Image paste | Clipboard paste / drag-drop images to `./assets/` | `ui/src/image-paste.ts` |
| Command palette | Fuzzy search commands (Cmd+K), `?` prefix for semantic search | `ui/src/command-palette.ts` |
| Frontmatter panel | Collapsible YAML frontmatter display | `ui/src/frontmatter-panel.ts` |
| TOC panel | Heading navigation with active tracking (Cmd+4) | `ui/src/toc-panel.ts` |
| Presentation mode | Slide presentation (split at `---`) | `ui/src/presentation.ts` |
| Mermaid viewer | Zoom/pan viewer for Mermaid diagrams (Copy as PNG) | `ui/src/mermaid-viewer.ts` |
| Theme | CodeMirror editor theme (warm paper palette) | `ui/src/theme.ts` |
| Path utils | `basename()`, `dirname()`, `buildRelativePath()` | `ui/src/path-utils.ts` |
| HTML utils | `escapeHtml()`, `copySvgAsPng()`, `writeTextFile()` | `ui/src/html-utils.ts` |
| Fetch markdown | Shared URL→Markdown pipeline | `ui/src/fetch-markdown.ts` |
| Storage utils | `getStorageBool()`, `setStorageBool()` | `ui/src/storage-utils.ts` |
| Storage keys | Centralized localStorage key registry | `ui/src/storage-keys.ts` |
| Worker fetch | Shared Worker API fetch helper | `ui/src/worker-fetch.ts` |
| Batch import | Queue-based parallel batch conversion | `ui/src/batch-import.ts` |
| Publish | Publish Markdown to R2 (permanent or time-limited) | `ui/src/publish.ts` |
| Semantic search | Natural language search via Vectorize | `ui/src/semantic-search.ts` |
| Update toast | App update availability notification | `ui/src/update-toast.ts` |
| Backend commands | Rust (Tauri IPC) | `src-tauri/src/commands/` |
| Auto-setup | Wrangler CLI (login, deploy, secrets) | `src-tauri/src/cloudflare.rs` |
| MCP bridge | Rust (axum HTTP server) | `src-tauri/src/bridge.rs` |
| Utilities | Home directory helper | `src-tauri/src/util.rs` |

### Cloudflare Worker (`worker/`)

| Endpoint | Purpose | Cloudflare Service |
|----------|---------|-------------------|
| `GET /health` | Capability check (all feature availability) | — |
| `POST /fetch` | Fetch URL → Markdown | Workers AI `AI.toMarkdown()` |
| `POST /convert` | Document/image → Markdown | Workers AI `AI.toMarkdown()` |
| `GET /render?url=` | JS-rendered page → Markdown | Browser Rendering `/content` API + Workers AI `AI.toMarkdown()` |
| `POST /crawl` | Start website crawl (returns `job_id`) | Browser Rendering `/crawl` REST API |
| `GET /crawl/:job_id` | Poll crawl status and retrieve results | Browser Rendering `/crawl` REST API |
| `POST /batch` | Submit batch conversion job | Queue + KV |
| `GET /batch/:id` | Poll batch status | KV |
| `PUT /publish` | Publish Markdown to R2 | R2 |
| `GET /p/:key` | Serve published Markdown | R2 |
| `DELETE /publish/:key` | Unpublish | R2 |
| `POST /embed` | Index documents as vectors | Vectorize + Workers AI |
| `POST /search` | Semantic search query | Vectorize + Workers AI |
| `DELETE /embed/:id` | Remove document from index | Vectorize |

The `/render` endpoint pipeline:

1. **Content extraction** — `POST /content` via Browser Rendering API gets the JS-rendered HTML
2. **Markdown conversion** — `AI.toMarkdown()` converts HTML to Markdown
3. **Caching** — Responses cached for 1 hour via `caches.default`

Security: SSRF prevention validates URLs and blocks private/reserved IP ranges via DNS-over-HTTPS resolution. Bridge path validation: All file paths received via MCP bridge are validated through `validate_path()` which canonicalizes and ensures paths are under the user's home directory.

### MCP Server (`mcp-server-rs/`)

| Component | Role |
|-----------|------|
| `main.rs` | Entry point, stdio transport |
| `tools.rs` | 62 MCP tools (editor, project, files, content, conversion, crawl, git, tags, search, publish, batch, windows) |
| `bridge.rs` | HTTP client to Tauri bridge (auto-discovers port) |

Communication: MCP server (Rust sidecar binary) reads the bridge port from `~/.markupsidedown-bridge-port` and sends HTTP requests to the Tauri backend's axum server.

See [ai-integration.md](ai-integration.md) for setup and [mcp-server.md](mcp-server.md) for the full tool list.

## Tauri IPC Commands

### Core

| Command | Description | Module |
|---------|-------------|--------|
| `sync_editor_state` | Sync editor state to Rust (for MCP bridge) | `commands/editor.rs` |
| `get_mcp_binary_path` | Get path to bundled MCP sidecar binary | `commands/editor.rs` |
| `create_cowork_workspace` | Create a Cowork workspace folder with MCP config | `commands/editor.rs` |
| `validate_markdown` | Validate Markdown structure via comrak parser | `commands/editor.rs` |
| `check_for_update` | Check GitHub for new release | `commands/web.rs` |

### Worker / Conversion

| Command | Description | Module |
|---------|-------------|--------|
| `test_worker_url` | Test Worker health and report capabilities | `commands/web.rs` |
| `fetch_url_as_markdown` | Fetch URL with `Accept: text/markdown` header | `commands/web.rs` |
| `fetch_url_via_worker` | Fetch URL via Worker `/fetch` (AI.toMarkdown) | `commands/web.rs` |
| `fetch_rendered_url_as_markdown` | Fetch JS-rendered page via Worker `/render` | `commands/web.rs` |
| `convert_file_to_markdown` | Send file to Worker `/convert` | `commands/web.rs` |
| `detect_file_is_image` | Check if file is image (derived from MIME map) | `commands/web.rs` |
| `fetch_svg` | Fetch and sanitize remote SVG for inline rendering | `commands/web.rs` |
| `crawl_website` | Start website crawl via Worker `/crawl` | `commands/crawl.rs` |
| `crawl_status` | Poll crawl job status and retrieve completed pages | `commands/crawl.rs` |
| `crawl_save` | Save crawled pages as Markdown files to local directory | `commands/crawl.rs` |

### Content & Assets

| Command | Description | Module |
|---------|-------------|--------|
| `fetch_page_title` | Extract `<title>` from a web page (for auto-link-title) | `commands/web.rs` |
| `download_image` | Download image from URL to local file | `commands/web.rs` |

### File Operations

| Command | Description | Module |
|---------|-------------|--------|
| `read_text_file` | Read file content (UTF-8) | `commands/files.rs` |
| `write_text_file` | Write text to file (UTF-8) | `commands/files.rs` |
| `list_directory` | List files/folders (respects .gitignore, dirs first) | `commands/files.rs` |
| `create_file` | Create empty file | `commands/files.rs` |
| `create_directory` | Create directory | `commands/files.rs` |
| `rename_entry` | Rename file or folder | `commands/files.rs` |
| `delete_entry` | Delete file or folder (recursive for dirs) | `commands/files.rs` |
| `copy_entry` | Copy file or folder | `commands/files.rs` |
| `duplicate_entry` | Copy with unique name suffix ("file copy.md") | `commands/files.rs` |
| `write_file_bytes` | Write raw bytes to file (for drag & drop) | `commands/files.rs` |
| `save_image` | Save image bytes to file (creates ./assets/ directory) | `commands/files.rs` |
| `move_entries` | Move multiple files/directories to target directory | `commands/files.rs` |
| `reveal_in_finder` | Open in system file manager | `commands/files.rs` |
| `open_in_terminal` | Open terminal at directory | `commands/files.rs` |

### Git

| Command | Description | Module |
|---------|-------------|--------|
| `git_status` | Get branch + file changes with line diffs | `commands/git.rs` |
| `git_stage_all` | Stage all changes (`git add -A`) | `commands/git.rs` |
| `git_stage` | Stage specific file | `commands/git.rs` |
| `git_unstage` | Unstage specific file (`git reset HEAD`) | `commands/git.rs` |
| `git_commit` | Commit with message | `commands/git.rs` |
| `git_push` | Push to remote | `commands/git.rs` |
| `git_pull` | Pull from remote | `commands/git.rs` |
| `git_fetch` | Fetch remote updates | `commands/git.rs` |
| `git_diff` | Get diff for a specific file (staged or unstaged) | `commands/git.rs` |
| `git_discard` | Discard changes for a specific file | `commands/git.rs` |
| `git_discard_all` | Discard all uncommitted changes | `commands/git.rs` |
| `git_log` | Get recent commit history | `commands/git.rs` |
| `git_revert` | Revert a commit (creates new revert commit) | `commands/git.rs` |
| `git_show` | Show diff for a specific commit | `commands/git.rs` |
| `git_init` | Initialize a new git repo | `commands/git.rs` |

### Clone

| Command | Description | Module |
|---------|-------------|--------|
| `git_clone` | Clone a Git repository to a local directory | `commands/git.rs` |

### Window

| Command | Description | Module |
|---------|-------------|--------|
| `load_window_registry` | Load saved window positions | `commands/editor.rs` |
| `save_window_registry` | Save window positions | `commands/editor.rs` |

### Cloudflare / Wrangler

| Command | Description | Module |
|---------|-------------|--------|
| `check_wrangler_status` | Check wrangler installation and login state | `cloudflare.rs` |
| `wrangler_login` | Run `wrangler login` | `cloudflare.rs` |
| `deploy_worker` | Deploy Worker from embedded source files | `cloudflare.rs` |
| `setup_worker_secrets` | Auto-configure Worker secrets (OAuth attempt) | `cloudflare.rs` |
| `setup_worker_secrets_with_token` | Configure secrets with user-provided token | `cloudflare.rs` |

### Menu

| Command | Description | Module |
|---------|-------------|--------|
| `add_recent_file` | Add file to the Open Recent menu | `menu.rs` |

## MCP Bridge Endpoints

The Tauri backend runs an axum HTTP server on `localhost:31415` (fallback: 31416–31420).

### Editor

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/editor/content` | GET | Get current editor content |
| `/editor/content` | POST | Replace editor content |
| `/editor/insert` | POST | Insert text at position (cursor/start/end) |
| `/editor/state` | GET | Get editor state (file path, Worker URL, cursor) |
| `/editor/open-file` | POST | Open a file in the editor |
| `/editor/save-file` | POST | Save editor content to file |
| `/editor/structure` | GET | Get document structure as JSON |
| `/editor/normalize` | POST | Normalize document |
| `/editor/lint` | GET | Get cached lint diagnostics |
| `/editor/tabs` | GET | List open tabs |
| `/editor/root` | GET | Get project root path |
| `/editor/dirty-files` | GET | List files with unsaved changes |
| `/editor/switch-tab` | POST | Switch active tab |

### Files

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/files/list` | GET | List directory entries (supports `?recursive=true`) |
| `/files/read` | GET | Read file content |
| `/files/search` | GET | Search file names |
| `/files/create` | POST | Create empty file |
| `/files/create-directory` | POST | Create directory |
| `/files/rename` | POST | Rename/move entry |
| `/files/delete` | POST | Delete entry |
| `/files/copy` | POST | Copy file or directory to another directory |
| `/files/duplicate` | POST | Duplicate with auto-naming |

### Content & Assets

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/content/download-image` | POST | Download image from URL to local file |
| `/content/fetch-title` | POST | Extract `<title>` from a web page |

### Crawl

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/crawl/save` | POST | Save crawled pages as local Markdown files |

### Git

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/git/status` | GET | Get git status (branch, files, ahead/behind) |
| `/git/stage` | POST | Stage a file |
| `/git/unstage` | POST | Unstage a file |
| `/git/commit` | POST | Commit staged changes |
| `/git/push` | POST | Push to remote |
| `/git/pull` | POST | Pull from remote |
| `/git/fetch` | POST | Fetch from remote |
| `/git/diff` | GET | Get diff for a file (staged or unstaged) |
| `/git/discard` | POST | Discard changes for a file |
| `/git/discard-all` | POST | Discard all uncommitted changes |
| `/git/log` | GET | Get recent commit history |
| `/git/revert` | POST | Revert a commit |

## Scroll Sync

The editor and preview panes are bidirectionally scroll-synced using viewport-based live measurement:

1. **Source line annotation** — `marked.lexer()` tokens are mapped to source line numbers with an O(n) incremental counter, then attached as `data-source-line` attributes on preview elements
2. **Viewport-based mapping** — Positions are computed on-the-fly using only viewport-local data:
   - `syncToPreview()` — `posAtCoords()` finds top visible line → live `getBoundingClientRect()` on nearest `data-source-line` elements
   - `syncToEditor()` — Binary search finds preview element at viewport top → determines source line → `lineBlockAt()`
3. **Cooldown** — Timestamp-based cooldown prevents scroll event feedback loops
4. **Cursor sync** — Cursor movement scrolls the preview to the corresponding element
5. **Click-to-jump** — Clicking a preview element jumps the editor cursor to the corresponding source line

### Preview Rendering

Preview updates use idiomorph (DOM-diffing) instead of innerHTML for flicker-free updates. Key considerations:
- `overflow-anchor: none` on `#preview-pane` to prevent browser scroll anchoring conflicts
- Programmatic scroll markers before/after morph to suppress unwanted scroll events
- Preserved elements (mermaid/katex/highlighted code) retain rendered state across morphs

## Data Flow Summary

| Action | Path |
|--------|------|
| File open/save | Tauri FS plugin (sandboxed) |
| File tree browse | `list_directory` → `git check-ignore` (via `spawn_blocking`) |
| URL fetch (standard) | reqwest → target URL (with `Accept: text/markdown`) |
| URL fetch (Worker) | reqwest → Worker `/fetch` → `AI.toMarkdown()` |
| URL fetch (rendered) | reqwest → Worker `/render` → Browser Rendering `/content` → `AI.toMarkdown()` |
| Document import | reqwest → Worker `/convert` → Workers AI `AI.toMarkdown()` |
| Website crawl | reqwest → Worker `/crawl` → Browser Rendering → poll → save .md files |
| SVG inlining | reqwest → SVG URL → sanitize (string-based) → inline DOM |
| Git operations | `git` CLI subprocess (via `spawn_blocking`) |
| Git clone | `git` CLI subprocess |
| MCP agent access | MCP Server → HTTP → axum bridge → Tauri events → Frontend |
| Auto-setup | Rust → wrangler CLI → Cloudflare API |
| File watcher | Tauri FS plugin → watch events → prompt reload |
| Settings (Worker URL) | Browser localStorage |
| Tab state | Browser localStorage (debounced writes) |
| Bridge port discovery | `~/.markupsidedown-bridge-port` file |
| Error handling | Structured `AppError` enum (`Io`, `Network`, `Git`, `Worker`, `Validation`) with typed JSON bridge responses | `src-tauri/src/error.rs` |

## Key Dependencies

### Rust (`src-tauri/Cargo.toml`)

| Crate | Purpose |
|-------|---------|
| `tauri` + plugins | Desktop app framework (dialog, fs, shell, store) |
| `reqwest` | HTTP client for Worker API and SVG fetch |
| `axum` + `tokio` | MCP bridge HTTP server |
| `serde` + `serde_json` | JSON serialization |
| `urlencoding` | URL encoding for Worker API calls |
| `log` | Logging |
| `regex-lite` | Lightweight regex for wrangler output parsing |

### Frontend (`ui/package.json`)

| Package | Purpose |
|---------|---------|
| `@codemirror/*` | Editor (markdown, search, state, view) |
| `@tauri-apps/*` | Tauri IPC (api, plugin-dialog, plugin-fs) |
| `marked` | Markdown → HTML |
| `dompurify` | HTML sanitization for preview |
| `mermaid` | Diagram rendering (lazy-loaded) |
| `highlight.js` | Code syntax highlighting (lazy-loaded) |
| `katex` | Math rendering (lazy-loaded) |
| `idiomorph` | DOM-diffing for flicker-free preview updates |
| `vite-plus` (dev) | Unified toolchain (Vite + Oxlint + Oxfmt via `vp` CLI) |
