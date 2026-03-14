// --- Markdown Table Parser ---

function parseMarkdownTable(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;

  const parseRow = (line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = parseRow(lines[0]);
  const sepLine = lines[1].trim();
  if (!/^\|?[\s:]*-{3,}[\s:]*(\|[\s:]*-{3,}[\s:]*)*\|?$/.test(sepLine)) return null;

  const alignments = parseRow(lines[1]).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  const rows = lines.slice(2).map(parseRow);
  const colCount = header.length;

  // Normalize row lengths
  const normalize = (row) => {
    while (row.length < colCount) row.push("");
    return row.slice(0, colCount);
  };

  return {
    headers: normalize(header),
    alignments: alignments.slice(0, colCount),
    rows: rows.map(normalize),
  };
}

function generateMarkdownTable(table) {
  const { headers, alignments, rows } = table;
  const colCount = headers.length;

  // Calculate column widths
  const widths = Array.from({ length: colCount }, (_, i) => {
    const cells = [headers[i], ...rows.map((r) => r[i] || "")];
    return Math.max(3, ...cells.map((c) => c.length));
  });

  const pad = (str, width, align) => {
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

  const formatRow = (cells) =>
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

// --- Find table range in editor ---

function findTableAtCursor(doc, pos) {
  const text = doc.toString();
  const lines = text.split("\n");
  let offset = 0;
  let cursorLine = 0;

  for (let i = 0; i < lines.length; i++) {
    if (offset + lines[i].length >= pos) {
      cursorLine = i;
      break;
    }
    offset += lines[i].length + 1;
  }

  // Check if cursor line looks like a table line
  const isTableLine = (line) => line.trim().startsWith("|") || /\|.*\|/.test(line);
  if (!isTableLine(lines[cursorLine])) return null;

  // Find table boundaries
  let start = cursorLine;
  while (start > 0 && isTableLine(lines[start - 1])) start--;

  let end = cursorLine;
  while (end < lines.length - 1 && isTableLine(lines[end + 1])) end++;

  const tableText = lines.slice(start, end + 1).join("\n");
  const parsed = parseMarkdownTable(tableText);
  if (!parsed) return null;

  let from = 0;
  for (let i = 0; i < start; i++) from += lines[i].length + 1;
  let to = from + tableText.length;

  return { table: parsed, from, to };
}

// --- Spreadsheet UI ---

export function showTableEditor(editor, existingTable) {
  document.getElementById("table-editor-dialog")?.remove();

  let table;
  let tableRange = null;

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
  const undoStack = [];
  const redoStack = [];

  function snapshot() {
    undoStack.push(JSON.parse(JSON.stringify(table)));
    redoStack.length = 0;
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.parse(JSON.stringify(table)));
    Object.assign(table, undoStack.pop());
    renderGrid();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.parse(JSON.stringify(table)));
    Object.assign(table, redoStack.pop());
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

  const gridEl = overlay.querySelector(".table-editor-grid");
  const alignSelect = overlay.querySelector('[data-action="align"]');
  let activeCol = 0;

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

    // Attach input listeners
    gridEl.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", (e) => {
        const row = parseInt(e.target.dataset.row);
        const col = parseInt(e.target.dataset.col);
        if (row === -1) {
          table.headers[col] = e.target.value;
        } else {
          table.rows[row][col] = e.target.value;
        }
      });

      input.addEventListener("focus", (e) => {
        activeCol = parseInt(e.target.dataset.col);
        alignSelect.value = table.alignments[activeCol] || "left";
        e.target.select();
      });

      input.addEventListener("blur", () => {
        snapshot();
      });

      input.addEventListener("keydown", handleCellKeydown);
    });
  }

  function handleCellKeydown(e) {
    const row = parseInt(e.target.dataset.row);
    const col = parseInt(e.target.dataset.col);
    const colCount = table.headers.length;
    const rowCount = table.rows.length;

    const focusCell = (r, c) => {
      const sel = `input[data-row="${r}"][data-col="${c}"]`;
      const el = gridEl.querySelector(sel);
      if (el) el.focus();
    };

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        // Previous cell
        if (col > 0) focusCell(row, col - 1);
        else if (row > -1) focusCell(row - 1, colCount - 1);
      } else {
        // Next cell
        if (col < colCount - 1) focusCell(row, col + 1);
        else if (row < rowCount - 1) focusCell(row + 1, 0);
        else {
          // Add new row at end
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
    } else if (e.key === "ArrowUp" && e.target.selectionStart === e.target.selectionEnd) {
      e.preventDefault();
      if (row > -1) focusCell(row - 1, col);
    } else if (e.key === "ArrowDown" && e.target.selectionStart === e.target.selectionEnd) {
      e.preventDefault();
      if (row === -1) focusCell(0, col);
      else if (row < rowCount - 1) focusCell(row + 1, col);
    }
  }

  function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // Toolbar actions
  overlay.querySelector(".table-editor-toolbar").addEventListener("click", (e) => {
    const action = e.target.dataset?.action;
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
  gridEl.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || !text.includes("\t") && !text.includes(",")) return;

    e.preventDefault();
    snapshot();

    const delimiter = text.includes("\t") ? "\t" : ",";
    const pastedRows = text
      .trim()
      .split("\n")
      .map((line) => line.split(delimiter).map((c) => c.trim()));

    if (pastedRows.length === 0) return;

    const focusedRow = parseInt(document.activeElement?.dataset?.row ?? "-1");
    const focusedCol = parseInt(document.activeElement?.dataset?.col ?? "0");

    // Expand table if needed
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
  const close = () => overlay.remove();

  document.getElementById("table-editor-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.getElementById("table-editor-ok").addEventListener("click", () => {
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
  // Focus first cell
  setTimeout(() => {
    const first = gridEl.querySelector("input");
    if (first) first.focus();
  }, 50);
}

// --- Edit table at cursor ---

export function editTableAtCursor(editor) {
  const pos = editor.state.selection.main.head;
  const found = findTableAtCursor(editor.state.doc, pos);
  if (found) {
    showTableEditor(editor, found);
  } else {
    showTableEditor(editor, null);
  }
}
