# MCP Server Setup Guide

MarkUpsideDown exposes its editing and conversion capabilities as an MCP (Model Context Protocol) server, allowing AI agents (Claude Desktop, etc.) to use the editor as a tool.

## Architecture

```
AI Agent (Claude Desktop, etc.)
    ↕ stdio (JSON-RPC)
MCP Server (mcp-server/)
    ↕ HTTP (localhost:31415)
MarkUpsideDown App (Tauri)
    ↕ Tauri events
Editor (CodeMirror)
```

The MCP server communicates with the running MarkUpsideDown app via a local HTTP bridge. Conversion tools can also call the Cloudflare Worker directly.

## Available Tools

### Editor Tools (require the app to be running)

| Tool | Description |
|------|-------------|
| `get_editor_content` | Get current Markdown content from the editor |
| `set_editor_content` | Replace editor content with provided Markdown |
| `insert_text` | Insert text at cursor, start, or end |
| `open_file` | Open a Markdown file in the editor |
| `save_file` | Save current content to a file |
| `export_pdf` | Export current content as PDF |

### Conversion Tools (require Worker URL)

| Tool | Description |
|------|-------------|
| `fetch_markdown` | Fetch a URL as Markdown (Cloudflare Markdown for Agents) |
| `render_markdown` | Fetch a JS-rendered page as Markdown (Browser Rendering) |
| `convert_to_markdown` | Convert a document (PDF, DOCX, etc.) to Markdown |

## Setup

### 1. Build the MCP Server

```bash
cd mcp-server
npm install
npm run build
```

### 2. Configure Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "markupsidedown": {
      "command": "node",
      "args": ["/absolute/path/to/markupsidedown/mcp-server/dist/index.js"],
      "env": {
        "MARKUPSIDEDOWN_WORKER_URL": "https://markupsidedown-converter.YOUR_SUBDOMAIN.workers.dev"
      }
    }
  }
}
```

Replace the paths and Worker URL with your actual values.

### 3. Start the App

Launch MarkUpsideDown. The app automatically starts the HTTP bridge on `localhost:31415` and writes the port to `~/.markupsidedown-bridge-port`.

### 4. Use with AI Agent

Editor tools (`get_editor_content`, `set_editor_content`, etc.) require the MarkUpsideDown app to be running. Conversion tools work independently if `MARKUPSIDEDOWN_WORKER_URL` is set.

## Configuration

### Worker URL

The MCP server looks for the Worker URL in this order:
1. `MARKUPSIDEDOWN_WORKER_URL` environment variable
2. Worker URL configured in the app's Settings

### Bridge Port

The Tauri app listens on `localhost:31415` by default (falls back to 31416–31420 if in use). The active port is written to `~/.markupsidedown-bridge-port`.

## Troubleshooting

### "MarkUpsideDown app is not running"

Editor tools require the app. Make sure MarkUpsideDown is open.

### "Worker URL not configured"

Set `MARKUPSIDEDOWN_WORKER_URL` in your MCP config or configure it in the app's Settings dialog.

### Bridge port conflict

If port 31415 is in use, the app tries ports up to 31420. Check `~/.markupsidedown-bridge-port` for the actual port.
