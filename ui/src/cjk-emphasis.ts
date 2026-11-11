// Shared CJK emphasis spacing logic.
// CommonMark delimiter-flanking rules treat CJK characters as "letters",
// causing emphasis markers adjacent to CJK text to fail parsing.
// Reference: https://zenn.dev/miyabitti/articles/594fdb7373a3a8
//
// normalize.ts uses half-width space (portable Markdown for all parsers).
// preview-render.ts uses hair space U+200A (invisible, passes flanking rules).

import { findCodeBlockRanges, isInCodeBlock, mapOutsideInlineCode } from "./document-structure.ts";

export const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;

// Emphasis span matchers — shared with markdown-lint.ts so a fix to the
// flanking logic in one place cannot silently miss the other.
export const STRONG_ASTERISK_RE = /\*\*((?:[^*]|\*(?!\*))+?)\*\*/g;
export const EM_ASTERISK_RE = /(?<!\*)\*((?:[^*\n])+?)\*(?!\*)/g;
export const STRONG_UNDERSCORE_RE = /__((?:[^_]|_(?!_))+?)__/g;
export const EM_UNDERSCORE_RE = /(?<!_)_((?:[^_\n])+?)_(?!_)/g;

function spaceCjkEmphasis(line: string, re: RegExp, marker: string, space: string): string {
  return line.replace(re, (m, content, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : "";
    const afterPos = offset + m.length;
    const after = afterPos < str.length ? str[afterPos] : "";
    const pre = before && CJK_RE.test(before) ? space : "";
    const post = after && CJK_RE.test(after) ? space : "";
    return `${pre}${marker}${content}${marker}${post}`;
  });
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

// Leading blockquote / list markers, so a `*` bullet is never taken as an emphasis opener.
const LINE_PREFIX_RE = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$))*[ \t]*/;

function stripInnerSpaces(line: string, re: RegExp, marker: string): string {
  return line.replace(re, (m, content: string) =>
    /^\s/.test(content) && /\s$/.test(content) && content.trim()
      ? `${marker}${content.trim()}${marker}`
      : m,
  );
}

function fixLine(line: string, space: string): string {
  // Strip inner spaces: "** text **" → "**text**"
  line = stripInnerSpaces(line, STRONG_ASTERISK_RE, "**");
  line = stripInnerSpaces(line, STRONG_UNDERSCORE_RE, "__");

  // Insert spaces at CJK boundaries (longer markers first to avoid conflicts)
  line = spaceCjkEmphasis(line, STRONG_ASTERISK_RE, "**", space);
  line = spaceCjkEmphasis(line, EM_ASTERISK_RE, "*", space);
  line = spaceCjkEmphasis(line, STRONG_UNDERSCORE_RE, "__", space);
  line = spaceCjkEmphasis(line, EM_UNDERSCORE_RE, "_", space);
  return line;
}

export function fixCjkEmphasisWith(text: string, space: string): string {
  const lines = text.split("\n");
  const codeRanges = findCodeBlockRanges(lines);
  let prevBlank = true;
  let inIndentedCode = false;
  return lines
    .map((line, i) => {
      const blank = line.trim() === "";
      inIndentedCode =
        !blank &&
        /^( {4}|\t)/.test(line) &&
        (prevBlank || inIndentedCode) &&
        !LIST_ITEM_RE.test(line);
      prevBlank = blank;
      if (blank || inIndentedCode || isInCodeBlock(i, codeRanges) || !/[*_]/.test(line))
        return line;
      const prefix = line.match(LINE_PREFIX_RE)![0];
      return prefix + mapOutsideInlineCode(line.slice(prefix.length), (s) => fixLine(s, space));
    })
    .join("\n");
}
