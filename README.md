# MarkUpsideDown

AI-era Markdown editor built with Rust (Tauri v2) and CodeMirror 6.

## Features

- **Live Preview** — Split-pane editor with real-time Markdown rendering
- **CodeMirror 6** — Syntax highlighting, vim keybindings, IME support, code folding
- **Cloudflare Markdown for Agents** — Fetch any URL as clean Markdown using `Accept: text/markdown`
- **Browser Rendering** — Fetch JavaScript-rendered pages (SPAs, dynamic sites) as Markdown via Cloudflare Browser Rendering API
- **Document Import** — Convert PDF, Office, CSV, XML, and images to Markdown via Workers AI
- **Drag & Drop** — Drop files onto the editor to import or open them
- **GitHub Integration** — Read/write Issues, PRs, and Wikis via `gh` CLI
- **Dark theme** — Catppuccin-inspired design

## Requirements

- Rust 1.85+
- Node.js 18+
- [gh CLI](https://cli.github.com/) (optional, for GitHub integration)

## Getting Started

```bash
cd ui && npm install && cd ..
cargo tauri dev
```

## Document Import (Optional)

The Import feature converts documents to Markdown using a Cloudflare Worker powered by [`AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/).

**Quick setup:**

```bash
wrangler login
cd worker && npm install && wrangler deploy
```

Then click **Settings** in the app toolbar and paste your Worker URL.

See [docs/worker-deployment.md](docs/worker-deployment.md) for full setup guide, supported formats, and cost details.

## Architecture

```
src-tauri/           # Rust backend (Tauri v2)
├── src/
│   ├── main.rs      # App entry point
│   └── commands.rs  # IPC commands (URL fetch, file conversion, GitHub)
├── Cargo.toml
└── tauri.conf.json

ui/                  # Frontend (Vite + CodeMirror 6)
├── src/
│   ├── main.js      # Editor, preview, toolbar, drag & drop
│   ├── theme.js     # Dark theme (Catppuccin-inspired)
│   └── styles.css   # Layout and styling
├── index.html
└── package.json

worker/              # Cloudflare Worker (document conversion + rendered fetch)
├── src/
│   └── index.ts     # /convert and /render endpoints
├── wrangler.jsonc
└── package.json

docs/                # Documentation
├── architecture.md
└── worker-deployment.md
```

See [docs/architecture.md](docs/architecture.md) for detailed architecture documentation.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
