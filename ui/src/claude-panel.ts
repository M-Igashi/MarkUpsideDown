import { marked } from "marked";
import DOMPurify from "dompurify";
import { escapeHtml } from "./settings.ts";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- Storage ---

import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import {
  KEY_CLAUDE_COLLAPSED,
  KEY_CLAUDE_API_KEY,
  KEY_CLAUDE_AUTH_MODE,
  KEY_CLAUDE_PERMISSION,
  KEY_CLAUDE_MODEL,
  KEY_CLAUDE_WIDTH,
  KEY_CLAUDE_MESSAGES,
} from "./storage-keys.ts";
const MAX_PERSISTED_MESSAGES = 100;

// --- Types ---

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string; // accumulated text
  images: PastedImage[]; // inline images
  toolUses: ToolUseBlock[];
  thinking: string;
  status: "streaming" | "done" | "error";
  costUsd?: number;
}

interface PastedImage {
  dataUrl: string; // for display
  mediaType: string; // e.g. "image/png"
  base64: string; // raw base64 data
}

interface ToolUseBlock {
  id: string;
  name: string;
  input: string;
  status: "running" | "done" | "error";
}

interface AttachedContext {
  type: "file" | "selection";
  label: string; // display name (basename for files, "Selection" for selection)
  content: string; // file path or selected text
}

// --- State ---

let panelEl: HTMLElement | null = null;
let messagesEl: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let statusIndicator: HTMLElement | null = null;

let messages: ChatMessage[] = [];
let isRunning = false;
let isStreaming = false;
let currentAssistantMsg: ChatMessage | null = null;
let getCwd: (() => string | null) | null = null;
let getActiveFilePath: (() => string | null) | null = null;
let rateLimitResetTime: number | null = null;
let rateLimitInterval: number | null = null;
let pendingImages: PastedImage[] = [];
let imagePreviewEl: HTMLElement | null = null;
let onFileEditedCallback: ((filePath: string) => void) | null = null;
let attachedContexts: AttachedContext[] = [];
let contextChipsEl: HTMLElement | null = null;
let contextMenuEl: HTMLElement | null = null;
let getEditorSelection: (() => string | null) | null = null;
let listDirectory:
  | ((path: string) => Promise<{ name: string; path: string; is_dir: boolean }[]>)
  | null = null;

// --- Public API ---

export function initClaudePanel(
  el: HTMLElement,
  callbacks: {
    getCwd: () => string | null;
    getActiveFilePath: () => string | null;
    onFileEdited?: (filePath: string) => void;
    getEditorSelection?: () => string | null;
    listDirectory?: (path: string) => Promise<{ name: string; path: string; is_dir: boolean }[]>;
  },
) {
  panelEl = el;
  getCwd = callbacks.getCwd;
  getActiveFilePath = callbacks.getActiveFilePath;
  onFileEditedCallback = callbacks.onFileEdited ?? null;
  getEditorSelection = callbacks.getEditorSelection ?? null;
  listDirectory = callbacks.listDirectory ?? null;
  messages = loadMessages();
  render();
  setupListeners();
}

export function isCollapsed(): boolean {
  return getStorageBool(KEY_CLAUDE_COLLAPSED, true);
}

export function togglePanel() {
  if (!panelEl) return;
  const collapsed = panelEl.classList.toggle("collapsed");
  setStorageBool(KEY_CLAUDE_COLLAPSED, collapsed);
}

export function showPanel() {
  if (!panelEl) return;
  panelEl.classList.remove("collapsed");
  setStorageBool(KEY_CLAUDE_COLLAPSED, false);
  requestAnimationFrame(() => inputEl?.focus());
}

// --- Auth helpers ---

function getAuthMode(): string {
  return localStorage.getItem(KEY_CLAUDE_AUTH_MODE) || "oauth";
}

function setAuthMode(mode: string) {
  localStorage.setItem(KEY_CLAUDE_AUTH_MODE, mode);
}

function getApiKey(): string {
  return localStorage.getItem(KEY_CLAUDE_API_KEY) || "";
}

function setApiKey(key: string) {
  if (key) {
    localStorage.setItem(KEY_CLAUDE_API_KEY, key);
  } else {
    localStorage.removeItem(KEY_CLAUDE_API_KEY);
  }
}

function getPermissionMode(): string {
  return localStorage.getItem(KEY_CLAUDE_PERMISSION) || "acceptEdits";
}

function setPermissionMode(mode: string) {
  localStorage.setItem(KEY_CLAUDE_PERMISSION, mode);
}

