import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import { load, type Store } from "@tauri-apps/plugin-store";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- Constants ---

const STORAGE_KEY_COLLAPSED = "markupsidedown:claudePanelCollapsed";
const STORAGE_KEY_WIDTH = "markupsidedown:claudePanelWidth";
const STORAGE_KEY_AUTH_MODE = "markupsidedown:claudeAuthMode";
const STORE_KEY_API_KEY = "claudeApiKey";

// --- Secure store for sensitive data ---

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load("claude-secrets.json", { autoSave: true });
  }
  return storePromise;
}

async function getApiKey(): Promise<string | undefined> {
  const store = await getStore();
  return ((await store.get<string>(STORE_KEY_API_KEY)) as string | undefined) || undefined;
}

async function setApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set(STORE_KEY_API_KEY, key);
}

async function removeApiKey(): Promise<void> {
  const store = await getStore();
  await store.delete(STORE_KEY_API_KEY);
}
const DEFAULT_WIDTH = 420;
const MAX_TABS = 5;

// --- Types ---

interface Session {
  id: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  resizeObserver: ResizeObserver;
  containerEl: HTMLElement;
  isSpawned: boolean;
  label: string;
  dataDisposable: { dispose(): void } | null;
}

// --- State ---

let container: HTMLElement;
let getCwd: () => string | null;
let getMcpBinaryPath: () => Promise<string>;
let getWorkerUrl: () => string;

const sessions: Map<string, Session> = new Map();
let activeSessionId: string | null = null;
let unlistenData: (() => void) | null = null;
let unlistenExit: (() => void) | null = null;
let nextTabNumber = 1;

// xterm modules cached after first lazy load
let xtermModules: {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
  WebglAddon?: typeof import("@xterm/addon-webgl").WebglAddon;
} | null = null;

// --- Public API ---

export function initClaudePanel(
  el: HTMLElement,
  opts: {
    getCwd: () => string | null;
    getMcpBinaryPath: () => Promise<string>;
    getWorkerUrl: () => string;
  },
) {
  container = el;
  getCwd = opts.getCwd;
  getMcpBinaryPath = opts.getMcpBinaryPath;
  getWorkerUrl = opts.getWorkerUrl;

  migrateApiKeyFromLocalStorage();
  renderPanel();
  setupGlobalListeners();
}

/** Migrate API key from localStorage to secure store (one-time) */
async function migrateApiKeyFromLocalStorage() {
  const OLD_KEY = "markupsidedown:claudeApiKey";
  const legacyKey = localStorage.getItem(OLD_KEY);
  if (legacyKey) {
    await setApiKey(legacyKey);
    localStorage.removeItem(OLD_KEY);
  }
}

export function isClaudePanelOpen() {
  return !container.classList.contains("collapsed");
}

export function toggleClaudePanel() {
  const collapsed = container.classList.toggle("collapsed");
  const divider = document.getElementById("claude-divider");
  const unfoldBtn = document.getElementById("claude-unfold-btn");

  if (divider) divider.classList.toggle("hidden", collapsed);
  if (unfoldBtn) unfoldBtn.classList.toggle("visible", collapsed);

  localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));

  if (!collapsed && sessions.size === 0) {
    showSetupOrTerminal();
  }
  if (!collapsed && activeSessionId) {
    const session = sessions.get(activeSessionId);
    if (session) {
      requestAnimationFrame(() => session.fitAddon.fit());
    }
  }
}

export async function resetAuth() {
  localStorage.removeItem(STORAGE_KEY_AUTH_MODE);
  await removeApiKey();

  // Kill and dispose all sessions
  for (const [id, session] of sessions) {
    if (session.isSpawned) {
      await invoke("kill_pty", { sessionId: id }).catch(() => {});
    }
    session.terminal.dispose();
    session.resizeObserver.disconnect();
    session.containerEl.remove();
  }
  sessions.clear();
  activeSessionId = null;
  nextTabNumber = 1;

  cleanupGlobalListeners();
  showSetup();
}

export function getStoredWidth(): number {
  const stored = localStorage.getItem(STORAGE_KEY_WIDTH);
  return stored ? Number(stored) : DEFAULT_WIDTH;
}

export function setStoredWidth(width: number) {
  localStorage.setItem(STORAGE_KEY_WIDTH, String(width));
}

// --- Internal ---

