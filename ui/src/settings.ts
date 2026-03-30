import { isLintEnabled, setLintEnabled } from "./markdown-lint.ts";
import { isSmartTypographyEnabled, setSmartTypographyEnabled } from "./smart-typography.ts";
import { getStorageBool, setStorageBool } from "./storage-utils.ts";
import {
  KEY_WORKER_URL,
  KEY_ACCOUNT_ID,
  KEY_SETUP_DONE,
  KEY_ALLOW_IMAGE,
  KEY_AUTOSAVE,
} from "./storage-keys.ts";
import { escapeHtml } from "./html-utils.ts";

const { invoke } = window.__TAURI__.core;

interface WorkerStatus {
  reachable: boolean;
  convert_available: boolean;
  render_available: boolean;
  json_available: boolean;
  crawl_available: boolean;
  worker_version: number | null;
  update_available: boolean;
  error?: string;
}

interface WranglerStatus {
  installed: boolean;
  logged_in: boolean;
  accounts: { id: string; name: string }[];
}

export function getWorkerUrl() {
  return localStorage.getItem(KEY_WORKER_URL) || "";
}

export function setWorkerUrl(url: string) {
  if (url) {
    localStorage.setItem(KEY_WORKER_URL, url.replace(/\/+$/, ""));
  } else {
    localStorage.removeItem(KEY_WORKER_URL);
  }
}

export function isSetupDone() {
  return getStorageBool(KEY_SETUP_DONE, false);
}

export function isImageConversionAllowed() {
  return getStorageBool(KEY_ALLOW_IMAGE);
}

export function isAutoSaveEnabled() {
  return getStorageBool(KEY_AUTOSAVE);
}

function setAutoSaveEnabled(enabled: boolean) {
  setStorageBool(KEY_AUTOSAVE, enabled);
}

function setImageConversionAllowed(allowed: boolean) {
  setStorageBool(KEY_ALLOW_IMAGE, allowed);
}

function markSetupDone() {
  setStorageBool(KEY_SETUP_DONE, true);
}

let currentTestStatus: WorkerStatus | null = null; // cached last test result
let lastTestedUrl: string | null = null; // URL that produced currentTestStatus

export function isRenderAvailable(): boolean {
  return Boolean(currentTestStatus?.render_available);
}

function featureRows(status: WorkerStatus | null) {
  const hasConvert = Boolean(status && status.convert_available);
  const hasRender = Boolean(status && status.render_available);
  const hasJson = Boolean(status && status.json_available);
  const hasCrawl = Boolean(status && status.crawl_available);
  const hasWorker = Boolean(status && status.reachable);

  return [
    { name: "Open / Save", ok: true, hint: "Always available" },
    {
      name: "Get URL as Markdown",
      ok: true,
      hint: "Always available (auto-renders JS pages if Worker configured)",
    },
    { name: "Table Editor / Copy Rich Text", ok: true, hint: "Always available" },
    {
      name: "Import documents",
      ok: hasConvert,
      hint: hasConvert ? "Ready" : "Needs Worker URL",
    },
    {
      name: "JS Rendering (auto-fallback)",
      ok: hasRender,
      hint: hasRender ? "Ready" : hasWorker ? "Needs Worker secrets" : "Needs Worker URL + secrets",
    },
    {
      name: "Extract JSON (AI)",
      ok: hasJson,
      hint: hasJson ? "Ready" : hasWorker ? "Needs Worker secrets" : "Needs Worker URL + secrets",
    },
    {
      name: "Website Crawl",
      ok: hasCrawl,
      hint: hasCrawl ? "Ready" : hasWorker ? "Needs Worker secrets" : "Needs Worker URL + secrets",
    },
  ];
}

function renderFeatureList(container: HTMLElement | null, status: WorkerStatus | null) {
  if (!container) return;
  const rows = featureRows(status);
  container.innerHTML = rows
    .map(
      (r) => `
    <div class="feature-row ${r.ok ? "feature-ok" : "feature-needs"}">
      <span class="feature-icon">${r.ok ? "\u2713" : "\u25CF"}</span>
      <span class="feature-name">${r.name}</span>
      <span class="feature-hint">${r.hint}</span>
    </div>`,
    )
    .join("");
}

// --- Auto Setup ---

const SETUP_STEPS = [
  { id: "wrangler", label: "Check wrangler" },
  { id: "login", label: "Cloudflare login" },
  { id: "deploy", label: "Deploy Worker" },
  { id: "secrets", label: "Configure secrets" },
  { id: "verify", label: "Verify" },
];

function renderSetupProgress(container: HTMLElement, stepStates: Record<string, string>) {
  container.innerHTML = SETUP_STEPS.map((step) => {
    const state = stepStates[step.id] || "pending";
    let icon, cls;
    if (state === "done") {
      icon = "\u2713";
      cls = "setup-step-done";
    } else if (state === "running") {
      icon = "\u25CF";
      cls = "setup-step-running";
    } else if (state === "error") {
      icon = "\u2717";
      cls = "setup-step-error";
    } else if (state === "skipped") {
      icon = "\u2014";
      cls = "setup-step-skipped";
    } else {
      icon = "\u25CB";
      cls = "setup-step-pending";
    }
    return `<div class="setup-step ${cls}"><span class="setup-step-icon">${icon}</span> ${step.label}</div>`;
  }).join("");
}

