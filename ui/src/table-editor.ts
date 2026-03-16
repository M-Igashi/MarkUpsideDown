import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// --- Markdown Table Parser ---

interface TableData {
  headers: string[];
  alignments: string[];
  rows: string[][];
}

interface TableRange {
  table: TableData;
  from: number;
  to: number;
}

function parseMarkdownTable(text: string): TableData | null {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = parseRow(lines[0]);
  const sepLine = lines[1].trim();
  if (!/^\|?[\s:]*-{3,}[\s:]*(\|[\s:]*-{3,}[\s:]*)*\|?$/.test(sepLine)) return null;

  const alignments: string[] = parseRow(lines[1]).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  const rows = lines.slice(2).map(parseRow);
  const colCount = header.length;

  const normalize = (row: string[]): string[] => {
    while (row.length < colCount) row.push("");
    return row.slice(0, colCount);
  };

  return {
    headers: normalize(header),
    alignments: alignments.slice(0, colCount),
    rows: rows.map(normalize),
  };
}

function generateMarkdownTable(table: TableData): string {
  const { headers, alignments, rows } = table;
  const colCount = headers.length;

  const widths = Array.from({ length: colCount }, (_, i) => {
    const cells = [headers[i], ...rows.map((r) => r[i] || "")];
    return Math.max(3, ...cells.map((c) => c.length));
  });

  const pad = (str: string, width: number, align: string): string => {
    const s = str || "";
    const diff = width - s.length;
    if (diff <= 0) return s;
    if (align === "center") {
      const left = Math.floor(diff / 2);
      return " ".repeat(left) + s + " ".repeat(diff - left);
    }
    if (align === "right") return " ".repeat(diff) + s;
    return s + " ".repeat(diff);
  };

  const formatRow = (cells: string[]): string =>
    "| " + cells.map((c, i) => pad(c, widths[i], alignments[i])).join(" | ") + " |";

  const sepRow =
    "| " +
    widths
      .map((w, i) => {
        const dashes = "-".repeat(w);
        const a = alignments[i];
        if (a === "center") return ":" + dashes.slice(1, -1) + ":";
        if (a === "right") return dashes.slice(0, -1) + ":";
        return dashes;
      })
      .join(" | ") +
    " |";

  return [formatRow(headers), sepRow, ...rows.map(formatRow)].join("\n");
}

// --- Find table range in editor (uses CodeMirror line API) ---

function findTableAtCursor(doc: Text, pos: number): TableRange | null {
  const isTableLine = (text: string): boolean => text.trim().startsWith("|") || /\|.*\|/.test(text);

  const cursorLine = doc.lineAt(pos);
  if (!isTableLine(cursorLine.text)) return null;

  let startLine = cursorLine.number;
  while (startLine > 1 && isTableLine(doc.line(startLine - 1).text)) startLine--;

  let endLine = cursorLine.number;
  while (endLine < doc.lines && isTableLine(doc.line(endLine + 1).text)) endLine++;

  const tableLines: string[] = [];
  for (let i = startLine; i <= endLine; i++) tableLines.push(doc.line(i).text);

  const tableText = tableLines.join("\n");
  const parsed = parseMarkdownTable(tableText);
  if (!parsed) return null;

  const from = doc.line(startLine).from;
  const to = doc.line(endLine).to;

  return { table: parsed, from, to };
}

