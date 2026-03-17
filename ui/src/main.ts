import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { editorTheme } from "./theme.ts";
import { editTableAtCursor } from "./table-editor.ts";
import {
  showSettings,
  checkFirstRun,
} from "./settings.ts";
import {
  initSidebar,
  setSelectedPath,
  getRootPath,
  setGitStatus,
  getGitPanelEl,
  getGitHubPanelEl,
  updateGitChangeCount,
} from "./sidebar.ts";
import {
  initGitPanel,
  setRepoPath,
  refresh as refreshGit,
  getStatusMap,
  getChangeCount,
  getBranch,
} from "./git-panel.ts";
import { initGitHubPanel } from "./github-panel.ts";
import {
  initTabs,
  openTab,
  closeActiveTab,
  switchToPrevTab,
  switchToNextTab,
  updateActiveTab,
} from "./tabs.ts";
import "katex/dist/katex.min.css";

import {
  initScrollSync,
  scrollState,
  isProgrammaticScroll,
  syncToPreview,
  syncToEditor,
  syncPreviewToCursor,
  syncPreviewClickToEditor,
  buildScrollAnchors,
} from "./scroll-sync.ts";
import { initPreview, renderPreview, clearSvgCache } from "./preview-render.ts";
import {
  initFileOps,
  saveFile,
  autoSave,
  scheduleAutoSave,
  openFile,
  fetchUrl,
  renderUrl,
  importFile,
  initDragDrop,
} from "./file-ops.ts";
import { initClipboard, copyRichText, copyMarkdown } from "./clipboard.ts";
import { initMcpSync, syncEditorState, initBridgeListeners } from "./mcp-sync.ts";

// --- Tauri APIs ---

const { invoke } = window.__TAURI__.core;

// --- Shared state ---

let currentFilePath: string | null = null;
let previewTimeout: ReturnType<typeof setTimeout> | null = null;

function getCurrentFilePath() {
  return currentFilePath;
}
function setCurrentFilePath(p: string | null) {
  currentFilePath = p;
}

// --- CodeMirror Editor ---

const updatePreviewListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    scrollState.pendingRender = true;
    const content = update.state.doc.toString();
    if (previewTimeout) clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      renderPreview(content);
      updateStatus(update.state);
    }, 100);
    updateActiveTab({ content });
    scheduleAutoSave();
    syncEditorState(content);
  }
  if (update.selectionSet && !update.docChanged && !scrollState.pendingRender) {
    scrollState.activeSide = "editor";
    cancelAnimationFrame(scrollState.syncRAF);
    scrollState.syncRAF = requestAnimationFrame(syncPreviewToCursor);
  }
});

const editor = new EditorView({
  state: EditorState.create({
    doc: "# Welcome to MarkUpsideDown\n\nStart typing your Markdown here…\n",
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      history(),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      editorTheme,
      search(),
      keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      updatePreviewListener,
      EditorView.lineWrapping,
    ],
  }),
  parent: document.getElementById("editor-pane")!,
});

// --- DOM references ---

const previewPane = document.getElementById("preview-pane")!;
const cmScroller = editor.dom.querySelector(".cm-scroller")! as HTMLElement;
const statusEl = document.getElementById("status")!;

// --- Initialize modules ---

initScrollSync(editor, previewPane, cmScroller);
initPreview(previewPane);
initClipboard(editor, previewPane, statusEl);

// --- Orchestration functions ---

function loadContent(content: string, filePath?: string | null) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
  if (filePath !== undefined) {
    currentFilePath = filePath ?? null;
    setSelectedPath(filePath ?? null);
  }
  clearSvgCache();
  renderPreview(content);
  if (previewTimeout) {
    clearTimeout(previewTimeout);
    previewTimeout = null;
  }
  scrollState.pendingRender = false;
  updateStatus(editor.state);
}

function loadContentAsTab(content: string, filePath?: string) {
  const name = filePath ? filePath.split("/").pop()! : "Untitled";
  openTab(filePath || null, name, content);
}

