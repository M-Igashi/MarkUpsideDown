import { linter, type Diagnostic } from "@codemirror/lint";
import { marked } from "marked";
import { getDocumentStructure, type DocumentStructure } from "./document-structure.ts";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import { KEY_LINT_ENABLED } from "./storage-keys.ts";

const { invoke } = window.__TAURI__.core;

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

export interface LintDiagnostic {
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export function getLintDiagnostics(text: string): LintDiagnostic[] {
  const lines = text.split("\n");
  const structure = getDocumentStructure(text);

  // Build line offset table for byte offset → line number conversion
  const lineStarts: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(lineStarts[i] + lines[i].length + 1);
  }

  const doc = {
    line: (n: number) => ({
      from: lineStarts[n - 1] ?? 0,
      to: (lineStarts[n - 1] ?? 0) + (lines[n - 1]?.length ?? 0),
    }),
  };

  const diagnostics: Diagnostic[] = [];

  checkHeadings(structure, doc, diagnostics);
  checkLinks(structure, doc, diagnostics);
  checkTables(structure, doc, diagnostics);
  checkFrontmatter(structure, doc, diagnostics);
  checkLists(structure, doc, diagnostics);
  checkEmphasis(lines, doc, diagnostics);
  checkCodeBlocks(lines, doc, diagnostics);
  checkFootnotes(lines, doc, diagnostics);
  checkHtmlComments(lines, doc, diagnostics);
  checkBlankLines(lines, doc, diagnostics, structure);

  function offsetToLine(offset: number): number {
    for (let i = 0; i < lineStarts.length - 1; i++) {
      if (offset < lineStarts[i + 1]) return i + 1;
    }
    return lines.length;
  }

  return diagnostics.map((d) => ({
    line: offsetToLine(d.from),
    severity: d.severity as LintDiagnostic["severity"],
    message: d.message,
  }));
}

interface ComrakDiagnostic {
  line: number;
  severity: "info";
  message: string;
}

export const markdownLinter = linter(
  async (view) => {
    if (!isLintEnabled()) return [];

    const doc = view.state.doc;
    const text = doc.toString();
    const lines = text.split("\n");
    const structure = getDocumentStructure(text);

    const diagnostics: Diagnostic[] = [];

    checkHeadings(structure, doc, diagnostics);
    checkLinks(structure, doc, diagnostics);
    checkTables(structure, doc, diagnostics);
    checkFrontmatter(structure, doc, diagnostics);
    checkLists(structure, doc, diagnostics);
    checkEmphasis(lines, doc, diagnostics);
    checkCodeBlocks(lines, doc, diagnostics);
    checkFootnotes(lines, doc, diagnostics);
    checkHtmlComments(lines, doc, diagnostics);
    checkBlankLines(lines, doc, diagnostics, structure);

    // comrak-based CommonMark validation (block structure checks)
    try {
      const comrakDiags = await invoke<ComrakDiagnostic[]>("validate_markdown", { content: text });
      for (const d of comrakDiags) {
        if (d.line < 1 || d.line > doc.lines) continue;
        const line = doc.line(d.line);
        diagnostics.push({
          from: line.from,
          to: line.to,
          severity: d.severity,
          message: `[comrak] ${d.message}`,
        });
      }
    } catch {
      // Silently ignore — TS-based linting still works without comrak
    }

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
  lines: string[],
  doc: { line: (n: number) => { from: number; to: number; text: string } },
  diagnostics: Diagnostic[],
) {
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

// --- Code block language specifier check (#132) ---

function checkCodeBlocks(
  lines: string[],
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  let inFence = false;
  let fenceChar = "";

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)?$/);
    if (!fenceMatch) continue;

    const char = fenceMatch[1][0];

    if (!inFence) {
      inFence = true;
      fenceChar = char;
      const lang = (fenceMatch[2] || "").trim();
      if (!lang) {
        const lineObj = doc.line(i + 1);
        diagnostics.push({
          from: lineObj.from,
          to: lineObj.to,
          severity: "info",
          message:
            "Code block without language specifier — consider adding a language for syntax highlighting",
        });
      }
    } else if (char === fenceChar) {
      inFence = false;
      fenceChar = "";
    }
  }
}

// --- Footnote reference/definition mismatch check (#133) ---

