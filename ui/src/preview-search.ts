// Find-in-preview: Cmd+F search bar for the rendered preview pane.
// Matches are painted with the CSS Custom Highlight API so the preview DOM
// stays untouched (safe for idiomorph morphing, Mermaid, KaTeX, hljs).

const HIGHLIGHT_ALL = "preview-search";
const HIGHLIGHT_CURRENT = "preview-search-current";
// Invisible text or UI chrome that is not document content
const SKIP_SELECTOR =
  "script, style, .code-copy-btn, .mermaid-copy-btn, .mermaid-expand-hint, .katex-mathml";

const highlights = "highlights" in CSS ? CSS.highlights : null;

let pane: HTMLElement;
let wrapper: HTMLElement;
let editorEl: HTMLElement;
let bar: HTMLElement;
let input: HTMLInputElement;
let countEl: HTMLElement;
let onClose: () => void;
let lastPane: "editor" | "preview" = "editor";
let ranges: Range[] = [];
let current = -1;

export function initPreviewSearch(
  pp: HTMLElement,
  pw: HTMLElement,
  editorContainer: HTMLElement,
  opts: { onClose: () => void },
) {
  pane = pp;
  wrapper = pw;
  editorEl = editorContainer;
  onClose = opts.onClose;

  // Track the pane the user last interacted with so Cmd+F can be routed.
  // Focus alone is not enough: clicking the preview moves focus to the editor.
  const markEditor = () => {
    lastPane = "editor";
  };
  const markPreview = () => {
    lastPane = "preview";
  };
  editorEl.addEventListener("mousedown", markEditor);
  editorEl.addEventListener("wheel", markEditor, { passive: true });
  editorEl.addEventListener("keydown", (e) => {
    if (!e.metaKey && !e.ctrlKey) markEditor();
  });
  wrapper.addEventListener("mousedown", markPreview);
  wrapper.addEventListener("wheel", markPreview, { passive: true });

  bar = document.createElement("div");
  bar.className = "preview-search";
  bar.hidden = true;

  input = document.createElement("input");
  input.type = "text";
  input.className = "preview-search-input";
  input.placeholder = "Find in preview…";
  input.spellcheck = false;
  input.addEventListener("input", () => runSearch(true));
  input.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      closePreviewSearch();
    } else if (e.key === "Enter" || (mod && e.key === "g")) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });

  countEl = document.createElement("span");
  countEl.className = "preview-search-count";

  bar.append(
    input,
    countEl,
    button("↑", "Previous match (⇧↩)", () => step(-1)),
    button("↓", "Next match (↩)", () => step(1)),
    button("✕", "Close (Esc)", closePreviewSearch),
  );
  wrapper.insertBefore(bar, pane);
}

function button(label: string, title: string, onClick: () => void) {
  const btn = document.createElement("button");
  btn.className = "preview-search-btn";
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

/** True when Cmd+F should open the preview search rather than the editor's. */
export function isPreviewSearchTarget() {
  if (wrapper.classList.contains("collapsed")) return false;
  return lastPane === "preview" || editorEl.classList.contains("collapsed");
}

export function openPreviewSearch() {
  bar.hidden = false;
  input.focus();
  input.select();
  runSearch(true);
}

export function closePreviewSearch() {
  if (bar.hidden) return;
  bar.hidden = true;
  ranges = [];
  current = -1;
  clearHighlights();
  onClose();
}

/** Re-apply highlights after the preview re-renders (no-op while closed). */
export function refreshPreviewSearch() {
  if (!bar.hidden) runSearch(false);
}

function runSearch(reset: boolean) {
  const query = input.value;
  ranges = query ? findRanges(query) : [];
  if (ranges.length === 0) {
    current = -1;
  } else if (reset || current < 0) {
    current = firstVisibleIndex();
  } else {
    current = Math.min(current, ranges.length - 1);
  }
  applyHighlights();
  if (reset && current >= 0) scrollToCurrent();
  updateCount(query);
}

function step(dir: 1 | -1) {
  if (ranges.length === 0) return;
  current = (current + dir + ranges.length) % ranges.length;
  applyHighlights();
  scrollToCurrent();
  updateCount(input.value);
}

function updateCount(query: string) {
  if (!query) countEl.textContent = "";
  else if (ranges.length === 0) countEl.textContent = "No results";
  else countEl.textContent = `${current + 1} / ${ranges.length}`;
}

// Concatenate all visible text nodes, search once, then map match offsets
// back to DOM positions so matches spanning inline elements still work.
function findRanges(query: string): Range[] {
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }

  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const result: Range[] = [];
  let i = 0;
  // Matches arrive in document order, so a single forward cursor suffices
  const locate = (offset: number) => {
    while (i + 1 < starts.length && starts[i + 1] <= offset) i++;
    return i;
  };
  for (const m of text.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    const range = document.createRange();
    const si = locate(start);
    range.setStart(nodes[si], start - starts[si]);
    const ei = locate(end - 1);
    range.setEnd(nodes[ei], end - starts[ei]);
    result.push(range);
  }
  return result;
}

function firstVisibleIndex() {
  const top = pane.getBoundingClientRect().top;
  const idx = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top);
  return idx < 0 ? 0 : idx;
}

function scrollToCurrent() {
  const rect = ranges[current].getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  if (rect.top < paneRect.top || rect.bottom > paneRect.bottom) {
    pane.scrollTop += rect.top - paneRect.top - (pane.clientHeight - rect.height) / 2;
  }
}

function applyHighlights() {
  if (!highlights) return;
  const all = new Highlight();
  for (const r of ranges) all.add(r);
  highlights.set(HIGHLIGHT_ALL, all);
  highlights.set(
    HIGHLIGHT_CURRENT,
    current >= 0 ? new Highlight(ranges[current]) : new Highlight(),
  );
}

function clearHighlights() {
  highlights?.delete(HIGHLIGHT_ALL);
  highlights?.delete(HIGHLIGHT_CURRENT);
}