async function startAutoSetup(
  progressContainer: HTMLElement,
  urlInput: HTMLInputElement,
  onComplete: (workerUrl: string | null, testStatus: WorkerStatus | null) => void,
) {
  const states: Record<string, string> = {};
  const update = (id: string, state: string) => {
    states[id] = state;
    renderSetupProgress(progressContainer, states);
  };
  const fail = (id: string, message: string) => {
    update(id, "error");
    showSetupMessage(progressContainer, "setup-error", message);
    onComplete(null, null);
  };

  let accountId: string | null = null;

  // Step 1: Check wrangler
  update("wrangler", "running");
  let status: WranglerStatus;
  try {
    status = await invoke<WranglerStatus>("check_wrangler_status");
  } catch (e) {
    return fail("wrangler", `Failed to check wrangler: ${e}`);
  }

  if (!status.installed) {
    return fail("wrangler", "wrangler is not installed. Install it with:\nnpm install -g wrangler");
  }
  update("wrangler", "done");

  // Step 2: Login
  if (status.logged_in && status.accounts.length > 0) {
    update("login", "skipped");
  } else {
    update("login", "running");
    try {
      await invoke("wrangler_login");
      status = await invoke<WranglerStatus>("check_wrangler_status");
      if (!status.logged_in) {
        return fail("login", "Login failed. Please try again.");
      }
      update("login", "done");
    } catch (e) {
      return fail("login", `Login failed: ${e}`);
    }
  }

  // Pick account
  accountId = status.accounts.length === 1 ? status.accounts[0].id : null;
  if (!accountId && status.accounts.length > 1) {
    accountId = await showAccountPicker(progressContainer, status.accounts);
    if (!accountId) {
      return fail("login", "No account selected.");
    }
    update("login", "done");
  }
  if (!accountId) {
    return fail("login", "No Cloudflare accounts found.");
  }

  // Persist account ID for future Worker updates
  localStorage.setItem(KEY_ACCOUNT_ID, accountId);

  // Step 3: Deploy
  update("deploy", "running");
  let workerUrl: string;
  try {
    workerUrl = await invoke<string>("deploy_worker", { accountId });
  } catch (e) {
    return fail("deploy", `Deploy failed: ${e}`);
  }
  update("deploy", "done");

  // Step 4: Secrets (optional — only needed for Render JS)
  update("secrets", "running");
  let secretsOk = false;
  try {
    await invoke("setup_worker_secrets", { accountId });
    secretsOk = true;
  } catch {
    // Auto-setup failed — ask user for API token
    try {
      const userToken = await showApiTokenInput(progressContainer);
      await invoke("setup_worker_secrets_with_token", {
        accountId,
        apiToken: userToken,
      });
      secretsOk = true;
    } catch {
      // User skipped or manual entry failed — continue without secrets
    }
  }
  update("secrets", secretsOk ? "done" : "skipped");

  // Step 5: Verify
  update("verify", "running");
  urlInput.value = workerUrl;
  try {
    const testStatus = await invoke<WorkerStatus>("test_worker_url", {
      workerUrl,
    });
    currentTestStatus = testStatus;
    lastTestedUrl = workerUrl;
    if (testStatus.reachable) {
      update("verify", "done");
      if (testStatus.render_available) {
        showSetupMessage(
          progressContainer,
          "setup-success",
          `Setup complete! Worker: ${workerUrl}`,
        );
      } else {
        showSetupMessage(
          progressContainer,
          "setup-info",
          `Worker ready at ${workerUrl}\nImport works. To enable Render JS, add secrets later from the panel below.`,
        );
      }
    } else {
      update("verify", "error");
      showSetupMessage(
        progressContainer,
        "setup-error",
        `Worker deployed but health check failed. URL: ${workerUrl}`,
      );
    }
    onComplete(workerUrl, testStatus);
  } catch (e) {
    update("verify", "error");
    showSetupMessage(progressContainer, "setup-error", `Health check error: ${e}`);
    onComplete(workerUrl, null);
  }
}

function showSetupMessage(container: HTMLElement, className: string, message: string) {
  const div = container.querySelector(`.${className}`) || document.createElement("div");
  div.className = className;
  div.textContent = message;
  if (!div.parentNode) container.appendChild(div);
}

function showAccountPicker(
  container: HTMLElement,
  accounts: { id: string; name: string }[],
): Promise<string> {
  return new Promise((resolve) => {
    const pickerDiv = document.createElement("div");
    pickerDiv.className = "setup-account-picker";

    const label = document.createElement("div");
    label.className = "setup-account-label";
    label.textContent = "Select your Cloudflare account:";

    const select = document.createElement("select");
    select.className = "setup-account-select";
    for (const a of accounts) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = `${a.name} (${a.id.slice(0, 8)}...)`;
      select.appendChild(opt);
    }

    const btn = document.createElement("button");
    btn.className = "setup-account-confirm";
    btn.textContent = "Continue";
    btn.addEventListener("click", () => {
      pickerDiv.remove();
      resolve(select.value);
    });

    pickerDiv.append(label, select, btn);
    container.appendChild(pickerDiv);
  });
}

