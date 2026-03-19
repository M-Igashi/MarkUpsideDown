# MarkUpsideDown

Turn any markup into Markdown — websites, PDFs, Office docs, images.

A desktop Markdown editor that bridges the web and AI, powered by [Tauri v2](https://v2.tauri.app/), [CodeMirror 6](https://codemirror.net/), and [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/).

![License](https://img.shields.io/github/license/M-Igashi/MarkUpsideDown)
![Release](https://img.shields.io/github/v/release/M-Igashi/MarkUpsideDown)

## Features

### Markup to Markdown

| Feature | How it works |
|---------|-------------|
| **Fetch URL** | Cloudflare [Markdown for Agents](https://developers.cloudflare.com/agents/guides/markdown-for-agents/) — fast, free |
| **Fetch URL (Render JS)** | [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) — SPAs, dynamic sites |
| **Crawl website** | [Browser Rendering `/crawl` API](https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/) — crawl entire sites to Markdown files |
| **Import documents** | [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/) — PDF, DOCX, XLSX, PPTX, HTML, CSV, XML |
| **Import images** | Workers AI OCR — JPG, PNG, GIF, WebP, BMP, TIFF |

| **Drag & Drop** | Drop any supported file onto the editor to import |

### Editor

- **Live preview** — Split-pane with real-time rendering, DOM-diffing (idiomorph), and bidirectional scroll sync
- **Multi-tab editing** — Open multiple files in tabs, drag to reorder, switch with <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> / <kbd>]</kbd>
- **CodeMirror 6** — Syntax highlighting, line numbers, bracket matching, search & replace
- **Command palette** — Fuzzy search over all commands with <kbd>Cmd</kbd>+<kbd>K</kbd>
- **Formatting shortcuts** — Bold, italic, strikethrough, inline code, link insertion
- **Document cleanup** — Normalize headings, tables, list markers, whitespace in one click
- **Markdown linting** — Structural warnings for heading hierarchy, broken links, table formatting
- **Code highlighting** — 30+ languages via highlight.js (lazy-loaded), copy button on hover
- **KaTeX math** — Inline `$...$` and display `$$...$$` rendering
- **Mermaid diagrams** — Flowcharts, sequence diagrams, etc.
- **Table editor** — Spreadsheet-like editing with Tab/Enter navigation, undo/redo, paste from TSV/CSV
- **Auto-save & auto-reload** — File-backed tabs auto-save; external changes detected and reloaded
- **SVG inlining** — Remote SVG images rendered inline with sanitization
- **Safari Reader-inspired preview** — Clean sans-serif typography with CJK text spacing support

### File Browser & Git

- **File tree sidebar** — Browse, create, rename, duplicate, delete files and folders; drag & drop, search
- **Git panel** — View changes, stage/unstage files, commit, push/pull with ahead/behind counts, fetch
- **GitHub panel** — Fetch issue and PR bodies by reference (`owner/repo#123` or URL)


### Export

- **Export PDF** — Print/save the preview pane as PDF
- **Copy Rich Text** — Copy rendered HTML to clipboard (preview pane)
- **Copy Markdown** — Copy raw Markdown to clipboard (editor pane)

### Integration

- **MCP Server** — AI agents (Claude Desktop, Claude Code, Cowork) can read/write editor content, crawl websites, and convert documents via [Model Context Protocol](https://modelcontextprotocol.io/) (15 tools)

### Keyboard Shortcuts

#### Formatting (editor)

| Shortcut | Action |
|----------|--------|
| <kbd>Cmd</kbd>+<kbd>B</kbd> | Bold (`**text**`) |
| <kbd>Cmd</kbd>+<kbd>I</kbd> | Italic (`*text*`) |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> | Strikethrough (`~~text~~`) |
| <kbd>Cmd</kbd>+<kbd>`</kbd> | Inline code (`` `text` ``) |
| <kbd>Cmd</kbd>+<kbd>K</kbd> | Command palette (fuzzy search) |

#### File & Tabs

| Shortcut | Action |
|----------|--------|
| <kbd>Cmd</kbd>+<kbd>S</kbd> | Save file |
| <kbd>Cmd</kbd>+<kbd>W</kbd> | Close tab |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> | Previous tab |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd> | Next tab |

#### Panels

| Shortcut | Action |
|----------|--------|
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> | Toggle sidebar |
| <kbd>Cmd</kbd>+<kbd>E</kbd> | Toggle editor pane |
| <kbd>Cmd</kbd>+<kbd>\\</kbd> | Toggle preview pane |

#### Copy (<kbd>Cmd</kbd>+<kbd>C</kbd>)

| Focus | Selection | Behavior |
|-------|-----------|----------|
| Editor pane | Text selected | Copy selected text as plain Markdown (default) |
| Editor pane | No selection | Copy entire document as plain Markdown |
| Preview pane | Text selected | Copy selected text as rich text (HTML + plain) (default) |
| Preview pane | No selection | Copy entire preview as rich text (HTML + plain) |

## Requirements

- **macOS** on **Apple Silicon** (M1/M2/M3/M4)

## Getting Started

### 1. Install the App

**Homebrew (macOS):**

```bash
brew install M-Igashi/tap/markupsidedown
```

**Manual:** Download the `.dmg` from the [latest release](https://github.com/M-Igashi/MarkUpsideDown/releases/latest), open it, and drag **MarkUpsideDown.app** to Applications.

> **Note:** The app is not code-signed. For manual installs, run `xattr -cr /Applications/MarkUpsideDown.app` or right-click → Open to bypass Gatekeeper. Homebrew handles this automatically.

### 2. Set Up the Cloudflare Worker

The Worker powers document import and JS-rendered page fetching.

**Automatic setup (recommended):** On first launch, click **Setup with Cloudflare** in the Settings panel. This runs `wrangler login`, deploys the Worker, and configures secrets — all from within the app.

**Manual setup:**

```bash
npm install -g wrangler
wrangler login

export CLOUDFLARE_API_TOKEN="your-token"
cd worker && wrangler deploy
```

For Render JS, also set secrets:

```bash
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put CLOUDFLARE_API_TOKEN
```

See [docs/worker-deployment.md](docs/worker-deployment.md) for API token creation and pricing details.

### 3. Configure the App

On first launch, Settings opens automatically. If you used auto-setup, the Worker URL is already filled in. Otherwise, paste your Worker URL and click **Test**.

The **Feature Status** panel shows which capabilities are available.

## Build from Source

**Requirements:** Rust 1.85+, Node.js 22+, [Vite+](https://viteplus.dev/) (optional, for lint/format), [gh CLI](https://cli.github.com/) (optional)

```bash
cd ui && npm install && cd ..
cargo tauri dev        # dev mode with hot-reload
cargo tauri build      # production build

# Lint + format (requires vp CLI)
cd ui && vp check src/
```

## MCP Server

The MCP server lets AI agents interact with the editor — read/write content, open/save files, import documents, and more. It is a standalone Rust binary bundled as a Tauri sidecar (no Node.js required).

**Setup:** Open **Settings > AI Agent Integration** in the app, then copy the config JSON for your AI client (Claude Desktop, Claude Code, or Cowork).

See [docs/mcp-server.md](docs/mcp-server.md) for the full tool list and troubleshooting.

## Architecture

```
src-tauri/               # Rust backend (Tauri v2)
├── src/
│   ├── main.rs          # App entry, plugin setup
│   ├── commands.rs      # IPC commands (fetch, convert, crawl, file ops, git, GitHub)
│   ├── bridge.rs        # MCP HTTP bridge (axum, localhost:31415)
│   ├── cloudflare.rs    # Wrangler CLI integration, auto-setup wizard

│   └── util.rs          # Shared utilities
├── Cargo.toml
└── tauri.conf.json

ui/                      # Frontend (Vite+ + TypeScript)
├── src/
│   ├── main.ts              # Editor, toolbar, bridge events
│   ├── preview-render.ts    # Markdown → HTML (marked + idiomorph DOM-diffing)
│   ├── scroll-sync.ts       # Bidirectional editor↔preview scroll sync
│   ├── settings.ts          # Settings panel, auto-setup UI, MCP config
│   ├── sidebar.ts           # File tree browser with context menu, search, drag & drop
│   ├── tabs.ts              # Multi-tab management with state persistence
│   ├── git-panel.ts         # Git status, stage/unstage, commit, push/pull
│   ├── github-panel.ts      # GitHub issue/PR fetcher

│   ├── table-editor.ts      # Spreadsheet-like table editor with undo/redo
│   ├── markdown-commands.ts # Formatting shortcuts (bold, italic, link, etc.)
│   ├── crawl.ts             # Website crawl UI (dialog, polling, file saving)
│   ├── file-ops.ts          # File create, rename, delete, import, auto-save
│   ├── file-watcher.ts      # External file change detection and auto-reload
│   ├── clipboard.ts         # Rich text / Markdown copy
│   ├── mcp-sync.ts          # Editor state sync for MCP bridge
│   ├── normalize.ts         # Post-conversion Markdown normalization
│   ├── document-structure.ts # Document structure parser (headings, links, tables)
│   ├── markdown-lint.ts     # Markdown structural linting
│   ├── command-palette.ts   # Command palette with fuzzy search (Cmd+K)
│   ├── theme.ts             # CodeMirror editor theme
│   ├── global.d.ts          # Tauri type declarations
│   └── styles.css           # All styling (editor, preview, sidebar, dialogs, print)
├── index.html
└── package.json

worker/                  # Cloudflare Worker
├── src/index.ts         # /health, /convert (AI.toMarkdown), /render, /crawl (Browser Rendering)
├── wrangler.jsonc
└── package.json

mcp-server-rs/           # MCP Server (Rust sidecar binary)
├── src/
│   ├── main.rs          # Entry point (stdio transport)
│   ├── tools.rs         # 15 MCP tools (editor, conversion, crawl, diagnostics)
│   └── bridge.rs        # HTTP client to Tauri bridge
└── Cargo.toml

docs/                    # Documentation
├── architecture.md      # Data flow, components, IPC/bridge API reference
├── mcp-server.md        # MCP setup guide and tool reference
└── worker-deployment.md # Worker deployment, API tokens, pricing
```

See [docs/architecture.md](docs/architecture.md) for detailed data flow and API reference.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
