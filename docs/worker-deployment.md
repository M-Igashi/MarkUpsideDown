# Worker Deployment Guide

> For a high-level overview of AI integration, see the [AI Integration Guide](ai-integration.md).

MarkUpsideDown uses a Cloudflare Worker for four features:

1. **Document Import** — Convert PDF, Office docs, images, etc. to Markdown via [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/)
2. **Rendered Fetch** — Fetch JavaScript-rendered pages as Markdown via [Browser Rendering](https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/)
3. **Structured Extraction** — Extract structured JSON data from web pages using AI (Browser Rendering + Workers AI LLM)
4. **Website Crawl** — Crawl an entire website and save all pages as Markdown files via [Browser Rendering `/crawl` API](https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/)

Each user deploys their own Worker instance.

## Automatic Setup (Recommended)

On first launch, MarkUpsideDown opens the Settings panel with a **Setup with Cloudflare** button. This automates the entire process:

1. Checks that `wrangler` is installed globally
2. Runs `wrangler login` (opens browser for Cloudflare OAuth)
3. **Creates Cloudflare resources** — KV namespace (cache), R2 bucket (publish), Queue (batch conversion), Vectorize index (semantic search). Each is optional and created in parallel; failures are non-fatal
4. Deploys the Worker with a **randomized URL** (e.g. `markupsidedown-a3f8k2xp7m9qb.example.workers.dev`) to prevent third-party URL guessing
5. Sets a random **API key** as the `API_KEY` Worker secret and saves it in the app. Every endpoint except `GET /health` and `GET /p/:key` requires it
6. **(Optional)** Configures secrets for Render JS via OAuth — creates a scoped API token automatically
7. Verifies the deployment

After step 5, Document Import is ready to use. Step 6 (secrets) is only needed for Render JS (fetching JavaScript-rendered pages). If OAuth token creation fails, you can add secrets later via `wrangler secret put`.

