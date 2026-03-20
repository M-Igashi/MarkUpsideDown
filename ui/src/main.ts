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
import { lintGutter } from "@codemirror/lint";
import { markdownLinter } from "./markdown-lint.ts";
import { editorTheme } from "./theme.ts";
import { editTableAtCursor } from "./table-editor.ts";
import { showSettings, checkFirstRun } from "./settings.ts";
import {
  initSidebar,
  setSelectedPath,
  revealPath,
  getRootPath,
  setGitStatus,
  getGitPanelEl,
  getGitHubPanelEl,
  updateGitChangeCount,
  refreshTree,
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
  getActiveTab,
  getTabByPath,
  getTabs,
  isTabDirty,
  markTabSaved,
} from "./tabs.ts";
import { initFileWatcher, startWatching, stopWatching } from "./file-watcher.ts";
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
  preservePreviewScroll,
} from "./scroll-sync.ts";
import { initPreview, renderPreview } from "./preview-render.ts";
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
import { initCrawl, crawlUrl } from "./crawl.ts";
import { normalizeMarkdown } from "./normalize.ts";
import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  insertLink,
} from "./markdown-commands.ts";
import { basename } from "./path-utils.ts";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import {
  KEY_SIDEBAR_COLLAPSED,
  KEY_EDITOR_COLLAPSED,
  KEY_PREVIEW_COLLAPSED,
  KEY_CLAUDE_WIDTH,
  KEY_CLAUDE_COLLAPSED,
} from "./storage-keys.ts";
import { registerCommands, toggle as toggleCommandPalette } from "./command-palette.ts";
import { autoLinkTitle } from "./auto-link-title.ts";
import { initLinkContextMenu } from "./link-context-menu.ts";
import { smartTypography } from "./smart-typography.ts";
import { initDownloadImages, downloadExternalImages } from "./download-images.ts";
import { initNoteRefactor, extractToNewNote } from "./note-refactor.ts";
import { initFrontmatterPanel, updateFrontmatterPanel } from "./frontmatter-panel.ts";
import { startPresentation } from "./presentation.ts";
import {
  initClaudePanel,
  togglePanel as _toggleClaudePanelRaw,
  isCollapsed as isClaudePanelCollapsed,
} from "./claude-panel.ts";

function toggleClaudePanel() {
  preservePreviewScroll(() => _toggleClaudePanelRaw());
}

// --- Tauri APIs ---

const { invoke } = window.__TAURI__.core;

// --- Shared state ---

let previewTimeout: ReturnType<typeof setTimeout> | null = null;

function getCurrentFilePath() {
  return getActiveTab()?.path ?? null;
}

// --- CodeMirror Editor ---

const updatePreviewListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    scrollState.pendingRender = true;
    const content = update.state.doc.toString();
    if (previewTimeout) clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      renderPreview(content);
      updateFrontmatterPanel(content);
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
      markdownLinter,
      lintGutter(),
      keymap.of([
        { key: "Mod-b", run: toggleBold },
        { key: "Mod-i", run: toggleItalic },
        { key: "Mod-Shift-x", run: toggleStrikethrough },
        { key: "Mod-`", run: toggleInlineCode },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      autoLinkTitle,
      smartTypography,
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
    if (filePath) {
      revealPath(filePath);
    } else {
      setSelectedPath(null);
    }
  }
  renderPreview(content);
  updateFrontmatterPanel(content);
  if (previewTimeout) {
    clearTimeout(previewTimeout);
    previewTimeout = null;
  }
  scrollState.pendingRender = false;
  updateStatus(editor.state);
}

function loadContentAsTab(content: string, filePath?: string) {
  const name = filePath ? basename(filePath) : "Untitled";
  openTab(filePath || null, name, content);
}

function updateStatus(state: EditorState) {
  const lines = state.doc.lines;
  const chars = state.doc.length;
  const fp = getCurrentFilePath();
  const pathInfo = fp ? ` | ${fp}` : "";
  const branch = getBranch();
  const branchInfo = branch ? ` | \u{e0a0} ${branch}` : "";
  statusEl.textContent = `${lines} lines | ${chars} chars${pathInfo}${branchInfo}`;
}

let gitRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
const GIT_REFRESH_DEBOUNCE = 2000;

async function doGitRefresh() {
  await refreshGit();
  setGitStatus(getStatusMap());
  updateGitChangeCount(getChangeCount());
  updateStatus(editor.state);
}

