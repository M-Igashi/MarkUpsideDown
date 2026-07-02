// Table of Contents panel: displays heading hierarchy and allows
// quick navigation to any section in the editor.

import type { EditorView } from "@codemirror/view";
import { getDocumentStructure, type Heading } from "./document-structure.ts";
import { escapeHtml } from "./html-utils.ts";

let panelEl: HTMLElement | null = null;
let editor: EditorView;
let collapsed = true;
let lastHeadings: Heading[] = [];
let lastContent: string | null = null;
let lastActiveIdx = -2;

export function initTocPanel(ed: EditorView, container: HTMLElement) {
  editor = ed;

  panelEl = document.createElement("div");
  panelEl.className = "toc-panel";
  panelEl.style.display = "none";
  container.insertBefore(panelEl, container.firstChild);

  // Single delegated click listener (never accumulates on re-render)
  panelEl.addEventListener("click", (e) => {
    const toggle = (e.target as HTMLElement).closest(".toc-toggle");
    if (toggle) {
      collapsed = !collapsed;
      render();
      return;
    }
    const item = (e.target as HTMLElement).closest(".toc-item") as HTMLElement | null;
    if (!item) return;
    const lineNum = Number(item.dataset.line);
    if (!lineNum) return;
    const line = editor.state.doc.line(lineNum);
    editor.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    editor.focus();
  });
}

export function updateTocPanel(content: string) {
  if (!panelEl) return;
  if (content === lastContent) return;
  lastContent = content;

  const headings = getDocumentStructure(content).headings;

  if (headings.length === 0) {
    if (lastHeadings.length > 0) {
      lastHeadings = headings;
      panelEl.style.display = "none";
    }
    return;
  }

  // Skip re-render if headings are unchanged
  if (
    headings.length === lastHeadings.length &&
    headings.every(
      (h, i) =>
        h.level === lastHeadings[i].level &&
        h.text === lastHeadings[i].text &&
        h.line === lastHeadings[i].line,
    )
  ) {
    return;
  }

  lastHeadings = headings;
  panelEl.style.display = "";
  render();
}

function render() {
  if (!panelEl) return;

  let html = `<div class="toc-header">`;
  html += `<button class="toc-toggle" title="Toggle TOC">${collapsed ? "\u25B6" : "\u25BC"} Contents</button>`;
  html += `<span class="toc-count">${lastHeadings.length}</span>`;
  html += `</div>`;

  if (!collapsed) {
    html += `<div class="toc-body">`;
    // Find minimum heading level for indentation
    const minLevel = Math.min(...lastHeadings.map((h) => h.level));
    for (const h of lastHeadings) {
      const indent = h.level - minLevel;
      html += `<div class="toc-item toc-level-${indent}" data-line="${h.line}">`;
      html += escapeHtml(h.text);
      html += `</div>`;
    }
    html += `</div>`;
  }

  panelEl.innerHTML = html;
  lastActiveIdx = -2;
}

/** Highlight the heading closest to the current editor viewport. */
export function updateTocActiveHeading() {
  if (!panelEl || collapsed || lastHeadings.length === 0) return;

  const topLine = editor.state.doc.lineAt(
    editor.lineBlockAtHeight(editor.scrollDOM.scrollTop).from,
  ).number;

  // Find the last heading at or before the top visible line
  let activeIdx = -1;
  for (let i = lastHeadings.length - 1; i >= 0; i--) {
    if (lastHeadings[i].line <= topLine) {
      activeIdx = i;
      break;
    }
  }
  // If no heading before viewport, highlight first
  if (activeIdx === -1 && lastHeadings.length > 0) activeIdx = 0;

  // Skip DOM updates when the active heading hasn't changed (scroll hot path)
  if (activeIdx === lastActiveIdx) return;
  lastActiveIdx = activeIdx;

  const items = panelEl.querySelectorAll(".toc-item");
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("toc-active", i === activeIdx);
  }

  // Scroll active item into view within the TOC body
  if (activeIdx >= 0 && items[activeIdx]) {
    const body = panelEl.querySelector(".toc-body");
    if (body) {
      const item = items[activeIdx] as HTMLElement;
      const bodyRect = body.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      if (itemRect.top < bodyRect.top || itemRect.bottom > bodyRect.bottom) {
        item.scrollIntoView({ block: "nearest" });
      }
    }
  }
}

export function toggleTocPanel() {
  if (!panelEl) return;
  if (panelEl.style.display === "none") {
    // Force show even if empty
    panelEl.style.display = "";
    collapsed = false;
    render();
  } else {
    panelEl.style.display = "none";
  }
}