function getModel(): string {
  return localStorage.getItem(KEY_CLAUDE_MODEL) || "";
}

function setModel(model: string) {
  if (model) {
    localStorage.setItem(KEY_CLAUDE_MODEL, model);
  } else {
    localStorage.removeItem(KEY_CLAUDE_MODEL);
  }
}

function getSavedWidth(): number {
  const w = localStorage.getItem(KEY_CLAUDE_WIDTH);
  return w ? parseInt(w, 10) : 380;
}

// --- Render ---

function render() {
  if (!panelEl) return;

  const collapsed = isCollapsed();
  if (collapsed) panelEl.classList.add("collapsed");

  const width = getSavedWidth();
  panelEl.style.width = `${width}px`;

  panelEl.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "claude-header";
  header.innerHTML = `
    <span class="claude-title">Claude</span>
    <span class="claude-status" id="claude-status-indicator"></span>
    <span class="spacer"></span>
    <button class="claude-header-btn" id="claude-settings-btn" title="Settings">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="1.5"/><path d="M7 2v1.5M7 10.5V12M2 7h1.5M10.5 7H12M3.5 3.5l1 1M9.5 9.5l1 1M10.5 3.5l-1 1M4.5 9.5l-1 1"/></svg>
    </button>
    <button class="claude-header-btn" id="claude-clear-btn" title="Clear conversation">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h8M5.5 3V2h3v1M4 3v8.5h6V3"/></svg>
    </button>
    <button class="claude-header-btn" id="claude-fold-btn" title="Collapse Claude Panel (⌘4)">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l4 4-4 4"/></svg>
    </button>
  `;
  panelEl.appendChild(header);

  statusIndicator = header.querySelector("#claude-status-indicator");
  header.querySelector("#claude-fold-btn")?.addEventListener("click", togglePanel);

  // Messages area
  messagesEl = document.createElement("div");
  messagesEl.className = "claude-messages";
  panelEl.appendChild(messagesEl);

  // Render existing messages
  renderMessages();

  // Input area
  const inputArea = document.createElement("div");
  inputArea.className = "claude-input-area";

  // Context chips (above textarea row)
  contextChipsEl = document.createElement("div");
  contextChipsEl.className = "claude-context-chips";
  contextChipsEl.style.display = "none";
  inputArea.appendChild(contextChipsEl);

  // Textarea row (+ button, textarea, send button)
  const inputRow = document.createElement("div");
  inputRow.className = "claude-input-row";

  const addCtxBtn = document.createElement("button");
  addCtxBtn.className = "claude-add-context-btn";
  addCtxBtn.title = "Attach context (@)";
  addCtxBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>`;
  addCtxBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(addCtxBtn);
  });
  inputRow.appendChild(addCtxBtn);

  inputEl = document.createElement("textarea");
  inputEl.className = "claude-input";
  inputEl.placeholder = "Ask Claude… (@ to attach context)";
  inputEl.rows = 3;
  inputRow.appendChild(inputEl);

  // Image preview area (between textarea and send button)
  imagePreviewEl = document.createElement("div");
  imagePreviewEl.className = "claude-image-preview";
  inputRow.appendChild(imagePreviewEl);

  sendBtn = document.createElement("button");
  sendBtn.className = "claude-send-btn";
  sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 13V3l11 5-11 5z" fill="currentColor"/></svg>`;
  sendBtn.title = "Send message (Enter / Shift+Enter for newline)";
  inputRow.appendChild(sendBtn);

  inputArea.appendChild(inputRow);
  panelEl.appendChild(inputArea);

  // Events
  sendBtn.addEventListener("click", () => {
    if (isStreaming) {
      stopClaude();
    } else {
      handleSend();
    }
  });

  // IME composition tracking: WebKit fires keydown with isComposing=false
  // right after compositionend, so we consume exactly that one Enter keyup.
  let suppressNextEnterUp = false;
  inputEl.addEventListener("compositionend", () => {
    suppressNextEnterUp = true;
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey) return; // Shift+Enter = newline
    e.preventDefault();
    if (suppressNextEnterUp) {
      suppressNextEnterUp = false;
      return; // Skip the Enter that finalized IME
    }
    handleSend();
  });

  // Auto-resize textarea
  inputEl.addEventListener("input", () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";

    // Detect @ trigger for context menu
    const pos = inputEl.selectionStart;
    const val = inputEl.value;
    if (pos > 0 && val[pos - 1] === "@") {
      // Only trigger if @ is at start or preceded by whitespace
      if (pos === 1 || /\s/.test(val[pos - 2])) {
        showContextMenu(addCtxBtn);
      }
    }
  });

  // Image paste handler
  inputEl.addEventListener("paste", handlePaste);

  header.querySelector("#claude-settings-btn")!.addEventListener("click", showClaudeSettings);
  header.querySelector("#claude-clear-btn")!.addEventListener("click", clearConversation);

  updateStatusIndicator();
}

