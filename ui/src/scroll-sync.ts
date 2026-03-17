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

let scrollAnchors: ScrollAnchor[] = [];
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

export function buildScrollAnchors() {
  const elements = previewPane.querySelectorAll("[data-source-line]");

  const anchors: ScrollAnchor[] = [{ editorY: 0, previewY: 0 }];
  const previewRect = previewPane.getBoundingClientRect();
  const previewScrollTop = previewPane.scrollTop;

  for (const el of elements) {
    const lineNum = parseInt((el as HTMLElement).dataset.sourceLine!, 10);
    if (lineNum < 1 || lineNum > editor.state.doc.lines) continue;
    const line = editor.state.doc.line(lineNum);
    const block = editor.lineBlockAt(line.from);
    const editorY = block.top;
    const previewY = el.getBoundingClientRect().top - previewRect.top + previewScrollTop;
    anchors.push({ editorY, previewY });

    if (el.tagName === "PRE") {
      const info = getCodeBlockLineInfo(el as HTMLElement);
      if (info.lines.length > 1) {
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

function interpolate(
  anchors: ScrollAnchor[],
  fromKey: keyof ScrollAnchor,
  toKey: keyof ScrollAnchor,
  value: number,
) {
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

export function syncToPreview() {
  if (scrollState.renderingPreview || scrollAnchors.length < 2) return;
  const target = Math.round(
    interpolate(scrollAnchors, "editorY", "previewY", cmScroller.scrollTop),
  );
  if (Math.abs(previewPane.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  previewPane.scrollTop = target;
}

export function syncToEditor() {
  if (scrollState.renderingPreview || scrollAnchors.length < 2) return;
  const target = Math.round(
    interpolate(scrollAnchors, "previewY", "editorY", previewPane.scrollTop),
  );
  if (Math.abs(cmScroller.scrollTop - target) < 1) return;
  markProgrammaticScroll();
  cmScroller.scrollTop = target;
}

export function syncPreviewToCursor() {
  if (scrollState.renderingPreview || scrollState.pendingRender) return;
  if (performance.now() - lastPreviewClickAt < CLICK_SUPPRESS_MS) return;

  const pos = editor.state.selection.main.head;
  const cursorLine = editor.state.doc.lineAt(pos).number;
  const block = editor.lineBlockAt(pos);

  const elements = scrollState.cachedSourceLineEls;
  if (elements.length === 0) return;

  let before: HTMLElement | null = null;
  let after: HTMLElement | null = null;
  let beforeLine = -1;
  let afterLine = Infinity;

  for (const el of elements) {
    const sl = parseInt(el.dataset.sourceLine!, 10);
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

  let previewTargetY: number | undefined;

  if (before!.tagName === "PRE" && cursorLine > beforeLine) {
    const info = getCodeBlockLineInfo(before!);
    if (info.lines.length > 1) {
      const lineIndex = cursorLine - beforeLine - 1;
      if (lineIndex >= 0 && lineIndex < info.lines.length) {
        previewTargetY =
          info.rect.top - previewRect.top + previewScrollTop + lineIndex * info.lineHeight;
      }
    }
  }

  if (previewTargetY === undefined) {
    const beforeY = before!.getBoundingClientRect().top - previewRect.top + previewScrollTop;
    if (before === after || beforeLine === afterLine) {
      previewTargetY = beforeY;
    } else {
      const afterY = after!.getBoundingClientRect().top - previewRect.top + previewScrollTop;
      const t = (cursorLine - beforeLine) / (afterLine - beforeLine);
      previewTargetY = beforeY + t * (afterY - beforeY);
    }
  }

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
