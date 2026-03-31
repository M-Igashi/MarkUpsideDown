import { linter, type Diagnostic } from "@codemirror/lint";
import { marked } from "marked";
import { getDocumentStructure, type DocumentStructure } from "./document-structure.ts";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import { KEY_LINT_ENABLED } from "./storage-keys.ts";

/**
 * CodeMirror 6 lint extension for Markdown structural issues.
 * Uses the shared document-structure parser for analysis.
 */

export function isLintEnabled(): boolean {
  return getStorageBool(KEY_LINT_ENABLED);
}

export function setLintEnabled(enabled: boolean) {
  setStorageBool(KEY_LINT_ENABLED, enabled);
}

export const markdownLinter = linter(
  (view) => {
    if (!isLintEnabled()) return [];

    const doc = view.state.doc;
    const text = doc.toString();
    const structure = getDocumentStructure(text);

    const diagnostics: Diagnostic[] = [];

    checkHeadings(structure, doc, diagnostics);
    checkLinks(structure, doc, diagnostics);
    checkTables(structure, doc, diagnostics);
    checkFrontmatter(structure, doc, diagnostics);
    checkLists(structure, doc, diagnostics);
    checkEmphasis(text, doc, diagnostics);

    return diagnostics;
  },
  { delay: 500 },
);

function checkHeadings(
  structure: DocumentStructure,
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  const { headings } = structure;
  if (headings.length === 0) return;

  // Multiple h1
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length > 1) {
    for (let i = 1; i < h1s.length; i++) {
      const line = doc.line(h1s[i].line);
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: "warning",
        message: "Multiple h1 headings — consider using a single h1 per document",
      });
    }
  }

  // Heading level skip
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1].level;
    const curr = headings[i].level;
    if (curr > prev + 1) {
      const line = doc.line(headings[i].line);
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: "warning",
        message: `Heading level skip: h${prev} → h${curr} (missing h${prev + 1})`,
      });
    }
  }
}

const LINK_PATTERN = /\[([^\]]*)\]\(([^)]*)\)/g;

function checkLinks(
  structure: DocumentStructure,
  doc: { line: (n: number) => { from: number; to: number; text: string } },
  diagnostics: Diagnostic[],
) {
  for (const link of structure.links) {
    const lineObj = doc.line(link.line);

    // Find the exact position of this link in the line
    LINK_PATTERN.lastIndex = 0;
    let match;
    while ((match = LINK_PATTERN.exec(lineObj.text)) !== null) {
      if (match[1] === link.text && match[2].trim() === link.target) {
        const from = lineObj.from + match.index;
        const to = from + match[0].length;

        // Empty link
        if (link.target === "" || link.target === "#") {
          diagnostics.push({ from, to, severity: "warning", message: "Empty link target" });
          break;
        }

        // Broken internal anchor
        if (link.type === "internal" && link.valid === false) {
          diagnostics.push({
            from,
            to,
            severity: "info",
            message: `Internal anchor "${link.target}" does not match any heading`,
          });
          break;
        }
        break;
      }
    }
  }
}

function checkTables(
  structure: DocumentStructure,
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  for (const table of structure.tables) {
    if (!table.hasSeparator) {
      const line = doc.line(table.startLine + 1);
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: "warning",
        message: "Table missing separator row (expected | --- | --- | ...)",
      });
    }

    if (table.columnMismatch) {
      // Report on the table header line
      const line = doc.line(table.startLine);
      diagnostics.push({
        from: line.from,
        to: line.to,
        severity: "warning",
        message: "Table has rows with mismatched column counts",
      });
    }
  }
}

function checkFrontmatter(
  structure: DocumentStructure,
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  if (!structure.frontmatter) return;

  if (!structure.frontmatter.valid) {
    const line = doc.line(structure.frontmatter.startLine);
    diagnostics.push({
      from: line.from,
      to: doc.line(structure.frontmatter.endLine).to,
      severity: "warning",
      message: "Frontmatter contains invalid YAML syntax",
    });
  }
}