function renderMessages() {
  if (!messagesEl) return;

  // Keep scroll position info before re-render
  const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;

  messagesEl.innerHTML = "";

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "claude-empty";
    empty.innerHTML = `
      <div class="claude-empty-icon">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
          <path d="M16 4C9.4 4 4 9.4 4 16s5.4 12 12 12 12-5.4 12-12S22.6 4 16 4z"/>
          <path d="M11 13h0M21 13h0M12 20s1.5 2 4 2 4-2 4-2"/>
        </svg>
      </div>
      <div class="claude-empty-text">Start a conversation with Claude</div>
      <div class="claude-empty-hint">Claude has access to your project files via MCP</div>
    `;
    messagesEl.appendChild(empty);
    return;
  }

  for (const msg of messages) {
    messagesEl.appendChild(renderMessage(msg));
  }

  if (wasAtBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function renderMessage(msg: ChatMessage): HTMLElement {
  const el = document.createElement("div");
  el.className = `claude-msg claude-msg-${msg.role}`;
  el.dataset.id = msg.id;

  if (msg.role === "user") {
    let userHtml = "";
    if (msg.images?.length > 0) {
      userHtml += '<div class="claude-msg-images">';
      for (const img of msg.images) {
        userHtml += `<img class="claude-msg-image" src="${img.dataUrl}" />`;
      }
      userHtml += "</div>";
    }
    userHtml += `<div class="claude-msg-content">${escapeHtml(msg.content)}</div>`;
    el.innerHTML = userHtml;
  } else if (msg.role === "assistant") {
    let html = "";

    // Thinking block
    if (msg.thinking) {
      html += `<details class="claude-thinking"><summary>Thinking…</summary><div class="claude-thinking-content">${escapeHtml(msg.thinking)}</div></details>`;
    }

    // Tool uses
    for (const tool of msg.toolUses) {
      const statusClass =
        tool.status === "running"
          ? "claude-tool-running"
          : tool.status === "error"
            ? "claude-tool-error"
            : "claude-tool-done";
      html += `<div class="claude-tool ${statusClass}">
        <div class="claude-tool-header">
          <span class="claude-tool-icon">${tool.status === "running" ? "⟳" : tool.status === "error" ? "✗" : "✓"}</span>
          <span class="claude-tool-name">${escapeHtml(tool.name)}</span>
        </div>
        ${tool.input ? `<pre class="claude-tool-input">${escapeHtml(truncate(tool.input, 500))}</pre>` : ""}
      </div>`;
    }

    // Main content (Markdown rendered)
    if (msg.content) {
      const rawHtml = marked.parse(msg.content, { async: false }) as string;
      const clean = DOMPurify.sanitize(rawHtml);
      html += `<div class="claude-msg-content claude-markdown">${clean}</div>`;
    }

    // Status indicator
    if (msg.status === "streaming") {
      html += `<span class="claude-cursor">▊</span>`;
    }
    if (msg.costUsd !== undefined) {
      html += `<div class="claude-msg-meta">$${msg.costUsd.toFixed(4)}</div>`;
    }

    el.innerHTML = html;
  } else {
    // System message
    el.innerHTML = `<div class="claude-msg-content claude-msg-system-content">${escapeHtml(msg.content)}</div>`;
  }

  return el;
}

function updateMessageInPlace(msg: ChatMessage) {
  if (!messagesEl) return;
  const existing = messagesEl.querySelector(`[data-id="${msg.id}"]`);
  if (existing) {
    const wasAtBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    const newEl = renderMessage(msg);
    existing.replaceWith(newEl);
    if (wasAtBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } else {
    renderMessages();
  }
}

function updateStatusIndicator() {
  if (!statusIndicator) return;
  if (isRunning) {
    statusIndicator.className = "claude-status claude-status-active";
    statusIndicator.title = "Connected";
  } else {
    statusIndicator.className = "claude-status claude-status-inactive";
    statusIndicator.title = "Not running";
  }
  if (sendBtn) {
    if (isStreaming) {
      sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="12" height="12" rx="2" fill="currentColor"/></svg>`;
      sendBtn.title = "Stop Claude";
    } else {
      sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 13V3l11 5-11 5z" fill="currentColor"/></svg>`;
      sendBtn.title = isRunning
        ? "Send message (Enter / Shift+Enter for newline)"
        : "Start Claude session";
    }
  }
}

// --- Actions ---

async function handleSend() {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text && pendingImages.length === 0) return;

  const images = [...pendingImages];
  const contexts = [...attachedContexts];
  pendingImages = [];
  attachedContexts = [];
  renderImagePreview();
  renderContextChips();

  inputEl.value = "";
  inputEl.style.height = "auto";

  // If not running, start Claude first
  if (!isRunning) {
    try {
      await startClaude();
    } catch (e) {
      addSystemMessage(`Failed to start Claude: ${e}`);
      return;
    }
    // Wait a short moment for init
    await new Promise((r) => setTimeout(r, 300));
  }

  // Add user message to UI
  const userMsg: ChatMessage = {
    id: `user-${Date.now()}`,
    role: "user",
    content: text || (images.length > 0 ? "(image)" : ""),
    images,
    toolUses: [],
    thinking: "",
    status: "done",
  };
  messages.push(userMsg);
  persistMessages();
  renderMessages();
  scrollToBottom();

  // Send to CLI with active file context and attached contexts
  try {
    const imgPayload =
      images.length > 0
        ? images.map((img) => ({ mediaType: img.mediaType, data: img.base64 }))
        : null;
    let msgText = text || "Describe this image.";

    // Prepend attached contexts
    const contextParts: string[] = [];
    const activeFile = getActiveFilePath?.();
    if (activeFile) {
      contextParts.push(`[Active file: ${activeFile}]`);
    }
    for (const ctx of contexts) {
      if (ctx.type === "file") {
        contextParts.push(`[Attached file: ${ctx.content}]`);
      } else if (ctx.type === "selection") {
        contextParts.push(`[Editor selection:\n${ctx.content}\n]`);
      }
    }
    if (contextParts.length > 0) {
      msgText = contextParts.join("\n") + "\n" + msgText;
    }
    await invoke("claude_send", { message: msgText, images: imgPayload });
  } catch (e) {
    addSystemMessage(`Send failed: ${e}`);
  }
}

async function startClaude() {
  const cwd = getCwd?.() || null;
  const authMode = getAuthMode();
  const apiKey = authMode === "apikey" ? getApiKey() : null;

  if (authMode === "apikey" && !apiKey) {
    showClaudeSettings();
    throw new Error("API key not configured");
  }

  await invoke("claude_start", {
    options: {
      cwd,
      apiKey: apiKey || null,
      permissionMode: getPermissionMode() || null,
      model: getModel() || null,
    },
  });
  isRunning = true;
  updateStatusIndicator();
}

async function stopClaude() {
  try {
    await invoke("claude_stop");
  } catch {
    // ignore
  }
  isRunning = false;
  isStreaming = false;
  currentAssistantMsg = null;
  updateStatusIndicator();
}

function clearConversation() {
  messages = [];
  currentAssistantMsg = null;
  attachedContexts = [];
  renderContextChips();
  localStorage.removeItem(KEY_CLAUDE_MESSAGES);
  renderMessages();
  if (isRunning) {
    stopClaude();
  }
}

function addSystemMessage(text: string) {
  messages.push({
    id: `sys-${Date.now()}`,
    role: "system",
    content: text,
    images: [],
    toolUses: [],
    thinking: "",
    status: "done",
  });
  persistMessages();
  renderMessages();
  scrollToBottom();
}

function scrollToBottom() {
  if (!messagesEl) return;
  requestAnimationFrame(() => {
    messagesEl!.scrollTop = messagesEl!.scrollHeight;
  });
}

// --- Image Paste ---

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Extract base64 data after the comma
      const base64 = dataUrl.split(",")[1];
      pendingImages.push({ dataUrl, mediaType: file.type, base64 });
      renderImagePreview();
    };
    reader.readAsDataURL(file);
  }
}

