import type { EditorView } from "@codemirror/view";

let editor: EditorView;
let previewPane: HTMLElement;
let statusEl: HTMLElement;

export function initClipboard(ed: EditorView, pp: HTMLElement, se: HTMLElement) {
  editor = ed;
  previewPane = pp;
  statusEl = se;
}

const UI_SELECTOR = ".code-copy-btn, .mermaid-copy-btn, .mermaid-expand-hint";

// Copy without the preview's buttons, data-* attributes, and CJK hair spaces.
// The container is attached off-screen so innerText keeps line breaks.
function cleanCopy(range: Range): { html: string; text: string } {
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:-99999px;top:0";
  container.appendChild(range.cloneContents());
  container.querySelectorAll(UI_SELECTOR).forEach((el) => el.remove());
  for (const el of container.querySelectorAll("*")) {
    for (const name of el.getAttributeNames()) {
      if (name.startsWith("data-")) el.removeAttribute(name);
    }
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    node.nodeValue = node.nodeValue!.replaceAll(" ", "");
  }
  document.body.appendChild(container);
  const text = container.innerText;
  container.remove();
  return { html: container.innerHTML, text };
}

export async function copyRichText() {
  const sel = window.getSelection();
  const hasSelection = sel && !sel.isCollapsed && previewPane.contains(sel.anchorNode);

  let range: Range;
  if (hasSelection) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(previewPane);
  }
  const { html, text } = cleanCopy(range);

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    statusEl.textContent = hasSelection ? "Copied selection as rich text" : "Copied as rich text";
  } catch (e) {
    statusEl.textContent = `Copy failed: ${e}`;
  }
}

export async function copyMarkdown() {
  const state = editor.state;
  const sel = state.selection.main;
  const hasSelection = !sel.empty;
  const text = hasSelection ? state.sliceDoc(sel.from, sel.to) : state.doc.toString();

  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = hasSelection ? "Copied selection as Markdown" : "Copied as Markdown";
  } catch (e) {
    statusEl.textContent = `Copy failed: ${e}`;
  }
}
