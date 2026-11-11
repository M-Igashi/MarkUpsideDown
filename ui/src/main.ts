import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  placeholder,
} from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { markdownLinter } from "./markdown-lint.ts";
import { editorTheme } from "./theme.ts";
import { editTableAtCursor } from "./table-editor.ts";
import {
  showSettings,
  checkFirstRun,
  isAutoSaveEnabled,
  isRenderAvailable,
  getWorkerUrl,
  getWorkerHealth,
  refreshWorkerHealth,
  WORKER_STATUS_EVENT,
  type WorkerHealth,
} from "./settings.ts";
import { checkForUpdate, watchBundleVersion } from "./update-toast.ts";
import {
  initSidebar,
  setSelectedPath,
  revealPath,
  getRootPath,
  setGitStatus,
  getGitPanelEl,
  getClonePanelEl,
  openFolderByPath,
  updateGitChangeCount,
  refreshTree,
  stopDirWatcher,
  getActivePanel,
  switchPanel,
  getGitHubPanelEl,
  openFolder,
  SIDEBAR_IMAGE_MIME,
} from "./sidebar.ts";
import {
  initGitPanel,
  setRepoPath,
  refresh as refreshGit,
  getStatusMap,
  getChangeCount,
  getBranch,
  getSyncCounts,
} from "./git-panel.ts";
import {
  initGitHubPanel,
  setGitHubRepoPath,
  setGitHubKind,
  refresh as refreshGitHubPanel,
} from "./github-panel.ts";
import {
  buildDocument,
  remoteTabName,
  reloadRemoteTab,
  toRemoteRef,
  type GhItemDetail,
  type GhKind,
} from "./github.ts";
import { initClonePanel } from "./clone-panel.ts";

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
  updateTabPath,
  type Tab,
  closeTabsByPath,
  closeTabsUnderDir,
  setTabsProjectRoot,
  switchProjectTabs,
  getDirtyFileTabs,
  setTabContentFlusher,
  setTabContent,
} from "./tabs.ts";
import {
  initFileWatcher,
  startWatching,
  stopWatching,
  stopWatchingUnder,
  stopAll as stopAllFileWatchers,
} from "./file-watcher.ts";
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
import { initPreview, renderPreview, getMermaid, setFilePathGetter } from "./preview-render.ts";
import { initPreviewSearch, openPreviewSearch, isPreviewSearchTarget } from "./preview-search.ts";
import {
  initFileOps,
  saveFile,
  autoSave,
  scheduleAutoSave,
  openFile,
  getUrl,
  fetchUrl,
  renderUrl,
  importFile,
  initDragDrop,
  saveTabToDisk,
} from "./file-ops.ts";
import { initClipboard, copyRichText, copyMarkdown } from "./clipboard.ts";
import { initMcpSync, syncEditorState, initBridgeListeners, listenToWindow } from "./mcp-sync.ts";
import { initCrawl, crawlUrl } from "./crawl.ts";
import { normalizeMarkdown } from "./normalize.ts";
import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  insertCodeBlock,
  insertLink,
} from "./markdown-commands.ts";
import {
  basename,
  buildRelativePath,
  encodeLinkPath,
  escapeLinkText,
  getExtension,
  MD_EXTENSIONS,
  relativeToRoot,
  resolveRelativePath,
  SYSTEM_OPEN_EXTENSIONS,
} from "./path-utils.ts";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import {
  KEY_TABS,
  KEY_SIDEBAR,
  KEY_SIDEBAR_PANEL,
  KEY_SIDEBAR_COLLAPSED,
  KEY_EDITOR_COLLAPSED,
  KEY_PREVIEW_COLLAPSED,
  KEY_V2_WINDOW_MIGRATED,
  KEY_STATUS_COUNT,
  initWindowLabel,
  windowKey,
  getWindowLabel,
} from "./storage-keys.ts";
import {
  registerCommands,
  open as openCommandPalette,
  toggle as toggleCommandPalette,
  setSemanticSearchHandler,
} from "./command-palette.ts";
import { autoLinkTitle } from "./auto-link-title.ts";
import { initLinkContextMenu } from "./link-context-menu.ts";
import { smartTypography } from "./smart-typography.ts";
import { todoAutocomplete } from "./todo-autocomplete.ts";
import { initDownloadImages, downloadExternalImages } from "./download-images.ts";
import { initImagePaste, handlePaste, handleImageDrop } from "./image-paste.ts";
import { initNoteRefactor, extractToNewNote } from "./note-refactor.ts";
import { initFrontmatterPanel, updateFrontmatterPanel } from "./frontmatter-panel.ts";
import {
  initTocPanel,
  updateTocPanel,
  updateTocActiveHeading,
  toggleTocPanel,
} from "./toc-panel.ts";
import { startPresentation } from "./presentation.ts";
import {
  setPublishProjectRoot,
  loadPublishState,
  isPublished,
  getPublishUrl,
  publishedItems,
  publishOptionItems,
} from "./publish.ts";
import { showDropdown, type MenuItem } from "./context-menu.ts";
import { hydrateIcons, icon } from "./icons.ts";
import { escapeHtml } from "./html-utils.ts";
import { getAppearance, watchAppearance } from "./appearance.ts";
// --- Window label (must run before any state restoration) ---
initWindowLabel();
const isFreshWindow = new URLSearchParams(window.location.search).has("fresh");

// --- One-time migration: copy unscoped keys to window-scoped keys for "main" window ---
{
  if (!localStorage.getItem(KEY_V2_WINDOW_MIGRATED) && !isFreshWindow) {
    const keysToMigrate = [
      KEY_TABS,
      KEY_SIDEBAR,
      KEY_SIDEBAR_PANEL,
      KEY_SIDEBAR_COLLAPSED,
      KEY_EDITOR_COLLAPSED,
      KEY_PREVIEW_COLLAPSED,
    ];
    for (const key of keysToMigrate) {
      const val = localStorage.getItem(key);
      if (val !== null) localStorage.setItem(windowKey(key), val);
    }
    localStorage.setItem(KEY_V2_WINDOW_MIGRATED, "1");
  }
}

// --- Tauri APIs ---

const { invoke } = window.__TAURI__.core;

