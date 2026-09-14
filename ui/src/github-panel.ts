// Sidebar panel listing GitHub issues and pull requests for the open project.

import {
  ghList,
  ghStatus,
  ghView,
  type GhItem,
  type GhItemDetail,
  type GhKind,
  type GhStatus,
} from "./github.ts";
import { KEY_GITHUB_FILTER } from "./storage-keys.ts";

type StateFilter = "open" | "closed" | "all";

let panelEl: HTMLElement | null = null;
let repoPath: string | null = null;
let status: GhStatus | null = null;
let items: GhItem[] = [];
let loading = false;
let errorMessage = "";
let onItemOpen: ((repo: string, kind: GhKind, detail: GhItemDetail) => void) | null = null;
let isVisibleCb: (() => boolean) | null = null;

let kind: GhKind = "issue";
let stateFilter: StateFilter = "open";
let searchQuery = "";

function restoreFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_GITHUB_FILTER) || "{}");
    if (saved.kind === "issue" || saved.kind === "pr") kind = saved.kind;
    if (saved.state === "open" || saved.state === "closed" || saved.state === "all") {
      stateFilter = saved.state;
    }
  } catch {
    // ignore
  }
}

function saveFilter() {
  localStorage.setItem(KEY_GITHUB_FILTER, JSON.stringify({ kind, state: stateFilter }));
}

export function initGitHubPanel(
  el: HTMLElement,
  {
    onOpen,
    isVisible,
  }: {
    onOpen: (repo: string, kind: GhKind, detail: GhItemDetail) => void;
    isVisible?: () => boolean;
  },
) {
  panelEl = el;
  onItemOpen = onOpen;
  isVisibleCb = isVisible ?? null;
  restoreFilter();
  render();
}

export function setGitHubRepoPath(path: string | null, skipRefresh = false) {
  repoPath = path;
  status = null;
  items = [];
  errorMessage = "";
  if (!path) {
    render();
    return;
  }
  if (!skipRefresh) refresh();
  else render();
}

/** Switch between the issue and pull request listings. */
export function setGitHubKind(next: GhKind) {
  if (kind === next) return;
  kind = next;
  saveFilter();
  refresh();
}

// Filter changes can overlap a listing already in flight, so only the newest
// request is allowed to write back its results.
let requestId = 0;

export async function refresh() {
  if (!repoPath) return;
  // Listing costs a network round trip — skip it while the panel is hidden.
  if (isVisibleCb && !isVisibleCb()) return;

  const id = ++requestId;
  loading = true;
  errorMessage = "";
  render();

  let nextItems: GhItem[] = [];
  let nextError = "";
  try {
    if (!status) status = await ghStatus(repoPath);
    if (status.repo && status.cli_available && status.authenticated) {
      nextItems = await ghList(status.repo, kind, stateFilter, 50, searchQuery);
    }
  } catch (e) {
    nextError = String(e);
  }

  if (id !== requestId) return;
  items = nextItems;
  errorMessage = nextError;
  loading = false;
  render();
}

async function openItem(item: GhItem) {
  if (!status?.repo || !onItemOpen) return;
  const repo = status.repo;
  errorMessage = "";
  loading = true;
  render();
  try {
    const detail = await ghView(repo, kind, item.number);
    onItemOpen(repo, kind, detail);
  } catch (e) {
    errorMessage = String(e);
  } finally {
    loading = false;
    render();
  }
}

// --- Render helpers ---

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [60, "s"],
    [3600, "m"],
    [86400, "h"],
    [2592000, "d"],
    [31536000, "mo"],
  ];
  if (seconds < 60) return `${seconds}s ago`;
  for (let i = 1; i < units.length; i++) {
    if (seconds < units[i][0]) {
      return `${Math.floor(seconds / units[i - 1][0])}${units[i][1]} ago`;
    }
  }
  return `${Math.floor(seconds / 31536000)}y ago`;
}

function emptyMessage(): string | null {
  if (!repoPath) return "Open a folder to see GitHub issues";
  if (!status) return null;
  if (!status.repo) return "This project has no GitHub remote";
  if (!status.cli_available) return "GitHub CLI (gh) is not installed";
  if (!status.authenticated) return "Not signed in. Run: gh auth login";
  if (loading) return null;
  return searchQuery ? "No matches" : `No ${stateFilter === "all" ? "" : stateFilter} items`;
}

// The header is built once and reused: rebuilding it on every render would
// steal focus from the search box while the user is still typing.
let headerEl: HTMLElement | null = null;
let searchInputEl: HTMLInputElement | null = null;

