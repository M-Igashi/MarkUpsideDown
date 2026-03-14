# MarkUpsideDown

AI-era Markdown editor built with Rust (Tauri v2) and CodeMirror 6.

## Features

- **Live Preview** — Split-pane editor with real-time Markdown rendering
- **CodeMirror 6** — Syntax highlighting, vim keybindings, IME support, code folding
- **Cloudflare Markdown for Agents** — Fetch any URL as clean Markdown using `Accept: text/markdown`
- **GitHub Integration** — Read/write Issues, PRs, and Wikis via `gh` CLI
- **Document Import** — Convert PDF, Office, CSV, XML, and images to Markdown via Workers AI
- **Drag & Drop** — Drop files onto the editor to import or open them
- **Claude Code Integration** — AI-assisted editing and generation (planned)
- **Dark theme** — Catppuccin-inspired design

## Requirements

- Rust 1.85+
- Node.js 18+
- [gh CLI](https://cli.github.com/) (for GitHub integration)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) (for Worker deployment)

## Getting Started

```bash
cd ui && npm install && cd ..
cargo tauri dev
```

## Worker Deployment (Document Import)

The document import feature requires a Cloudflare Worker running `AI.toMarkdown()`.

```bash
wrangler login
cd worker && npm install
wrangler deploy
```

After deploying, update `WORKER_URL` in `ui/src/main.js` with your Worker URL.

## Architecture

```
src-tauri/
├── src/
│   ├── main.rs        # Tauri app entry point
│   └── commands.rs    # Backend commands (Cloudflare, GitHub)
├── Cargo.toml
└── tauri.conf.json

ui/
├── src/
│   ├── main.js        # CodeMirror 6 editor + preview + Tauri IPC
│   ├── theme.js       # Dark theme (Catppuccin-inspired)
│   └── styles.css     # Layout and preview styles
├── index.html
└── package.json

worker/
├── src/
│   └── index.ts       # AI.toMarkdown() conversion endpoint
├── wrangler.jsonc
└── package.json
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
