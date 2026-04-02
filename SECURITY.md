# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

Only the latest release is supported with security updates.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use [GitHub Security Advisories](https://github.com/M-Igashi/MarkUpsideDown/security/advisories/new) to report vulnerabilities privately.

Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- Affected versions
- Any potential impact

You should receive an initial response within 7 days. Once the issue is confirmed, a fix will be released as soon as possible.

## Scope

This project is a desktop Markdown editor built with Tauri v2 with a Cloudflare Worker backend and a standalone MCP server. Areas of particular security concern include:

- **Tauri IPC**: Commands exposed between the frontend and Rust backend
- **Markdown rendering**: XSS via crafted Markdown input (DOMPurify sanitization)
- **File system access**: Reading/writing files through Tauri APIs
- **External content**: Fetching and rendering remote resources
- **Cloudflare Worker**: SSRF via `/fetch`, `/render`, `/crawl` endpoints (mitigated by DNS-over-HTTPS validation)
- **MCP server**: HTTP bridge (port 31415) exposed to localhost — tool invocations from AI agents
- **Clipboard**: Rich text paste handling

## Out of Scope

- Vulnerabilities in upstream dependencies that are not exploitable through this project
- Issues requiring physical access to the user's machine
- Denial-of-service attacks against the local desktop application
