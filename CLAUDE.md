# MarkUpsideDown - Project Guidelines

AI-era Markdown editor built with Tauri v2 + CodeMirror 6.

## Tech Stack

- **Backend**: Rust (Tauri v2) — `src-tauri/`
- **Frontend**: Vanilla JS + CodeMirror 6 + Vite — `ui/`
- **Platform**: Cloudflare (Markdown for Agents, Workers AI, future features)
- **License**: AGPL-3.0-or-later (dual-licensing model planned)

## Development

```bash
# Dev mode (hot-reload)
cargo tauri dev

# Build production
cargo tauri build

# Frontend only
cd ui && npm run dev

# Rust check
cargo check
```

## Architecture

| Layer | Tech | Location |
|-------|------|----------|
| Desktop shell | Tauri v2 (WebKit on macOS) | `src-tauri/` |
| Editor | CodeMirror 6 | `ui/src/main.js` |
| Preview | marked.js (Markdown → HTML) | `ui/src/main.js` |
| Theme | Custom dark theme (Catppuccin-inspired) | `ui/src/theme.js` |
| Backend commands | Rust (Tauri IPC) | `src-tauri/src/commands.rs` |

## Key Conventions

- Tauri commands go in `src-tauri/src/commands.rs`
- Frontend communicates with backend via `invoke()` from `@tauri-apps/api`
- Use `window.__TAURI__` global (enabled via `withGlobalTauri: true`)
- No wrangler as project dependency — use globally installed version
- Avoid Cloudflare Pages (EoL announced) — use Workers instead

## Cloudflare Integration

- **Markdown for Agents**: `Accept: text/markdown` header for URL fetching
- **Workers AI**: `AI.toMarkdown()` for document-to-Markdown conversion — `worker/`
- Refer to Cloudflare docs via the `cloudflare` skill when implementing new features

## Worker Deployment

The `worker/` directory contains a Cloudflare Worker for document conversion.

```bash
# First time setup
wrangler login
cd worker && npm install

# Deploy
wrangler deploy

# After deploying, update WORKER_URL in ui/src/main.js
```

## Skills to Use

When working on this project, prefer these skills:
- `/cloudflare` — General Cloudflare platform guidance
- `/wrangler` — CLI commands for Workers, KV, D1, etc.
- `/workers-best-practices` — Code review for Workers
- `/build-fix` — Fix build and type errors incrementally
- `/code-review` — Review code quality and security
