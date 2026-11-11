import { basename } from "./path-utils.ts";

const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

let panelEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let onCloned: ((repoPath: string) => void) | null = null;

export function initClonePanel(
  el: HTMLElement,
  { onComplete }: { onComplete: (repoPath: string) => void },
) {
  panelEl = el;
  onCloned = onComplete;
  render();
}

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = "";

  // URL input
  const urlRow = document.createElement("div");
  urlRow.className = "clone-input-row";

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "field field-sm clone-input";
  urlInput.placeholder = "https://github.com/owner/repo.git";
  urlRow.appendChild(urlInput);

  panelEl.appendChild(urlRow);

  // Destination row
  const destRow = document.createElement("div");
  destRow.className = "clone-input-row";

  const destInput = document.createElement("input");
  destInput.type = "text";
  destInput.className = "field field-sm clone-input clone-dest-input";
  destInput.placeholder = "Destination folder…";
  destInput.readOnly = true;
  destRow.appendChild(destInput);

  const browseBtn = document.createElement("button");
  browseBtn.className = "btn btn-sm clone-btn";
  browseBtn.textContent = "Browse";
  browseBtn.addEventListener("click", async () => {
    const path = await openDialog({ directory: true });
    if (path) destInput.value = path as string;
  });
  destRow.appendChild(browseBtn);

  panelEl.appendChild(destRow);

  // Clone button
  const actionRow = document.createElement("div");
  actionRow.className = "clone-input-row";

  const cloneBtn = document.createElement("button");
  cloneBtn.className = "btn btn-primary btn-block clone-btn";
  cloneBtn.textContent = "Clone";
  cloneBtn.addEventListener("click", () => doClone(urlInput, destInput, cloneBtn));
  actionRow.appendChild(cloneBtn);

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doClone(urlInput, destInput, cloneBtn);
  });

  panelEl.appendChild(actionRow);

  // Status
  statusEl = document.createElement("div");
  statusEl.className = "clone-status";
  panelEl.appendChild(statusEl);
}

function setStatus(text: string, cls: string) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `clone-status ${cls}`;
}

async function doClone(
  urlInput: HTMLInputElement,
  destInput: HTMLInputElement,
  cloneBtn: HTMLButtonElement,
) {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Enter a repository URL", "clone-status-error");
    return;
  }

  const dest = destInput.value.trim();
  if (!dest) {
    setStatus("Choose a destination folder", "clone-status-error");
    return;
  }

  // Derive repo name from URL
  const repoName = basename(url.replace(/\/+$/, "").replace(/\.git$/, "")) || "repo";
  const fullDest = `${dest}/${repoName}`;

  setStatus("Cloning…", "clone-status-pending");
  cloneBtn.disabled = true;

  try {
    await invoke<string>("git_clone", { url, dest: fullDest });
    setStatus(`Cloned to ${repoName}`, "clone-status-ok");
    onCloned?.(fullDest);
  } catch (e: unknown) {
    setStatus(`Error: ${e}`, "clone-status-error");
  } finally {
    cloneBtn.disabled = false;
  }
}