function refreshGitAndSync() {
  if (gitRefreshTimeout) clearTimeout(gitRefreshTimeout);
  gitRefreshTimeout = setTimeout(doGitRefresh, GIT_REFRESH_DEBOUNCE);
}

async function refreshGitAndSyncNow() {
  if (gitRefreshTimeout) clearTimeout(gitRefreshTimeout);
  await doGitRefresh();
}

// --- Initialize file-ops and MCP sync (need orchestration functions) ---

initFileOps({
  editor,
  statusEl,
  getCurrentFilePath,
  loadContentAsTab,
  refreshGitAndSync,
});

initCrawl({
  statusEl,
  onCrawlComplete: () => {
    // Refresh file tree and git status after crawl saves files
    refreshTree();
    const root = getRootPath();
    if (root) refreshGitAndSync();
  },
});

initMcpSync({
  editor,
  statusEl,
  getCurrentFilePath,
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
document.getElementById("btn-table")!.addEventListener("click", () => {
  editTableAtCursor(editor);
});

function cleanupDocument() {
  const content = editor.state.doc.toString();
  const cleaned = normalizeMarkdown(content);
  if (cleaned !== content) {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: cleaned } });
    renderPreview(cleaned);
    statusEl.textContent = "Document cleaned up";
  } else {
    statusEl.textContent = "No changes needed";
  }
}

document.getElementById("btn-cleanup")!.addEventListener("click", cleanupDocument);
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
document.getElementById("btn-crawl")!.addEventListener("click", () => crawlUrl(urlInput, urlBar));
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

// --- Frontmatter panel ---

initFrontmatterPanel(editor, editorContainer);

// --- Download images & note refactor ---

initDownloadImages({ editor, statusEl, getCurrentFilePath });
initNoteRefactor({ editor, statusEl, getCurrentFilePath, loadContentAsTab });

// --- Link context menu in preview ---

initLinkContextMenu(previewPane, {
  statusEl,
  loadContentAsTab,
  crawlUrl,
  urlInput,
  urlBar,
});

// --- Link hover URL preview in status bar ---

let linkHoverActive = false;
previewPane.addEventListener("mouseover", (e) => {
  const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (href) {
      statusEl.textContent = href;
      linkHoverActive = true;
    }
  }
});
previewPane.addEventListener("mouseout", (e) => {
  if (!linkHoverActive) return;
  const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) {
    linkHoverActive = false;
    updateStatus(editor.state);
  }
});

// --- Resizable divider ---

const divider = document.getElementById("divider")!;
const editorContainer = document.getElementById("editor-container")!;
const previewWrapper = document.getElementById("preview-wrapper")!;

function makeDraggable(handle: HTMLElement, onDrag: (clientX: number) => void, onEnd?: () => void) {
  let active = false;
  let rafId = 0;
  handle.addEventListener("mousedown", () => {
    active = true;
  });
  document.addEventListener("mousemove", (e) => {
    if (!active) return;
    cancelAnimationFrame(rafId);
    const x = e.clientX;
    rafId = requestAnimationFrame(() => onDrag(x));
  });
  document.addEventListener("mouseup", () => {
    if (!active) return;
    active = false;
    onEnd?.();
  });
}

let dragEditorLeft = 0;
let dragAvailableWidth = 0;

divider.addEventListener("mousedown", () => {
  dragEditorLeft = editorContainer.getBoundingClientRect().left;
  dragAvailableWidth = previewWrapper.getBoundingClientRect().right - dragEditorLeft;
});
makeDraggable(divider, (clientX) => {
  const ratio = (clientX - dragEditorLeft) / dragAvailableWidth;
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  editorContainer.style.flex = `${clamped}`;
  previewWrapper.style.flex = `${1 - clamped}`;
});

// --- Sidebar ---

const sidebarEl = document.getElementById("sidebar")!;
const sidebarDivider = document.getElementById("sidebar-divider")!;

const sidebarCollapsed = getStorageBool(KEY_SIDEBAR_COLLAPSED, false);
if (sidebarCollapsed) {
  sidebarEl.classList.add("collapsed");
}

