import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { editorTheme } from "./theme.js";
import { editTableAtCursor } from "./table-editor.js";
import {
  showSettings,
  ensureWorkerUrl,
  getWorkerUrl,
  isImageConversionAllowed,
  checkFirstRun,
} from "./settings.js";
import {
  initSidebar,
  setSelectedPath,
  getRootPath,
  setGitStatus,
  getGitPanelEl,
} from "./sidebar.js";
import { initGitPanel, setRepoPath, refresh as refreshGit, getStatusMap } from "./git-panel.js";
import {
  initTabs,
  openTab,
  closeActiveTab,
  switchToPrevTab,
  switchToNextTab,
  updateActiveTab,
} from "./tabs.js";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import "katex/dist/katex.min.css";
import DOMPurify from "dompurify";

// KaTeX math extension for marked
const mathExtension = {
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start(src) {
        return src.indexOf("$$");
      },
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
      start(src) {
        return src.indexOf("$");
      },
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
    securityLevel: "strict",
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

// --- Scroll Sync ---
//
// Design: single-direction-at-a-time with programmatic-scroll detection.
//   activeSide = which pane the user last interacted with (scroll / click / cursor)
//   programmaticScrollAt = timestamp to ignore echo-back scroll events
//   pendingRender = true while a debounced re-render is queued (anchors stale)

let scrollAnchors = [];
let cachedSourceLineEls = [];
let syncRAF = 0;
let renderingPreview = false;
let pendingRender = false;
let activeSide = "editor"; // 'editor' | 'preview'
let programmaticScrollAt = 0;
let lastPreviewClickAt = 0;

const PROG_SCROLL_MS = 80;
const CLICK_SUPPRESS_MS = 150;

function isProgrammaticScroll() {
  return performance.now() - programmaticScrollAt < PROG_SCROLL_MS;
}
function markProgrammaticScroll() {
  programmaticScrollAt = performance.now();
}

function getCodeBlockLineInfo(preEl) {
  const codeEl = preEl.querySelector("code") || preEl;
  const lines = codeEl.textContent.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rect = codeEl.getBoundingClientRect();
  const lineHeight = lines.length > 0 ? rect.height / lines.length : 0;
  return { codeEl, lines, rect, lineHeight };
}

function countNewlines(str, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (str.charCodeAt(i) === 10) n++;
  }
  return n;
}

function annotateTokensWithSourceLines(tokens) {
  let lineNum = 1;
  for (const token of tokens) {
    if (!token.raw) continue;
    if (token.type === "space") {
      lineNum += countNewlines(token.raw, 0, token.raw.length);
      continue;
    }
    token._sourceLine = lineNum;
    lineNum += countNewlines(token.raw, 0, token.raw.length);
  }
}

function slAttr(sourceLine) {
  return sourceLine ? ` data-source-line="${sourceLine}"` : "";
}