// --- Shared state ---

let previewTimeout: ReturnType<typeof setTimeout> | null = null;

function getCurrentFilePath() {
  return getActiveTab()?.path ?? null;
}

// --- CodeMirror Editor ---

// Latest doc state with a not-yet-flushed tab content update. Materializing
// doc.toString() on every keystroke is O(doc size), so it is deferred to the
// debounced callback below; tabs.ts flushes it early when tab content is read.
let pendingDocState: EditorState | null = null;

function flushPendingContent(): string | null {
  if (!pendingDocState) return null;
  const content = pendingDocState.doc.toString();
  pendingDocState = null;
  updateActiveTab({ content });
  return content;
}

setTabContentFlusher(flushPendingContent);

// Skip preview rendering while the preview pane is collapsed; render once on expand
let previewDirty = false;

const updatePreviewListener = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    scrollState.pendingRender = true;
    pendingDocState = update.state;
    if (previewTimeout) clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      previewTimeout = null;
      const content = flushPendingContent() ?? editor.state.doc.toString();
      if (previewWrapper.classList.contains("collapsed")) {
        previewDirty = true;
      } else {
        renderPreview(content);
      }
      updateFrontmatterPanel(content);
      updateTocPanel(content);
      updateStatus(editor.state);
    }, 100);
    scheduleAutoSave();
    syncEditorState();
  }
  if (update.selectionSet && !update.docChanged && !scrollState.pendingRender) {
    scrollState.activeSide = "editor";
    cancelAnimationFrame(scrollState.syncRAF);
    scrollState.syncRAF = requestAnimationFrame(syncPreviewToCursor);
  }
});

const lineNumbersCompartment = new Compartment();

const editor = new EditorView({
  state: EditorState.create({
    doc: "",
    extensions: [
      lineNumbersCompartment.of(getAppearance().lineNumbers ? lineNumbers() : []),
      placeholder("Start writing, or paste a URL above…"),
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
        { key: "Mod-Shift-`", run: insertCodeBlock },
        {
          key: "Mod-f",
          run: () => {
            if (!isPreviewSearchTarget()) return false;
            openPreviewSearch();
            return true;
          },
        },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      autoLinkTitle,
      smartTypography,
      todoAutocomplete,
      updatePreviewListener,
      EditorView.lineWrapping,
    ],
  }),
  parent: document.getElementById("editor-pane")!,
});

// --- DOM references ---

const previewPane = document.getElementById("preview-pane")!;
const editorPane = document.getElementById("editor-pane")!;
const cmScroller = editor.dom.querySelector(".cm-scroller")! as HTMLElement;
hydrateIcons();
watchAppearance(({ lineNumbers: show }) => {
  editor.dispatch({ effects: lineNumbersCompartment.reconfigure(show ? lineNumbers() : []) });
});
const statusEl = document.getElementById("status")!;

// --- Initialize modules ---

initScrollSync(editor, previewPane, cmScroller);
initPreview(previewPane);
setFilePathGetter(getCurrentFilePath);
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
  updateTocPanel(content);
  if (previewTimeout) {
    clearTimeout(previewTimeout);
    previewTimeout = null;
  }
  // Callers of loadContent set tab.content themselves, so the pending
  // editor→tab sync from the dispatch above must not fire later.
  pendingDocState = null;
  scrollState.pendingRender = false;
  updateStatus(editor.state);
}

/** Open a GitHub issue or pull request as an editable document tab. */
function openRemoteTab(repo: string, kind: GhKind, detail: GhItemDetail) {
  openTab(
    null,
    remoteTabName(kind, detail.number, detail.title),
    buildDocument(detail),
    toRemoteRef(repo, kind, detail),
  );
}

function loadContentAsTab(content: string, filePath?: string, tabName?: string) {
  const name = tabName || (filePath ? basename(filePath) : "Untitled");
  openTab(filePath || null, name, content);
  if (filePath) {
    invoke("add_recent_file", { path: filePath }).catch(() => {});
  }
}

// --- Status bar ---
// Left: #status shows transient messages from any module. Right: document state.

const wordSegmenter =
  "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
let countedDoc: EditorState["doc"] | null = null;
let countedWords = 0;

function countWords(text: string): number {
  if (!wordSegmenter) return text.split(/\s+/).filter(Boolean).length;
  let n = 0;
  for (const segment of wordSegmenter.segment(text)) if (segment.isWordLike) n++;
  return n;
}

function updateStatus(state: EditorState) {
  const showChars = localStorage.getItem(KEY_STATUS_COUNT) === "chars";
  const count = document.getElementById("status-count")!;
  if (showChars) {
    count.textContent = `${state.doc.length.toLocaleString()} characters`;
  } else {
    if (countedDoc !== state.doc) {
      countedDoc = state.doc;
      countedWords = countWords(state.doc.toString());
    }
    count.textContent = `${countedWords.toLocaleString()} ${countedWords === 1 ? "word" : "words"}`;
  }

  const branchEl = document.getElementById("status-branch")!;
  const branch = getBranch();
  branchEl.hidden = !branch;
  if (branch) {
    const { ahead, behind } = getSyncCounts();
    const sync =
      (ahead ? `<span class="status-sync">${icon("arrow-up", 11)}${ahead}</span>` : "") +
      (behind ? `<span class="status-sync">${icon("arrow-down", 11)}${behind}</span>` : "");
    branchEl.innerHTML = `${icon("git-branch", 12)}<span>${escapeHtml(branch)}</span>${sync}`;
  }

  const isBlank = !getCurrentFilePath() && state.doc.length === 0;
  document.getElementById("preview-wrapper")!.classList.toggle("is-empty", isBlank);

  const publishedEl = document.getElementById("status-published")!;
  const target = publishTarget();
  const published = !!target && isPublished(target.relPath);
  publishedEl.hidden = !published;
  if (published) publishedEl.innerHTML = `${icon("cloud-upload", 12)}Published`;

  updatePublishButton();
}

const WORKER_HEALTH_TITLES: Record<WorkerHealth, string> = {
  none: "No Cloudflare Worker set up. Click to open Settings.",
  unknown: "Cloudflare Worker configured. Click to open Settings.",
  ok: "Cloudflare Worker connected",
  warn: "Cloudflare Worker needs an update. Click to open Settings.",
  error: "Cloudflare Worker is not reachable. Click to open Settings.",
};

