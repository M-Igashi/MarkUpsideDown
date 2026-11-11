import { normalizeMarkdown } from "./normalize.ts";
import { ensureWorkerUrl, getWorkerKey } from "./settings.ts";
import { escapeHtml } from "./html-utils.ts";
import { getRootPath } from "./sidebar.ts";
import { indexDocuments } from "./semantic-search.ts";
import { workerFetch } from "./worker-fetch.ts";
import { relativeToRoot } from "./path-utils.ts";

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
  paths: string[];
}

let statusEl: HTMLElement;
let onCrawlComplete: (() => void) | null = null;
let crawlAbort: AbortController | null = null;
let crawlJobId: string | null = null;

function deleteCrawlJob(jobId: string) {
  workerFetch(`/crawl/${jobId}`, { method: "DELETE" }).catch(() => {
    // Older Workers have no cancel endpoint; the job stops at its page limit.
  });
}

/** Stop polling and cancel the job on Cloudflare so it stops using browser time. */
function cancelCrawl() {
  crawlAbort?.abort();
  if (crawlJobId) deleteCrawlJob(crawlJobId);
}

function crawlRunning(): boolean {
  if (!crawlAbort) return false;
  statusEl.textContent = "A crawl is already running. Cancel it before starting another.";
  return true;
}

export function initCrawl(deps: { statusEl: HTMLElement; onCrawlComplete: () => void }) {
  statusEl = deps.statusEl;
  onCrawlComplete = deps.onCrawlComplete;
}

export async function crawlUrl(urlInput: HTMLInputElement, urlBar: HTMLElement) {
  const url = urlInput.value.trim();
  if (!url || crawlRunning()) return;

  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  // Show options dialog
  const options = await showCrawlDialog(url);
  if (!options || crawlRunning()) return;

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
    const stopped = status === "completed" ? "" : ` (stopped: ${status})`;
    const outcome = status === "completed" ? "Crawl complete" : "Crawl partial";

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

    statusEl.textContent = `${outcome}: ${result.saved_count} pages saved to ${result.base_dir}${stopped}`;
    onCrawlComplete?.();

    // Auto-index crawled pages for semantic search (fire and forget). Search
    // results are opened relative to the project root, so pages saved outside
    // it are not indexed.
    const root = getRootPath();
    const docs = root
      ? allPages.flatMap((page, i) => {
          const path = result.paths?.[i];
          if (!path?.startsWith(`${root}/`)) return [];
          return [{ id: relativeToRoot(root, path), content: page.markdown }];
        })
      : [];
    if (docs.length > 0) {
      statusEl.textContent += " | Indexing for search…";
      indexDocuments(docs)
        .then((r) => {
          statusEl.textContent = `${outcome}: ${result.saved_count} pages saved, ${r.indexed} indexed${stopped}`;
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
  const fetchStatus = (cursor: string | null, limit: number) =>
    invoke<CrawlStatusResult>("crawl_status", {
      jobId,
      workerUrl,
      workerKey: getWorkerKey() || null,
      cursor,
      limit,
    });

  // Records are fetched once, after the job stops: the endpoint returns every
  // completed record on each call, so collecting them while polling would
  // re-download (and duplicate) all finished pages every second.
  const collect = async (status: string) => {
    const pages: CrawlPage[] = [];
    let cursor: string | null = null;
    do {
      const result = await fetchStatus(cursor, 100);
      for (const page of result.pages) {
        if (page.markdown) {
          pages.push({ url: page.url, markdown: normalizeMarkdown(page.markdown) });
        }
      }
      cursor = result.cursor;
    } while (cursor);
    return { pages, status };
  };

  const maxAttempts = 300; // 5 minutes at 1s interval
  let lastMsg = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) return collect("cancelled_by_user");

    // Job statuses: running, completed, errored, cancelled_by_user,
    // cancelled_due_to_limits, cancelled_due_to_timeout
    const { status, finished, total } = await fetchStatus(null, 1);
    if (status === "errored") throw new Error("Crawl job failed");
    if (status === "completed" || status.startsWith("cancelled")) return collect(status);

    const newMsg = `Crawling... ${finished}/${total} pages`;
    if (newMsg !== lastMsg) {
      showCrawlStatus(newMsg);
      lastMsg = newMsg;
    }

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

  // Timed out: cancel the job so it stops using browser time, then save
  // whatever has completed so far
  deleteCrawlJob(jobId);
  return collect("timed_out");
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
      <input type="number" class="field field-sm" id="crawl-depth" value="3" min="1" max="100" />
    </div>
    <div class="crawl-field">
      <label>Page limit</label>
      <input type="number" class="field field-sm" id="crawl-limit" value="50" min="1" max="500" />
    </div>
    <div class="crawl-field">
      <label>Render JavaScript</label>
      <input type="checkbox" id="crawl-render" checked />
    </div>
    <div class="crawl-field">
      <label>Include patterns</label>
      <input type="text" class="field field-sm" id="crawl-include" placeholder="e.g. /articles/**, /blog/**" />
    </div>
    <div class="crawl-field">
      <label>Exclude patterns</label>
      <input type="text" class="field field-sm" id="crawl-exclude" placeholder="e.g. /tag/**, /author/**" />
    </div>
    <div class="crawl-field">
      <label>Save to</label>
      <div class="crawl-dir-row">
        <input type="text" class="field field-sm" id="crawl-dir" value="${escapeHtml(defaultDir)}" readonly />
        <button id="crawl-browse" class="btn btn-sm">Browse</button>
      </div>
    </div>
    <p class="crawl-note">Render JavaScript uses Browser Run hours ($0.09/hr after the free tier); with it off, crawls are free during the beta. The Workers Free plan allows 5 crawls per day and 100 pages per crawl.</p>
    <div class="crawl-actions">
      <button id="crawl-cancel" class="btn">Cancel</button>
      <button id="crawl-start" class="btn btn-primary">Start Crawl</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const dirInput = dialog.querySelector("#crawl-dir") as HTMLInputElement;

  dialog.querySelector("#crawl-browse")!.addEventListener("click", async () => {
    const dir = await openDialog({ directory: true });
    if (dir) dirInput.value = dir;
  });

  const cancel = () => {
    overlay.remove();
    resolve(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancel();
  };
  document.addEventListener("keydown", onKey);
  promise.finally(() => document.removeEventListener("keydown", onKey));
  dialog.querySelector("#crawl-cancel")!.addEventListener("click", cancel);

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