function buildScrollAnchors() {
  const elements = previewPane.querySelectorAll("[data-source-line]");

  const anchors = [{ editorY: 0, previewY: 0 }];
  const previewRect = previewPane.getBoundingClientRect();
  const previewScrollTop = previewPane.scrollTop;

  for (const el of elements) {
    const lineNum = parseInt(el.dataset.sourceLine, 10);
    if (lineNum < 1 || lineNum > editor.state.doc.lines) continue;
    const line = editor.state.doc.line(lineNum);
    const block = editor.lineBlockAt(line.from);
    const editorY = block.top;
    const previewY = el.getBoundingClientRect().top - previewRect.top + previewScrollTop;
    anchors.push({ editorY, previewY });

    // Add sub-line anchors within code blocks for precise per-line sync
    if (el.tagName === "PRE") {
      const info = getCodeBlockLineInfo(el);
      if (info.lines.length > 1) {
        // data-source-line points to the opening ```, code content starts at lineNum + 1
        for (let i = 0; i < info.lines.length; i++) {
          const srcLine = lineNum + 1 + i;
          if (srcLine > editor.state.doc.lines) break;
          const editorLine = editor.state.doc.line(srcLine);
          const editorBlock = editor.lineBlockAt(editorLine.from);
          const subPreviewY =
            info.rect.top - previewRect.top + previewScrollTop + i * info.lineHeight;
          anchors.push({ editorY: editorBlock.top, previewY: subPreviewY });
        }
      }
    }
  }

  const editorMax = cmScroller.scrollHeight - cmScroller.clientHeight;
  const previewMax = previewPane.scrollHeight - previewPane.clientHeight;
  if (editorMax > 0 && previewMax > 0) {
    anchors.push({ editorY: editorMax, previewY: previewMax });
  }

  anchors.sort((a, b) => a.editorY - b.editorY);
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

function syncToPreview() {
  if (renderingPreview || scrollAnchors.length < 2) return;
  const target = Math.round(
    interpolate(scrollAnchors, "editorY", "previewY", cmScroller.scrollTop),
  );
  if (Math.abs(previewPane.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  previewPane.scrollTop = target;
}

function syncToEditor() {
  if (renderingPreview || scrollAnchors.length < 2) return;
  const target = Math.round(
    interpolate(scrollAnchors, "previewY", "editorY", previewPane.scrollTop),
  );
  if (Math.abs(cmScroller.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  cmScroller.scrollTop = target;
}

function syncPreviewToCursor() {
  if (renderingPreview || pendingRender) return;
  if (performance.now() - lastPreviewClickAt < CLICK_SUPPRESS_MS) return;

  const pos = editor.state.selection.main.head;
  const cursorLine = editor.state.doc.lineAt(pos).number;
  const block = editor.lineBlockAt(pos);

  const elements = cachedSourceLineEls;
  if (elements.length === 0) return;

  // Find the two elements bracketing the cursor line
  let before = null;
  let after = null;
  let beforeLine = -1;
  let afterLine = Infinity;

  for (const el of elements) {
    const sl = parseInt(el.dataset.sourceLine, 10);
    if (isNaN(sl)) continue;
    if (sl <= cursorLine && sl > beforeLine) {
      before = el;
      beforeLine = sl;
    }
    if (sl >= cursorLine && sl < afterLine) {
      after = el;
      afterLine = sl;
    }
  }

  if (!before && !after) return;
  if (!before) {
    before = after;
    beforeLine = afterLine;
  }
  if (!after) {
    after = before;
    afterLine = beforeLine;
  }

  const previewRect = previewPane.getBoundingClientRect();
  const previewScrollTop = previewPane.scrollTop;

  let previewTargetY;

  // Check if cursor is inside a code block represented by 'before' PRE element
  if (before.tagName === "PRE" && cursorLine > beforeLine) {
    const info = getCodeBlockLineInfo(before);
    if (info.lines.length > 1) {
      const lineIndex = cursorLine - beforeLine - 1;
      if (lineIndex >= 0 && lineIndex < info.lines.length) {
        previewTargetY =
          info.rect.top - previewRect.top + previewScrollTop + lineIndex * info.lineHeight;
      }
    }
  }

  // If not resolved by code block, interpolate between bracketing elements
  if (previewTargetY === undefined) {
    const beforeY = before.getBoundingClientRect().top - previewRect.top + previewScrollTop;
    if (before === after || beforeLine === afterLine) {
      previewTargetY = beforeY;
    } else {
      const afterY = after.getBoundingClientRect().top - previewRect.top + previewScrollTop;
      const t = (cursorLine - beforeLine) / (afterLine - beforeLine);
      previewTargetY = beforeY + t * (afterY - beforeY);
    }
  }

  // Align: same visual offset from viewport top in both panes
  const lineVisibleY = block.top - cmScroller.scrollTop;
  const scrollTarget = Math.max(0, Math.round(previewTargetY - lineVisibleY));
  if (Math.abs(previewPane.scrollTop - scrollTarget) < 1) return;
  markProgrammaticScroll();
  previewPane.scrollTop = scrollTarget;
}

function syncPreviewClickToEditor(event) {
  let el = event.target;
  while (el && el !== event.currentTarget) {
    if (el.dataset && el.dataset.sourceLine) break;
    el = el.parentElement;
  }
  if (!el || !el.dataset || !el.dataset.sourceLine) return;

  let lineNum = parseInt(el.dataset.sourceLine, 10);
  if (lineNum < 1 || lineNum > editor.state.doc.lines) return;

  if (el.tagName === "PRE") {
    const info = getCodeBlockLineInfo(el);
    if (info.lines.length > 1) {
      const clickY = event.clientY - info.rect.top;
      const lineIndex = Math.max(
        0,
        Math.min(info.lines.length - 1, Math.floor(clickY / info.lineHeight)),
      );
      const targetLine = lineNum + 1 + lineIndex;
      if (targetLine >= 1 && targetLine <= editor.state.doc.lines) {
        lineNum = targetLine;
      }
    }
  }

  lastPreviewClickAt = performance.now();
  activeSide = "preview";
  const line = editor.state.doc.line(lineNum);
  editor.dispatch({ selection: { anchor: line.from } });

  const clickVisibleY = event.clientY - previewPane.getBoundingClientRect().top;
  const block = editor.lineBlockAt(line.from);
  const editorTarget = block.top - clickVisibleY;
  markProgrammaticScroll();
  cmScroller.scrollTo({ top: Math.max(0, editorTarget), behavior: "instant" });
  editor.focus();
}

function loadContent(content, filePath) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
  if (filePath !== undefined) {
    currentFilePath = filePath;
    setSelectedPath(filePath);
  }
  svgCache.clear();
  renderPreview(content);
  updateStatus(editor.state);
}

function loadContentAsTab(content, filePath) {
  const name = filePath ? filePath.split("/").pop() : "Untitled";
  openTab(filePath || null, name, content);
  // openTab triggers onSwitch which calls loadContent
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMPORT_EXTENSIONS = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "html",
  "htm",
  "csv",
  "xml",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
];

// --- CodeMirror Editor ---

const updatePreview = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    pendingRender = true;
    clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => {
      renderPreview(update.state.doc.toString());
      updateStatus(update.state);
    }, 100);
    updateActiveTab({ content: update.state.doc.toString() });
    syncEditorState();
  }
  // Sync preview when cursor moves — skip if a render is pending (anchors stale)
  if (update.selectionSet && !update.docChanged && !pendingRender) {
    activeSide = "editor";
    cancelAnimationFrame(syncRAF);
    syncRAF = requestAnimationFrame(syncPreviewToCursor);
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

// --- Cached DOM references (used by scroll sync & preview) ---

const previewPane = document.getElementById("preview-pane");
const cmScroller = editor.dom.querySelector(".cm-scroller");
const statusEl = document.getElementById("status");

// --- Preview ---

// SVG cache: URL -> sanitized SVG string
const svgCache = new Map();

async function inlineSvgImages(container) {
  const imgs = container.querySelectorAll('img[src$=".svg"]');
  if (imgs.length === 0) return false;
  let changed = false;
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
      changed = true;
    } catch {
      // Leave as <img> on failure — browser may still render it
    }
  });
  await Promise.all(tasks);
  return changed;
}

