import type { EditorView } from "@codemirror/view";
import type { Command } from "@codemirror/view";

/** Wrap or unwrap the selection with a symmetric marker (e.g. `**`, `*`, `~~`, `` ` ``). */
function toggleWrap(marker: string): Command {
  return (view: EditorView) => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const len = marker.length;

      // Check if already wrapped — unwrap
      const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));

      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from, insert: "" },
            { from: range.to, to: range.to + len, insert: "" },
          ],
          range: { anchor: range.from - len, head: range.to - len },
        };
      }

      // Wrap selection
      const insert = `${marker}${selected}${marker}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: {
          anchor: range.from + len,
          head: range.from + len + selected.length,
        },
      };
    });

    view.dispatch(state.update(changes, { userEvent: "input" }));
    return true;
  };
}

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
 * Bold toggle: wraps with `__` (avoids nesting collision with italic `*`).
 * Unwraps both `__` and `**` for compatibility with existing documents.
 */
export const toggleBold: Command = (view: EditorView) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);

    // Unwrap either __ or ** (check both for existing-document compat)
    for (const marker of ["__", "**"]) {
      const len = marker.length;
      const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from, insert: "" },
            { from: range.to, to: range.to + len, insert: "" },
          ],
          range: { anchor: range.from - len, head: range.to - len },
        };
      }
    }

    // Wrap with __ (distinct from italic * to avoid nesting ambiguity)
    const insert = `__${selected}__`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: { anchor: range.from + 2, head: range.from + 2 + selected.length },
    };
  });

  view.dispatch(state.update(changes, { userEvent: "input" }));
  return true;
};
export const toggleItalic = toggleWrap("*");
export const toggleStrikethrough = toggleWrap("~~");
/** Smart inline code: adjusts backtick delimiter length when content contains backticks. */
export const toggleInlineCode: Command = (view: EditorView) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);

    // Detect if already wrapped with backticks — find the delimiter length
    for (let len = 3; len >= 1; len--) {
      const marker = "`".repeat(len);
      const before = state.sliceDoc(Math.max(0, range.from - len), range.from);
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + len));
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from, insert: "" },
            { from: range.to, to: range.to + len, insert: "" },
          ],
          range: { anchor: range.from - len, head: range.to - len },
        };
      }
    }

    // Wrap: find longest backtick run in content and use N+1
    const maxTicks = Math.max(0, ...(selected.match(/`+/g) || []).map((s) => s.length));
    const delimiter = "`".repeat(maxTicks + 1);
    // CommonMark: when delimiter > 1 backtick, add space padding
    const space = maxTicks > 0 ? " " : "";
    const insert = `${delimiter}${space}${selected}${space}${delimiter}`;
    const contentOffset = delimiter.length + space.length;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: {
        anchor: range.from + contentOffset,
        head: range.from + contentOffset + selected.length,
      },
    };
  });

  view.dispatch(state.update(changes, { userEvent: "input" }));
  return true;
};

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