function renderImagePreview() {
  if (!imagePreviewEl) return;
  imagePreviewEl.innerHTML = "";
  if (pendingImages.length === 0) {
    imagePreviewEl.style.display = "none";
    return;
  }
  imagePreviewEl.style.display = "flex";
  for (let i = 0; i < pendingImages.length; i++) {
    const thumb = document.createElement("div");
    thumb.className = "claude-image-thumb";
    thumb.innerHTML = `<img src="${pendingImages[i].dataUrl}" /><button class="claude-image-remove" data-idx="${i}" title="Remove">&times;</button>`;
    thumb.querySelector("button")!.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImagePreview();
    });
    imagePreviewEl.appendChild(thumb);
  }
}

// --- Context Menu ---

function removeAtTrigger() {
  if (!inputEl) return;
  const pos = inputEl.selectionStart;
  const val = inputEl.value;
  if (pos > 0 && val[pos - 1] === "@") {
    inputEl.value = val.slice(0, pos - 1) + val.slice(pos);
    inputEl.selectionStart = inputEl.selectionEnd = pos - 1;
  }
}

function dismissContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

function showContextMenu(anchor: HTMLElement) {
  dismissContextMenu();
  const menu = document.createElement("div");
  menu.className = "claude-context-menu";

  const items: { label: string; icon: string; action: () => void }[] = [
    {
      label: "File",
      icon: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1.5h5l3 3V12.5H3z"/><path d="M8 1.5v3h3"/></svg>`,
      action: () => {
        dismissContextMenu();
        removeAtTrigger();
        showFilePicker();
      },
    },
    {
      label: "Selection",
      icon: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 3h6M4 7h6M4 11h3"/></svg>`,
      action: () => {
        dismissContextMenu();
        removeAtTrigger();
        attachSelection();
      },
    },
  ];

  for (const item of items) {
    const row = document.createElement("button");
    row.className = "claude-context-menu-item";
    row.innerHTML = `${item.icon}<span>${item.label}</span>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      item.action();
    });
    menu.appendChild(row);
  }

  // Position above the anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${rect.left}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;

  document.body.appendChild(menu);
  contextMenuEl = menu;

  // Close on outside click
  const closeHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      dismissContextMenu();
      document.removeEventListener("click", closeHandler);
    }
  };
  // Delay so the current click doesn't immediately close it
  requestAnimationFrame(() => document.addEventListener("click", closeHandler));
}

function attachSelection() {
  const sel = getEditorSelection?.();
  if (!sel) return;
  // Avoid duplicates
  if (attachedContexts.some((c) => c.type === "selection")) {
    // Replace existing selection
    attachedContexts = attachedContexts.filter((c) => c.type !== "selection");
  }
  const lines = sel.split("\n");
  const preview =
    lines.length > 1 ? `${lines[0].slice(0, 30)}… (${lines.length} lines)` : sel.slice(0, 40);
  attachedContexts.push({ type: "selection", label: preview, content: sel });
  renderContextChips();
}

async function showFilePicker() {
  const root = getCwd?.();
  if (!root || !listDirectory) return;

  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  overlay.innerHTML = `
    <div class="claude-file-picker">
      <input type="text" class="claude-file-picker-input" placeholder="Search files…" autofocus />
      <div class="claude-file-picker-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const searchInput = overlay.querySelector<HTMLInputElement>(".claude-file-picker-input")!;
  const listEl = overlay.querySelector<HTMLElement>(".claude-file-picker-list")!;
  let allFiles: { name: string; path: string; relativePath: string }[] = [];
  let selectedIndex = 0;

  // Recursively collect files (limit depth to keep it fast)
  async function collectFiles(dir: string, depth: number) {
    if (depth > 5) return;
    try {
      const entries = await listDirectory!(dir);
      for (const entry of entries) {
        if (entry.is_dir) {
          // Skip hidden dirs and common large dirs
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "target" ||
            entry.name === "dist"
          )
            continue;
          await collectFiles(entry.path, depth + 1);
        } else {
          allFiles.push({
            name: entry.name,
            path: entry.path,
            relativePath: entry.path.startsWith(root + "/")
              ? entry.path.slice(root.length + 1)
              : entry.name,
          });
        }
      }
    } catch {
      // Permission error etc. — skip
    }
  }

  listEl.innerHTML = `<div class="claude-file-picker-loading">Loading…</div>`;
  await collectFiles(root, 0);
  renderFileList("");

  function renderFileList(query: string) {
    const q = query.toLowerCase();
    const filtered = q
      ? allFiles.filter((f) => f.relativePath.toLowerCase().includes(q))
      : allFiles;
    const display = filtered.slice(0, 50);
    selectedIndex = 0;

    listEl.innerHTML = "";
    if (display.length === 0) {
      listEl.innerHTML = `<div class="claude-file-picker-empty">No files found</div>`;
      return;
    }
    for (let i = 0; i < display.length; i++) {
      const item = document.createElement("div");
      item.className = "claude-file-picker-item" + (i === 0 ? " selected" : "");
      item.textContent = display[i].relativePath;
      item.addEventListener("click", () => pickFile(display[i]));
      item.addEventListener("mouseenter", () => {
        listEl.querySelector(".selected")?.classList.remove("selected");
        item.classList.add("selected");
        selectedIndex = i;
      });
      listEl.appendChild(item);
    }
  }

  function pickFile(file: { name: string; path: string; relativePath: string }) {
    // Avoid duplicates
    if (!attachedContexts.some((c) => c.type === "file" && c.content === file.path)) {
      attachedContexts.push({ type: "file", label: file.relativePath, content: file.path });
      renderContextChips();
    }
    overlay.remove();
    inputEl?.focus();
  }

  searchInput.addEventListener("input", () => renderFileList(searchInput.value));
  searchInput.addEventListener("keydown", (e) => {
    const items = listEl.querySelectorAll<HTMLElement>(".claude-file-picker-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      items.forEach((it, i) => it.classList.toggle("selected", i === selectedIndex));
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      items.forEach((it, i) => it.classList.toggle("selected", i === selectedIndex));
      items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const visibleFiles = allFiles
        .filter((f) => f.relativePath.toLowerCase().includes(searchInput.value.toLowerCase()))
        .slice(0, 50);
      if (visibleFiles[selectedIndex]) pickFile(visibleFiles[selectedIndex]);
    } else if (e.key === "Escape") {
      overlay.remove();
      inputEl?.focus();
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
      inputEl?.focus();
    }
  });

  requestAnimationFrame(() => searchInput.focus());
}