// Shared renderer — stateless, reused across renders
const previewRenderer = new marked.Renderer();
previewRenderer.code = function ({ text, lang, _sourceLine }) {
  const sl = slAttr(_sourceLine);
  if (lang === "mermaid") {
    return `<div${sl} class="mermaid-container" data-mermaid-source="${encodeURIComponent(text)}"></div>`;
  }
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;
  const langClass = language ? ` class="hljs language-${lang}"` : ' class="hljs"';
  return `<pre${sl}><code${langClass}>${highlighted}</code></pre>`;
};
previewRenderer.heading = function ({ text, depth, _sourceLine }) {
  return `<h${depth}${slAttr(_sourceLine)}>${text}</h${depth}>\n`;
};
previewRenderer.paragraph = function ({ text, _sourceLine }) {
  return `<p${slAttr(_sourceLine)}>${text}</p>\n`;
};
previewRenderer.blockquote = function ({ body, _sourceLine }) {
  return `<blockquote${slAttr(_sourceLine)}>\n${body}</blockquote>\n`;
};
previewRenderer.list = function ({ items, ordered, start, _sourceLine }) {
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
  const body = items.map((item) => this.listitem(item)).join("");
  return `<${tag}${startAttr}${slAttr(_sourceLine)}>\n${body}</${tag}>\n`;
};
previewRenderer.table = function ({ header, rows, _sourceLine }) {
  const headerRow = `<tr>${header.map((h) => `<th${h.align ? ` align="${h.align}"` : ""}>${h.text}</th>`).join("")}</tr>`;
  const bodyRows = rows
    .map(
      (row) =>
        `<tr>${row.map((c) => `<td${c.align ? ` align="${c.align}"` : ""}>${c.text}</td>`).join("")}</tr>`,
    )
    .join("\n");
  const tbody = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
  return `<table${slAttr(_sourceLine)}><thead>${headerRow}</thead>${tbody}</table>\n`;
};
previewRenderer.hr = function ({ _sourceLine }) {
  return `<hr${slAttr(_sourceLine)}>\n`;
};
previewRenderer.html = function ({ text, _sourceLine }) {
  return _sourceLine ? text.replace(/^<(\w+)/, `<$1${slAttr(_sourceLine)}`) : text;
};

