import { createGitBadge, applyGitNameStyle } from "./git-panel.ts";
import { IMPORT_EXTENSIONS, convertFile } from "./file-ops.ts";
import { basename, dirname } from "./path-utils.ts";
import { escapeHtml } from "./html-utils.ts";
import { watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { KEY_SIDEBAR, KEY_SIDEBAR_SORT, KEY_SIDEBAR_PANEL } from "./storage-keys.ts";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open: openDialog, confirm, message } = window.__TAURI__.dialog;

function promptInput(label: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "prompt-overlay";
    const box = document.createElement("div");
    box.className = "prompt-box";
    box.innerHTML = `
      <label>${label}</label>
      <input type="text" value="${escapeHtml(defaultValue)}" />
      <div class="prompt-buttons">
        <button class="prompt-cancel">Cancel</button>
        <button class="prompt-ok">OK</button>
      </div>`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const input = box.querySelector("input")!;
    input.select();
    input.focus();
    const close = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };
    box.querySelector(".prompt-cancel")!.addEventListener("click", () => close(null));
    box.querySelector(".prompt-ok")!.addEventListener("click", () => close(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value);
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  extension: string | null;
  modified_at: number | null;
}

interface GitStatus {
  status: string;
  staged: boolean;
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
export const SIDEBAR_IMAGE_MIME = "application/x-sidebar-image";

// --- State ---

let rootPath: string | null = null;
let expandedDirs = new Set<string>();
let selectedPaths = new Set<string>();
let anchorPath: string | null = null;
let onFileOpen: ((content: string, filePath: string) => void) | null = null;
let onFolderChange: ((rootPath: string) => void) | null = null;
let onSidebarFold: (() => void) | null = null;
let onExternalChange: (() => void) | null = null;
let onEntryRename: ((oldPath: string, newPath: string) => void) | null = null;
let onEntryDelete: ((paths: string[], hadDir: boolean) => void) | null = null;
let gitStatusMap: Map<string, GitStatus> = new Map();
let refreshGeneration = 0; // guards against concurrent refreshTree() races
let filterQuery = "";
let filterScope: string | null = null; // null = global, path = scoped to folder
let dragSourcePaths = new Set<string>();
let clipboardPaths = new Set<string>();
let clipboardMode: "cut" | "copy" | null = null;
let dirWatcherUnwatch: UnwatchFn | null = null;
let dirWatchDebounce: ReturnType<typeof setTimeout> | null = null;

// --- Selection helpers ---

function primarySelectedPath(): string | null {
  if (selectedPaths.size === 0) return null;
  if (anchorPath && selectedPaths.has(anchorPath)) return anchorPath;
  return [...selectedPaths][selectedPaths.size - 1];
}

function selectSingle(path: string) {
  selectedPaths.clear();
  selectedPaths.add(path);
  anchorPath = path;
  updateSelectionDOM();
}

function toggleSelect(path: string) {
  if (selectedPaths.has(path)) {
    selectedPaths.delete(path);
  } else {
    selectedPaths.add(path);
  }
  anchorPath = path;
  updateSelectionDOM();
}

function selectRange(toPath: string) {
  const items = getVisibleItems();
  const anchorIdx = items.findIndex((el) => el.dataset.path === anchorPath);
  const toIdx = items.findIndex((el) => el.dataset.path === toPath);
  if (anchorIdx < 0 || toIdx < 0) {
    selectSingle(toPath);
    return;
  }
  const start = Math.min(anchorIdx, toIdx);
  const end = Math.max(anchorIdx, toIdx);
  selectedPaths.clear();
  for (let i = start; i <= end; i++) {
    const p = items[i].dataset.path;
    if (p) selectedPaths.add(p);
  }
  // anchorPath stays unchanged for range extension
  updateSelectionDOM();
}

function updateSelectionDOM() {
  if (!treeEl) return;
  for (const el of treeEl.querySelectorAll(".sidebar-tree-item") as NodeListOf<HTMLElement>) {
    el.classList.toggle("selected", selectedPaths.has(el.dataset.path ?? ""));
  }
}

type SortBy = "name" | "date" | "type";
let sortBy: SortBy = (localStorage.getItem(KEY_SIDEBAR_SORT) as SortBy) || "name";

export type SidebarPanel = "files" | "git" | "clone";
let activePanel: SidebarPanel = "files";

// --- DOM ---

let sidebarEl: HTMLElement | null = null;
let treeEl: HTMLElement | null = null;
let gitPanelSlot: HTMLElement | null = null;
let clonePanelSlot: HTMLElement | null = null;
let filesContainer: HTMLElement | null = null;
let navBar: HTMLElement | null = null;
let gitChangeCount = 0;

export function initSidebar(
  el: HTMLElement,
  {
    onOpen,
    onFolder,
    onFold,
    onDirChange,
    onRename,
    onDelete,
  }: {
    onOpen: (content: string, filePath: string) => void;
    onFolder: (rootPath: string) => void;
    onFold?: () => void;
    onDirChange?: () => void;
    onRename?: (oldPath: string, newPath: string) => void;
    onDelete?: (paths: string[], hadDir: boolean) => void;
  },
) {
  sidebarEl = el;
  onFileOpen = onOpen;
  onFolderChange = onFolder;
  onSidebarFold = onFold ?? null;
  onExternalChange = onDirChange ?? null;
  onEntryRename = onRename ?? null;
  onEntryDelete = onDelete ?? null;

  // Restore state
  const saved = localStorage.getItem(KEY_SIDEBAR);
  if (saved) {
    try {
      const state = JSON.parse(saved);
      rootPath = state.rootPath || null;
      expandedDirs = new Set(state.expandedDirs || []);
    } catch {
      // ignore
    }
  }

  // Restore active panel
  const savedPanel = localStorage.getItem(KEY_SIDEBAR_PANEL);
  if (savedPanel === "files" || savedPanel === "git" || savedPanel === "clone") {
    activePanel = savedPanel;
  }

  render();

  if (rootPath) {
    refreshTree();
    startDirWatcher();
  }
}

function saveState() {
  localStorage.setItem(
    KEY_SIDEBAR,
    JSON.stringify({
      rootPath,
      expandedDirs: [...expandedDirs],
    }),
  );
}

export async function openFolder() {
  const path = await openDialog({ directory: true });
  if (!path) return;
  rootPath = path;
  expandedDirs.clear();
  expandedDirs.add(rootPath);
  saveState();
  render();
  refreshTree();
  startDirWatcher();
  onFolderChange?.(rootPath);
}

// --- Render ---

function populateHeaderActions(container: Element) {
  if (activePanel === "files") {
    const openBtn = document.createElement("button");
    openBtn.title = "Open Folder";
    openBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13V3a1 1 0 011-1h4l2 2h4a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>';
    openBtn.addEventListener("click", openFolder);
    container.appendChild(openBtn);
  }
}

function updateFilterScopeBadge() {
  const badge = document.getElementById("sidebar-filter-scope");
  if (!badge) return;
  if (!filterScope) {
    badge.style.display = "none";
    badge.innerHTML = "";
    return;
  }
  const folderName = basename(filterScope);
  badge.style.display = "flex";
  badge.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = `in: ${folderName}`;
  badge.appendChild(label);
  const clearBtn = document.createElement("button");
  clearBtn.className = "sidebar-filter-scope-clear";
  clearBtn.textContent = "✕";
  clearBtn.title = "Clear scope";
  clearBtn.addEventListener("click", () => {
    filterScope = null;
    updateFilterScopeBadge();
    refreshTree();
  });
  badge.appendChild(clearBtn);
}

function findInFolder(dirPath: string) {
  filterScope = dirPath;
  updateFilterScopeBadge();
  // Focus the search input
  const input = filesContainer?.querySelector(".sidebar-search-input") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
  }
  if (filterQuery) refreshTree();
}