function renderContextChips() {
  if (!contextChipsEl) return;
  if (attachedContexts.length === 0) {
    contextChipsEl.style.display = "none";
    contextChipsEl.innerHTML = "";
    return;
  }
  contextChipsEl.style.display = "flex";
  contextChipsEl.innerHTML = "";
  for (let i = 0; i < attachedContexts.length; i++) {
    const ctx = attachedContexts[i];
    const chip = document.createElement("span");
    chip.className = `claude-context-chip claude-context-chip-${ctx.type}`;
    const icon =
      ctx.type === "file"
        ? `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 1.5h5l3 3V12.5H3z"/><path d="M8 1.5v3h3"/></svg>`
        : `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 3h6M4 7h6M4 11h3"/></svg>`;
    chip.innerHTML = `${icon}<span class="claude-context-chip-label">${escapeHtml(ctx.label)}</span><button class="claude-context-chip-remove" title="Remove">&times;</button>`;
    chip.querySelector("button")!.addEventListener("click", () => {
      attachedContexts.splice(i, 1);
      renderContextChips();
    });
    contextChipsEl.appendChild(chip);
  }
}

function showRestartButton() {
  if (!messagesEl) return;
  // Remove existing restart bar if any
  messagesEl.querySelector(".claude-restart-bar")?.remove();
  const bar = document.createElement("div");
  bar.className = "claude-restart-bar";
  const btn = document.createElement("button");
  btn.className = "claude-restart-btn";
  btn.textContent = "Restart Claude";
  btn.addEventListener("click", async () => {
    bar.remove();
    try {
      await startClaude();
      addSystemMessage("Claude restarted. Send a message to continue.");
    } catch (e) {
      addSystemMessage(`Failed to restart: ${e}`);
    }
  });
  bar.appendChild(btn);
  messagesEl.appendChild(bar);
  scrollToBottom();
}

