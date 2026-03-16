const { invoke } = window.__TAURI__.core;

// --- State ---

interface GitFile {
  path: string;
  status: string;
  staged: boolean;
}

interface GitData {
  branch: string;
  files: GitFile[];
  is_repo: boolean;
}

let panelEl: HTMLElement | null = null;
let repoPath: string | null = null;
let gitData: GitData | null = null;
let onFileClick: ((path: string) => void) | null = null;

export function initGitPanel(el: HTMLElement, { onOpen }: { onOpen: (path: string) => void }) {
  panelEl = el;
  onFileClick = onOpen;
  render();
}

export function setRepoPath(path: string | null) {
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
    gitData = await invoke<GitData>("git_status", { repoPath });
  } catch {
    gitData = null;
  }
  render();
}

export function getStatusMap(): Map<string, GitFile> {
  if (!gitData || !gitData.is_repo) return new Map();
  const map = new Map<string, GitFile>();
  for (const f of gitData.files) {
    // Use the highest-priority status (staged > unstaged)
    if (!map.has(f.path) || f.staged) {
      map.set(f.path, f);
    }
  }
  return map;
}

// --- Actions ---

async function stageFile(filePath: string) {
  if (!repoPath) return;
  try {
    await invoke("git_stage", { repoPath, filePath });
    await refresh();
  } catch (e) {
    alert(`Stage failed: ${e}`);
  }
}

async function unstageFile(filePath: string) {
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
  const input = panelEl!.querySelector<HTMLInputElement>(".git-commit-input");
  const message = input?.value.trim();
  if (!message) return;
  try {
    await invoke("git_commit", { repoPath, message });
    input!.value = "";
    await refresh();
  } catch (e) {
    alert(`Commit failed: ${e}`);
  }
}

async function gitRemoteAction(command: string, label: string) {
  if (!repoPath) return;
  try {
    await invoke(command, { repoPath });
    await refresh();
  } catch (e) {
    alert(`${label} failed: ${e}`);
  }
}

// --- Render ---

function statusLabel(status: string): string {
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

export function statusClass(status: string): string {
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

export function statusSuffix(status: string): string {
  return statusClass(status).replace("git-", "");
}

export function createGitBadge(status: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "sidebar-git-badge";
  badge.textContent = status;
  badge.classList.add(statusClass(status));
  return badge;
}

export function applyGitNameStyle(nameEl: Element, status: string) {
  nameEl.classList.add(`sidebar-name-${statusSuffix(status)}`);
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

  for (const [label, command] of [
    ["Fetch", "git_fetch"],
    ["Pull", "git_pull"],
    ["Push", "git_push"],
  ] as const) {
    const btn = document.createElement("button");
    btn.className = "git-action-btn";
    btn.textContent = label;
    btn.addEventListener("click", () => gitRemoteAction(command, label));
    actions.appendChild(btn);
  }

  panelEl.appendChild(actions);
}

function createSection(title: string, files: GitFile[], isStaged: boolean): HTMLElement {
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
