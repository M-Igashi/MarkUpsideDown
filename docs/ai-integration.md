# AI Integration Guide

MarkUpsideDown connects to AI agents (Claude Desktop, Claude Code, Cowork) via MCP, letting them read/write your editor, convert documents, crawl websites, and manage files — all through natural language.

## What You Can Do

- **"Convert this PDF to Markdown"** — PDF, DOCX, XLSX, images, and more
- **"Fetch this URL as Markdown"** — static pages or JS-rendered SPAs
- **"Crawl this documentation site"** — save an entire site as organized `.md` files
- **"Edit the document in the editor"** — read, write, insert, normalize
- **"Stage and commit these changes"** — full git operations through the editor

## Quick Start

### 1. Deploy the Cloudflare Worker

Open **Settings** in the app → click **Setup with Cloudflare**. This automatically deploys a Worker to your account. See [Worker Deployment Guide](worker-deployment.md) for details or manual setup.

> **No Worker?** You can still use editor, file, and git tools — the Worker is only needed for document conversion, rendered fetch, and crawl.

### 2. Copy the MCP Config

In **Settings → AI Agent Integration**, click **Copy to clipboard**. The config JSON includes your MCP binary path and Worker URL.

### 3. Connect Your AI Agent

Choose one:

| Agent | Setup |
|-------|-------|
| **Cowork** (easiest) | Click **Create workspace** in the Cowork tab — opens a ready-to-use folder with `.mcp.json` and `CLAUDE.md` |
| **Claude Desktop — Code tab** | Paste config into `~/.claude/settings.json` (global) or `.mcp.json` (per-project) |
| **Claude Code — Terminal** | Paste config into `.mcp.json` or `~/.claude/settings.json` |
| **Claude Desktop — Chat** | Paste config into `~/Library/Application Support/Claude/claude_desktop_config.json` |

That's it. Start asking your agent to work with Markdown.

## How It Works

```
AI Agent (Claude Desktop, Claude Code, Cowork)
    ↕ stdio (JSON-RPC)
MCP Server (Rust binary, bundled in .app)
    ↕ HTTP (localhost:31415)
MarkUpsideDown App ←→ Editor (CodeMirror)
```

- **Editor/file/git tools** need the app running (communicate via local HTTP bridge)
- **Conversion/crawl tools** call the Worker directly — app not required for starting and polling crawls, but saving results to disk needs the app (see [Standalone Mode](mcp-server.md#standalone-mode-no-app-required))
- File changes by Claude Code are **auto-detected** by MarkUpsideDown's file-watcher — no manual reload

## Recommended Workflow

The best experience is **Claude Code** (via Desktop Code tab or terminal) + **MarkUpsideDown running side by side**:

1. Open your project in MarkUpsideDown
2. Connect Claude Code with the MCP config
3. Claude reads/writes your editor, manages files, runs git — all through MCP
4. Edits appear in real-time via file-watcher

This replaces the need for a built-in chat panel.

## Further Reading

- [Worker Deployment Guide](worker-deployment.md) — deploy and configure the Cloudflare Worker
- [MCP Server Reference](mcp-server.md) — all 50 tools, standalone mode, troubleshooting
