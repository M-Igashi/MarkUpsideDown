import { ViewPlugin, ViewUpdate } from "@codemirror/view";

// When user types `[` after a list marker (e.g. `- `, `* `, `1. `),
// auto-complete to `[ ] ` forming a checkbox: `- [ ] `

export const todoAutocomplete = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.docChanged) return;

      for (const tr of update.transactions) {
        if (!tr.isUserEvent("input")) continue;

        tr.changes.iterChanges((_fromA, _toA, _fromB, toB) => {
          // Check if the just-typed character is `[`
          if (update.state.doc.sliceString(toB - 1, toB) !== "[") return;

          // Get text from line start to cursor
          const line = update.state.doc.lineAt(toB);
          const prefix = line.text.slice(0, toB - line.from);

          // Match: optional whitespace + list marker + `[`
          if (!/^\s*(?:[-*+]|\d+\.)\s+\[$/.test(prefix)) return;

          queueMicrotask(() => {
            // Verify the character is still `[` (no concurrent edits)
            if (update.view.state.doc.sliceString(toB - 1, toB) !== "[") return;

            update.view.dispatch({
              changes: { from: toB, to: toB, insert: " ] " },
              selection: { anchor: toB + 3 },
            });
          });
        });
      }
    }
  },
);