function showApiTokenInput(container: HTMLElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const div = document.createElement("div");
    div.className = "setup-token-input";
    div.innerHTML = `
      <div class="setup-token-label">
        <strong>Optional:</strong> Add an API token to enable Render JS (JS-rendered page fetching).<br>
        You can skip this — document import will work without it.
      </div>
      <input type="password" class="setup-token-field" placeholder="API Token" />
      <div class="setup-token-actions">
        <button class="setup-token-skip">Skip for now</button>
        <button class="setup-token-confirm primary">Set Secrets</button>
      </div>
      <div class="setup-token-hint">
        Create a token at <em>dash.cloudflare.com/profile/api-tokens</em> with
        "Edit Cloudflare Workers" template + Workers AI Read + Browser Rendering Edit.
      </div>
    `;
    container.appendChild(div);

    const input = div.querySelector<HTMLInputElement>(".setup-token-field")!;
    input.focus();

    div.querySelector(".setup-token-confirm")!.addEventListener("click", () => {
      const val = input.value.trim();
      if (!val) return;
      div.remove();
      resolve(val);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = input.value.trim();
        if (!val) return;
        div.remove();
        resolve(val);
      }
    });

    div.querySelector(".setup-token-skip")!.addEventListener("click", () => {
      div.remove();
      reject("Skipped — secrets not configured");
    });
  });
}

// --- Settings Panel ---

