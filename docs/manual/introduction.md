# Introduction

MarkUpsideDown is a Markdown editor that turns any markup into Markdown — websites, PDFs, Office documents, and images. Everything ships in a single ~15 MB desktop app: live preview, file browser, Git integration, website crawling, document import, and AI agent integration. No plugins or extensions needed.

![Main window layout with editor, preview, and sidebar](images/introduction/main-layout.png)

## Who Is This For?

- **Writers** who want a distraction-free Markdown editor with live preview
- **Developers** who need a Git-aware editor for documentation
- **Researchers** who collect web content and convert documents to Markdown
- **Anyone** who works with AI agents and wants to give them full access to their editor via MCP

## Key Features

### Convert Anything to Markdown

Fetch web pages, render JavaScript-heavy sites, crawl entire websites, and import documents (PDF, DOCX, XLSX, HTML, CSV, XML) and images — all converted to clean Markdown through Cloudflare Workers AI.

### Full-Featured Editor

Built on CodeMirror 6 with syntax highlighting, multi-tab editing, a command palette (Cmd+K), formatting shortcuts, live preview with Mermaid diagrams, KaTeX math, and code highlighting. A split-pane layout with bidirectional scroll sync lets you write and preview side by side.

### File Browser & Git

A built-in sidebar with file tree, search, sorting, and file tagging. The Git panel lets you stage, commit, push, and pull without leaving the app.

### AI Agent Integration

A bundled MCP server exposes 62 tools to AI agents like Claude Desktop and Claude Code. Agents can read/write your editor, manage files, convert documents, crawl websites, and run Git operations — all through natural language.

### Publishing & Search

Publish Markdown files to Cloudflare R2 with shareable links. Index documents for semantic search and find content by meaning, not just keywords.

## Requirements

- **macOS** on Apple Silicon (M1/M2/M3/M4)

## How This Manual Is Organized

| Chapter | What You'll Learn |
|---------|-------------------|
| [Installation & Setup](installation.md) | Download, install, and configure the Cloudflare Worker |
| [Editor Basics](editor-basics.md) | Toolbar, shortcuts, command palette |
| [Live Preview](preview.md) | Preview pane, Mermaid, KaTeX, scroll sync |
| [File Management](file-management.md) | Sidebar, tabs, file operations |
| [Importing Content](importing-content.md) | URL fetch, file import, batch conversion |
| [Crawling Websites](crawling-websites.md) | Crawl settings, progress, results |
| [Advanced Editing](editing-features.md) | Table editor, image paste, smart typography, and more |
| [Git Integration](git-integration.md) | Stage, commit, push, pull, clone |
| [Tags & Organization](tags.md) | File tagging and filtering |
| [Publishing](publishing.md) | Publish to R2, share links |
| [Semantic Search](search.md) | Index and search documents |
| [Presentation Mode](presentation.md) | Fullscreen slide presentations |
| [AI Agent Integration](ai-integration.md) | MCP server setup and available tools |
| [Keyboard Shortcuts](keyboard-shortcuts.md) | Complete shortcut reference |
