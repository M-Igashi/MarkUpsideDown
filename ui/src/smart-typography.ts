// Smart Typography: auto-convert ASCII quotes, dashes, and ellipsis
// as the user types. Respects code blocks and inline code.

import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import { isPositionInCode } from "./document-structure.ts";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import { KEY_SMART_TYPOGRAPHY } from "./storage-keys.ts";

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
          const doc = update.state.doc.toString();

          for (const rule of rules) {
            const len = rule.pattern.source.length;
            // Check the characters just before cursor
            const start = Math.max(0, toB - len);
            const segment = doc.slice(start, toB);
            const match = segment.match(rule.pattern);
            if (!match) continue;

            const matchStart = start + match.index!;
            const matchEnd = matchStart + match[0].length;

            if (isPositionInCode(doc, matchStart)) continue;

            const replacement =
              typeof rule.replace === "function" ? rule.replace(match) : rule.replace;

            // Schedule the replacement after the current transaction
            requestAnimationFrame(() => {
              // Re-verify the text is still there
              const currentDoc = update.view.state.doc.toString();
              if (currentDoc.slice(matchStart, matchEnd) === match[0]) {
                update.view.dispatch({
                  changes: { from: matchStart, to: matchEnd, insert: replacement },
                  selection: { anchor: matchStart + replacement.length },
                });
              }
            });
            return; // Only one rule per keystroke
          }
        });
      }
    }
  },
);
