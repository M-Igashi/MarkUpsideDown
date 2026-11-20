// File tagging system — stores tags in .markupsidedown/tags.json per project.
// `data` is a read cache. Every change goes through the backend's `update_tags`,
// which re-reads the file and applies just that change, so other windows on
// the project and MCP agents never overwrite each other.

import { clampToViewport } from "./html-utils.ts";
import { relativeToRoot } from "./path-utils.ts";
import { icon } from "./icons.ts";

const { invoke } = window.__TAURI__.core;

interface TagDef {
  color: string;
}

interface TagsData {
  tags: Record<string, TagDef>;
  files: Record<string, string[]>;
}

/** Mirrors `TagsOp` in src-tauri/src/commands/tags.rs. Paths are project-relative. */
type TagsOp =
  | { op: "create_tag"; name: string; color: string }
  | { op: "delete_tag"; name: string }
  | { op: "add_file_tag"; paths: string[]; tag: string }
  | { op: "remove_file_tag"; paths: string[]; tag: string }
  | { op: "rename_path"; from: string; to: string }
  | { op: "delete_path"; path: string };

const PRESET_COLORS = [
  { name: "Red", value: "#d94545" },
  { name: "Orange", value: "#d98a45" },
  { name: "Yellow", value: "#c9a830" },
  { name: "Green", value: "#4a9e5c" },
  { name: "Blue", value: "#4a7ab5" },
  { name: "Purple", value: "#8a5ab5" },
  { name: "Pink", value: "#c95a8a" },
  { name: "Gray", value: "#8a8578" },
];

let currentRootPath: string | null = null;
let data: TagsData = { tags: {}, files: {} };

export async function loadTags(rootPath: string): Promise<void> {
  currentRootPath = rootPath;
  try {
    // The backend drops entries whose file no longer exists
    const loaded = await invoke<TagsData>("load_tags", { root: rootPath });
    if (rootPath === currentRootPath) data = loaded;
  } catch {
    data = { tags: {}, files: {} };
  }
}

/** True when any file is tagged, i.e. a removed file could leave a stale entry. */
export function hasTaggedFiles(): boolean {
  return Object.keys(data.files).length > 0;
}

export async function reloadTags(): Promise<void> {
  if (currentRootPath) await loadTags(currentRootPath);
}

/** Apply changes to tags.json. On failure (e.g. a tag another window just deleted), resync. */
async function update(ops: TagsOp[]): Promise<void> {
  const root = currentRootPath;
  if (!root || ops.length === 0) return;
  try {
    const updated = await invoke<TagsData>("update_tags", { root, ops });
    if (root === currentRootPath) data = updated;
  } catch {
    await reloadTags();
  }
}

function toRelPath(absPath: string): string {
  return currentRootPath ? relativeToRoot(currentRootPath, absPath) : absPath;
}

export function renameFileTags(oldPath: string, newPath: string): void {
  update([{ op: "rename_path", from: toRelPath(oldPath), to: toRelPath(newPath) }]);
}

export function deleteFileTags(paths: string[]): void {
  update(paths.map((p) => ({ op: "delete_path", path: toRelPath(p) })));
}

export function getFileTags(absPath: string): string[] {
  const rel = toRelPath(absPath);
  return data.files[rel] ?? [];
}

export function getTagDef(tagName: string): TagDef | undefined {
  return data.tags[tagName];
}

export function getAllTagNames(): string[] {
  return Object.keys(data.tags);
}

function deleteTag(name: string): Promise<void> {
  return update([{ op: "delete_tag", name }]);
}

function bulkToggleTag(absPaths: string[], tagName: string): Promise<void> {
  // If all selected files have this tag, remove it from all; otherwise add to all
  const allHave = absPaths.every((p) => getFileTags(p).includes(tagName));
  return update([
    {
      op: allHave ? "remove_file_tag" : "add_file_tag",
      paths: absPaths.map(toRelPath),
      tag: tagName,
    },
  ]);
}

// --- Popover UI ---

