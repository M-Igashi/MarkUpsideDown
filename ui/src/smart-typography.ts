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

interface Rule {
  pattern: RegExp;
  replace: string | ((match: RegExpMatchArray) => string);
}

const rules: Rule[] = [
  // Ellipsis: three dots → …
  { pattern: /\.\.\./, replace: "\u2026" },
  // Em dash: three hyphens → —
  { pattern: /---/, replace: "\u2014" },
  // En dash: two hyphens → –
  { pattern: /--/, replace: "\u2013" },
];

export const smartTypography = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.docChanged || !isSmartTypographyEnabled()) return;

      for (const tr of update.transactions) {
        if (!tr.isUserEvent("input.type") && !tr.isUserEvent("input")) continue;

        tr.changes.iterChanges((_fromA, _toA, _fromB, toB) => {
          for (const rule of rules) {
            const len = rule.pattern.source.length;
            const start = Math.max(0, toB - len);
            const segment = update.state.doc.sliceString(start, toB);
            const match = segment.match(rule.pattern);
            if (!match) continue;

            const matchStart = start + match.index!;
            const matchEnd = matchStart + match[0].length;

            const before = update.state.doc.sliceString(0, matchStart);
            if (isPositionInCode(before, before.length)) continue;

            const replacement =
              typeof rule.replace === "function" ? rule.replace(match) : rule.replace;

            // Use queueMicrotask instead of requestAnimationFrame to minimize
            // the window where a click can race with the pending selection change.
            // RAF (~16ms) was causing range selections when clicking right after typing.
            queueMicrotask(() => {
              const current = update.view.state.doc.sliceString(matchStart, matchEnd);
              if (current === match[0]) {
                update.view.dispatch({
                  changes: { from: matchStart, to: matchEnd, insert: replacement },
                  selection: { anchor: matchStart + replacement.length },
                });
              }
            });
            return;
          }
        });
      }
    }
  },
);
