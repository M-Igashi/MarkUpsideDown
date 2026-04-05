# AI Agent Integration

MarkUpsideDown connects to AI agents like Claude Desktop, Claude Code, and Cowork through MCP (Model Context Protocol). This lets AI agents read and write your editor, manage files, convert documents, crawl websites, and run Git operations — all through natural language.

## How It Works

```
AI Agent (Claude Desktop, Claude Code, Cowork)
    ↕ stdio (JSON-RPC)
MCP Server (Rust binary, bundled in .app)
    ↕ HTTP (localhost:31415)
MarkUpsideDown App ←→ Editor (CodeMirror)
```

The MCP server is a standalone Rust binary bundled with the app. It communicates with AI agents via stdio and with the app via a local HTTP bridge.

## Setup

### 1. Deploy the Cloudflare Worker

If you haven't already, set up the Cloudflare Worker (see [Installation & Setup](installation.md)). The Worker is needed for document conversion, rendered fetch, and crawl features.

> **No Worker?** Editor, file, and Git tools work without a Worker.

### 2. Copy the MCP Config

Open **Settings → AI Agent Integration**.

![Settings AI Agent Integration panel](images/ai-integration/settings-mcp.png)

The section shows:
- **Bridge status** — whether the local HTTP bridge is running
- **Binary path** — location of the MCP server binary
- **Config tabs** — configuration JSON for each agent type

![Settings tabs for each agent type](images/ai-integration/settings-mcp-tabs.png)

Select the tab for your agent and click **Copy to clipboard**:

| Tab | Agent | Where to paste |
|-----|-------|---------------|
| **Chat** | Claude Desktop (Chat) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Code** (Recommended) | Claude Desktop (Code tab) or Claude Code | `~/.claude/settings.json` or `.mcp.json` in your project |
| **Terminal** | Claude Code (terminal) | `~/.claude/settings.json` or `.mcp.json` |
| **Cowork** | Cowork | Click "Create workspace" to auto-generate `.mcp.json` and `CLAUDE.md` |

### 3. Start Using It

Once connected, ask your AI agent to work with your Markdown. Examples:

- *"Convert this PDF to Markdown"*
- *"Fetch this URL as Markdown"*
- *"Crawl this documentation site"*
- *"Edit the document in the editor"*
- *"Stage and commit these changes"*

## Available Tools

The MCP server exposes **62 tools** organized by category:

| Category | Examples |
|----------|---------|
| **Editor** | Read/write editor content, get selection, insert text, normalize |
| **Content** | Fetch URL, render page, convert file, crawl website |
| **File operations** | Read, write, list, create, rename, delete files |
| **Project context** | List project files, get file tree, search files |
| **Git** | Status, stage, unstage, commit, push, pull, fetch, diff, log |
| **Tags** | List tags, get/set file tags |
| **Search** | Index documents, semantic search, remove from index |
| **Publish** | Publish/unpublish files, list published |
| **Batch** | Batch import/convert files |
| **Windows** | List windows, get/set active window |
| **Markdown lint** | Validate document structure |

The full tool list is visible in Settings → AI Agent Integration (expand the tools section).

![Available tools list expanded](images/ai-integration/settings-mcp-tools.png)

## Bridge Details

- **Port**: 31415 (fallback: 31416–31420)
- **Port file**: `~/.markupsidedown-bridge-port` — agents read this to find the active port
- The bridge runs as long as the app is open

## Recommended Workflow

The best experience is **Claude Code + MarkUpsideDown side by side**:

1. Open your project folder in MarkUpsideDown
2. Connect Claude Code with the MCP config
3. Claude reads/writes your editor, manages files, runs Git — all through MCP
4. Edits made by Claude appear in real-time via the file watcher

This gives you a visual Markdown editor paired with an AI assistant that can operate it directly.

## Standalone Mode

Some MCP tools work without the app running:

- **Conversion tools** (fetch, render, convert) call the Cloudflare Worker directly
- **Crawl tools** can start and poll crawls via the Worker

However, saving results to disk and all editor/file/Git operations require the app to be running.

## Troubleshooting

- **"Bridge not running"** — Make sure MarkUpsideDown is open. The bridge starts automatically with the app.
- **MCP server not found** — Verify the binary path in Settings. It should point to the `markupsidedown-mcp` binary inside the `.app` bundle.
- **After rebuilding** — If you build from source, restart your IDE/agent session to pick up the new binary.