function checkFootnotes(
  lines: string[],
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  let inFence = false;

  const refs = new Map<string, { line: number; col: number }[]>();
  const defs = new Map<string, { line: number; col: number }>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(`{3,}|~{3,})/.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Mask inline code
    const noCode = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));

    // Definitions: [^id]: ... (at start of line)
    const defMatch = noCode.match(/^\[\^([^\]]+)\]:\s/);
    if (defMatch) {
      defs.set(defMatch[1], { line: i + 1, col: 0 });
      continue;
    }

    // References: [^id] (inline)
    let m;
    const refRe = /\[\^([^\]]+)\](?!:)/g;
    while ((m = refRe.exec(noCode)) !== null) {
      const id = m[1];
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id)!.push({ line: i + 1, col: m.index });
    }
  }

  // Referenced but not defined → warning
  for (const [id, positions] of refs) {
    if (!defs.has(id)) {
      for (const pos of positions) {
        const lineObj = doc.line(pos.line);
        diagnostics.push({
          from: lineObj.from + pos.col,
          to: lineObj.from + pos.col + `[^${id}]`.length,
          severity: "warning",
          message: `Footnote [^${id}] referenced but not defined`,
        });
      }
    }
  }

  // Defined but not referenced → info
  for (const [id, pos] of defs) {
    if (!refs.has(id)) {
      const lineObj = doc.line(pos.line);
      diagnostics.push({
        from: lineObj.from,
        to: lineObj.from + `[^${id}]:`.length,
        severity: "info",
        message: `Footnote [^${id}] defined but never referenced`,
      });
    }
  }
}

// --- HTML comment TODO/FIXME/HACK check (#134) ---

const COMMENT_KEYWORDS = /\b(TODO|FIXME|HACK|XXX|BUG|NOTE)\b/i;

function checkHtmlComments(
  lines: string[],
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(`{3,}|~{3,})/.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Single-line comments: <!-- ... -->
    const commentRe = /<!--([\s\S]*?)-->/g;
    let m;
    while ((m = commentRe.exec(line)) !== null) {
      const content = m[1];
      const kwMatch = content.match(COMMENT_KEYWORDS);
      if (kwMatch) {
        const lineObj = doc.line(i + 1);
        diagnostics.push({
          from: lineObj.from + m.index,
          to: lineObj.from + m.index + m[0].length,
          severity: "info",
          message: `HTML comment contains ${kwMatch[1].toUpperCase()} — consider resolving before publishing`,
        });
      }
    }
  }
}

// --- Block element blank line separation check (#135) ---

function checkBlankLines(
  lines: string[],
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
  structure: DocumentStructure,
) {
  let inFence = false;

  // Determine frontmatter end line (0-based index)
  const fmEndIdx = structure.frontmatter ? structure.frontmatter.endLine - 1 : -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Track fenced code blocks
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      if (!inFence) {
        // Opening fence — check blank line before it
        checkNeedsBlankBefore(i, lines, fmEndIdx, "Fenced code block", doc, diagnostics);
        inFence = true;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    // Standalone image (full-line image only)
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) {
      checkNeedsBlankBefore(i, lines, fmEndIdx, "Image", doc, diagnostics);
      continue;
    }

    // Table start (first | line not preceded by another | line)
    if (trimmed.startsWith("|") && (i === 0 || !lines[i - 1].trimStart().startsWith("|"))) {
      checkNeedsBlankBefore(i, lines, fmEndIdx, "Table", doc, diagnostics);
      continue;
    }

    // Blockquote start (first > line not preceded by another > line)
    if (trimmed.startsWith(">") && (i === 0 || !lines[i - 1].trimStart().startsWith(">"))) {
      checkNeedsBlankBefore(i, lines, fmEndIdx, "Blockquote", doc, diagnostics);
      continue;
    }

    // Math block
    if (trimmed.startsWith("$$")) {
      checkNeedsBlankBefore(i, lines, fmEndIdx, "Math block", doc, diagnostics);
      continue;
    }

    // Horizontal rule
    if (/^([-_*])\1{2,}\s*$/.test(trimmed) && trimmed !== "---") {
      checkNeedsBlankBefore(i, lines, fmEndIdx, "Horizontal rule", doc, diagnostics);
    }
  }
}

function checkNeedsBlankBefore(
  i: number,
  lines: string[],
  fmEndIdx: number,
  label: string,
  doc: { line: (n: number) => { from: number; to: number } },
  diagnostics: Diagnostic[],
) {
  if (i === 0) return;
  // Skip if previous line is frontmatter closing ---
  if (i - 1 === fmEndIdx) return;
  const prev = lines[i - 1];
  if (prev.trim() === "") return;
  // Skip if previous line is a heading (headings naturally separate)
  if (/^#{1,6}\s/.test(prev.trimStart())) return;

  const lineObj = doc.line(i + 1);
  diagnostics.push({
    from: lineObj.from,
    to: lineObj.to,
    severity: "info",
    message: `${label} not separated by blank line above — add a blank line for consistent rendering`,
  });
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