function updateWorkerStatus() {
  const el = document.getElementById("status-worker")!;
  const health = getWorkerHealth();
  el.dataset.health = health;
  el.title = WORKER_HEALTH_TITLES[health];
}

function initStatusBar() {
  onClick("status-count", () => {
    const showChars = localStorage.getItem(KEY_STATUS_COUNT) === "chars";
    localStorage.setItem(KEY_STATUS_COUNT, showChars ? "words" : "chars");
    updateStatus(editor.state);
  });
  onClick("status-branch", () => {
    if (sidebarEl.classList.contains("collapsed")) toggleSidebar();
    switchPanel("git");
  });
  onClick("status-published", async () => {
    const target = publishTarget();
    const url = target && getPublishUrl(target.relPath);
    if (!url) return;
    await invoke("copy_to_clipboard", { text: url });
    statusEl.textContent = "Public URL copied";
  });
  onClick("status-worker", () => document.getElementById("btn-settings")!.click());
  window.addEventListener(WORKER_STATUS_EVENT, updateWorkerStatus);
  updateWorkerStatus();
  setTimeout(refreshWorkerHealth, 1500);

  // Transient messages fade after a while; document state lives on the right
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => (statusEl.textContent = ""), 10_000);
  }).observe(statusEl, { childList: true, characterData: true, subtree: true });
}

let gitRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
const GIT_REFRESH_DEBOUNCE = 2000;

async function doGitRefresh() {
  // Badges are updated by the git panel's onRefresh callback.
  await refreshGit();
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

/** Git refresh after an autosave. An already-modified (unstaged) file stays
 * modified after another save — only the line counts shown inside the git
 * panel change — so skip the git process spawns while the panel is hidden. */
function refreshGitAfterAutoSave(path: string) {
  if (getActivePanel() !== "git") {
    const root = getRootPath();
    const rel = root ? relativeToRoot(root, path) : path;
    const entry = getStatusMap().get(rel);
    if (entry && !entry.staged) return;
  }
  refreshGitAndSync();
}

/** Reload all open file-backed tabs from disk (after git ops that modify files). */
/** Reload open files after a git operation, asking before dropping unsaved edits. */
async function reloadAllOpenTabs() {
  const fileTabs = getTabs().filter((t) => t.path);
  const reads = await Promise.all(
    fileTabs.map((tab) =>
      invoke<string>("read_text_file", { path: tab.path! }).then(
        (content) => ({ tab, content }),
        () => null,
      ),
    ),
  );
  const conflicts: { tab: Tab; content: string }[] = [];
  for (const read of reads) {
    // Unchanged on disk since it was loaded: keep any unsaved edits
    if (!read || read.content === read.tab.savedContent) continue;
    if (isTabDirty(read.tab)) conflicts.push(read);
    else if (read.content !== read.tab.content) applyDiskContent(read.tab, read.content);
  }
  if (conflicts.length > 0) {
    const names = conflicts.map((c) => c.tab.name).join(", ");
    const reload = await confirmDialog(
      `Changed on disk: ${names}\n\nReload and discard your unsaved changes?`,
      { title: "Files Changed", kind: "warning" },
    );
    if (reload) for (const c of conflicts) applyDiskContent(c.tab, c.content);
  }
  refreshTree();
}

// --- Initialize file-ops and MCP sync (need orchestration functions) ---

initFileOps({
  editor,
  statusEl,
  getCurrentFilePath,
  loadContentAsTab,
  refreshGitAndSync,
  refreshGitAfterAutoSave,
  applyEditorContent: (content: string) => loadContent(content),
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
  refreshTree,
});

// Initial render of the welcome document happens after initTabs() below —
// when a tab is restored, its activation renders instead.

// --- Toolbar Actions ---

function onClick(id: string, handler: (button: HTMLElement) => void) {
  const button = document.getElementById(id)!;
  button.addEventListener("click", () => handler(button));
}

/** Reveal the clone panel, expanding the sidebar when it is collapsed. */
function showClonePanel() {
  if (sidebarEl.classList.contains("collapsed")) toggleSidebar();
  switchPanel("clone");
}

onClick("btn-sidebar", () => toggleSidebar());
onClick("btn-import", (button) =>
  showDropdown(button, [
    { label: "Import Document…", shortcut: "⇧⌘I", action: importFile },
    null,
    { label: "Open File…", shortcut: "⌘O", action: openFile },
    { label: "Open Folder…", shortcut: "⇧⌘O", action: openFolder },
    { label: "Clone Repository…", action: showClonePanel },
  ]),
);
onClick("btn-table", () => editTableAtCursor(editor));

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

onClick("btn-cleanup", cleanupDocument);
onClick("btn-copy", (button) =>
  showDropdown(button, [
    { label: "Copy as Rich Text", action: copyRichText },
    { label: "Copy as Markdown", action: copyMarkdown },
  ]),
);
onClick("btn-publish", (button) => showDropdown(button, publishMenu()));
onClick("btn-present", () => startPresentation(editor.state.doc.toString()));
onClick("btn-palette", () => toggleCommandPalette());
onClick("btn-settings", () => {
  showSettings({
    onSave: (url: string) => {
      statusEl.textContent = url ? `Worker URL: ${url}` : "Worker URL cleared";
      updatePublishButton();
    },
  });
});

initStatusBar();

// File menu items emit these (src-tauri/src/menu.rs)
const MENU_ACTIONS: Record<string, () => void> = {
  open: openFile,
  "open-folder": openFolder,
  save: saveFile,
  import: importFile,
};

// The toolbar leaves room for the traffic lights except in fullscreen
const appWindow = window.__TAURI__.window?.getCurrentWindow();
async function syncFullscreen() {
  if (appWindow) document.body.classList.toggle("fullscreen", await appWindow.isFullscreen());
}
appWindow?.onResized(syncFullscreen);
syncFullscreen();

/** The active tab's file, if it is a saved Markdown file inside the open project. */
function publishTarget(): { absPath: string; relPath: string } | null {
  const path = getCurrentFilePath();
  const root = getRootPath();
  if (!path || !root || !path.startsWith(`${root}/`)) return null;
  if (!MD_EXTENSIONS.has(getExtension(path))) return null;
  return { absPath: path, relPath: relativeToRoot(root, path) };
}

function publishMenu(): MenuItem[] {
  const target = publishTarget();
  if (!target) return [];
  const onChange = () => {
    refreshTree();
    updatePublishButton();
  };
  // Publishing reads the file from disk, so save pending edits first
  const saveFirst = async () => {
    const tab = getActiveTab();
    if (tab && isTabDirty(tab)) await saveFile();
  };
  return isPublished(target.relPath)
    ? publishedItems(target.absPath, target.relPath, onChange, saveFirst)
    : publishOptionItems(target.absPath, target.relPath, onChange, saveFirst);
}

function updatePublishButton() {
  const btnPublish = document.getElementById("btn-publish") as HTMLButtonElement;
  const target = publishTarget();
  const reason = !getWorkerUrl()
    ? "Set up a Cloudflare Worker in Settings to publish"
    : !target
      ? "Open a Markdown file from the project folder to publish it"
      : null;
  btnPublish.disabled = reason !== null;
  btnPublish.title = reason ?? "Publish this file to a shareable URL";
  btnPublish.classList.toggle("published", !!target && isPublished(target.relPath));
}

// --- Auto-save ---

window.addEventListener("blur", autoSave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) autoSave();
});

