import type { EditorView } from "@codemirror/view";

let editor: EditorView;
let previewPane: HTMLElement;
let statusEl: HTMLElement;

export function initClipboard(ed: EditorView, pp: HTMLElement, se: HTMLElement) {
  editor = ed;
  previewPane = pp;
  statusEl = se;
}

export async function copyRichText() {
  const sel = window.getSelection();
  const hasSelection = sel && !sel.isCollapsed && previewPane.contains(sel.anchorNode);

  let html: string;
  let text: string;
  if (hasSelection) {
    const range = sel.getRangeAt(0);
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    html = container.innerHTML;
    text = sel.toString();
  } else {
    html = previewPane.innerHTML;
    text = previewPane.innerText;
  }

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
