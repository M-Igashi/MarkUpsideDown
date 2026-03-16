# MCP Server Setup Guide

MarkUpsideDown exposes its editing and conversion capabilities as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, allowing AI agents to use the editor as a tool.

## Architecture

```
AI Agent (Claude Desktop, Claude Code, etc.)
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

## Available Tools

### Editor Tools (require the app to be running)

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_editor_content` | Get current Markdown from the editor | — |
| `set_editor_content` | Replace editor content | `markdown: string` |
| `insert_text` | Insert text at cursor, start, or end | `text: string`, `position?: "cursor" \| "start" \| "end"` |
| `open_file` | Open a Markdown file in the editor | `path: string` |
| `save_file` | Save content to a file | `path?: string` (uses current file if omitted) |
| `export_pdf` | Export as PDF (opens print dialog) | — |

### Conversion Tools (require Worker URL)

| Tool | Description | Parameters |
|------|-------------|------------|
| `fetch_markdown` | Fetch a URL as Markdown via Markdown for Agents | `url: string` |
| `render_markdown` | Fetch a JS-rendered page as Markdown via Browser Rendering | `url: string` |
| `convert_to_markdown` | Convert a local file to Markdown via Workers AI | `file_path: string` |

**Supported formats for `convert_to_markdown`:** PDF, DOCX, XLSX, PPTX, HTML, HTM, CSV, XML, JPG, JPEG, PNG, GIF, WebP, BMP, TIFF, TIF

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

Paste the copied config into your project's `.mcp.json` or global MCP config.

### 3. Start the App

Launch MarkUpsideDown. The app automatically starts the HTTP bridge and writes the port to `~/.markupsidedown-bridge-port`.

### 4. Use with the Agent

- **Editor tools** (`get_editor_content`, `set_editor_content`, etc.) require the app to be running
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