function render() {
  if (!sidebarEl) return;
  sidebarEl.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "sidebar-header";

  const title = document.createElement("span");
  title.className = "sidebar-title";
  title.textContent = panelTitle();
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "sidebar-header-actions";

  populateHeaderActions(actions);

  const foldBtn = document.createElement("button");
  foldBtn.className = "panel-fold-btn";
  foldBtn.title = "Collapse Sidebar (⌘1)";
  foldBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3 5 7l4 4"/></svg>`;
  foldBtn.addEventListener("click", () => onSidebarFold?.());
  actions.appendChild(foldBtn);

  header.appendChild(actions);
  sidebarEl.appendChild(header);

  // Files panel (tree container)
  filesContainer = document.createElement("div");
  filesContainer.className = "sidebar-panel-content";

  // Search/filter input
  const searchWrap = document.createElement("div");
  searchWrap.className = "sidebar-search";
  const searchInput = document.createElement("input");
  searchInput.className = "sidebar-search-input";
  searchInput.type = "text";
  searchInput.placeholder = "Filter files…";
  searchInput.value = filterQuery;
  let filterTimeout: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener("input", () => {
    if (filterTimeout) clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => {
      filterQuery = searchInput.value.trim().toLowerCase();
      refreshTree();
    }, 150);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      filterQuery = "";
      filterScope = null;
      updateFilterScopeBadge();
      refreshTree();
    }
  });
  searchWrap.appendChild(searchInput);

  const sortSelect = document.createElement("select");
  sortSelect.className = "sidebar-sort-select";
  sortSelect.title = "Sort files by…";
  for (const [value, label] of [
    ["name", "Name"],
    ["date", "Date"],
    ["type", "Type"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === sortBy) opt.selected = true;
    sortSelect.appendChild(opt);
  }
  sortSelect.addEventListener("change", () => {
    sortBy = sortSelect.value as SortBy;
    localStorage.setItem(KEY_SIDEBAR_SORT, sortBy);
    refreshTree();
  });
  searchWrap.appendChild(sortSelect);

  filesContainer.appendChild(searchWrap);

  // Filter scope badge (shown when scoped to a folder)
  const scopeBadge = document.createElement("div");
  scopeBadge.className = "sidebar-filter-scope";
  scopeBadge.id = "sidebar-filter-scope";
  filesContainer.appendChild(scopeBadge);
  updateFilterScopeBadge();

  treeEl = document.createElement("div");
  treeEl.className = "sidebar-tree";
  treeEl.addEventListener("keydown", handleTreeKeydown);
  treeEl.addEventListener("contextmenu", (e) => {
    // Only handle clicks on the tree background, not on items
    const target = e.target as HTMLElement;
    if (target.closest(".sidebar-tree-item")) return;
    if (!rootPath) return;
    e.preventDefault();
    showEmptyAreaContextMenu(e);
  });

  // File drop on tree background (drops into root — both external and internal)
  treeEl.addEventListener("dragover", (e) => {
    if (!rootPath) return;
    const isExternal = e.dataTransfer?.types.includes("Files");
    const isInternal = dragSourcePaths.size > 0;
    if (!isExternal && !isInternal) return;
    // Don't highlight tree root when hovering over a folder/file item
    if ((e.target as HTMLElement).closest(".sidebar-tree-item")) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = isExternal ? "copy" : "move";
    treeEl!.classList.add("drop-target-root");
  });
  treeEl.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || !treeEl!.contains(e.relatedTarget as Node)) {
      treeEl!.classList.remove("drop-target-root");
    }
  });
  treeEl.addEventListener("drop", (e) => {
    treeEl!.classList.remove("drop-target-root");
    if (!rootPath) return;
    // Don't handle here if a folder item already handled it
    if ((e.target as HTMLElement).closest(".sidebar-tree-item[data-is-dir='true']")) return;
    e.preventDefault();
    // External file drop (from Finder)
    if (e.dataTransfer?.types.includes("Files") && e.dataTransfer.files.length > 0) {
      handleExternalFileDrop(e.dataTransfer.files, rootPath);
      return;
    }
    // Internal file/folder move to root
    if (dragSourcePaths.size > 0) {
      moveEntries(dragSourcePaths, rootPath);
      dragSourcePaths.clear();
    }
  });

  if (!rootPath) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Open a folder to browse files";
    treeEl.appendChild(empty);
  }

  filesContainer.appendChild(treeEl);
  sidebarEl.appendChild(filesContainer);

  // Git panel slot — reuse existing element to preserve panelEl references in git-panel.ts
  if (!gitPanelSlot) {
    gitPanelSlot = document.createElement("div");
    gitPanelSlot.id = "git-panel";
    gitPanelSlot.className = "sidebar-panel-content";
  }
  sidebarEl.appendChild(gitPanelSlot);

  // Clone panel slot — reuse existing element
  if (!clonePanelSlot) {
    clonePanelSlot = document.createElement("div");
    clonePanelSlot.id = "clone-panel";
    clonePanelSlot.className = "sidebar-panel-content";
  }
  sidebarEl.appendChild(clonePanelSlot);

  // Bottom nav bar
  navBar = document.createElement("div");
  navBar.className = "sidebar-nav";
  navBar.appendChild(createNavButton("files", "Files", SVG_FILES));
  navBar.appendChild(createNavButton("git", "Git", SVG_GIT));
  navBar.appendChild(createNavButton("clone", "Clone", SVG_CLONE));
  sidebarEl.appendChild(navBar);

  updatePanelVisibility();
}