// --- Spreadsheet UI ---

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function showTableEditor(editor: EditorView, existingTable: TableRange | null): void {
  document.getElementById("table-editor-dialog")?.remove();

  let table: TableData;
  let tableRange: { from: number; to: number } | null = null;

  if (existingTable) {
    table = existingTable.table;
    tableRange = { from: existingTable.from, to: existingTable.to };
  } else {
    table = {
      headers: ["Header 1", "Header 2", "Header 3"],
      alignments: ["left", "left", "left"],
      rows: [["", "", ""]],
    };
  }

  // Undo stack
  const undoStack: TableData[] = [];
  const redoStack: TableData[] = [];

  function snapshot() {
    undoStack.push(JSON.parse(JSON.stringify(table)));
    redoStack.length = 0;
  }

  function restoreSnapshot(snap: TableData): void {
    table.headers = snap.headers;
    table.alignments = snap.alignments;
    table.rows = snap.rows;
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.parse(JSON.stringify(table)));
    restoreSnapshot(undoStack.pop()!);
    renderGrid();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.parse(JSON.stringify(table)));
    restoreSnapshot(redoStack.pop()!);
    renderGrid();
  }

  const overlay = document.createElement("div");
  overlay.id = "table-editor-dialog";
  overlay.className = "dialog-overlay";
  overlay.innerHTML = `
    <div class="dialog-box table-editor-box">
      <div class="dialog-title">
        ${tableRange ? "Edit Table" : "Insert Table"}
        <span class="table-editor-hint">Tab/Enter to navigate, Ctrl+Z undo</span>
      </div>
      <div class="table-editor-toolbar">
        <button data-action="add-row" title="Add row">+ Row</button>
        <button data-action="add-col" title="Add column">+ Column</button>
        <button data-action="del-row" title="Delete last row">- Row</button>
        <button data-action="del-col" title="Delete last column">- Column</button>
        <span class="separator"></span>
        <select data-action="align" title="Column alignment">
          <option value="left">Align Left</option>
          <option value="center">Align Center</option>
          <option value="right">Align Right</option>
        </select>
      </div>
      <div class="table-editor-grid-wrapper">
        <table class="table-editor-grid"></table>
      </div>
      <div class="dialog-actions">
        <button id="table-editor-cancel">Cancel</button>
        <button id="table-editor-ok" class="primary">${tableRange ? "Update" : "Insert"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const gridEl = overlay.querySelector(".table-editor-grid") as HTMLTableElement;
  const alignSelect = overlay.querySelector('[data-action="align"]') as HTMLSelectElement;
  let activeCol = 0;
  let focusValueOnEntry = "";

  function renderGrid() {
    const colCount = table.headers.length;
    let html = "<thead><tr>";
    for (let c = 0; c < colCount; c++) {
      html += `<th><input type="text" data-row="-1" data-col="${c}" value="${escapeAttr(table.headers[c])}" /></th>`;
    }
    html += "</tr></thead><tbody>";
    for (let r = 0; r < table.rows.length; r++) {
      html += "<tr>";
      for (let c = 0; c < colCount; c++) {
        html += `<td><input type="text" data-row="${r}" data-col="${c}" value="${escapeAttr(table.rows[r][c] || "")}" /></td>`;
      }
      html += "</tr>";
    }
    html += "</tbody>";
    gridEl.innerHTML = html;
  }

  // Event delegation on grid
  gridEl.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    const input = target as HTMLInputElement;
    const row = parseInt(input.dataset.row!);
    const col = parseInt(input.dataset.col!);
    if (row === -1) {
      table.headers[col] = input.value;
    } else {
      table.rows[row][col] = input.value;
    }
  });

  gridEl.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    const input = target as HTMLInputElement;
    activeCol = parseInt(input.dataset.col!);
    alignSelect.value = table.alignments[activeCol] || "left";
    focusValueOnEntry = input.value;
    input.select();
  });

  gridEl.addEventListener("focusout", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    const input = target as HTMLInputElement;
    if (input.value !== focusValueOnEntry) {
      snapshot();
    }
  });

  gridEl.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    handleCellKeydown(e as KeyboardEvent);
  });

  function handleCellKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLInputElement;
    const row = parseInt(target.dataset.row!);
    const col = parseInt(target.dataset.col!);
    const colCount = table.headers.length;
    const rowCount = table.rows.length;

    const focusCell = (r: number, c: number): void => {
      const el = gridEl.querySelector<HTMLInputElement>(`input[data-row="${r}"][data-col="${c}"]`);
      if (el) el.focus();
    };

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (col > 0) focusCell(row, col - 1);
        else if (row > -1) focusCell(row - 1, colCount - 1);
      } else {
        if (col < colCount - 1) focusCell(row, col + 1);
        else if (row < rowCount - 1) focusCell(row + 1, 0);
        else {
          snapshot();
          table.rows.push(Array(colCount).fill(""));
          renderGrid();
          focusCell(rowCount, 0);
        }
      }
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (row < rowCount - 1) focusCell(row + 1, col);
      else if (row === -1) focusCell(0, col);
    } else if (e.key === "ArrowUp" && target.selectionStart === target.selectionEnd) {
      e.preventDefault();
      if (row > -1) focusCell(row - 1, col);
    } else if (e.key === "ArrowDown" && target.selectionStart === target.selectionEnd) {
      e.preventDefault();
      if (row === -1) focusCell(0, col);
      else if (row < rowCount - 1) focusCell(row + 1, col);
    }
  }

  // Toolbar actions
  overlay.querySelector(".table-editor-toolbar")!.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).dataset?.action;
    if (!action) return;
    const colCount = table.headers.length;

    snapshot();
    if (action === "add-row") {
      table.rows.push(Array(colCount).fill(""));
      renderGrid();
    } else if (action === "add-col") {
      table.headers.push(`Column ${colCount + 1}`);
      table.alignments.push("left");
      table.rows.forEach((r) => r.push(""));
      renderGrid();
    } else if (action === "del-row" && table.rows.length > 1) {
      table.rows.pop();
      renderGrid();
    } else if (action === "del-col" && colCount > 1) {
      table.headers.pop();
      table.alignments.pop();
      table.rows.forEach((r) => r.pop());
      renderGrid();
    }
  });

  alignSelect.addEventListener("change", () => {
    snapshot();
    table.alignments[activeCol] = alignSelect.value;
  });

  // Clipboard paste: TSV/CSV -> table cells
  gridEl.addEventListener("paste", (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || (!text.includes("\t") && !text.includes(","))) return;

    e.preventDefault();
    snapshot();

    const delimiter = text.includes("\t") ? "\t" : ",";
    const pastedRows = text
      .trim()
      .split("\n")
      .map((line) => line.split(delimiter).map((c) => c.trim()));

    if (pastedRows.length === 0) return;

    const active = document.activeElement as HTMLInputElement | null;
    const focusedRow = parseInt(active?.dataset?.row ?? "-1");
    const focusedCol = parseInt(active?.dataset?.col ?? "0");

    const neededCols = focusedCol + pastedRows[0].length;
    while (table.headers.length < neededCols) {
      table.headers.push(`Column ${table.headers.length + 1}`);
      table.alignments.push("left");
      table.rows.forEach((r) => r.push(""));
    }

    for (let pr = 0; pr < pastedRows.length; pr++) {
      const targetRow = focusedRow + pr;
      for (let pc = 0; pc < pastedRows[pr].length; pc++) {
        const targetCol = focusedCol + pc;
        if (targetCol >= table.headers.length) continue;
        if (targetRow === -1) {
          table.headers[targetCol] = pastedRows[pr][pc];
        } else {
          while (table.rows.length <= targetRow) {
            table.rows.push(Array(table.headers.length).fill(""));
          }
          table.rows[targetRow][targetCol] = pastedRows[pr][pc];
        }
      }
    }

    renderGrid();
  });

  // Keyboard shortcuts
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (
      (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
      (e.key === "y" && (e.ctrlKey || e.metaKey))
    ) {
      e.preventDefault();
      redo();
    }
  });

  // Close / Apply
  const close = (): void => overlay.remove();

  document.getElementById("table-editor-cancel")!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.getElementById("table-editor-ok")!.addEventListener("click", () => {
    const md = generateMarkdownTable(table);
    if (tableRange) {
      editor.dispatch({
        changes: { from: tableRange.from, to: tableRange.to, insert: md },
      });
    } else {
      const pos = editor.state.selection.main.head;
      const prefix = pos > 0 && editor.state.doc.sliceString(pos - 1, pos) !== "\n" ? "\n\n" : "\n";
      editor.dispatch({
        changes: { from: pos, insert: prefix + md + "\n" },
      });
    }
    close();
    editor.focus();
  });

  renderGrid();
  setTimeout(() => {
    const first = gridEl.querySelector<HTMLInputElement>("input");
    if (first) first.focus();
  }, 50);
}

// --- Edit table at cursor ---

export function editTableAtCursor(editor: EditorView): void {
  const pos = editor.state.selection.main.head;
  const found = findTableAtCursor(editor.state.doc, pos);
  showTableEditor(editor, found);
}
