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
import { search, searchKeymap } from "@codemirror/search";
import { editorTheme } from "./theme.js";
import { editTableAtCursor } from "./table-editor.js";
import { showSettings, ensureWorkerUrl, getWorkerUrl, isImageConversionAllowed, checkFirstRun } from "./settings.js";
import { marked } from "marked";
import hljs from "highlight.js";
import katex from "katex";
import "katex/dist/katex.min.css";

// KaTeX math extension for marked
const mathExtension = {
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start(src) { return src.indexOf("$$"); },
      tokenizer(src) {
        const match = src.match(/^\$\$([\s\S]+?)\$\$/);
        if (match) {
          return { type: "mathBlock", raw: match[0], text: match[1].trim() };
        }
      },
      renderer(token) {
        try {
          return `<div class="math-block">${katex.renderToString(token.text, { displayMode: true, throwOnError: false })}</div>`;
        } catch {
          return `<div class="math-block math-error"><code>${token.text}</code></div>`;
        }
      },
    },
    {
      name: "mathInline",
      level: "inline",
      start(src) { return src.indexOf("$"); },
      tokenizer(src) {
        const match = src.match(/^\$([^\s$](?:[^$]*[^\s$])?)\$/);
        if (match) {
          return { type: "mathInline", raw: match[0], text: match[1] };
        }
      },
      renderer(token) {
        try {
          return katex.renderToString(token.text, { displayMode: false, throwOnError: false });
        } catch {
          return `<code class="math-error">${token.text}</code>`;
        }
      },
    },
  ],
};

marked.use(mathExtension);

let mermaidModule = null;
let mermaidRenderCount = 0;

async function getMermaid() {
  if (mermaidModule) return mermaidModule;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "default",
    themeVariables: {
      primaryColor: "#dce4f0",
      primaryTextColor: "#2c2c2c",
      primaryBorderColor: "#4a7ab5",
      lineColor: "#8a8578",
      secondaryColor: "#eee8e0",
      tertiaryColor: "#f5f1eb",
      background: "#faf7f2",
      mainBkg: "#dce4f0",
      nodeBorder: "#4a7ab5",
      clusterBkg: "#f5f1eb",
      titleColor: "#2c2c2c",
      edgeLabelBackground: "#faf7f2",
    },
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  });
  mermaidModule = mermaid;
  return mermaid;
}

const { invoke } = window.__TAURI__.core;
const { open, save, confirm } = window.__TAURI__.dialog;
const { readTextFile, writeTextFile } = window.__TAURI__.fs;

let currentFilePath = null;
let previewTimeout = null;

// --- Scroll Sync (anchor-based, timestamp cooldown) ---

let scrollAnchors = []; // [{ editorY, previewY }]
let editorScrolledAt = 0; // timestamp of last programmatic editor scroll
let previewScrolledAt = 0; // timestamp of last programmatic preview scroll
let cursorSyncRAF = 0;
let previewClickedAt = 0; // timestamp of last preview click (suppress cursor→preview sync)
const SCROLL_COOLDOWN = 50; // ms to ignore scroll events after programmatic scroll

function annotateSourceLines(previewEl, source) {
  const tokens = marked.lexer(source);
  let offset = 0;
  let lineNum = 1;
  const lines = [];
  for (const token of tokens) {
    if (!token.raw) continue;
    if (token.type === "space") {
      offset += token.raw.length;
      continue;
    }
    const idx = source.indexOf(token.raw, offset);
    if (idx >= 0) {
      for (let j = offset; j < idx; j++) {
        if (source.charCodeAt(j) === 10) lineNum++;
      }
      lines.push(lineNum);
      offset = idx + token.raw.length;
    }
  }

  const page = previewEl.querySelector(".preview-page") || previewEl;
  const children = page.children;
  const len = Math.min(children.length, lines.length);
  for (let i = 0; i < len; i++) {
    children[i].setAttribute("data-source-line", lines[i]);
  }
}

function buildScrollAnchors() {
  const preview = document.getElementById("preview-pane");
  const cmScroller = editor.dom.querySelector(".cm-scroller");
  const elements = preview.querySelectorAll("[data-source-line]");

  const anchors = [{ editorY: 0, previewY: 0 }];
  const previewRect = preview.getBoundingClientRect();
  const previewScrollTop = preview.scrollTop;

  for (const el of elements) {
    const lineNum = parseInt(el.dataset.sourceLine, 10);
    if (lineNum < 1 || lineNum > editor.state.doc.lines) continue;
    const line = editor.state.doc.line(lineNum);
    const block = editor.lineBlockAt(line.from);
    const editorY = block.top;
    const previewY = el.getBoundingClientRect().top - previewRect.top + previewScrollTop;
    anchors.push({ editorY, previewY });
  }

  const editorMax = cmScroller.scrollHeight - cmScroller.clientHeight;
  const previewMax = preview.scrollHeight - preview.clientHeight;
  if (editorMax > 0 && previewMax > 0) {
    anchors.push({ editorY: editorMax, previewY: previewMax });
  }

  scrollAnchors = anchors;
}