export function showSettings({
  onSave,
  onClose: onCloseCallback,
}: { onSave?: (url: string) => void; onClose?: () => void } = {}) {
  document.getElementById("settings-panel")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "settings-panel";
  overlay.className = "dialog-overlay";

  const workerUrl = getWorkerUrl();

  overlay.innerHTML = `
    <div class="settings-box">
      <div class="settings-header">
        <span class="settings-title">Settings</span>
        <button id="settings-close" class="settings-close-btn" title="Close">&times;</button>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Cloudflare Worker</div>
        <div class="settings-description">
          Powers document import and JS-rendered page fetching — the core of MarkUpsideDown.
        </div>

        <div class="settings-auto-setup">
          <button id="settings-auto-setup-btn" class="settings-setup-btn">Setup with Cloudflare</button>
          <button id="settings-update-worker-btn" class="settings-update-btn" style="display:none">Update Worker</button>
          <div id="settings-update-result" class="settings-test-result" style="display:none"></div>
          <div id="settings-setup-progress" class="settings-setup-progress" style="display:none"></div>
        </div>

        <div class="settings-divider">
          <span>Or enter an existing Worker URL</span>
        </div>

        <div class="settings-worker-input-row">
          <input
            type="url"
            id="settings-worker-url"
            placeholder="https://markupsidedown-converter.YOUR_SUBDOMAIN.workers.dev"
            value=""
          />
          <button id="settings-test-btn">Test</button>
        </div>
        <div id="settings-test-result" class="settings-test-result"></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Feature Status</div>
        <div id="settings-feature-list" class="settings-feature-list"></div>
      </div>

      <div class="settings-section settings-secrets-help" id="settings-secrets-help" style="display:none">
        <div class="settings-section-title">Missing: Worker Secrets</div>
        <div class="settings-description">
          The <code>/render</code> endpoint needs two secrets. Run these once after deploy:
        </div>
        <pre class="settings-code">cd worker
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put CLOUDFLARE_API_TOKEN</pre>
      </div>

      <details class="settings-section settings-manual-deploy">
        <summary class="settings-section-title">Manual deploy instructions</summary>
        <div class="settings-description">
          Deploy the Worker yourself from the terminal, then paste the URL above.
        </div>
        <pre class="settings-code">cd worker && wrangler deploy</pre>
        <div class="settings-description">
          To enable Render JS, also set secrets:
        </div>
        <pre class="settings-code">cd worker
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put CLOUDFLARE_API_TOKEN</pre>
      </details>

      <div class="settings-section">
        <div class="settings-section-title">Editor</div>
        <label class="settings-toggle-row">
          <input type="checkbox" id="settings-autosave" />
          <span class="settings-toggle-label">Auto-save files (2 seconds after last edit)</span>
        </label>
        <label class="settings-toggle-row">
          <input type="checkbox" id="settings-lint" />
          <span class="settings-toggle-label">Markdown structure linting (heading hierarchy, links, tables)</span>
        </label>
        <label class="settings-toggle-row">
          <input type="checkbox" id="settings-smart-typography" />
          <span class="settings-toggle-label">Smart typography (auto-convert ..., --, --- to typographic characters)</span>
        </label>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Import Options</div>
        <label class="settings-toggle-row">
          <input type="checkbox" id="settings-allow-image" />
          <span class="settings-toggle-label">Allow image conversion (~720 AI Neurons per image)</span>
        </label>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">AI Agent Integration</div>
        <div class="settings-mcp-banner">
          MarkUpsideDown works with any Claude client via MCP. Choose your preferred client below.
        </div>
        <div class="settings-description">
          MCP allows AI agents (Claude Desktop, Claude Code, Cowork) to read and write your editor,
          convert documents, and fetch web pages as Markdown.
        </div>
        <div class="settings-mcp-status">
          <div class="settings-mcp-row">
            <span class="settings-mcp-label">Bridge:</span>
            <span id="settings-mcp-bridge-status" class="settings-mcp-value"></span>
          </div>
          <div class="settings-mcp-row">
            <span class="settings-mcp-label">MCP binary:</span>
            <span id="settings-mcp-binary-path" class="settings-mcp-value"></span>
          </div>
        </div>
        <div class="settings-mcp-config">
          <div class="settings-mcp-tabs">
            <button class="settings-mcp-tab active" data-mcp-target="claude-desktop-chat">Chat</button>
            <button class="settings-mcp-tab" data-mcp-target="claude-desktop-code"><span class="mcp-tab-recommended">Recommended</span> Code</button>
            <button class="settings-mcp-tab" data-mcp-target="claude-code-terminal">Terminal</button>
            <button class="settings-mcp-tab" data-mcp-target="cowork">Cowork</button>
          </div>
          <div id="settings-mcp-tab-content" class="settings-mcp-tab-content"></div>
        </div>
        <details class="settings-mcp-tools-details">
          <summary>Available tools (48)</summary>
          <div class="settings-mcp-tools-list">
            <div class="settings-mcp-tool"><code>get_editor_content</code> &mdash; Get current Markdown from the editor</div>
            <div class="settings-mcp-tool"><code>set_editor_content</code> &mdash; Replace editor content</div>
            <div class="settings-mcp-tool"><code>insert_text</code> &mdash; Insert text at cursor, start, or end</div>
            <div class="settings-mcp-tool"><code>get_editor_state</code> &mdash; Get editor state (file path, cursor, Worker URL)</div>
            <div class="settings-mcp-tool"><code>get_document_structure</code> &mdash; Get document structure (headings, links, stats) as JSON</div>
            <div class="settings-mcp-tool"><code>normalize_document</code> &mdash; Normalize headings, tables, list markers, whitespace</div>
            <div class="settings-mcp-tool"><code>open_file</code> &mdash; Open a Markdown file</div>
            <div class="settings-mcp-tool"><code>save_file</code> &mdash; Save content to a file</div>
            <div class="settings-mcp-tool"><code>get_markdown</code> &mdash; Fetch URL as Markdown (auto-detects JS-rendered pages)</div>
            <div class="settings-mcp-tool"><code>fetch_markdown</code> &mdash; Fetch URL as Markdown (static only)</div>
            <div class="settings-mcp-tool"><code>render_markdown</code> &mdash; JS-render a page as Markdown via Browser Rendering</div>
            <div class="settings-mcp-tool"><code>convert_to_markdown</code> &mdash; Convert local file (PDF, DOCX, images, etc.) to Markdown</div>
            <div class="settings-mcp-tool"><code>extract_json</code> &mdash; Extract structured JSON from a web page using AI</div>
            <div class="settings-mcp-tool"><code>crawl_website</code> &mdash; Start a website crawl job (markdown and/or json output)</div>
            <div class="settings-mcp-tool"><code>crawl_status</code> &mdash; Poll crawl job status and retrieve pages</div>
            <div class="settings-mcp-tool"><code>crawl_save</code> &mdash; Save crawled pages as local Markdown files</div>
            <div class="settings-mcp-tool"><code>list_directory</code> &mdash; List files and directories in the project</div>
            <div class="settings-mcp-tool"><code>read_file</code> &mdash; Read a text file from the project</div>
            <div class="settings-mcp-tool"><code>search_files</code> &mdash; Search file names in the project</div>
            <div class="settings-mcp-tool"><code>create_file</code> &mdash; Create a new empty file</div>
            <div class="settings-mcp-tool"><code>create_directory</code> &mdash; Create a new directory</div>
            <div class="settings-mcp-tool"><code>rename_entry</code> &mdash; Rename or move a file or directory</div>
            <div class="settings-mcp-tool"><code>delete_entry</code> &mdash; Delete a file or directory (moved to trash)</div>
            <div class="settings-mcp-tool"><code>copy_entry</code> &mdash; Copy a file or directory to another directory</div>
            <div class="settings-mcp-tool"><code>duplicate_entry</code> &mdash; Duplicate a file or directory</div>
            <div class="settings-mcp-tool"><code>download_image</code> &mdash; Download an image from a URL to local path</div>
            <div class="settings-mcp-tool"><code>fetch_page_title</code> &mdash; Extract page title for Markdown links</div>
            <div class="settings-mcp-tool"><code>get_open_tabs</code> &mdash; List all open editor tabs</div>
            <div class="settings-mcp-tool"><code>get_project_root</code> &mdash; Get the current project root path</div>
            <div class="settings-mcp-tool"><code>get_dirty_files</code> &mdash; List files with unsaved changes</div>
            <div class="settings-mcp-tool"><code>switch_tab</code> &mdash; Switch the active editor tab</div>
            <div class="settings-mcp-tool"><code>git_status</code> &mdash; Get git status of the project</div>
            <div class="settings-mcp-tool"><code>git_stage</code> &mdash; Stage a file for commit</div>
            <div class="settings-mcp-tool"><code>git_unstage</code> &mdash; Unstage a file</div>
            <div class="settings-mcp-tool"><code>git_commit</code> &mdash; Commit staged changes</div>
            <div class="settings-mcp-tool"><code>git_push</code> &mdash; Push commits to remote</div>
            <div class="settings-mcp-tool"><code>git_pull</code> &mdash; Pull changes from remote</div>
            <div class="settings-mcp-tool"><code>git_fetch</code> &mdash; Fetch updates from remote</div>
            <div class="settings-mcp-tool"><code>git_diff</code> &mdash; Get the diff for a specific file (staged or unstaged)</div>
            <div class="settings-mcp-tool"><code>git_discard</code> &mdash; Discard changes for a specific file</div>
            <div class="settings-mcp-tool"><code>git_discard_all</code> &mdash; Discard all uncommitted changes</div>
            <div class="settings-mcp-tool"><code>git_log</code> &mdash; Get recent commit history</div>
            <div class="settings-mcp-tool"><code>git_revert</code> &mdash; Revert a commit by creating a new revert commit</div>
            <div class="settings-mcp-tool"><code>list_tags</code> &mdash; List all tag definitions and file-tag assignments</div>
            <div class="settings-mcp-tool"><code>get_file_tags</code> &mdash; Get tags assigned to a specific file</div>
            <div class="settings-mcp-tool"><code>set_file_tags</code> &mdash; Set tags for a file (replaces existing)</div>
            <div class="settings-mcp-tool"><code>create_tag</code> &mdash; Create a new tag definition with a color</div>
            <div class="settings-mcp-tool"><code>delete_tag</code> &mdash; Delete a tag and remove from all files</div>
          </div>
        </details>
      </div>

      <div class="settings-actions">
        <button id="settings-clear" class="settings-clear-btn">Clear URL</button>
        <span class="spacer"></span>
        <button id="settings-cancel">Cancel</button>
        <button id="settings-save" class="primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const urlInput = document.getElementById("settings-worker-url") as HTMLInputElement;
  const testBtn = document.getElementById("settings-test-btn") as HTMLButtonElement;
  const testResult = document.getElementById("settings-test-result")!;
  const featureList = document.getElementById("settings-feature-list")!;
  const secretsHelp = document.getElementById("settings-secrets-help") as HTMLElement;
  const autoSetupBtn = document.getElementById("settings-auto-setup-btn") as HTMLButtonElement;
  const updateWorkerBtn = document.getElementById(
    "settings-update-worker-btn",
  ) as HTMLButtonElement;
  const updateResult = document.getElementById("settings-update-result")!;
  const setupProgress = document.getElementById("settings-setup-progress")!;

  function showUpdateButton(status: WorkerStatus | null) {
    if (status?.reachable && status.update_available) {
      updateWorkerBtn.style.display = "";
    } else {
      updateWorkerBtn.style.display = "none";
      updateResult.style.display = "none";
    }
  }

  // Initial feature list
  renderFeatureList(featureList, currentTestStatus);
  showUpdateButton(currentTestStatus);
  if (currentTestStatus?.reachable && !currentTestStatus?.render_available) {
    secretsHelp.style.display = "";
  }

  const allowImageCheckbox = document.getElementById("settings-allow-image") as HTMLInputElement;
  allowImageCheckbox.checked = isImageConversionAllowed();

  const autosaveCheckbox = document.getElementById("settings-autosave") as HTMLInputElement;
  autosaveCheckbox.checked = isAutoSaveEnabled();

  const lintCheckbox = document.getElementById("settings-lint") as HTMLInputElement;
  lintCheckbox.checked = isLintEnabled();

  const smartTypoCheckbox = document.getElementById(
    "settings-smart-typography",
  ) as HTMLInputElement;
  smartTypoCheckbox.checked = isSmartTypographyEnabled();

  // --- MCP Integration Section ---
  initMcpSection();

  urlInput.focus();

  // Auto setup
  autoSetupBtn.addEventListener("click", () => {
    autoSetupBtn.disabled = true;
    autoSetupBtn.textContent = "Setting up...";
    setupProgress.style.display = "";
    setupProgress.innerHTML = "";

    startAutoSetup(setupProgress, urlInput, (workerUrl, testStatus) => {
      if (testStatus) {
        renderFeatureList(featureList, testStatus);
        showUpdateButton(testStatus);
        secretsHelp.style.display =
          testStatus.reachable && !testStatus.render_available ? "" : "none";
      }
      autoSetupBtn.disabled = false;
      autoSetupBtn.textContent = "Setup with Cloudflare";
    });
  });

  // Update Worker (re-deploy only, no login/secrets)
  updateWorkerBtn.addEventListener("click", async () => {
    // Resolve account ID: saved from initial setup, or auto-detect for single-account users
    let resolvedAccountId = localStorage.getItem(KEY_ACCOUNT_ID);
    if (!resolvedAccountId) {
      try {
        const wStatus = await invoke<WranglerStatus>("check_wrangler_status");
        if (wStatus.accounts.length === 1) {
          resolvedAccountId = wStatus.accounts[0].id;
          localStorage.setItem(KEY_ACCOUNT_ID, resolvedAccountId);
        } else if (wStatus.accounts.length > 1) {
          // Show account picker inline
          updateResult.style.display = "";
          updateResult.className = "settings-test-result test-warn";
          updateResult.textContent = "Multiple accounts detected. Selecting account\u2026";
          resolvedAccountId = await showAccountPicker(
            updateResult.parentElement!,
            wStatus.accounts,
          );
          if (resolvedAccountId) {
            localStorage.setItem(KEY_ACCOUNT_ID, resolvedAccountId);
          }
        }
      } catch {
        // Fall through — deploy_worker will try without account_id
      }
    }

    updateWorkerBtn.disabled = true;
    updateWorkerBtn.textContent = "Updating\u2026";
    updateResult.style.display = "";
    updateResult.className = "settings-test-result test-pending";
    updateResult.textContent = "Re-deploying Worker\u2026";

    try {
      const newUrl = await invoke<string>("deploy_worker", {
        accountId: resolvedAccountId,
      });
      updateResult.className = "settings-test-result test-ok";
      updateResult.textContent = `Worker updated successfully: ${newUrl}`;
      urlInput.value = newUrl;
      // Re-test to refresh capabilities
      const status = await invoke<WorkerStatus>("test_worker_url", { workerUrl: newUrl });
      currentTestStatus = status;
      lastTestedUrl = newUrl;
      renderFeatureList(featureList, status);
      showUpdateButton(status);
      secretsHelp.style.display = status.reachable && !status.render_available ? "" : "none";
      if (status.reachable && !status.update_available) {
        updateResult.className = "settings-test-result test-ok";
        updateResult.textContent = "Worker updated and verified \u2014 all features refreshed";
      }
    } catch (e) {
      updateResult.className = "settings-test-result test-error";
      updateResult.textContent = `Update failed: ${e}`;
    } finally {
      updateWorkerBtn.disabled = false;
      updateWorkerBtn.textContent = "Update Worker";
    }
  });

  // Test connection
  testBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      testResult.className = "settings-test-result test-error";
      testResult.textContent = "Enter a Worker URL first";
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "Testing\u2026";
    testResult.className = "settings-test-result test-pending";
    testResult.textContent = "Connecting\u2026";

    try {
      const status = await invoke<WorkerStatus>("test_worker_url", { workerUrl: url });
      currentTestStatus = status;
      lastTestedUrl = url;

      if (!status.reachable) {
        testResult.className = "settings-test-result test-error";
        testResult.textContent = status.error || "Cannot reach Worker";
      } else if (status.update_available) {
        testResult.className = "settings-test-result test-warn";
        testResult.textContent =
          "Worker update available \u2014 click Update Worker to get new features";
      } else if (status.render_available) {
        testResult.className = "settings-test-result test-ok";
        testResult.textContent = "Fully configured \u2014 all features available";
      } else if (status.convert_available) {
        testResult.className = "settings-test-result test-warn";
        testResult.textContent = "Connected \u2014 Import works, but Render JS needs secrets";
      } else {
        testResult.className = "settings-test-result test-warn";
        testResult.textContent = status.error || "Reachable but returned unexpected response";
      }

      renderFeatureList(featureList, status);
      showUpdateButton(status);
      secretsHelp.style.display = status.reachable && !status.render_available ? "" : "none";
    } catch (e) {
      testResult.className = "settings-test-result test-error";
      testResult.textContent = `Error: ${e}`;
      currentTestStatus = null;
      renderFeatureList(featureList, null);
      showUpdateButton(null);
      secretsHelp.style.display = "none";
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test";
    }
  });

  // Set value via DOM API (avoids HTML injection from localStorage)
  urlInput.value = workerUrl;

  // Close actions
  const close = () => {
    overlay.remove();
    if (onCloseCallback) onCloseCallback();
  };
  const saveAndClose = () => {
    const url = urlInput.value.trim();
    setWorkerUrl(url);
    setImageConversionAllowed(allowImageCheckbox.checked);
    setAutoSaveEnabled(autosaveCheckbox.checked);
    setLintEnabled(lintCheckbox.checked);
    setSmartTypographyEnabled(smartTypoCheckbox.checked);
    markSetupDone();
    close();
    if (onSave) onSave(url);
  };

  document.getElementById("settings-close")!.addEventListener("click", close);
  document.getElementById("settings-cancel")!.addEventListener("click", close);
  document.getElementById("settings-save")!.addEventListener("click", saveAndClose);

  document.getElementById("settings-clear")!.addEventListener("click", () => {
    urlInput.value = "";
    currentTestStatus = null;
    lastTestedUrl = null;
    testResult.className = "settings-test-result";
    testResult.textContent = "";
    renderFeatureList(featureList, null);
    secretsHelp.style.display = "none";
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Auto-test if URL exists and hasn't been tested yet
  if (workerUrl && workerUrl !== lastTestedUrl) {
    testBtn.click();
  }
}

// --- MCP Config Generator ---

function generateMcpServerEntry(binaryPath: string, workerUrl: string) {
  return {
    command: binaryPath,
    ...(workerUrl ? { env: { MARKUPSIDEDOWN_WORKER_URL: workerUrl } } : {}),
  };
}

function generateMcpConfigJson(binaryPath: string, workerUrl: string) {
  return JSON.stringify(
    { mcpServers: { markupsidedown: generateMcpServerEntry(binaryPath, workerUrl) } },
    null,
    2,
  );
}

function renderClaudeDesktopChatTab(container: HTMLElement, binaryPath: string, workerUrl: string) {
  const json = generateMcpConfigJson(binaryPath, workerUrl);
  container.innerHTML = `
    <div class="settings-mcp-instruction">
      <strong>Claude Desktop — Chat</strong><br>
      For the standard Claude Desktop chat interface.
    </div>
    <div class="settings-mcp-steps">
      <div class="settings-mcp-step"><strong>1.</strong> Open Claude Desktop &rarr; Settings &rarr; Developer &rarr; Edit Config</div>
      <div class="settings-mcp-step"><strong>2.</strong> Paste the JSON below</div>
      <div class="settings-mcp-step"><strong>3.</strong> Restart Claude Desktop</div>
      <div class="settings-mcp-step"><strong>4.</strong> Start a conversation — MarkUpsideDown tools appear automatically</div>
    </div>
    <div class="settings-mcp-config-label">Config file: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></div>
    <pre class="settings-code settings-mcp-json">${escapeHtml(json)}</pre>
    <button class="settings-mcp-copy-btn" data-copy-text="${escapeHtml(json)}">Copy to clipboard</button>
    <div class="settings-mcp-note">
      MarkUpsideDown must be running for editor/file/git tools.
      Conversion/crawl tools work standalone if Worker URL is set.
    </div>
  `;
  attachCopyHandler(container);
}

function renderClaudeDesktopCodeTab(container: HTMLElement, binaryPath: string, workerUrl: string) {
  const json = generateMcpConfigJson(binaryPath, workerUrl);
  container.innerHTML = `
    <div class="settings-mcp-instruction">
      <strong>Claude Desktop — Code Tab</strong>
      <span class="mcp-badge-recommended">Recommended</span><br>
      The Code tab runs full Claude Code with access to the filesystem and all MCP tools.
    </div>
    <div class="settings-mcp-steps">
      <div class="settings-mcp-step"><strong>1.</strong> Open Claude Desktop &rarr; Code tab</div>
      <div class="settings-mcp-step"><strong>2.</strong> Select your project folder (the folder open in MarkUpsideDown)</div>
      <div class="settings-mcp-step"><strong>3.</strong> Add MCP config using one of the options below</div>
      <div class="settings-mcp-step"><strong>4.</strong> Start coding — Claude Code can read/write your editor via MCP and edit files directly</div>
    </div>
    <details class="settings-mcp-config-option" open>
      <summary>Option A — Global (all projects)</summary>
      <div class="settings-mcp-config-label">Add to <code>~/.claude/settings.json</code></div>
      <pre class="settings-code settings-mcp-json">${escapeHtml(json)}</pre>
      <button class="settings-mcp-copy-btn" data-copy-text="${escapeHtml(json)}">Copy to clipboard</button>
    </details>
    <details class="settings-mcp-config-option">
      <summary>Option B — Per-project</summary>
      <div class="settings-mcp-config-label">Create <code>.mcp.json</code> in your project root</div>
      <pre class="settings-code settings-mcp-json">${escapeHtml(json)}</pre>
      <button class="settings-mcp-copy-btn" data-copy-text="${escapeHtml(json)}">Copy to clipboard</button>
    </details>
    <div class="settings-mcp-note">
      Changes to files are auto-detected by MarkUpsideDown's file-watcher — no manual reload needed.
    </div>
  `;
  for (const btn of container.querySelectorAll<HTMLButtonElement>(".settings-mcp-copy-btn")) {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copyText || "";
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    });
  }
}

function renderClaudeCodeTerminalTab(
  container: HTMLElement,
  binaryPath: string,
  workerUrl: string,
) {
  const json = generateMcpConfigJson(binaryPath, workerUrl);
  container.innerHTML = `
    <div class="settings-mcp-instruction">
      <strong>Claude Code — Terminal</strong><br>
      For users who run Claude Code from the terminal (Zed, iTerm, etc.).
    </div>
    <div class="settings-mcp-steps">
      <div class="settings-mcp-step"><strong>1.</strong> Navigate to your project: <code>cd /path/to/your/project</code></div>
      <div class="settings-mcp-step"><strong>2.</strong> Add MCP config (per-project <code>.mcp.json</code> or global <code>~/.claude/settings.json</code>)</div>
      <div class="settings-mcp-step"><strong>3.</strong> Run <code>claude</code> in the terminal</div>
      <div class="settings-mcp-step"><strong>4.</strong> MCP tools are available — Claude Code can interact with the editor</div>
    </div>
    <div class="settings-mcp-config-label">Add to <code>.mcp.json</code> in your project root, or <code>~/.claude/settings.json</code> (global)</div>
    <pre class="settings-code settings-mcp-json">${escapeHtml(json)}</pre>
    <button class="settings-mcp-copy-btn" data-copy-text="${escapeHtml(json)}">Copy to clipboard</button>
  `;
  attachCopyHandler(container);
}

function renderCoworkTab(container: HTMLElement, binaryPath: string, workerUrl: string) {
  container.innerHTML = `
    <div class="settings-mcp-instruction">
      Cowork reads MCP servers from Claude Desktop's global config.
    </div>
    <div class="settings-mcp-cowork-steps">
      <div class="settings-mcp-cowork-step">
        <strong>1.</strong> Click <em>Install</em> to add MarkUpsideDown to Claude Desktop
      </div>
      <div class="settings-mcp-cowork-step">
        <strong>2.</strong> Restart Claude Desktop
      </div>
      <div class="settings-mcp-cowork-step">
        <strong>3.</strong> Optionally create a workspace folder with CLAUDE.md context
      </div>
    </div>
    <div class="settings-mcp-cowork-actions">
      <div class="settings-mcp-cowork-path-row">
        <button id="settings-cowork-install" class="primary">Install</button>
        <span id="settings-cowork-install-result" class="settings-mcp-cowork-install-status"></span>
      </div>
    </div>
    <details class="settings-mcp-cowork-details">
      <summary>Workspace folder (optional)</summary>
      <div class="settings-mcp-cowork-detail-text">
        Create a folder with <code>CLAUDE.md</code> listing available MCP tools as context for Cowork.
      </div>
      <div class="settings-mcp-cowork-actions">
        <div class="settings-mcp-cowork-path-row">
          <input type="text" id="settings-cowork-path" class="settings-mcp-cowork-path" placeholder="~/Claude-Workspace" value="~/Claude-Workspace" />
          <button id="settings-cowork-browse">Browse</button>
          <button id="settings-cowork-create">Create</button>
        </div>
        <div id="settings-cowork-result" class="settings-test-result"></div>
      </div>
    </details>
  `;

  const installBtn = container.querySelector("#settings-cowork-install") as HTMLButtonElement;
  const installResult = container.querySelector("#settings-cowork-install-result")!;
  const createBtn = container.querySelector("#settings-cowork-create") as HTMLButtonElement;
  const browseBtn = container.querySelector("#settings-cowork-browse") as HTMLButtonElement;
  const pathInput = container.querySelector("#settings-cowork-path") as HTMLInputElement;
  const resultEl = container.querySelector("#settings-cowork-result")!;

  installBtn.addEventListener("click", async () => {
    installBtn.disabled = true;
    installBtn.textContent = "Installing\u2026";
    try {
      const configPath = await invoke<string>("install_mcp_to_claude_desktop", {
        mcpBinaryPath: binaryPath,
        workerUrl,
      });
      installResult.className = "settings-mcp-cowork-install-status test-ok";
      installResult.textContent = `Installed \u2014 restart Claude Desktop to activate`;
      installBtn.textContent = "Reinstall";
      installBtn.title = configPath;
    } catch (e) {
      installResult.className = "settings-mcp-cowork-install-status test-error";
      installResult.textContent = `Error: ${e}`;
      installBtn.textContent = "Install";
    } finally {
      installBtn.disabled = false;
    }
  });

  browseBtn.addEventListener("click", async () => {
    const { open: openDialog } = window.__TAURI__.dialog;
    const dir = await openDialog({ directory: true });
    if (dir) pathInput.value = dir;
  });

  createBtn.addEventListener("click", async () => {
    const folderPath = pathInput.value.trim();
    if (!folderPath) {
      resultEl.className = "settings-test-result test-error";
      resultEl.textContent = "Enter a folder path";
      return;
    }
    createBtn.disabled = true;
    createBtn.textContent = "Creating\u2026";
    try {
      const created = await invoke<string>("create_cowork_workspace", {
        folderPath,
      });
      resultEl.className = "settings-test-result test-ok";
      resultEl.textContent = `Created at ${created}`;
    } catch (e) {
      resultEl.className = "settings-test-result test-error";
      resultEl.textContent = `Error: ${e}`;
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = "Create";
    }
  });
}

function attachCopyHandler(container: HTMLElement) {
  const btn = container.querySelector<HTMLButtonElement>(".settings-mcp-copy-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const text = btn.dataset.copyText || "";
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  });
}

async function initMcpSection() {
  const bridgeStatus = document.getElementById("settings-mcp-bridge-status");
  const binaryPathEl = document.getElementById("settings-mcp-binary-path");
  const tabContent = document.getElementById("settings-mcp-tab-content");
  const tabs = document.querySelectorAll<HTMLButtonElement>(".settings-mcp-tab");

  if (!bridgeStatus || !binaryPathEl || !tabContent) return;

  // Bridge status — always active when app is running
  bridgeStatus.textContent = "Active (app is running)";
  bridgeStatus.classList.add("mcp-status-ok");

  // State that gets populated after async resolve
  let mcpBinaryPath = "";
  let workerUrl = getWorkerUrl();

  function showTab(target: string) {
    tabContent.innerHTML = "";
    const renderers: Record<string, (container: HTMLElement) => void> = {
      "claude-desktop-chat": (c) => renderClaudeDesktopChatTab(c, mcpBinaryPath, workerUrl),
      "claude-desktop-code": (c) => renderClaudeDesktopCodeTab(c, mcpBinaryPath, workerUrl),
      "claude-code-terminal": (c) => renderClaudeCodeTerminalTab(c, mcpBinaryPath, workerUrl),
      cowork: (c) => renderCoworkTab(c, mcpBinaryPath, workerUrl),
    };
    const renderer = renderers[target];
    if (renderer) renderer(tabContent);
  }

  function getActiveTarget(): string {
    for (const t of tabs) {
      if (t.classList.contains("active")) return t.dataset.mcpTarget || "claude-desktop-chat";
    }
    return "claude-desktop-chat";
  }

  // Tab switching — attach immediately (synchronous)
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) t.classList.remove("active");
      tab.classList.add("active");
      showTab(tab.dataset.mcpTarget || "claude-desktop-chat");
    });
  }

  // Show default tab immediately (with empty binaryPath for now)
  showTab("claude-desktop-chat");

  // Resolve MCP binary path asynchronously, then re-render active tab
  try {
    mcpBinaryPath = await invoke<string>("get_mcp_binary_path");
    binaryPathEl.textContent = mcpBinaryPath;
    binaryPathEl.classList.add("mcp-status-ok");
  } catch {
    binaryPathEl.textContent = "Not found";
    binaryPathEl.classList.add("mcp-status-error");
  }

  // Re-render active tab with resolved binary path
  showTab(getActiveTarget());
}

// Returns the worker URL, or shows settings panel if not configured.
// Returns a Promise that resolves to the URL or null.
export function ensureWorkerUrl(): Promise<string | null> {
  const url = getWorkerUrl();
  if (url) return Promise.resolve(url);

  return new Promise((resolve) => {
    let resolved = false;
    showSettings({
      onSave: (savedUrl) => {
        resolved = true;
        resolve(savedUrl || null);
      },
      onClose: () => {
        if (!resolved) resolve(null);
      },
    });
  });
}

// Show settings on first launch
export function checkFirstRun() {
  if (!isSetupDone() && !getWorkerUrl()) {
    showSettings();
  }
}

// Re-exported from html-utils.ts for backward compatibility
export { escapeHtml } from "./html-utils.ts";
