import {
  findCodeBlockRanges,
  isInCodeBlock,
  isValidYamlLine,
  mapOutsideInlineCode,
} from "./document-structure.ts";
import { fixCjkEmphasisWith } from "./cjk-emphasis.ts";

/**
 * Post-conversion Markdown normalization.
 * Applied after AI.toMarkdown() / Browser Run output, before loading into editor.
 * Deterministic, fast, no AI involved.
 *
 * ## Escaping contract
 *
 * Each step escapes only what breaks its own syntax — no step re-escapes
 * what another already escaped (hierarchical escaping principle).
 *
 * | Step                  | Escapes         | Preserves              |
 * |-----------------------|-----------------|------------------------|
 * | stripMalformedFrontmatter | (none)      | all                    |
 * | fixHeadingHierarchy   | (none)          | all                    |
 * | removeEmptyLinks      | (none)          | all                    |
 * | normalizeListMarkers  | (none)          | all                    |
 * | reformatTables        | (none — input)  | `\|` in cells, `\\`   |
 * | fixCjkEmphasis        | (none)          | all                    |
 * | collapseWhitespace    | (none)          | all                    |
 *
 * `reformatTables` relies on `splitTableCells` to parse `\|` as escaped
 * pipe (not a delimiter). Cells after splitting never contain unescaped `|`.
 * The output preserves `\|` as-is, so no escaping step is needed.
 */
export function normalizeMarkdown(input: string): string {
  let text = input;
  text = stripMalformedFrontmatter(text);
  text = fixHeadingHierarchy(text);
  text = removeEmptyLinks(text);
  text = normalizeListMarkers(text);
  text = reformatTables(text);
  text = fixCjkEmphasis(text);
  text = collapseWhitespace(text);
  return text;
}

// --- Frontmatter cleanup ---

const MAX_FRONTMATTER_LINES = 30;

function stripMalformedFrontmatter(text: string): string {
  if (!/^---\r?\n/.test(text)) return text;

  const lines = text.split("\n");
  const close = lines
    .slice(0, MAX_FRONTMATTER_LINES + 2)
    .findIndex((line, i) => i > 0 && /^---[ \t\r]*$/.test(line));
  if (close < 0) return text;

  const body = lines.slice(1, close);
  const hasKey = body.some((line) => /^[\w.-]+\s*:/.test(line.trim()));
  if (!hasKey || body.every(isValidYamlLine)) return text;

  return lines
    .slice(close + 1)
    .join("\n")
    .replace(/^[\r\n]+/, "");
}

// --- Heading hierarchy fix ---