// Refresh sidebar tree and git status when window regains focus.
// Catches file changes made by external tools (Cowork, Finder, terminal, etc.)
// that macOS FSEvents may have missed.
window.addEventListener("focus", () => {
  refreshTree();
  refreshGitAndSync();
});

// --- URL Bar ---

const urlBar = document.getElementById("url-bar")!;
const urlInput = document.getElementById("url-input")! as HTMLInputElement;

onClick("btn-get", () => getUrl(urlInput, urlBar));
onClick("btn-get-menu", (button) => {
  const renderReady = isRenderAvailable();
  showDropdown(button, [
    { label: "Get as Markdown", shortcut: "↩", action: () => getUrl(urlInput, urlBar) },
    { label: "Fetch Static Page", action: () => fetchUrl(urlInput, urlBar) },
    {
      label: "Render with Browser",
      action: () => renderUrl(urlInput, urlBar),
      disabled: !renderReady,
      title: renderReady
        ? "Render JavaScript pages before converting"
        : "Needs a Worker with Browser Run",
    },
    null,
    { label: "Crawl Site…", action: () => crawlUrl(urlInput, urlBar) },
  ]);
});
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") getUrl(urlInput, urlBar);
});

// --- Drag & Drop ---

initDragDrop(document.getElementById("app")!);

// Image drag from sidebar tree → insert Markdown image link at drop position
cmScroller.addEventListener("dragover", (e) => {
  if (
    !e.dataTransfer?.types.includes(SIDEBAR_IMAGE_MIME) &&
    !e.dataTransfer?.types.includes("Files")
  )
    return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
cmScroller.addEventListener("drop", (e) => {
  // Sidebar image drag
  const imagePath = e.dataTransfer?.getData(SIDEBAR_IMAGE_MIME);
  if (imagePath) {
    e.preventDefault();
    e.stopPropagation();
    const pos =
      editor.posAtCoords({ x: e.clientX, y: e.clientY }) ?? editor.state.selection.main.head;
    const currentFile = getCurrentFilePath();
    const fileName = basename(imagePath).replace(/\.[^.]+$/, "");
    const relativePath = currentFile
      ? buildRelativePath(currentFile, imagePath)
      : basename(imagePath);
    const imageLink = `![${escapeLinkText(fileName)}](${encodeLinkPath(relativePath)})`;
    editor.dispatch({
      changes: { from: pos, insert: imageLink },
      selection: { anchor: pos + imageLink.length },
    });
    editor.focus();
    statusEl.textContent = `Inserted image: ${basename(imagePath)}`;
    return;
  }
  // External image file drop → save to ./assets/ and insert link
  handleImageDrop(e);
});

// Clipboard paste → save image to ./assets/ and insert link
editor.dom.addEventListener("paste", (e) => handlePaste(e));

// --- MCP Bridge ---

initBridgeListeners();
syncEditorState();

// CLI file open + Open Recent menu (same handler)
async function openFileByPath(path: string) {
  try {
    const content = await invoke<string>("read_text_file", { path });
    loadContentAsTab(content, path);
  } catch (e) {
    statusEl.textContent = `Failed to open: ${e}`;
  }
}
if (window.__TAURI__.event) {
  // Files opened at launch wait in the backend until this listener exists
  listenToWindow<string>("cli:open-file", (e) => openFileByPath(e.payload)).then(async () => {
    for (const path of await invoke<string[]>("take_pending_open_files")) {
      await openFileByPath(path);
    }
  });
  listenToWindow<string>("menu:open-recent", (e) => openFileByPath(e.payload));
  listenToWindow<string>("menu:action", (e) => MENU_ACTIONS[e.payload]?.());
}

async function openSearchResult(filePath: string) {
  const root = getRootPath();
  if (!root) return;
  await openFileByPath(`${root}/${filePath}`);
}

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
/** Open a local file linked from the preview, resolved against the current file. */
async function openLocalLink(href: string) {
  const [rawPath] = href.split(/[?#]/);
  if (!rawPath) return;
  let target = rawPath;
  try {
    target = decodeURIComponent(rawPath);
  } catch {}
  let path: string;
  if (target.startsWith("/")) {
    path = target;
  } else {
    const current = getCurrentFilePath();
    if (!current) {
      statusEl.textContent = "Save this file first to follow relative links";
      return;
    }
    path = resolveRelativePath(current, target);
  }
  if (SYSTEM_OPEN_EXTENSIONS.has(getExtension(path))) {
    try {
      await invoke("open_with_default_app", { path });
    } catch (e) {
      statusEl.textContent = `Failed to open: ${e}`;
    }
    return;
  }
  await openFileByPath(path);
}

// Never let a link navigate the app webview away (preview, presentation
// slides, settings, toasts). Web and mail links open in the default app
// instead; local links are handled by the preview handler below, which still
// sees the click because this runs in the capture phase.
document.addEventListener(
  "click",
  (e) => {
    const anchor = (e.target as Element | null)?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href === "" || href.startsWith("#")) return;
    e.preventDefault();
    if (/^(https?:\/\/|mailto:)/i.test(href)) invoke("plugin:shell|open", { path: href });
  },
  true,
);

previewPane.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (href && !href.startsWith("#")) {
      // Relative/absolute local path (URI schemes are handled by the
      // document-level link handler above)
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) openLocalLink(href);
      return;
    }
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  syncPreviewClickToEditor(e);
});

