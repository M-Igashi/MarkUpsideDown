# Importing Content

MarkUpsideDown can convert a wide range of content into Markdown: web pages, documents, and images. All conversions are powered by Cloudflare Workers AI.

## Fetching Web Pages

### Static Pages (Get)

Type a URL into the URL bar and click **Get**. The page is fetched and converted to Markdown using Cloudflare's Markdown for Agents / `AI.toMarkdown()`.

![URL bar with Get and Render options](images/importing-content/url-bar.png)

This works well for most web pages — articles, documentation, blog posts. Results are cached in KV to avoid redundant conversions.

![Fetch result showing converted Markdown](images/importing-content/fetch-result.png)

### JavaScript-Rendered Pages (Render)

For pages that rely on JavaScript to render content (SPAs, dynamic sites), use the **Render** option. This uses Cloudflare Browser Rendering to load the page in a headless browser, wait for JavaScript to execute, then convert the rendered HTML to Markdown.

Rendering requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets in your Worker (see [Installation & Setup](installation.md)).

### Auto Link Title

When you paste a URL into the editor, MarkUpsideDown automatically fetches the page title and formats it as a Markdown link: `[Page Title](https://example.com)`. This saves you from manually looking up titles.

### Link Context Menu

Right-click any link in the preview pane to get a context menu with quick actions:

- **Fetch** — convert the linked page to Markdown
- **Render** — render with JavaScript and convert
- **Crawl** — start crawling from that URL

## Importing Files

Click the **Import** button in the toolbar to open a file picker. Select a document to convert it to Markdown.

### Supported Formats

| Format | Extension |
|--------|-----------|
| PDF | `.pdf` |
| Word | `.docx` |
| Excel | `.xlsx` |
| HTML | `.html`, `.htm` |
| CSV | `.csv` |
| XML | `.xml` |
| Images (OCR) | `.jpg`, `.png`, `.webp`, `.svg` |

You can also **drag and drop** supported files onto the editor to import them.

### How It Works

Files are sent to your Cloudflare Worker, which uses `AI.toMarkdown()` to convert them. For images, OCR is performed to extract text.

## Batch Import

For converting multiple files at once, MarkUpsideDown supports batch import. This uses a queue-based parallel conversion pipeline:

1. Select multiple files to import
2. Files are queued and converted in parallel via the Worker
3. Progress is tracked per file

Batch import requires the **CONVERT_QUEUE** Queue binding and **CACHE** KV binding in your Worker.

## Caching

Converted content is cached in Cloudflare KV (when the CACHE binding is available). Fetching the same URL or converting the same file again will return the cached result instantly.
