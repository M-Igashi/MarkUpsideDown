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
| **Import documents** | [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/) — PDF, DOCX, XLSX, HTML, CSV, XML |
| **Import images** | Workers AI OCR — JPG, PNG, WebP, SVG |
| **Paste / Drop images** | Paste from clipboard or drag & drop — saves to `./assets/` with Markdown link |
| **Batch import** | Queue-based parallel conversion of multiple files via Worker |
| **Drag & Drop** | Drop any supported file onto the editor to import |

### Editor

- **Live preview** — Split-pane with real-time rendering, DOM-diffing (idiomorph), and bidirectional scroll sync
- **Multi-tab editing** — Open multiple files in tabs, drag to reorder
- **CodeMirror 6** — Syntax highlighting, line numbers, bracket matching, search & replace
- **Command palette** — Fuzzy search over all commands (<kbd>Cmd</kbd>+<kbd>K</kbd>); type `?` to switch to semantic search
- **Formatting shortcuts** — Bold, italic, strikethrough, inline code, link insertion
- **Document cleanup** — Normalize headings, tables, list markers, whitespace, CJK emphasis spacing in one click
- **Markdown linting** — 11 structural checks + CommonMark validation via comrak: heading hierarchy, broken links, table formatting, emphasis flanking, code blocks, footnotes, blank lines
- **Code highlighting** — 24 languages via highlight.js (lazy-loaded), copy button on hover
- **KaTeX math** — Inline `$...$` and display `$$...$$` rendering
- **Mermaid diagrams** — Flowcharts, sequence diagrams, etc. Click to open zoom/pan viewer with Copy as PNG
- **GitHub-style alerts** — `[!NOTE]`, `[!TIP]`, `[!WARNING]`, `[!IMPORTANT]`, `[!CAUTION]` blockquotes with colored icons
- **Table of Contents** — Heading navigation panel with active heading tracking (<kbd>Cmd</kbd>+<kbd>4</kbd>)
- **Frontmatter panel** — Collapsible YAML frontmatter display above the editor
- **Table editor** — Spreadsheet-like editing with Tab/Enter navigation, undo/redo, paste from TSV/CSV
- **Presentation mode** — Split document at `---` and present slides fullscreen
- **Auto link title** — Paste a URL to auto-fetch the page title and format as `[Title](url)`
- **Smart typography** — Auto-convert `...` → `…`, `--` → `–`, `---` → `—` as you type
- **Note refactor** — Extract selected text into a new linked Markdown file
- **Semantic search** — Natural language search across indexed documents via Vectorize (<kbd>Cmd</kbd>+<kbd>5</kbd> or `?` in command palette); crawled and imported files are auto-indexed
- **Multi-window** — Open multiple windows with per-window state isolation and session restoration
- **Auto-save & auto-reload** — File-backed tabs auto-save; external changes detected and reloaded
- **SVG inlining** — Remote SVG images rendered inline with sanitization

### File Browser & Git

- **File tree sidebar** — Browse, create, rename, duplicate, delete files and folders; drag & drop, search, file tagging
- **Git panel** — View changes, stage/unstage files, commit, push/pull with ahead/behind counts, fetch
- **Clone repository** — Clone Git repositories (HTTPS/SSH) and open them in the editor

### Clipboard & Copy

- **Copy Rich Text** — Copy rendered HTML to clipboard (preview pane)
- **Copy Markdown** — Copy raw Markdown to clipboard (editor pane)
- **Copy Mermaid as PNG** — One-click PNG export from Mermaid diagrams (2x Retina)
- **Copy code blocks** — Hover any code block in the preview for a Copy button

### Publishing

- **Publish to R2** — Share Markdown files via Cloudflare R2 with permanent or time-limited URLs

### AI Agent Integration

- **MCP Server** — AI agents (Claude Desktop, Claude Code, Cowork) can read/write editor content, manage files, browse projects, crawl websites, lint/normalize documents, and convert documents via [Model Context Protocol](https://modelcontextprotocol.io/) (62 tools). See [docs/ai-integration.md](docs/ai-integration.md) for setup.
- **File-watcher sync** — External edits by AI agents are automatically detected and reloaded in the editor

### Keyboard Shortcuts

Press <kbd>Cmd</kbd>+<kbd>K</kbd> to open the command palette with all available commands. Right-click links in the preview for quick Fetch/Render/Crawl actions. See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for the full shortcut reference.

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

**Automatic setup (recommended):** On first launch, click **Setup with Cloudflare** in the Settings panel. This runs `wrangler login`, creates Cloudflare resources (KV, R2, Queue, Vectorize), deploys the Worker with a randomized URL, and configures secrets — all from within the app.

**Manual setup:** See [docs/worker-deployment.md](docs/worker-deployment.md) for step-by-step instructions.

### 3. Configure the App

On first launch, Settings opens automatically. If you used auto-setup, the Worker URL is already filled in. Otherwise, paste your Worker URL and click **Test**.

### 4. CLI Access (Optional)

Create a symlink so you can open files from the terminal:

```bash
sudo ln -sf /Applications/MarkUpsideDown.app/Contents/MacOS/MarkUpsideDown /usr/local/bin/markupsidedown
```

```bash
markupsidedown README.md                          # open a file
markupsidedown file1.md file2.md notes/todo.md    # open multiple files as tabs
```

If the app is already running, files are opened in the existing window. See [docs/cli.md](docs/cli.md) for details.

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
| [docs/ai-integration.md](docs/ai-integration.md) | AI agent setup guide (quick start) |
| [docs/mcp-server.md](docs/mcp-server.md) | MCP server reference (62 tools, standalone mode) |
| [docs/worker-deployment.md](docs/worker-deployment.md) | Worker deployment, API tokens, pricing |
| [docs/architecture.md](docs/architecture.md) | Data flow, components, IPC/bridge API reference |
| [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) | All keyboard shortcuts |
| [docs/cli.md](docs/cli.md) | CLI setup and usage |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