// --- Frontmatter panel ---

const editorContainer = document.getElementById("editor-container")!;
initFrontmatterPanel(editor, editorContainer, editorPane);

// --- Download images & note refactor ---

initDownloadImages({ editor, statusEl, getCurrentFilePath });
initImagePaste({ editor, statusEl, getCurrentFilePath });
initNoteRefactor({ editor, statusEl, getCurrentFilePath, loadContentAsTab });

// --- Link context menu in preview ---

initLinkContextMenu(previewPane, {
  getUrl,
  fetchUrl,
  renderUrl,
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
const previewWrapper = document.getElementById("preview-wrapper")!;

// --- TOC panel (above preview) ---
initTocPanel(editor, previewWrapper);
let tocRafPending = false;
cmScroller.addEventListener(
  "scroll",
  () => {
    if (tocRafPending) return;
    tocRafPending = true;
    requestAnimationFrame(() => {
      tocRafPending = false;
      updateTocActiveHeading();
    });
  },
  { passive: true },
);

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

makeDraggable(divider, (clientX) => {
  const editorLeft = editorContainer.getBoundingClientRect().left;
  const totalWidth = previewWrapper.getBoundingClientRect().right - editorLeft;
  const ratio = (clientX - editorLeft) / totalWidth;
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  editorContainer.style.flex = `${clamped}`;
});

// --- Sidebar ---

const sidebarEl = document.getElementById("sidebar")!;
const sidebarDivider = document.getElementById("sidebar-divider")!;

const sidebarCollapsed = getStorageBool(windowKey(KEY_SIDEBAR_COLLAPSED), false);
if (sidebarCollapsed) {
  sidebarEl.classList.add("collapsed");
}

initSidebar(sidebarEl, {
  onOpen: (content: string, filePath: string) => {
    loadContentAsTab(content, filePath);
  },
  beforeFolder: async () => {
    const dirty = getDirtyFileTabs();
    if (dirty.length === 0) return true;
    const names = dirty.map((t) => t.name).join(", ");
    return window.__TAURI__.dialog.confirm(
      `Unsaved changes in: ${names}\n\nSwitch project without saving?`,
      { title: "Unsaved Changes", kind: "warning" },
    );
  },
  onFolder: async (rootPath: string) => {
    // Save current tabs, restore tabs for the new project
    switchProjectTabs(rootPath, reloadTab);
    // Stop watchers for old tabs, start watchers for new tabs
    stopAllFileWatchers();
    for (const tab of getTabs()) {
      if (tab.path) startWatching(tab.path);
    }
    setRepoPath(rootPath);
    setGitHubRepoPath(rootPath);
    setPublishProjectRoot(rootPath);
    loadPublishState().catch(() => {});
    refreshGitAndSyncNow();
  },
  onDirChange: () => {
    refreshGitAndSync();
  },
  onRename: (oldPath, newPath) => {
    updateTabPath(oldPath, newPath);
    // Move watchers to the new paths, including open files inside a renamed directory
    stopWatchingUnder(oldPath);
    for (const tab of getTabs()) {
      if (tab.path === newPath || tab.path?.startsWith(`${newPath}/`)) startWatching(tab.path);
    }
    // Reload active tab if it was renamed (path changed, content may differ)
    const active = getActiveTab();
    if (active?.path === newPath) {
      updateStatus(editor.state);
    }
  },
  onDelete: (paths, hadDir) => {
    for (const p of paths) {
      stopWatchingUnder(p);
      if (hadDir) {
        closeTabsUnderDir(p);
      } else {
        closeTabsByPath([p]);
      }
    }
  },
  skipRestore: isFreshWindow,
});

const gitPanelEl = getGitPanelEl();
if (gitPanelEl) {
  initGitPanel(gitPanelEl, {
    onOpen: openFileByPath,
    onRefresh: () => {
      setGitStatus(getStatusMap());
      updateGitChangeCount(getChangeCount());
    },
    onFilesChanged: () => reloadAllOpenTabs(),
    isVisible: () => getActivePanel() === "git",
  });
}

const gitHubPanelEl = getGitHubPanelEl();
if (gitHubPanelEl) {
  initGitHubPanel(gitHubPanelEl, {
    onOpen: openRemoteTab,
    isVisible: () => getActivePanel() === "github",
  });
}

const clonePanelEl = getClonePanelEl();
if (clonePanelEl) {
  initClonePanel(clonePanelEl, {
    onComplete: (repoPath: string) => {
      openFolderByPath(repoPath);
      statusEl.textContent = `Cloned: ${basename(repoPath)}`;
    },
  });
}

const initialRoot = getRootPath();
if (initialRoot) {
  setRepoPath(initialRoot);
  setGitHubRepoPath(initialRoot);
  if (getActivePanel() === "github") refreshGitHubPanel();
  setPublishProjectRoot(initialRoot);
  loadPublishState().catch(() => {});
  refreshGitAndSyncNow();
}

const sidebarToggleBtn = document.getElementById("btn-sidebar")!;

function syncSidebarToggle() {
  sidebarToggleBtn.setAttribute("aria-pressed", String(!sidebarEl.classList.contains("collapsed")));
}

function toggleSidebar() {
  preservePreviewScroll(() => {
    const collapsed = sidebarEl.classList.toggle("collapsed");
    syncSidebarToggle();
    setStorageBool(windowKey(KEY_SIDEBAR_COLLAPSED), collapsed);
  });
}

/** Reveal the GitHub panel, expanding the sidebar when it is collapsed. */
function showGitHubPanel(kind?: GhKind) {
  if (sidebarEl.classList.contains("collapsed")) toggleSidebar();
  switchPanel("github");
  if (kind) setGitHubKind(kind);
}

makeDraggable(
  sidebarDivider,
  (clientX) => {
    const width = Math.max(120, Math.min(400, clientX));
    sidebarEl.style.width = `${width}px`;
    sidebarEl.classList.remove("collapsed");
    syncSidebarToggle();
  },
  () => {
    setStorageBool(windowKey(KEY_SIDEBAR_COLLAPSED), false);
  },
);

// --- Panel Fold/Unfold ---

const SVG_CHEVRON_LEFT = icon("chevron-left", 14);
const SVG_CHEVRON_RIGHT = icon("chevron-right", 14);

// Editor fold button (in tab-bar, right side)
const editorFoldBtn = document.createElement("button");
editorFoldBtn.className = "icon-btn icon-btn-sm panel-fold-btn";
editorFoldBtn.title = "Collapse Editor (⌘2)";
editorFoldBtn.setAttribute("aria-label", editorFoldBtn.title);
editorFoldBtn.innerHTML = SVG_CHEVRON_LEFT;

// Preview header with fold button
const previewHeader = document.createElement("div");
previewHeader.className = "preview-header";
const previewTitle = document.createElement("span");
previewTitle.className = "pane-title";
previewTitle.textContent = "Preview";
previewHeader.appendChild(previewTitle);
const previewFoldBtn = document.createElement("button");
previewFoldBtn.className = "icon-btn icon-btn-sm panel-fold-btn";
previewFoldBtn.title = "Collapse Preview (⌘3)";
previewFoldBtn.setAttribute("aria-label", previewFoldBtn.title);
previewFoldBtn.innerHTML = SVG_CHEVRON_RIGHT;
previewHeader.appendChild(previewFoldBtn);
previewWrapper.prepend(previewHeader);
initPreviewSearch(previewPane, previewWrapper, editorContainer, { onClose: () => editor.focus() });

// Start sheet: covers the blank preview while an untitled document is empty.
// It is chrome, not content, so it never reaches the document, print, or MCP.
const startSheet = document.createElement("div");
startSheet.className = "start-sheet";
startSheet.innerHTML = `
  <svg class="start-mark" viewBox="240 260 544 580" aria-hidden="true">
    <g fill="none" stroke-width="80" stroke-linejoin="miter" stroke-miterlimit="6">
      <path d="M290,566 V306 L512,540 L734,306 V566" stroke="var(--ink)"/>
      <path d="M512,540 V762" stroke="var(--accent)"/>
      <path d="M394,674 L512,792 L630,674" stroke="var(--accent)"/>
    </g>
  </svg>
  <h2>Start with anything</h2>
  <p>Write on the left, or bring in a web page, a PDF, an Office file, or a whole site.</p>
  <div class="start-actions">
    <button class="btn" data-start="url">${icon("link")}Paste a URL</button>
    <button class="btn" data-start="import">${icon("file-down")}Import a Document</button>
    <button class="btn" data-start="folder">${icon("folder-open")}Open a Folder</button>
  </div>
  <p class="start-hint"><kbd>⌘K</kbd> for everything else</p>`;
startSheet.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-start]")?.dataset.start;
  if (action === "url") document.getElementById("url-input")!.focus();
  else if (action === "import") importFile();
  else if (action === "folder") openFolder();
});
previewWrapper.appendChild(startSheet);

