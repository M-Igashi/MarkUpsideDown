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
│  │  ├─ commands.rs  (IPC: fetch, convert, file, git) │    │
│  │  ├─ bridge.rs    (axum HTTP server for MCP)       │    │
│  │  └─ cloudflare.rs (wrangler CLI, auto-setup)      │    │
│  └───────┬──────────────────────────────────────────┘    │
└──────────┼───────────────────────────────────────────────┘
           │ HTTP
           ▼
┌──────────────────────────────────────┐
│  Cloudflare Worker                    │
│  GET  /health   → capability check    │
│  POST /convert  → AI.toMarkdown()    │
│  GET  /render   → Browser Rendering   │
│       (content → stripBoilerplate     │
│        → /markdown)                   │
│  POST /crawl    → start site crawl    │
│  GET  /crawl/:id → poll crawl results │
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
| Sidebar | File tree browser with context menu, search, drag & drop | `ui/src/sidebar.ts` |
| Tabs | Multi-tab editing with state persistence, drag reorder | `ui/src/tabs.ts` |
| Git panel | Status, stage/unstage, commit, push/pull with ahead/behind, fetch | `ui/src/git-panel.ts` |
| GitHub panel | Issue/PR body fetcher via `gh` CLI | `ui/src/github-panel.ts` |

| Table editor | Spreadsheet grid with undo/redo, paste TSV/CSV | `ui/src/table-editor.ts` |
| Formatting | Markdown shortcuts (bold, italic, link, strikethrough, code) | `ui/src/markdown-commands.ts` |
| Crawl | Website crawl UI (options dialog, polling, file saving) | `ui/src/crawl.ts` |
| File operations | Create, rename, delete, import, auto-save | `ui/src/file-ops.ts` |
| File watcher | External file change detection and auto-reload | `ui/src/file-watcher.ts` |
| Clipboard | Rich text / Markdown copy | `ui/src/clipboard.ts` |
| MCP sync | Editor state sync for MCP bridge | `ui/src/mcp-sync.ts` |
| Normalize | Post-conversion Markdown normalization | `ui/src/normalize.ts` |
| Document structure | Heading tree, links, tables, stats parser | `ui/src/document-structure.ts` |
| Markdown lint | Structural linting (headings, links, tables) | `ui/src/markdown-lint.ts` |
| Command palette | Fuzzy search over all commands (Cmd+K) | `ui/src/command-palette.ts` |
| Theme | CodeMirror editor theme (warm paper palette) | `ui/src/theme.ts` |
| Backend commands | Rust (Tauri IPC) | `src-tauri/src/commands.rs` |
| Auto-setup | Wrangler CLI (login, deploy, secrets) | `src-tauri/src/cloudflare.rs` |

| MCP bridge | Rust (axum HTTP server) | `src-tauri/src/bridge.rs` |

### Cloudflare Worker (`worker/`)

| Endpoint | Purpose | Cloudflare Service |
|----------|---------|-------------------|
| `GET /health` | Capability check (reports convert/render/crawl availability) | — |
| `POST /convert` | Document/image → Markdown | Workers AI `AI.toMarkdown()` |
| `GET /render?url=` | JS-rendered page → Markdown | Browser Rendering REST API |
| `POST /crawl` | Start website crawl (returns `job_id`) | Browser Rendering `/crawl` REST API |
| `GET /crawl/:job_id` | Poll crawl status and retrieve results | Browser Rendering `/crawl` REST API |

The `/render` endpoint uses a multi-step pipeline:

1. **Content extraction** — `POST /content` gets the rendered HTML
2. **Boilerplate removal** — HTMLRewriter strips nav, header, footer, cookie banners, ads, etc.
3. **Markdown conversion** — `POST /markdown` converts cleaned HTML to Markdown
4. **Caching** — Responses cached for 1 hour via `caches.default`

Security: SSRF prevention validates URLs and blocks private/reserved IP ranges via DNS-over-HTTPS resolution.

