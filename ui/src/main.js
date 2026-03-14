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
import { editTableAtCursor } from "./table-editor.js";
import { marked } from "marked";

let mermaidModule = null;
let mermaidReady = false;
let mermaidIdCounter = 0;

async function getMermaid() {
  if (mermaidModule) return mermaidModule;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
      primaryColor: "#89b4fa",
      primaryTextColor: "#cdd6f4",
      primaryBorderColor: "#3a3a4a",
      lineColor: "#6c7086",
      secondaryColor: "#252535",
      tertiaryColor: "#1e1e2e",
      background: "#1e1e2e",
      mainBkg: "#252535",
      nodeBorder: "#89b4fa",
      clusterBkg: "#252535",
      titleColor: "#cdd6f4",
      edgeLabelBackground: "#252535",
    },
    fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
  });
  mermaidModule = mermaid;
  mermaidReady = true;
  return mermaid;
}

const { invoke } = window.__TAURI__.core;
const { open, save, confirm } = window.__TAURI__.dialog;
const { readTextFile, writeTextFile } = window.__TAURI__.fs;

let currentFilePath = null;
let previewTimeout = null;

const STORAGE_KEY_WORKER_URL = "markupsidedown:workerUrl";

function getWorkerUrl() {
  return localStorage.getItem(STORAGE_KEY_WORKER_URL) || "";
}

function setWorkerUrl(url) {
  localStorage.setItem(STORAGE_KEY_WORKER_URL, url);
}

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

async function renderPreview(source) {
  const hasMermaid = /```mermaid\b/.test(source);

  if (hasMermaid) {
    // Custom renderer to replace mermaid code blocks with placeholders
    const renderer = new marked.Renderer();
    const originalCode = renderer.code;
    renderer.code = function ({ text, lang }) {
      if (lang === "mermaid") {
        const id = `mermaid-${mermaidIdCounter++}`;
        return `<div class="mermaid-container" data-mermaid-id="${id}" data-mermaid-source="${encodeURIComponent(text)}"></div>`;
      }
      return originalCode.call(this, { text, lang });
    };

    const html = marked.parse(source, { renderer });
    document.getElementById("preview-pane").innerHTML = html;

    // Render mermaid diagrams
    try {
      const mermaid = await getMermaid();
      const containers = document.querySelectorAll(".mermaid-container");
      for (const el of containers) {
        const src = decodeURIComponent(el.dataset.mermaidSource);
        const id = el.dataset.mermaidId;
        try {
          const { svg } = await mermaid.render(id, src);
          el.innerHTML = svg;
          el.classList.add("mermaid-rendered");
        } catch (err) {
          el.innerHTML = `<pre class="mermaid-error">${err.message || err}</pre>`;
          // mermaid.render creates a temp element on error; clean up
          document.getElementById(id)?.remove();
        }
      }
    } catch (err) {
      // Mermaid failed to load — leave placeholders as-is
    }
  } else {
    const html = marked.parse(source);
    document.getElementById("preview-pane").innerHTML = html;
  }
}

function updateStatus(state) {
  const lines = state.doc.lines;
  const chars = state.doc.length;
  const pathInfo = currentFilePath ? ` | ${currentFilePath}` : "";
  document.getElementById("status").textContent = `${lines} lines | ${chars} chars${pathInfo}`;
}

// Initial render
renderPreview(editor.state.doc.toString()).catch(() => {});
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

document.getElementById("btn-fetch-url").addEventListener("click", () => {
  showFetchDialog();
});

function showFetchDialog() {
  // Remove existing dialog if any
  document.getElementById("fetch-dialog")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "fetch-dialog";
  overlay.className = "dialog-overlay";
  overlay.innerHTML = `
    <div class="dialog-box">
      <div class="dialog-title">Fetch URL as Markdown</div>
      <input type="url" id="fetch-url-input" placeholder="https://example.com" />
      <div class="dialog-row">
        <label class="toggle-label">
          <input type="checkbox" id="fetch-render-toggle" />
          <span>Render JS</span>
        </label>
        <span class="toggle-hint" id="fetch-render-hint">Standard fetch (fast)</span>
      </div>
      <div class="dialog-actions">
        <button id="fetch-dialog-cancel">Cancel</button>
        <button id="fetch-dialog-ok" class="primary">Fetch</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const urlInput = document.getElementById("fetch-url-input");
  const renderToggle = document.getElementById("fetch-render-toggle");
  const hint = document.getElementById("fetch-render-hint");

  urlInput.focus();

  renderToggle.addEventListener("change", () => {
    hint.textContent = renderToggle.checked
      ? "Browser Rendering (slower, JS support)"
      : "Standard fetch (fast)";
  });

  const close = () => overlay.remove();

  document.getElementById("fetch-dialog-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const doFetch = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const renderJs = renderToggle.checked;
    close();
    await fetchUrl(url, renderJs);
  };

  document.getElementById("fetch-dialog-ok").addEventListener("click", doFetch);
  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doFetch(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

async function fetchUrl(url, renderJs) {
  const statusEl = document.getElementById("status");

  if (renderJs) {
    const workerUrl = await ensureWorkerUrl();
    if (!workerUrl) return;

    statusEl.textContent = "Rendering page (this may take a moment)…";
    try {
      const markdown = await invoke("fetch_rendered_url_as_markdown", { url, workerUrl });
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: markdown },
      });
      renderPreview(markdown);
      statusEl.textContent = "Fetched (rendered): " + url;
    } catch (e) {
      statusEl.textContent = `Render error: ${e}`;
    }
  } else {
    statusEl.textContent = "Fetching…";
    try {
      const result = await invoke("fetch_url_as_markdown", { url });
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: result.body },
      });
      renderPreview(result.body);
      const info = result.is_markdown ? "Markdown" : "HTML (no Markdown for Agents)";
      const tokens = result.token_count ? ` | ${result.token_count} tokens` : "";
      statusEl.textContent = `Fetched: ${info}${tokens}`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  }
}

// --- Import Document ---

async function ensureWorkerUrl() {
  let url = getWorkerUrl();
  if (url) return url;
  url = prompt(
    "Enter your Worker URL for document conversion.\n" +
    "Deploy the worker/ directory first. See docs/worker-deployment.md for details.\n\n" +
    "Worker URL (e.g. https://markupsidedown-converter.YOUR_SUBDOMAIN.workers.dev):"
  );
  if (!url) return null;
  url = url.replace(/\/+$/, "");
  setWorkerUrl(url);
  return url;
}

async function convertFile(filePath) {
  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

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
      workerUrl,
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

// --- Table Editor ---

document.getElementById("btn-table").addEventListener("click", () => {
  editTableAtCursor(editor);
});

// --- Settings ---

document.getElementById("btn-settings").addEventListener("click", () => {
  const current = getWorkerUrl() || "(not set)";
  const url = prompt(`Worker URL (current: ${current}):\n\nLeave empty to clear.`);
  if (url === null) return;
  if (url === "") {
    localStorage.removeItem(STORAGE_KEY_WORKER_URL);
    document.getElementById("status").textContent = "Worker URL cleared";
  } else {
    setWorkerUrl(url.replace(/\/+$/, ""));
    document.getElementById("status").textContent = `Worker URL set: ${url}`;
  }
});

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
