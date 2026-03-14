# Worker Deployment Guide

MarkUpsideDown uses a Cloudflare Worker for two features:

1. **Document Import** — Convert PDF, Office, images, etc. to Markdown via [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/)
2. **Rendered Fetch** — Fetch JavaScript-rendered pages as Markdown via [Browser Rendering `/markdown` REST API](https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/)

Each user deploys their own Worker instance.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works for document import)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI installed globally

## API Token Setup

Create a single API token that covers both Worker deployment and Browser Rendering:

1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Custom Token**
2. Set permissions:
   - `Account` → `Workers Scripts` → `Edit` (deploy Workers)
   - `Account` → `Browser Rendering` → `Edit` (rendered fetch)
3. Account Resources: select your account
4. Create the token and save it

### Set Worker secrets

Get your **Account ID** from [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → right sidebar.

```bash
cd worker
wrangler secret put CF_ACCOUNT_ID
# Paste your Account ID

wrangler secret put CF_API_TOKEN
# Paste the API token created above
```

> **Note**: If you only need Document Import (not Rendered Fetch), you can skip the secrets. The `Browser Rendering - Edit` permission and secrets are only required for the "Render JS" feature.

## Deploy

```bash
# Authenticate with Cloudflare (or use the API token)
wrangler login

# Install dependencies and deploy
cd worker
npm install
wrangler deploy
```

On success, wrangler outputs your Worker URL:

```
Uploaded markupsidedown-converter
Deployed markupsidedown-converter triggers
  https://markupsidedown-converter.<your-subdomain>.workers.dev
```

## Configure the App

1. Launch MarkUpsideDown
2. Click **Settings** in the toolbar
3. Paste your Worker URL (e.g. `https://markupsidedown-converter.example.workers.dev`)

The URL is saved in localStorage and persists across sessions.

## When to Use Rendered Fetch

| Scenario | Use |
|----------|-----|
| Static pages, blogs, docs | **Standard** fetch (fast, free) |
| SPAs (React, Vue, Angular) | **Render JS** |
| Pages behind JS-based loading | **Render JS** |
| Dynamic dashboards | **Render JS** |

## Pricing

### Browser Rendering

| Plan | Browser Time | Rate Limit | Cost |
|------|-------------|------------|------|
| **Free** | 10 min/day | 6 req/min | Free |
| **Paid** | 10 hrs/month | 600 req/min | $5/month |

The free tier is sufficient for occasional use. See [Browser Rendering Pricing](https://developers.cloudflare.com/browser-rendering/pricing/) for details.

### Document Import

| Format | Cost |
|--------|------|
| PDF, DOCX, XLSX, PPTX, HTML, CSV, XML | **Free** (no AI Neurons) |
| Images (JPG, PNG, GIF, WebP, BMP, TIFF) | **AI Neurons** (OCR) |

The app shows a confirmation dialog before processing images.

## Supported Import Formats

- PDF (`.pdf`)
- Microsoft Word (`.docx`)
- Microsoft Excel (`.xlsx`)
- Microsoft PowerPoint (`.pptx`)
- HTML (`.html`, `.htm`)
- CSV (`.csv`)
- XML (`.xml`)
- Images (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.tif`)

## Troubleshooting

### Authentication error on deploy

Run `wrangler login` or set `CLOUDFLARE_API_TOKEN` env var with a token that has `Workers Scripts - Edit` permission.

### "CF_ACCOUNT_ID and CF_API_TOKEN secrets are required" error

Set the secrets as described in [API Token Setup](#api-token-setup). This is only required for the "Render JS" feature.

### Browser Rendering API errors

- **403**: Check that your API token has `Browser Rendering - Edit` permission.
- **429**: Rate limit exceeded. Free tier allows 6 requests/minute.
- **Timeout**: Some complex pages may take longer to render. Try again or use standard fetch.

### CORS errors in the app

The Worker includes permissive CORS headers (`*`). If you need to restrict origins, edit `corsHeaders()` in `worker/src/index.ts`.

### Updating the Worker

```bash
cd worker
wrangler deploy
```

No app-side changes needed — the URL stays the same. Secrets persist across deploys.
