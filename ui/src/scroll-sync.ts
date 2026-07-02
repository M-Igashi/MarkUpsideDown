import type { EditorView } from "@codemirror/view";

export interface ScrollAnchor {
  editorY: number;
  previewY: number;
}

// Shared mutable state — accessed by both scroll-sync and preview modules
export const scrollState = {
  renderingPreview: false,
  pendingRender: false,
  activeSide: "editor" as "editor" | "preview",
  syncRAF: 0,
  cachedSourceLineEls: [] as HTMLElement[],
  // Parsed source-line numbers parallel to cachedSourceLineEls (DOM order,
  // monotonically non-decreasing) — enables binary search in sync functions
  cachedSourceLines: [] as number[],
};

let editor: EditorView;
let previewPane: HTMLElement;
let cmScroller: HTMLElement;

let programmaticScrollAt = 0;
let lastPreviewClickAt = 0;

const PROG_SCROLL_MS = 80;
const CLICK_SUPPRESS_MS = 150;

export function initScrollSync(ed: EditorView, pp: HTMLElement, cms: HTMLElement) {
  editor = ed;
  previewPane = pp;
  cmScroller = cms;
}

export function isProgrammaticScroll() {
  return performance.now() - programmaticScrollAt < PROG_SCROLL_MS;
}

export function markProgrammaticScroll() {
  programmaticScrollAt = performance.now();
}

function getCodeBlockLineInfo(preEl: HTMLElement) {
  const codeEl = preEl.querySelector("code") || preEl;
  const lines = codeEl.textContent!.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rect = codeEl.getBoundingClientRect();
  const lineHeight = lines.length > 0 ? rect.height / lines.length : 0;
  return { codeEl, lines, rect, lineHeight };
}

// --- Helpers for finding surrounding data-source-line elements ---

function findSurroundingEls(targetLine: number) {
  const elements = scrollState.cachedSourceLineEls;
  const lines = scrollState.cachedSourceLines;
  if (elements.length === 0) return null;

  // Binary search: last index with line <= targetLine
  let lo = 0;
  let hi = elements.length - 1;
  let beforeIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] <= targetLine) {
      beforeIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // First element among equal-line duplicates
  while (beforeIdx > 0 && lines[beforeIdx - 1] === lines[beforeIdx]) beforeIdx--;

  // Binary search: first index with line >= targetLine
  lo = 0;
  hi = elements.length - 1;
  let afterIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] >= targetLine) {
      afterIdx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  let before: HTMLElement | null = beforeIdx >= 0 ? elements[beforeIdx] : null;
  let after: HTMLElement | null = afterIdx >= 0 ? elements[afterIdx] : null;
  let beforeLine = beforeIdx >= 0 ? lines[beforeIdx] : -1;
  let afterLine = afterIdx >= 0 ? lines[afterIdx] : Infinity;

  if (!before && !after) return null;
  if (!before) {
    before = after;
    beforeLine = afterLine;
  }
  if (!after) {
    after = before;
    afterLine = beforeLine;
  }

  return { before: before!, after: after!, beforeLine, afterLine };
}

function computePreviewLineHeight(surr: {
  before: HTMLElement;
  after: HTMLElement;
  beforeLine: number;
  afterLine: number;
}) {
  if (surr.before === surr.after || surr.afterLine === surr.beforeLine) {
    return surr.before.getBoundingClientRect().height;
  }
  const previewRect = previewPane.getBoundingClientRect();
  const pst = previewPane.scrollTop;
  const beforeY = surr.before.getBoundingClientRect().top - previewRect.top + pst;
  const afterY = surr.after.getBoundingClientRect().top - previewRect.top + pst;
  return (afterY - beforeY) / (surr.afterLine - surr.beforeLine);
}

function computePreviewY(
  surr: { before: HTMLElement; after: HTMLElement; beforeLine: number; afterLine: number },
  targetLine: number,
) {
  const previewRect = previewPane.getBoundingClientRect();
  const pst = previewPane.scrollTop;

  // Fine-grained sync within code blocks
  if (surr.before.tagName === "PRE" && targetLine > surr.beforeLine) {
    const info = getCodeBlockLineInfo(surr.before);
    if (info.lines.length > 1) {
      const lineIndex = targetLine - surr.beforeLine - 1;
      if (lineIndex >= 0 && lineIndex < info.lines.length) {
        return info.rect.top - previewRect.top + pst + lineIndex * info.lineHeight;
      }
    }
  }

  const beforeY = surr.before.getBoundingClientRect().top - previewRect.top + pst;
  if (surr.before === surr.after || surr.beforeLine === surr.afterLine) {
    return beforeY;
  }
  const afterY = surr.after.getBoundingClientRect().top - previewRect.top + pst;
  const t = (targetLine - surr.beforeLine) / (surr.afterLine - surr.beforeLine);
  return beforeY + t * (afterY - beforeY);
}

