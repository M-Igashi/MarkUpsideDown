// YAML Frontmatter panel: collapsible display above the editor
// showing parsed key-value pairs from the document frontmatter.

import type { EditorView } from "@codemirror/view";
import { parseFrontmatter } from "./document-structure.ts";
import { escapeHtml } from "./settings.ts";

let panelEl: HTMLElement | null = null;
let editor: EditorView;

export function initFrontmatterPanel(ed: EditorView, container: HTMLElement) {
  editor = ed;

  panelEl = document.createElement("div");
  panelEl.className = "frontmatter-panel";
  panelEl.style.display = "none";
  panelEl.dataset.collapsed = "true";
  container.insertBefore(panelEl, container.firstChild);
}

export function updateFrontmatterPanel(content: string) {
  if (!panelEl) return;

  const lines = content.split("\n");
  const fm = parseFrontmatter(lines);

  if (!fm || !fm.parsed || Object.keys(fm.parsed).length === 0) {
    panelEl.style.display = "none";
    return;
  }

  panelEl.style.display = "";
  const collapsed = panelEl.dataset.collapsed === "true";

  let html = `<div class="frontmatter-header">`;
  html += `<button class="frontmatter-toggle" title="Toggle frontmatter">${collapsed ? "\u25B6" : "\u25BC"} Frontmatter</button>`;
  if (!fm.valid) {
    html += `<span class="frontmatter-warning">Invalid YAML</span>`;
  }
  html += `</div>`;

  if (!collapsed) {
    html += `<div class="frontmatter-body">`;
    for (const [key, value] of Object.entries(fm.parsed)) {
      html += `<div class="frontmatter-row">`;
      html += `<span class="frontmatter-key">${escapeHtml(key)}</span>`;
      html += `<span class="frontmatter-value">${escapeHtml(value)}</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  panelEl.innerHTML = html;

  const toggle = panelEl.querySelector(".frontmatter-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      panelEl!.dataset.collapsed = collapsed ? "false" : "true";
      updateFrontmatterPanel(editor.state.doc.toString());
    });
  }

  // Click on key or value to jump to frontmatter in editor
  panelEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".frontmatter-row");
    if (row && fm) {
      // Jump to frontmatter start
      const line = editor.state.doc.line(fm.startLine + 1);
      editor.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      editor.focus();
    }
  });
}
