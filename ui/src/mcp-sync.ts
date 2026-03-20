import type { EditorView } from "@codemirror/view";
import { basename } from "./path-utils.ts";
import { getWorkerUrl } from "./settings.ts";
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
let cachedStructureContent: string | null = null;
let cachedStructureJson: string | null = null;

export function initMcpSync(deps: {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
  loadContentAsTab: (content: string, filePath?: string) => void;
  renderPreview: (source: string) => Promise<void>;
  updateStatus: () => void;
  refreshGitAndSync: () => void;
}) {
  editor = deps.editor;
  statusEl = deps.statusEl;
  getCurrentFilePath = deps.getCurrentFilePath;
  loadContentAsTab = deps.loadContentAsTab;
  renderPreview = deps.renderPreview;
  updateStatus = deps.updateStatus;
  refreshGitAndSync = deps.refreshGitAndSync;
}

export function syncEditorState(cachedContent?: string) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    const currentFilePath = getCurrentFilePath();
    const content = cachedContent ?? editor.state.doc.toString();
    if (content === lastSyncedContent && currentFilePath === lastSyncedFilePath) return;
    lastSyncedContent = content;
    lastSyncedFilePath = currentFilePath;
    const cursorPos = editor.state.selection.main.head;
    if (content !== cachedStructureContent) {
      const structure = getDocumentStructure(content);
      cachedStructureJson = JSON.stringify({
        headings: structure.headings,
        links: structure.links,
        tables: structure.tables,
        frontmatter: structure.frontmatter,
        stats: structure.stats,
      });
      cachedStructureContent = content;
    }
    const tabInfos = getTabs().map((t) => ({
      id: t.id,
      path: t.path,
      name: t.name,
      is_dirty: isTabDirty(t),
    }));
    invoke("sync_editor_state", {
      content,
      filePath: currentFilePath,
      cursorPos,
      workerUrl: getWorkerUrl() || null,
      documentStructure: cachedStructureJson,
      rootPath: getRootPath() || null,
      tabs: tabInfos,
    }).catch(() => {});
  }, 2000);
}

export function initBridgeListeners() {
  if (!window.__TAURI__?.event) return;

  const { listen } = window.__TAURI__.event;
  const { writeTextFile } = window.__TAURI__.fs;

  listen<string>("bridge:set-content", (event) => {
    loadContentAsTab(event.payload);
  });

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
  });

  listen<string>("bridge:open-file", async (event) => {
    const path = event.payload;
    try {
      const content = await invoke<string>("read_text_file", { path: path });
      loadContentAsTab(content, path);
      syncEditorState();
    } catch (e) {
      statusEl.textContent = `Open failed: ${e}`;
    }
  });

  listen<string>("bridge:save-file", async (event) => {
    const currentFilePath = getCurrentFilePath();
    const path = event.payload || currentFilePath;
    if (!path) return;
    try {
      suppressNext(path);
      await writeTextFile(path, editor.state.doc.toString());
      if (!currentFilePath) {
        updateActiveTab({ path, name: basename(path) });
        updateStatus();
      }
      const tab = getActiveTab();
      if (tab) markTabSaved(tab.id);
      if (getRootPath()) refreshGitAndSync();
    } catch (e) {
      statusEl.textContent = `Save failed: ${e}`;
    }
  });

  listen("bridge:normalize", () => {
    const content = editor.state.doc.toString();
    const cleaned = normalizeMarkdown(content);
    if (cleaned !== content) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: cleaned } });
      renderPreview(cleaned);
    }
    syncEditorState(cleaned);
  });

  listen<{ path?: string; tab_id?: string }>("bridge:switch-tab", (event) => {
    const { path, tab_id } = event.payload;
    if (tab_id) {
      switchTab(tab_id);
    } else if (path) {
      const tab = getTabByPath(path);
      if (tab) switchTab(tab.id);
    }
    syncEditorState();
  });
}
