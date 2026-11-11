// YAML Frontmatter panel: collapsible display above the editor
// showing parsed key-value pairs from the document frontmatter.

import type { EditorView } from "@codemirror/view";
import { getDocumentStructure, type FrontmatterInfo } from "./document-structure.ts";
import { escapeHtml } from "./html-utils.ts";

let panelEl: HTMLElement | null = null;
let editor: EditorView;
let lastFm: FrontmatterInfo | null = null;
let lastContent: string | null = null;

export function initFrontmatterPanel(ed: EditorView, container: HTMLElement) {
  editor = ed;

  panelEl = document.createElement("div");
  panelEl.className = "frontmatter-panel";
  panelEl.style.display = "none";
  panelEl.dataset.collapsed = "true";
  container.insertBefore(panelEl, container.firstChild);

  // Single delegated click listener (never accumulates)
  panelEl.addEventListener("click", (e) => {
    const toggle = (e.target as HTMLElement).closest(".frontmatter-toggle");
    if (toggle) {
      panelEl!.dataset.collapsed = panelEl!.dataset.collapsed === "true" ? "false" : "true";
      renderPanel();
      return;
    }
    const row = (e.target as HTMLElement).closest(".frontmatter-row");
    if (row && lastFm) {
      const line = editor.state.doc.line(lastFm.startLine + 1);
      editor.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      editor.focus();
    }
  });
}

export function updateFrontmatterPanel(content: string) {
  if (!panelEl) return;
  if (content === lastContent) return;
  lastContent = content;

  const fm = getDocumentStructure(content).frontmatter;

  if (!fm || !fm.parsed || Object.keys(fm.parsed).length === 0) {
    if (lastFm !== null) {
      panelEl.style.display = "none";
      lastFm = null;
    }
    return;
  }

  // Skip re-render if frontmatter raw content is unchanged
  if (fm.raw === lastFm?.raw && fm.valid === lastFm?.valid) return;

  lastFm = fm;
  panelEl.style.display = "";
  renderPanel();
}

function renderPanel() {
  if (!panelEl || !lastFm?.parsed) return;

  const collapsed = panelEl.dataset.collapsed === "true";

  let html = `<div class="frontmatter-header">`;
  html += `<button class="frontmatter-toggle" title="Toggle frontmatter">${collapsed ? "\u25B6" : "\u25BC"} Frontmatter</button>`;
  if (!lastFm.valid) {
    html += `<span class="frontmatter-warning">Invalid YAML</span>`;
  }
  html += `</div>`;

  if (!collapsed) {
    html += `<div class="frontmatter-body">`;
    for (const [key, value] of Object.entries(lastFm.parsed)) {
      html += `<div class="frontmatter-row">`;
      html += `<span class="frontmatter-key">${escapeHtml(key)}</span>`;
      html += `<span class="frontmatter-value">${escapeHtml(value)}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  panelEl.innerHTML = html;
}
