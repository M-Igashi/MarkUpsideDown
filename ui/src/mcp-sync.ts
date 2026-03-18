import type { EditorView } from "@codemirror/view";
import { getWorkerUrl } from "./settings.ts";
import { getActiveTab, markTabSaved, updateActiveTab } from "./tabs.ts";
import { getRootPath } from "./sidebar.ts";
import { suppressNext } from "./file-watcher.ts";
import { getDocumentStructure } from "./document-structure.ts";

const { invoke } = window.__TAURI__.core;

let editor: EditorView;
let statusEl: HTMLElement;
let getCurrentFilePath: () => string | null;
let setCurrentFilePath: (p: string | null) => void;
let loadContentAsTab: (content: string, filePath?: string) => void;
let renderPreview: (source: string) => Promise<void>;
let updateStatus: () => void;
let refreshGitAndSync: () => void;

let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSyncedContent: string | null = null;
let lastSyncedFilePath: string | null = null;

export function initMcpSync(deps: {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
  setCurrentFilePath: (p: string | null) => void;
  loadContentAsTab: (content: string, filePath?: string) => void;
  renderPreview: (source: string) => Promise<void>;
  updateStatus: () => void;
  refreshGitAndSync: () => void;
}) {
  editor = deps.editor;
  statusEl = deps.statusEl;
  getCurrentFilePath = deps.getCurrentFilePath;
  setCurrentFilePath = deps.setCurrentFilePath;
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
    const structure = getDocumentStructure(content);
    // Serialize structure to JSON (convert Set to Array for JSON compat)
    const structureJson = JSON.stringify({
      headings: structure.headings,
      links: structure.links,
      tables: structure.tables,
      frontmatter: structure.frontmatter,
      stats: structure.stats,
    });
    invoke("sync_editor_state", {
      content,
      filePath: currentFilePath,
      cursorPos: cursorPos,
      workerUrl: getWorkerUrl() || null,
      documentStructure: structureJson,
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
        setCurrentFilePath(path);
        updateActiveTab({ path, name: path.split("/").pop()! });
        updateStatus();
      }
      const tab = getActiveTab();
      if (tab) markTabSaved(tab.id);
      if (getRootPath()) refreshGitAndSync();
    } catch (e) {
      statusEl.textContent = `Save failed: ${e}`;
    }
  });

  listen("bridge:export-pdf", () => {
    window.print();
  });
}
