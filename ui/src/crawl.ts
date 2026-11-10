import { normalizeMarkdown } from "./normalize.ts";
import { ensureWorkerUrl, getWorkerKey } from "./settings.ts";
import { escapeHtml } from "./html-utils.ts";
import { getRootPath } from "./sidebar.ts";
import { indexDocuments } from "./semantic-search.ts";
import { workerFetch } from "./worker-fetch.ts";

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
let crawlAbort: AbortController | null = null;
let crawlJobId: string | null = null;

/** Stop polling and cancel the job on Cloudflare so it stops using browser time. */
function cancelCrawl() {
  crawlAbort?.abort();
  if (crawlJobId) {
    workerFetch(`/crawl/${crawlJobId}`, { method: "DELETE" }).catch(() => {
      // Older Workers have no cancel endpoint; the job stops at its page limit.
    });
  }
}

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

  crawlAbort = new AbortController();
  const { signal } = crawlAbort;

  try {
    // Step 1: Start crawl
    const { job_id } = await invoke<CrawlStartResult>("crawl_website", {
      url,
      workerUrl,
      workerKey: getWorkerKey() || null,
      depth: options.depth,
      limit: options.limit,
      render: options.render,
      includePatterns: options.includePatterns.length ? options.includePatterns : null,
      excludePatterns: options.excludePatterns.length ? options.excludePatterns : null,
    });

    crawlJobId = job_id;
    showCrawlStatus(`Crawl started (job: ${job_id.slice(0, 8)}...)`);

    // Step 2: Poll for results
    const { pages: allPages, status } = await pollCrawl(job_id, workerUrl, signal);
    // e.g. "cancelled_due_to_limits" when the Workers Free plan limits are hit
    const stopped = status.startsWith("cancelled") ? ` (stopped: ${status})` : "";

    if (allPages.length === 0) {
      statusEl.textContent = `Crawl finished but no pages were found${stopped}`;
      return;
    }

    // Step 3: Save files
    statusEl.textContent = `Saving ${allPages.length} pages...`;
    const result = await invoke<CrawlSaveResult>("crawl_save", {
      pages: allPages,
      baseDir,
    });

    statusEl.textContent = `Crawl complete: ${result.saved_count} pages saved to ${result.base_dir}${stopped}`;
    onCrawlComplete?.();

    // Auto-index crawled pages for semantic search (fire and forget)
    if (allPages.length > 0) {
      const docs = allPages.map((page) => {
        // Derive relative path from URL
        let relPath: string;
        try {
          const u = new URL(page.url);
          relPath = u.pathname.replace(/^\//, "").replace(/\/$/, "/index") + ".md";
        } catch {
          relPath = page.url;
        }
        return { id: relPath, content: page.markdown };
      });
      statusEl.textContent += " — Indexing for search…";
      indexDocuments(docs)
        .then((r) => {
          statusEl.textContent = `Crawl complete: ${result.saved_count} pages saved, ${r.indexed} indexed`;
        })
        .catch(() => {
          // Semantic search not configured — silently ignore
        });
    }
  } catch (e) {
    if (signal.aborted) {
      statusEl.textContent = "Crawl aborted";
    } else {
      statusEl.textContent = `Crawl error: ${e}`;
    }
  } finally {
    crawlAbort = null;
    crawlJobId = null;
    urlBar.classList.remove("loading");
    urlInput.disabled = false;
  }
}

function showCrawlStatus(message: string) {
  statusEl.textContent = "";
  statusEl.append(message + " ");
  const cancel = document.createElement("a");
  cancel.textContent = "[Cancel]";
  cancel.href = "#";
  cancel.style.cursor = "pointer";
  cancel.addEventListener("click", (e) => {
    e.preventDefault();
    cancelCrawl();
  });
  statusEl.appendChild(cancel);
}

async function pollCrawl(
  jobId: string,
  workerUrl: string,
  signal: AbortSignal,
): Promise<{ pages: CrawlPage[]; status: string }> {
  const allPages: CrawlPage[] = [];
  const done = (status: string) => ({ pages: allPages, status });
  const maxAttempts = 300; // 5 minutes at 1s interval
  let lastMsg = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return done("cancelled_by_user");

    let cursor: string | null = null;

    // Fetch all available completed pages
    do {
      if (signal.aborted) return done("cancelled_by_user");

      const result: CrawlStatusResult = await invoke("crawl_status", {
        jobId,
        workerUrl,
        workerKey: getWorkerKey() || null,
        cursor,
      });

      for (const page of result.pages) {
        if (page.markdown) {
          allPages.push({ url: page.url, markdown: normalizeMarkdown(page.markdown) });
        }
      }

      const newMsg = `Crawling... ${result.finished}/${result.total} pages (${allPages.length} saved)`;
      if (newMsg !== lastMsg) {
        showCrawlStatus(newMsg);
        lastMsg = newMsg;
      }

      cursor = result.cursor;

      // Job statuses: running, completed, errored, cancelled_by_user,
      // cancelled_due_to_limits, cancelled_due_to_timeout
      if (
        result.status === "completed" ||
        result.status === "errored" ||
        result.status.startsWith("cancelled")
      ) {
        if (result.status === "errored") {
          throw new Error("Crawl job failed");
        }
        // Drain remaining pages if cursor exists
        if (!cursor) return done(result.status);
      }
    } while (cursor);

    // Wait before next poll (abortable)
    await new Promise<void>((r) => {
      if (signal.aborted) return r();
      const timer = setTimeout(r, 1000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          r();
        },
        { once: true },
      );
    });
  }

  // If we got here, we timed out but may still have pages
  return done("timeout");
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

  const { promise, resolve } = Promise.withResolvers<CrawlOptions | null>();
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
    <p class="crawl-note">Render JavaScript uses Browser Run hours ($0.09/hr after the free tier); with it off, crawls are free during the beta. The Workers Free plan allows 5 crawls per day and 100 pages per crawl.</p>
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
    const limit = parseInt((dialog.querySelector("#crawl-limit") as HTMLInputElement).value) || 50;
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
  return promise;
}
