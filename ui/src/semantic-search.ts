// Semantic search via Worker's /embed and /search endpoints (Vectorize).

import { escapeHtml } from "./html-utils.ts";
import { basename, dirname } from "./path-utils.ts";
import { workerFetch } from "./worker-fetch.ts";

const { readTextFile } = window.__TAURI__.fs;

// --- Index ---

export async function indexDocument(
  id: string,
  content: string,
  metadata?: Record<string, string>,
): Promise<{ indexed: number; chunks: number }> {
  return workerFetch("/embed", {
    method: "POST",
    body: JSON.stringify({ documents: [{ id, content, metadata }] }),
  });
}

export async function indexDocuments(
  docs: { id: string; content: string; metadata?: Record<string, string> }[],
): Promise<{ indexed: number; chunks: number }> {
  return workerFetch("/embed", {
    method: "POST",
    body: JSON.stringify({ documents: docs }),
  });
}

export async function removeDocument(docId: string): Promise<void> {
  await workerFetch(`/embed/${encodeURIComponent(docId)}`, { method: "DELETE" });
}

// --- Search ---

export interface SearchResult {
  id: string;
  score: number;
  metadata?: Record<string, string>;
}

export async function semanticSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const resp = await workerFetch<{ results: SearchResult[] }>("/search", {
    method: "POST",
    body: JSON.stringify({ query, limit }),
  });
  return resp.results;
}

// --- Bulk index from file tree ---

export async function indexProjectFiles(
  rootPath: string,
  filePaths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const batchSize = 10;
  let indexed = 0;

  for (let i = 0; i < filePaths.length; i += batchSize) {
    const batch = filePaths.slice(i, i + batchSize);
    const docs = await Promise.all(
      batch.map(async (fp) => {
        const content = await readTextFile(fp);
        const relativePath = fp.startsWith(rootPath) ? fp.slice(rootPath.length + 1) : fp;
        return {
          id: relativePath,
          content,
          metadata: {
            filename: basename(relativePath),
            dir: dirname(relativePath),
          },
        };
      }),
    );
    await indexDocuments(docs);
    indexed += docs.length;
    onProgress?.(indexed, filePaths.length);
  }

  return indexed;
}

// --- Search UI (standalone overlay, can be triggered from command palette) ---

let searchOverlay: HTMLElement | null = null;

export function openSearchUI(onSelect: (filePath: string) => void) {
  if (searchOverlay) return;

  searchOverlay = document.createElement("div");
  searchOverlay.className = "command-palette-overlay";

  const box = document.createElement("div");
  box.className = "command-palette-box";

  const input = document.createElement("input");
  input.className = "command-palette-input";
  input.type = "text";
  input.placeholder = "Semantic search… (natural language query)";

  const list = document.createElement("div");
  list.className = "command-palette-list";

  box.appendChild(input);
  box.appendChild(list);
  searchOverlay.appendChild(box);
  document.body.appendChild(searchOverlay);

  requestAnimationFrame(() => input.focus());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedIndex = 0;
  let currentResults: SearchResult[] = [];

  function renderSearchResults() {
    list.innerHTML = "";
    for (let i = 0; i < currentResults.length; i++) {
      const r = currentResults[i];
      const docId = typeof r.id === "string" && r.id.includes("#") ? r.id.split("#")[0] : r.id;
      const item = document.createElement("div");
      item.className = "command-palette-item" + (i === selectedIndex ? " selected" : "");
      item.innerHTML = `
        <span class="command-palette-label">${escapeHtml(docId)}</span>
        <span class="command-palette-meta">
          <span class="command-palette-category">${(r.score * 100).toFixed(0)}%</span>
        </span>
      `;
      item.addEventListener("mouseenter", () => {
        selectedIndex = i;
        for (const el of list.children) el.classList.remove("selected");
        item.classList.add("selected");
      });
      item.addEventListener("click", () => {
        closeSearchUI();
        onSelect(docId);
      });
      list.appendChild(item);
    }
    if (currentResults.length === 0 && input.value.length > 0) {
      list.innerHTML = '<div class="command-palette-empty">No results</div>';
    }
  }

  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const query = input.value.trim();
      if (!query) {
        currentResults = [];
        renderSearchResults();
        return;
      }
      try {
        currentResults = await semanticSearch(query);
        selectedIndex = 0;
        renderSearchResults();
      } catch {
        list.innerHTML = '<div class="command-palette-empty">Search error</div>';
      }
    }, 300);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
      renderSearchResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      renderSearchResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentResults[selectedIndex]) {
        closeSearchUI();
        const docId = currentResults[selectedIndex].id.split("#")[0];
        onSelect(docId);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchUI();
    }
  });

  searchOverlay.addEventListener("click", (e) => {
    if (e.target === searchOverlay) closeSearchUI();
  });
}

export function closeSearchUI() {
  if (searchOverlay) {
    searchOverlay.remove();
    searchOverlay = null;
  }
}
