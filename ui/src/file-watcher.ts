import { watch } from "@tauri-apps/plugin-fs";
import type { WatchEvent, UnwatchFn } from "@tauri-apps/plugin-fs";
import type { Tab } from "./tabs.ts";

const { invoke } = window.__TAURI__.core;

// Active watchers: filePath -> unwatch function
const watchers = new Map<string, UnwatchFn>();

// Suppress mechanism: ignore change events triggered by our own saves
const suppressUntil = new Map<string, number>();
const SUPPRESS_WINDOW_MS = 1000;

// Poll fallback: macOS FSEvents can miss events for individual file watches,
// especially with atomic writes (write temp → rename). Periodic content polling
// catches changes the watcher misses.
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;
let lastPolledPath: string | null = null;
let lastPolledContent: string | null = null;

// Dependencies injected via init
let deps: {
  getTabByPath: (path: string) => Tab | null;
  getActiveTab: () => Tab | null;
  isTabDirty: (tab: Tab) => boolean;
  reloadTab: (path: string) => Promise<void>;
  confirmReload: (path: string) => Promise<boolean>;
  onFileDeleted?: (path: string) => void;
};

export function initFileWatcher(d: typeof deps) {
  deps = d;
  startPolling();
}

export function suppressNext(filePath: string) {
  suppressUntil.set(filePath, Date.now() + SUPPRESS_WINDOW_MS);
}

function isRecentlySuppressed(filePath: string): boolean {
  const until = suppressUntil.get(filePath);
  if (until && Date.now() < until) return true;
  suppressUntil.delete(filePath);
  return false;
}

async function reloadPath(path: string) {
  const tab = deps.getTabByPath(path);
  if (!tab) return;

  if (deps.isTabDirty(tab)) {
    const shouldReload = await deps.confirmReload(path);
    if (!shouldReload) return;
  }

  await deps.reloadTab(path);
}

async function handleReload(event: WatchEvent) {
  for (const path of event.paths) {
    if (!path || isRecentlySuppressed(path)) continue;
    await reloadPath(path);
  }
}

async function onFileChanged(event: WatchEvent) {
  const kind = event.type;

  // 'any' — generic event (common on macOS FSEvents); treat as modify
  if (kind === "any") {
    await handleReload(event);
    return;
  }

  if (typeof kind !== "object") return;

  // Handle file removal — close the tab for deleted files
  if ("remove" in kind) {
    for (const path of event.paths) {
      if (!path) continue;
      const tab = deps.getTabByPath(path);
      if (tab) deps.onFileDeleted?.(path);
    }
    return;
  }

  // React to modify and create events
  // Create events cover atomic writes (write temp file → rename over original)
  // used by most editors (Vim, Zed, sed -i) and tools (Claude Code Edit)
  if ("modify" in kind || "create" in kind) {
    await handleReload(event);
  }
}

// Poll active tab's file by reading content and comparing with savedContent.
// Uses read_text_file (Tauri command) which has proper fs permissions,
// unlike stat() which may lack fs:allow-stat permission.
// Caches last-read disk content to avoid triggering reload when nothing changed.
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (document.hidden) return; // skip when window is not visible
    const activeTab = deps.getActiveTab();
    const path = activeTab?.path;
    if (!path) return;
    if (isRecentlySuppressed(path)) return;

    try {
      const diskContent = await invoke<string>("read_text_file", { path });
      // Skip if disk content hasn't changed since last poll
      if (path === lastPolledPath && diskContent === lastPolledContent) return;
      lastPolledPath = path;
      lastPolledContent = diskContent;
      if (activeTab.savedContent !== null && diskContent !== activeTab.savedContent) {
        await reloadPath(path);
      }
    } catch {
      // File may have been deleted — watcher handles removal
    }
  }, POLL_INTERVAL_MS);
}

export async function startWatching(filePath: string) {
  if (watchers.has(filePath)) return;
  try {
    const unwatch = await watch(filePath, onFileChanged, { delayMs: 50 });
    watchers.set(filePath, unwatch);
  } catch {
    // Watch may fail for some paths — silently ignore
  }
}

export function stopWatching(filePath: string) {
  const unwatch = watchers.get(filePath);
  if (unwatch) {
    unwatch();
    watchers.delete(filePath);
  }
}

export function stopAll() {
  for (const unwatch of watchers.values()) unwatch();
  watchers.clear();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