function fixHeadingHierarchy(text: string): string {
  const lines = text.split("\n");
  const headings: { idx: number; level: number; rest: string }[] = [];
  const codeRanges = findCodeBlockRanges(lines);

  for (let i = 0; i < lines.length; i++) {
    if (isInCodeBlock(i, codeRanges)) continue;
    const match = lines[i].match(/^(#{1,6})\s+(.*)/);
    if (match) {
      headings.push({ idx: i, level: match[1].length, rest: match[2] });
    }
  }

  if (headings.length < 2) return text;

  // Build a mapping to close gaps in the heading sequence
  const usedLevels = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b);

  // If no gaps, return as-is
  let hasGap = false;
  for (let i = 1; i < usedLevels.length; i++) {
    if (usedLevels[i] - usedLevels[i - 1] > 1) {
      hasGap = true;
      break;
    }
  }
  if (!hasGap) return text;

  // Map each used level to a compact level preserving relative depth
  const levelMap = new Map<number, number>();
  const minLevel = usedLevels[0];
  for (let i = 0; i < usedLevels.length; i++) {
    levelMap.set(usedLevels[i], minLevel + i);
  }

  for (const h of headings) {
    const newLevel = levelMap.get(h.level)!;
    if (newLevel !== h.level) {
      lines[h.idx] = "#".repeat(newLevel) + " " + h.rest;
    }
  }

  return lines.join("\n");
}

// --- Empty/broken link removal ---

function removeEmptyLinks(text: string): string {
  // [text]() or [text](#), but not images
  return mapProseLines(text, (line) =>
    mapOutsideInlineCode(line, (s) => s.replace(/(?<!!)\[([^\]]+)\]\(#?\)/g, "$1")),
  );
}

function mapProseLines(text: string, fn: (line: string) => string): string {
  const lines = text.split("\n");
  const codeRanges = findCodeBlockRanges(lines);
  return lines.map((line, i) => (isInCodeBlock(i, codeRanges) ? line : fn(line))).join("\n");
}

// --- List marker normalization ---

const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function normalizeListMarkers(text: string): string {
  const lines = text.split("\n");
  const codeRanges = findCodeBlockRanges(lines);
  const listMarker = (i: number) =>
    isInCodeBlock(i, codeRanges) || THEMATIC_BREAK_RE.test(lines[i])
      ? null
      : lines[i].match(/^(\s*)([-*+]) /);
  let i = 0;

  while (i < lines.length) {
    const match = listMarker(i);
    if (!match) {
      i++;
      continue;
    }

    // Found a list block — collect all consecutive list lines
    const firstMarker = match[2];
    const blockStart = i;
    i++;

    while (i < lines.length) {
      const cont = listMarker(i);
      if (cont) {
        i++;
      } else if (lines[i].trim() === "") {
        // Blank line might separate list items, peek ahead
        if (i + 1 < lines.length && listMarker(i + 1)) {
          i++;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    // Normalize markers in this block
    for (let j = blockStart; j < i; j++) {
      lines[j] = lines[j].replace(/^(\s*)([-*+]) /, `$1${firstMarker} `);
    }
  }

  return lines.join("\n");
}

// --- Table reformatting ---

/** Split a table row on unescaped `|` outside of inline code spans. */
export function splitTableCells(line: string): string[] {
  // Strip leading/trailing pipes
  let s = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");

  const cells: string[] = [];
  let current = "";
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    // Handle code spans with variable-length backtick delimiters (CommonMark spec)
    if (ch === "`") {
      let tickLen = 0;
      while (i + tickLen < s.length && s[i + tickLen] === "`") tickLen++;
      current += s.slice(i, i + tickLen);
      i += tickLen;
      // Scan for matching closing delimiter of the same length
      let closed = false;
      while (i < s.length) {
        if (s[i] === "`") {
          let closeLen = 0;
          while (i + closeLen < s.length && s[i + closeLen] === "`") closeLen++;
          current += s.slice(i, i + closeLen);
          i += closeLen;
          if (closeLen === tickLen) {
            closed = true;
            break;
          }
        } else {
          current += s[i];
          i++;
        }
      }
      if (!closed) continue; // unclosed code span — already consumed
    } else if (ch === "\\" && i + 1 < s.length && s[i + 1] === "|") {
      // Escaped pipe — keep as literal \|
      current += "\\|";
      i += 2;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Extract alignment from a separator cell (e.g. `:---:` → "center"). */
function cellAlignment(cell: string): "left" | "right" | "center" | "none" {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "none";
}

/** Build a separator cell with proper alignment markers for a given width. */
function formatSepCell(align: "left" | "right" | "center" | "none", width: number): string {
  switch (align) {
    case "left":
      return ":" + "-".repeat(width - 1);
    case "right":
      return "-".repeat(width - 1) + ":";
    case "center":
      return ":" + "-".repeat(width - 2) + ":";
    default:
      return "-".repeat(width);
  }
}

/** Display width of a cell: counts `\|` as 1 character (the rendered pipe). */
function displayWidth(cell: string): number {
  return cell.replace(/\\\|/g, "|").length;
}

function reformatTables(text: string): string {
  const lines = text.split("\n");
  const codeRanges = findCodeBlockRanges(lines);
  const isTableLine = (i: number) =>
    lines[i].trim().startsWith("|") && !isInCodeBlock(i, codeRanges);
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isTableLine(i)) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Collect table block
    const tableLines: string[] = [];
    while (i < lines.length && isTableLine(i)) {
      tableLines.push(lines[i]);
      i++;
    }

    if (tableLines.length < 2) {
      result.push(...tableLines);
      continue;
    }

    // Parse rows using pipe-aware splitting.
    // After splitting, cells never contain unescaped `|` (those became delimiters).
    // Escaped `\|` is preserved as-is and written through to output unchanged.
    const rows = tableLines.map((line) => splitTableCells(line));

    // Determine column count from header
    const colCount = rows[0].length;

    // Check if row 2 is a valid separator
    const isSeparator = (row: string[]) => row.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));

    const headerRow = rows[0];
    let sepRow: string[];
    let dataRows: string[][];
    let alignments: ReturnType<typeof cellAlignment>[];

    if (rows.length > 1 && isSeparator(rows[1])) {
      sepRow = rows[1];
      alignments = sepRow.map((cell) => cellAlignment(cell));
      dataRows = rows.slice(2);
    } else {
      // Missing separator — generate one
      sepRow = Array(colCount).fill("---");
      alignments = Array(colCount).fill("none" as const);
      dataRows = rows.slice(1);
    }

    // Malformed tables (multi-line cells, extra columns) pass through unmodified
    const hasMalformedRows = dataRows.some(
      (row) => row.length > colCount || colCount - row.length > 1,
    );
    if (hasMalformedRows) {
      result.push(...tableLines);
      continue;
    }

    // Normalize column counts
    const allRows = [headerRow, sepRow, ...dataRows];
    for (const row of allRows) {
      while (row.length < colCount) row.push("");
    }
    while (alignments.length < colCount) alignments.push("none");
    if (alignments.length > colCount) alignments.length = colCount;

    // Calculate column widths (min 3 for separator dashes, max 40 per column)
    const MAX_COL_WIDTH = 40;
    const widths = Array(colCount).fill(3);
    for (const row of allRows) {
      for (let c = 0; c < colCount; c++) {
        widths[c] = Math.max(widths[c], displayWidth(row[c]));
      }
    }
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.min(widths[c], MAX_COL_WIDTH);
    }

    // Format rows (display-width-aware padding for escaped pipes)
    const formatRow = (row: string[], isSep: boolean) => {
      const cells = row.map((cell, c) => {
        if (isSep) return formatSepCell(alignments[c], widths[c]);
        const padAmount = widths[c] - displayWidth(cell) + cell.length;
        return cell.padEnd(padAmount);
      });
      return "| " + cells.join(" | ") + " |";
    };

    result.push(formatRow(allRows[0], false));
    result.push(formatRow(allRows[1], true));
    for (let r = 2; r < allRows.length; r++) {
      result.push(formatRow(allRows[r], false));
    }
  }

  return result.join("\n");
}

function fixCjkEmphasis(text: string): string {
  return fixCjkEmphasisWith(text, " ");
}

// --- Whitespace collapse ---

function collapseWhitespace(text: string): string {
  const lines = text.split("\n");
  const codeRanges = findCodeBlockRanges(lines);
  const result: string[] = [];
  let blankRun = 0;

  for (let i = 0; i < lines.length; i++) {
    if (isInCodeBlock(i, codeRanges)) {
      result.push(lines[i]);
      blankRun = 0;
      continue;
    }
    const line = trimTrailing(lines[i], (lines[i + 1] ?? "").trim() !== "");
    // Collapse 3+ blank lines to 2
    blankRun = line === "" ? blankRun + 1 : 0;
    if (blankRun <= 2) result.push(line);
  }

  return result.join("\n").replace(/^\n+/, "").trimEnd() + "\n";
}

/** Trim trailing spaces and tabs, keeping a two-space hard break before a non-blank line. */
function trimTrailing(line: string, keepHardBreak: boolean): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  if (end === line.length || end === 0) return line.slice(0, end);
  return line.slice(0, end) + (keepHardBreak && line.endsWith("  ") ? "  " : "");
}