function updateStatus(state: EditorState) {
  const lines = state.doc.lines;
  const chars = state.doc.length;
  const pathInfo = currentFilePath ? ` | ${currentFilePath}` : "";
  const branch = getBranch();
  const branchInfo = branch ? ` | \u{e0a0} ${branch}` : "";
  statusEl.textContent = `${lines} lines | ${chars} chars${pathInfo}${branchInfo}`;
}

async function refreshGitAndSync() {
  await refreshGit();
  setGitStatus(getStatusMap());
  updateGitChangeCount(getChangeCount());
  updateStatus(editor.state);
}

// --- Initialize file-ops and MCP sync (need orchestration functions) ---

initFileOps({
  editor,
  statusEl,
  getCurrentFilePath,
  setCurrentFilePath,
  loadContentAsTab,
  refreshGitAndSync,
});

initMcpSync({
  editor,
  statusEl,
  getCurrentFilePath,
  setCurrentFilePath,
  loadContentAsTab,
  renderPreview,
  updateStatus: () => updateStatus(editor.state),
  refreshGitAndSync,
});

// --- Initial render ---

renderPreview(editor.state.doc.toString()).catch(() => {});
updateStatus(editor.state);

// --- Toolbar Actions ---

document.getElementById("btn-open")!.addEventListener("click", openFile);
document.getElementById("btn-save")!.addEventListener("click", saveFile);
document.getElementById("btn-import")!.addEventListener("click", importFile);
document.getElementById("btn-copy-rich")!.addEventListener("click", copyRichText);
document.getElementById("btn-table")!.addEventListener("click", () => {
  editTableAtCursor(editor);
});
document.getElementById("btn-export-pdf")!.addEventListener("click", () => {
  window.print();
});
document.getElementById("btn-settings")!.addEventListener("click", () => {
  showSettings({
    onSave: (url: string) => {
      statusEl.textContent = url ? `Worker URL: ${url}` : "Worker URL cleared";
    },
  });
});

// --- Auto-save ---

window.addEventListener("blur", autoSave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) autoSave();
});

// --- URL Bar ---

const urlBar = document.getElementById("url-bar")!;
const urlInput = document.getElementById("url-input")! as HTMLInputElement;

document.getElementById("btn-fetch")!.addEventListener("click", () => fetchUrl(urlInput, urlBar));
document.getElementById("btn-render")!.addEventListener("click", () => renderUrl(urlInput, urlBar));
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchUrl(urlInput, urlBar);
});

// --- Drag & Drop ---

initDragDrop(document.getElementById("app")!);

// --- MCP Bridge ---

initBridgeListeners();
syncEditorState();

// --- Scroll Sync Event Listeners ---

cmScroller.addEventListener(
  "scroll",
  () => {
    if (isProgrammaticScroll()) return;
    scrollState.activeSide = "editor";
    cancelAnimationFrame(scrollState.syncRAF);
    scrollState.syncRAF = requestAnimationFrame(syncToPreview);
  },
  { passive: true },
);
previewPane.addEventListener(
  "scroll",
  () => {
    if (isProgrammaticScroll()) return;
    scrollState.activeSide = "preview";
    cancelAnimationFrame(scrollState.syncRAF);
    scrollState.syncRAF = requestAnimationFrame(syncToEditor);
  },
  { passive: true },
);
let resizeRAF = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeRAF);
  resizeRAF = requestAnimationFrame(buildScrollAnchors);
});
previewPane.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) {
      e.preventDefault();
      invoke("plugin:shell|open", { path: href });
      return;
    }
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  syncPreviewClickToEditor(e);
});

// --- Resizable divider ---

const divider = document.getElementById("divider")!;
const editorContainer = document.getElementById("editor-container")!;

let isDragging = false;

divider.addEventListener("mousedown", () => {
  isDragging = true;
});
document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const editorLeft = editorContainer.getBoundingClientRect().left;
  const previewRight = previewPane.getBoundingClientRect().right;
  const availableWidth = previewRight - editorLeft;
  const ratio = (e.clientX - editorLeft) / availableWidth;
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  (editorContainer as HTMLElement).style.flex = `${clamped}`;
  (previewPane as HTMLElement).style.flex = `${1 - clamped}`;
});
document.addEventListener("mouseup", () => {
  isDragging = false;
});

