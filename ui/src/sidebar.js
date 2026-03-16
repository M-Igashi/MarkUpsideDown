import { statusClass } from "./git-panel.js";

const { invoke } = window.__TAURI__.core;
const { open: openDialog, confirm } = window.__TAURI__.dialog;
const { readTextFile } = window.__TAURI__.fs;

const STORAGE_KEY = "markupsidedown:sidebar";

// --- State ---

let rootPath = null;
let expandedDirs = new Set();
let selectedPath = null;
let onFileOpen = null;
let onFolderChange = null;
let gitStatusMap = new Map(); // path -> { status, staged }
let refreshGeneration = 0; // guards against concurrent refreshTree() races

// --- DOM ---

let sidebarEl = null;
let treeEl = null;
let gitPanelSlot = null;
let ghPanelSlot = null;

export function initSidebar(el, { onOpen, onFolder }) {
  sidebarEl = el;
  onFileOpen = onOpen;
  onFolderChange = onFolder;

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

function render() {
  sidebarEl.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "sidebar-header";

  const title = document.createElement("span");
  title.className = "sidebar-title";
  title.textContent = rootPath ? rootPath.split("/").pop() : "Files";
  header.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "sidebar-header-actions";

  const openBtn = document.createElement("button");
  openBtn.title = "Open Folder";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", openFolder);
  actions.appendChild(openBtn);

  header.appendChild(actions);
  sidebarEl.appendChild(header);

  // Tree container
  treeEl = document.createElement("div");
  treeEl.className = "sidebar-tree";

  if (!rootPath) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Open a folder to browse files";
    treeEl.appendChild(empty);
  }

  sidebarEl.appendChild(treeEl);

  // Git panel slot (populated by main.js)
  gitPanelSlot = document.createElement("div");
  gitPanelSlot.id = "git-panel";
  sidebarEl.appendChild(gitPanelSlot);

  // GitHub panel slot
  ghPanelSlot = document.createElement("div");
  ghPanelSlot.id = "github-panel";
  sidebarEl.appendChild(ghPanelSlot);
}

export function getGitPanelEl() {
  return gitPanelSlot;
}

export function getGitHubPanelEl() {
  return ghPanelSlot;
}

async function refreshTree() {
  if (!rootPath || !treeEl) return;

  const gen = ++refreshGeneration;
  treeEl.innerHTML = "";
  try {
    await renderDirectory(rootPath, treeEl, 0, gen);
  } catch (e) {
    if (gen !== refreshGeneration) return;
    const err = document.createElement("div");
    err.className = "sidebar-error";
    err.textContent = `Error: ${e}`;
    treeEl.appendChild(err);
  }
}

async function renderDirectory(dirPath, container, depth, gen) {
  const entries = await invoke("list_directory", { path: dirPath });
  if (gen !== refreshGeneration) return;

  // Render items and collect expanded subdirectories for parallel fetch
  const expandedChildren = [];
  for (const entry of entries) {
    const item = createTreeItem(entry, depth);
    container.appendChild(item);

    if (entry.is_dir && expandedDirs.has(entry.path)) {
      const childContainer = document.createElement("div");
      childContainer.className = "sidebar-tree-children";
      container.appendChild(childContainer);
      expandedChildren.push({ path: entry.path, container: childContainer });
    }
  }

  // Recurse into expanded subdirectories in parallel
  if (expandedChildren.length > 0) {
    await Promise.all(
      expandedChildren.map(({ path, container: c }) => renderDirectory(path, c, depth + 1, gen)),
    );
  }
}

