# Crawling Websites

MarkUpsideDown can crawl an entire website and save each page as a Markdown file. This is useful for archiving documentation sites, saving reference material, or importing content for editing.

## Starting a Crawl

1. Type the target URL into the URL bar
2. Click **Crawl** (or right-click a link in the preview and select "Crawl")
3. The crawl dialog opens with configuration options

![Crawl dialog with configuration options](images/crawling-websites/crawl-dialog.png)

## Crawl Options

| Option | Default | Description |
|--------|---------|-------------|
| **Max depth** | 3 | How many link levels to follow from the starting page |
| **Page limit** | 50 | Maximum number of pages to crawl |
| **Render JavaScript** | On | Use Browser Rendering for JavaScript-heavy sites |
| **Include patterns** | (empty) | Only crawl URLs matching these patterns (e.g., `/articles/**`, `/blog/**`) |
| **Exclude patterns** | (empty) | Skip URLs matching these patterns (e.g., `/tag/**`, `/author/**`) |
| **Save to** | (auto) | Directory where crawled Markdown files will be saved. Click **Browse** to change. |

## During the Crawl

After clicking **Start Crawl**:

- The status bar shows live progress: "Crawling... 12/50 pages (12 saved)"
- A **[Cancel]** link in the status bar lets you stop the crawl at any time
- Pages are saved as they are converted — you don't have to wait for the full crawl to finish

## Results

Crawled pages are saved as individual `.md` files in the target directory. The file tree in the sidebar updates to show the new files.

## Requirements

Crawling uses Cloudflare Browser Rendering's `/crawl` API. It requires:

- `CLOUDFLARE_ACCOUNT_ID` secret in your Worker
- `CLOUDFLARE_API_TOKEN` secret in your Worker

These are configured during the Cloudflare Worker setup (see [Installation & Setup](installation.md)).

> **Billing note:** Browser Rendering usage is billed by Cloudflare. The crawl dialog shows a note about this. Check [Cloudflare's pricing page](https://developers.cloudflare.com/browser-rendering/) for current rates.

## Tips

- Use **include patterns** to limit crawling to specific sections of a site (e.g., only `/docs/**`)
- Use **exclude patterns** to skip pages that aren't useful (e.g., `/tag/**`, `/page/**`)
- Lower the **max depth** for focused crawls, increase it for comprehensive archiving
- The **page limit** prevents runaway crawls on large sites — adjust as needed
- If a site relies heavily on JavaScript, keep **Render JavaScript** enabled