function ensureHeader(): HTMLElement {
  if (headerEl) {
    syncHeader();
    return headerEl;
  }

  headerEl = document.createElement("div");

  const segmented = document.createElement("div");
  segmented.className = "gh-segmented";
  for (const [value, label] of [
    ["issue", "Issues"],
    ["pr", "Pull Requests"],
  ] as const) {
    const btn = document.createElement("button");
    btn.className = "gh-segment";
    btn.dataset.kind = value;
    btn.textContent = label;
    btn.addEventListener("click", () => setGitHubKind(value));
    segmented.appendChild(btn);
  }
  headerEl.appendChild(segmented);

  const filterRow = document.createElement("div");
  filterRow.className = "gh-filter-row";

  searchInputEl = document.createElement("input");
  searchInputEl.className = "gh-search-input";
  searchInputEl.type = "text";
  let timeout: ReturnType<typeof setTimeout> | null = null;
  searchInputEl.addEventListener("input", () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      searchQuery = searchInputEl!.value.trim();
      refresh();
    }, 400);
  });
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchQuery) {
      searchInputEl!.value = "";
      searchQuery = "";
      refresh();
    }
  });
  filterRow.appendChild(searchInputEl);

  const select = document.createElement("select");
  select.className = "gh-state-select";
  select.title = "Filter by state";
  for (const [value, label] of [
    ["open", "Open"],
    ["closed", "Closed"],
    ["all", "All"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    stateFilter = select.value as StateFilter;
    saveFilter();
    refresh();
  });
  filterRow.appendChild(select);

  headerEl.appendChild(filterRow);
  syncHeader();
  return headerEl;
}

function syncHeader() {
  if (!headerEl) return;
  for (const btn of headerEl.querySelectorAll(".gh-segment") as NodeListOf<HTMLElement>) {
    btn.classList.toggle("active", btn.dataset.kind === kind);
  }
  if (searchInputEl) {
    searchInputEl.placeholder = kind === "pr" ? "Search pull requests…" : "Search issues…";
  }
  const select = headerEl.querySelector(".gh-state-select") as HTMLSelectElement | null;
  if (select) select.value = stateFilter;
}

function createItemRow(item: GhItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "gh-item-row";
  row.title = item.title;
  row.addEventListener("click", () => openItem(item));

  const dot = document.createElement("span");
  dot.className = `gh-state-dot gh-state-${item.state.toLowerCase()}`;
  row.appendChild(dot);

  const main = document.createElement("div");
  main.className = "gh-item-main";

  const titleEl = document.createElement("div");
  titleEl.className = "gh-item-title";
  titleEl.textContent = `#${item.number} ${item.title}`;
  main.appendChild(titleEl);

  const meta = document.createElement("div");
  meta.className = "gh-item-meta";
  const parts = [item.author?.login ? `@${item.author.login}` : "", relativeTime(item.updated_at)];
  if (item.is_draft) parts.unshift("draft");
  meta.textContent = parts.filter(Boolean).join(" · ");
  main.appendChild(meta);

  if (item.labels.length > 0) {
    const labels = document.createElement("div");
    labels.className = "gh-item-labels";
    for (const label of item.labels.slice(0, 4)) {
      const chip = document.createElement("span");
      chip.className = "gh-label-chip";
      chip.textContent = label.name;
      if (/^[0-9a-fA-F]{6}$/.test(label.color)) {
        chip.style.borderColor = `#${label.color}`;
        chip.style.color = `#${label.color}`;
      }
      labels.appendChild(chip);
    }
    main.appendChild(labels);
  }

  row.appendChild(main);
  return row;
}

function render() {
  if (!panelEl) return;
  const header = ensureHeader();
  panelEl.innerHTML = "";
  panelEl.appendChild(header);

  const list = document.createElement("div");
  list.className = "gh-item-list";

  if (loading && items.length === 0) {
    const busy = document.createElement("div");
    busy.className = "gh-panel-empty";
    busy.textContent = "Loading…";
    list.appendChild(busy);
  } else {
    for (const item of items) list.appendChild(createItemRow(item));
    const empty = items.length === 0 ? emptyMessage() : null;
    if (empty) {
      const el = document.createElement("div");
      el.className = "gh-panel-empty";
      el.textContent = empty;
      list.appendChild(el);
    }
  }

  panelEl.appendChild(list);

  const bottom = document.createElement("div");
  bottom.className = "gh-bottom";

  const msg = document.createElement("div");
  msg.className = errorMessage ? "gh-status-msg error" : "gh-status-msg";
  msg.textContent = errorMessage || (status?.repo ?? "");
  bottom.appendChild(msg);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "gh-refresh-btn";
  refreshBtn.textContent = "⟳ Refresh";
  refreshBtn.disabled = !repoPath || loading;
  refreshBtn.addEventListener("click", () => {
    status = null;
    refresh();
  });
  bottom.appendChild(refreshBtn);

  panelEl.appendChild(bottom);
}