async function renderPreview(source) {
  const hasMermaid = /```mermaid\b/.test(source);

  renderingPreview = true;
  cancelAnimationFrame(syncRAF);

  // Save scroll position to prevent visual flash during innerHTML replacement
  const savedScrollTop = previewPane.scrollTop;

  // Reset render count each time so Mermaid IDs stay small and predictable
  mermaidRenderCount = 0;

  // Lex source and annotate top-level tokens with source line numbers
  const tokens = marked.lexer(source);
  annotateTokensWithSourceLines(tokens);

  const html = marked.parser(tokens, { renderer: previewRenderer });

  previewPane.innerHTML = DOMPurify.sanitize(
    `<article class="preview-page" lang="en">${html}</article>`,
    {
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: ["data-mermaid-source", "data-source-line"],
    },
  );

  // Optimize image loading (Safari Reader-style)
  for (const img of previewPane.querySelectorAll(".preview-page img")) {
    img.loading = "lazy";
    img.decoding = "async";
  }

  // Wrap tables in scrollable containers for overflow handling
  for (const table of previewPane.querySelectorAll(".preview-page > table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    // Transfer data-source-line to wrapper so scroll sync finds it
    if (table.dataset.sourceLine) {
      wrapper.dataset.sourceLine = table.dataset.sourceLine;
      table.removeAttribute("data-source-line");
    }
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }

  if (hasMermaid) {
    try {
      const mermaid = await getMermaid();
      const containers = previewPane.querySelectorAll(".mermaid-container");
      for (const el of containers) {
        const src = decodeURIComponent(el.dataset.mermaidSource);
        const id = `mmd-${mermaidRenderCount++}`;
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

  // Restore scroll approximately (prevents flash), then build fresh anchors
  previewPane.scrollTop = savedScrollTop;
  buildScrollAnchors();
  cachedSourceLineEls = Array.from(previewPane.querySelectorAll("[data-source-line]"));
  pendingRender = false;
  renderingPreview = false;

  // Re-sync preview to cursor so it never drifts from the editing position
  if (activeSide === "editor") {
    markProgrammaticScroll();
    syncPreviewToCursor();
  }

  // Inline SVG images — rebuild anchors only if layout changed
  inlineSvgImages(previewPane)
    .then((changed) => {
      if (changed) buildScrollAnchors();
    })
    .catch(() => {});
}

function updateStatus(state) {
  const lines = state.doc.lines;
  const chars = state.doc.length;
  const pathInfo = currentFilePath ? ` | ${currentFilePath}` : "";
  statusEl.textContent = `${lines} lines | ${chars} chars${pathInfo}`;
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
    loadContentAsTab(content, path);
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
      updateActiveTab({ path, name: path.split("/").pop() });
      updateStatus(editor.state);
    }
  }
  // Refresh git status after save
  if (getRootPath()) refreshGitAndSync();
});

// --- URL Bar (Fetch URL) ---

const urlBar = document.getElementById("url-bar");
const urlInput = document.getElementById("url-input");

async function fetchFromUrlBar() {
  const url = urlInput.value.trim();
  if (!url) return;

  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  urlBar.classList.add("loading");
  urlInput.disabled = true;
  statusEl.textContent = "Rendering page (this may take a moment)…";

  try {
    const markdown = await invoke("fetch_rendered_url_as_markdown", { url, workerUrl });
    loadContentAsTab(markdown);
    statusEl.textContent = "Fetched: " + url;
  } catch (e) {
    statusEl.textContent = `Render error: ${e}`;
  } finally {
    urlBar.classList.remove("loading");
    urlInput.disabled = false;
  }
}

document.getElementById("btn-fetch").addEventListener("click", fetchFromUrlBar);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchFromUrlBar();
});

// --- Import Document ---

async function convertFile(filePath) {
  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return;

  const isImage = await invoke("detect_file_is_image", { filePath });

  if (isImage) {
    if (!isImageConversionAllowed()) {
      statusEl.textContent = "Image conversion is disabled in Settings";
      return;
    }
    const ok = await confirm("Image conversion uses AI Neurons (costs apply). Continue?", {
      title: "Image Conversion Cost",
      kind: "warning",
    });
    if (!ok) return;
  }

  statusEl.textContent = "Converting…";

  try {
    const result = await invoke("convert_file_to_markdown", {
      filePath,
      workerUrl,
    });
    loadContentAsTab(result.markdown, filePath);
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
    filters: [
      {
        name: "Documents",
        extensions: IMPORT_EXTENSIONS,
      },
    ],
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
  statusEl.textContent =
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
      loadContentAsTab(content, filePath);
    } else {
      statusEl.textContent = `Unsupported file type: .${ext}`;
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
  const html = previewPane.innerHTML;
  const text = previewPane.innerText;
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
      statusEl.textContent = url ? `Worker URL: ${url}` : "Worker URL cleared";
    },
  });
});

// --- Resizable divider ---

const divider = document.getElementById("divider");
const editorPane = document.getElementById("editor-pane");

let isDragging = false;

divider.addEventListener("mousedown", () => {
  isDragging = true;
});
document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  // Calculate ratio within the editor+preview area (excluding sidebar)
  const editorLeft = editorPane.getBoundingClientRect().left;
  const previewRight = previewPane.getBoundingClientRect().right;
  const availableWidth = previewRight - editorLeft;
  const ratio = (e.clientX - editorLeft) / availableWidth;
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  editorPane.style.flex = `${clamped}`;
  previewPane.style.flex = `${1 - clamped}`;
});
document.addEventListener("mouseup", () => {
  isDragging = false;
});

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
    loadContentAsTab(event.payload);
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
      loadContentAsTab(content, path);
      syncEditorState();
    } catch (e) {
      statusEl.textContent = `Open failed: ${e}`;
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
      statusEl.textContent = `Save failed: ${e}`;
    }
  });

  listen("bridge:export-pdf", () => {
    window.print();
  });
}

// Initial sync
syncEditorState();

// --- Scroll Sync Event Listeners ---

cmScroller.addEventListener(
  "scroll",
  () => {
    if (isProgrammaticScroll()) return;
    activeSide = "editor";
    cancelAnimationFrame(syncRAF);
    syncRAF = requestAnimationFrame(syncToPreview);
  },
  { passive: true },
);
previewPane.addEventListener(
  "scroll",
  () => {
    if (isProgrammaticScroll()) return;
    activeSide = "preview";
    cancelAnimationFrame(syncRAF);
    syncRAF = requestAnimationFrame(syncToEditor);
  },
  { passive: true },
);
window.addEventListener("resize", buildScrollAnchors);
previewPane.addEventListener("click", (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  syncPreviewClickToEditor(e);
});

// --- Sidebar ---

const sidebarEl = document.getElementById("sidebar");
const sidebarDivider = document.getElementById("sidebar-divider");

// Restore collapsed state
const sidebarCollapsed = localStorage.getItem("markupsidedown:sidebarCollapsed") === "true";
if (sidebarCollapsed) {
  sidebarEl.classList.add("collapsed");
}

initSidebar(sidebarEl, {
  onOpen: (content, filePath) => {
    loadContentAsTab(content, filePath);
  },
  onFolder: (rootPath) => {
    setRepoPath(rootPath);
    refreshGitAndSync();
  },
});

// Initialize git panel after sidebar renders
const gitPanelEl = getGitPanelEl();
if (gitPanelEl) {
  initGitPanel(gitPanelEl, {
    onOpen: async (filePath) => {
      const { readTextFile } = window.__TAURI__.fs;
      try {
        const content = await readTextFile(filePath);
        loadContentAsTab(content, filePath);
      } catch (e) {
        statusEl.textContent = `Open failed: ${e}`;
      }
    },
  });
}

async function refreshGitAndSync() {
  await refreshGit();
  setGitStatus(getStatusMap());
}

// Initialize git for restored sidebar root path
const initialRoot = getRootPath();
if (initialRoot) {
  setRepoPath(initialRoot);
  refreshGitAndSync();
}

function toggleSidebar() {
  sidebarEl.classList.toggle("collapsed");
  localStorage.setItem(
    "markupsidedown:sidebarCollapsed",
    sidebarEl.classList.contains("collapsed"),
  );
}

// Cmd+B to toggle sidebar
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "b") {
    e.preventDefault();
    toggleSidebar();
  }
});

// Sidebar resizable divider
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
    localStorage.setItem("markupsidedown:sidebarCollapsed", "false");
  }
});

// --- Tabs ---

const tabBarEl = document.getElementById("tab-bar");

initTabs(tabBarEl, {
  onSwitch: (tab) => {
    loadContent(tab.content, tab.path);
  },
  onEmpty: () => {
    loadContent("# Welcome to MarkUpsideDown\n\nStart typing your Markdown here…\n");
  },
});

// Cmd+W: close tab
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "w") {
    e.preventDefault();
    closeActiveTab();
  }
});

// Cmd+Shift+[ / ]: switch tabs
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "[") {
    e.preventDefault();
    switchToPrevTab();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "]") {
    e.preventDefault();
    switchToNextTab();
  }
});

// First-run: show settings if Worker not configured
checkFirstRun();
