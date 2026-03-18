import { linter, type Diagnostic } from "@codemirror/lint";
import { getDocumentStructure, type DocumentStructure } from "./document-structure.ts";

/**
 * CodeMirror 6 lint extension for Markdown structural issues.
 * Uses the shared document-structure parser for analysis.
 */

const STORAGE_KEY_LINT = "markupsidedown:lintEnabled";

export function isLintEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY_LINT) !== "0";
}

export function setLintEnabled(enabled: boolean) {
  localStorage.setItem(STORAGE_KEY_LINT, enabled ? "1" : "0");
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

    return diagnostics;
  },
  { delay: 500 },
);

// --- Heading checks ---

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

// --- Link checks ---

function checkLinks(
  structure: DocumentStructure,
  doc: { line: (n: number) => { from: number; to: number; text: string } },
  diagnostics: Diagnostic[],
) {
  const linkPattern = /\[([^\]]*)\]\(([^)]*)\)/g;

  for (const link of structure.links) {
    const lineObj = doc.line(link.line);

    // Find the exact position of this link in the line
    linkPattern.lastIndex = 0;
    let match;
    while ((match = linkPattern.exec(lineObj.text)) !== null) {
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

// --- Table checks ---

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

// --- Frontmatter checks ---

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

// --- List checks ---

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
