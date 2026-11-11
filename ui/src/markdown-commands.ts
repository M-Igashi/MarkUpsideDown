import type { EditorView } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";

/**
 * Toggle inline markup around each selection: unwrap if the range is already
 * surrounded by one of `unwrapMarkers` (checked in order), otherwise wrap it
 * with the `[open, close]` pair from `wrapWith`, keeping the text selected.
 */
function toggleMarkup(
  unwrapMarkers: string[],
  wrapWith: (selected: string) => [string, string],
): Command {
  return (view: EditorView) => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const unwrapped = tryUnwrap(state, range, unwrapMarkers);
      if (unwrapped) return unwrapped;
      const selected = state.sliceDoc(range.from, range.to);
      const [open, close] = wrapWith(selected);
      return {
        changes: { from: range.from, to: range.to, insert: `${open}${selected}${close}` },
        range: EditorSelection.range(
          range.from + open.length,
          range.from + open.length + selected.length,
        ),
      };
    });
    view.dispatch(state.update(changes, { userEvent: "input" }));
    return true;
  };
}

function tryUnwrap(state: EditorState, range: SelectionRange, markers: string[]) {
  for (const marker of markers) {
    const len = marker.length;
    const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));
    if (before === marker && after === marker && !isInsideDoubleMarker(state, range, marker)) {
      return {
        changes: [
          { from: range.from - len, to: range.from, insert: "" },
          { from: range.to, to: range.to + len, insert: "" },
        ],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }
  }
  return null;
}

/** True when a single-char marker like `*` is really part of `**` (bold), not italic. */
function isInsideDoubleMarker(state: EditorState, range: SelectionRange, marker: string): boolean {
  if (marker.length !== 1) return false;
  let run = 0;
  while (
    range.from - run > 0 &&
    state.sliceDoc(range.from - run - 1, range.from - run) === marker
  ) {
    run++;
  }
  return run % 2 === 0;
}

/** Wrap or unwrap the selection with a symmetric marker (e.g. `*`, `~~`). */
const toggleWrap = (marker: string) => toggleMarkup([marker], () => [marker, marker]);

/** Insert a markdown link. If text is selected, use it as the link text. */
const insertLink: Command = (view: EditorView) => {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);

  if (selected) {
    const insert = `[${selected}](url)`;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: {
        anchor: range.from + selected.length + 3,
        head: range.from + selected.length + 6,
      },
    });
  } else {
    const insert = "[](url)";
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + 1 },
    });
  }
  return true;
};

/**
 * Bold toggle: wraps with `**`, which CommonMark renders as bold even inside CJK text.
 * Unwraps both `**` and `__` for compatibility with existing documents.
 */
export const toggleBold = toggleMarkup(["**", "__"], () => ["**", "**"]);
export const toggleItalic = toggleWrap("*");
export const toggleStrikethrough = toggleWrap("~~");
/** Smart inline code: adjusts backtick delimiter length when content contains backticks. */
export const toggleInlineCode = toggleMarkup(["```", "``", "`"], (selected) => {
  // Use one more backtick than the longest run in the content
  const maxTicks = Math.max(0, ...(selected.match(/`+/g) || []).map((s) => s.length));
  const delimiter = "`".repeat(maxTicks + 1);
  // CommonMark: when delimiter > 1 backtick, add space padding
  const space = maxTicks > 0 ? " " : "";
  return [delimiter + space, space + delimiter];
});

/** Insert a fenced code block. Auto-adjusts fence length if content contains triple backticks. */
export const insertCodeBlock: Command = (view: EditorView) => {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);

  // Find the longest backtick fence in the selected text
  const maxFence = Math.max(2, ...(selected.match(/`{3,}/g) || []).map((s) => s.length));
  const fence = "`".repeat(maxFence + 1);

  const prefix = range.from > 0 && state.sliceDoc(range.from - 1, range.from) !== "\n" ? "\n" : "";

  if (selected) {
    const insert = `${prefix}${fence}\n${selected}\n${fence}\n`;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: {
        // Place cursor at language hint position (after opening fence)
        anchor: range.from + prefix.length + fence.length,
      },
    });
  } else {
    const insert = `${prefix}${fence}\n\n${fence}\n`;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: {
        // Place cursor on the empty line inside the block
        anchor: range.from + prefix.length + fence.length + 1,
      },
    });
  }
  return true;
};

export { insertLink };