function interpolate(anchors, fromKey, toKey, value) {
  if (anchors.length < 2) return 0;

  let lo = 0;
  let hi = anchors.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid][fromKey] <= value) lo = mid;
    else hi = mid;
  }

  const a = anchors[lo];
  const b = anchors[hi];
  const range = b[fromKey] - a[fromKey];
  if (range <= 0) return a[toKey];

  const t = Math.max(0, Math.min(1, (value - a[fromKey]) / range));
  return a[toKey] + t * (b[toKey] - a[toKey]);
}

function syncEditorToPreview() {
  const now = performance.now();
  if (now - editorScrolledAt < SCROLL_COOLDOWN) return;
  if (scrollAnchors.length < 2) return;

  const preview = document.getElementById("preview-pane");
  const cmScroller = editor.dom.querySelector(".cm-scroller");
  const target = Math.round(interpolate(scrollAnchors, "editorY", "previewY", cmScroller.scrollTop));

  if (Math.abs(preview.scrollTop - target) < 1) return;

  previewScrolledAt = now;
  preview.scrollTop = target;
}

function syncPreviewToEditor() {
  const now = performance.now();
  if (now - previewScrolledAt < SCROLL_COOLDOWN) return;
  if (scrollAnchors.length < 2) return;

  const preview = document.getElementById("preview-pane");
  const cmScroller = editor.dom.querySelector(".cm-scroller");
  const target = Math.round(interpolate(scrollAnchors, "previewY", "editorY", preview.scrollTop));

  if (Math.abs(cmScroller.scrollTop - target) < 1) return;

  editorScrolledAt = now;
  cmScroller.scrollTop = target;
}

// Sync preview to editor cursor/selection position
function syncPreviewToCursor() {
  if (performance.now() - previewClickedAt < 100) return;
  const pos = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(pos);
  const lineNum = line.number;

  const preview = document.getElementById("preview-pane");
  // Find the closest annotated element at or before this line
  const elements = preview.querySelectorAll("[data-source-line]");
  let best = null;
  for (const el of elements) {
    const elLine = parseInt(el.dataset.sourceLine, 10);
    if (elLine <= lineNum) best = el;
    else break;
  }

  if (best) {
    const target = best.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - preview.clientHeight / 3;
    previewScrolledAt = performance.now();
    preview.scrollTo({ top: Math.max(0, target), behavior: "instant" });
  }
}

// Sync editor cursor to clicked preview element
function syncPreviewClickToEditor(event) {
  let el = event.target;
  while (el && el !== event.currentTarget) {
    if (el.dataset && el.dataset.sourceLine) break;
    el = el.parentElement;
  }
  if (!el || !el.dataset || !el.dataset.sourceLine) return;

  const lineNum = parseInt(el.dataset.sourceLine, 10);
  if (lineNum < 1 || lineNum > editor.state.doc.lines) return;

  previewClickedAt = performance.now();
  const line = editor.state.doc.line(lineNum);
  editor.dispatch({
    selection: { anchor: line.from },
    scrollIntoView: true,
  });
  editor.focus();
}

function loadContent(content, filePath) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
  if (filePath !== undefined) currentFilePath = filePath;
  svgCache.clear();
  renderPreview(content);
  updateStatus(editor.state);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMPORT_EXTENSIONS = [
  "pdf", "docx", "xlsx", "pptx", "html", "htm", "csv", "xml",
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif",
];

// --- CodeMirror Editor ---

const updatePreview = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      renderPreview(update.state.doc.toString());
      updateStatus(update.state);
    }, 100);
    syncEditorState();
  }
  // Sync preview when cursor moves (click, arrow keys, selection)
  if (update.selectionSet && !update.docChanged) {
    cancelAnimationFrame(cursorSyncRAF);
    cursorSyncRAF = requestAnimationFrame(syncPreviewToCursor);
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
      editorTheme,
      search(),
      keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      updatePreview,
      EditorView.lineWrapping,
    ],
  }),
  parent: document.getElementById("editor-pane"),
});

// --- Preview ---

