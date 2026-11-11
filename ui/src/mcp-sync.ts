import type { EditorView } from "@codemirror/view";
import { basename } from "./path-utils.ts";
import { getWorkerKey, getWorkerUrl } from "./settings.ts";
import {
  getActiveTab,
  getTabByPath,
  getTabs,
  isTabDirty,
  markTabSaved,
  switchTab,
  updateActiveTab,
} from "./tabs.ts";
import { getRootPath } from "./sidebar.ts";
import { suppressNext } from "./file-watcher.ts";
import { getDocumentStructure } from "./document-structure.ts";
import { normalizeMarkdown } from "./normalize.ts";
import { writeTextFile } from "./html-utils.ts";
import { reloadTags } from "./tags.ts";
import { getLintDiagnostics, isLintEnabled } from "./markdown-lint.ts";

const { invoke } = window.__TAURI__.core;

let editor: EditorView;
let statusEl: HTMLElement;
let getCurrentFilePath: () => string | null;
let loadContentAsTab: (content: string, filePath?: string) => void;
let renderPreview: (source: string) => Promise<void>;
let updateStatus: () => void;
let refreshGitAndSync: () => void;

let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSyncedContent: string | null = null;
let lastSyncedFilePath: string | null = null;
let lastSyncedCursorPos: number | null = null;
let cachedStructureJson: string | null = null;
let cachedLintJson: string | null = null;

let refreshTree: () => void;

export function initMcpSync(deps: {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
  loadContentAsTab: (content: string, filePath?: string) => void;
  renderPreview: (source: string) => Promise<void>;
  updateStatus: () => void;
  refreshGitAndSync: () => void;
  refreshTree: () => void;
}) {
  editor = deps.editor;
  statusEl = deps.statusEl;
  getCurrentFilePath = deps.getCurrentFilePath;
  loadContentAsTab = deps.loadContentAsTab;
  renderPreview = deps.renderPreview;
  updateStatus = deps.updateStatus;
  refreshGitAndSync = deps.refreshGitAndSync;
  refreshTree = deps.refreshTree;
}

export function syncEditorState(cachedContent?: string) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    const currentFilePath = getCurrentFilePath();
    const content = cachedContent ?? editor.state.doc.toString();
    const cursorPos = editor.state.selection.main.head;
    const contentChanged = content !== lastSyncedContent || currentFilePath !== lastSyncedFilePath;
    const cursorChanged = cursorPos !== lastSyncedCursorPos;
    if (!contentChanged && !cursorChanged) return;
    lastSyncedCursorPos = cursorPos;
    const cursorLine = editor.state.doc.lineAt(cursorPos);
    const cursor = { pos: cursorPos, line: cursorLine.number, column: cursorPos - cursorLine.from };
    if (!contentChanged) {
      // Cursor-only change: skip the content/structure/tabs payload
      invoke("sync_editor_cursor", { cursor }).catch(() => {});
      return;
    }
    // Structure and lint only depend on the text, not on a file path change.
    if (content !== lastSyncedContent) {
      const structure = getDocumentStructure(content);
      cachedStructureJson = JSON.stringify({
        headings: structure.headings,
        links: structure.links,
        tables: structure.tables,
        frontmatter: structure.frontmatter,
        stats: structure.stats,
      });
      const diagnostics = isLintEnabled() ? getLintDiagnostics(content) : [];
      cachedLintJson = JSON.stringify(diagnostics);
    }
    lastSyncedContent = content;
    lastSyncedFilePath = currentFilePath;
    const tabs = getTabs().map((t) => ({
      id: t.id,
      path: t.path,
      name: t.name,
      is_dirty: isTabDirty(t),
    }));
    const sync = {
      content,
      filePath: currentFilePath,
      workerUrl: getWorkerUrl() || null,
      workerKey: getWorkerKey(),
      documentStructure: cachedStructureJson,
      lintDiagnostics: cachedLintJson,
      rootPath: getRootPath() || null,
      tabs,
    };
    invoke("sync_editor_state", { sync, cursor }).catch(() => {});
  }, 2000);
}

let unlistenFns: Array<() => void> = [];

export function initBridgeListeners() {
  if (!window.__TAURI__?.event) return;

  // Clean up previous listeners to prevent accumulation
  for (const fn of unlistenFns) fn();
  unlistenFns = [];

  const { listen } = window.__TAURI__.event;
  const { invoke } = window.__TAURI__.core;

  const track = (p: Promise<() => void>) => {
    p.then((fn) => unlistenFns.push(fn));
  };

  track(
    listen<string>("bridge:set-content", (event) => {
      loadContentAsTab(event.payload);
    }),
  );

  track(
    listen<{ text: string; position: string }>("bridge:insert-text", (event) => {
      const { text, position } = event.payload;
      let pos: number;
      if (position === "start") {
        pos = 0;
      } else if (position === "end") {
        pos = editor.state.doc.length;
      } else {
        pos = editor.state.selection.main.head;
      }
      editor.dispatch({ changes: { from: pos, insert: text } });
      renderPreview(editor.state.doc.toString());
      updateStatus();
    }),
  );

  track(
    listen<string>("bridge:open-file", async (event) => {
      const path = event.payload;
      try {
        const content = await invoke<string>("read_text_file", { path: path });
        loadContentAsTab(content, path);
        syncEditorState();
      } catch (e) {
        statusEl.textContent = `Open failed: ${e}`;
      }
    }),
  );

  track(
    listen<string>("bridge:save-file", async (event) => {
      const currentFilePath = getCurrentFilePath();
      const path = event.payload || currentFilePath;
      if (!path) return;
      const tab = getActiveTab();
      const content = editor.state.doc.toString();
      try {
        suppressNext(path);
        await writeTextFile(path, content);
        if (tab && getActiveTab()?.id === tab.id) {
          if (!currentFilePath) {
            updateActiveTab({ path, name: basename(path) });
            updateStatus();
          }
          // Writing a copy elsewhere does not save the tab's own file
          if (!currentFilePath || path === currentFilePath) markTabSaved(tab.id, content);
        }
        if (getRootPath()) {
          refreshGitAndSync();
          refreshTree();
        }
      } catch (e) {
        statusEl.textContent = `Save failed: ${e}`;
      }
    }),
  );

  track(
    listen("bridge:normalize", () => {
      const content = editor.state.doc.toString();
      const cleaned = normalizeMarkdown(content);
      if (cleaned !== content) {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: cleaned } });
        renderPreview(cleaned);
      }
      syncEditorState(cleaned);
    }),
  );

  track(
    listen<{ path?: string; tab_id?: string }>("bridge:switch-tab", (event) => {
      const { path, tab_id } = event.payload;
      if (tab_id) {
        switchTab(tab_id);
      } else if (path) {
        const tab = getTabByPath(path);
        if (tab) switchTab(tab.id);
      }
      syncEditorState();
    }),
  );

  track(
    listen("bridge:tags-changed", async () => {
      await reloadTags();
      refreshTree();
    }),
  );
}