initSidebar(sidebarEl, {
  onOpen: (content: string, filePath: string) => {
    loadContentAsTab(content, filePath);
  },
  onFolder: (rootPath: string) => {
    setRepoPath(rootPath, true);
    refreshGitAndSyncNow();
  },
  onFold: () => toggleSidebar(),
  onDirChange: () => {
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
    onRefresh: () => {
      setGitStatus(getStatusMap());
      updateGitChangeCount(getChangeCount());
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
  setRepoPath(initialRoot, true);
  refreshGitAndSyncNow();
}

function toggleSidebar() {
  preservePreviewScroll(() => {
    const collapsed = sidebarEl.classList.toggle("collapsed");
    sidebarUnfoldBtn.classList.toggle("visible", collapsed);
    setStorageBool(KEY_SIDEBAR_COLLAPSED, collapsed);
  });
}

makeDraggable(
  sidebarDivider,
  (clientX) => {
    const width = Math.max(120, Math.min(400, clientX));
    sidebarEl.style.width = `${width}px`;
    sidebarEl.classList.remove("collapsed");
    sidebarUnfoldBtn.classList.remove("visible");
  },
  () => {
    setStorageBool(KEY_SIDEBAR_COLLAPSED, false);
  },
);

// --- Panel Fold/Unfold ---

const SVG_CHEVRON_LEFT = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3 5 7l4 4"/></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l4 4-4 4"/></svg>`;

// Editor fold button (in tab-bar, right side)
const editorFoldBtn = document.createElement("button");
editorFoldBtn.className = "panel-fold-btn";
editorFoldBtn.title = "Collapse Editor (⌘2)";
editorFoldBtn.innerHTML = SVG_CHEVRON_LEFT;

// Preview header with fold button
const previewHeader = document.createElement("div");
previewHeader.className = "preview-header";
const previewFoldBtn = document.createElement("button");
previewFoldBtn.className = "panel-fold-btn";
previewFoldBtn.title = "Collapse Preview (⌘3)";
previewFoldBtn.innerHTML = SVG_CHEVRON_RIGHT;
previewHeader.appendChild(previewFoldBtn);
previewWrapper.insertBefore(previewHeader, previewPane);

// Unfold buttons (thin strips shown when panel is collapsed)
const appEl = document.getElementById("app")!;

const sidebarUnfoldBtn = document.createElement("button");
sidebarUnfoldBtn.className = "panel-unfold-btn";
sidebarUnfoldBtn.title = "Expand Sidebar (⌘1)";
sidebarUnfoldBtn.innerHTML = SVG_CHEVRON_RIGHT;
appEl.insertBefore(sidebarUnfoldBtn, sidebarDivider);

const editorUnfoldBtn = document.createElement("button");
editorUnfoldBtn.className = "panel-unfold-btn";
editorUnfoldBtn.title = "Expand Editor (⌘2)";
editorUnfoldBtn.innerHTML = SVG_CHEVRON_RIGHT;
appEl.insertBefore(editorUnfoldBtn, divider);

const previewUnfoldBtn = document.createElement("button");
previewUnfoldBtn.className = "panel-unfold-btn";
previewUnfoldBtn.title = "Expand Preview (⌘3)";
previewUnfoldBtn.innerHTML = SVG_CHEVRON_LEFT;
appEl.appendChild(previewUnfoldBtn);

const claudeUnfoldBtn = document.createElement("button");
claudeUnfoldBtn.className = "panel-unfold-btn claude-unfold";
claudeUnfoldBtn.title = "Expand Claude Panel (⌘4)";
claudeUnfoldBtn.innerHTML = SVG_CHEVRON_LEFT;
appEl.appendChild(claudeUnfoldBtn);

function toggleEditor() {
  preservePreviewScroll(() => {
    const collapsed = editorContainer.classList.toggle("collapsed");
    divider.classList.toggle("hidden", collapsed);
    editorUnfoldBtn.classList.toggle("visible", collapsed);
    setStorageBool(KEY_EDITOR_COLLAPSED, collapsed);
  });
}

function togglePreview() {
  const collapsed = previewWrapper.classList.toggle("collapsed");
  divider.classList.toggle("hidden", collapsed);
  previewUnfoldBtn.classList.toggle("visible", collapsed);
  setStorageBool(KEY_PREVIEW_COLLAPSED, collapsed);
}

sidebarUnfoldBtn.addEventListener("click", toggleSidebar);
editorFoldBtn.addEventListener("click", toggleEditor);
previewFoldBtn.addEventListener("click", togglePreview);
editorUnfoldBtn.addEventListener("click", toggleEditor);
previewUnfoldBtn.addEventListener("click", togglePreview);
claudeUnfoldBtn.addEventListener("click", toggleClaudePanel);

// Restore collapsed states
if (sidebarCollapsed) {
  sidebarUnfoldBtn.classList.add("visible");
}
if (getStorageBool(KEY_EDITOR_COLLAPSED, false)) {
  editorContainer.classList.add("collapsed");
  divider.classList.add("hidden");
  editorUnfoldBtn.classList.add("visible");
}
if (getStorageBool(KEY_PREVIEW_COLLAPSED, false)) {
  previewWrapper.classList.add("collapsed");
  divider.classList.add("hidden");
  previewUnfoldBtn.classList.add("visible");
}

// --- Tabs ---

const tabBarEl = document.getElementById("tab-bar")!;

// --- File Watcher ---

const { confirm: confirmDialog } = window.__TAURI__.dialog;

async function reloadTabFromDisk(path: string) {
  const content = await invoke<string>("read_text_file", { path });
  const tab = getTabByPath(path);
  if (!tab) return;
  tab.content = content;
  tab.savedContent = content;
  markTabSaved(tab.id);
  if (tab.id === getActiveTab()?.id) {
    loadContent(content, path);
  }
}

initFileWatcher({
  getTabByPath,
  getActiveTab,
  isTabDirty,
  reloadTab: reloadTabFromDisk,
  confirmReload: async (path: string) => {
    const fileName = basename(path);
    return confirmDialog(
      `"${fileName}" has been modified externally.\nReload and discard your unsaved changes?`,
      { title: "File Changed", kind: "warning" },
    );
  },
});

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
      updateActiveTab({ content });
      markTabSaved(tab.id);
      loadContent(content, tab.path);
    } catch {
      loadContent("", tab.path);
    }
  },
  onOpen: (tab) => {
    if (tab.path) startWatching(tab.path);
  },
  onClose: (tab) => {
    if (tab.path) stopWatching(tab.path);
  },
});

// Start watching all previously open file-backed tabs
for (const tab of getTabs()) {
  if (tab.path) startWatching(tab.path);
}

// Append editor fold button to editor-header (stays at right edge)
document.getElementById("editor-header")!.appendChild(editorFoldBtn);

// --- Claude Panel ---

const claudePanelEl = document.getElementById("claude-panel")!;
const claudeDivider = document.getElementById("claude-divider")!;

initClaudePanel(claudePanelEl, {
  getCwd: () => getRootPath(),
  getActiveFilePath: () => getCurrentFilePath(),
  onFileEdited: (filePath: string) => {
    const tab = getTabByPath(filePath);
    if (tab) reloadTabFromDisk(filePath);
  },
});

// Claude panel divider drag
makeDraggable(claudeDivider, (clientX) => {
  const width = Math.max(250, Math.min(600, window.innerWidth - clientX));
  claudePanelEl.style.width = `${width}px`;
  claudePanelEl.classList.remove("collapsed");
  localStorage.setItem(KEY_CLAUDE_WIDTH, String(width));
  setStorageBool(KEY_CLAUDE_COLLAPSED, false);
});

// Hide divider and show unfold button when collapsed
if (isClaudePanelCollapsed()) {
  claudeDivider.style.display = "none";
  claudeUnfoldBtn.classList.add("visible");
}
// Observe collapsed state for divider and unfold button visibility
new MutationObserver(() => {
  const collapsed = claudePanelEl.classList.contains("collapsed");
  claudeDivider.style.display = collapsed ? "none" : "";
  claudeUnfoldBtn.classList.toggle("visible", collapsed);
}).observe(claudePanelEl, { attributes: true, attributeFilter: ["class"] });

// --- Keyboard Shortcuts ---

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  if (e.shiftKey) {
    if (e.key === "[") {
      e.preventDefault();
      switchToPrevTab();
    } else if (e.key === "]") {
      e.preventDefault();
      switchToNextTab();
    }
  } else if (e.key === "1") {
    e.preventDefault();
    toggleSidebar();
  } else if (e.key === "2") {
    e.preventDefault();
    toggleEditor();
  } else if (e.key === "3") {
    e.preventDefault();
    togglePreview();
  } else if (e.key === "4") {
    e.preventDefault();
    toggleClaudePanel();
  } else if (e.key === "c") {
    // Cmd+C with no selection: copy entire content from focused pane
    const previewEl = document.getElementById("preview-pane")!;
    const editorEl = document.getElementById("editor-pane")!;
    const active = document.activeElement;

    if (previewEl.contains(active) || active === previewEl) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        e.preventDefault();
        copyRichText();
      }
    } else if (editorEl.contains(active) || active === editorEl) {
      const sel = editor.state.selection.main;
      if (sel.empty) {
        e.preventDefault();
        copyMarkdown();
      }
    }
  } else {
    if (e.key === "s") {
      e.preventDefault();
      saveFile();
    } else if (e.key === "w") {
      e.preventDefault();
      closeActiveTab();
    } else if (e.key === "k") {
      e.preventDefault();
      toggleCommandPalette();
    }
  }
});

// --- Command Palette Registry ---

registerCommands([
  { id: "file.open", label: "Open File", shortcut: "⌘O", category: "File", run: openFile },
  { id: "file.save", label: "Save File", shortcut: "⌘S", category: "File", run: saveFile },
  { id: "file.import", label: "Import Document", category: "File", run: importFile },
  {
    id: "edit.bold",
    label: "Bold",
    shortcut: "⌘B",
    category: "Edit",
    run: () => toggleBold(editor),
  },
  {
    id: "edit.italic",
    label: "Italic",
    shortcut: "⌘I",
    category: "Edit",
    run: () => toggleItalic(editor),
  },
  {
    id: "edit.strikethrough",
    label: "Strikethrough",
    shortcut: "⌘⇧X",
    category: "Edit",
    run: () => toggleStrikethrough(editor),
  },
  {
    id: "edit.inlineCode",
    label: "Inline Code",
    shortcut: "⌘`",
    category: "Edit",
    run: () => toggleInlineCode(editor),
  },
  {
    id: "edit.insertLink",
    label: "Insert Link",
    category: "Edit",
    run: () => insertLink(editor),
  },
  {
    id: "edit.table",
    label: "Insert Table",
    category: "Edit",
    run: () => editTableAtCursor(editor),
  },
  {
    id: "edit.cleanup",
    label: "Clean Up Document",
    category: "Edit",
    run: cleanupDocument,
  },
  {
    id: "export.richText",
    label: "Copy as Rich Text",
    shortcut: "⌘⇧C",
    category: "Export",
    run: copyRichText,
  },
  { id: "export.markdown", label: "Copy as Markdown", category: "Export", run: copyMarkdown },
  {
    id: "convert.fetch",
    label: "Fetch URL",
    category: "Convert",
    run: () => fetchUrl(urlInput, urlBar),
  },
  {
    id: "convert.render",
    label: "Fetch URL (JS Render)",
    category: "Convert",
    run: () => renderUrl(urlInput, urlBar),
  },
  {
    id: "convert.crawl",
    label: "Crawl Website",
    category: "Convert",
    run: () => crawlUrl(urlInput, urlBar),
  },
  {
    id: "edit.downloadImages",
    label: "Download External Images",
    category: "Edit",
    run: downloadExternalImages,
  },
  {
    id: "edit.extractNote",
    label: "Extract to New Note",
    category: "Edit",
    run: extractToNewNote,
  },
  {
    id: "view.presentation",
    label: "Start Presentation",
    category: "View",
    run: () => startPresentation(editor.state.doc.toString()),
  },
  {
    id: "view.sidebar",
    label: "Toggle Sidebar",
    shortcut: "⌘1",
    category: "View",
    run: toggleSidebar,
  },
  {
    id: "view.editor",
    label: "Toggle Editor",
    shortcut: "⌘2",
    category: "View",
    run: toggleEditor,
  },
  {
    id: "view.preview",
    label: "Toggle Preview",
    shortcut: "⌘3",
    category: "View",
    run: togglePreview,
  },
  {
    id: "view.claude",
    label: "Toggle Claude Panel",
    shortcut: "⌘4",
    category: "View",
    run: toggleClaudePanel,
  },
  {
    id: "app.settings",
    label: "Open Settings",
    category: "App",
    run: () =>
      showSettings({
        onSave: (url: string) => {
          statusEl.textContent = url ? `Worker URL: ${url}` : "Worker URL cleared";
        },
      }),
  },
]);

// --- First-run ---

checkFirstRun();
