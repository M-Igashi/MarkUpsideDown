import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { oneDark } from "./theme.js";
import { marked } from "marked";

const { invoke } = window.__TAURI__.core;
const { open, save, confirm } = window.__TAURI__.dialog;
const { readTextFile, writeTextFile } = window.__TAURI__.fs;

let currentFilePath = null;
let previewTimeout = null;

// Worker URL — update after deploying the Worker
const WORKER_URL = "https://markupsidedown-converter.<YOUR_SUBDOMAIN>.workers.dev";

const IMPORT_EXTENSIONS = [
  "pdf", "docx", "xlsx", "pptx", "html", "htm", "csv", "xml",
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif",
];

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif",
]);

// --- CodeMirror Editor ---

const updatePreview = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      renderPreview(update.state.doc.toString());
      updateStatus(update.state);
    }, 150);
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
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      updatePreview,
      EditorView.lineWrapping,
    ],
  }),
  parent: document.getElementById("editor-pane"),
});

// --- Preview ---

function renderPreview(source) {
  const html = marked.parse(source);
  document.getElementById("preview-pane").innerHTML = html;
}

function updateStatus(state) {
  const lines = state.doc.lines;
  const chars = state.doc.length;
  const pathInfo = currentFilePath ? ` | ${currentFilePath}` : "";
  document.getElementById("status").textContent = `${lines} lines | ${chars} chars${pathInfo}`;
}

// Initial render
renderPreview(editor.state.doc.toString());
updateStatus(editor.state);

// --- Toolbar Actions ---

document.getElementById("btn-open").addEventListener("click", async () => {
  const path = await open({
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdx"] }],
  });
  if (path) {
    const content = await readTextFile(path);
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
    });
    currentFilePath = path;
    renderPreview(content);
    updateStatus(editor.state);
  }
});

document.getElementById("btn-save").addEventListener("click", async () => {
  const content = editor.state.doc.toString();
  if (currentFilePath) {
    await writeTextFile(currentFilePath, content);
  } else {
    const path = await save({
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (path) {
      await writeTextFile(path, content);
      currentFilePath = path;
      updateStatus(editor.state);
    }
  }
});

document.getElementById("btn-fetch-url").addEventListener("click", async () => {
  const url = prompt("Enter URL to fetch as Markdown:");
  if (!url) return;

  document.getElementById("status").textContent = "Fetching…";
  try {
    const result = await invoke("fetch_url_as_markdown", { url });
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: result.body },
    });
    renderPreview(result.body);
    const info = result.is_markdown ? "Markdown" : "HTML (no Markdown for Agents)";
    const tokens = result.token_count ? ` | ${result.token_count} tokens` : "";
    document.getElementById("status").textContent = `Fetched: ${info}${tokens}`;
  } catch (e) {
    document.getElementById("status").textContent = `Error: ${e}`;
  }
});

// --- Import Document ---

async function convertFile(filePath) {
  const isImage = await invoke("detect_file_is_image", { filePath });

  if (isImage) {
    const ok = await confirm(
      "Image conversion uses AI Neurons (costs apply). Continue?",
      { title: "Image Conversion Cost", kind: "warning" }
    );
    if (!ok) return;
  }

  const statusEl = document.getElementById("status");
  statusEl.textContent = "Converting…";

  try {
    const result = await invoke("convert_file_to_markdown", {
      filePath,
      workerUrl: WORKER_URL,
    });
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: result.markdown },
    });
    renderPreview(result.markdown);
    const tag = result.is_image ? " (image OCR)" : "";
    statusEl.textContent = `Converted${tag}: ${filePath.split("/").pop()}`;
  } catch (e) {
    statusEl.textContent = `Convert error: ${e}`;
  }
}

document.getElementById("btn-import").addEventListener("click", async () => {
  const path = await open({
    filters: [{
      name: "Documents",
      extensions: IMPORT_EXTENSIONS,
    }],
  });
  if (path) await convertFile(path);
});

// --- Drag & Drop ---

const appEl = document.getElementById("app");

appEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  appEl.classList.add("drop-active");
});

appEl.addEventListener("dragleave", (e) => {
  if (!appEl.contains(e.relatedTarget)) {
    appEl.classList.remove("drop-active");
  }
});

appEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  appEl.classList.remove("drop-active");

  const paths = e.dataTransfer?.files;
  if (!paths || paths.length === 0) return;

  // Tauri exposes dropped file paths via the event
  // For web drag-and-drop, we need to use Tauri's drag-drop event instead
  // Fall back to prompting the user to use the Import button
  document.getElementById("status").textContent =
    "Drop detected — use the Import button to select files (Tauri security restriction)";
});

// Tauri file drop event (works with native file drops)
if (window.__TAURI__?.event) {
  window.__TAURI__.event.listen("tauri://drag-drop", async (event) => {
    const paths = event.payload.paths;
    if (!paths || paths.length === 0) return;

    const filePath = paths[0];
    const ext = filePath.split(".").pop()?.toLowerCase() || "";

    if (IMPORT_EXTENSIONS.includes(ext)) {
      await convertFile(filePath);
    } else if (ext === "md" || ext === "markdown" || ext === "mdx") {
      const content = await readTextFile(filePath);
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: content },
      });
      currentFilePath = filePath;
      renderPreview(content);
      updateStatus(editor.state);
    } else {
      document.getElementById("status").textContent = `Unsupported file type: .${ext}`;
    }
  });
}

// --- Resizable divider ---

const divider = document.getElementById("divider");
const editorPane = document.getElementById("editor-pane");
const previewPane = document.getElementById("preview-pane");

let isDragging = false;

divider.addEventListener("mousedown", () => { isDragging = true; });
document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const container = document.getElementById("app");
  const rect = container.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  editorPane.style.flex = `${clamped}`;
  previewPane.style.flex = `${1 - clamped}`;
});
document.addEventListener("mouseup", () => { isDragging = false; });