function checkLists(
  structure: DocumentStructure,
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  for (const list of structure.lists) {
    // Check for inconsistent indentation within nested list
    // Only flag if there are nested items with irregular indent steps
    const indentLevels = [...new Set(list.items.map((it) => it.indent))].sort((a, b) => a - b);
    if (indentLevels.length < 2) continue;

    // Determine the standard indent step (difference between first two levels)
    const step = indentLevels[1] - indentLevels[0];
    if (step === 0) continue;

    for (let i = 2; i < indentLevels.length; i++) {
      const expectedStep = indentLevels[i] - indentLevels[i - 1];
      if (expectedStep !== step) {
        // Find the first item at this irregular indent
        const item = list.items.find((it) => it.indent === indentLevels[i]);
        if (item) {
          const line = doc.line(item.line);
          diagnostics.push({
            from: line.from,
            to: line.to,
            severity: "info",
            message: `Inconsistent list indentation: expected ${step}-space steps, got ${expectedStep}-space step`,
          });
        }
        break; // one diagnostic per list block
      }
    }
  }
}

// --- Emphasis / flanking delimiter check ---
// Detect emphasis markers that fail CommonMark flanking delimiter rules.
// Uses marked.parseInline() as the authoritative parser: if markers remain
// as literal text after parsing, the emphasis is broken.
// Reference: https://zenn.dev/miyabitti/articles/594fdb7373a3a8

function checkEmphasis(
  text: string,
  doc: { line: (n: number) => { from: number; to: number; text: string } },
  diagnostics: Diagnostic[],
) {
  const lines = text.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(`{3,}|~{3,})/.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!/[*_]/.test(line)) continue;

    const lineObj = doc.line(i + 1);

    // Mask inline code spans so they don't trigger false positives
    const noCode = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));

    checkEmphasisPattern(
      noCode,
      /\*\*((?:[^*]|\*(?!\*))+?)\*\*/g,
      "**",
      "strong",
      line,
      lineObj,
      diagnostics,
    );
    checkEmphasisPattern(
      noCode,
      /(?<!\*)\*((?:[^*\n])+?)\*(?!\*)/g,
      "*",
      "em",
      line,
      lineObj,
      diagnostics,
    );
    checkEmphasisPattern(
      noCode,
      /__((?:[^_]|_(?!_))+?)__/g,
      "__",
      "strong",
      line,
      lineObj,
      diagnostics,
    );
    checkEmphasisPattern(
      noCode,
      /(?<!_)_((?:[^_\n])+?)_(?!_)/g,
      "_",
      "em",
      line,
      lineObj,
      diagnostics,
    );
  }
}

function checkEmphasisPattern(
  masked: string,
  re: RegExp,
  marker: string,
  htmlTag: string,
  originalLine: string,
  lineObj: { from: number; to: number },
  diagnostics: Diagnostic[],
) {
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Build a minimal context string: one char before + match + one char after
    const before = m.index > 0 ? originalLine[m.index - 1] : " ";
    const afterIdx = m.index + m[0].length;
    const after = afterIdx < originalLine.length ? originalLine[afterIdx] : " ";
    const context = before + m[0] + after;

    const html = marked.parseInline(context);
    if (html.includes(`<${htmlTag}>`)) continue;

    // Emphasis failed to parse — determine the reason for a helpful message
    const content = m[1];
    const isBold = marker.length === 2;
    const name = isBold ? "Bold" : "Italic";
    const innerSpace = content.startsWith(" ") || content.endsWith(" ");

    let message: string;
    if (innerSpace) {
      message = `${name} not rendered — spaces inside ${marker}...${marker} prevent parsing. Remove inner spaces.`;
    } else {
      message = `${name} not rendered — CommonMark flanking delimiter failure. Add spaces: " ${marker}text${marker} "`;
    }

    diagnostics.push({
      from: lineObj.from + m.index,
      to: lineObj.from + m.index + m[0].length,
      severity: "warning",
      message,
    });
  }
}
