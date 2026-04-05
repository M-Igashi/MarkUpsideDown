# Publishing

MarkUpsideDown can publish Markdown files to Cloudflare R2, giving you shareable URLs for your content.

## Requirements

Publishing requires the **PUBLISH_BUCKET** R2 binding in your Cloudflare Worker. This is set up automatically during the Cloudflare Worker setup (see [Installation & Setup](installation.md)). Check **Settings → Feature Status** to confirm "Publish to R2" shows a green checkmark.

## How to Publish

1. Right-click a file in the sidebar
2. Select the publish option from the context menu
3. Choose an expiry:
   - **Permanent** — no expiration
   - **1 hour**
   - **24 hours**
   - **7 days**

![Publish context menu with expiry options](images/publishing/publish-context-menu.png)

The file is uploaded to R2 and you receive a shareable URL. The URL format is `https://your-worker.workers.dev/p/:key`.

## Published File Indicator

Published files show an indicator in the sidebar, so you can see at a glance which files have been shared.

## Unpublishing

To remove a published file, use the unpublish option from the context menu. The content is deleted from R2 and the URL stops working.

## How It Works

- Content is stored in a Cloudflare R2 bucket (object storage)
- Published files are served as `text/markdown` at the `/p/:key` endpoint
- Time-limited URLs automatically expire — the content is removed when the time is up
- No authentication is required to view published files (anyone with the URL can access them)

> **Note:** Published URLs are not easily guessable (they use generated keys), but they are not password-protected. Don't publish sensitive content.
