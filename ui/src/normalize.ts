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

  // Simple YAML validation: each non-empty line should be key: value, - item, or comment
  const valid = lines.every((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return true;
    if (trimmed.startsWith("#")) return true;
    if (trimmed.startsWith("- ")) return true;
    if (/^[\w.-]+\s*:/.test(trimmed)) return true;
    return false;
  });

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
  for (const level of usedLevels) {
    // Find rank (0-based) and add minLevel
    const rank = usedLevels.indexOf(level);
    levelMap.set(level, minLevel + rank);
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

    // Parse rows
    const rows = tableLines.map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );

    // Determine column count from header
    const colCount = rows[0].length;

    // Check if row 2 is a valid separator
    const isSeparator = (row: string[]) => row.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));

    let headerRow = rows[0];
    let sepRow: string[];
    let dataRows: string[][];

    if (rows.length > 1 && isSeparator(rows[1])) {
      sepRow = rows[1];
      dataRows = rows.slice(2);
    } else {
      // Missing separator — generate one
      sepRow = Array(colCount).fill("---");
      dataRows = rows.slice(1);
    }

    // Normalize column counts
    const allRows = [headerRow, sepRow, ...dataRows];
    for (const row of allRows) {
      while (row.length < colCount) row.push("");
      if (row.length > colCount) row.length = colCount;
    }

    // Calculate column widths
    const widths = Array(colCount).fill(3); // min width for ---
    for (const row of allRows) {
      for (let c = 0; c < colCount; c++) {
        widths[c] = Math.max(widths[c], row[c].length);
      }
    }

    // Format rows
    const formatRow = (row: string[], isSep: boolean) => {
      const cells = row.map((cell, c) => (isSep ? "-".repeat(widths[c]) : cell.padEnd(widths[c])));
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
