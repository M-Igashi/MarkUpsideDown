# Worker Deployment Guide

> For a high-level overview of AI integration, see the [AI Integration Guide](ai-integration.md).

MarkUpsideDown uses a Cloudflare Worker for four features:

1. **Document Import** — Convert PDF, Office docs, images, etc. to Markdown via [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/)
2. **Rendered Fetch** — Fetch JavaScript-rendered pages as Markdown via [Browser Run](https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/)
3. **Structured Extraction** — Extract structured JSON data from web pages using AI (Browser Run + Workers AI LLM)
4. **Website Crawl** — Crawl an entire website and save all pages as Markdown files via [Browser Run `/crawl` API](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/)

Rendered Fetch and Structured Extraction use the Worker's `browser` binding, so they need no API token and work right after deploy. Only Website Crawl needs the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets, because Browser Run offers `/crawl` through the REST API only.

The Worker also powers publishing to R2 and semantic search via [AI Search](https://developers.cloudflare.com/ai-search/). Each user deploys their own Worker instance.

## Automatic Setup (Recommended)

On first launch, MarkUpsideDown opens the Settings panel with a **Setup with Cloudflare** button. This automates the entire process:

1. Checks that `wrangler` is installed globally
2. Runs `wrangler login` (opens browser for Cloudflare OAuth)
3. **Creates the R2 bucket** for publishing. It is optional: if it fails, the Worker deploys without the R2 binding and only publishing is unavailable. No other resources need setup, since the AI Search instance for semantic search is created on first use
4. Deploys the Worker with a **randomized URL** (e.g. `markupsidedown-a3f8k2xp7m9qb.example.workers.dev`) to prevent third-party URL guessing
5. Sets a random **API key** as the `API_KEY` Worker secret and saves it in the app. Every endpoint except `GET /health` and `GET /p/:key` requires it
6. **(Optional)** Asks for an API token and stores it, with your account ID, as the Website Crawl secrets. Create the token in the dashboard with **Account > Browser Run > Edit** and **Account > Workers AI > Read** (wrangler's OAuth login cannot create API tokens)
7. Verifies the deployment

After step 5, Document Import, Rendered Fetch, Structured Extraction, and semantic search are ready to use. Step 6 (secrets) is only needed for Website Crawl. If you skip it, you can add the secrets later via `wrangler secret put`.

If you have multiple Cloudflare accounts, you'll be prompted to select one.

**Prerequisites:** `npm install -g wrangler`

## Manual Setup

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works for document import)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI installed globally

### API Token

Create a single API token that covers deployment and website crawl:

1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token**
2. Use the **"Edit Cloudflare Workers"** template → **Use template**
3. Add these additional permissions:
   - `Account` → `Workers AI` → `Read`
   - `Account` → `Browser Run` → `Edit` (formerly named `Browser Rendering`)
4. Account Resources: select your account
5. Create the token and save it

| Scope | Permission | Purpose |
|-------|-----------|---------|
| Account > Workers Scripts | Edit | `wrangler deploy` |
| Account > Workers AI | Read | `AI.toMarkdown()` (document import) |
| Account > Browser Run | Edit | `/crawl` endpoint (Website Crawl) |

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

The secrets are required only for the `/crawl` endpoint (Website Crawl). If you don't crawl websites, you can skip this — `/render` and `/json` use the `browser` binding, and `/convert` uses the AI binding directly.

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

The Render pipeline uses Browser Run's `markdown` Quick Action, which loads the page in a headless browser (skipping images, media, fonts, and stylesheets) and returns Markdown. Results are cached by Browser Run for 1 hour; `GET /render?url=...&nocache=1` bypasses the cache.

The Crawl feature uses the Browser Run `/crawl` REST API to discover and convert pages starting from a URL. Results are saved as organized `.md` files under a local directory (e.g. `domain/path.md`).

## Pricing

### Browser Run

| Plan | Browser Time | Rate Limit | Cost |
|------|-------------|------------|------|
| **Free** | 10 min/day | 6 req/min | Free |
| **Paid** | 10 hrs/month | 30 req/s | $5/month |

The free tier is sufficient for occasional use. Render responses are cached by Browser Run for 1 hour, so repeated renders of the same URL do not use browser time. Crawl with `render: true` (default) is billed as Browser Run hours; `render: false` runs on Workers and is free during the beta. The Workers Free plan also limits crawls to 5 per day and 100 pages per crawl. The app defaults to a 50-page limit to prevent accidental cost overrun. See [Browser Run Pricing](https://developers.cloudflare.com/browser-run/pricing/) and [Browser Run Limits](https://developers.cloudflare.com/browser-run/limits/).

### Document Import

| Format | Cost |
|--------|------|
| PDF, DOCX, XLSX, HTML, CSV, XML | **Free** (no AI Neurons) |
| Images (JPG, PNG, WebP, SVG, GIF, BMP) | **AI Neurons** (OCR) |

The app shows a confirmation dialog before processing images.

## Supported Import Formats

| Category | Extensions |
|----------|-----------|
| Documents | `.pdf`, `.docx`, `.xlsx` |
| Web/data | `.html`, `.htm`, `.csv`, `.xml` |
| Images | `.jpg`, `.jpeg`, `.png`, `.webp`, `.svg`, `.gif`, `.bmp` |

## Troubleshooting

### Authentication error on deploy

Ensure `CLOUDFLARE_API_TOKEN` is set and the token has `Workers Scripts: Edit` permission. See [API Token](#api-token).

### "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for crawling"

Set the secrets as described in [Set Worker Secrets](#set-worker-secrets). They are only required for Website Crawl.

### "Browser Run binding is missing on this Worker" or "AI Search binding is missing on this Worker"

The deployed Worker predates v13. Click **Update Worker** in Settings.

### Browser Run API errors

- **403** (crawl only): Check that your API token has `Browser Run - Edit` permission
- **429**: Rate limit exceeded (free tier: 6 req/min)
- **Timeout**: Complex pages may take longer; try standard fetch instead

### "Unauthorized: missing API key" or "invalid API key"

The Worker requires the API key on every endpoint except `GET /health` and `GET /p/:key`. Paste the key into Settings, or click **Update Worker** to set a new one. For the MCP server in standalone mode, set `MARKUPSIDEDOWN_WORKER_KEY` in the MCP config (re-copy the config from Settings).

### "API_KEY secret is not set on this Worker"

The Worker code is v12 or later but the secret was never set (for example, after a manual deploy). Click **Update Worker** in Settings, or run `wrangler secret put API_KEY` as described in [Set the API Key](#set-the-api-key).

### Auto-setup fails at "Configure secrets"

If the app can't auto-detect your API token, it will prompt you to paste one manually. Create a token with the permissions listed in [API Token](#api-token).

If you skip this step, the Worker is still deployed and every feature except Website Crawl works.

### Updating the Worker

The app shows an **"Update available"** badge in Settings when your deployed Worker is older than the version bundled with the app. Click the **Update Worker** button to re-deploy with the latest code.

The URL stays the same. Secrets and resource bindings persist across deploys. Updating also sets the API key (reusing the saved one), so Workers deployed before v12 become protected after one update. The feature list refreshes automatically after update.

**When to update:** After installing a new version of MarkUpsideDown, check Settings → Worker Status. If it shows "Update available", click Update Worker. New MCP tools (e.g., `extract_json`) may require Worker endpoints that don't exist in older versions.

### Worker version

The Worker exposes its version via `GET /health`:

```json
{ "status": "ok", "version": 13, "auth": "valid", "capabilities": { "fetch": true, "convert": true, "render": true, "json": true, "crawl": true, "publish": true, "search": true } }
```

`auth` reports the API key check for the request: `valid`, `invalid`, `missing` (no `Authorization` header), or `unconfigured` (the `API_KEY` secret is not set).

The `capabilities` object shows which features are available:
- `render`, `json` — require the Browser Run `browser` binding (Worker v13+)
- `crawl` — requires Worker secrets (`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`)
- `publish` — requires R2 bucket binding
- `search` — requires the AI Search `ai_search_namespaces` binding (Worker v13+)

If `publish` shows `false`, the R2 bucket was not created during setup. Re-run setup or create the bucket manually. If `render`, `json`, or `search` shows `false`, click **Update Worker**.

### Removing resources from older setups

Worker v13 no longer uses Workers KV, Queues, or Vectorize: render results are cached by Browser Run, batch conversion runs in the app, and semantic search moved to AI Search. Documents indexed in the old Vectorize index are not migrated; they are indexed again the next time they are converted or crawled. If an older setup created these resources, you can delete them:

```bash
wrangler vectorize delete markupsidedown-docs
wrangler queues delete markupsidedown-convert
wrangler kv namespace list      # find the namespace created for the Worker's CACHE binding
wrangler kv namespace delete --namespace-id <id>
```

### CORS

The Worker includes permissive CORS headers (`*`). To restrict origins, edit `CORS_HEADERS` in `worker/src/index.ts`.
