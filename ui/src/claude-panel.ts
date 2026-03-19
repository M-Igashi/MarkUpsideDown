import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- Constants ---

const STORAGE_KEY_COLLAPSED = "markupsidedown:claudePanelCollapsed";
const STORAGE_KEY_WIDTH = "markupsidedown:claudePanelWidth";
const STORAGE_KEY_AUTH_MODE = "markupsidedown:claudeAuthMode";
const STORAGE_KEY_API_KEY = "markupsidedown:claudeApiKey";
const DEFAULT_WIDTH = 420;

// --- State ---

let container: HTMLElement;
let getCwd: () => string | null;
let getMcpBinaryPath: () => Promise<string>;
let getWorkerUrl: () => string;

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let isSpawned = false;
let unlistenData: (() => void) | null = null;
let unlistenExit: (() => void) | null = null;

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

  renderPanel();
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

  if (!collapsed && !terminal) {
    showSetupOrTerminal();
  }
  if (!collapsed && terminal && fitAddon) {
    requestAnimationFrame(() => fitAddon!.fit());
  }
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
    <div class="claude-panel-body">
      <div class="claude-setup" style="display:none"></div>
      <div class="claude-terminal-container" style="display:none"></div>
    </div>
  `;

  const foldBtn = container.querySelector(".claude-panel-fold-btn")!;
  foldBtn.addEventListener("click", toggleClaudePanel);

  const restartBtn = container.querySelector(".claude-panel-restart-btn") as HTMLButtonElement;
  restartBtn.addEventListener("click", restartSession);

  // If not collapsed on load, initialize
  if (!container.classList.contains("collapsed")) {
    showSetupOrTerminal();
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
    // Auth already configured, start terminal
    await startTerminal();
  } else {
    showSetup();
  }
}

function showNotInstalled() {
  const setupEl = container.querySelector(".claude-setup") as HTMLElement;
  const termEl = container.querySelector(".claude-terminal-container") as HTMLElement;
  setupEl.style.display = "";
  termEl.style.display = "none";

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

function showSetup() {
  const setupEl = container.querySelector(".claude-setup") as HTMLElement;
  const termEl = container.querySelector(".claude-terminal-container") as HTMLElement;
  setupEl.style.display = "";
  termEl.style.display = "none";

  const savedKey = localStorage.getItem(STORAGE_KEY_API_KEY) || "";

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
    await startTerminal();
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
    localStorage.setItem(STORAGE_KEY_API_KEY, key);
    await startTerminal();
  });

  apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      (apiKeyBtn as HTMLButtonElement).click();
    }
  });
}

async function startTerminal() {
  const setupEl = container.querySelector(".claude-setup") as HTMLElement;
  const termEl = container.querySelector(".claude-terminal-container") as HTMLElement;
  setupEl.style.display = "none";
  termEl.style.display = "";
  termEl.innerHTML = "";

  if (!terminal) {
    await initXterm(termEl);
  }

  await spawnClaude();
}

async function initXterm(termEl: HTMLElement) {
  const { Terminal } = await import("@xterm/xterm");
  const { FitAddon: Fit } = await import("@xterm/addon-fit");
  const { WebLinksAddon } = await import("@xterm/addon-web-links");

  // Import xterm CSS
  await import("@xterm/xterm/css/xterm.css");

  terminal = new Terminal({
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

  fitAddon = new Fit();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  // Try loading WebGL addon for GPU-accelerated rendering
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    terminal.loadAddon(new WebglAddon());
  } catch {
    // WebGL not available — fall back to canvas renderer
  }

  terminal.open(termEl);
  fitAddon.fit();

  // Relay keystrokes to backend
  terminal.onData((data) => {
    const encoded = btoa(data);
    invoke("write_pty", { data: encoded }).catch(() => {});
  });

  // Listen for PTY output
  unlistenData = await listen<string>("pty:data", (event) => {
    if (terminal) {
      terminal.write(Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0)));
    }
  });

  // Listen for process exit
  unlistenExit = await listen("pty:exit", () => {
    isSpawned = false;
    if (terminal) {
      terminal.writeln(
        "\r\n\x1b[90m[Process exited. Press any key or click Restart to start a new session.]\x1b[0m",
      );
    }
  });

  // Resize handling
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && terminal && termEl.offsetWidth > 0) {
      fitAddon.fit();
      if (isSpawned) {
        invoke("resize_pty", { cols: terminal.cols, rows: terminal.rows }).catch(() => {});
      }
    }
  });
  resizeObserver.observe(termEl);

  // Handle keypress when process has exited — restart on any key
  terminal.onKey(() => {
    if (!isSpawned) {
      restartSession();
    }
  });
}

async function spawnClaude() {
  if (isSpawned) return;

  const cwd = getCwd() || "/";
  const authMode = localStorage.getItem(STORAGE_KEY_AUTH_MODE);
  const apiKey =
    authMode === "apikey" ? localStorage.getItem(STORAGE_KEY_API_KEY) || undefined : undefined;

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
      cwd,
      apiKey: apiKey || null,
      mcpConfigPath: mcpConfigPath || null,
    });
    isSpawned = true;

    // Sync terminal size after spawn
    if (terminal) {
      await invoke("resize_pty", { cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    }
  } catch (e) {
    if (terminal) {
      terminal.writeln(`\r\n\x1b[31mFailed to start Claude: ${e}\x1b[0m`);
    }
  }
}

async function restartSession() {
  if (isSpawned) {
    await invoke("kill_pty").catch(() => {});
    isSpawned = false;
  }
  if (terminal) {
    terminal.clear();
  }
  await spawnClaude();
}

export function resetAuth() {
  localStorage.removeItem(STORAGE_KEY_AUTH_MODE);
  localStorage.removeItem(STORAGE_KEY_API_KEY);
  if (isSpawned) {
    invoke("kill_pty").catch(() => {});
    isSpawned = false;
  }
  if (terminal) {
    terminal.dispose();
    terminal = null;
    fitAddon = null;
  }
  if (unlistenData) {
    unlistenData();
    unlistenData = null;
  }
  if (unlistenExit) {
    unlistenExit();
    unlistenExit = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  showSetup();
}

export function getStoredWidth(): number {
  const stored = localStorage.getItem(STORAGE_KEY_WIDTH);
  return stored ? Number(stored) : DEFAULT_WIDTH;
}

export function setStoredWidth(width: number) {
  localStorage.setItem(STORAGE_KEY_WIDTH, String(width));
}
