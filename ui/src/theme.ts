import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// The editor is the manuscript sheet next to the preview's printed page.
// Colors come from the CSS custom properties in styles.css.

const theme = EditorView.theme(
  {
    "&": {
      color: "var(--ink)",
      backgroundColor: "var(--paper)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.7",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      boxSizing: "border-box",
      maxWidth: "calc(46rem + 64px)",
      margin: "0 auto",
      padding: "28px 32px 64px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(60, 50, 30, 0.025)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--paper)",
      color: "var(--ink-3)",
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--ink-2)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 12px",
      fontSize: "var(--fs-sm)",
    },
    ".cm-panels": {
      backgroundColor: "var(--surface)",
      color: "var(--ink)",
      fontFamily: "var(--font-sans)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--rule)",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid var(--rule)",
    },
    ".cm-search": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      padding: "6px 12px",
      gap: "6px",
      fontSize: "var(--fs-sm)",
    },
    ".cm-search br": {
      display: "none",
    },
    ".cm-search label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      color: "var(--ink-2)",
      fontSize: "var(--fs-sm)",
    },
    ".cm-search input[type=checkbox]": {
      accentColor: "var(--accent)",
    },
    ".cm-textfield": {
      height: "24px",
      padding: "0 6px",
      fontSize: "var(--fs-sm)",
      backgroundColor: "var(--paper)",
      color: "var(--ink)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-sm)",
      outline: "none",
    },
    ".cm-textfield:focus": {
      borderColor: "var(--accent)",
      boxShadow: "0 0 0 3px var(--accent-ring)",
    },
    ".cm-button": {
      height: "24px",
      padding: "0 8px",
      fontSize: "var(--fs-sm)",
      backgroundImage: "none",
      backgroundColor: "var(--paper)",
      color: "var(--ink)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-sm)",
      cursor: "pointer",
    },
    ".cm-button:hover": {
      borderColor: "var(--rule-strong)",
    },
    ".cm-search [name=close]": {
      marginLeft: "auto",
      fontSize: "16px",
      color: "var(--ink-2)",
      cursor: "pointer",
    },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in srgb, var(--accent) 15%, transparent)",
      outline: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
    },
    ".cm-placeholder": {
      color: "var(--ink-3)",
      fontFamily: "var(--font-sans)",
    },
  },
  { dark: false },
);

// Ink on paper: structure through weight and size, Markdown syntax marks
// recede, color is kept for links and code.
const codeInk = "#3d6b47";
const highlighting = HighlightStyle.define([
  { tag: tags.heading, color: "var(--ink)", fontWeight: "bold" },
  { tag: tags.heading1, fontSize: "1.4em" },
  { tag: tags.heading2, fontSize: "1.2em" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--ink-2)" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--ink-3)" },
  { tag: tags.monospace, color: codeInk },
  { tag: tags.quote, color: "var(--ink-2)" },
  { tag: tags.processingInstruction, color: "var(--ink-3)" },
  { tag: tags.labelName, color: "var(--ink-3)" },
  { tag: tags.keyword, color: "#6b4f9a" },
  { tag: tags.string, color: codeInk },
  { tag: tags.number, color: "#9a5a12" },
  { tag: tags.comment, color: "var(--ink-3)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--ink-3)" },
]);

export const editorTheme = [theme, syntaxHighlighting(highlighting)];
