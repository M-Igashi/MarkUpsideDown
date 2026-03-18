import { createGitBadge, applyGitNameStyle } from "./git-panel.ts";

const { invoke } = window.__TAURI__.core;
const { open: openDialog, confirm, message } = window.__TAURI__.dialog;

function promptInput(label: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "prompt-overlay";
    const box = document.createElement("div");
    box.className = "prompt-box";
    box.innerHTML = `
      <label>${label}</label>
      <input type="text" value="${defaultValue.replace(/"/g, "&quot;")}" />
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

const STORAGE_KEY = "markupsidedown:sidebar";

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

// --- State ---

let rootPath: string | null = null;
let expandedDirs = new Set<string>();
let selectedPath: string | null = null;
let onFileOpen: ((content: string, filePath: string) => void) | null = null;
let onFolderChange: ((rootPath: string) => void) | null = null;
let onSidebarFold: (() => void) | null = null;
let gitStatusMap: Map<string, GitStatus> = new Map();
let refreshGeneration = 0; // guards against concurrent refreshTree() races
let filterQuery = "";
let filterScope: string | null = null; // null = global, path = scoped to folder
let dragSourcePath: string | null = null;
let clipboardPath: string | null = null;
let clipboardMode: "cut" | "copy" | null = null;

type SortBy = "name" | "date" | "type";
const SORT_STORAGE_KEY = "markupsidedown:sidebar-sort";
let sortBy: SortBy = (localStorage.getItem(SORT_STORAGE_KEY) as SortBy) || "name";

export type SidebarPanel = "files" | "git" | "github" | "slack";
let activePanel: SidebarPanel = "files";
const PANEL_STORAGE_KEY = "markupsidedown:sidebarPanel";

// --- DOM ---

let sidebarEl: HTMLElement | null = null;
let treeEl: HTMLElement | null = null;
let gitPanelSlot: HTMLElement | null = null;
let ghPanelSlot: HTMLElement | null = null;
let slackPanelSlot: HTMLElement | null = null;
let filesContainer: HTMLElement | null = null;
let navBar: HTMLElement | null = null;
let gitChangeCount = 0;

export function initSidebar(
  el: HTMLElement,
  {
    onOpen,
    onFolder,
    onFold,
  }: {
    onOpen: (content: string, filePath: string) => void;
    onFolder: (rootPath: string) => void;
    onFold?: () => void;
  },
) {
  sidebarEl = el;
  onFileOpen = onOpen;
  onFolderChange = onFolder;
  onSidebarFold = onFold ?? null;

  // Restore state
  const saved = localStorage.getItem(STORAGE_KEY);
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
  const savedPanel = localStorage.getItem(PANEL_STORAGE_KEY);
  if (
    savedPanel === "files" ||
    savedPanel === "git" ||
    savedPanel === "github" ||
    savedPanel === "slack"
  ) {
    activePanel = savedPanel;
  }

  render();

  if (rootPath) {
    refreshTree();
  }
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
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
  onFolderChange?.(rootPath);
}

// --- Render ---

function populateHeaderActions(container: Element) {
  if (activePanel === "files") {
    const openBtn = document.createElement("button");
    openBtn.title = "Open Folder";
    openBtn.textContent = "Open";
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
  const folderName = filterScope.split("/").pop() ?? filterScope;
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
  foldBtn.title = "Collapse Sidebar (⌘⇧B)";
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
    localStorage.setItem(SORT_STORAGE_KEY, sortBy);
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

  // GitHub panel slot — reuse existing element
  if (!ghPanelSlot) {
    ghPanelSlot = document.createElement("div");
    ghPanelSlot.id = "github-panel";
    ghPanelSlot.className = "sidebar-panel-content";
  }
  sidebarEl.appendChild(ghPanelSlot);

  // Slack panel slot — reuse existing element
  if (!slackPanelSlot) {
    slackPanelSlot = document.createElement("div");
    slackPanelSlot.id = "slack-panel";
    slackPanelSlot.className = "sidebar-panel-content";
  }
  sidebarEl.appendChild(slackPanelSlot);

  // Bottom nav bar
  navBar = document.createElement("div");
  navBar.className = "sidebar-nav";
  navBar.appendChild(createNavButton("files", "Files", SVG_FILES));
  navBar.appendChild(createNavButton("git", "Git", SVG_GIT));
  navBar.appendChild(createNavButton("github", "GitHub", SVG_GITHUB));
  navBar.appendChild(createNavButton("slack", "Slack", SVG_SLACK));
  sidebarEl.appendChild(navBar);

  updatePanelVisibility();
}

function panelTitle(): string {
  switch (activePanel) {
    case "files":
      return rootPath ? (rootPath.split("/").pop() ?? rootPath) : "Files";
    case "git":
      return "Source Control";
    case "github":
      return "GitHub";
    case "slack":
      return "Slack";
  }
}

// SVG icons (16x16, stroke-based for consistency)
const SVG_FILES = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h4l2 2h6v9H2V2z"/><path d="M2 5h12"/></svg>`;
const SVG_GIT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M8 5v6"/><path d="M9.4 4.2 11 6.5"/></svg>`;
const SVG_GITHUB = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5" r="1"/><circle cx="10.5" cy="5" r="1"/><path d="M5.5 10c0 1.5 1.5 2.5 2.5 2.5s2.5-1 2.5-2.5"/><rect x="2" y="1.5" width="12" height="10" rx="2"/><path d="M5 11.5V14"/><path d="M11 11.5V14"/></svg>`;
const SVG_SLACK = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5a1.5 1.5 0 1 1 0-3h3v1.5A1.5 1.5 0 0 1 5.5 9.5H4z"/><path d="M9.5 4a1.5 1.5 0 1 1 3 0v3h-1.5A1.5 1.5 0 0 1 9.5 5.5V4z"/><path d="M12 9.5a1.5 1.5 0 1 1 0 3h-3v-1.5A1.5 1.5 0 0 1 10.5 9.5H12z"/><path d="M6.5 12a1.5 1.5 0 1 1-3 0V9h1.5A1.5 1.5 0 0 1 6.5 10.5V12z"/></svg>`;

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
  localStorage.setItem(PANEL_STORAGE_KEY, panel);
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
  if (ghPanelSlot) ghPanelSlot.style.display = activePanel === "github" ? "" : "none";
  if (slackPanelSlot) slackPanelSlot.style.display = activePanel === "slack" ? "" : "none";
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

export function getGitHubPanelEl() {
  return ghPanelSlot;
}

export function getSlackPanelEl() {
  return slackPanelSlot;
}

async function refreshTree() {
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

  // Atomic swap: replace old tree element with new one
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
      const item = createTreeItem(entry, depth);
      const childContainer = document.createElement("div");
      childContainer.className = "sidebar-tree-children";
      pendingItems.push({ entry, item, childContainer });
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

function createTreeItem(entry: DirEntry, depth: number) {
  const item = document.createElement("div");
  item.className = "sidebar-tree-item";
  item.dataset.path = entry.path;
  if (entry.is_dir) item.dataset.isDir = "true";
  item.tabIndex = -1;
  if (entry.path === selectedPath) {
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
  name.textContent = entry.name;
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
    dragSourcePath = entry.path;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", entry.path);
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => {
    item.classList.remove("dragging");
    dragSourcePath = null;
    clearTreeDropTarget();
  });
  if (entry.is_dir) {
    // WebKit requires preventDefault() on both dragenter and dragover for drop to work
    item.addEventListener("dragenter", (e) => {
      if (!dragSourcePath || dragSourcePath === entry.path) return;
      if (dragSourcePath && entry.path.startsWith(dragSourcePath + "/")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = "move";
      clearTreeDropTarget();
      item.classList.add("drop-target");
    });
    item.addEventListener("dragover", (e) => {
      if (!dragSourcePath || dragSourcePath === entry.path) return;
      if (dragSourcePath && entry.path.startsWith(dragSourcePath + "/")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = "move";
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
      if (!dragSourcePath || dragSourcePath === entry.path) return;
      moveEntry(dragSourcePath, entry.path);
      dragSourcePath = null;
    });
  }

  // Click handler
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    selectedPath = entry.path;
    item.focus();
    if (entry.is_dir) {
      toggleDirectory(entry.path);
    } else {
      selectAndOpenFile(entry);
    }
  });

  // Context menu
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e, entry);
  });

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
  setSelectedPath(entry.path);
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

