# Architecture

## Overview

```
AI Agent (Claude Desktop, Claude Code, etc.)
    ↕ stdio (JSON-RPC)
MCP Server (mcp-server/)
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
│  │  ├─ commands.rs  (IPC: fetch, convert, SVG, GitHub)│    │
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
└──────────────────────────────────────┘
```

## Components

### Desktop App (`src-tauri/` + `ui/`)

| Layer | Tech | Location |
|-------|------|----------|
| Desktop shell | Tauri v2 (WebKit on macOS) | `src-tauri/` |
| Editor | CodeMirror 6 (Markdown) | `ui/src/main.js` |
| Preview | marked.js + KaTeX + Mermaid + highlight.js | `ui/src/main.js` |
| Scroll sync | Anchor-based bidirectional sync with cooldown | `ui/src/main.js` |
| Settings | Worker setup (auto + manual), feature status | `ui/src/settings.js` |
| Table editor | Spreadsheet grid with undo/redo, paste TSV/CSV | `ui/src/table-editor.js` |
| Theme | Warm paper palette (light) | `ui/src/theme.js` |
| Backend commands | Rust (Tauri IPC) | `src-tauri/src/commands.rs` |
| Auto-setup | Wrangler CLI (login, deploy, secrets) | `src-tauri/src/cloudflare.rs` |
| MCP bridge | Rust (axum HTTP server) | `src-tauri/src/bridge.rs` |

### Cloudflare Worker (`worker/`)

| Endpoint | Purpose | Cloudflare Service |
|----------|---------|-------------------|
| `GET /health` | Capability check (reports convert/render availability) | — |
| `POST /convert` | Document/image → Markdown | Workers AI `AI.toMarkdown()` |
| `GET /render?url=` | JS-rendered page → Markdown | Browser Rendering REST API |

The `/render` endpoint uses a two-step pipeline:

1. **Content extraction** — `POST /content` gets the rendered HTML
2. **Boilerplate removal** — HTMLRewriter strips nav, header, footer, cookie banners, ads, etc.
3. **Markdown conversion** — `POST /markdown` converts cleaned HTML to Markdown
4. **Caching** — Responses cached for 1 hour via `caches.default`

### MCP Server (`mcp-server/`)

| Component | Role |
|-----------|------|
| `index.ts` | 9 MCP tools (editor, conversion, file operations) |
| `bridge.ts` | HTTP client to Tauri bridge (auto-discovers port) |

Communication: MCP server reads the bridge port from `~/.markupsidedown-bridge-port` and sends HTTP requests to the Tauri backend's axum server.

See [mcp-server.md](mcp-server.md) for the full tool list.

## Tauri IPC Commands

| Command | Description | Module |
|---------|-------------|--------|
| `sync_editor_state` | Sync editor state to Rust (for MCP bridge) | `commands.rs` |
| `test_worker_url` | Test Worker health and report capabilities | `commands.rs` |
| `fetch_url_as_markdown` | Fetch URL with `Accept: text/markdown` header | `commands.rs` |
| `fetch_rendered_url_as_markdown` | Fetch JS-rendered page via Worker `/render` | `commands.rs` |
| `convert_file_to_markdown` | Send file to Worker `/convert` | `commands.rs` |
| `detect_file_is_image` | Check if file is image (derived from MIME map) | `commands.rs` |
| `fetch_svg` | Fetch and sanitize remote SVG for inline rendering | `commands.rs` |
| `github_fetch_issue` | Fetch GitHub issue body via `gh` CLI | `commands.rs` |
| `github_fetch_pr` | Fetch GitHub PR body via `gh` CLI | `commands.rs` |
| `github_list_repos` | List GitHub repos via `gh` CLI | `commands.rs` |
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

The editor and preview panes are bidirectionally scroll-synced using an anchor-based approach:

1. **Source line annotation** — `marked.lexer()` tokens are mapped to source line numbers with an O(n) incremental counter, then attached as `data-source-line` attributes on preview elements
2. **Anchor building** — After each render, editor Y positions (via `lineBlockAt`) and preview Y positions (via `offsetTop`) are paired into anchor points
3. **Interpolation** — Binary search finds the surrounding anchors, then linear interpolation maps scroll positions between panes
4. **Cooldown** — A 50ms timestamp-based cooldown prevents scroll event feedback loops
5. **Cursor sync** — Cursor movement scrolls the preview to the corresponding element, with a 100ms cooldown after preview clicks to prevent conflicts

## Data Flow Summary

| Action | Path |
|--------|------|
| File open/save | Tauri FS plugin (sandboxed) |
| URL fetch (standard) | reqwest → target URL (with `Accept: text/markdown`) |
| URL fetch (rendered) | reqwest → Worker → Browser Rendering REST API |
| Document import | reqwest → Worker → Workers AI `AI.toMarkdown()` |
| SVG inlining | reqwest → SVG URL → sanitize (string-based) → inline DOM |
| GitHub | `gh` CLI subprocess |
| MCP agent access | MCP Server → HTTP → axum bridge → Tauri events → Frontend |
| Auto-setup | Rust → wrangler CLI → Cloudflare API |
| Settings (Worker URL) | Browser localStorage |
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

### Frontend (`ui/package.json`)

| Package | Purpose |
|---------|---------|
| `@codemirror/*` | Editor (markdown, search, state, view) |
| `@tauri-apps/*` | Tauri IPC (api, plugin-dialog, plugin-fs) |
| `marked` | Markdown → HTML |
| `mermaid` | Diagram rendering (lazy-loaded) |
| `highlight.js` | Code syntax highlighting |
| `katex` | Math rendering (inline and display) |
| `vite-plus` (dev) | Unified toolchain (Vite + Oxlint + Oxfmt via `vp` CLI) |
