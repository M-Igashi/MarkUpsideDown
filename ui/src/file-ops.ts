import type { EditorView } from "@codemirror/view";
import { ensureWorkerUrl, isImageConversionAllowed, isAutoSaveEnabled } from "./settings.ts";
import { normalizeMarkdown } from "./normalize.ts";
import { getRootPath } from "./sidebar.ts";
import { getActiveTab, isTabDirty, markTabSaved, updateActiveTab } from "./tabs.ts";
import { suppressNext } from "./file-watcher.ts";

const { invoke } = window.__TAURI__.core;
const { open, save, confirm } = window.__TAURI__.dialog;
const { writeTextFile } = window.__TAURI__.fs;

export interface FetchResult {
  body: string;
  is_markdown: boolean;
}

export interface ConvertResult {
  markdown: string;
  is_image: boolean;
  original_size: number;
  warning?: string;
}

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif"];

export const IMPORT_EXTENSIONS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "html",
  "htm",
  "csv",
  "xml",
  ...IMAGE_EXTENSIONS,
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Dependencies set via init ---

let editor: EditorView;
let statusEl: HTMLElement;
let getCurrentFilePath: () => string | null;
let setCurrentFilePath: (p: string | null) => void;
let loadContentAsTab: (content: string, filePath?: string) => void;
let refreshGitAndSync: () => void;

export function initFileOps(deps: {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
  setCurrentFilePath: (p: string | null) => void;
  loadContentAsTab: (content: string, filePath?: string) => void;
  refreshGitAndSync: () => void;
}) {
  editor = deps.editor;
  statusEl = deps.statusEl;
  getCurrentFilePath = deps.getCurrentFilePath;
  setCurrentFilePath = deps.setCurrentFilePath;
  loadContentAsTab = deps.loadContentAsTab;
  refreshGitAndSync = deps.refreshGitAndSync;
}

// --- Save ---

