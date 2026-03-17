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

function findSurroundingEls(elements: HTMLElement[], targetLine: number) {
  let before: HTMLElement | null = null;
  let after: HTMLElement | null = null;
  let beforeLine = -1;
  let afterLine = Infinity;

  for (const el of elements) {
    const sl = parseInt(el.dataset.sourceLine!, 10);
    if (isNaN(sl)) continue;
    if (sl <= targetLine && sl > beforeLine) {
      before = el;
      beforeLine = sl;
    }
    if (sl >= targetLine && sl < afterLine) {
      after = el;
      afterLine = sl;
    }
  }

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
  scrollState.cachedSourceLineEls = Array.from(
    previewPane.querySelectorAll("[data-source-line]"),
  ) as HTMLElement[];
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
  // Sub-line offset: how many px of the top line are scrolled above the viewport
  const editorSubOffset = cmScroller.scrollTop - topBlock.top;

  const surr = findSurroundingEls(elements, topLine);
  if (!surr) return;

  const previewY = computePreviewY(surr, topLine);
  const target = Math.max(0, Math.round(previewY + editorSubOffset));
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

  // Find the preview element nearest to the viewport top
  const previewRect = previewPane.getBoundingClientRect();
  const pst = previewPane.scrollTop;

  let before: HTMLElement | null = null;
  let after: HTMLElement | null = null;
  let beforeLine = -1;
  let afterLine = Infinity;
  let beforeAbsY = -Infinity;
  let afterAbsY = Infinity;

  for (const el of elements) {
    const sl = parseInt(el.dataset.sourceLine!, 10);
    if (isNaN(sl)) continue;
    const absY = el.getBoundingClientRect().top - previewRect.top + pst;
    if (absY <= pst && absY > beforeAbsY) {
      before = el;
      beforeLine = sl;
      beforeAbsY = absY;
    }
    if (absY > pst && absY < afterAbsY) {
      after = el;
      afterLine = sl;
      afterAbsY = absY;
    }
  }

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
    targetLine = Math.round(beforeLine + t * (afterLine - beforeLine));
  }

  if (targetLine < 1) targetLine = 1;
  if (targetLine > editor.state.doc.lines) targetLine = editor.state.doc.lines;

  const line = editor.state.doc.line(targetLine);
  const block = editor.lineBlockAt(line.from);

  const target = Math.max(0, Math.round(block.top + previewSubOffset));
  if (Math.abs(cmScroller.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  cmScroller.scrollTop = target;
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

  const surr = findSurroundingEls(elements, cursorLine);
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
