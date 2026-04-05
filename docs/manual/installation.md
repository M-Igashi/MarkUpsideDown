# Installation & Setup

## Installing MarkUpsideDown

### Homebrew (Recommended)

The easiest way to install on macOS:

```bash
brew install M-Igashi/tap/markupsidedown
```

Homebrew handles Gatekeeper automatically — no need to run `xattr` or right-click to open.

### GitHub Releases

Download the latest `.dmg` from the [Releases page](https://github.com/M-Igashi/MarkUpsideDown/releases). Open the `.dmg` and drag MarkUpsideDown to your Applications folder.

> **Note:** The app is not code-signed. If you download directly (not via Homebrew), macOS may show a warning. Right-click the app and select "Open" to bypass it the first time.

## System Requirements

- **macOS** on Apple Silicon (M1/M2/M3/M4)

## First Launch

When you open MarkUpsideDown for the first time, you'll see an empty editor. The app works immediately for local Markdown editing — no setup required for basic use.

![First launch with empty editor](images/installation/first-launch.png)

To unlock conversion features (importing documents, fetching URLs, crawling websites), you need to set up a Cloudflare Worker.

## Cloudflare Worker Setup

Click **Settings** in the toolbar to open the Settings dialog.

![Settings dialog](images/installation/settings-dialog.png)

### Auto Setup (Recommended)

Click **"Setup with Cloudflare"** to start the automated setup wizard. It walks through 6 steps:


| Step | What it does |
|------|-------------|
| 1. Check wrangler | Verifies that `wrangler` CLI is installed (`npm install -g wrangler`) |
| 2. Cloudflare login | Opens your browser for Cloudflare OAuth (skipped if already logged in) |
| 3. Create resources | Creates KV namespace, R2 bucket, Queue, and Vectorize index in parallel |
| 4. Deploy Worker | Deploys the Worker with a randomized URL (e.g., `markupsidedown-a3f8k2.workers.dev`) |
| 5. Configure secrets | Creates a scoped API token and sets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as Worker secrets |
| 6. Verify | Tests the deployed Worker and confirms which features are available |


Each step shows its status: pending (○), running (●), done (✓), error (✗), or skipped (—).


> **If step 5 fails:** A fallback form appears asking you to paste a manually-created API token. You can also click "Skip for now" — the Worker will still work for document import, but Render JS, Crawl, and Extract JSON won't be available until you add secrets later.

### Manual Setup

If you prefer to set things up manually:

1. Install wrangler: `npm install -g wrangler`
2. Deploy the Worker: `cd worker && wrangler deploy`
3. Set secrets (for Render JS and Crawl):
   ```bash
   cd worker
   wrangler secret put CLOUDFLARE_ACCOUNT_ID
   wrangler secret put CLOUDFLARE_API_TOKEN
   ```
4. In Settings, paste the Worker URL, click **Test**, then **Save**

### Testing the Connection

After setup, the **Test** button sends a health check to your Worker and reports which features are available.

### Feature Status

The Feature Status section shows a green checkmark or amber dot for each capability:

![Feature status indicators](images/installation/feature-status.png)

| Feature | Requires |
|---------|----------|
| Open / Save | Nothing (always works) |
| Get URL as Markdown | Nothing (always works) |
| Table Editor / Copy Rich Text | Nothing (always works) |
| Import documents | Worker URL |
| JS Rendering | Worker URL + secrets |
| Website Crawl | Worker URL + secrets |
| Conversion Cache | KV namespace |
| Batch Import | Queue + KV |
| Publish to R2 | R2 bucket |
| Semantic Search | Vectorize index |

Features that show an amber dot are available once their requirements are met. The auto setup creates all resources, so everything should show green after a successful setup.

## Editor Settings

In Settings → Editor:

| Setting | Default | Description |
|---------|---------|-------------|
| **Auto-save files** | Off | Saves automatically 2 seconds after last edit |
| **Markdown linting** | Off | Shows structural issues in the editor gutter |
| **Smart typography** | Off | Auto-converts `...` → `…`, `--` → `–`, `---` → `—` |

## Import Options

In Settings → Import Options:

| Setting | Default | Description |
|---------|---------|-------------|
| **Allow image conversion** | Off | Enables OCR-based image import (~720 AI Neurons per image) |

## Updating the Worker

When a new version of MarkUpsideDown includes Worker updates, an **"Update Worker"** button appears in Settings. Click it to re-deploy with the latest code — no need to re-run the full setup.
