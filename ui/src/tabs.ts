import { KEY_TABS } from "./storage-keys.ts";
import { basename } from "./path-utils.ts";

// --- Types ---

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  content: string;
  scrollTop: number;
  savedContent: string | null; // runtime-only, not serialized
}

// --- State ---

let tabs: Tab[] = [];
let activeTabId: string | null = null;
let tabBarEl: HTMLElement | null = null;
let onTabSwitch: ((tab: Tab) => void) | null = null;
let onTabEmpty: (() => void) | null = null;
let onTabOpen: ((tab: Tab) => void) | null = null;
let onTabClose: ((tab: Tab) => void) | null = null;

let nextId = 1;

function genId(): string {
  return `tab-${nextId++}`;
}

export function initTabs(
  el: HTMLElement,
  {
    onSwitch,
    onEmpty,
    onReload,
    onOpen,
    onClose,
  }: {
    onSwitch: (tab: Tab) => void;
    onEmpty: () => void;
    onReload?: (tab: Tab) => void;
    onOpen?: (tab: Tab) => void;
    onClose?: (tab: Tab) => void;
  },
): void {
  tabBarEl = el;
  onTabSwitch = onSwitch;
  onTabEmpty = onEmpty;
  onTabOpen = onOpen || null;
  onTabClose = onClose || null;

  // Restore state
  const saved = localStorage.getItem(KEY_TABS);
  if (saved) {
    try {
      const state = JSON.parse(saved);
      tabs = state.tabs || [];
      activeTabId = state.activeTabId || null;
      // Ensure IDs are unique and initialize runtime-only fields
      for (const tab of tabs) {
        const num = parseInt(tab.id?.replace("tab-", ""), 10);
        if (num >= nextId) nextId = num + 1;
        tab.savedContent = null; // will be set on reload from disk
      }
    } catch {
      // ignore
    }
  }

  renderTabs();

  // If we have tabs, activate the active one
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (activeTab) {
    // File-backed tabs with empty content need to be reloaded from disk
    if (activeTab.path && !activeTab.content && onReload) {
      onReload(activeTab);
    } else {
      onTabSwitch?.(activeTab);
    }
  }
}

function saveState(): void {
  localStorage.setItem(
    KEY_TABS,
    JSON.stringify({
      tabs: tabs.map((t) => ({
        id: t.id,
        path: t.path,
        name: t.name,
        // Skip content for file-backed tabs to avoid hitting localStorage limits
        content: t.path ? "" : t.content,
        scrollTop: t.scrollTop || 0,
      })),
      activeTabId,
    }),
  );
}

// --- Public API ---

export function openTab(path: string | null, name: string, content: string): Tab {
  // If file already open, switch to it
  if (path) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      existing.content = content;
      existing.savedContent = content;
      if (existing.id === activeTabId) {
        // Already active but content was refreshed — update the editor
        onTabSwitch?.(existing);
        renderTabs();
      } else {
        switchTab(existing.id);
      }
      return existing;
    }
  }

  const tab: Tab = {
    id: genId(),
    path: path || null,
    name: name || "Untitled",
    content: content ?? "",
    scrollTop: 0,
    savedContent: path ? (content ?? "") : null,
  };
  tabs.push(tab);
  onTabOpen?.(tab);
  switchTab(tab.id);
  return tab;
}

export function switchTab(id: string): void {
  if (id === activeTabId) {
    renderTabs();
    return;
  }
  activeTabId = id;
  saveState();
  renderTabs();
  const tab = tabs.find((t) => t.id === id);
  if (tab) onTabSwitch?.(tab);
}

export function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const closedTab = tabs[idx];
  tabs.splice(idx, 1);
  onTabClose?.(closedTab);

  if (activeTabId === id) {
    if (tabs.length > 0) {
      // Activate nearest tab
      const newIdx = Math.min(idx, tabs.length - 1);
      activeTabId = tabs[newIdx].id;
      onTabSwitch?.(tabs[newIdx]);
    } else {
      activeTabId = null;
      onTabEmpty?.();
    }
  }

  saveState();
  renderTabs();
}

export function closeActiveTab(): void {
  if (activeTabId) closeTab(activeTabId);
}

export function switchToPrevTab(): void {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const prev = (idx - 1 + tabs.length) % tabs.length;
  switchTab(tabs[prev].id);
}

export function switchToNextTab(): void {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const next = (idx + 1) % tabs.length;
  switchTab(tabs[next].id);
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function updateActiveTab({
  content,
  path,
  name,
  scrollTop,
}: {
  content?: string;
  path?: string;
  name?: string;
  scrollTop?: number;
}): void {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab) return;
  if (content !== undefined) tab.content = content;
  if (path !== undefined) tab.path = path;
  if (name !== undefined) {
    tab.name = name;
    renderTabs();
  }
  if (scrollTop !== undefined) tab.scrollTop = scrollTop;
  // Debounce localStorage writes for content-only updates
  if (content !== undefined && path === undefined && name === undefined) {
    if (saveTimeout !== null) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 1000);
  } else {
    saveState();
  }
}

export function getActiveTab(): Tab | null {
  return tabs.find((t) => t.id === activeTabId) || null;
}

