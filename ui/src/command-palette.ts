// --- Command Palette (Cmd+K / Ctrl+K) ---

import { escapeHtml } from "./html-utils.ts";

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  run: () => void;
}

const commands: Command[] = [];
let overlay: HTMLElement | null = null;
let selectedIndex = 0;

export function registerCommand(cmd: Command) {
  if (!commands.some((c) => c.id === cmd.id)) {
    commands.push(cmd);
  }
}

export function registerCommands(cmds: Command[]) {
  for (const cmd of cmds) registerCommand(cmd);
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  // Simple fuzzy: all query chars appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  // Exact prefix match scores highest
  if (t.startsWith(q)) return 3;
  // Contains as substring
  if (t.includes(q)) return 2;
  // Fuzzy match
  return 1;
}

function filterCommands(query: string): Command[] {
  if (!query) return commands.slice();
  return commands
    .filter((c) => fuzzyMatch(query, c.label) || fuzzyMatch(query, c.category))
    .sort((a, b) => {
      const sa = Math.max(fuzzyScore(query, a.label), fuzzyScore(query, a.category));
      const sb = Math.max(fuzzyScore(query, b.label), fuzzyScore(query, b.category));
      return sb - sa;
    });
}

function renderResults(list: HTMLElement, results: Command[]) {
  list.innerHTML = "";
  for (let i = 0; i < results.length; i++) {
    const cmd = results[i];
    const item = document.createElement("div");
    item.className = "command-palette-item" + (i === selectedIndex ? " selected" : "");
    item.innerHTML = `
      <span class="command-palette-label">${escapeHtml(cmd.label)}</span>
      <span class="command-palette-meta">
        ${cmd.shortcut ? `<kbd>${escapeHtml(cmd.shortcut)}</kbd>` : ""}
        <span class="command-palette-category">${escapeHtml(cmd.category)}</span>
      </span>
    `;
    item.addEventListener("mouseenter", () => {
      selectedIndex = i;
      for (const el of list.children) el.classList.remove("selected");
      item.classList.add("selected");
    });
    item.addEventListener("click", () => {
      close();
      cmd.run();
    });
    list.appendChild(item);
  }
}

function updateSelection(list: HTMLElement) {
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("selected", i === selectedIndex);
  }
}

function scrollSelectedIntoView(list: HTMLElement) {
  const sel = list.querySelector(".command-palette-item.selected") as HTMLElement | null;
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

export function open() {
  if (overlay) return;

  selectedIndex = 0;
  overlay = document.createElement("div");
  overlay.className = "command-palette-overlay";

  const box = document.createElement("div");
  box.className = "command-palette-box";

  const input = document.createElement("input");
  input.className = "command-palette-input";
  input.type = "text";
  input.placeholder = "Type a command…";

  const list = document.createElement("div");
  list.className = "command-palette-list";

  box.appendChild(input);
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let filtered = filterCommands("");
  renderResults(list, filtered);

  // Focus input after append
  requestAnimationFrame(() => input.focus());

  input.addEventListener("input", () => {
    selectedIndex = 0;
    filtered = filterCommands(input.value);
    renderResults(list, filtered);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      updateSelection(list);
      scrollSelectedIntoView(list);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection(list);
      scrollSelectedIntoView(list);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        close();
        filtered[selectedIndex].run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}

export function close() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

export function toggle() {
  if (overlay) close();
  else open();
}
