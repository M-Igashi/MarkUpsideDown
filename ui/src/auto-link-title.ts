// Auto Link Title: when a bare URL is pasted, fetch the page title
// and replace it with [Title](url) format.

import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import { isPositionInCode } from "./document-structure.ts";

const { invoke } = window.__TAURI__.core;

const URL_REGEX = /^https?:\/\/[^\s]+$/;

export const autoLinkTitle = ViewPlugin.fromClass(
  class {
    pending: { from: number; to: number; url: string } | null = null;

    update(update: ViewUpdate) {
      if (!update.docChanged) return;

      // Detect paste: a single insertion that looks like a URL
      update.transactions.forEach((tr) => {
        if (!tr.isUserEvent("input.paste")) return;

        tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
          const inserted = update.state.doc.sliceString(fromB, toB);
          if (URL_REGEX.test(inserted.trim())) {
            const url = inserted.trim();
            // Don't auto-link inside code blocks
            if (isPositionInCode(update.state.doc.toString(), fromB)) return;
            // Don't auto-link if already inside a markdown link
            const before = update.state.doc.sliceString(Math.max(0, fromB - 2), fromB);
            if (before.endsWith("](") || before.endsWith("![")) return;

            this.pending = { from: fromB, to: toB, url };
          }
        });
      });

      if (this.pending) {
        const { from, to, url } = this.pending;
        this.pending = null;
        this.fetchAndReplace(update.view, from, to, url);
      }
    }

    async fetchAndReplace(view: EditorView, from: number, to: number, url: string) {
      try {
        const title = await invoke<string>("fetch_page_title", { url });
        // Verify the URL is still at the expected position (user may have edited)
        const current = view.state.doc.sliceString(from, to);
        if (current.trim() !== url) return;

        const link = `[${title}](${url})`;
        view.dispatch({
          changes: { from, to, insert: link },
          // Put cursor after the link
          selection: { anchor: from + link.length },
        });
      } catch {
        // Failed to fetch title — leave the bare URL as-is
      }
    }
  },
);