export function getTabByPath(path: string): Tab | null {
  return tabs.find((t) => t.path === path) || null;
}

export function getTabs(): Tab[] {
  return tabs;
}

export function isTabDirty(tab: Tab): boolean {
  return tab.path !== null && tab.savedContent !== null && tab.content !== tab.savedContent;
}

export function markTabSaved(id: string): void {
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    tab.savedContent = tab.content;
    renderTabs();
  }
}

export function getDirtyFileTabs(): Tab[] {
  return tabs.filter(isTabDirty);
}

/** Update the path (and name) of a tab after a rename on disk. */
export function updateTabPath(oldPath: string, newPath: string): void {
  let changed = false;
  for (const tab of tabs) {
    if (!tab.path) continue;
    if (tab.path === oldPath) {
      tab.path = newPath;
      tab.name = basename(newPath);
      changed = true;
    } else if (tab.path.startsWith(oldPath + "/")) {
      tab.path = newPath + tab.path.substring(oldPath.length);
      tab.name = basename(tab.path) || tab.name;
      changed = true;
    }
  }
  if (changed) {
    renderTabs();
    saveState();
  }
}

/** Close any tab whose file was deleted. Returns closed paths. */
export function closeTabsByPath(paths: string[]): string[] {
  const closed: string[] = [];
  for (const p of paths) {
    const tab = tabs.find((t) => t.path === p);
    if (tab) {
      closed.push(p);
      closeTab(tab.id);
    }
  }
  return closed;
}

/** Close tabs whose paths are under a deleted directory. */
export function closeTabsUnderDir(dirPath: string): void {
  const prefix = dirPath + "/";
  const toClose = tabs.filter((t) => t.path && (t.path === dirPath || t.path.startsWith(prefix)));
  for (const tab of toClose) {
    closeTab(tab.id);
  }
}

// --- Drag-and-drop reorder ---

let dragTabId: string | null = null;
let dragOverTabId: string | null = null;
let dropIndicatorSide: "left" | "right" | null = null;
let didDrag = false;

function handleTabDragStart(e: DragEvent, tabId: string) {
  didDrag = true;
  dragTabId = tabId;
  e.dataTransfer!.effectAllowed = "move";
  e.dataTransfer!.setData("text/plain", tabId);
  (e.target as HTMLElement).classList.add("dragging");
}

function handleTabDragOver(e: DragEvent, tabId: string) {
  if (!dragTabId || dragTabId === tabId) {
    clearDropIndicator();
    return;
  }
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const mid = rect.left + rect.width / 2;
  const side = e.clientX < mid ? "left" : "right";
  if (dragOverTabId !== tabId || dropIndicatorSide !== side) {
    clearDropIndicator();
    dragOverTabId = tabId;
    dropIndicatorSide = side;
    (e.currentTarget as HTMLElement).classList.add(`drop-${side}`);
  }
}

function handleTabDrop(e: DragEvent, targetTabId: string) {
  e.preventDefault();
  if (!dragTabId || dragTabId === targetTabId) return;
  const fromIdx = tabs.findIndex((t) => t.id === dragTabId);
  const toIdx = tabs.findIndex((t) => t.id === targetTabId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = tabs.splice(fromIdx, 1);
  const insertIdx =
    dropIndicatorSide === "right"
      ? toIdx > fromIdx
        ? toIdx
        : toIdx + 1
      : toIdx > fromIdx
        ? toIdx - 1
        : toIdx;
  tabs.splice(Math.max(0, insertIdx), 0, moved);
  saveState();
  cleanupDrag();
  renderTabs();
}

function handleTabDragEnd() {
  cleanupDrag();
  renderTabs();
}

function clearDropIndicator() {
  if (!tabBarEl) return;
  for (const el of tabBarEl.querySelectorAll(".drop-left, .drop-right")) {
    el.classList.remove("drop-left", "drop-right");
  }
  dragOverTabId = null;
  dropIndicatorSide = null;
}

function cleanupDrag() {
  dragTabId = null;
  didDrag = false;
  clearDropIndicator();
}

// --- Render ---

function renderTabs(): void {
  if (!tabBarEl) return;
  tabBarEl.innerHTML = "";

  if (tabs.length === 0) {
    tabBarEl.classList.add("empty");
    return;
  }
  tabBarEl.classList.remove("empty");

  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab-item";
    if (tab.id === activeTabId) el.classList.add("active");
    if (isTabDirty(tab)) el.classList.add("dirty");
    el.draggable = true;

    el.addEventListener("dragstart", (e) => handleTabDragStart(e, tab.id));
    el.addEventListener("dragover", (e) => handleTabDragOver(e, tab.id));
    el.addEventListener("drop", (e) => handleTabDrop(e, tab.id));
    el.addEventListener("dragend", handleTabDragEnd);

    const nameEl = document.createElement("span");
    nameEl.className = "tab-name";
    nameEl.textContent = tab.name;
    nameEl.title = tab.path || tab.name;
    el.appendChild(nameEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close tab";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => {
      if (didDrag) {
        didDrag = false;
        return;
      }
      switchTab(tab.id);
    });

    tabBarEl.appendChild(el);
  }
}
