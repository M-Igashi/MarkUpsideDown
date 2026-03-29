// File tagging system — stores tags in .markupsidedown/tags.json per project.

const { invoke } = window.__TAURI__.core;
const { writeTextFile } = window.__TAURI__.fs;

interface TagDef {
  color: string;
}

interface TagsData {
  tags: Record<string, TagDef>;
  files: Record<string, string[]>;
}

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

function tagsFilePath(): string | null {
  if (!currentRootPath) return null;
  return `${currentRootPath}/.markupsidedown/tags.json`;
}

export async function loadTags(rootPath: string): Promise<void> {
  currentRootPath = rootPath;
  const fp = tagsFilePath();
  if (!fp) return;
  try {
    const raw = await invoke<string>("read_text_file", { path: fp });
    const parsed = JSON.parse(raw);
    data = {
      tags: parsed.tags ?? {},
      files: parsed.files ?? {},
    };
  } catch {
    data = { tags: {}, files: {} };
  }
}

export function clearTags(): void {
  currentRootPath = null;
  data = { tags: {}, files: {} };
}

async function save(): Promise<void> {
  const fp = tagsFilePath();
  if (!fp) return;
  const dir = `${currentRootPath}/.markupsidedown`;
  try {
    await invoke("create_directory", { path: dir });
  } catch {}

  // Remove empty file entries before saving
  for (const [path, tags] of Object.entries(data.files)) {
    if (tags.length === 0) delete data.files[path];
  }
  await writeTextFile(fp, JSON.stringify(data, null, 2));
}

function toRelPath(absPath: string): string {
  if (currentRootPath && absPath.startsWith(currentRootPath + "/")) {
    return absPath.substring(currentRootPath.length + 1);
  }
  return absPath;
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

export function hasAnyTags(): boolean {
  return Object.keys(data.tags).length > 0;
}

async function createTag(name: string, color: string): Promise<void> {
  data.tags[name] = { color };
  await save();
}

async function deleteTag(name: string): Promise<void> {
  delete data.tags[name];
  for (const [path, tags] of Object.entries(data.files)) {
    data.files[path] = tags.filter((t) => t !== name);
  }
  await save();
}

async function bulkToggleTag(absPaths: string[], tagName: string): Promise<void> {
  // If all selected files have this tag, remove it from all; otherwise add to all
  const allHave = absPaths.every((p) => getFileTags(p).includes(tagName));
  for (const absPath of absPaths) {
    const rel = toRelPath(absPath);
    const tags = data.files[rel] ?? [];
    if (allHave) {
      data.files[rel] = tags.filter((t) => t !== tagName);
    } else if (!tags.includes(tagName)) {
      data.files[rel] = [...tags, tagName];
    }
  }
  await save();
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
        del.textContent = "✕";
        del.title = `Delete tag "${tagName}"`;
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
    input.className = "tag-popover-input";
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
    addBtn.className = "tag-popover-add";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name || data.tags[name]) return;
      await createTag(name, selectedColor);
      // Auto-assign to selected files
      for (const absPath of targetPaths) {
        const rel = toRelPath(absPath);
        const tags = data.files[rel] ?? [];
        if (!tags.includes(name)) {
          data.files[rel] = [...tags, name];
        }
      }
      await save();
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

  // Adjust position if overflowing
  requestAnimationFrame(() => {
    const rect = popover.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      popover.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      popover.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });

  // Close on outside click
  const closeHandler = (e: Event) => {
    if (!popover.contains(e.target as Node)) {
      removeTagPopover();
      document.removeEventListener("mousedown", closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeHandler, true), 0);
}