function panelTitle(): string {
  switch (activePanel) {
    case "files":
      return rootPath ? basename(rootPath) : "Files";
    case "git":
      return "Source Control";
    case "clone":
      return "Clone Repository";
  }
}

// SVG icons (16x16, stroke-based for consistency)
const SVG_FILES = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h4l2 2h6v9H2V2z"/><path d="M2 5h12"/></svg>`;
const SVG_GIT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M8 5v6"/><path d="M9.4 4.2 11 6.5"/></svg>`;
const SVG_CLONE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8"/><path d="M5 7l3 3 3-3"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2"/></svg>`;

function syncGitBadge(btn: Element, count: number) {
  const existing = btn.querySelector(".sidebar-nav-badge");
  if (existing) existing.remove();
  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "sidebar-nav-badge";
    badge.textContent = String(count);
    btn.appendChild(badge);
  }
}

function createNavButton(panel: SidebarPanel, label: string, svgIcon: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "sidebar-nav-btn";
  btn.dataset.panel = panel;
  if (panel === activePanel) btn.classList.add("active");
  btn.title = label;
  btn.innerHTML = svgIcon;

  if (panel === "git") syncGitBadge(btn, gitChangeCount);

  btn.addEventListener("click", () => switchPanel(panel));
  return btn;
}

export function switchPanel(panel: SidebarPanel) {
  activePanel = panel;
  localStorage.setItem(KEY_SIDEBAR_PANEL, panel);
  // Update header title
  const titleEl = sidebarEl?.querySelector(".sidebar-title");
  if (titleEl) titleEl.textContent = panelTitle();
  // Update header actions (preserve fold button)
  const actionsEl = sidebarEl?.querySelector(".sidebar-header-actions");
  if (actionsEl) {
    // Keep fold button, rebuild only panel-specific actions
    const foldBtn = actionsEl.querySelector(".panel-fold-btn");
    actionsEl.innerHTML = "";
    populateHeaderActions(actionsEl);
    if (foldBtn) actionsEl.appendChild(foldBtn);
  }
  updatePanelVisibility();
  updateNavButtons();
}

function updatePanelVisibility() {
  if (filesContainer) filesContainer.style.display = activePanel === "files" ? "" : "none";
  if (gitPanelSlot) gitPanelSlot.style.display = activePanel === "git" ? "" : "none";
  if (clonePanelSlot) clonePanelSlot.style.display = activePanel === "clone" ? "" : "none";
}

function updateNavButtons() {
  if (!navBar) return;
  for (const btn of navBar.querySelectorAll(".sidebar-nav-btn") as NodeListOf<HTMLElement>) {
    btn.classList.toggle("active", btn.dataset.panel === activePanel);
    if (btn.dataset.panel === "git") syncGitBadge(btn, gitChangeCount);
  }
}

export function updateGitChangeCount(count: number) {
  gitChangeCount = count;
  if (!navBar) return;
  const gitBtn = navBar.querySelector('.sidebar-nav-btn[data-panel="git"]');
  if (gitBtn) syncGitBadge(gitBtn, count);
}

export function getGitPanelEl() {
  return gitPanelSlot;
}

export function getClonePanelEl() {
  return clonePanelSlot;
}

export function openFolderByPath(path: string) {
  rootPath = path;
  expandedDirs.clear();
  expandedDirs.add(rootPath);
  saveState();
  render();
  refreshTree();
  startDirWatcher();
  onFolderChange?.(rootPath);
}

async function startDirWatcher() {
  stopDirWatcher();
  if (!rootPath) return;
  try {
    dirWatcherUnwatch = await watch(
      rootPath,
      () => {
        // Debounce to avoid rapid-fire refreshes
        if (dirWatchDebounce) clearTimeout(dirWatchDebounce);
        dirWatchDebounce = setTimeout(() => {
          refreshTree();
          onExternalChange?.();
        }, 500);
      },
      { recursive: true, delayMs: 200 },
    );
  } catch {
    // Watch may not be supported for some paths
  }
}

export function stopDirWatcher() {
  if (dirWatcherUnwatch) {
    dirWatcherUnwatch();
    dirWatcherUnwatch = null;
  }
  if (dirWatchDebounce) {
    clearTimeout(dirWatchDebounce);
    dirWatchDebounce = null;
  }
}

export async function refreshTree() {
  if (!rootPath || !treeEl) return;

  const gen = ++refreshGeneration;

  // Build a completely new tree element off-DOM
  const newTree = document.createElement("div");
  newTree.className = "sidebar-tree";

  try {
    await renderDirectory(rootPath, newTree, 0, gen);
  } catch (e) {
    if (gen !== refreshGeneration) return;
    const err = document.createElement("div");
    err.className = "sidebar-error";
    err.textContent = `Error: ${e}`;
    newTree.appendChild(err);
  }

  // Stale render — discard
  if (gen !== refreshGeneration) return;

  // Atomic swap: replace old tree element with new one.
  // Re-attach listeners lost by replaceWith.
  const suppressNativeDrag = (e: DragEvent) => {
    if (dragSourcePaths.size > 0) e.preventDefault();
  };
  newTree.addEventListener("dragenter", suppressNativeDrag);
  newTree.addEventListener("dragover", suppressNativeDrag);
  newTree.addEventListener("drop", (e) => {
    if (dragSourcePaths.size === 0) return;
    e.preventDefault();
    // Resolve target folder: if dropped inside an expanded folder's children area,
    // find the parent folder item (the sibling before .sidebar-tree-children).
    const target = e.target as HTMLElement;
    const childrenContainer = target.closest(".sidebar-tree-children");
    let targetDir = rootPath;
    if (childrenContainer) {
      const folderItem = childrenContainer.previousElementSibling as HTMLElement | null;
      if (folderItem?.dataset.path) targetDir = folderItem.dataset.path;
    }
    if (targetDir) {
      moveEntries(dragSourcePaths, targetDir);
      dragSourcePaths.clear();
    }
  });
  newTree.addEventListener("keydown", handleTreeKeydown);
  treeEl.replaceWith(newTree);
  treeEl = newTree;
}

async function renderDirectory(
  dirPath: string,
  container: HTMLElement,
  depth: number,
  gen: number,
): Promise<boolean> {
  const entries = await invoke<DirEntry[]>("list_directory", {
    path: dirPath,
    repoRoot: rootPath,
  });
  if (gen !== refreshGeneration) return false;

  // Sort entries by user preference (directories always first)
  if (sortBy === "date") {
    entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return (b.modified_at ?? 0) - (a.modified_at ?? 0);
    });
  } else if (sortBy === "type") {
    entries.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      const extA = a.extension ?? "";
      const extB = b.extension ?? "";
      if (extA !== extB) return extA.localeCompare(extB);
      return a.name.localeCompare(b.name);
    });
  }
  // "name" sort is already done by the Rust backend

  // Deduplicate by path (safety net)
  const seen = new Set<string>();
  // When scoped, only filter within the target directory (and its children)
  const inScope = !filterScope || dirPath === filterScope || dirPath.startsWith(filterScope + "/");
  const isFiltering = filterQuery.length > 0 && (!filterScope || inScope);

  // When filtering, we need to recurse into all directories to find matches
  // Collect items and expanded children
  const pendingItems: { entry: DirEntry; item: HTMLElement; childContainer?: HTMLElement }[] = [];

  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);

    if (entry.is_dir) {
      // Auto-fold: detect chain of single-child directories
      let foldedEntry = entry;
      let displayName = entry.name;

      if (!isFiltering) {
        let folding = true;
        while (folding) {
          const subEntries = await invoke<DirEntry[]>("list_directory", {
            path: foldedEntry.path,
            repoRoot: rootPath,
          });
          if (gen !== refreshGeneration) return false;
          const subDirs = subEntries.filter((e) => e.is_dir);
          const subFiles = subEntries.filter((e) => !e.is_dir);
          if (subDirs.length === 1 && subFiles.length === 0) {
            // Migrate expanded state from intermediate path to final path
            if (expandedDirs.has(foldedEntry.path) && !expandedDirs.has(subDirs[0].path)) {
              expandedDirs.add(subDirs[0].path);
              expandedDirs.delete(foldedEntry.path);
            }
            displayName += "/" + subDirs[0].name;
            foldedEntry = subDirs[0];
          } else {
            folding = false;
          }
        }
      }

      const item = createTreeItem(foldedEntry, depth, displayName);
      const childContainer = document.createElement("div");
      childContainer.className = "sidebar-tree-children";
      pendingItems.push({ entry: foldedEntry, item, childContainer });
    } else {
      if (isFiltering && !entry.name.toLowerCase().includes(filterQuery)) continue;
      const item = createTreeItem(entry, depth);
      pendingItems.push({ entry, item });
    }
  }

  // Recurse into directories (expanded ones always, all when filtering)
  const dirItems = pendingItems.filter((p) => p.entry.is_dir && p.childContainer);
  let dirHasMatch: Map<string, boolean> = new Map();
  if (dirItems.length > 0) {
    const results = await Promise.all(
      dirItems.map(async ({ entry, childContainer }) => {
        const shouldExpand = isFiltering || expandedDirs.has(entry.path);
        if (!shouldExpand) return false;
        return renderDirectory(entry.path, childContainer!, depth + 1, gen);
      }),
    );
    dirItems.forEach(({ entry }, i) => {
      dirHasMatch.set(entry.path, results[i]);
    });
  }
  if (gen !== refreshGeneration) return false;

  // Append items to container, skipping filtered-out directories
  let hasAnyMatch = false;
  for (const { entry, item, childContainer } of pendingItems) {
    if (entry.is_dir && isFiltering) {
      const nameMatch = entry.name.toLowerCase().includes(filterQuery);
      const childMatch = dirHasMatch.get(entry.path) ?? false;
      if (!nameMatch && !childMatch) continue;
    }
    container.appendChild(item);
    if (entry.is_dir && childContainer && (isFiltering || expandedDirs.has(entry.path))) {
      container.appendChild(childContainer);
    }
    hasAnyMatch = true;
  }

  return hasAnyMatch;
}

function createTreeItem(entry: DirEntry, depth: number, displayName?: string) {
  const item = document.createElement("div");
  item.className = "sidebar-tree-item";
  item.dataset.path = entry.path;
  if (entry.is_dir) item.dataset.isDir = "true";
  item.tabIndex = -1;
  if (selectedPaths.has(entry.path)) {
    item.classList.add("selected");
  }
  item.style.paddingLeft = `${8 + depth * 16}px`;

  // Indent guides
  for (let i = 1; i <= depth; i++) {
    const guide = document.createElement("span");
    guide.className = "sidebar-indent-guide";
    guide.style.left = `${8 + (i - 1) * 16 + 4}px`;
    item.appendChild(guide);
  }

  // Expand/collapse indicator for directories
  const indicator = document.createElement("span");
  indicator.className = "sidebar-tree-indicator";
  if (entry.is_dir) {
    indicator.textContent = expandedDirs.has(entry.path) ? "▾" : "▸";
  }
  item.appendChild(indicator);

  // Icon
  const icon = document.createElement("span");
  icon.className = "sidebar-tree-icon";
  icon.textContent = entry.is_dir ? "📁" : fileIcon(entry.extension ?? "");
  item.appendChild(icon);

  // Name
  const name = document.createElement("span");
  name.className = "sidebar-tree-name";
  if (entry.is_dir) name.classList.add("is-dir");
  name.textContent = displayName ?? entry.name;
  item.appendChild(name);

  // Git status indicator
  const relPath = rootPath ? entry.path.replace(rootPath + "/", "") : entry.name;
  const gitStatus = gitStatusMap.get(relPath);
  if (gitStatus) {
    item.appendChild(createGitBadge(gitStatus.status));
    applyGitNameStyle(name, gitStatus.status);
  }

  // Drag-and-drop for file/folder move
  item.draggable = true;
  item.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    if (selectedPaths.has(entry.path) && selectedPaths.size > 1) {
      dragSourcePaths = new Set(selectedPaths);
    } else {
      dragSourcePaths = new Set([entry.path]);
    }
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", [...dragSourcePaths].join("\n"));
    // Mark single image files so the editor can detect image drops
    const ext = (entry.extension ?? "").toLowerCase();
    if (!entry.is_dir && IMAGE_EXTENSIONS.has(ext) && dragSourcePaths.size === 1) {
      e.dataTransfer!.effectAllowed = "copyMove";
      e.dataTransfer!.setData(SIDEBAR_IMAGE_MIME, entry.path);
      // Use a thumbnail as drag image
      const thumb = document.createElement("img");
      thumb.src = convertFileSrc(entry.path);
      thumb.style.cssText =
        "width:48px;height:48px;object-fit:cover;border-radius:4px;position:fixed;top:-200px";
      document.body.appendChild(thumb);
      e.dataTransfer!.setDragImage(thumb, 24, 24);
      requestAnimationFrame(() => thumb.remove());
    }
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    dragSourcePaths.clear();
    clearTreeDropTarget();
  });
  if (entry.is_dir) {
    const isDragBlocked = () => {
      if (dragSourcePaths.size === 0) return true;
      if (dragSourcePaths.has(entry.path)) return true;
      for (const src of dragSourcePaths) {
        if (entry.path.startsWith(src + "/")) return true;
      }
      return false;
    };
    // WebKit requires preventDefault() on both dragenter and dragover for drop to work
    item.addEventListener("dragenter", (e) => {
      const isExternal = e.dataTransfer?.types.includes("Files");
      if (!isExternal && isDragBlocked()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = isExternal ? "copy" : "move";
      clearTreeDropTarget();
      item.classList.add("drop-target");
    });
    item.addEventListener("dragover", (e) => {
      const isExternal = e.dataTransfer?.types.includes("Files");
      if (!isExternal && isDragBlocked()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = isExternal ? "copy" : "move";
    });
    item.addEventListener("dragleave", (e) => {
      // Only remove highlight when leaving the item itself, not its children
      if (e.relatedTarget && item.contains(e.relatedTarget as Node)) return;
      item.classList.remove("drop-target");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("drop-target");
      if (e.dataTransfer?.types.includes("Files") && e.dataTransfer.files.length > 0) {
        handleExternalFileDrop(e.dataTransfer.files, entry.path);
        return;
      }
      if (dragSourcePaths.size === 0) return;
      moveEntries(dragSourcePaths, entry.path);
      dragSourcePaths.clear();
    });
  }

  // Click handler
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.metaKey) {
      toggleSelect(entry.path);
      item.focus();
    } else if (e.shiftKey) {
      selectRange(entry.path);
      item.focus();
    } else {
      selectSingle(entry.path);
      item.focus();
      if (entry.is_dir) {
        toggleDirectory(entry.path);
      } else {
        selectAndOpenFile(entry);
      }
    }
  });

  // Context menu
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedPaths.has(entry.path)) {
      selectSingle(entry.path);
    }
    if (selectedPaths.size > 1) {
      showMultiContextMenu(e);
    } else {
      showContextMenu(e, entry);
    }
  });

  // Image hover thumbnail preview
  const ext = (entry.extension ?? "").toLowerCase();
  if (!entry.is_dir && IMAGE_EXTENSIONS.has(ext)) {
    let tooltip: HTMLElement | null = null;
    item.addEventListener("mouseenter", () => {
      tooltip = document.createElement("div");
      tooltip.className = "sidebar-image-tooltip";
      const img = document.createElement("img");
      img.src = convertFileSrc(entry.path);
      tooltip.appendChild(img);
      document.body.appendChild(tooltip);
      const rect = item.getBoundingClientRect();
      tooltip.style.top = `${rect.top}px`;
      tooltip.style.left = `${rect.right + 8}px`;
    });
    item.addEventListener("mouseleave", () => {
      tooltip?.remove();
      tooltip = null;
    });
    // Remove tooltip when drag starts
    item.addEventListener("dragstart", () => {
      tooltip?.remove();
      tooltip = null;
    });
  }

  return item;
}

function fileIcon(ext: string) {
  switch (ext) {
    case "md":
    case "markdown":
    case "mdx":
      return "📝";
    case "json":
    case "toml":
    case "yaml":
    case "yml":
      return "⚙️";
    case "js":
    case "ts":
    case "rs":
    case "py":
      return "📄";
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
      return "🖼️";
    case "pdf":
      return "📕";
    default:
      return "📄";
  }
}

async function toggleDirectory(dirPath: string) {
  if (expandedDirs.has(dirPath)) {
    expandedDirs.delete(dirPath);
  } else {
    expandedDirs.add(dirPath);
  }
  saveState();
  await refreshTree();
}

async function selectAndOpenFile(entry: DirEntry) {
  selectSingle(entry.path);
  if (onFileOpen) {
    try {
      const content = await invoke<string>("read_text_file", { path: entry.path });
      onFileOpen(content, entry.path);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }
}

// --- Drag-and-drop helpers ---

function clearTreeDropTarget() {
  if (!treeEl) return;
  for (const el of treeEl.querySelectorAll(".drop-target")) {
    el.classList.remove("drop-target");
  }
}

async function moveEntries(sourcePaths: Set<string>, targetDirPath: string) {
  let anyMoved = false;
  for (const sourcePath of sourcePaths) {
    const fileName = basename(sourcePath);
    if (!fileName) continue;
    const newPath = `${targetDirPath}/${fileName}`;
    if (sourcePath === newPath) continue;
    try {
      await invoke("rename_entry", { from: sourcePath, to: newPath });
      if (selectedPaths.has(sourcePath)) {
        selectedPaths.delete(sourcePath);
        selectedPaths.add(newPath);
      }
      onEntryRename?.(sourcePath, newPath);
      anyMoved = true;
    } catch (e) {
      message(`Failed to move "${fileName}": ${e}`, { kind: "error" });
    }
  }
  if (anyMoved) {
    if (!expandedDirs.has(targetDirPath)) {
      expandedDirs.add(targetDirPath);
    }
    saveState();
    await refreshTree();
  }
}

async function handleExternalFileDrop(files: FileList, targetDir: string) {
  const MD_EXTENSIONS = ["md", "markdown", "mdx"];
  let copiedCount = 0;

  for (const file of files) {
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const targetPath = `${targetDir}/${file.name}`;

    try {
      const buffer = await file.arrayBuffer();
      const data = Array.from(new Uint8Array(buffer));
      await invoke("write_file_bytes", { path: targetPath, data });
      copiedCount++;

      // Open markdown files in editor after copy
      if (MD_EXTENSIONS.includes(ext)) {
        const content = await invoke<string>("read_text_file", { path: targetPath });
        onFileOpen?.(content, targetPath);
      } else if (IMPORT_EXTENSIONS.includes(ext)) {
        await convertFile(targetPath);
      }
    } catch (e) {
      await message(`Failed to copy "${file.name}": ${e}`, { kind: "error" });
    }
  }

  if (copiedCount > 0) {
    if (!expandedDirs.has(targetDir)) {
      expandedDirs.add(targetDir);
    }
    saveState();
    await refreshTree();
  }
}

// --- Context Menu ---

let activeContextMenu: HTMLElement | null = null;
let contextMenuCloseHandler: ((e: Event) => void) | null = null;

function removeContextMenu() {
  if (contextMenuCloseHandler) {
    document.removeEventListener("click", contextMenuCloseHandler, true);
    contextMenuCloseHandler = null;
  }
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

function showEmptyAreaContextMenu(event: MouseEvent) {
  if (!rootPath) return;
  removeContextMenu();

  const menu = document.createElement("div");
  menu.className = "sidebar-context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const items: ({ label: string; action: () => void } | null)[] = [
    { label: "New File…", action: () => promptNewFile(rootPath!) },
    { label: "New Folder…", action: () => promptNewFolder(rootPath!) },
  ];

  if (clipboardPaths.size > 0 && clipboardMode) {
    items.push(null); // separator
    items.push({ label: "Paste", action: () => pasteEntry() });
  }

  buildContextMenuDOM(menu, items);
}

function buildContextMenuDOM(
  menu: HTMLElement,
  items: ({ label: string; action: () => void; danger?: boolean } | null)[],
) {
  for (const item of items) {
    if (!item) {
      const sep = document.createElement("div");
      sep.className = "sidebar-context-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "sidebar-context-item";
    if (item.danger) btn.classList.add("danger");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      removeContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Adjust position if overflowing
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  }

  contextMenuCloseHandler = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      removeContextMenu();
    }
  };
  setTimeout(() => {
    if (contextMenuCloseHandler) {
      document.addEventListener("click", contextMenuCloseHandler, true);
    }
  }, 0);
}

function showContextMenu(event: MouseEvent, entry: DirEntry) {
  removeContextMenu();

  const menu = document.createElement("div");
  menu.className = "sidebar-context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const items: ({ label: string; action: () => void; danger?: boolean } | null)[] = [];

  const parentDir = dirname(entry.path);

  if (entry.is_dir) {
    items.push({ label: "New File…", action: () => promptNewFile(entry.path) });
    items.push({ label: "New Folder…", action: () => promptNewFolder(entry.path) });
  } else {
    items.push({ label: "New File…", action: () => promptNewFile(parentDir) });
    items.push({ label: "New Folder…", action: () => promptNewFolder(parentDir) });
  }
  items.push(null);

  if (entry.is_dir) {
    items.push({ label: "Find in Folder…", action: () => findInFolder(entry.path) });
  }
  items.push({ label: "Reveal in Finder", action: () => revealInFinder(entry.path) });
  items.push({ label: "Open in Terminal", action: () => openInTerminal(entry.path) });
  items.push(null);

  items.push({ label: "Copy Path", action: () => copyToClipboard(entry.path) });
  if (rootPath) {
    const relPath = entry.path.startsWith(rootPath + "/")
      ? entry.path.substring(rootPath.length + 1)
      : entry.name;
    items.push({ label: "Copy Relative Path", action: () => copyToClipboard(relPath) });
  }
  items.push(null);

  items.push({
    label: "Cut",
    action: () => {
      clipboardPaths = new Set([entry.path]);
      clipboardMode = "cut";
      updateClipboardStyle();
    },
  });
  items.push({
    label: "Copy",
    action: () => {
      clipboardPaths = new Set([entry.path]);
      clipboardMode = "copy";
      updateClipboardStyle();
    },
  });
  if (clipboardPaths.size > 0 && clipboardMode) {
    items.push({ label: "Paste", action: () => pasteEntry() });
  }
  items.push(null);
  items.push({ label: "Duplicate", action: () => duplicateEntry(entry) });
  items.push({ label: "Rename…", action: () => promptRename(entry) });
  items.push({
    label: "Move to Trash",
    action: () => promptDelete(entry),
    danger: true,
  });

  buildContextMenuDOM(menu, items);
}

function showMultiContextMenu(event: MouseEvent) {
  removeContextMenu();

  const menu = document.createElement("div");
  menu.className = "sidebar-context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const count = selectedPaths.size;
  const items: ({ label: string; action: () => void; danger?: boolean } | null)[] = [
    {
      label: `Cut ${count} Items`,
      action: () => {
        clipboardPaths = new Set(selectedPaths);
        clipboardMode = "cut";
        updateClipboardStyle();
      },
    },
    {
      label: `Copy ${count} Items`,
      action: () => {
        clipboardPaths = new Set(selectedPaths);
        clipboardMode = "copy";
        updateClipboardStyle();
      },
    },
  ];

  if (clipboardPaths.size > 0 && clipboardMode) {
    items.push({ label: "Paste", action: () => pasteEntry() });
  }
  items.push(null);
  items.push({
    label: `Move ${count} Items to Trash`,
    action: () => promptDeleteSelected(),
    danger: true,
  });

  buildContextMenuDOM(menu, items);
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older WebKit
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

async function revealInFinder(path: string) {
  try {
    await invoke("reveal_in_finder", { path });
  } catch (e) {
    message(`Failed to reveal in Finder: ${e}`, { kind: "error" });
  }
}

async function openInTerminal(path: string) {
  try {
    await invoke("open_in_terminal", { path });
  } catch (e) {
    message(`Failed to open terminal: ${e}`, { kind: "error" });
  }
}

async function duplicateEntry(entry: DirEntry) {
  try {
    const newPath = await invoke<string>("duplicate_entry", { path: entry.path });
    await refreshTree();
    // Select the new duplicate
    setSelectedPath(newPath);
  } catch (e) {
    message(`Failed to duplicate: ${e}`, { kind: "error" });
  }
}

async function promptNewFile(dirPath: string) {
  const name = await promptInput("New file name:");
  if (!name) return;
  try {
    const path = `${dirPath}/${name}`;
    await invoke("create_file", { path });
    expandedDirs.add(dirPath);
    saveState();
    await refreshTree();
  } catch (e) {
    message(`Failed to create file: ${e}`, { kind: "error" });
  }
}

async function promptNewFolder(dirPath: string) {
  const name = await promptInput("New folder name:");
  if (!name) return;
  try {
    const path = `${dirPath}/${name}`;
    await invoke("create_directory", { path });
    expandedDirs.add(dirPath);
    saveState();
    await refreshTree();
  } catch (e) {
    message(`Failed to create folder: ${e}`, { kind: "error" });
  }
}

function promptRename(entry: DirEntry) {
  if (!treeEl) return;
  const item = treeEl.querySelector(
    `.sidebar-tree-item[data-path="${CSS.escape(entry.path)}"]`,
  ) as HTMLElement | null;
  if (!item) return;

  const nameEl = item.querySelector(".sidebar-tree-name") as HTMLElement | null;
  if (!nameEl) return;

  // Replace name span with an inline input
  const input = document.createElement("input");
  input.className = "sidebar-rename-input";
  input.type = "text";
  input.value = entry.name;
  nameEl.replaceWith(input);
  input.select();
  input.focus();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === entry.name) {
      // Restore original name
      const span = document.createElement("span");
      span.className = "sidebar-tree-name";
      span.textContent = entry.name;
      input.replaceWith(span);
      return;
    }
    try {
      const parentDir = dirname(entry.path);
      const newPath = `${parentDir}/${newName}`;
      await invoke("rename_entry", { from: entry.path, to: newPath });
      if (selectedPaths.has(entry.path)) {
        selectedPaths.delete(entry.path);
        selectedPaths.add(newPath);
      }
      if (entry.is_dir) {
        const updated = new Set<string>();
        for (const p of expandedDirs) {
          if (p === entry.path) {
            updated.add(newPath);
          } else if (p.startsWith(entry.path + "/")) {
            updated.add(newPath + p.substring(entry.path.length));
          } else {
            updated.add(p);
          }
        }
        expandedDirs = updated;
      }
      saveState();
      await refreshTree();
      onEntryRename?.(entry.path, newPath);
    } catch (e) {
      message(`Failed to rename: ${e}`, { kind: "error" });
      // Restore original name on error
      const span = document.createElement("span");
      span.className = "sidebar-tree-name";
      span.textContent = entry.name;
      if (input.parentElement) input.replaceWith(span);
    }
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      committed = true;
      const span = document.createElement("span");
      span.className = "sidebar-tree-name";
      span.textContent = entry.name;
      input.replaceWith(span);
    }
  });
  input.addEventListener("blur", () => commit());
}

async function promptDelete(entry: DirEntry) {
  const ok = await confirm(
    `Move "${entry.name}"${entry.is_dir ? " and all its contents" : ""} to Trash?`,
    { title: "Move to Trash", kind: "warning" },
  );
  if (!ok) return;
  try {
    await invoke("delete_entry", { path: entry.path, isDir: entry.is_dir });
    selectedPaths.delete(entry.path);
    expandedDirs.delete(entry.path);
    saveState();
    await refreshTree();
    onEntryDelete?.([entry.path], entry.is_dir);
  } catch (e) {
    message(`Failed to delete: ${e}`, { kind: "error" });
  }
}

async function promptDeleteSelected() {
  if (selectedPaths.size === 0) return;
  const paths = [...selectedPaths];
  const count = paths.length;
  const label = count === 1 ? `"${basename(paths[0])}"` : `${count} items`;
  const ok = await confirm(`Move ${label} to Trash?`, {
    title: "Move to Trash",
    kind: "warning",
  });
  if (!ok) return;
  let hadDir = false;
  const deleted: string[] = [];
  for (const path of paths) {
    try {
      const el = treeEl?.querySelector(
        `.sidebar-tree-item[data-path="${CSS.escape(path)}"]`,
      ) as HTMLElement | null;
      const isDir = el?.dataset.isDir === "true";
      await invoke("delete_entry", { path, isDir });
      expandedDirs.delete(path);
      deleted.push(path);
      if (isDir) hadDir = true;
    } catch (e) {
      message(`Failed to delete: ${e}`, { kind: "error" });
    }
  }
  selectedPaths.clear();
  anchorPath = null;
  saveState();
  await refreshTree();
  if (deleted.length > 0) onEntryDelete?.(deleted, hadDir);
}

// --- Keyboard Navigation ---

function getVisibleItems(): HTMLElement[] {
  if (!treeEl) return [];
  return [...treeEl.querySelectorAll(".sidebar-tree-item")] as HTMLElement[];
}

function focusItemByPath(path: string) {
  if (!treeEl) return;
  const el = treeEl.querySelector(
    `.sidebar-tree-item[data-path="${CSS.escape(path)}"]`,
  ) as HTMLElement | null;
  if (el) {
    selectSingle(path);
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }
}

function entryFromItem(item: HTMLElement): DirEntry | null {
  const path = item.dataset.path;
  if (!path) return null;
  const name = basename(path);
  const isDir = item.dataset.isDir === "true";
  const ext = isDir ? null : name.includes(".") ? name.split(".").pop()! : null;
  return { path, name, is_dir: isDir, extension: ext, modified_at: null };
}

function handleTreeKeydown(e: KeyboardEvent) {
  const items = getVisibleItems();
  if (items.length === 0) return;

  const focused = document.activeElement as HTMLElement;
  const currentIndex = items.indexOf(focused);
  const currentItem = currentIndex >= 0 ? items[currentIndex] : null;

  switch (e.key) {
    case "ArrowDown": {
      e.preventDefault();
      const next = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      const nextPath = items[next].dataset.path;
      if (!nextPath) break;
      if (e.shiftKey) {
        selectRange(nextPath);
        items[next].focus();
        items[next].scrollIntoView({ block: "nearest" });
      } else {
        focusItemByPath(nextPath);
      }
      break;
    }
    case "ArrowUp": {
      e.preventDefault();
      const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      const prevPath = items[prev].dataset.path;
      if (!prevPath) break;
      if (e.shiftKey) {
        selectRange(prevPath);
        items[prev].focus();
        items[prev].scrollIntoView({ block: "nearest" });
      } else {
        focusItemByPath(prevPath);
      }
      break;
    }
    case "ArrowRight": {
      e.preventDefault();
      if (!currentItem) break;
      const path = currentItem.dataset.path;
      if (path && currentItem.dataset.isDir === "true" && !expandedDirs.has(path)) {
        toggleDirectory(path);
      }
      break;
    }
    case "ArrowLeft": {
      e.preventDefault();
      if (!currentItem) break;
      const path = currentItem.dataset.path;
      if (path && currentItem.dataset.isDir === "true" && expandedDirs.has(path)) {
        toggleDirectory(path);
      } else if (path) {
        // Move to parent directory
        const parentPath = dirname(path);
        if (parentPath && parentPath !== rootPath) {
          focusItemByPath(parentPath);
        }
      }
      break;
    }
    case "Enter": {
      e.preventDefault();
      if (!currentItem) break;
      const entry = entryFromItem(currentItem);
      if (!entry) break;
      if (entry.is_dir) {
        toggleDirectory(entry.path);
      } else {
        selectAndOpenFile(entry);
      }
      break;
    }
    case "F2": {
      e.preventDefault();
      if (!currentItem) break;
      const entry = entryFromItem(currentItem);
      if (entry) promptRename(entry);
      break;
    }
    case "Backspace":
    case "Delete": {
      e.preventDefault();
      if (selectedPaths.size > 1) {
        promptDeleteSelected();
      } else if (currentItem) {
        const entry = entryFromItem(currentItem);
        if (entry) promptDelete(entry);
      }
      break;
    }
    case "x": {
      if (!e.metaKey) break;
      e.preventDefault();
      if (selectedPaths.size > 0) {
        clipboardPaths = new Set(selectedPaths);
        clipboardMode = "cut";
        updateClipboardStyle();
      }
      break;
    }
    case "c": {
      if (!e.metaKey) break;
      e.preventDefault();
      if (selectedPaths.size > 0) {
        clipboardPaths = new Set(selectedPaths);
        clipboardMode = "copy";
        updateClipboardStyle();
      }
      break;
    }
    case "v": {
      if (!e.metaKey) break;
      e.preventDefault();
      pasteEntry();
      break;
    }
    case "a": {
      if (!e.metaKey) break;
      e.preventDefault();
      selectedPaths.clear();
      for (const el of items) {
        const p = el.dataset.path;
        if (p) selectedPaths.add(p);
      }
      updateSelectionDOM();
      break;
    }
  }
}

// --- Cut/Copy/Paste ---

function updateClipboardStyle() {
  if (!treeEl) return;
  for (const el of treeEl.querySelectorAll(".sidebar-tree-item.cut")) {
    el.classList.remove("cut");
  }
  if (clipboardMode === "cut") {
    for (const path of clipboardPaths) {
      const el = treeEl.querySelector(`.sidebar-tree-item[data-path="${CSS.escape(path)}"]`);
      if (el) el.classList.add("cut");
    }
  }
}

async function pasteEntry() {
  if (clipboardPaths.size === 0 || !clipboardMode) return;

  // Determine target directory: selected directory, or parent of selected file
  const primary = primarySelectedPath();
  let targetDir: string | null = null;
  if (primary) {
    const items = getVisibleItems();
    const item = items.find((el) => el.dataset.path === primary);
    if (item?.dataset.isDir === "true") {
      targetDir = primary;
    } else {
      targetDir = dirname(primary);
    }
  }
  if (!targetDir) targetDir = rootPath;
  if (!targetDir) return;

  try {
    for (const sourcePath of clipboardPaths) {
      if (clipboardMode === "cut") {
        const fileName = basename(sourcePath);
        if (!fileName) continue;
        const newPath = `${targetDir}/${fileName}`;
        if (sourcePath === newPath) continue;
        await invoke("rename_entry", { from: sourcePath, to: newPath });
        if (selectedPaths.has(sourcePath)) {
          selectedPaths.delete(sourcePath);
          selectedPaths.add(newPath);
        }
      } else {
        await invoke("copy_entry", { from: sourcePath, toDir: targetDir });
      }
    }
    clipboardPaths.clear();
    clipboardMode = null;
    if (!expandedDirs.has(targetDir)) {
      expandedDirs.add(targetDir);
    }
    saveState();
    await refreshTree();
  } catch (e) {
    message(`Failed to paste: ${e}`, { kind: "error" });
  }
}

// --- Public API ---

export function setSelectedPath(path: string | null) {
  selectedPaths.clear();
  if (path) selectedPaths.add(path);
  anchorPath = path;
  updateSelectionDOM();
}

export async function revealPath(filePath: string) {
  if (!rootPath || !filePath.startsWith(rootPath)) return;
  if (activePanel !== "files") return;

  // Expand all parent directories
  let dir = dirname(filePath);
  let changed = false;
  while (dir.length >= rootPath.length) {
    if (!expandedDirs.has(dir)) {
      expandedDirs.add(dir);
      changed = true;
    }
    if (dir === rootPath) break;
    dir = dirname(dir);
  }

  if (changed) {
    saveState();
    await refreshTree();
  }

  setSelectedPath(filePath);
  if (treeEl) {
    const target = treeEl.querySelector(`.sidebar-tree-item[data-path="${CSS.escape(filePath)}"]`);
    if (target) {
      target.scrollIntoView({ block: "nearest" });
    }
  }
}

export function getRootPath() {
  return rootPath;
}

export function setGitStatus(statusMap: Map<string, GitStatus>) {
  gitStatusMap = statusMap;
  if (!treeEl || !rootPath) return;
  // Update git badges in-place without re-fetching the entire file tree
  for (const item of treeEl.querySelectorAll(".sidebar-tree-item") as NodeListOf<HTMLElement>) {
    const itemPath = item.dataset.path;
    if (!itemPath) continue;
    const relPath = itemPath.replace(rootPath + "/", "");
    const status = statusMap.get(relPath);

    // Remove existing badge and name styling
    const oldBadge = item.querySelector(".sidebar-git-badge");
    if (oldBadge) oldBadge.remove();
    const nameEl = item.querySelector(".sidebar-tree-name");
    if (nameEl) {
      const toRemove = [...nameEl.classList].filter((cls) => cls.startsWith("sidebar-name-"));
      for (const cls of toRemove) nameEl.classList.remove(cls);
    }

    if (status) {
      item.appendChild(createGitBadge(status.status));
      if (nameEl) {
        applyGitNameStyle(nameEl, status.status);
      }
    }
  }
}