// --- Event Listeners ---

function setupListeners() {
  // Catch-all event listener
  listen<{ event_type: string; data: any }>("claude:event", (event) => {
    const { event_type, data } = event.payload;

    switch (event_type) {
      case "system":
        handleSystemEvent(data);
        break;
      case "assistant":
        handleAssistantEvent(data);
        break;
      case "result":
        handleResultEvent(data);
        break;
      case "rate_limit_event":
        handleRateLimitEvent(data);
        break;
    }
  });

  listen<{ reason: string; exit_code?: number | null }>("claude:stopped", (event) => {
    const wasRunning = isRunning;
    isRunning = false;
    isStreaming = false;
    // Mark any streaming message as error
    if (currentAssistantMsg && currentAssistantMsg.status === "streaming") {
      currentAssistantMsg.status = "error";
      updateMessageInPlace(currentAssistantMsg);
    }
    currentAssistantMsg = null;
    updateStatusIndicator();
    if (wasRunning) {
      const exitCode = event.payload.exit_code;
      const detail = exitCode !== null && exitCode !== undefined ? ` (exit ${exitCode})` : "";
      addSystemMessage(`Claude process ended${detail}`);
      showRestartButton();
    }
  });

  listen<{ message: string }>("claude:stderr", (event) => {
    const msg = event.payload.message;
    // Filter out noise, only show meaningful errors
    if (msg && !msg.startsWith("Warning:")) {
      console.warn("[claude stderr]", msg);
    }
  });
}