// SVG cache: URL -> sanitized SVG string
const svgCache = new Map();

async function inlineSvgImages(container) {
  const imgs = container.querySelectorAll('img[src$=".svg"]');
  const tasks = Array.from(imgs).map(async (img) => {
    const url = img.src;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;

    try {
      let svgText;
      if (svgCache.has(url)) {
        svgText = svgCache.get(url);
      } else {
        svgText = await invoke("fetch_svg", { url });
        svgCache.set(url, svgText);
      }

      const wrapper = document.createElement("span");
      wrapper.className = "inline-svg";
      wrapper.innerHTML = svgText;

      // Preserve alt text as aria-label
      const alt = img.alt;
      const svgEl = wrapper.querySelector("svg");
      if (svgEl && alt) {
        svgEl.setAttribute("aria-label", alt);
        svgEl.setAttribute("role", "img");
      }

      img.replaceWith(wrapper);
    } catch {
      // Leave as <img> on failure — browser may still render it
    }
  });
  await Promise.all(tasks);
}

async function renderPreview(source) {
  const hasMermaid = /```mermaid\b/.test(source);
  const preview = document.getElementById("preview-pane");

  // Reset render count each time so Mermaid IDs stay small and predictable
  mermaidRenderCount = 0;

  const renderer = new marked.Renderer();
  renderer.code = function ({ text, lang }) {
    if (lang === "mermaid") {
      return `<div class="mermaid-container" data-mermaid-source="${encodeURIComponent(text)}"></div>`;
    }
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    const highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
    const langClass = language ? ` class="hljs language-${lang}"` : ' class="hljs"';
    return `<pre><code${langClass}>${highlighted}</code></pre>`;
  };
  const html = marked.parse(source, { renderer });

  preview.innerHTML = `<article class="preview-page" lang="en">${html}</article>`;

  // Optimize image loading (Safari Reader-style)
  for (const img of preview.querySelectorAll(".preview-page img")) {
    img.loading = "lazy";
    img.decoding = "async";
  }

  // Wrap tables in scrollable containers for overflow handling
  for (const table of preview.querySelectorAll(".preview-page > table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }

  // Annotate elements with source line numbers for scroll sync
  annotateSourceLines(preview, source);

  if (hasMermaid) {
    try {
      const mermaid = await getMermaid();
      const containers = preview.querySelectorAll(".mermaid-container");
      for (const el of containers) {
        const src = decodeURIComponent(el.dataset.mermaidSource);
        const id = `mmd-${Date.now()}-${mermaidRenderCount++}`;
        try {
          const { svg } = await mermaid.render(id, src);
          el.innerHTML = svg;
          el.classList.add("mermaid-rendered");
        } catch (err) {
          const pre = document.createElement("pre");
          pre.className = "mermaid-error";
          pre.textContent = err.message || String(err);
          el.replaceChildren(pre);
          document.getElementById(id)?.remove();
        }
      }
    } catch (err) {
      console.error("Mermaid failed to load:", err);
    }
  }

  // Build scroll anchors after layout is computed
  requestAnimationFrame(buildScrollAnchors);

  // Inline SVG images (runs after initial HTML is set)
  inlineSvgImages(preview).catch(() => {});
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
    loadContent(content, path);
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

// --- URL Bar (Fetch URL) ---

const urlBar = document.getElementById("url-bar");
const urlInput = document.getElementById("url-input");

async function fetchFromUrlBar() {
  const url = urlInput.value.trim();
  if (!url) return;

  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  const statusEl = document.getElementById("status");
  urlBar.classList.add("loading");
  urlInput.disabled = true;
  statusEl.textContent = "Rendering page (this may take a moment)…";

  try {
    const markdown = await invoke("fetch_rendered_url_as_markdown", { url, workerUrl });
    loadContent(markdown);
    statusEl.textContent = "Fetched: " + url;
  } catch (e) {
    statusEl.textContent = `Render error: ${e}`;
  } finally {
    urlBar.classList.remove("loading");
    urlInput.disabled = false;
  }
}

document.getElementById("btn-fetch").addEventListener("click", fetchFromUrlBar);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchFromUrlBar(); });

// --- Import Document ---

async function convertFile(filePath) {
  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  const isImage = await invoke("detect_file_is_image", { filePath });

  if (isImage) {
    if (!isImageConversionAllowed()) {
      document.getElementById("status").textContent = "Image conversion is disabled in Settings";
      return;
    }
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
    loadContent(result.markdown);
    const tag = result.is_image ? " (image OCR)" : "";
    const fileName = filePath.split("/").pop();
    const mdSize = new Blob([result.markdown]).size;
    if (result.original_size && result.original_size > 0 && mdSize < result.original_size) {
      const reduction = Math.round((1 - mdSize / result.original_size) * 100);
      statusEl.textContent = `Converted${tag}: ${fileName} | ${formatBytes(result.original_size)} → ${formatBytes(mdSize)} (${reduction}% reduction)`;
    } else {
      statusEl.textContent = `Converted${tag}: ${fileName}`;
    }
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
      loadContent(content, filePath);
    } else {
      document.getElementById("status").textContent = `Unsupported file type: .${ext}`;
    }
  });
}

// --- Table Editor ---

document.getElementById("btn-table").addEventListener("click", () => {
  editTableAtCursor(editor);
});

// --- Export PDF ---

document.getElementById("btn-export-pdf").addEventListener("click", () => {
  window.print();
});

// --- Copy as Rich Text ---

async function copyRichText() {
  const preview = document.getElementById("preview-pane");
  const html = preview.innerHTML;
  const text = preview.innerText;
  const statusEl = document.getElementById("status");

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    statusEl.textContent = "Copied as rich text";
  } catch (e) {
    statusEl.textContent = `Copy failed: ${e}`;
  }
}

document.getElementById("btn-copy-rich").addEventListener("click", copyRichText);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "C") {
    e.preventDefault();
    copyRichText();
  }
});

// --- Settings ---

document.getElementById("btn-settings").addEventListener("click", () => {
  showSettings({
    onSave: (url) => {
      const statusEl = document.getElementById("status");
      statusEl.textContent = url ? `Worker URL: ${url}` : "Worker URL cleared";
    },
  });
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

// --- MCP Bridge: State Sync & Event Listeners ---

let syncTimeout = null;
let lastSyncedContent = null;
let lastSyncedFilePath = null;

function syncEditorState() {
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    const content = editor.state.doc.toString();
    if (content === lastSyncedContent && currentFilePath === lastSyncedFilePath) return;
    lastSyncedContent = content;
    lastSyncedFilePath = currentFilePath;
    const cursorPos = editor.state.selection.main.head;
    invoke("sync_editor_state", {
      content,
      filePath: currentFilePath,
      cursorPos: cursorPos,
      workerUrl: getWorkerUrl() || null,
    }).catch(() => {});
  }, 2000);
}

// Bridge event listeners
if (window.__TAURI__?.event) {
  const { listen } = window.__TAURI__.event;

  listen("bridge:set-content", (event) => {
    loadContent(event.payload);
  });

  listen("bridge:insert-text", (event) => {
    const { text, position } = event.payload;
    let pos;
    if (position === "start") {
      pos = 0;
    } else if (position === "end") {
      pos = editor.state.doc.length;
    } else {
      pos = editor.state.selection.main.head;
    }
    editor.dispatch({ changes: { from: pos, insert: text } });
    renderPreview(editor.state.doc.toString());
    updateStatus(editor.state);
  });

  listen("bridge:open-file", async (event) => {
    const path = event.payload;
    try {
      const content = await readTextFile(path);
      loadContent(content, path);
      syncEditorState();
    } catch (e) {
      document.getElementById("status").textContent = `Open failed: ${e}`;
    }
  });

  listen("bridge:save-file", async (event) => {
    const path = event.payload || currentFilePath;
    if (!path) return;
    try {
      await writeTextFile(path, editor.state.doc.toString());
      if (!currentFilePath) {
        currentFilePath = path;
        updateStatus(editor.state);
      }
    } catch (e) {
      document.getElementById("status").textContent = `Save failed: ${e}`;
    }
  });

  listen("bridge:export-pdf", () => {
    window.print();
  });
}

// Initial sync
syncEditorState();

// --- Scroll Sync Event Listeners ---

let editorScrollRAF = 0;
let previewScrollRAF = 0;
const cmScroller = editor.dom.querySelector(".cm-scroller");
cmScroller.addEventListener("scroll", () => {
  cancelAnimationFrame(editorScrollRAF);
  editorScrollRAF = requestAnimationFrame(syncEditorToPreview);
}, { passive: true });
document.getElementById("preview-pane").addEventListener("scroll", () => {
  cancelAnimationFrame(previewScrollRAF);
  previewScrollRAF = requestAnimationFrame(syncPreviewToEditor);
}, { passive: true });
window.addEventListener("resize", buildScrollAnchors);
document.getElementById("preview-pane").addEventListener("click", syncPreviewClickToEditor);

// First-run: show settings if Worker not configured
checkFirstRun();