let activePopover: HTMLElement | null = null;

export function removeTagPopover(): void {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

export function showTagPopover(
  anchorX: number,
  anchorY: number,
  targetPaths: string[],
  onDone: () => void,
): void {
  removeTagPopover();

  const popover = document.createElement("div");
  popover.className = "tag-popover";
  popover.style.left = `${anchorX}px`;
  popover.style.top = `${anchorY}px`;
  activePopover = popover;

  function renderContent() {
    popover.innerHTML = "";

    const tagNames = getAllTagNames();

    if (tagNames.length > 0) {
      const list = document.createElement("div");
      list.className = "tag-popover-list";

      for (const tagName of tagNames) {
        const def = data.tags[tagName];
        const row = document.createElement("div");
        row.className = "tag-popover-row";

        // Checkbox
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "tag-popover-checkbox";
        const allHave = targetPaths.every((p) => getFileTags(p).includes(tagName));
        const someHave = !allHave && targetPaths.some((p) => getFileTags(p).includes(tagName));
        cb.checked = allHave;
        cb.indeterminate = someHave;
        cb.addEventListener("change", async () => {
          await bulkToggleTag(targetPaths, tagName);
          renderContent();
          onDone();
        });
        row.appendChild(cb);

        // Color dot + label
        const dot = document.createElement("span");
        dot.className = "tag-dot";
        dot.style.background = def.color;
        row.appendChild(dot);

        const label = document.createElement("span");
        label.className = "tag-popover-label";
        label.textContent = tagName;
        row.appendChild(label);

        // Delete button
        const del = document.createElement("button");
        del.className = "tag-popover-delete";
        del.innerHTML = icon("x", 12);
        del.title = `Delete tag "${tagName}"`;
        del.setAttribute("aria-label", del.title);
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          await deleteTag(tagName);
          renderContent();
          onDone();
        });
        row.appendChild(del);

        list.appendChild(row);
      }
      popover.appendChild(list);

      const sep = document.createElement("div");
      sep.className = "tag-popover-separator";
      popover.appendChild(sep);
    }

    // New tag form
    const form = document.createElement("div");
    form.className = "tag-popover-new";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "field field-sm tag-popover-input";
    input.placeholder = "New tag…";
    input.maxLength = 24;
    form.appendChild(input);

    const colorRow = document.createElement("div");
    colorRow.className = "tag-popover-colors";
    let selectedColor = PRESET_COLORS[0].value;

    for (const preset of PRESET_COLORS) {
      const swatch = document.createElement("button");
      swatch.className = "tag-color-swatch";
      if (preset.value === selectedColor) swatch.classList.add("selected");
      swatch.style.background = preset.value;
      swatch.title = preset.name;
      swatch.addEventListener("click", () => {
        selectedColor = preset.value;
        for (const s of colorRow.querySelectorAll(".tag-color-swatch")) {
          s.classList.toggle(
            "selected",
            (s as HTMLElement).style.background === swatch.style.background,
          );
        }
      });
      colorRow.appendChild(swatch);
    }
    form.appendChild(colorRow);

    const addBtn = document.createElement("button");
    addBtn.className = "btn btn-sm btn-primary tag-popover-add";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name || data.tags[name]) return;
      // Create the tag and assign it to the selected files
      await update([
        { op: "create_tag", name, color: selectedColor },
        { op: "add_file_tag", paths: targetPaths.map(toRelPath), tag: name },
      ]);
      renderContent();
      onDone();
    });
    form.appendChild(addBtn);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addBtn.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        removeTagPopover();
      }
    });

    popover.appendChild(form);

    // Focus the input after render
    requestAnimationFrame(() => input.focus());
  }

  renderContent();
  document.body.appendChild(popover);

  requestAnimationFrame(() => clampToViewport(popover));

  // Close on outside click
  const closeHandler = (e: Event) => {
    if (!popover.contains(e.target as Node)) {
      removeTagPopover();
      document.removeEventListener("mousedown", closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeHandler, true), 0);
}
