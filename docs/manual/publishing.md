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

The file is uploaded to R2 and you receive a shareable URL. By default, the URL format is `https://your-worker.workers.dev/p/:key`. If [R2 public access](../worker-deployment.md#r2-public-access-for-published-urls-optional) is configured, URLs use the R2 public domain instead (e.g. `https://pub-abc123.r2.dev/:key`), keeping the Worker URL secret.

## Published File Indicator

Published files show an indicator in the sidebar, so you can see at a glance which files have been shared.

## Updating a Published File

Publishing uploads a snapshot. After you edit and save the file, right-click it and select **Update Published Version** to replace the content at the same URL. A time-limited link keeps its original expiry time. Unsaved changes in the editor are not included.

## Unpublishing

To remove a published file, use the unpublish option from the context menu. The content is deleted from R2 and the URL stops working.

## How It Works

- Content is stored in a Cloudflare R2 bucket (object storage)
- Published files are served as `text/markdown` at the `/p/:key` endpoint
- Time-limited URLs automatically expire — the content is removed when the time is up
- No authentication is required to view published files (anyone with the URL can access them)

> **Note:** The key in a published URL is derived from the file's path (for example `/p/notes/meeting`), so treat the URL as unlisted rather than secret. It is not password-protected: anyone with the URL can read the content. Don't publish sensitive content.
>
> **Note:** If using R2 public access, a time-limited URL can stay accessible for up to 15 minutes after it expires. The Worker's `/p/:key` endpoint enforces expiration immediately, while the R2 public URL serves the object until the Worker's scheduled cleanup (every 15 minutes) deletes it.