function handleSystemEvent(data: any) {
  isRunning = true;
  updateStatusIndicator();
  const model = data.model || "unknown";
  const tools = data.tools?.length || 0;
  addSystemMessage(`Connected (${model}, ${tools} tools)`);
}

function handleAssistantEvent(data: any) {
  const message = data.message;
  if (!message) return;

  const content = message.content;
  if (!Array.isArray(content)) return;

  // Create or reuse current assistant message
  if (!currentAssistantMsg) {
    currentAssistantMsg = {
      id: `asst-${Date.now()}`,
      role: "assistant",
      content: "",
      images: [],
      toolUses: [],
      thinking: "",
      status: "streaming",
    };
    messages.push(currentAssistantMsg);
    isStreaming = true;
    updateStatusIndicator();
  }

  // Parse content blocks
  for (const block of content) {
    if (block.type === "text") {
      currentAssistantMsg.content = block.text || "";
    } else if (block.type === "thinking") {
      currentAssistantMsg.thinking = block.thinking || "";
    } else if (block.type === "tool_use") {
      const existing = currentAssistantMsg.toolUses.find((t) => t.id === block.id);
      if (existing) {
        existing.input = JSON.stringify(block.input, null, 2);
      } else {
        currentAssistantMsg.toolUses.push({
          id: block.id,
          name: block.name,
          input: JSON.stringify(block.input, null, 2),
          status: "running",
        });
      }
    } else if (block.type === "tool_result") {
      // Mark tool as done
      const tool = currentAssistantMsg.toolUses.find((t) => t.id === block.tool_use_id);
      if (tool) {
        tool.status = block.is_error ? "error" : "done";
        // Notify when file-editing tools complete successfully
        if (!block.is_error && onFileEditedCallback) {
          const FILE_TOOLS = ["Edit", "Write", "NotebookEdit"];
          if (FILE_TOOLS.includes(tool.name)) {
            try {
              const input = JSON.parse(tool.input);
              if (input.file_path) onFileEditedCallback(input.file_path);
            } catch {
              // input parse failure — ignore
            }
          }
        }
      }
    }
  }

  // Check if message is complete
  if (message.stop_reason) {
    currentAssistantMsg.status = "done";
    // Mark all running tools as done
    for (const tool of currentAssistantMsg.toolUses) {
      if (tool.status === "running") tool.status = "done";
    }
  }

  updateMessageInPlace(currentAssistantMsg);
}

function handleResultEvent(data: any) {
  if (currentAssistantMsg) {
    currentAssistantMsg.status = "done";
    if (data.total_cost_usd) {
      currentAssistantMsg.costUsd = data.total_cost_usd;
    }
    // Mark all running tools as done
    for (const tool of currentAssistantMsg.toolUses) {
      if (tool.status === "running") tool.status = "done";
    }
    updateMessageInPlace(currentAssistantMsg);
    currentAssistantMsg = null;
    isStreaming = false;
    updateStatusIndicator();
    persistMessages();
  }

  if (data.is_error) {
    addSystemMessage(`Error: ${data.result || "Unknown error"}`);
  }
}

function handleRateLimitEvent(data: any) {
  const info = data.rate_limit_info;
  if (info?.status === "rate_limited") {
    const resetsAtMs = info.resetsAt ? info.resetsAt * 1000 : Date.now() + 60_000;
    startRateLimitCountdown(resetsAtMs);
  }
}

function startRateLimitCountdown(resetsAtMs: number) {
  clearRateLimitCountdown();
  rateLimitResetTime = resetsAtMs;
  renderRateLimitBanner();
  rateLimitInterval = window.setInterval(() => {
    const remaining = (rateLimitResetTime || 0) - Date.now();
    if (remaining <= 0) {
      clearRateLimitCountdown();
      removeRateLimitBanner();
      addSystemMessage("Rate limit expired. You can continue.");
      return;
    }
    updateCountdownDisplay(remaining);
  }, 1000);
}

function clearRateLimitCountdown() {
  if (rateLimitInterval !== null) {
    clearInterval(rateLimitInterval);
    rateLimitInterval = null;
  }
  rateLimitResetTime = null;
}

function renderRateLimitBanner() {
  if (!messagesEl) return;
  removeRateLimitBanner();
  const banner = document.createElement("div");
  banner.className = "claude-rate-limit-bar";
  const remaining = (rateLimitResetTime || 0) - Date.now();
  banner.innerHTML = `<span class="claude-rate-limit-text">Rate limited — resuming in <span class="claude-countdown">${formatCountdown(remaining)}</span></span>`;
  messagesEl.appendChild(banner);
  scrollToBottom();
}