// Unfold buttons live in the other pane's header while a pane is collapsed

const editorUnfoldBtn = document.createElement("button");
editorUnfoldBtn.className = "icon-btn icon-btn-sm panel-unfold-btn";
editorUnfoldBtn.title = "Expand Editor (⌘2)";
editorUnfoldBtn.setAttribute("aria-label", editorUnfoldBtn.title);
editorUnfoldBtn.innerHTML = SVG_CHEVRON_RIGHT;
previewHeader.prepend(editorUnfoldBtn);

const previewUnfoldBtn = document.createElement("button");
previewUnfoldBtn.className = "icon-btn icon-btn-sm panel-unfold-btn";
previewUnfoldBtn.title = "Expand Preview (⌘3)";
previewUnfoldBtn.setAttribute("aria-label", previewUnfoldBtn.title);
previewUnfoldBtn.innerHTML = SVG_CHEVRON_LEFT;

function updateDividerVisibility() {
  const eitherCollapsed =
    editorContainer.classList.contains("collapsed") ||
    previewWrapper.classList.contains("collapsed");
  divider.classList.toggle("hidden", eitherCollapsed);
}

function toggleEditor() {
  // Never hide both panes: collapsing one reveals the other
  if (
    !editorContainer.classList.contains("collapsed") &&
    previewWrapper.classList.contains("collapsed")
  ) {
    togglePreview();
  }
  preservePreviewScroll(() => {
    const collapsed = editorContainer.classList.toggle("collapsed");
    editorUnfoldBtn.classList.toggle("visible", collapsed);
    updateDividerVisibility();
    setStorageBool(windowKey(KEY_EDITOR_COLLAPSED), collapsed);
  });
}

function togglePreview() {
  if (
    !previewWrapper.classList.contains("collapsed") &&
    editorContainer.classList.contains("collapsed")
  ) {
    toggleEditor();
  }
  const collapsed = previewWrapper.classList.toggle("collapsed");
  previewUnfoldBtn.classList.toggle("visible", collapsed);
  updateDividerVisibility();
  setStorageBool(windowKey(KEY_PREVIEW_COLLAPSED), collapsed);
  if (!collapsed && previewDirty) {
    previewDirty = false;
    renderPreview(flushPendingContent() ?? editor.state.doc.toString());
  }
}

async function printPreview() {
  statusEl.textContent = "Preparing print…";
  // Re-render so the printout reflects the latest edits even while the
  // preview pane is collapsed (renders are skipped in that state)
  const content = flushPendingContent() ?? editor.state.doc.toString();
  await renderPreview(content);
  previewDirty = false;
  // Lazy images outside the viewport never load — force-load them for print
  const imgs = Array.from(previewPane.querySelectorAll("img")) as HTMLImageElement[];
  for (const img of imgs) img.loading = "eager";
  await Promise.allSettled(imgs.map((img) => img.decode()));
  updateStatus(editor.state);
  try {
    await invoke("print_webview");
  } catch (e) {
    statusEl.textContent = `Print failed: ${e}`;
  }
}

