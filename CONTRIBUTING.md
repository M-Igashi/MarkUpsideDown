# Contributing to MarkUpsideDown

Thank you for your interest in contributing! This document outlines the rules and expectations for all contributions.

## Issue-First Policy

**Every pull request MUST be linked to an existing issue.** PRs without a linked issue will be automatically closed.

1. **Before writing code**, open an issue describing the bug, feature, or improvement
2. Wait for maintainer feedback — the issue may be declined or scoped differently
3. Reference the issue in your PR using `Closes #<number>` in the PR description

This policy exists to:

- Prevent unsolicited or AI-generated drive-by PRs
- Ensure all changes are discussed and agreed upon before implementation
- Keep the project focused and maintainable

> **Note:** Typo fixes and documentation corrections under 5 lines may skip this requirement, but a PR description explaining the change is still expected.

## Security Policy for MCP Server & Tool Contributions

MarkUpsideDown includes an MCP (Model Context Protocol) server that exposes tools to AI agents. This is a sensitive surface area that requires extra care.

### MCP Tool Guidelines

- **Least privilege**: Tools must request only the minimum permissions needed
- **No arbitrary code execution**: Tools must never execute user-supplied code or shell commands
- **No unrestricted filesystem access**: File operations must be scoped to the user's working context
- **No silent network requests**: Any outbound network call must be clearly documented and user-visible
- **Input validation**: All tool inputs must be validated and sanitized before use

### What requires security review

The following changes **require explicit maintainer security review** before merge:

- Adding, modifying, or removing MCP tools (`mcp-server-rs/`)
- Changes to Tauri IPC commands (`src-tauri/src/commands.rs`)
- Changes to the MCP bridge (`src-tauri/src/bridge.rs`)
- Changes to Cloudflare Worker endpoints (`worker/src/`)
- Any new outbound network requests
- Changes to file system access patterns
- Dependency additions or major version upgrades

### Reporting security issues

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.

## Pull Request Requirements

- [ ] Linked to an issue (`Closes #<number>`)
- [ ] Code builds without errors (`cargo tauri build` or `cargo check`)
- [ ] No new lint warnings (`cd ui && npx vp check src/`)
- [ ] Changes are focused — one concern per PR
- [ ] No unrelated formatting or refactoring changes

## Development Setup

See [CLAUDE.md](CLAUDE.md) for build commands and architecture overview.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later](LICENSE) license.
