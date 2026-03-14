# MarkUpsideDown

AI-era Markdown editor built with Rust (Tauri v2) and CodeMirror 6.

## Features

### Editor
- **Live Preview** — Split-pane editor with real-time Markdown rendering
- **CodeMirror 6** — Syntax highlighting for Markdown and nested code blocks, line numbers, bracket matching
- **Search & Replace** — Full search and replace with regex support (Ctrl/Cmd+H)
- **Table Editor** — Spreadsheet-like Markdown table editing with keyboard navigation
- **Mermaid Diagrams** — Live rendering of Mermaid diagrams in the preview pane
- **Dark Theme** — Catppuccin-inspired design

### Import & Conversion
- **Cloudflare Markdown for Agents** — Fetch any URL as clean Markdown using `Accept: text/markdown`
- **Browser Rendering** — Fetch JavaScript-rendered pages (SPAs, dynamic sites) as Markdown via Cloudflare Browser Rendering API
- **Document Import** — Convert PDF, Office, CSV, XML, and images to Markdown via Workers AI
- **Drag & Drop** — Drop files onto the editor to import or open them

### Export
- **Export PDF** — Print/save the preview pane as PDF
- **Copy Rich Text** — Copy the preview as rich text (HTML + plain text) to clipboard (Cmd+Shift+C)

### Integration
- **MCP Server** — AI agents (Claude Desktop, etc.) can read/write editor content via Model Context Protocol
- **GitHub** — Read Issues and PRs via `gh` CLI

## Install

### Homebrew (macOS)

```bash
brew install M-Igashi/tap/markupsidedown
```

### Manual

Download the `.dmg` from the [latest release](https://github.com/M-Igashi/markupsidedown/releases/latest), open it, and drag **MarkUpsideDown.app** to your Applications folder.

> **Note:** This app is not code-signed. When installing manually, run `xattr -cr /Applications/MarkUpsideDown.app` or right-click the app and select "Open" to bypass Gatekeeper. Homebrew installs handle this automatically.

## Build from Source

### Requirements

- Rust 1.85+
- Node.js 18+
- [gh CLI](https://cli.github.com/) (optional, for GitHub integration)

```bash
cd ui && npm install && cd ..
cargo tauri dev
```

## Cloudflare Worker (Optional)

The Worker powers two features: **Document Import** and **Rendered Fetch (Render JS)**.

```bash
# Create an API token from the "Edit Cloudflare Workers" template
# (includes Workers Scripts: Edit for deployment),
# then add Workers AI: Read and Browser Rendering: Edit permissions.
export CLOUDFLARE_API_TOKEN="your-token-here"
cd worker && npm install && wrangler deploy
```

Then click **Settings** in the app toolbar and paste your Worker URL.

See [docs/worker-deployment.md](docs/worker-deployment.md) for full setup guide including API token creation, secrets, supported formats, and pricing.

## MCP Server (Optional)

The MCP server lets AI agents interact with the editor.

```bash
cd mcp-server && npm install && npm run build
```

See [docs/mcp-server.md](docs/mcp-server.md) for Claude Desktop configuration and available tools.

## Architecture

```
src-tauri/           # Rust backend (Tauri v2)
├── src/
│   ├── main.rs      # App entry point
│   ├── commands.rs  # IPC commands (URL fetch, file conversion, GitHub)
│   └── bridge.rs    # MCP HTTP bridge (axum server on localhost:31415)
├── Cargo.toml
└── tauri.conf.json

ui/                  # Frontend (Vite + CodeMirror 6)
├── src/
│   ├── main.js      # Editor, preview, toolbar, drag & drop
│   ├── table-editor.js  # Spreadsheet-like table editing
│   ├── theme.js     # Dark theme (Catppuccin-inspired)
│   └── styles.css   # Layout and styling
├── index.html
└── package.json

worker/              # Cloudflare Worker
├── src/
│   └── index.ts     # POST /convert (AI.toMarkdown) + GET /render (Browser Rendering)
├── wrangler.jsonc
└── package.json

mcp-server/          # MCP Server (Model Context Protocol)
├── src/
│   ├── index.ts     # MCP tool definitions
│   └── bridge.ts    # HTTP client to Tauri bridge
├── tsconfig.json
└── package.json

docs/                # Documentation
├── architecture.md
├── mcp-server.md
└── worker-deployment.md
```

See [docs/architecture.md](docs/architecture.md) for detailed data flow and component documentation.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