function renderPanel() {
  container.innerHTML = `
    <div class="claude-panel-header">
      <span class="claude-panel-title">Claude Code</span>
      <span class="claude-panel-spacer"></span>
      <button class="claude-panel-restart-btn" title="Restart session">↻</button>
      <button class="claude-panel-fold-btn" title="Collapse (⌘J)">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l4 4-4 4"/></svg>
      </button>
    </div>
    <div class="claude-tab-bar" style="display:none">
      <div class="claude-tab-list"></div>
      <button class="claude-tab-new" title="New session (max ${MAX_TABS})">+</button>
    </div>
    <div class="claude-panel-body">
      <div class="claude-setup" style="display:none"></div>
      <div class="claude-terminals"></div>
    </div>
  `;

  const foldBtn = container.querySelector(".claude-panel-fold-btn")!;
  foldBtn.addEventListener("click", toggleClaudePanel);

  const restartBtn = container.querySelector(".claude-panel-restart-btn") as HTMLButtonElement;
  restartBtn.addEventListener("click", restartActiveSession);

  const newTabBtn = container.querySelector(".claude-tab-new") as HTMLButtonElement;
  newTabBtn.addEventListener("click", createNewTab);

  // If not collapsed on load, initialize
  if (!container.classList.contains("collapsed")) {
    showSetupOrTerminal();
  }
}

async function setupGlobalListeners() {
  // Listen for PTY output — route to correct session
  unlistenData = await listen<{ session_id: string; data: string }>("pty:data", (event) => {
    const session = sessions.get(event.payload.session_id);
    if (session) {
      session.terminal.write(Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0)));
    }
  });

  // Listen for process exit — mark session as not spawned
  unlistenExit = await listen<{ session_id: string }>("pty:exit", (event) => {
    const session = sessions.get(event.payload.session_id);
    if (session) {
      session.isSpawned = false;
      session.terminal.writeln(
        "\r\n\x1b[90m[Process exited. Press any key or click Restart to start a new session.]\x1b[0m",
      );
    }
  });
}

function cleanupGlobalListeners() {
  if (unlistenData) {
    unlistenData();
    unlistenData = null;
  }
  if (unlistenExit) {
    unlistenExit();
    unlistenExit = null;
  }
}

async function showSetupOrTerminal() {
  const installed = await invoke<boolean>("check_claude_installed").catch(() => false);
  if (!installed) {
    showNotInstalled();
    return;
  }

  const authMode = localStorage.getItem(STORAGE_KEY_AUTH_MODE);
  if (authMode) {
    await createNewTab();
  } else {
    showSetup();
  }
}

function showNotInstalled() {
  const setupEl = container.querySelector(".claude-setup") as HTMLElement;
  const terminalsEl = container.querySelector(".claude-terminals") as HTMLElement;
  const tabBar = container.querySelector(".claude-tab-bar") as HTMLElement;
  setupEl.style.display = "";
  terminalsEl.style.display = "none";
  tabBar.style.display = "none";

  setupEl.innerHTML = `
    <div class="claude-setup-message">
      <div class="claude-setup-icon">⚠</div>
      <div class="claude-setup-title">Claude Code not found</div>
      <div class="claude-setup-desc">
        Install Claude Code CLI to use this panel:
      </div>
      <pre class="claude-setup-code">npm install -g @anthropic-ai/claude-code</pre>
      <button class="claude-setup-retry-btn">Retry</button>
    </div>
  `;

  setupEl.querySelector(".claude-setup-retry-btn")!.addEventListener("click", showSetupOrTerminal);
}