// --- Scroll anchor build (kept for resize and post-render) ---

export function buildScrollAnchors() {
  // Refresh cached source-line elements (used by all sync functions)
  const els: HTMLElement[] = [];
  const lines: number[] = [];
  for (const el of previewPane.querySelectorAll("[data-source-line]")) {
    const sl = parseInt((el as HTMLElement).dataset.sourceLine!, 10);
    if (isNaN(sl)) continue;
    els.push(el as HTMLElement);
    lines.push(sl);
  }
  scrollState.cachedSourceLineEls = els;
  scrollState.cachedSourceLines = lines;
}

// --- Viewport-based scroll sync ---
// Uses posAtCoords / live getBoundingClientRect instead of pre-computed anchors.
// This avoids CodeMirror's estimated lineBlockAt positions for off-screen lines.

export function syncToPreview() {
  if (scrollState.renderingPreview) return;
  const elements = scrollState.cachedSourceLineEls;
  if (elements.length === 0) return;

  // Edge: top
  if (cmScroller.scrollTop <= 0) {
    if (previewPane.scrollTop < 1) return;
    markProgrammaticScroll();
    previewPane.scrollTop = 0;
    return;
  }

  // Edge: bottom
  const editorMax = cmScroller.scrollHeight - cmScroller.clientHeight;
  if (cmScroller.scrollTop >= editorMax - 1) {
    const previewMax = previewPane.scrollHeight - previewPane.clientHeight;
    if (Math.abs(previewPane.scrollTop - previewMax) < 1) return;
    markProgrammaticScroll();
    previewPane.scrollTop = previewMax;
    return;
  }

  // Find the document position at the top of the visible editor
  const cmRect = cmScroller.getBoundingClientRect();
  const topPos = editor.posAtCoords({ x: cmRect.left + 1, y: cmRect.top + 1 });
  if (topPos == null) return;

  const topLine = editor.state.doc.lineAt(topPos).number;
  const topBlock = editor.lineBlockAt(topPos);
  // Fractional progress within the top editor line (0–1)
  const editorSubOffset = cmScroller.scrollTop - topBlock.top;
  const blockProgress = topBlock.height > 0 ? editorSubOffset / topBlock.height : 0;

  const surr = findSurroundingEls(topLine);
  if (!surr) return;

  const previewY = computePreviewY(surr, topLine);
  // Scale sub-offset proportionally using preview line height
  const previewLineHeight = computePreviewLineHeight(surr);
  const target = Math.max(0, Math.round(previewY + blockProgress * previewLineHeight));
  if (Math.abs(previewPane.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  previewPane.scrollTop = target;
}

export function syncToEditor() {
  if (scrollState.renderingPreview) return;
  const elements = scrollState.cachedSourceLineEls;
  if (elements.length === 0) return;

  // Edge: top
  if (previewPane.scrollTop <= 0) {
    if (cmScroller.scrollTop < 1) return;
    markProgrammaticScroll();
    cmScroller.scrollTop = 0;
    return;
  }

  // Edge: bottom
  const previewMax = previewPane.scrollHeight - previewPane.clientHeight;
  if (previewPane.scrollTop >= previewMax - 1) {
    const editorMax = cmScroller.scrollHeight - cmScroller.clientHeight;
    if (Math.abs(cmScroller.scrollTop - editorMax) < 1) return;
    markProgrammaticScroll();
    cmScroller.scrollTop = editorMax;
    return;
  }

  // Find the preview element nearest to the viewport top using binary search.
  // Elements are in DOM order, so their absolute Y positions are monotonically increasing.
  const previewRect = previewPane.getBoundingClientRect();
  const pst = previewPane.scrollTop;

  const getAbsY = (el: HTMLElement) => el.getBoundingClientRect().top - previewRect.top + pst;

  // Binary search: find the last element with absY <= pst
  let lo = 0;
  let hi = elements.length - 1;
  let beforeIdx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (getAbsY(elements[mid]) <= pst) {
      beforeIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const lines = scrollState.cachedSourceLines;
  let before: HTMLElement | null = beforeIdx >= 0 ? elements[beforeIdx] : null;
  let after: HTMLElement | null = beforeIdx + 1 < elements.length ? elements[beforeIdx + 1] : null;
  let beforeLine = beforeIdx >= 0 ? lines[beforeIdx] : -1;
  let afterLine = beforeIdx + 1 < elements.length ? lines[beforeIdx + 1] : Infinity;
  let beforeAbsY = before ? getAbsY(before) : -Infinity;
  let afterAbsY = after ? getAbsY(after) : Infinity;

  if (!before && !after) return;
  if (!before) {
    before = after!;
    beforeLine = afterLine;
    beforeAbsY = afterAbsY;
  }
  if (!after) {
    after = before!;
    afterLine = beforeLine;
    afterAbsY = beforeAbsY;
  }

  // Determine the source line at the preview viewport top
  let targetLine: number;
  let previewSubOffset = 0;
  let lineFraction = 0;

  if (before!.tagName === "PRE" && pst > beforeAbsY) {
    const info = getCodeBlockLineInfo(before!);
    if (info.lineHeight > 0 && info.lines.length > 1) {
      const offsetInBlock = pst - beforeAbsY;
      const lineIndex = Math.min(
        info.lines.length - 1,
        Math.floor(offsetInBlock / info.lineHeight),
      );
      targetLine = beforeLine + 1 + lineIndex;
      previewSubOffset = offsetInBlock - lineIndex * info.lineHeight;
    } else {
      targetLine = beforeLine;
      previewSubOffset = pst - beforeAbsY;
    }
  } else if (before === after || afterAbsY <= beforeAbsY) {
    targetLine = beforeLine;
    previewSubOffset = pst - beforeAbsY;
  } else {
    const t = Math.max(0, Math.min(1, (pst - beforeAbsY) / (afterAbsY - beforeAbsY)));
    const exactLine = beforeLine + t * (afterLine - beforeLine);
    targetLine = Math.floor(exactLine);
    lineFraction = exactLine - targetLine;
  }

  if (targetLine < 1) targetLine = 1;
  if (targetLine > editor.state.doc.lines) targetLine = editor.state.doc.lines;

  const line = editor.state.doc.line(targetLine);
  const block = editor.lineBlockAt(line.from);

  const target = Math.max(
    0,
    Math.round(block.top + previewSubOffset + lineFraction * block.height),
  );
  if (Math.abs(cmScroller.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  cmScroller.scrollTop = target;
}

// --- Preserve preview scroll across layout changes (panel fold/unfold) ---
// Captures the element at the viewport top, runs the layout change, then
// restores scroll so the same element stays in view after reflow.

export function preservePreviewScroll(action: () => void) {
  const elements = scrollState.cachedSourceLineEls;
  if (elements.length === 0) {
    action();
    return;
  }

  const previewRect = previewPane.getBoundingClientRect();

  // Find the last element whose top is at or above the viewport top
  let anchorEl: HTMLElement | null = null;
  let anchorOffset = 0;

  for (const el of elements) {
    const elTop = el.getBoundingClientRect().top - previewRect.top;
    if (elTop <= 2) {
      anchorEl = el;
      anchorOffset = elTop;
    } else {
      break;
    }
  }

  if (!anchorEl) {
    anchorEl = elements[0];
    anchorOffset = anchorEl.getBoundingClientRect().top - previewRect.top;
  }

  // Suppress scroll-sync events triggered by the reflow
  markProgrammaticScroll();

  action();

  // Cancel any pending sync (e.g. syncPreviewToCursor from CodeMirror selectionSet)
  cancelAnimationFrame(scrollState.syncRAF);
  scrollState.syncRAF = 0;

  // After reflow, restore so anchor element stays at the same viewport offset
  requestAnimationFrame(() => {
    markProgrammaticScroll();
    const newTop = anchorEl!.getBoundingClientRect().top - previewPane.getBoundingClientRect().top;
    previewPane.scrollTop += newTop - anchorOffset;
    // Best-effort: sync editor scroll to match preview position
    syncToEditor();
  });
}

// --- Cursor-based sync (unchanged — already uses live measurements) ---

export function syncPreviewToCursor() {
  if (scrollState.renderingPreview || scrollState.pendingRender) return;
  if (performance.now() - lastPreviewClickAt < CLICK_SUPPRESS_MS) return;

  const pos = editor.state.selection.main.head;
  const cursorLine = editor.state.doc.lineAt(pos).number;
  const block = editor.lineBlockAt(pos);

  const elements = scrollState.cachedSourceLineEls;
  if (elements.length === 0) return;

  const surr = findSurroundingEls(cursorLine);
  if (!surr) return;

  const previewTargetY = computePreviewY(surr, cursorLine);

  const lineVisibleY = block.top - cmScroller.scrollTop;
  const scrollTarget = Math.max(0, Math.round(previewTargetY - lineVisibleY));
  if (Math.abs(previewPane.scrollTop - scrollTarget) < 1) return;
  markProgrammaticScroll();
  previewPane.scrollTop = scrollTarget;
}

export function syncPreviewClickToEditor(event: MouseEvent) {
  let el = event.target as HTMLElement | null;
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
  scrollState.activeSide = "preview";
  const line = editor.state.doc.line(lineNum);
  editor.dispatch({ selection: { anchor: line.from } });

  const clickVisibleY = event.clientY - previewPane.getBoundingClientRect().top;
  const block = editor.lineBlockAt(line.from);
  const editorTarget = block.top - clickVisibleY;
  markProgrammaticScroll();
  cmScroller.scrollTo({ top: Math.max(0, editorTarget), behavior: "instant" });
  editor.focus();
}
