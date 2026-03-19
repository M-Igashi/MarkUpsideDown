import { marked } from "marked";
import DOMPurify from "dompurify";
import { escapeHtml } from "./settings.ts";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- Storage ---

const STORAGE_KEY_COLLAPSED = "markupsidedown:claudeCollapsed";
const STORAGE_KEY_API_KEY = "markupsidedown:claudeApiKey";
const STORAGE_KEY_AUTH_MODE = "markupsidedown:claudeAuthMode"; // "oauth" | "apikey"
const STORAGE_KEY_PERMISSION = "markupsidedown:claudePermission";
const STORAGE_KEY_WIDTH = "markupsidedown:claudeWidth";

// --- Types ---

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string; // accumulated text
  toolUses: ToolUseBlock[];
  thinking: string;
  status: "streaming" | "done" | "error";
  costUsd?: number;
}

interface ToolUseBlock {
  id: string;
  name: string;
  input: string;
  status: "running" | "done" | "error";
}

// --- State ---

let panelEl: HTMLElement | null = null;
let messagesEl: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let statusIndicator: HTMLElement | null = null;

let messages: ChatMessage[] = [];
let isRunning = false;
let currentAssistantMsg: ChatMessage | null = null;
let getCwd: (() => string | null) | null = null;

// --- Public API ---

export function initClaudePanel(el: HTMLElement, callbacks: { getCwd: () => string | null }) {
  panelEl = el;
  getCwd = callbacks.getCwd;
  render();
  setupListeners();
}

export function isCollapsed(): boolean {
  return localStorage.getItem(STORAGE_KEY_COLLAPSED) !== "false";
}

export function togglePanel() {
  if (!panelEl) return;
  const collapsed = panelEl.classList.toggle("collapsed");
  localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
}

export function showPanel() {
  if (!panelEl) return;
  panelEl.classList.remove("collapsed");
  localStorage.setItem(STORAGE_KEY_COLLAPSED, "false");
  requestAnimationFrame(() => inputEl?.focus());
}

// --- Auth helpers ---

function getAuthMode(): string {
  return localStorage.getItem(STORAGE_KEY_AUTH_MODE) || "oauth";
}

function setAuthMode(mode: string) {
  localStorage.setItem(STORAGE_KEY_AUTH_MODE, mode);
}

function getApiKey(): string {
  return localStorage.getItem(STORAGE_KEY_API_KEY) || "";
}

function setApiKey(key: string) {
  if (key) {
    localStorage.setItem(STORAGE_KEY_API_KEY, key);
  } else {
    localStorage.removeItem(STORAGE_KEY_API_KEY);
  }
}

function getPermissionMode(): string {
  return localStorage.getItem(STORAGE_KEY_PERMISSION) || "default";
}

function setPermissionMode(mode: string) {
  localStorage.setItem(STORAGE_KEY_PERMISSION, mode);
}

function getSavedWidth(): number {
  const w = localStorage.getItem(STORAGE_KEY_WIDTH);
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
  `;
  panelEl.appendChild(header);

  statusIndicator = header.querySelector("#claude-status-indicator");

  // Messages area
  messagesEl = document.createElement("div");
  messagesEl.className = "claude-messages";
  panelEl.appendChild(messagesEl);

  // Render existing messages
  renderMessages();

  // Input area
  const inputArea = document.createElement("div");
  inputArea.className = "claude-input-area";

  inputEl = document.createElement("textarea");
  inputEl.className = "claude-input";
  inputEl.placeholder = "Ask Claude…";
  inputEl.rows = 1;
  inputArea.appendChild(inputEl);

  sendBtn = document.createElement("button");
  sendBtn.className = "claude-send-btn";
  sendBtn.textContent = "Send";
  sendBtn.title = "Send message (Enter)";
  inputArea.appendChild(sendBtn);

  panelEl.appendChild(inputArea);

  // Events
  sendBtn.addEventListener("click", handleSend);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea
  inputEl.addEventListener("input", () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
  });

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
    el.innerHTML = `<div class="claude-msg-content">${escapeHtml(msg.content)}</div>`;
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
    sendBtn.textContent = isRunning ? "Send" : "Start";
  }
}

// --- Actions ---

async function handleSend() {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text) return;

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
    content: text,
    toolUses: [],
    thinking: "",
    status: "done",
  };
  messages.push(userMsg);
  renderMessages();
  scrollToBottom();

  // Send to CLI
  try {
    await invoke("claude_send", { message: text });
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
      model: null,
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
  currentAssistantMsg = null;
  updateStatusIndicator();
}

function clearConversation() {
  messages = [];
  currentAssistantMsg = null;
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
    toolUses: [],
    thinking: "",
    status: "done",
  });
  renderMessages();
  scrollToBottom();
}

function scrollToBottom() {
  if (!messagesEl) return;
  requestAnimationFrame(() => {
    messagesEl!.scrollTop = messagesEl!.scrollHeight;
  });
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

  listen<{ reason: string }>("claude:stopped", () => {
    isRunning = false;
    currentAssistantMsg = null;
    updateStatusIndicator();
    if (messages.length > 0) {
      addSystemMessage("Claude process ended");
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
      toolUses: [],
      thinking: "",
      status: "streaming",
    };
    messages.push(currentAssistantMsg);
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
  }

  if (data.is_error) {
    addSystemMessage(`Error: ${data.result || "Unknown error"}`);
  }
}

function handleRateLimitEvent(data: any) {
  const info = data.rate_limit_info;
  if (info?.status === "rate_limited") {
    const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "soon";
    addSystemMessage(`Rate limited. Resets at ${resetsAt}`);
  }
}

// --- Settings Dialog ---

function showClaudeSettings() {
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";

  const authMode = getAuthMode();
  const apiKey = getApiKey();
  const permission = getPermissionMode();

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