function createTreeItem(entry, depth) {
  const item = document.createElement("div");
  item.className = "sidebar-tree-item";
  item.dataset.path = entry.path;
  if (entry.path === selectedPath) {
    item.classList.add("selected");
  }
  item.style.paddingLeft = `${8 + depth * 16}px`;

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
  icon.textContent = entry.is_dir ? "📁" : fileIcon(entry.extension);
  item.appendChild(icon);

  // Name
  const name = document.createElement("span");
  name.className = "sidebar-tree-name";
  name.textContent = entry.name;
  item.appendChild(name);

  // Git status indicator
  const relPath = rootPath ? entry.path.replace(rootPath + "/", "") : entry.name;
  const gitStatus = gitStatusMap.get(relPath);
  if (gitStatus) {
    const badge = document.createElement("span");
    badge.className = "sidebar-git-badge";
    badge.textContent = gitStatus.status;
    badge.classList.add(statusClass(gitStatus.status));
    item.appendChild(badge);
    const cls = statusClass(gitStatus.status);
    const suffix = cls.replace("git-", "");
    name.classList.add(`sidebar-name-${suffix}`);
  }

  // Click handler
  item.addEventListener("click", (e) => {
    e.stopPropagation();
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

function fileIcon(ext) {
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

async function toggleDirectory(dirPath) {
  if (expandedDirs.has(dirPath)) {
    expandedDirs.delete(dirPath);
  } else {
    expandedDirs.add(dirPath);
  }
  saveState();
  await refreshTree();
}

async function selectAndOpenFile(entry) {
  setSelectedPath(entry.path);
  if (onFileOpen) {
    try {
      const content = await readTextFile(entry.path);
      onFileOpen(content, entry.path);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }
}

// --- Context Menu ---

let activeContextMenu = null;

function removeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

function showContextMenu(event, entry) {
  removeContextMenu();

  const menu = document.createElement("div");
  menu.className = "sidebar-context-menu";
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const items = [];

  if (entry.is_dir) {
    items.push({ label: "New File…", action: () => promptNewFile(entry.path) });
    items.push({ label: "New Folder…", action: () => promptNewFolder(entry.path) });
    items.push(null); // separator
  }

  items.push({ label: "Rename…", action: () => promptRename(entry) });
  items.push({
    label: "Delete",
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
  const close = (e) => {
    if (!menu.contains(e.target)) {
      removeContextMenu();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true), 0);
}

async function promptNewFile(dirPath) {
  const name = prompt("New file name:");
  if (!name) return;
  try {
    const path = `${dirPath}/${name}`;
    await invoke("create_file", { path });
    if (!expandedDirs.has(dirPath)) {
      expandedDirs.add(dirPath);
    }
    saveState();
    await refreshTree();
  } catch (e) {
    alert(`Failed to create file: ${e}`);
  }
}

async function promptNewFolder(dirPath) {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    const path = `${dirPath}/${name}`;
    await invoke("create_directory", { path });
    if (!expandedDirs.has(dirPath)) {
      expandedDirs.add(dirPath);
    }
    saveState();
    await refreshTree();
  } catch (e) {
    alert(`Failed to create folder: ${e}`);
  }
}

async function promptRename(entry) {
  const newName = prompt("New name:", entry.name);
  if (!newName || newName === entry.name) return;
  try {
    const parentDir = entry.path.substring(0, entry.path.lastIndexOf("/"));
    const newPath = `${parentDir}/${newName}`;
    await invoke("rename_entry", { from: entry.path, to: newPath });
    if (entry.path === selectedPath) {
      selectedPath = newPath;
    }
    // Update expanded dirs if renamed a directory
    if (entry.is_dir) {
      const updated = new Set();
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
    alert(`Failed to rename: ${e}`);
  }
}

async function promptDelete(entry) {
  const ok = await confirm(
    `Delete "${entry.name}"${entry.is_dir ? " and all its contents" : ""}?`,
    { title: "Confirm Delete", kind: "warning" },
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
    alert(`Failed to delete: ${e}`);
  }
}

// --- Public API ---

export function setSelectedPath(path) {
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

export function getSidebarState() {
  return {
    rootPath,
    visible: sidebarEl ? sidebarEl.style.display !== "none" : true,
  };
}

export function getRootPath() {
  return rootPath;
}

export function setGitStatus(statusMap) {
  gitStatusMap = statusMap;
  if (treeEl && rootPath) refreshTree();
}