function removeRateLimitBanner() {
  messagesEl?.querySelector(".claude-rate-limit-bar")?.remove();
}

function updateCountdownDisplay(remainingMs: number) {
  const el = messagesEl?.querySelector(".claude-countdown");
  if (el) el.textContent = formatCountdown(remainingMs);
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

// --- Settings Dialog ---

function showClaudeSettings() {
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";

  const authMode = getAuthMode();
  const apiKey = getApiKey();
  const permission = getPermissionMode();
  const model = getModel();

  overlay.innerHTML = `
    <div class="claude-settings-box">
      <h3>Claude Settings</h3>
      <div class="claude-settings-section">
        <label class="claude-settings-label">Authentication</label>
        <div class="claude-settings-radio-group">
          <label><input type="radio" name="claude-auth" value="oauth" ${authMode === "oauth" ? "checked" : ""}> OAuth (Claude Code login)</label>
          <label><input type="radio" name="claude-auth" value="apikey" ${authMode === "apikey" ? "checked" : ""}> API Key</label>
        </div>
      </div>
      <div class="claude-settings-section" id="claude-apikey-section" style="display:${authMode === "apikey" ? "block" : "none"}">
        <label class="claude-settings-label">API Key</label>
        <input type="password" id="claude-apikey-input" class="claude-settings-input" value="${escapeHtml(apiKey)}" placeholder="sk-ant-..." />
      </div>
      <div class="claude-settings-section">
        <label class="claude-settings-label">Permission Mode</label>
        <select id="claude-permission-select" class="claude-settings-input">
          <option value="default" ${permission === "default" ? "selected" : ""}>Default (ask for permission)</option>
          <option value="acceptEdits" ${permission === "acceptEdits" ? "selected" : ""}>Accept Edits</option>
          <option value="bypassPermissions" ${permission === "bypassPermissions" ? "selected" : ""}>Bypass All Permissions</option>
          <option value="plan" ${permission === "plan" ? "selected" : ""}>Plan Mode</option>
        </select>
      </div>
      <div class="claude-settings-section">
        <label class="claude-settings-label">Model</label>
        <select id="claude-model-select" class="claude-settings-input">
          <option value="" ${!model ? "selected" : ""}>Default</option>
          <option value="sonnet" ${model === "sonnet" ? "selected" : ""}>Sonnet</option>
          <option value="haiku" ${model === "haiku" ? "selected" : ""}>Haiku</option>
          <option value="opus" ${model === "opus" ? "selected" : ""}>Opus</option>
        </select>
      </div>
      <div class="claude-settings-actions">
        <button id="claude-settings-cancel">Cancel</button>
        <button id="claude-settings-save" class="primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Toggle API key section
  const radios = overlay.querySelectorAll<HTMLInputElement>('input[name="claude-auth"]');
  const apiKeySection = overlay.querySelector("#claude-apikey-section") as HTMLElement;
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      apiKeySection.style.display = radio.value === "apikey" ? "block" : "none";
    });
  }

  overlay.querySelector("#claude-settings-cancel")!.addEventListener("click", () => {
    overlay.remove();
  });

  overlay.querySelector("#claude-settings-save")!.addEventListener("click", () => {
    const selected = overlay.querySelector<HTMLInputElement>(
      'input[name="claude-auth"]:checked',
    )!.value;
    setAuthMode(selected);

    const key = (overlay.querySelector("#claude-apikey-input") as HTMLInputElement).value.trim();
    setApiKey(key);

    const perm = (overlay.querySelector("#claude-permission-select") as HTMLSelectElement).value;
    setPermissionMode(perm);

    const selectedModel = (overlay.querySelector("#claude-model-select") as HTMLSelectElement)
      .value;
    setModel(selectedModel);

    overlay.remove();

    // Restart Claude if running with new settings
    if (isRunning) {
      stopClaude().then(() => addSystemMessage("Settings changed. Send a message to reconnect."));
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// --- Helpers ---

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// --- Session Persistence ---

function persistMessages() {
  const toSave = messages.filter((m) => m.status !== "streaming").slice(-MAX_PERSISTED_MESSAGES);
  try {
    localStorage.setItem(KEY_CLAUDE_MESSAGES, JSON.stringify(toSave));
  } catch {
    // Storage full — silently fail
  }
}

function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(KEY_CLAUDE_MESSAGES);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