export async function saveFile() {
  const currentFilePath = getCurrentFilePath();
  try {
    const content = editor.state.doc.toString();
    if (currentFilePath) {
      suppressNext(currentFilePath);
      await writeTextFile(currentFilePath, content);
      const tab = getActiveTab();
      if (tab) markTabSaved(tab.id);
    } else {
      const path = await save({
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (path) {
        suppressNext(path);
        await writeTextFile(path, content);
        setCurrentFilePath(path);
        updateActiveTab({ path, name: path.split("/").pop()! });
        const tab = getActiveTab();
        if (tab) markTabSaved(tab.id);
      }
    }
    if (getRootPath()) refreshGitAndSync();
  } catch (e) {
    statusEl.textContent = `Save failed: ${e}`;
  }
}

// --- Auto-save ---

let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
const AUTO_SAVE_DELAY = 2000;

export function scheduleAutoSave() {
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(autoSave, AUTO_SAVE_DELAY);
}

export async function autoSave() {
  if (!isAutoSaveEnabled()) return;
  const currentFilePath = getCurrentFilePath();
  if (!currentFilePath) return;
  const tab = getActiveTab();
  if (!tab || !tab.path || !isTabDirty(tab)) return;
  try {
    suppressNext(currentFilePath);
    await writeTextFile(currentFilePath, editor.state.doc.toString());
    markTabSaved(tab.id);
    if (getRootPath()) refreshGitAndSync();
  } catch (e) {
    statusEl.textContent = `Auto-save failed: ${e}`;
  }
}

// --- Open file ---

export async function openFile() {
  const path = await open({
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
  });
  if (path) {
    const content = await invoke<string>("read_text_file", { path: path });
    loadContentAsTab(content, path);
  }
}

// --- URL fetch / render ---

export async function fetchUrl(urlInput: HTMLInputElement, urlBar: HTMLElement) {
  const url = urlInput.value.trim();
  if (!url) return;

  urlBar.classList.add("loading");
  urlInput.disabled = true;
  statusEl.textContent = "Fetching page…";

  try {
    // First try Markdown for Agents (free, no Worker needed)
    const result = await invoke<FetchResult>("fetch_url_as_markdown", { url });

    if (result.is_markdown) {
      loadContentAsTab(normalizeMarkdown(result.body));
      statusEl.textContent = `Fetched (Markdown for Agents): ${url}`;
      return;
    }

    // HTML returned — use Worker /fetch for AI.toMarkdown() conversion
    const workerUrl = await ensureWorkerUrl();
    if (workerUrl) {
      statusEl.textContent = "Converting via AI.toMarkdown()…";
      try {
        const markdown = await invoke<string>("fetch_url_via_worker", { url, workerUrl });
        loadContentAsTab(normalizeMarkdown(markdown));
        statusEl.textContent = `Fetched (AI.toMarkdown): ${url}`;
        return;
      } catch {
        // Fall through to raw HTML
      }
    }

    // Fallback: load raw HTML as-is (no normalization for raw HTML)
    loadContentAsTab(result.body);
    statusEl.textContent = `Fetched (raw HTML): ${url}`;
  } catch (e) {
    statusEl.textContent = `Fetch error: ${e}`;
  } finally {
    urlBar.classList.remove("loading");
    urlInput.disabled = false;
  }
}

export async function renderUrl(urlInput: HTMLInputElement, urlBar: HTMLElement) {
  const url = urlInput.value.trim();
  if (!url) return;

  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  urlBar.classList.add("loading");
  urlInput.disabled = true;
  statusEl.textContent = "Rendering page (this may take a moment)…";

  try {
    const markdown = await invoke<string>("fetch_rendered_url_as_markdown", { url, workerUrl });
    loadContentAsTab(normalizeMarkdown(markdown));
    statusEl.textContent = "Rendered: " + url;
  } catch (e) {
    statusEl.textContent = `Render error: ${e}`;
  } finally {
    urlBar.classList.remove("loading");
    urlInput.disabled = false;
  }
}

// --- Import / Convert ---

export async function convertFile(filePath: string) {
  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isImage = IMAGE_EXTENSIONS.includes(ext);

  if (isImage) {
    if (!isImageConversionAllowed()) {
      statusEl.textContent = "Image conversion is disabled in Settings";
      return;
    }
    const imageFileName = filePath.split("/").pop()!;
    const ok = await confirm(
      `"${imageFileName}" will be sent to Workers AI for OCR.\n\nThis uses AI Neurons (billed per request). Typical cost: ~720 neurons per image.\n\nContinue?`,
      { title: "Image Conversion Cost", kind: "warning" },
    );
    if (!ok) return;
  }

  statusEl.textContent = "Converting…";

  try {
    const result = await invoke<ConvertResult>("convert_file_to_markdown", {
      filePath,
      workerUrl,
    });
    loadContentAsTab(normalizeMarkdown(result.markdown), filePath);
    const tag = result.is_image ? " (image OCR)" : "";
    const fileName = filePath.split("/").pop()!;
    const mdSize = new Blob([result.markdown]).size;
    const words = result.markdown.split(/\s+/).filter(Boolean).length;
    const warn = result.warning ? ` ⚠ ${result.warning}` : "";
    if (result.original_size && result.original_size > 0 && mdSize < result.original_size) {
      const reduction = Math.round((1 - mdSize / result.original_size) * 100);
      statusEl.textContent = `Converted${tag}: ${fileName} | ${formatBytes(result.original_size)} → ${formatBytes(mdSize)} (${reduction}% reduction) | ~${words.toLocaleString()} words${warn}`;
    } else {
      statusEl.textContent = `Converted${tag}: ${fileName} | ~${words.toLocaleString()} words${warn}`;
    }
  } catch (e) {
    statusEl.textContent = `Convert error: ${e}`;
  }
}

export async function importFile() {
  const path = await open({
    filters: [
      {
        name: "Documents",
        extensions: IMPORT_EXTENSIONS,
      },
    ],
  });
  if (path) await convertFile(path);
}

// --- Drag & Drop ---

export function initDragDrop(appEl: HTMLElement) {
  appEl.addEventListener("dragover", (e) => {
    // Only show drop overlay for external file drops, not internal drags
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    appEl.classList.add("drop-active");
  });

  appEl.addEventListener("dragleave", (e) => {
    if (!appEl.contains(e.relatedTarget as Node)) {
      appEl.classList.remove("drop-active");
    }
  });

  appEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    appEl.classList.remove("drop-active");

    // Ignore internal drags (sidebar/tab reorder)
    if (!e.dataTransfer?.types.includes("Files")) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // If dropped on sidebar, let sidebar handle it
    const sidebar = (e.target as HTMLElement).closest(".sidebar");
    if (sidebar) return;

    // Handle external file drop on editor area
    const file = files[0];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const MD_EXTENSIONS = ["md", "markdown", "mdx"];

    const root = getRootPath();
    if (root) {
      // Save to project root, then open/convert
      const targetPath = `${root}/${file.name}`;
      try {
        const buffer = await file.arrayBuffer();
        const data = Array.from(new Uint8Array(buffer));
        await invoke("write_file_bytes", { path: targetPath, data });
        if (MD_EXTENSIONS.includes(ext)) {
          const content = await invoke<string>("read_text_file", { path: targetPath });
          loadContentAsTab(content, targetPath);
        } else if (IMPORT_EXTENSIONS.includes(ext)) {
          await convertFile(targetPath);
        } else {
          statusEl.textContent = `Copied: ${file.name}`;
        }
      } catch (e) {
        statusEl.textContent = `Drop failed: ${e}`;
      }
    } else {
      // No project open — read content directly for markdown, or convert via temp approach
      if (MD_EXTENSIONS.includes(ext)) {
        const text = await file.text();
        loadContentAsTab(text);
      } else if (IMPORT_EXTENSIONS.includes(ext)) {
        statusEl.textContent = "Open a folder first to import files via drag & drop";
      } else {
        statusEl.textContent = `Unsupported file type: .${ext}`;
      }
    }
  });

  if (window.__TAURI__?.event) {
    window.__TAURI__.event.listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      const filePath = paths[0];
      const ext = filePath.split(".").pop()?.toLowerCase() || "";

      if (IMPORT_EXTENSIONS.includes(ext)) {
        await convertFile(filePath);
      } else if (ext === "md" || ext === "markdown" || ext === "mdx") {
        const content = await invoke<string>("read_text_file", { path: filePath });
        loadContentAsTab(content, filePath);
      } else {
        statusEl.textContent = `Unsupported file type: .${ext}`;
      }
    });
  }
}