editorFoldBtn.addEventListener("click", toggleEditor);
previewFoldBtn.addEventListener("click", togglePreview);
editorUnfoldBtn.addEventListener("click", toggleEditor);
previewUnfoldBtn.addEventListener("click", togglePreview);
// Restore collapsed states
syncSidebarToggle();
if (getStorageBool(windowKey(KEY_EDITOR_COLLAPSED), false)) {
  editorContainer.classList.add("collapsed");
  divider.classList.add("hidden");
  editorUnfoldBtn.classList.add("visible");
}
if (
  getStorageBool(windowKey(KEY_PREVIEW_COLLAPSED), false) &&
  !editorContainer.classList.contains("collapsed")
) {
  previewWrapper.classList.add("collapsed");
  divider.classList.add("hidden");
  previewUnfoldBtn.classList.add("visible");
}

// --- Tabs ---

const tabBarEl = document.getElementById("tab-bar")!;

// Last-seen (mtime, size) per file path — gates disk re-reads on tab switch
const tabStatKeys = new Map<string, string>();

// --- File Watcher ---

const { confirm: confirmDialog } = window.__TAURI__.dialog;

/** Apply freshly-read disk content to a tab (and the editor when active). */
function applyDiskContent(tab: Tab, content: string) {
  tab.content = content;
  markTabSaved(tab.id);
  if (tab.id === getActiveTab()?.id) {
    loadContent(content, tab.path);
  }
}

async function reloadTabFromDisk(path: string) {
  const content = await invoke<string>("read_text_file", { path });
  const tab = getTabByPath(path);
  if (!tab || (!isTabDirty(tab) && tab.content === content)) return;
  applyDiskContent(tab, content);
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
  onFileDeleted: (path: string) => {
    stopWatching(path);
    closeTabsByPath([path]);
  },
});

// Set project root before restoring tabs so the correct per-project key is used
setTabsProjectRoot(getRootPath());

// Shared tab reload logic — used by initTabs.onReload and switchProjectTabs
async function reloadTab(tab: Tab) {
  if (tab.remote) {
    try {
      const { document: doc } = await reloadRemoteTab(tab.remote);
      setTabContent(tab.id, doc);
      markTabSaved(tab.id);
      if (getActiveTab()?.id === tab.id) loadContent(doc);
    } catch (e) {
      statusEl.textContent = `Failed to load ${tab.name}: ${e}`;
    }
    return;
  }
  if (!tab.path) return;
  try {
    const content = await invoke<string>("read_text_file", { path: tab.path });
    // The user may have switched tabs while the read was in flight
    setTabContent(tab.id, content);
    markTabSaved(tab.id, content);
    if (getActiveTab()?.id === tab.id) loadContent(content, tab.path);
  } catch {
    if (getActiveTab()?.id === tab.id) loadContent("", tab.path);
  }
}

/** Ask before closing a tab whose content would be lost. */
async function confirmCloseTab(tab: Tab): Promise<boolean> {
  if (tab.path && isTabDirty(tab)) {
    if (isAutoSaveEnabled()) return saveTabToDisk(tab);
    const choice = await window.__TAURI__.dialog.message(`"${tab.name}" has unsaved changes.`, {
      title: "Unsaved Changes",
      kind: "warning",
      buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
    });
    if (choice === "Save") return saveTabToDisk(tab);
    return choice === "Don't Save";
  }
  const unsavedText = tab.remote ? isTabDirty(tab) : !tab.path && tab.content.trim() !== "";
  if (!unsavedText) return true;
  const what = tab.remote
    ? "Unsaved edits will not be pushed to GitHub."
    : "Its content has not been saved to a file.";
  return confirmDialog(`Close "${tab.name}"? ${what}`, {
    title: "Unsaved Changes",
    kind: "warning",
    okLabel: "Close",
  });
}

initTabs(tabBarEl, {
  onSwitch: (tab: Tab) => {
    // Restored background tabs have no content yet; load it from the source
    if ((tab.path || tab.remote) && tab.savedContent === null) {
      loadContent("", tab.path);
      reloadTab(tab);
      return;
    }
    loadContent(tab.content, tab.path);
    // Check if file changed on disk since last load (catches missed watcher events).
    // Cheap (mtime, size) gate first — only re-read the file when it changed.
    if (tab.path && tab.savedContent !== null) {
      const path = tab.path;
      invoke<{ mtime_ms: number; size: number }>("stat_file", { path })
        .then((stat) => {
          const statKey = `${stat.mtime_ms}:${stat.size}`;
          if (tabStatKeys.get(path) === statKey) return;
          tabStatKeys.set(path, statKey);
          return invoke<string>("read_text_file", { path }).then(async (diskContent) => {
            if (diskContent === tab.savedContent || tab.id !== getActiveTab()?.id) return;
            if (isTabDirty(tab)) {
              const fileName = basename(path);
              const reload = await confirmDialog(
                `"${fileName}" has been modified externally.\nReload and discard your unsaved changes?`,
                { title: "File Changed", kind: "warning" },
              );
              if (!reload || tab.id !== getActiveTab()?.id) return;
            }
            applyDiskContent(tab, diskContent);
          });
        })
        .catch(() => {});
    }
  },
  onEmpty: () => {
    loadContent("");
  },
  onReload: reloadTab,
  onOpen: (tab) => {
    if (tab.path) startWatching(tab.path);
  },
  onClose: (tab) => {
    if (tab.path) stopWatching(tab.path);
  },
  onLeave: (tab) => {
    // The outgoing tab leaves the editor, so the pending auto-save would no
    // longer see it; write it now.
    if (isAutoSaveEnabled()) saveTabToDisk(tab);
  },
  beforeClose: confirmCloseTab,
  skipRestore: isFreshWindow,
});

// Start watching all previously open file-backed tabs
for (const tab of getTabs()) {
  if (tab.path) startWatching(tab.path);
}

