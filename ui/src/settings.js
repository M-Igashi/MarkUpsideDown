const { invoke } = window.__TAURI__.core;

const STORAGE_KEY_WORKER_URL = "markupsidedown:workerUrl";
const STORAGE_KEY_SETUP_DONE = "markupsidedown:setupDone";

export function getWorkerUrl() {
  return localStorage.getItem(STORAGE_KEY_WORKER_URL) || "";
}

export function setWorkerUrl(url) {
  if (url) {
    localStorage.setItem(STORAGE_KEY_WORKER_URL, url.replace(/\/+$/, ""));
  } else {
    localStorage.removeItem(STORAGE_KEY_WORKER_URL);
  }
}

export function isSetupDone() {
  return localStorage.getItem(STORAGE_KEY_SETUP_DONE) === "1";
}

function markSetupDone() {
  localStorage.setItem(STORAGE_KEY_SETUP_DONE, "1");
}

let currentTestStatus = null; // cached last test result

function featureRows(status) {
  const hasWorker = Boolean(status && status.reachable);
  const hasConvert = Boolean(status && status.convert_available);
  const hasRender = Boolean(status && status.render_available);

  return [
    { name: "Open / Save / Export PDF", ok: true, hint: "Always available" },
    { name: "Fetch URL (standard)", ok: true, hint: "Always available" },
    { name: "Table Editor / Copy Rich Text", ok: true, hint: "Always available" },
    {
      name: "Import documents",
      ok: hasConvert,
      hint: hasConvert ? "Ready" : "Needs Worker URL",
    },
    {
      name: "Fetch URL (Render JS)",
      ok: hasRender,
      hint: hasRender ? "Ready" : hasWorker ? "Needs Worker secrets" : "Needs Worker URL + secrets",
    },
  ];
}

