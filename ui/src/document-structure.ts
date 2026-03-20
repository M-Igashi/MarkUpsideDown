/**
 * Shared document structure parser.
 * Used by markdown-lint.ts (diagnostics) and MCP bridge (get_document_structure).
 */

export function isPositionInCode(doc: string, pos: number): boolean {
  const before = doc.slice(0, pos);

  // Inside fenced code block?
  const fences = before.split("```").length - 1;
  if (fences % 2 === 1) return true;

  // Inside inline code? Count backticks on the current line
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const backticks = line.split("`").length - 1;
  return backticks % 2 === 1;
}

export interface Heading {
  level: number;
  text: string;
  line: number; // 1-based
}

export interface Link {
  text: string;
  target: string;
  line: number; // 1-based
  type: "external" | "internal" | "other";
  valid?: boolean; // only set for internal links
}

export interface TableInfo {
  startLine: number; // 1-based
  endLine: number; // 1-based
  columns: number;
  hasSeparator: boolean;
  columnMismatch: boolean;
}

export interface FrontmatterInfo {
  raw: string;
  parsed: Record<string, string> | null;
  valid: boolean;
  startLine: number; // 1-based
  endLine: number; // 1-based
}

export interface ListBlock {
  startLine: number; // 1-based
  endLine: number; // 1-based
  items: { line: number; indent: number; marker: string }[];
}

export interface DocumentStats {
  wordCount: number;
  headingCount: number;
  linkCount: number;
  codeBlockCount: number;
  tableCount: number;
}

export interface DocumentStructure {
  headings: Heading[];
  links: Link[];
  tables: TableInfo[];
  lists: ListBlock[];
  frontmatter: FrontmatterInfo | null;
  stats: DocumentStats;
  anchors: Set<string>;
}

/** Check if a line is valid simple YAML (key: value, list item, comment, or empty). */
export function isValidYamlLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("- ")) return true;
  if (/^[\w.-]+\s*:/.test(trimmed)) return true;
  return false;
}

/** Generate a GitHub-style anchor from heading text. */
export function headingToAnchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** Identify fenced code block line ranges (0-based indices). */
function findCodeBlockRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("```")) {
      const start = i;
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) i++;
      ranges.push([start, i]);
      i++;
    } else {
      i++;
    }
  }
  return ranges;
}

function isInCodeBlock(lineIdx: number, ranges: [number, number][]): boolean {
  return ranges.some(([s, e]) => lineIdx >= s && lineIdx <= e);
}

/** Parse all headings from lines. */
export function parseHeadings(lines: string[], codeRanges: [number, number][]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isInCodeBlock(i, codeRanges)) continue;
    const match = lines[i].match(/^(#{1,6})\s+(.*)/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2], line: i + 1 });
    }
  }
  return headings;
}

/** Parse all links from lines. */
export function parseLinks(
  lines: string[],
  codeRanges: [number, number][],
  anchors: Set<string>,
): Link[] {
  const links: Link[] = [];
  const linkPattern = /\[([^\]]*)\]\(([^)]*)\)/g;

  for (let i = 0; i < lines.length; i++) {
    if (isInCodeBlock(i, codeRanges)) continue;

    let match;
    linkPattern.lastIndex = 0;
    while ((match = linkPattern.exec(lines[i])) !== null) {
      const target = match[2].trim();
      let type: Link["type"];
      let valid: boolean | undefined;

      if (target.startsWith("#")) {
        type = "internal";
        if (target.length > 1) {
          valid = anchors.has(target.slice(1));
        }
      } else if (/^https?:\/\//.test(target)) {
        type = "external";
      } else {
        type = "other";
      }

      links.push({ text: match[1], target, line: i + 1, type, valid });
    }
  }
  return links;
}

/** Parse tables from lines. */
export function parseTables(lines: string[], codeRanges: [number, number][]): TableInfo[] {
  const tables: TableInfo[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isInCodeBlock(i, codeRanges) || !lines[i].trim().startsWith("|")) {
      i++;
      continue;
    }

    const start = i;
    while (i < lines.length && lines[i].trim().startsWith("|")) i++;
    const tableLines = lines.slice(start, i);

    if (tableLines.length < 2) continue;

    const colCounts = tableLines.map(
      (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").length,
    );

    const headerCols = colCounts[0];
    const sepLine = tableLines[1];
    const hasSeparator = sepLine
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .every((cell) => /^\s*:?-+:?\s*$/.test(cell));

    const columnMismatch = colCounts.some((c) => c !== headerCols);

    tables.push({
      startLine: start + 1,
      endLine: start + tableLines.length,
      columns: headerCols,
      hasSeparator,
      columnMismatch,
    });
  }
  return tables;
}

/** Parse frontmatter from lines. */
export function parseFrontmatter(lines: string[]): FrontmatterInfo | null {
  if (lines.length === 0) return null;
  if (lines[0] !== "---") return null;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const fmLines = lines.slice(1, endIdx);
  const raw = fmLines.join("\n");

  // Simple YAML validation
  const valid = fmLines.every(isValidYamlLine);

  // Simple key-value parse for valid YAML
  let parsed: Record<string, string> | null = null;
  if (valid) {
    parsed = {};
    for (const line of fmLines) {
      const kv = line.match(/^([\w.-]+)\s*:\s*(.*)/);
      if (kv) parsed[kv[1]] = kv[2].trim();
    }
  }

  return { raw, parsed, valid, startLine: 1, endLine: endIdx + 1 };
}

/** Parse list blocks from lines. */
export function parseLists(lines: string[], codeRanges: [number, number][]): ListBlock[] {
  const lists: ListBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isInCodeBlock(i, codeRanges)) {
      i++;
      continue;
    }

    const match = lines[i].match(/^(\s*)([-*+]|\d+[.)]) /);
    if (!match) {
      i++;
      continue;
    }

    const items: ListBlock["items"] = [];
    const blockStart = i;

    while (i < lines.length && !isInCodeBlock(i, codeRanges)) {
      const itemMatch = lines[i].match(/^(\s*)([-*+]|\d+[.)]) /);
      if (itemMatch) {
        items.push({ line: i + 1, indent: itemMatch[1].length, marker: itemMatch[2] });
        i++;
      } else if (lines[i].trim() === "") {
        // Blank line might separate list items
        if (i + 1 < lines.length && /^\s*([-*+]|\d+[.)]) /.test(lines[i + 1])) {
          i++;
        } else {
          break;
        }
      } else if (/^\s+/.test(lines[i])) {
        // Continuation line (indented)
        i++;
      } else {
        break;
      }
    }

    if (items.length > 0) {
      lists.push({ startLine: blockStart + 1, endLine: i, items });
    }
  }
  return lists;
}

/** Count code blocks in lines. */
function countCodeBlocks(codeRanges: [number, number][]): number {
  return codeRanges.length;
}

/** Full document structure parse. */
export function getDocumentStructure(text: string): DocumentStructure {
  const lines = text.split("\n");
  const codeRanges = findCodeBlockRanges(lines);

  const headings = parseHeadings(lines, codeRanges);
  const anchors = new Set(headings.map((h) => headingToAnchor(h.text)));
  const links = parseLinks(lines, codeRanges, anchors);
  const tables = parseTables(lines, codeRanges);
  const lists = parseLists(lines, codeRanges);
  const frontmatter = parseFrontmatter(lines);

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return {
    headings,
    links,
    tables,
    lists,
    frontmatter,
    anchors,
    stats: {
      wordCount,
      headingCount: headings.length,
      linkCount: links.length,
      codeBlockCount: countCodeBlocks(codeRanges),
      tableCount: tables.length,
    },
  };
}