async function moveEntry(sourcePath: string, targetDirPath: string) {
  const fileName = sourcePath.split("/").pop();
  if (!fileName) return;
  const newPath = `${targetDirPath}/${fileName}`;
  if (sourcePath === newPath) return;
  try {
    await invoke("rename_entry", { from: sourcePath, to: newPath });
    // Update selected path if the moved item was selected
    if (sourcePath === selectedPath) {
      selectedPath = newPath;
    }
    // Expand the target directory
    if (!expandedDirs.has(targetDirPath)) {
      expandedDirs.add(targetDirPath);
    }
    saveState();
    await refreshTree();
  } catch (e) {
    const { message: showMessage } = window.__TAURI__.dialog;
    showMessage(`Failed to move: ${e}`, { kind: "error" });
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

  if (clipboardPath && clipboardMode) {
    items.push(null); // separator
    items.push({ label: "Paste", action: () => pasteEntry() });
  }

  for (const item of items) {
    if (!item) {
      const sep = document.createElement("div");
      sep.className = "sidebar-context-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "sidebar-context-item";
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

  const parentDir = entry.path.substring(0, entry.path.lastIndexOf("/"));

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
      clipboardPath = entry.path;
      clipboardMode = "cut";
      updateClipboardStyle();
    },
  });
  items.push({
    label: "Copy",
    action: () => {
      clipboardPath = entry.path;
      clipboardMode = "copy";
      updateClipboardStyle();
    },
  });
  if (clipboardPath && clipboardMode) {
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

  // Close on click outside
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
      const parentDir = entry.path.substring(0, entry.path.lastIndexOf("/"));
      const newPath = `${parentDir}/${newName}`;
      await invoke("rename_entry", { from: entry.path, to: newPath });
      if (entry.path === selectedPath) {
        selectedPath = newPath;
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
    if (entry.path === selectedPath) {
      selectedPath = null;
    }
    expandedDirs.delete(entry.path);
    saveState();
    await refreshTree();
  } catch (e) {
    message(`Failed to delete: ${e}`, { kind: "error" });
  }
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
    setSelectedPath(path);
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }
}

