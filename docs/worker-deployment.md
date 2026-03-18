# Worker Deployment Guide

MarkUpsideDown uses a Cloudflare Worker for three features:

1. **Document Import** — Convert PDF, Office docs, images, etc. to Markdown via [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/)
2. **Rendered Fetch** — Fetch JavaScript-rendered pages as Markdown via [Browser Rendering](https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/)
3. **Website Crawl** — Crawl an entire website and save all pages as Markdown files via [Browser Rendering `/crawl` API](https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/)

Each user deploys their own Worker instance.

## Automatic Setup (Recommended)

On first launch, MarkUpsideDown opens the Settings panel with a **Setup with Cloudflare** button. This automates the entire process:

1. Checks that `wrangler` is installed globally
2. Runs `wrangler login` (opens browser for Cloudflare OAuth)
3. Deploys the Worker to your account
4. **(Optional)** Configures secrets for Render JS — you can skip this step
5. Verifies the deployment

After step 3, Document Import is ready to use. Step 4 (secrets) is only needed for Render JS (fetching JavaScript-rendered pages). If the auto-token detection fails, you'll be asked to paste an API token or skip. You can always add secrets later.

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

### Set Worker Secrets

The secrets are required for the `/render` and `/crawl` endpoints (Rendered Fetch and Website Crawl). If you only need Document Import, you can skip this — `/convert` uses the AI binding directly.

Get your **Account ID** from [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → right sidebar.

```bash
cd worker
wrangler secret put CLOUDFLARE_ACCOUNT_ID   # paste your Account ID
wrangler secret put CLOUDFLARE_API_TOKEN    # paste the same API token
```

### Configure the App

1. Open Settings in the toolbar (or wait for the first-launch prompt)
2. Paste your Worker URL (e.g. `https://markupsidedown-converter.example.workers.dev`)
3. Click **Test** to verify the connection
4. Check **Feature Status** to see which capabilities are ready
5. Click **Save**

The URL is saved in localStorage and persists across sessions.

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
| PDF, DOCX, XLSX, PPTX, HTML, CSV, XML | **Free** (no AI Neurons) |
| Images (JPG, PNG, GIF, WebP, BMP, TIFF) | **AI Neurons** (OCR) |

The app shows a confirmation dialog before processing images.

## Supported Import Formats

| Category | Extensions |
|----------|-----------|
| Documents | `.pdf`, `.docx`, `.xlsx`, `.pptx` |
| Web/data | `.html`, `.htm`, `.csv`, `.xml` |
| Images | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.tif` |

## Troubleshooting

### Authentication error on deploy

Ensure `CLOUDFLARE_API_TOKEN` is set and the token has `Workers Scripts: Edit` permission. See [API Token](#api-token).

### "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required"

Set the secrets as described in [Set Worker Secrets](#set-worker-secrets). This is required for Render and Crawl features.

### Browser Rendering API errors

- **403**: Check that your API token has `Browser Rendering - Edit` permission
- **429**: Rate limit exceeded (free tier: 6 req/min)
- **Timeout**: Complex pages may take longer; try standard fetch instead

### Auto-setup fails at "Configure secrets"

If the app can't auto-detect your API token, it will prompt you to paste one manually. Create a token with the permissions listed in [API Token](#api-token).

If you skip this step, the Worker is still deployed and Document Import works — only Render and Crawl require the secrets.

### Updating the Worker

```bash
cd worker && wrangler deploy
```

No app-side changes needed — the URL stays the same. Secrets persist across deploys.

### CORS

The Worker includes permissive CORS headers (`*`). To restrict origins, edit `CORS_HEADERS` in `worker/src/index.ts`.