Resources created in step 3 enable additional features (see [Feature Status](#feature-status)). If a resource fails to create, the Worker still deploys without that binding — features degrade gracefully.

If you have multiple Cloudflare accounts, you'll be prompted to select one.

**Prerequisites:** `npm install -g wrangler`

## Manual Setup

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works for document import)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI installed globally

### API Token

Create a single API token that covers deployment, document import, and rendered fetch:

1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token**
2. Use the **"Edit Cloudflare Workers"** template → **Use template**
3. Add these additional permissions:
   - `Account` → `Workers AI` → `Read`
   - `Account` → `Browser Rendering` → `Edit`
4. Account Resources: select your account
5. Create the token and save it

| Scope | Permission | Purpose |
|-------|-----------|---------|
| Account > Workers Scripts | Edit | `wrangler deploy` |
| Account > Workers AI | Read | `AI.toMarkdown()` (document import) |
| Account > Browser Rendering | Edit | `/render` and `/crawl` endpoints |

### Deploy

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
cd worker && wrangler deploy
```

### Set the API Key

The Worker rejects every request except `GET /health` and `GET /p/:key` (published documents) unless it carries `Authorization: Bearer <API_KEY>`. Generate a random key and store it as a secret:

```bash
cd worker
openssl rand -hex 32          # copy the output
wrangler secret put API_KEY   # paste it
```

Until `API_KEY` is set, protected endpoints return `500` with an error explaining how to set it.

### Set Worker Secrets

The secrets are required for the `/render` and `/crawl` endpoints (Rendered Fetch and Website Crawl). If you only need Document Import, you can skip this — `/convert` uses the AI binding directly.

Get your **Account ID** from [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → right sidebar.

```bash
cd worker
wrangler secret put CLOUDFLARE_ACCOUNT_ID   # paste your Account ID
wrangler secret put CLOUDFLARE_API_TOKEN    # paste the same API token
```

### R2 Public Access for Published URLs (Optional)

By default, published URLs contain the Worker subdomain. To hide the Worker URL, enable **R2 public access** on the publish bucket:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → R2 Object Storage → **markupsidedown-publish** → Settings → **Public Development URL** → Enable
2. Copy the generated public URL (e.g. `https://pub-abc123.r2.dev`)
3. Set the URL on your Worker — choose one:
   - **In-app:** After setup completes, paste the R2 public URL in the input field shown in the Settings tip and click **Save**
   - **CLI:** `wrangler secret put R2_PUBLIC_URL --name markupsidedown-XXXXXX` (paste the URL when prompted)

Published URLs will now use the R2 public URL (e.g. `https://pub-abc123.r2.dev/my-document`) instead of the Worker URL. The `GET /p/:key` endpoint is kept as a fallback.

> **Note:** R2 public access serves objects directly, without going through the Worker. A Cron Trigger on the Worker deletes expired documents every 15 minutes, so a time-limited file can stay reachable via the R2 URL for up to 15 minutes after it expires. The Worker's `GET /p/:key` endpoint enforces expiration immediately. The cron is only deployed when the R2 bucket exists, and it counts toward your account's Cron Trigger limit (5 on the Workers Free plan).

### Configure the App

1. Open Settings in the toolbar (or wait for the first-launch prompt)
2. Paste your Worker URL (e.g. `https://markupsidedown-XXXXXX.example.workers.dev`)
3. Paste the API key you set with `wrangler secret put API_KEY`
4. Click **Test** to verify the connection
5. Check **Feature Status** to see which capabilities are ready
6. Click **Save**

The URL and API key are saved in localStorage and persist across sessions.

## When to Use Each Feature

| Scenario | Use |
|----------|-----|
| Static pages, blogs, docs | **Fetch** (fast, free) |
| SPAs (React, Vue, Angular) | **Render** |
| Pages behind JS-based loading | **Render** |
| Dynamic dashboards | **Render** |
| Entire documentation site | **Crawl** |
| Blog or wiki archival | **Crawl** |
| Building a local Markdown corpus for AI/RAG | **Crawl** |

The Render pipeline strips boilerplate (nav, header, footer, cookie banners, ads) using HTMLRewriter before converting to Markdown, producing cleaner output than raw HTML conversion.

The Crawl feature uses the Browser Rendering `/crawl` REST API to discover and convert pages starting from a URL. Results are saved as organized `.md` files under a local directory (e.g. `domain/path.md`).

## Pricing

### Browser Rendering

| Plan | Browser Time | Rate Limit | Cost |
|------|-------------|------------|------|
| **Free** | 10 min/day | 6 req/min | Free |
| **Paid** | 10 hrs/month | 600 req/min | $5/month |

The free tier is sufficient for occasional use. Render responses are cached for 1 hour. Crawl with `render: true` (default) is billed as Browser Rendering hours; `render: false` runs on Workers and is free during beta. The app defaults to a 50-page limit to prevent accidental cost overrun. See [Browser Rendering Pricing](https://developers.cloudflare.com/browser-rendering/pricing/).

### Document Import

| Format | Cost |
|--------|------|
| PDF, DOCX, XLSX, HTML, CSV, XML | **Free** (no AI Neurons) |
| Images (JPG, PNG, WebP, SVG) | **AI Neurons** (OCR) |

The app shows a confirmation dialog before processing images.

## Supported Import Formats

| Category | Extensions |
|----------|-----------|
| Documents | `.pdf`, `.docx`, `.xlsx` |
| Web/data | `.html`, `.htm`, `.csv`, `.xml` |
| Images | `.jpg`, `.jpeg`, `.png`, `.webp`, `.svg` |

## Troubleshooting

### Authentication error on deploy

Ensure `CLOUDFLARE_API_TOKEN` is set and the token has `Workers Scripts: Edit` permission. See [API Token](#api-token).

### "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required"

Set the secrets as described in [Set Worker Secrets](#set-worker-secrets). This is required for Render and Crawl features.

### Browser Rendering API errors

- **403**: Check that your API token has `Browser Rendering - Edit` permission
- **429**: Rate limit exceeded (free tier: 6 req/min)
- **Timeout**: Complex pages may take longer; try standard fetch instead

### "Unauthorized: missing API key" or "invalid API key"

The Worker requires the API key on every endpoint except `GET /health` and `GET /p/:key`. Paste the key into Settings, or click **Update Worker** to set a new one. For the MCP server in standalone mode, set `MARKUPSIDEDOWN_WORKER_KEY` in the MCP config (re-copy the config from Settings).

### "API_KEY secret is not set on this Worker"

The Worker code is v12 or later but the secret was never set (for example, after a manual deploy). Click **Update Worker** in Settings, or run `wrangler secret put API_KEY` as described in [Set the API Key](#set-the-api-key).

### Auto-setup fails at "Configure secrets"

If the app can't auto-detect your API token, it will prompt you to paste one manually. Create a token with the permissions listed in [API Token](#api-token).

If you skip this step, the Worker is still deployed and Document Import works — only Render and Crawl require the secrets.

### Updating the Worker

The app shows an **"Update available"** badge in Settings when your deployed Worker is older than the version bundled with the app. Click the **Update Worker** button to re-deploy with the latest code.

The URL stays the same. Secrets and resource bindings persist across deploys. Updating also sets the API key (reusing the saved one), so Workers deployed before v12 become protected after one update. The feature list refreshes automatically after update.

**When to update:** After installing a new version of MarkUpsideDown, check Settings → Worker Status. If it shows "Update available", click Update Worker. New MCP tools (e.g., `extract_json`) may require Worker endpoints that don't exist in older versions.

### Worker version

The Worker exposes its version via `GET /health`:

```json
{ "status": "ok", "version": 12, "auth": "valid", "capabilities": { "fetch": true, "convert": true, "render": true, "json": true, "crawl": true, "cache": true, "batch": true, "publish": true, "search": true } }
```

`auth` reports the API key check for the request: `valid`, `invalid`, `missing` (no `Authorization` header), or `unconfigured` (the `API_KEY` secret is not set).

The `capabilities` object shows which features are available:
- `render`, `json`, `crawl` — require Worker secrets (`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`)
- `cache` — requires KV namespace binding
- `batch` — requires Queue + KV bindings
- `publish` — requires R2 bucket binding
- `search` — requires Vectorize index binding

If capabilities show `false`, the corresponding resource was not created during setup. Re-run setup or create resources manually.

### CORS

The Worker includes permissive CORS headers (`*`). To restrict origins, edit `CORS_HEADERS` in `worker/src/index.ts`.
