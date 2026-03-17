const STORAGE_KEY = "markupsidedown:tabs";

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
  }: {
    onSwitch: (tab: Tab) => void;
    onEmpty: () => void;
    onReload?: (tab: Tab) => void;
  },
): void {
  tabBarEl = el;
  onTabSwitch = onSwitch;
  onTabEmpty = onEmpty;

  // Restore state
  const saved = localStorage.getItem(STORAGE_KEY);
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
    STORAGE_KEY,
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

  tabs.splice(idx, 1);

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

    el.addEventListener("click", () => switchTab(tab.id));

    tabBarEl.appendChild(el);
  }
}
