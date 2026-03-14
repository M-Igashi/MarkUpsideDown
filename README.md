# markupsidedown

AI-era Markdown editor built with Rust and egui.

## Features

- **Live Preview** — Split-pane editor with real-time Markdown rendering
- **Cloudflare Markdown for Agents** — Fetch any URL as clean Markdown using `Accept: text/markdown`
- **GitHub Integration** — Read/write Issues, PRs, and Wikis via `gh` CLI
- **Claude Code Integration** — AI-assisted editing and generation (planned)

## Requirements

- Rust 1.85+
- [gh CLI](https://cli.github.com/) (for GitHub integration)

## Getting Started

```bash
cargo run
```

## Architecture

```
src/
├── main.rs              # App entry point and top-level layout
├── editor/              # Text editor panel
├── preview/             # Live Markdown preview panel
└── integrations/
    ├── cloudflare.rs    # Markdown for Agents (Accept: text/markdown)
    └── github.rs        # GitHub via gh CLI
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact the author.
