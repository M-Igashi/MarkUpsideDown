import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Colors come from the CSS custom properties in styles.css
const bg = "var(--surface)";
const surface = "var(--chrome)";
const border = "var(--rule)";
const text = "var(--ink)";
const textMuted = "var(--ink-2)";
const accent = "var(--accent)";
const green = "var(--success)";
const red = "var(--error)";
const yellow = "#9a6f00";
const mauve = "#7b5ea7";

const theme = EditorView.theme(
  {
    "&": {
      color: text,
      backgroundColor: bg,
    },
    ".cm-content": {
      caretColor: accent,
      fontFamily: "var(--font-mono)",
      padding: "16px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: accent,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-soft)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(0, 0, 0, 0.03)",
    },
    ".cm-gutters": {
      backgroundColor: bg,
      color: "var(--ink-3)",
      border: "none",
      paddingRight: "8px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(0, 0, 0, 0.03)",
      color: textMuted,
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px",
      fontSize: "var(--fs-sm)",
    },
    ".cm-panels": {
      backgroundColor: surface,
      color: text,
      borderBottom: `1px solid ${border}`,
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: `1px solid ${border}`,
    },
    ".cm-search": {
      padding: "8px 12px",
      gap: "6px",
    },
    ".cm-search label": {
      color: textMuted,
      fontSize: "var(--fs-sm)",
    },
    ".cm-search input, .cm-search select": {
      backgroundColor: "var(--paper)",
      color: text,
      border: `1px solid ${border}`,
      borderRadius: "var(--r-sm)",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-search input:focus": {
      borderColor: accent,
    },
    ".cm-search button": {
      backgroundColor: border,
      color: text,
      border: "none",
      borderRadius: "var(--r-sm)",
      padding: "2px 10px",
      cursor: "pointer",
    },
    ".cm-search button:hover": {
      backgroundColor: "var(--rule-strong)",
    },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in srgb, var(--accent) 15%, transparent)",
      outline: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    },
  },
  { dark: false },
);

const highlighting = HighlightStyle.define([
  { tag: tags.heading, color: accent, fontWeight: "bold" },
  { tag: tags.heading1, fontSize: "1.4em" },
  { tag: tags.heading2, fontSize: "1.2em" },
  { tag: tags.emphasis, fontStyle: "italic", color: yellow },
  { tag: tags.strong, fontWeight: "bold", color: "#5a4a2c" },
  { tag: tags.link, color: accent, textDecoration: "underline" },
  { tag: tags.url, color: accent },
  { tag: tags.monospace, color: green },
  { tag: tags.quote, color: textMuted, fontStyle: "italic" },
  { tag: tags.keyword, color: mauve },
  { tag: tags.string, color: green },
  { tag: tags.number, color: yellow },
  { tag: tags.comment, color: textMuted },
  { tag: tags.meta, color: red },
  { tag: tags.processingInstruction, color: textMuted },
]);

export const editorTheme = [theme, syntaxHighlighting(highlighting)];
