import { normalizeMarkdown } from "./normalize.ts";
import { ensureWorkerUrl, escapeHtml } from "./settings.ts";
import { getRootPath } from "./sidebar.ts";

const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

interface CrawlStartResult {
  job_id: string;
}

interface CrawlPage {
  url: string;
  markdown: string;
}

interface CrawlStatusResult {
  status: string;
  total: number;
  finished: number;
  cursor: string | null;
  pages: CrawlPage[];
}

interface CrawlSaveResult {
  saved_count: number;
  base_dir: string;
}

let statusEl: HTMLElement;
let onCrawlComplete: (() => void) | null = null;

export function initCrawl(deps: { statusEl: HTMLElement; onCrawlComplete: () => void }) {
  statusEl = deps.statusEl;
  onCrawlComplete = deps.onCrawlComplete;
}

export async function crawlUrl(urlInput: HTMLInputElement, urlBar: HTMLElement) {
  const url = urlInput.value.trim();
  if (!url) return;

  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  // Show options dialog
  const options = await showCrawlDialog(url);
  if (!options) return;

  // Pick save directory
  const baseDir = options.saveDir;

  urlBar.classList.add("loading");
  urlInput.disabled = true;
  statusEl.textContent = "Starting crawl...";

  try {
    // Step 1: Start crawl
    const { job_id } = await invoke<CrawlStartResult>("crawl_website", {
      url,
      workerUrl,
      depth: options.depth,
      limit: options.limit,
      render: options.render,
      includePatterns: options.includePatterns.length ? options.includePatterns : null,
      excludePatterns: options.excludePatterns.length ? options.excludePatterns : null,
    });

    statusEl.textContent = `Crawl started (job: ${job_id.slice(0, 8)}...)`;

    // Step 2: Poll for results
    const allPages = await pollCrawl(job_id, workerUrl);

    if (allPages.length === 0) {
      statusEl.textContent = "Crawl completed but no pages were found";
      return;
    }

    // Step 3: Save files
    statusEl.textContent = `Saving ${allPages.length} pages...`;
    const result = await invoke<CrawlSaveResult>("crawl_save", {
      pages: allPages,
      baseDir,
    });

    statusEl.textContent = `Crawl complete: ${result.saved_count} pages saved to ${result.base_dir}`;
    onCrawlComplete?.();
  } catch (e) {
    statusEl.textContent = `Crawl error: ${e}`;
  } finally {
    urlBar.classList.remove("loading");
    urlInput.disabled = false;
  }
}

async function pollCrawl(jobId: string, workerUrl: string): Promise<CrawlPage[]> {
  const allPages: CrawlPage[] = [];
  const maxAttempts = 300; // 5 minutes at 1s interval

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let cursor: string | null = null;

    // Fetch all available completed pages
    do {
      const result = await invoke<CrawlStatusResult>("crawl_status", {
        jobId,
        workerUrl,
        cursor,
      });

      for (const page of result.pages) {
        if (page.markdown) {
          allPages.push({ url: page.url, markdown: normalizeMarkdown(page.markdown) });
        }
      }

      statusEl.textContent = `Crawling... ${result.finished}/${result.total} pages (${allPages.length} saved)`;

      cursor = result.cursor;

      if (result.status === "completed" || result.status === "failed") {
        if (result.status === "failed") {
          throw new Error("Crawl job failed");
        }
        // Drain remaining pages if cursor exists
        if (!cursor) return allPages;
      }
    } while (cursor);

    // Wait before next poll
    await new Promise((r) => setTimeout(r, 1000));
  }

  // If we got here, we timed out but may still have pages
  return allPages;
}

interface CrawlOptions {
  depth: number;
  limit: number;
  render: boolean;
  saveDir: string;
  includePatterns: string[];
  excludePatterns: string[];
}

async function showCrawlDialog(url: string): Promise<CrawlOptions | null> {
  // Determine default save directory
  const rootPath = getRootPath();
  let defaultDir = rootPath || "";

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "crawl-dialog-overlay";

    const dialog = document.createElement("div");
    dialog.className = "crawl-dialog";

    const hostname = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();

    dialog.innerHTML = `
      <h3>Crawl Website</h3>
      <p class="crawl-url">${escapeHtml(hostname)}</p>
      <div class="crawl-field">
        <label>Max depth</label>
        <input type="number" id="crawl-depth" value="3" min="1" max="100" />
      </div>
      <div class="crawl-field">
        <label>Page limit</label>
        <input type="number" id="crawl-limit" value="50" min="1" max="500" />
      </div>
      <div class="crawl-field">
        <label>Render JavaScript</label>
        <input type="checkbox" id="crawl-render" checked />
      </div>
      <div class="crawl-field">
        <label>Include patterns</label>
        <input type="text" id="crawl-include" placeholder="e.g. /articles/**, /blog/**" />
      </div>
      <div class="crawl-field">
        <label>Exclude patterns</label>
        <input type="text" id="crawl-exclude" placeholder="e.g. /tag/**, /author/**" />
      </div>
      <div class="crawl-field">
        <label>Save to</label>
        <div class="crawl-dir-row">
          <input type="text" id="crawl-dir" value="${escapeHtml(defaultDir)}" readonly />
          <button id="crawl-browse">Browse</button>
        </div>
      </div>
      <p class="crawl-note">Pages with render=on use Browser Rendering hours ($0.09/hr after free tier).</p>
      <div class="crawl-actions">
        <button id="crawl-cancel">Cancel</button>
        <button id="crawl-start" class="primary">Start Crawl</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const dirInput = dialog.querySelector("#crawl-dir") as HTMLInputElement;

    dialog.querySelector("#crawl-browse")!.addEventListener("click", async () => {
      const dir = await openDialog({ directory: true });
      if (dir) dirInput.value = dir;
    });

    dialog.querySelector("#crawl-cancel")!.addEventListener("click", () => {
      overlay.remove();
      resolve(null);
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });

    dialog.querySelector("#crawl-start")!.addEventListener("click", () => {
      const depth = parseInt((dialog.querySelector("#crawl-depth") as HTMLInputElement).value) || 3;
      const limit =
        parseInt((dialog.querySelector("#crawl-limit") as HTMLInputElement).value) || 50;
      const render = (dialog.querySelector("#crawl-render") as HTMLInputElement).checked;
      const saveDir = dirInput.value.trim();

      const includeRaw = (dialog.querySelector("#crawl-include") as HTMLInputElement).value.trim();
      const excludeRaw = (dialog.querySelector("#crawl-exclude") as HTMLInputElement).value.trim();
      const includePatterns = includeRaw
        ? includeRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const excludePatterns = excludeRaw
        ? excludeRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      if (!saveDir) {
        dirInput.style.borderColor = "#c44";
        return;
      }

      overlay.remove();
      resolve({ depth, limit, render, saveDir, includePatterns, excludePatterns });
    });

    // Focus start button
    (dialog.querySelector("#crawl-start") as HTMLElement).focus();
  });
}
