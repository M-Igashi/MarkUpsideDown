const { invoke } = window.__TAURI__.core;

interface GitHubRef {
  owner: string;
  repo: string;
  type: string;
  number: number;
}

let panelEl: HTMLElement | null = null;
let onInsert: ((body: string, ref: string) => void) | null = null;
let statusEl: HTMLElement | null = null;

export function initGitHubPanel(
  el: HTMLElement,
  { onContent }: { onContent: (body: string, ref: string) => void },
) {
  panelEl = el;
  onInsert = onContent;
  render();
}

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "gh-panel-header";
  header.textContent = "GitHub";
  panelEl.appendChild(header);

  // Input row
  const inputRow = document.createElement("div");
  inputRow.className = "gh-input-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "gh-input";
  input.placeholder = "owner/repo#123";
  inputRow.appendChild(input);

  const fetchBtn = document.createElement("button");
  fetchBtn.className = "gh-fetch-btn";
  fetchBtn.textContent = "Fetch";
  fetchBtn.addEventListener("click", () => fetchRef(input));
  inputRow.appendChild(fetchBtn);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fetchRef(input);
  });

  panelEl.appendChild(inputRow);

  // Status
  statusEl = document.createElement("div");
  statusEl.className = "gh-status";
  panelEl.appendChild(statusEl);
}

async function fetchRef(input: HTMLInputElement) {
  const raw = input.value.trim();
  if (!raw) return;

  const parsed = parseRef(raw);

  if (!parsed) {
    if (statusEl) statusEl.textContent = "Format: owner/repo#123 or GitHub URL";
    if (statusEl) statusEl.className = "gh-status gh-status-error";
    return;
  }

  if (statusEl) statusEl.textContent = "Fetching…";
  if (statusEl) statusEl.className = "gh-status gh-status-pending";

  try {
    let body: string;
    if (parsed.type === "pull") {
      body = await invoke<string>("github_fetch_pr", {
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
      });
    } else {
      body = await invoke<string>("github_fetch_issue", {
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
      });
    }

    if (statusEl) statusEl.textContent = `Fetched ${parsed.type} #${parsed.number}`;
    if (statusEl) statusEl.className = "gh-status gh-status-ok";

    onInsert?.(body, `${parsed.owner}/${parsed.repo}#${parsed.number}`);
  } catch (e: unknown) {
    if (statusEl) statusEl.textContent = `Error: ${e}`;
    if (statusEl) statusEl.className = "gh-status gh-status-error";
  }
}

function parseRef(input: string): GitHubRef | null {
  // GitHub URL: https://github.com/owner/repo/issues/123 or /pull/123
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      type: urlMatch[3] === "pull" ? "pull" : "issue",
      number: parseInt(urlMatch[4], 10),
    };
  }

  // Short form: owner/repo#123
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      type: "issue", // default to issue, gh CLI handles both
      number: parseInt(shortMatch[3], 10),
    };
  }

  return null;
}
