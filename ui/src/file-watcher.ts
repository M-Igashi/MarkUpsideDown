import { watch } from "@tauri-apps/plugin-fs";
import type { WatchEvent, UnwatchFn } from "@tauri-apps/plugin-fs";
import type { Tab } from "./tabs.ts";

const { invoke } = window.__TAURI__.core;

// Active watchers: filePath -> unwatch function
const watchers = new Map<string, UnwatchFn>();

// Suppress mechanism: ignore change events triggered by our own saves
const suppressUntil = new Map<string, number>();
const SUPPRESS_WINDOW_MS = 1000;

// Per-path debounce for reload: coalesces rapid external changes (e.g. Claude Code
// writing multiple times within a second) into a single reload.
const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RELOAD_DEBOUNCE_MS = 800;

// Poll fallback: macOS FSEvents can miss events for individual file watches,
// especially with atomic writes (write temp → rename). Periodic metadata polling
// catches changes the watcher misses.
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;
let lastPolledPath: string | null = null;
let lastPolledStat: string | null = null;

interface FileStat {
  mtime_ms: number;
  size: number;
}

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

function scheduleReload(path: string) {
  const existing = reloadTimers.get(path);
  if (existing) clearTimeout(existing);
  reloadTimers.set(
    path,
    setTimeout(() => {
      reloadTimers.delete(path);
      reloadPath(path);
    }, RELOAD_DEBOUNCE_MS),
  );
}

function handleReload(event: WatchEvent) {
  for (const path of event.paths) {
    if (!path || isRecentlySuppressed(path)) continue;
    scheduleReload(path);
  }
}

function onFileChanged(event: WatchEvent) {
  const kind = event.type;

  // 'any' — generic event (common on macOS FSEvents); treat as modify
  if (kind === "any") {
    handleReload(event);
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
    handleReload(event);
  }
}

// Poll active tab's file via a cheap (mtime, size) metadata check; the
// content is only read and compared when the metadata changed.
// Uses stat_file (Tauri command) which has proper fs permissions,
// unlike plugin-fs stat() which may lack fs:allow-stat permission.
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (document.hidden) return; // skip when window is not visible
    const activeTab = deps.getActiveTab();
    const path = activeTab?.path;
    if (!path) return;
    if (isRecentlySuppressed(path)) return;

    try {
      const stat = await invoke<FileStat>("stat_file", { path });
      const statKey = `${stat.mtime_ms}:${stat.size}`;
      // Skip the full read when the file metadata hasn't changed
      if (path === lastPolledPath && statKey === lastPolledStat) return;
      lastPolledPath = path;
      lastPolledStat = statKey;
      const diskContent = await invoke<string>("read_text_file", { path });
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
  const timer = reloadTimers.get(filePath);
  if (timer) {
    clearTimeout(timer);
    reloadTimers.delete(filePath);
  }
}

export function stopAll() {
  for (const unwatch of watchers.values()) unwatch();
  watchers.clear();
  for (const timer of reloadTimers.values()) clearTimeout(timer);
  reloadTimers.clear();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
