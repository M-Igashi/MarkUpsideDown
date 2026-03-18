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

export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("*");
export const toggleStrikethrough = toggleWrap("~~");
export const toggleInlineCode = toggleWrap("`");
export { insertLink };