### MCP Server (`mcp-server-rs/`)

| Component | Role |
|-----------|------|
| `main.rs` | Entry point, stdio transport |
| `tools.rs` | 15 MCP tools (editor, conversion, crawl, diagnostics) |
| `bridge.rs` | HTTP client to Tauri bridge (auto-discovers port) |

Communication: MCP server (Rust sidecar binary) reads the bridge port from `~/.markupsidedown-bridge-port` and sends HTTP requests to the Tauri backend's axum server.

See [mcp-server.md](mcp-server.md) for the full tool list.

## Tauri IPC Commands

### Core

| Command | Description | Module |
|---------|-------------|--------|
| `sync_editor_state` | Sync editor state to Rust (for MCP bridge) | `commands.rs` |
| `get_mcp_binary_path` | Get path to bundled MCP sidecar binary | `commands.rs` |
| `create_cowork_workspace` | Create a Cowork workspace folder with MCP config | `commands.rs` |

### Worker / Conversion

| Command | Description | Module |
|---------|-------------|--------|
| `test_worker_url` | Test Worker health and report capabilities | `commands.rs` |
| `fetch_url_as_markdown` | Fetch URL with `Accept: text/markdown` header | `commands.rs` |
| `fetch_rendered_url_as_markdown` | Fetch JS-rendered page via Worker `/render` | `commands.rs` |
| `convert_file_to_markdown` | Send file to Worker `/convert` | `commands.rs` |
| `detect_file_is_image` | Check if file is image (derived from MIME map) | `commands.rs` |
| `fetch_svg` | Fetch and sanitize remote SVG for inline rendering | `commands.rs` |
| `crawl_website` | Start website crawl via Worker `/crawl` | `commands.rs` |
| `crawl_status` | Poll crawl job status and retrieve completed pages | `commands.rs` |
| `crawl_save` | Save crawled pages as Markdown files to local directory | `commands.rs` |

### File Operations

| Command | Description | Module |
|---------|-------------|--------|
| `read_text_file` | Read file content (UTF-8) | `commands.rs` |
| `list_directory` | List files/folders (respects .gitignore, dirs first) | `commands.rs` |
| `create_file` | Create empty file | `commands.rs` |
| `create_directory` | Create directory | `commands.rs` |
| `rename_entry` | Rename file or folder | `commands.rs` |
| `delete_entry` | Delete file or folder (recursive for dirs) | `commands.rs` |
| `duplicate_entry` | Copy with unique name suffix ("file copy.md") | `commands.rs` |
| `reveal_in_finder` | Open in system file manager (macOS/Windows/Linux) | `commands.rs` |

### Git

| Command | Description | Module |
|---------|-------------|--------|
| `git_status` | Get branch + file changes with line diffs | `commands.rs` |
| `git_stage_all` | Stage all changes (`git add -A`) | `commands.rs` |
| `git_stage` | Stage specific file | `commands.rs` |
| `git_unstage` | Unstage specific file (`git reset HEAD`) | `commands.rs` |
| `git_commit` | Commit with message | `commands.rs` |
| `git_push` | Push to remote | `commands.rs` |
| `git_pull` | Pull from remote | `commands.rs` |
| `git_fetch` | Fetch remote updates | `commands.rs` |

### GitHub

| Command | Description | Module |
|---------|-------------|--------|
| `github_fetch_issue` | Fetch GitHub issue body via `gh` CLI | `commands.rs` |
| `github_fetch_pr` | Fetch GitHub PR body via `gh` CLI | `commands.rs` |
| `github_list_repos` | List GitHub repos via `gh` CLI | `commands.rs` |

### Cloudflare / Wrangler

| Command | Description | Module |
|---------|-------------|--------|
| `check_wrangler_status` | Check wrangler installation and login state | `cloudflare.rs` |
| `wrangler_login` | Run `wrangler login` | `cloudflare.rs` |
| `deploy_worker` | Deploy Worker from embedded source files | `cloudflare.rs` |
| `setup_worker_secrets` | Auto-configure Worker secrets | `cloudflare.rs` |
| `setup_worker_secrets_with_token` | Configure secrets with user-provided token | `cloudflare.rs` |

