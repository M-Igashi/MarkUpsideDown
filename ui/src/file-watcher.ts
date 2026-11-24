import type { Tab } from "./tabs.ts";

const { invoke } = window.__TAURI__.core;

// Suppress mechanism: ignore change events triggered by our own saves
const suppressUntil = new Map<string, number>();
const SUPPRESS_WINDOW_MS = 1000;

// External changes are detected by polling the active tab's file metadata.
// Other tabs are checked when they become active.
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;
// Last seen `mtime:size` per path, so unchanged files are not re-read
const statKeys = new Map<string, string>();

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
};

export function initFileWatcher(d: typeof deps) {
  deps = d;
  startPolling();
}

export function suppressNext(filePath: string) {
  suppressUntil.set(filePath, Date.now() + SUPPRESS_WINDOW_MS);
}

/** True while a path is inside the window opened by `suppressNext` (the app just wrote it). */
function isRecentlySuppressed(filePath: string): boolean {
  const until = suppressUntil.get(filePath);
  if (until && Date.now() < until) return true;
  suppressUntil.delete(filePath);
  return false;
}

// True while the "modified externally" prompt is open; auto-save waits so it
// cannot overwrite the external change the user is being asked about.
let reloadPromptOpen = false;

export function isReloadPromptOpen(): boolean {
  return reloadPromptOpen;
}

async function reloadPath(path: string) {
  const tab = deps.getTabByPath(path);
  if (!tab) return;

  if (deps.isTabDirty(tab)) {
    reloadPromptOpen = true;
    try {
      if (!(await deps.confirmReload(path))) return;
    } finally {
      reloadPromptOpen = false;
    }
  }

  await deps.reloadTab(path);
}

/**
 * Reload a tab whose file changed on disk, asking first if it has unsaved
 * edits. A cheap (mtime, size) check gates the read, so an unchanged file
 * is never re-read.
 */
export async function checkExternalChange(tab: Tab) {
  const path = tab.path;
  if (!path || tab.savedContent === null || isRecentlySuppressed(path)) return;
  try {
    const stat = await invoke<FileStat>("stat_file", { path });
    const statKey = `${stat.mtime_ms}:${stat.size}`;
    if (statKeys.get(path) === statKey) return;
    statKeys.set(path, statKey);
    const diskContent = await invoke<string>("read_text_file", { path });
    if (tab.savedContent !== null && diskContent !== tab.savedContent) await reloadPath(path);
  } catch {
    // File may have been deleted; the tab stays open
  }
}

// Poll the active tab; other tabs are checked by the caller when they become active.
function startPolling() {
  pollTimer = setInterval(() => {
    if (document.hidden) return; // skip when window is not visible
    const activeTab = deps.getActiveTab();
    if (activeTab) checkExternalChange(activeTab);
  }, POLL_INTERVAL_MS);
}

export function stopFileWatcher() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