// Initial render — when a tab was restored above its activation already
// rendered, so only the welcome document needs an explicit first render.
if (!getActiveTab()) {
  renderPreview(editor.state.doc.toString()).catch(() => {});
  updateStatus(editor.state);
}

// Editor header: tabs, then the fold button (and the preview unfold button)
document.getElementById("editor-header")!.append(previewUnfoldBtn, editorFoldBtn);

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
    toggleTocPanel();
  } else if (e.key === "5") {
    e.preventDefault();
    openCommandPalette("?");
  } else if (e.key === "c") {
    // Cmd+C with no selection: copy entire content from focused pane
    const active = document.activeElement;

    if (previewPane.contains(active) || active === previewPane) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        e.preventDefault();
        copyRichText();
      }
    } else if (editorPane.contains(active) || active === editorPane) {
      const sel = editor.state.selection.main;
      if (sel.empty) {
        e.preventDefault();
        copyMarkdown();
      }
    }
  } else {
    // ⌘S and ⌘O are File menu accelerators (see menu:action below)
    if (e.key === "w") {
      e.preventDefault();
      closeActiveTab();
    } else if (e.key === "k") {
      e.preventDefault();
      toggleCommandPalette();
    } else if (e.key === "p" && !e.defaultPrevented) {
      // defaultPrevented: Ctrl-p is cursorLineUp inside CodeMirror on macOS
      e.preventDefault();
      printPreview();
    } else if (e.key === "f" && !e.defaultPrevented && isPreviewSearchTarget()) {
      // Leave other text fields (sidebar search, dialogs) to their own handling
      const active = document.activeElement;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (inField && !previewWrapper.contains(active)) return;
      e.preventDefault();
      openPreviewSearch();
    }
  }
});

// --- Command Palette Registry ---

setSemanticSearchHandler(openSearchResult);

registerCommands([
  { id: "file.open", label: "Open File", shortcut: "⌘O", category: "File", run: openFile },
  { id: "file.save", label: "Save File", shortcut: "⌘S", category: "File", run: saveFile },
  {
    id: "file.import",
    label: "Import Document",
    shortcut: "⇧⌘I",
    category: "File",
    run: importFile,
  },
  {
    id: "file.openFolder",
    label: "Open Folder",
    shortcut: "⇧⌘O",
    category: "File",
    run: openFolder,
  },
  { id: "git.clone", label: "Clone Repository", category: "Git", run: showClonePanel },
  {
    id: "github.issues",
    label: "Show GitHub Issues",
    category: "GitHub",
    run: () => showGitHubPanel("issue"),
  },
  {
    id: "github.pulls",
    label: "Show GitHub Pull Requests",
    category: "GitHub",
    run: () => showGitHubPanel("pr"),
  },
  {
    id: "github.refresh",
    label: "Refresh GitHub Issues & Pull Requests",
    category: "GitHub",
    run: () => {
      showGitHubPanel();
      refreshGitHubPanel();
    },
  },
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
    id: "edit.codeBlock",
    label: "Insert Code Block",
    shortcut: "⌘⇧`",
    category: "Edit",
    run: () => insertCodeBlock(editor),
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
    id: "export.print",
    label: "Print Preview",
    shortcut: "⌘P",
    category: "Export",
    run: printPreview,
  },
  {
    id: "convert.get",
    label: "Get URL as Markdown",
    category: "Convert",
    run: () => getUrl(urlInput, urlBar),
  },
  {
    id: "convert.fetch",
    label: "Fetch URL (static only)",
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
    id: "view.toc",
    label: "Toggle Table of Contents",
    shortcut: "⌘4",
    category: "View",
    run: toggleTocPanel,
  },
  {
    id: "search.semantic",
    label: "Semantic Search",
    shortcut: "⌘5",
    category: "Search",
    run: () => openCommandPalette("?"),
  },
  {
    id: "search.preview",
    label: "Find in Preview",
    category: "Search",
    run: () => {
      if (previewWrapper.classList.contains("collapsed")) togglePreview();
      openPreviewSearch();
    },
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

// --- Window registry (session restoration) ---

let lastWindowSnapshot = "";

async function saveWindowRegistry() {
  try {
    // Load current registry and update this window's entry
    type WindowEntry = {
      label: string;
      x?: number;
      y?: number;
      width: number;
      height: number;
    };
    const label = getWindowLabel();
    const entry = {
      label,
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };

    // Skip the load + save IPC round-trip when geometry hasn't changed
    const snapshot = JSON.stringify(entry);
    if (snapshot === lastWindowSnapshot) return;
    lastWindowSnapshot = snapshot;

    const existing: WindowEntry[] = await invoke<WindowEntry[]>("load_window_registry").catch(
      () => [] as WindowEntry[],
    );

    const filtered = (existing as (typeof entry)[]).filter((e) => e.label !== label);
    filtered.push(entry);
    await invoke("save_window_registry", { windows: filtered });
  } catch {
    // ignore
  }
}

// Save registry periodically and on visibility change
setInterval(saveWindowRegistry, 30_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveWindowRegistry();
});

// --- Unsaved changes on window close ---

window.__TAURI__.window?.getCurrentWindow().onCloseRequested(async (event) => {
  flushPendingContent();
  const dirty = getTabs().filter(isTabDirty);
  if (dirty.length === 0) return;
  if (isAutoSaveEnabled() && dirty.every((t) => t.path)) {
    const results = await Promise.all(dirty.map(saveTabToDisk));
    if (results.every(Boolean)) return;
  }
  const names = dirty.map((t) => t.name).join(", ");
  const ok = await confirmDialog(`Unsaved changes in: ${names}\n\nClose the window anyway?`, {
    title: "Unsaved Changes",
    kind: "warning",
    okLabel: "Close",
  });
  if (!ok) event.preventDefault();
});

// --- Cleanup on window close ---

window.addEventListener("beforeunload", () => {
  saveWindowRegistry();
  stopDirWatcher();
  stopAllFileWatchers();
});

// --- First-run ---

checkFirstRun();
checkForUpdate();
watchBundleVersion();

// Preload heavy optional modules during idle time
(globalThis.requestIdleCallback ?? setTimeout)(() => getMermaid());
