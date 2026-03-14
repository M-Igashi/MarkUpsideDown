# Worker Deployment Guide

MarkUpsideDown uses a Cloudflare Worker for two features:

1. **Document Import** — Convert PDF, Office, images, etc. to Markdown via [Workers AI `AI.toMarkdown()`](https://developers.cloudflare.com/workers-ai/markdown-conversion/)
2. **Rendered Fetch** — Fetch JavaScript-rendered pages as Markdown via [Browser Rendering REST API](https://developers.cloudflare.com/browser-rendering/rest-api/)

Each user deploys their own Worker instance.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works for document import)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI installed globally

## Deploy

```bash
# Authenticate with Cloudflare
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

## Enable Rendered Fetch (Optional)

The "Render JS" feature in the Fetch URL dialog uses Cloudflare's [Browser Rendering `/markdown` REST API](https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/) to render JavaScript-heavy pages (SPAs, React/Vue apps, dynamic dashboards) and convert them to Markdown.

### Setup

The Worker needs a Cloudflare API token and account ID to call the Browser Rendering API:

1. **Get your Account ID**: Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → any domain or Workers & Pages → copy the Account ID from the right sidebar.

2. **Create an API Token**: Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Custom Token:
   - Permissions: `Account` → `Browser Rendering` → `Edit`
   - Account Resources: select your account

3. **Set Worker secrets**:

```bash
cd worker
wrangler secret put CF_ACCOUNT_ID
# Paste your Account ID

wrangler secret put CF_API_TOKEN
# Paste your API Token
```

That's it. The "Render JS" checkbox in the Fetch URL dialog will now work.

### Browser Rendering Pricing

| Plan | Browser Time | Rate Limit | Cost |
|------|-------------|------------|------|
| **Free** | 10 min/day | 6 req/min | Free |
| **Paid** | 10 hrs/month | 600 req/min | $5/month |

The free tier is sufficient for occasional use. See [Browser Rendering Pricing](https://developers.cloudflare.com/browser-rendering/pricing/) for details.

### When to Use Rendered Fetch

| Scenario | Use |
|----------|-----|
| Static pages, blogs, docs | **Standard** fetch (fast, free) |
| SPAs (React, Vue, Angular) | **Render JS** |
| Pages behind JS-based loading | **Render JS** |
| Dynamic dashboards | **Render JS** |

## Document Import Cost

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

Ensure your API token has **Workers Scripts - Edit** permission, or use `wrangler login` for OAuth.

### "CF_ACCOUNT_ID and CF_API_TOKEN secrets are required" error

Set the secrets as described in the [Enable Rendered Fetch](#enable-rendered-fetch-optional) section. This is only required for the "Render JS" feature.

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
