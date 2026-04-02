// --- Command Palette (Cmd+K / Ctrl+K) ---

import { escapeHtml } from "./html-utils.ts";
import { semanticSearch, type SearchResult } from "./semantic-search.ts";

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
let semanticSearchHandler: ((filePath: string) => void) | null = null;

/** Register a handler for `?` prefix semantic search in the command palette. */
export function setSemanticSearchHandler(handler: (filePath: string) => void) {
  semanticSearchHandler = handler;
}

export function registerCommand(cmd: Command) {
  if (!commands.some((c) => c.id === cmd.id)) {
    commands.push(cmd);
  }
}

export function registerCommands(cmds: Command[]) {
  for (const cmd of cmds) registerCommand(cmd);
}

/** Returns 0 if no match, 1–3 for fuzzy/substring/prefix match. */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  // Simple fuzzy: all query chars appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

function filterCommands(query: string): Command[] {
  if (!query) return commands.slice();
  const scored: { cmd: Command; score: number }[] = [];
  for (const cmd of commands) {
    const score = Math.max(fuzzyScore(query, cmd.label), fuzzyScore(query, cmd.category));
    if (score > 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
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
  input.placeholder = "Type a command… (? for semantic search)";

  const list = document.createElement("div");
  list.className = "command-palette-list";

  box.appendChild(input);
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let filtered = filterCommands("");
  let searchResults: SearchResult[] = [];
  let isSearchMode = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  renderResults(list, filtered);

  // Focus input after append
  requestAnimationFrame(() => input.focus());

  function renderSearchResults() {
    list.innerHTML = "";
    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      const docId = typeof r.id === "string" && r.id.includes("#") ? r.id.split("#")[0] : r.id;
      const item = document.createElement("div");
      item.className = "command-palette-item" + (i === selectedIndex ? " selected" : "");
      item.innerHTML = `
        <span class="command-palette-label">${escapeHtml(docId)}</span>
        <span class="command-palette-meta">
          <span class="command-palette-category">${(r.score * 100).toFixed(0)}%</span>
        </span>
      `;
      item.addEventListener("mouseenter", () => {
        selectedIndex = i;
        for (const el of list.children) el.classList.remove("selected");
        item.classList.add("selected");
      });
      item.addEventListener("click", () => {
        close();
        semanticSearchHandler?.(docId);
      });
      list.appendChild(item);
    }
    if (searchResults.length === 0 && input.value.length > 1) {
      list.innerHTML = '<div class="command-palette-empty">No results</div>';
    }
  }

  input.addEventListener("input", () => {
    selectedIndex = 0;
    const value = input.value;
    const wasSearchMode = isSearchMode;
    isSearchMode = value.startsWith("?") && semanticSearchHandler !== null;

    if (isSearchMode) {
      if (debounceTimer) clearTimeout(debounceTimer);
      const query = value.slice(1).trim();
      if (!query) {
        searchResults = [];
        renderSearchResults();
        return;
      }
      debounceTimer = setTimeout(async () => {
        try {
          searchResults = await semanticSearch(query);
          selectedIndex = 0;
          renderSearchResults();
        } catch {
          list.innerHTML = '<div class="command-palette-empty">Search error</div>';
        }
      }, 300);
    } else {
      if (wasSearchMode && debounceTimer) clearTimeout(debounceTimer);
      filtered = filterCommands(value);
      renderResults(list, filtered);
    }
  });

  input.addEventListener("keydown", (e) => {
    const items = isSearchMode ? searchResults : filtered;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      if (isSearchMode) renderSearchResults();
      else {
        updateSelection(list);
        scrollSelectedIntoView(list);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      if (isSearchMode) renderSearchResults();
      else {
        updateSelection(list);
        scrollSelectedIntoView(list);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isSearchMode) {
        if (searchResults[selectedIndex]) {
          const docId = searchResults[selectedIndex].id.split("#")[0];
          close();
          semanticSearchHandler?.(docId);
        }
      } else if (filtered[selectedIndex]) {
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