## MCP Bridge Endpoints

The Tauri backend runs an axum HTTP server on `localhost:31415` (fallback: 31416–31420).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/editor/content` | GET | Get current editor content |
| `/editor/content` | POST | Replace editor content |
| `/editor/insert` | POST | Insert text at position (cursor/start/end) |
| `/editor/state` | GET | Get editor state (file path, Worker URL, cursor) |
| `/editor/open-file` | POST | Open a file in the editor |
| `/editor/save-file` | POST | Save editor content to file |
| `/editor/export-pdf` | POST | Trigger PDF export |

## Scroll Sync

The editor and preview panes are bidirectionally scroll-synced using viewport-based live measurement:

1. **Source line annotation** — `marked.lexer()` tokens are mapped to source line numbers with an O(n) incremental counter, then attached as `data-source-line` attributes on preview elements
2. **Viewport-based mapping** — Instead of pre-computing all anchors, positions are computed on-the-fly using only viewport-local data:
   - `syncToPreview()` — `posAtCoords()` finds top visible line → live `getBoundingClientRect()` on nearest `data-source-line` elements
   - `syncToEditor()` — Finds preview element at viewport top → determines source line → `lineBlockAt()` (accurate near viewport)
3. **Cooldown** — Timestamp-based cooldown prevents scroll event feedback loops
4. **Cursor sync** — Cursor movement scrolls the preview to the corresponding element
5. **Click-to-jump** — Clicking a preview element jumps the editor cursor to the corresponding source line

### Preview Rendering

Preview updates use idiomorph (DOM-diffing) instead of innerHTML for flicker-free updates. Key considerations:
- `overflow-anchor: none` on `#preview-pane` to prevent browser scroll anchoring conflicts
- Programmatic scroll markers before/after morph to suppress unwanted scroll events
- Preserved elements (mermaid/katex) retain `data-source-line` attributes across morphs

## Data Flow Summary

| Action | Path |
|--------|------|
| File open/save | Tauri FS plugin (sandboxed) |
| File tree browse | `list_directory` → `git check-ignore` (via `spawn_blocking`) |
| URL fetch (standard) | reqwest → target URL (with `Accept: text/markdown`) |
| URL fetch (rendered) | reqwest → Worker → Browser Rendering REST API |
| Document import | reqwest → Worker → Workers AI `AI.toMarkdown()` |
| Website crawl | reqwest → Worker → Browser Rendering `/crawl` REST API → poll → save .md files |
| SVG inlining | reqwest → SVG URL → sanitize (string-based) → inline DOM |
| Git operations | `git` CLI subprocess (via `spawn_blocking`) |
| GitHub | `gh` CLI subprocess |
| MCP agent access | MCP Server → HTTP → axum bridge → Tauri events → Frontend |

| Auto-setup | Rust → wrangler CLI → Cloudflare API |
| File watcher | Tauri FS plugin → watch events → prompt reload |
| Settings (Worker URL) | Browser localStorage |
| Tab state | Browser localStorage (debounced writes) |
| Bridge port discovery | `~/.markupsidedown-bridge-port` file |

## Key Dependencies

### Rust (`src-tauri/Cargo.toml`)

| Crate | Purpose |
|-------|---------|
| `tauri` + plugins | Desktop app framework (dialog, fs, shell) |
| `reqwest` | HTTP client for Worker API and SVG fetch |
| `axum` + `tokio` | MCP bridge HTTP server |
| `serde` + `serde_json` | JSON serialization |
| `urlencoding` | URL encoding for Worker API calls |
| `dirs` | Home directory resolution |
| `log` | Logging |

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
| `vite-plus` (dev) | Unified toolchain (Vite + Oxlint + Oxfmt via `vp` CLI) |
