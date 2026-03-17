import { watch } from "@tauri-apps/plugin-fs";
import type { WatchEvent, UnwatchFn } from "@tauri-apps/plugin-fs";
import type { Tab } from "./tabs.ts";

// Active watchers: filePath -> unwatch function
const watchers = new Map<string, UnwatchFn>();

// Suppress mechanism: ignore change events triggered by our own saves
const suppressUntil = new Map<string, number>();
const SUPPRESS_WINDOW_MS = 3000;

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

async function onFileChanged(event: WatchEvent) {
  // Only react to modify events
  const kind = event.type;
  if (typeof kind !== "object" || !("modify" in kind)) return;

  for (const path of event.paths) {
    if (!path || isRecentlySuppressed(path)) continue;

    const tab = deps.getTabByPath(path);
    if (!tab) continue;

    if (deps.isTabDirty(tab)) {
      const shouldReload = await deps.confirmReload(path);
      if (!shouldReload) continue;
    }

    await deps.reloadTab(path);
  }
}

export async function startWatching(filePath: string) {
  if (watchers.has(filePath)) return;
  try {
    const unwatch = await watch(filePath, onFileChanged, { delayMs: 500 });
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
}