// --- Sidebar ---

const sidebarEl = document.getElementById("sidebar")!;
const sidebarDivider = document.getElementById("sidebar-divider")!;

const STORAGE_KEY_SIDEBAR_COLLAPSED = "markupsidedown:sidebarCollapsed";

const sidebarCollapsed = localStorage.getItem(STORAGE_KEY_SIDEBAR_COLLAPSED) === "true";
if (sidebarCollapsed) {
  sidebarEl.classList.add("collapsed");
}

initSidebar(sidebarEl, {
  onOpen: (content: string, filePath: string) => {
    loadContentAsTab(content, filePath);
  },
  onFolder: (rootPath: string) => {
    setRepoPath(rootPath);
    refreshGitAndSync();
  },
});

const gitPanelEl = getGitPanelEl();
if (gitPanelEl) {
  initGitPanel(gitPanelEl, {
    onOpen: async (filePath: string) => {
      try {
        const content = await invoke<string>("read_text_file", { path: filePath });
        loadContentAsTab(content, filePath);
      } catch (e) {
        statusEl.textContent = `Open failed: ${e}`;
      }
    },
  });
}

const ghPanelEl = getGitHubPanelEl();
if (ghPanelEl) {
  initGitHubPanel(ghPanelEl, {
    onContent: (body: string, ref_: string) => {
      loadContentAsTab(body);
      statusEl.textContent = `Fetched: ${ref_}`;
    },
  });
}

const initialRoot = getRootPath();
if (initialRoot) {
  setRepoPath(initialRoot);
  refreshGitAndSync();
}

function toggleSidebar() {
  sidebarEl.classList.toggle("collapsed");
  localStorage.setItem(
    STORAGE_KEY_SIDEBAR_COLLAPSED,
    String(sidebarEl.classList.contains("collapsed")),
  );
}

let isSidebarDragging = false;

sidebarDivider.addEventListener("mousedown", () => {
  isSidebarDragging = true;
});
document.addEventListener("mousemove", (e) => {
  if (!isSidebarDragging) return;
  const width = Math.max(120, Math.min(400, e.clientX));
  sidebarEl.style.width = `${width}px`;
  sidebarEl.classList.remove("collapsed");
});
document.addEventListener("mouseup", () => {
  if (isSidebarDragging) {
    isSidebarDragging = false;
    localStorage.setItem(STORAGE_KEY_SIDEBAR_COLLAPSED, "false");
  }
});

// --- Tabs ---

const tabBarEl = document.getElementById("tab-bar")!;

initTabs(tabBarEl, {
  onSwitch: (tab: { content: string; path: string | null }) => {
    autoSave();
    loadContent(tab.content, tab.path);
  },
  onEmpty: () => {
    loadContent("# Welcome to MarkUpsideDown\n\nStart typing your Markdown here…\n");
  },
  onReload: async (tab: { content: string; path: string | null; id: string }) => {
    if (!tab.path) return;
    try {
      const content = await invoke<string>("read_text_file", { path: tab.path });
      const { markTabSaved } = await import("./tabs.ts");
      updateActiveTab({ content });
      markTabSaved(tab.id);
      loadContent(content, tab.path);
    } catch {
      loadContent("", tab.path);
    }
  },
});

// --- Keyboard Shortcuts ---

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  if (e.shiftKey) {
    if (e.key === "C") {
      e.preventDefault();
      copyRichText();
    } else if (e.key === "M") {
      e.preventDefault();
      copyMarkdown();
    } else if (e.key === "[") {
      e.preventDefault();
      switchToPrevTab();
    } else if (e.key === "]") {
      e.preventDefault();
      switchToNextTab();
    }
  } else {
    if (e.key === "s") {
      e.preventDefault();
      saveFile();
    } else if (e.key === "w") {
      e.preventDefault();
      closeActiveTab();
    } else if (e.key === "b") {
      e.preventDefault();
      toggleSidebar();
    }
  }
});

// --- First-run ---

checkFirstRun();
