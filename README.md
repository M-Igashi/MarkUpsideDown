# MarkUpsideDown

Turn any markup into Markdown — websites, PDFs, Office docs, images.

A desktop Markdown editor that bridges the web and AI, powered by [Tauri v2](https://v2.tauri.app/), [CodeMirror 6](https://codemirror.net/), and [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/).

![License](https://img.shields.io/github/license/M-Igashi/MarkUpsideDown)
![Release](https://img.shields.io/github/v/release/M-Igashi/MarkUpsideDown)

## Features

### Markup → Markdown

| Feature | How it works |
|---------|-------------|
| **Fetch URL** | Cloudflare [Markdown for Agents](https://developers.cloudflare.com/agents/guides/markdown-for-agents/) — fast, free |
| **Fetch URL (Render JS)** | [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) — SPAs, dynamic sites |
| **Import documents** | [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/) — PDF, DOCX, XLSX, PPTX, HTML, CSV, XML |
| **Import images** | Workers AI OCR — JPG, PNG, GIF, WebP, BMP, TIFF |
| **Drag & Drop** | Drop any supported file onto the editor to import |

### Editor

- **Live preview** — Split-pane with real-time rendering and bidirectional scroll sync
- **CodeMirror 6** — Syntax highlighting, line numbers, bracket matching, search & replace
- **KaTeX math** — Inline `$...$` and display `$$...$$` math rendering
- **Syntax highlighting** — Code blocks with language detection (highlight.js)
- **Mermaid diagrams** — Live rendering of flowcharts, sequence diagrams, etc.
- **Table editor** — Spreadsheet-like editing with Tab/Enter navigation, undo/redo, paste from TSV/CSV
- **SVG inlining** — Remote SVG images rendered inline with sanitization
- **Paper-like preview** — Warm, serif-accented reading experience inspired by Safari Reader

### Export

- **Export PDF** — Print/save the preview pane as PDF
- **Copy Rich Text** — Copy rendered HTML to clipboard (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>)

### Integration

- **MCP Server** — AI agents (Claude Desktop, Claude Code, etc.) can read/write editor content via [Model Context Protocol](https://modelcontextprotocol.io/)
- **GitHub** — Fetch issue and PR bodies via `gh` CLI

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

The MCP server lets AI agents interact with the editor — read/write content, open/save files, import documents, and more.

```bash
cd mcp-server && npm install && npm run build
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "markupsidedown": {
      "command": "node",
      "args": ["/path/to/markupsidedown/mcp-server/dist/index.js"],
      "env": {
        "MARKUPSIDEDOWN_WORKER_URL": "https://markupsidedown-converter.YOUR_SUBDOMAIN.workers.dev"
      }
    }
  }
}
```

See [docs/mcp-server.md](docs/mcp-server.md) for the full tool list and troubleshooting.

## Architecture

```
src-tauri/               # Rust backend (Tauri v2)
├── src/
│   ├── main.rs          # App entry, plugin setup
│   ├── commands.rs      # IPC commands (URL fetch, conversion, SVG, GitHub)
│   ├── bridge.rs        # MCP HTTP bridge (axum, localhost:31415)
│   └── cloudflare.rs    # Wrangler CLI integration, auto-setup wizard
├── Cargo.toml
└── tauri.conf.json

ui/                      # Frontend (Vite+ + vanilla JS)
├── src/
│   ├── main.js          # Editor, preview, scroll sync, toolbar, bridge events
│   ├── settings.js      # Settings panel, auto-setup UI, feature status
│   ├── table-editor.js  # Spreadsheet-like table editor with undo/redo
│   ├── theme.js         # Light theme (warm paper palette)
│   └── styles.css       # All styling (editor, preview, dialogs, print)
├── index.html
└── package.json

worker/                  # Cloudflare Worker
├── src/index.ts         # /health, /convert (AI.toMarkdown), /render (Browser Rendering)
├── wrangler.jsonc
└── package.json

mcp-server/              # MCP Server (Model Context Protocol)
├── src/
│   ├── index.ts         # 9 MCP tools (editor, conversion, file operations)
│   └── bridge.ts        # HTTP client to Tauri bridge
└── package.json

docs/                    # Documentation
├── architecture.md      # Data flow, components, IPC/bridge API reference
├── mcp-server.md        # MCP setup guide and tool reference
└── worker-deployment.md # Worker deployment, API tokens, pricing
```

See [docs/architecture.md](docs/architecture.md) for detailed data flow and API reference.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
