import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const bg = "#f5f1eb";
const surface = "#ece8e2";
const border = "#d4cfc6";
const text = "#2c2c2c";
const textMuted = "#8a8578";
const accent = "#4a7ab5";
const green = "#2e7d32";
const red = "#b33a3a";
const yellow = "#b8860b";
const mauve = "#7b5ea7";

const theme = EditorView.theme(
  {
    "&": {
      color: text,
      backgroundColor: bg,
    },
    ".cm-content": {
      caretColor: accent,
      fontFamily: '"SF Mono", "Fira Code", "JetBrains Mono", monospace',
      padding: "16px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: accent,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(74, 122, 181, 0.18)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(0, 0, 0, 0.03)",
    },
    ".cm-gutters": {
      backgroundColor: bg,
      color: "#b0a99e",
      border: "none",
      paddingRight: "8px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(0, 0, 0, 0.03)",
      color: textMuted,
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px",
      fontSize: "12px",
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
      fontSize: "12px",
    },
    ".cm-search input, .cm-search select": {
      backgroundColor: "#faf7f2",
      color: text,
      border: `1px solid ${border}`,
      borderRadius: "4px",
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
      borderRadius: "4px",
      padding: "2px 10px",
      cursor: "pointer",
    },
    ".cm-search button:hover": {
      backgroundColor: "#c4bfb6",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(74, 122, 181, 0.15)",
      outline: `1px solid rgba(74, 122, 181, 0.3)`,
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "rgba(74, 122, 181, 0.3)",
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
