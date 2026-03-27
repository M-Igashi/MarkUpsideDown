import type { EditorView } from "@codemirror/view";
import { basename, dirname, buildRelativePath } from "./path-utils.ts";

const { save } = window.__TAURI__.dialog;
const { writeTextFile } = window.__TAURI__.fs;

interface NoteRefactorDeps {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
  loadContentAsTab: (content: string, filePath?: string) => void;
}

let deps: NoteRefactorDeps;

export function initNoteRefactor(d: NoteRefactorDeps) {
  deps = d;
}

export async function extractToNewNote() {
  const { editor, statusEl, getCurrentFilePath, loadContentAsTab } = deps;
  const sel = editor.state.selection.main;

  if (sel.empty) {
    statusEl.textContent = "Select text to extract into a new note";
    return;
  }

  const selectedText = editor.state.sliceDoc(sel.from, sel.to);
  const currentPath = getCurrentFilePath();

  // Suggest filename from first heading or first line
  const firstLine = selectedText
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .trim();
  const suggestedName =
    firstLine
      .slice(0, 50)
      .replace(/[^a-zA-Z0-9\s_-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "extracted-note";

  const defaultDir = currentPath ? dirname(currentPath) : undefined;

  const newPath = await save({
    defaultPath: defaultDir ? `${defaultDir}/${suggestedName}.md` : `${suggestedName}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (!newPath) return;

  try {
    await writeTextFile(newPath, selectedText);

    // Build relative link
    const newName = basename(newPath).replace(/\.md$/, "");
    let relativePath: string;
    if (currentPath) {
      relativePath = buildRelativePath(currentPath, newPath);
    } else {
      relativePath = basename(newPath);
    }

    const link = `[${newName}](${relativePath})`;
    editor.dispatch({
      changes: { from: sel.from, to: sel.to, insert: link },
      selection: { anchor: sel.from + link.length },
    });

    // Open the new note in a new tab
    loadContentAsTab(selectedText, newPath);
    statusEl.textContent = `Extracted to ${basename(newPath)}`;
  } catch (e) {
    statusEl.textContent = `Extract failed: ${e}`;
  }
}