function renderFeatureList(container, status) {
  const rows = featureRows(status);
  container.innerHTML = rows
    .map(
      (r) => `
    <div class="feature-row ${r.ok ? "feature-ok" : "feature-needs"}">
      <span class="feature-icon">${r.ok ? "\u2713" : "\u25CF"}</span>
      <span class="feature-name">${r.name}</span>
      <span class="feature-hint">${r.hint}</span>
    </div>`
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

function renderSetupProgress(container, currentStep, stepStates) {
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

async function startAutoSetup(progressContainer, urlInput, onComplete) {
  const states = {};
  const update = (id, state) => {
    states[id] = state;
    renderSetupProgress(progressContainer, id, states);
  };
  const fail = (id, message) => {
    update(id, "error");
    showSetupError(progressContainer, message);
    onComplete(null, null);
  };

  let accountId = null;

  // Step 1: Check wrangler
  update("wrangler", "running");
  let status;
  try {
    status = await invoke("check_wrangler_status");
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
      status = await invoke("check_wrangler_status");
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

  // Step 3: Deploy
  update("deploy", "running");
  let workerUrl;
  try {
    workerUrl = await invoke("deploy_worker", { accountId });
  } catch (e) {
    return fail("deploy", `Deploy failed: ${e}`);
  }
  update("deploy", "done");

  // Step 4: Secrets
  update("secrets", "running");
  try {
    await invoke("setup_worker_secrets", { accountId });
  } catch (e) {
    update("secrets", "error");
    urlInput.value = workerUrl;
    showSetupError(
      progressContainer,
      `Worker deployed at ${workerUrl} but secret setup failed: ${e}\nYou can set secrets manually or use Import without Render JS.`
    );
    onComplete(workerUrl, null);
    return;
  }
  update("secrets", "done");

  // Step 5: Verify
  update("verify", "running");
  urlInput.value = workerUrl;
  try {
    const testStatus = await invoke("test_worker_url", {
      workerUrl: workerUrl.replace(/\/+$/, ""),
    });
    currentTestStatus = testStatus;
    if (testStatus.reachable) {
      update("verify", "done");
      showSetupSuccess(progressContainer, workerUrl);
    } else {
      update("verify", "error");
      showSetupError(progressContainer, `Worker deployed but health check failed. URL: ${workerUrl}`);
    }
    onComplete(workerUrl, testStatus);
  } catch (e) {
    update("verify", "error");
    showSetupError(progressContainer, `Health check error: ${e}`);
    onComplete(workerUrl, null);
  }
}

function showSetupError(container, message) {
  const errDiv = container.querySelector(".setup-error") || document.createElement("div");
  errDiv.className = "setup-error";
  errDiv.textContent = message;
  if (!errDiv.parentNode) container.appendChild(errDiv);
}

function showSetupSuccess(container, url) {
  const div = container.querySelector(".setup-success") || document.createElement("div");
  div.className = "setup-success";
  div.textContent = `Setup complete! Worker: ${url}`;
  if (!div.parentNode) container.appendChild(div);
}

function showAccountPicker(container, accounts) {
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

// --- Settings Panel ---

export function showSettings({ onSave, onClose: onCloseCallback } = {}) {
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
          <div id="settings-setup-progress" class="settings-setup-progress" style="display:none"></div>
        </div>

        <div class="settings-divider">
          <span>Or configure manually</span>
        </div>

        <div class="settings-deploy">
          <span class="settings-deploy-label">Deploy:</span>
          <code>cd worker && wrangler deploy</code>
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

      <div class="settings-actions">
        <button id="settings-clear" class="settings-clear-btn">Clear URL</button>
        <span class="spacer"></span>
        <button id="settings-cancel">Cancel</button>
        <button id="settings-save" class="primary">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const urlInput = document.getElementById("settings-worker-url");
  const testBtn = document.getElementById("settings-test-btn");
  const testResult = document.getElementById("settings-test-result");
  const featureList = document.getElementById("settings-feature-list");
  const secretsHelp = document.getElementById("settings-secrets-help");
  const autoSetupBtn = document.getElementById("settings-auto-setup-btn");
  const setupProgress = document.getElementById("settings-setup-progress");

  // Initial feature list
  renderFeatureList(featureList, currentTestStatus);
  if (currentTestStatus?.reachable && !currentTestStatus?.render_available) {
    secretsHelp.style.display = "";
  }

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
        secretsHelp.style.display =
          testStatus.reachable && !testStatus.render_available ? "" : "none";
      }
      autoSetupBtn.disabled = false;
      autoSetupBtn.textContent = "Setup with Cloudflare";
    });
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
      const status = await invoke("test_worker_url", { workerUrl: url.replace(/\/+$/, "") });
      currentTestStatus = status;

      if (!status.reachable) {
        testResult.className = "settings-test-result test-error";
        testResult.textContent = status.error || "Cannot reach Worker";
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
      secretsHelp.style.display =
        status.reachable && !status.render_available ? "" : "none";
    } catch (e) {
      testResult.className = "settings-test-result test-error";
      testResult.textContent = `Error: ${e}`;
      currentTestStatus = null;
      renderFeatureList(featureList, null);
      secretsHelp.style.display = "none";
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test";
    }
  });

  // Set value via DOM API (avoids HTML injection from localStorage)
  urlInput.value = workerUrl;

  // Close actions
  const close = () => { overlay.remove(); if (onCloseCallback) onCloseCallback(); };
  const saveAndClose = () => {
    const url = urlInput.value.trim();
    setWorkerUrl(url);
    markSetupDone();
    close();
    if (onSave) onSave(url);
  };

  document.getElementById("settings-close").addEventListener("click", close);
  document.getElementById("settings-cancel").addEventListener("click", close);
  document.getElementById("settings-save").addEventListener("click", saveAndClose);

  document.getElementById("settings-clear").addEventListener("click", () => {
    urlInput.value = "";
    currentTestStatus = null;
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

  // Auto-test if URL already exists
  if (workerUrl) {
    testBtn.click();
  }
}

// Returns the worker URL, or shows settings panel if not configured.
// Returns a Promise that resolves to the URL or null.
export function ensureWorkerUrl() {
  const url = getWorkerUrl();
  if (url) return Promise.resolve(url);

  return new Promise((resolve) => {
    let resolved = false;
    showSettings({
      onSave: (savedUrl) => { resolved = true; resolve(savedUrl || null); },
      onClose: () => { if (!resolved) resolve(null); },
    });
  });
}

// Show settings on first launch
export function checkFirstRun() {
  if (!isSetupDone() && !getWorkerUrl()) {
    showSettings();
  }
}
