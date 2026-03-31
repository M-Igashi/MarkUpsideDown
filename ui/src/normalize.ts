import { isValidYamlLine } from "./document-structure.ts";

/**
 * Post-conversion Markdown normalization.
 * Applied after AI.toMarkdown() / Browser Rendering output, before loading into editor.
 * Deterministic, fast, no AI involved.
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

function stripMalformedFrontmatter(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;

  const endIdx = text.indexOf("\n---", 3);
  if (endIdx === -1) return text;

  const fmBody = text.slice(4, endIdx);
  const lines = fmBody.split("\n");

  const valid = lines.every(isValidYamlLine);

  if (valid) return text;

  // Strip malformed frontmatter
  const afterFm = text.slice(endIdx + 4); // skip \n---
  return afterFm.replace(/^\n+/, "");
}

// --- Heading hierarchy fix ---

function fixHeadingHierarchy(text: string): string {
  const lines = text.split("\n");
  const headings: { idx: number; level: number; rest: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
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
  // [text]() or [text](#)
  return text.replace(/\[([^\]]+)\]\(#?\)/g, "$1");
}

// --- List marker normalization ---

function normalizeListMarkers(text: string): string {
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const match = lines[i].match(/^(\s*)([-*+]) /);
    if (!match) {
      i++;
      continue;
    }

    // Found a list block — collect all consecutive list lines
    const firstMarker = match[2];
    const blockStart = i;
    i++;

    while (i < lines.length) {
      const cont = lines[i].match(/^(\s*)([-*+]) /);
      if (cont) {
        i++;
      } else if (lines[i].trim() === "") {
        // Blank line might separate list items, peek ahead
        if (i + 1 < lines.length && /^\s*[-*+] /.test(lines[i + 1])) {
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
function splitTableCells(line: string): string[] {
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
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim().startsWith("|")) {
      result.push(lines[i]);
      i++;
      continue;
    }

    // Collect table block
    const tableLines: string[] = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      tableLines.push(lines[i]);
      i++;
    }

    if (tableLines.length < 2) {
      result.push(...tableLines);
      continue;
    }

    // Parse rows using pipe-aware splitting
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

    // Detect malformed tables (e.g. multi-line cells) — pass through unmodified
    const hasMalformedRows = dataRows.some((row) => Math.abs(row.length - colCount) > 1);
    if (hasMalformedRows) {
      result.push(...tableLines);
      continue;
    }

    // Normalize column counts
    const allRows = [headerRow, sepRow, ...dataRows];
    for (const row of allRows) {
      while (row.length < colCount) row.push("");
      if (row.length > colCount) row.length = colCount;
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

// --- CJK emphasis fix ---
// CommonMark delimiter-flanking rules treat CJK characters as "letters",
// causing emphasis markers adjacent to CJK text to fail parsing.
// Reference: https://zenn.dev/miyabitti/articles/594fdb7373a3a8
//
// Two failure modes:
//   1. Inner spaces: "** text **" — never parsed as emphasis
//   2. CJK adjacency: "は**「重要」**です" — flanking delimiter check fails
//      when letter precedes opening ** + content starts with punctuation,
//      or content ends with punctuation + letter follows closing **.
//
// Fix: strip inner spaces, insert half-width spaces at CJK boundaries.
// Handles **, *, __, _ for portable Markdown that renders everywhere.

const CJK_EMPHASIS_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

function spaceCjkEmphasis(line: string, re: RegExp, marker: string): string {
  return line.replace(re, (m, content, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : "";
    const afterPos = offset + m.length;
    const after = afterPos < str.length ? str[afterPos] : "";
    const pre = before && CJK_EMPHASIS_RE.test(before) ? " " : "";
    const post = after && CJK_EMPHASIS_RE.test(after) ? " " : "";
    return `${pre}${marker}${content}${marker}${post}`;
  });
}

function fixCjkEmphasis(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^(`{3,}|~{3,})/.test(line.trimStart())) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      // 1. Strip inner spaces: "** text **" → "**text**", "* text *" → "*text*"
      line = line.replace(/\*\*\s+((?:[^*]|\*(?!\*))+?)\s+\*\*/g, "**$1**");
      line = line.replace(/__\s+((?:[^_]|_(?!_))+?)\s+__/g, "__$1__");

      // 2. Insert spaces at CJK boundaries (longer markers first to avoid conflicts)
      line = spaceCjkEmphasis(line, /\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "**");
      line = spaceCjkEmphasis(line, /(?<!\*)\*((?:[^*\n])+?)\*(?!\*)/g, "*");
      line = spaceCjkEmphasis(line, /__((?:[^_]|_(?!_))+?)__/g, "__");
      line = spaceCjkEmphasis(line, /(?<!_)_((?:[^_\n])+?)_(?!_)/g, "_");

      return line;
    })
    .join("\n");
}

// --- Whitespace collapse ---

function collapseWhitespace(text: string): string {
  // Trim trailing whitespace on each line
  let result = text.replace(/[ \t]+$/gm, "");
  // Collapse 3+ blank lines to 2
  result = result.replace(/\n{4,}/g, "\n\n\n");
  // Trim leading/trailing whitespace of the whole document
  result = result.trim() + "\n";
  return result;
}
