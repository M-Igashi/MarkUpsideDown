import type { Tab } from "./tabs.ts";

const { invoke } = window.__TAURI__.core;

// Suppress mechanism: ignore change events triggered by our own saves
const suppressUntil = new Map<string, number>();
const SUPPRESS_WINDOW_MS = 1000;

// External changes are detected by polling the active tab's file metadata.
// Other tabs are checked when they become active.
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
};

export function initFileWatcher(d: typeof deps) {
  deps = d;
  startPolling();
}

export function suppressNext(filePath: string) {
  suppressUntil.set(filePath, Date.now() + SUPPRESS_WINDOW_MS);
}

/** True while a path is inside the window opened by `suppressNext` (the app just wrote it). */
export function isRecentlySuppressed(filePath: string): boolean {
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

// Poll active tab's file via a cheap (mtime, size) metadata check; the
// content is only read and compared when the metadata changed.
// Uses stat_file (Tauri command) which has proper fs permissions,
// unlike plugin-fs stat() which may lack fs:allow-stat permission.
function startPolling() {
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
      // File may have been deleted; the tab stays open
    }
  }, POLL_INTERVAL_MS);
}

export function stopFileWatcher() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
