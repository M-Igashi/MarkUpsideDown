const { invoke } = window.__TAURI__.core;

// --- State ---

let panelEl = null;
let repoPath = null;
let gitData = null; // { branch, files, is_repo }
let onFileClick = null;

export function initGitPanel(el, { onOpen }) {
  panelEl = el;
  onFileClick = onOpen;
  render();
}

export function setRepoPath(path) {
  repoPath = path;
  if (path) {
    refresh();
  } else {
    gitData = null;
    render();
  }
}

export async function refresh() {
  if (!repoPath) return;
  try {
    gitData = await invoke("git_status", { repoPath });
  } catch {
    gitData = null;
  }
  render();
}

export function getFileStatus(filePath) {
  if (!gitData || !gitData.is_repo) return null;
  // Match by relative path suffix
  for (const f of gitData.files) {
    if (filePath.endsWith(f.path) || f.path.endsWith(filePath.split("/").pop())) {
      return f;
    }
  }
  return null;
}

export function getStatusMap() {
  if (!gitData || !gitData.is_repo) return new Map();
  const map = new Map();
  for (const f of gitData.files) {
    // Use the highest-priority status (staged > unstaged)
    if (!map.has(f.path) || f.staged) {
      map.set(f.path, f);
    }
  }
  return map;
}

// --- Actions ---

async function stageFile(filePath) {
  if (!repoPath) return;
  try {
    await invoke("git_stage", { repoPath, filePath });
    await refresh();
  } catch (e) {
    alert(`Stage failed: ${e}`);
  }
}

async function unstageFile(filePath) {
  if (!repoPath) return;
  try {
    await invoke("git_unstage", { repoPath, filePath });
    await refresh();
  } catch (e) {
    alert(`Unstage failed: ${e}`);
  }
}

async function commitChanges() {
  if (!repoPath) return;
  const input = panelEl.querySelector(".git-commit-input");
  const message = input?.value.trim();
  if (!message) return;
  try {
    await invoke("git_commit", { repoPath, message });
    input.value = "";
    await refresh();
  } catch (e) {
    alert(`Commit failed: ${e}`);
  }
}

async function gitPush() {
  if (!repoPath) return;
  try {
    await invoke("git_push", { repoPath });
    await refresh();
  } catch (e) {
    alert(`Push failed: ${e}`);
  }
}

async function gitPull() {
  if (!repoPath) return;
  try {
    await invoke("git_pull", { repoPath });
    await refresh();
  } catch (e) {
    alert(`Pull failed: ${e}`);
  }
}

async function gitFetch() {
  if (!repoPath) return;
  try {
    await invoke("git_fetch", { repoPath });
    await refresh();
  } catch (e) {
    alert(`Fetch failed: ${e}`);
  }
}

// --- Render ---

function statusLabel(status) {
  switch (status) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "?":
      return "untracked";
    default:
      return status;
  }
}

function statusClass(status) {
  switch (status) {
    case "M":
      return "git-modified";
    case "A":
      return "git-added";
    case "D":
      return "git-deleted";
    case "?":
      return "git-untracked";
    default:
      return "git-modified";
  }
}

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = "";

  if (!repoPath || !gitData || !gitData.is_repo) {
    const empty = document.createElement("div");
    empty.className = "git-panel-empty";
    empty.textContent = repoPath ? "Not a git repository" : "Open a folder to see git status";
    panelEl.appendChild(empty);
    return;
  }

  // Branch
  const branchRow = document.createElement("div");
  branchRow.className = "git-branch-row";
  branchRow.textContent = `\u{e0a0} ${gitData.branch || "HEAD (detached)"}`;
  panelEl.appendChild(branchRow);

  // Separate staged vs unstaged
  const staged = gitData.files.filter((f) => f.staged);
  const unstaged = gitData.files.filter((f) => !f.staged);

  if (staged.length === 0 && unstaged.length === 0) {
    const clean = document.createElement("div");
    clean.className = "git-panel-clean";
    clean.textContent = "Working tree clean";
    panelEl.appendChild(clean);
  }

  // Staged section
  if (staged.length > 0) {
    panelEl.appendChild(createSection("Staged Changes", staged, true));
  }

  // Unstaged section
  if (unstaged.length > 0) {
    panelEl.appendChild(createSection("Changes", unstaged, false));
  }

  // Commit input (show if there are staged files)
  if (staged.length > 0) {
    const commitRow = document.createElement("div");
    commitRow.className = "git-commit-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "git-commit-input";
    input.placeholder = "Commit message…";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        commitChanges();
      }
    });
    commitRow.appendChild(input);

    const commitBtn = document.createElement("button");
    commitBtn.className = "git-commit-btn";
    commitBtn.textContent = "Commit";
    commitBtn.addEventListener("click", commitChanges);
    commitRow.appendChild(commitBtn);

    panelEl.appendChild(commitRow);
  }

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "git-actions-row";

  for (const [label, fn] of [
    ["Fetch", gitFetch],
    ["Pull", gitPull],
    ["Push", gitPush],
  ]) {
    const btn = document.createElement("button");
    btn.className = "git-action-btn";
    btn.textContent = label;
    btn.addEventListener("click", fn);
    actions.appendChild(btn);
  }

  panelEl.appendChild(actions);
}

function createSection(title, files, isStaged) {
  const section = document.createElement("div");
  section.className = "git-section";

  const header = document.createElement("div");
  header.className = "git-section-header";
  header.textContent = `${title} (${files.length})`;
  section.appendChild(header);

  const list = document.createElement("div");
  list.className = "git-file-list";

  for (const file of files) {
    const row = document.createElement("div");
    row.className = `git-file-row ${statusClass(file.status)}`;

    const statusBadge = document.createElement("span");
    statusBadge.className = "git-file-status";
    statusBadge.textContent = file.status;
    statusBadge.title = statusLabel(file.status);
    row.appendChild(statusBadge);

    const name = document.createElement("span");
    name.className = "git-file-name";
    name.textContent = file.path;
    name.title = file.path;
    row.appendChild(name);

    const actionBtn = document.createElement("button");
    actionBtn.className = "git-file-action";
    if (isStaged) {
      actionBtn.textContent = "−";
      actionBtn.title = "Unstage";
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        unstageFile(file.path);
      });
    } else {
      actionBtn.textContent = "+";
      actionBtn.title = "Stage";
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        stageFile(file.path);
      });
    }
    row.appendChild(actionBtn);

    row.addEventListener("click", () => {
      if (onFileClick && file.status !== "D") {
        const fullPath = `${repoPath}/${file.path}`;
        onFileClick(fullPath);
      }
    });

    list.appendChild(row);
  }

  section.appendChild(list);
  return section;
}
