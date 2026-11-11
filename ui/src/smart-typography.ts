import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import { KEY_SMART_TYPOGRAPHY } from "./storage-keys.ts";
import { isPositionInCode } from "./document-structure.ts";

export function isSmartTypographyEnabled(): boolean {
  return getStorageBool(KEY_SMART_TYPOGRAPHY);
}

export function setSmartTypographyEnabled(enabled: boolean) {
  setStorageBool(KEY_SMART_TYPOGRAPHY, enabled);
}

// Matched against the text ending at the typed character, in order.
// `--` becomes an en dash right away, so a third `-` upgrades it to an em dash.
const rules: { match: string; replace: string }[] = [
  { match: "...", replace: "…" },
  { match: "–-", replace: "—" },
  { match: "--", replace: "–" },
];

// Thematic breaks, frontmatter delimiters, and table separator rows.
const STRUCTURAL_LINE = /^[-\s|:]*$/;

/** Find the replacement for the character just typed before `pos`, if any. */
export function findReplacement(
  doc: string,
  pos: number,
): { from: number; match: string; replace: string } | null {
  const rule = rules.find((r) => doc.slice(pos - r.match.length, pos) === r.match);
  if (!rule) return null;
  const from = pos - rule.match.length;

  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = doc.indexOf("\n", pos);
  if (STRUCTURAL_LINE.test(doc.slice(lineStart, lineEnd < 0 ? doc.length : lineEnd))) return null;

  const before = doc.slice(0, pos);
  if (before.lastIndexOf("<!--") > before.lastIndexOf("-->")) return null;
  if (isPositionInCode(doc, from)) return null;

  return { from, ...rule };
}

export const smartTypography = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.docChanged || !isSmartTypographyEnabled()) return;

      for (const tr of update.transactions) {
        if (!tr.isUserEvent("input.type") && !tr.isUserEvent("input")) continue;

        tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          if (toB - fromB !== 1) return;
          const found = findReplacement(update.state.doc.toString(), toB);
          if (!found) return;
          const { from, match, replace } = found;

          requestAnimationFrame(() => {
            if (update.view.state.doc.sliceString(from, toB) !== match) return;
            update.view.dispatch({
              changes: { from, to: toB, insert: replace },
              selection: { anchor: from + replace.length },
            });
          });
        });
      }
    }
  },
);