function entryFromItem(item: HTMLElement): DirEntry | null {
  const path = item.dataset.path;
  if (!path) return null;
  const name = path.split("/").pop() ?? "";
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
      if (nextPath) focusItemByPath(nextPath);
      break;
    }
    case "ArrowUp": {
      e.preventDefault();
      const prev = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      const prevPath = items[prev].dataset.path;
      if (prevPath) focusItemByPath(prevPath);
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
        const parentPath = path.substring(0, path.lastIndexOf("/"));
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
      if (!currentItem) break;
      const entry = entryFromItem(currentItem);
      if (entry) promptDelete(entry);
      break;
    }
    case "x": {
      if (!e.metaKey) break;
      e.preventDefault();
      if (!currentItem) break;
      const path = currentItem.dataset.path;
      if (path) {
        clipboardPath = path;
        clipboardMode = "cut";
        updateClipboardStyle();
      }
      break;
    }
    case "c": {
      if (!e.metaKey) break;
      e.preventDefault();
      if (!currentItem) break;
      const path = currentItem.dataset.path;
      if (path) {
        clipboardPath = path;
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
  }
}

// --- Cut/Copy/Paste ---

function updateClipboardStyle() {
  if (!treeEl) return;
  for (const el of treeEl.querySelectorAll(".sidebar-tree-item.cut")) {
    el.classList.remove("cut");
  }
  if (clipboardPath && clipboardMode === "cut") {
    const el = treeEl.querySelector(`.sidebar-tree-item[data-path="${CSS.escape(clipboardPath)}"]`);
    if (el) el.classList.add("cut");
  }
}

async function pasteEntry() {
  if (!clipboardPath || !clipboardMode) return;

  // Determine target directory: selected directory, or parent of selected file
  let targetDir: string | null = null;
  if (selectedPath) {
    const items = getVisibleItems();
    const item = items.find((el) => el.dataset.path === selectedPath);
    if (item?.dataset.isDir === "true") {
      targetDir = selectedPath;
    } else if (selectedPath) {
      targetDir = selectedPath.substring(0, selectedPath.lastIndexOf("/"));
    }
  }
  if (!targetDir) targetDir = rootPath;
  if (!targetDir) return;

  try {
    if (clipboardMode === "cut") {
      const fileName = clipboardPath.split("/").pop();
      if (!fileName) return;
      const newPath = `${targetDir}/${fileName}`;
      if (clipboardPath === newPath) return;
      await invoke("rename_entry", { from: clipboardPath, to: newPath });
      if (clipboardPath === selectedPath) {
        selectedPath = newPath;
      }
    } else {
      await invoke("copy_entry", { from: clipboardPath, toDir: targetDir });
    }
    clipboardPath = null;
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
  selectedPath = path;
  if (!treeEl) return;
  // Targeted DOM update: swap .selected class without full tree re-render
  for (const el of treeEl.querySelectorAll(".sidebar-tree-item.selected")) {
    el.classList.remove("selected");
  }
  if (path) {
    const target = treeEl.querySelector(`.sidebar-tree-item[data-path="${CSS.escape(path)}"]`);
    if (target) {
      target.classList.add("selected");
    }
  }
}

export async function revealPath(filePath: string) {
  if (!rootPath || !filePath.startsWith(rootPath)) return;
  if (activePanel !== "files") return;

  // Expand all parent directories
  let dir = filePath.substring(0, filePath.lastIndexOf("/"));
  let changed = false;
  while (dir.length >= rootPath.length) {
    if (!expandedDirs.has(dir)) {
      expandedDirs.add(dir);
      changed = true;
    }
    if (dir === rootPath) break;
    dir = dir.substring(0, dir.lastIndexOf("/"));
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
