# MarkUpsideDown

A Markdown browser/editor with built-in power and smile.

No plugins. No extensions. Everything you need — live preview, file browser, Git, website crawling, document import, AI agent integration — ships in a single 15 MB app. Open it and start writing.

Powered by [Tauri v2](https://v2.tauri.app/), [CodeMirror 6](https://codemirror.net/), and [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/).

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
- **Multi-tab editing** — Open multiple files in tabs, drag to reorder
- **CodeMirror 6** — Syntax highlighting, line numbers, bracket matching, search & replace
- **Command palette** — Fuzzy search over all commands (<kbd>Cmd</kbd>+<kbd>K</kbd>)
- **Formatting shortcuts** — Bold, italic, strikethrough, inline code, link insertion
- **Document cleanup** — Normalize headings, tables, list markers, whitespace in one click
- **Markdown linting** — Structural warnings for heading hierarchy, broken links, table formatting
- **Code highlighting** — 24 languages via highlight.js (lazy-loaded), copy button on hover
- **KaTeX math** — Inline `$...$` and display `$$...$$` rendering
- **Mermaid diagrams** — Flowcharts, sequence diagrams, etc.
- **Table editor** — Spreadsheet-like editing with Tab/Enter navigation, undo/redo, paste from TSV/CSV
- **Auto-save & auto-reload** — File-backed tabs auto-save; external changes detected and reloaded
- **SVG inlining** — Remote SVG images rendered inline with sanitization

### File Browser & Git

- **File tree sidebar** — Browse, create, rename, duplicate, delete files and folders; drag & drop, search
- **Git panel** — View changes, stage/unstage files, commit, push/pull with ahead/behind counts, fetch
- **GitHub panel** — Fetch issue and PR bodies by reference (`owner/repo#123` or URL)

### Clipboard

- **Copy Rich Text** — Copy rendered HTML to clipboard (preview pane)
- **Copy Markdown** — Copy raw Markdown to clipboard (editor pane)

### Integration

- **Claude Panel** — Chat with Claude directly from the editor, powered by Claude Code CLI `stream-json` mode. Supports image paste, session persistence, and auto-reconnection.
- **MCP Server** — AI agents (Claude Desktop, Claude Code, Cowork) can read/write editor content, manage files, browse projects, crawl websites, and convert documents via [Model Context Protocol](https://modelcontextprotocol.io/) (36 tools). See [docs/mcp-server.md](docs/mcp-server.md).

### Keyboard Shortcuts

Press <kbd>Cmd</kbd>+<kbd>K</kbd> to open the command palette with all available commands. See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for the full shortcut reference.

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

**Manual setup:** See [docs/worker-deployment.md](docs/worker-deployment.md) for step-by-step instructions.

### 3. Configure the App

On first launch, Settings opens automatically. If you used auto-setup, the Worker URL is already filled in. Otherwise, paste your Worker URL and click **Test**.

## Build from Source

**Requirements:** Rust 1.85+, Node.js 22+, [Vite+](https://viteplus.dev/) (optional, for lint/format)

```bash
cd ui && npm install && cd ..
cargo tauri dev        # dev mode with hot-reload
cargo tauri build      # production build
```

## Documentation

| Document | Contents |
|----------|----------|
| [docs/architecture.md](docs/architecture.md) | Data flow, components, IPC/bridge API reference |
| [docs/mcp-server.md](docs/mcp-server.md) | MCP setup guide and 40-tool reference |
| [docs/worker-deployment.md](docs/worker-deployment.md) | Worker deployment, API tokens, pricing |
| [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) | All keyboard shortcuts |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