async function showSetup() {
  const setupEl = container.querySelector(".claude-setup") as HTMLElement;
  const terminalsEl = container.querySelector(".claude-terminals") as HTMLElement;
  const tabBar = container.querySelector(".claude-tab-bar") as HTMLElement;
  setupEl.style.display = "";
  terminalsEl.style.display = "none";
  tabBar.style.display = "none";

  const savedKey = (await getApiKey()) || "";

  setupEl.innerHTML = `
    <div class="claude-setup-auth">
      <div class="claude-setup-title">Claude Code Setup</div>
      <div class="claude-setup-desc">Choose how to authenticate with Claude:</div>

      <div class="claude-auth-options">
        <button class="claude-auth-option" data-mode="oauth">
          <div class="claude-auth-option-title">Login with Anthropic</div>
          <div class="claude-auth-option-desc">OAuth login via browser — recommended for personal use</div>
        </button>

        <div class="claude-auth-divider"><span>or</span></div>

        <div class="claude-auth-apikey-section">
          <div class="claude-auth-option-title">Use API Key</div>
          <div class="claude-auth-option-desc">Set <code>ANTHROPIC_API_KEY</code> — for team/enterprise use</div>
          <div class="claude-auth-apikey-row">
            <input type="password" class="claude-auth-apikey-input" placeholder="sk-ant-..." value="" />
            <button class="claude-auth-apikey-btn">Start</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Set value via DOM to avoid XSS
  const apiKeyInput = setupEl.querySelector(".claude-auth-apikey-input") as HTMLInputElement;
  apiKeyInput.value = savedKey;

  // OAuth option
  setupEl.querySelector('[data-mode="oauth"]')!.addEventListener("click", async () => {
    localStorage.setItem(STORAGE_KEY_AUTH_MODE, "oauth");
    await createNewTab();
  });

  // API key option
  const apiKeyBtn = setupEl.querySelector(".claude-auth-apikey-btn")!;
  apiKeyBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      apiKeyInput.focus();
      return;
    }
    localStorage.setItem(STORAGE_KEY_AUTH_MODE, "apikey");
    await setApiKey(key);
    await createNewTab();
  });

  apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      (apiKeyBtn as HTMLButtonElement).click();
    }
  });
}

async function createNewTab() {
  if (sessions.size >= MAX_TABS) return;

  const setupEl = container.querySelector(".claude-setup") as HTMLElement;
  const terminalsEl = container.querySelector(".claude-terminals") as HTMLElement;
  const tabBar = container.querySelector(".claude-tab-bar") as HTMLElement;
  setupEl.style.display = "none";
  terminalsEl.style.display = "";
  tabBar.style.display = "";

  // Create session on backend
  const sessionId = await invoke<string>("create_session");
  const label = `Session ${nextTabNumber++}`;

  // Create terminal container
  const containerEl = document.createElement("div");
  containerEl.className = "claude-terminal-container";
  containerEl.style.display = "none";
  terminalsEl.appendChild(containerEl);

  // Initialize xterm
  const { terminal, fitAddon, resizeObserver, dataDisposable } = await initXterm(
    containerEl,
    sessionId,
  );

  const session: Session = {
    id: sessionId,
    terminal,
    fitAddon,
    resizeObserver,
    containerEl,
    isSpawned: false,
    label,
    dataDisposable,
  };
  sessions.set(sessionId, session);

  renderTabBar();
  switchToSession(sessionId);
  await spawnClaude(sessionId);
}

async function loadXtermModules() {
  if (xtermModules) return xtermModules;

  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
  ]);
  await import("@xterm/xterm/css/xterm.css");

  let WebglAddon: typeof import("@xterm/addon-webgl").WebglAddon | undefined;
  try {
    const mod = await import("@xterm/addon-webgl");
    WebglAddon = mod.WebglAddon;
  } catch {
    // WebGL not available
  }

  xtermModules = { Terminal, FitAddon, WebLinksAddon, WebglAddon };
  return xtermModules;
}

async function initXterm(
  termEl: HTMLElement,
  sessionId: string,
): Promise<{ terminal: Terminal; fitAddon: FitAddon; resizeObserver: ResizeObserver }> {
  const mods = await loadXtermModules();

  const terminal = new mods.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "SF Mono, Fira Code, JetBrains Mono, monospace",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b7066",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    allowProposedApi: true,
  });

  const fitAddon = new mods.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new mods.WebLinksAddon());

  if (mods.WebglAddon) {
    try {
      terminal.loadAddon(new mods.WebglAddon());
    } catch {
      // fall back to canvas
    }
  }

  terminal.open(termEl);
  fitAddon.fit();

  // Relay keystrokes to backend (scoped to this session)
  const dataDisposable = terminal.onData((data) => {
    const encoded = btoa(data);
    invoke("write_pty", { sessionId, data: encoded }).catch(() => {});
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    if (termEl.offsetWidth > 0) {
      fitAddon.fit();
      const session = sessions.get(sessionId);
      if (session?.isSpawned) {
        invoke("resize_pty", { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(
          () => {},
        );
      }
    }
  });
  resizeObserver.observe(termEl);

  // Handle keypress when process has exited — restart on any key
  terminal.onKey(() => {
    const session = sessions.get(sessionId);
    if (session && !session.isSpawned) {
      restartSession(sessionId);
    }
  });

  return { terminal, fitAddon, resizeObserver, dataDisposable };
}

function switchToSession(sessionId: string) {
  // Hide current
  if (activeSessionId) {
    const prev = sessions.get(activeSessionId);
    if (prev) prev.containerEl.style.display = "none";
  }

  // Show target
  const target = sessions.get(sessionId);
  if (target) {
    target.containerEl.style.display = "";
    activeSessionId = sessionId;
    requestAnimationFrame(() => target.fitAddon.fit());
  }

  renderTabBar();
}

async function closeTab(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Kill PTY and clean up
  if (session.isSpawned) {
    await invoke("kill_pty", { sessionId }).catch(() => {});
  }
  session.terminal.dispose();
  session.resizeObserver.disconnect();
  session.containerEl.remove();
  sessions.delete(sessionId);

  if (sessions.size === 0) {
    // No tabs left — show setup screen
    activeSessionId = null;
    showSetup();
    return;
  }

  // Switch to an adjacent tab if we closed the active one
  if (activeSessionId === sessionId) {
    const remaining = [...sessions.keys()];
    switchToSession(remaining[remaining.length - 1]);
  } else {
    renderTabBar();
  }
}

function renderTabBar() {
  const tabList = container.querySelector(".claude-tab-list") as HTMLElement;
  const newBtn = container.querySelector(".claude-tab-new") as HTMLButtonElement;
  if (!tabList) return;

  tabList.innerHTML = "";
  for (const [id, session] of sessions) {
    const tab = document.createElement("button");
    tab.className = `claude-tab${id === activeSessionId ? " active" : ""}`;
    tab.dataset.session = id;

    const labelSpan = document.createElement("span");
    labelSpan.className = "claude-tab-label";
    labelSpan.textContent = session.label;
    tab.appendChild(labelSpan);

    const closeBtn = document.createElement("span");
    closeBtn.className = "claude-tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close session";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener("click", () => switchToSession(id));
    tabList.appendChild(tab);
  }

  // Hide/show new tab button based on limit
  newBtn.style.display = sessions.size >= MAX_TABS ? "none" : "";

  // Hide tab bar entirely if only one session
  const tabBar = container.querySelector(".claude-tab-bar") as HTMLElement;
  if (tabBar) {
    tabBar.style.display = sessions.size <= 1 ? "none" : "";
  }
}

async function spawnClaude(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.isSpawned) return;

  const cwd = getCwd() || "/";
  const authMode = localStorage.getItem(STORAGE_KEY_AUTH_MODE);
  const apiKey = authMode === "apikey" ? await getApiKey() : undefined;

  // Generate MCP config
  let mcpConfigPath: string | undefined;
  try {
    const binaryPath = await getMcpBinaryPath();
    if (binaryPath) {
      const workerUrl = getWorkerUrl();
      const entry: Record<string, unknown> = { command: binaryPath };
      if (workerUrl) {
        entry.env = { MARKUPSIDEDOWN_WORKER_URL: workerUrl };
      }
      const configJson = JSON.stringify({ mcpServers: { markupsidedown: entry } });
      mcpConfigPath = await invoke<string>("write_mcp_config", { configJson });
    }
  } catch {
    // MCP config generation failed — continue without it
  }

  try {
    await invoke("spawn_claude", {
      sessionId,
      cwd,
      apiKey: apiKey || null,
      mcpConfigPath: mcpConfigPath || null,
    });
    session.isSpawned = true;

    // Sync terminal size after spawn
    await invoke("resize_pty", {
      sessionId,
      cols: session.terminal.cols,
      rows: session.terminal.rows,
    }).catch(() => {});
  } catch (e) {
    session.terminal.writeln(`\r\n\x1b[31mFailed to start Claude: ${e}\x1b[0m`);
  }
}

async function restartSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.isSpawned) {
    await invoke("kill_pty", { sessionId }).catch(() => {});
    session.isSpawned = false;
  }

  // Re-create backend session and migrate
  const newId = await invoke<string>("create_session");
  sessions.delete(sessionId);
  session.id = newId;
  sessions.set(newId, session);
  if (activeSessionId === sessionId) activeSessionId = newId;

  // Dispose old keystroke handler to prevent listener leak, then re-register
  session.dataDisposable?.dispose();
  session.dataDisposable = session.terminal.onData((data) => {
    const encoded = btoa(data);
    invoke("write_pty", { sessionId: newId, data: encoded }).catch(() => {});
  });

  session.terminal.clear();
  renderTabBar();
  await spawnClaude(newId);
}

async function restartActiveSession() {
  if (activeSessionId) {
    await restartSession(activeSessionId);
  }
}

// --- Keyboard shortcuts ---

function handleKeyDown(e: KeyboardEvent) {
  // ⌘{ / ⌘} to switch tabs (Ctrl on non-Mac)
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || sessions.size <= 1) return;

  if (e.key === "{" || e.key === "}") {
    e.preventDefault();
    const ids = [...sessions.keys()];
    const currentIdx = activeSessionId ? ids.indexOf(activeSessionId) : 0;
    const nextIdx =
      e.key === "}" ? (currentIdx + 1) % ids.length : (currentIdx - 1 + ids.length) % ids.length;
    switchToSession(ids[nextIdx]);
  }
}

document.addEventListener("keydown", handleKeyDown);
