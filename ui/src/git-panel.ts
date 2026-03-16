const { invoke } = window.__TAURI__.core;

// --- State ---

interface GitFile {
  path: string;
  status: string;
  staged: boolean;
  added_lines: number;
  removed_lines: number;
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
let commitMessage = "";

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

export function getBranch(): string | null {
  return gitData?.is_repo ? gitData.branch || null : null;
}

export function isRepo(): boolean {
  return gitData?.is_repo ?? false;
}

export function getChangeCount(): number {
  if (!gitData?.files) return 0;
  // Deduplicate: count unique paths
  const paths = new Set(gitData.files.map((f) => f.path));
  return paths.size;
}

export function getStatusMap(): Map<string, GitFile> {
  if (!gitData || !gitData.is_repo) return new Map();
  const map = new Map<string, GitFile>();
  for (const f of gitData.files) {
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
    showStatus(`Stage failed: ${e}`, true);
  }
}

async function stageAll() {
  if (!repoPath) return;
  try {
    await invoke("git_stage_all", { repoPath });
    await refresh();
  } catch (e) {
    showStatus(`Stage all failed: ${e}`, true);
  }
}

async function unstageFile(filePath: string) {
  if (!repoPath) return;
  try {
    await invoke("git_unstage", { repoPath, filePath });
    await refresh();
  } catch (e) {
    showStatus(`Unstage failed: ${e}`, true);
  }
}

async function commitChanges(mode: "staged" | "tracked") {
  if (!repoPath || !commitMessage.trim()) return;
  const message = commitMessage.trim();
  try {
    if (mode === "tracked") {
      // Stage all tracked files then commit
      await invoke("git_stage_all", { repoPath });
    }
    await invoke("git_commit", { repoPath, message });
    commitMessage = "";
    await refresh();
  } catch (e) {
    showStatus(`Commit failed: ${e}`, true);
  }
}

async function gitRemoteAction(command: string, label: string, btn: HTMLButtonElement) {
  if (!repoPath) return;
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="git-spinner"></span> ${label}`;
  btn.disabled = true;
  try {
    await invoke(command, { repoPath });
    btn.innerHTML = original;
    btn.disabled = false;
    showStatus(`${label} completed`, false);
    await refresh();
  } catch (e) {
    btn.innerHTML = original;
    btn.disabled = false;
    showStatus(`${label} failed: ${e}`, true);
  }
}

function showStatus(message: string, isError: boolean) {
  if (!panelEl) return;
  const el = panelEl.querySelector(".git-status-msg");
  if (!el) return;
  el.textContent = message;
  el.className = `git-status-msg ${isError ? "error" : "ok"}`;
  setTimeout(() => {
    el.textContent = "";
    el.className = "git-status-msg";
  }, 4000);
}

// --- Render helpers ---

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
    case "C":
      return "copied";
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
    case "R":
      return "git-renamed";
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

// --- Render ---

function render() {
  if (!panelEl) return;
  panelEl.innerHTML = "";

  if (!repoPath || !gitData || !gitData.is_repo) {
    const msg = document.createElement("div");
    msg.className = "git-panel-clean";
    msg.textContent = repoPath ? "Not a git repository" : "Open a folder to see git status";
    panelEl.appendChild(msg);
    return;
  }

  const staged = gitData.files.filter((f) => f.staged);
  const unstaged = gitData.files.filter((f) => !f.staged);
  const totalChanges = getChangeCount();

  // --- Scrollable file list area ---
  const fileArea = document.createElement("div");
  fileArea.className = "git-file-area";

  // Header: "N Changes ... Stage All"
  const header = document.createElement("div");
  header.className = "git-changes-header";

  const changesLabel = document.createElement("span");
  changesLabel.className = "git-changes-label";
  changesLabel.textContent =
    totalChanges === 0 ? "No changes" : `${totalChanges} Change${totalChanges > 1 ? "s" : ""}`;
  header.appendChild(changesLabel);

  if (unstaged.length > 0) {
    const stageAllBtn = document.createElement("button");
    stageAllBtn.className = "git-stage-all-btn";
    stageAllBtn.textContent = "Stage All";
    stageAllBtn.addEventListener("click", stageAll);
    header.appendChild(stageAllBtn);
  }

  fileArea.appendChild(header);

  if (totalChanges === 0) {
    const clean = document.createElement("div");
    clean.className = "git-panel-clean";
    clean.textContent = "Working tree clean";
    fileArea.appendChild(clean);
  }

  // Staged section
  if (staged.length > 0) {
    fileArea.appendChild(createSection("Staged", staged, true));
  }

  // Unstaged section
  if (unstaged.length > 0) {
    const label = staged.length > 0 ? "Unstaged" : "Tracked";
    fileArea.appendChild(createSection(label, unstaged, false));
  }

  panelEl.appendChild(fileArea);

  // --- Bottom sticky area ---
  const bottom = document.createElement("div");
  bottom.className = "git-bottom";

  // Status message
  const statusMsg = document.createElement("div");
  statusMsg.className = "git-status-msg";
  bottom.appendChild(statusMsg);

  // Branch row with Fetch button
  const branchRow = document.createElement("div");
  branchRow.className = "git-branch-row";

  const branchLabel = document.createElement("span");
  branchLabel.className = "git-branch-label";
  branchLabel.textContent = `\u{e0a0} ${gitData.branch || "HEAD (detached)"}`;
  branchRow.appendChild(branchLabel);

  const fetchBtn = document.createElement("button");
  fetchBtn.className = "git-fetch-btn";
  fetchBtn.innerHTML = "⟳ Fetch";
  fetchBtn.addEventListener("click", () => gitRemoteAction("git_fetch", "Fetch", fetchBtn));
  branchRow.appendChild(fetchBtn);

  bottom.appendChild(branchRow);

  // Commit textarea
  const commitArea = document.createElement("div");
  commitArea.className = "git-commit-area";

  const textarea = document.createElement("textarea");
  textarea.className = "git-commit-textarea";
  textarea.placeholder = "Enter commit message";
  textarea.value = commitMessage;
  textarea.rows = 3;
  textarea.addEventListener("input", () => {
    commitMessage = textarea.value;
    updateCommitBtnState();
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && commitMessage.trim()) {
      e.preventDefault();
      commitChanges(staged.length > 0 ? "staged" : "tracked");
    }
  });
  commitArea.appendChild(textarea);

  // Bottom action row: Pull/Push ... Commit button
  const actionRow = document.createElement("div");
  actionRow.className = "git-action-row";

  const leftActions = document.createElement("div");
  leftActions.className = "git-action-left";

  const pullBtn = document.createElement("button");
  pullBtn.className = "git-icon-btn";
  pullBtn.title = "Pull";
  pullBtn.innerHTML = "↓ Pull";
  pullBtn.addEventListener("click", () => gitRemoteAction("git_pull", "Pull", pullBtn));
  leftActions.appendChild(pullBtn);

  const pushBtn = document.createElement("button");
  pushBtn.className = "git-icon-btn";
  pushBtn.title = "Push";
  pushBtn.innerHTML = "↑ Push";
  pushBtn.addEventListener("click", () => gitRemoteAction("git_push", "Push", pushBtn));
  leftActions.appendChild(pushBtn);

  actionRow.appendChild(leftActions);

  const commitBtn = document.createElement("button");
  commitBtn.className = "git-commit-btn";
  if (staged.length > 0) {
    commitBtn.textContent = "Commit";
    commitBtn.addEventListener("click", () => commitChanges("staged"));
  } else {
    commitBtn.textContent = "Commit All";
    commitBtn.addEventListener("click", () => commitChanges("tracked"));
  }
  commitBtn.disabled = !commitMessage.trim();
  actionRow.appendChild(commitBtn);

  commitArea.appendChild(actionRow);
  bottom.appendChild(commitArea);

  panelEl.appendChild(bottom);

  function updateCommitBtnState() {
    commitBtn.disabled = !commitMessage.trim();
  }
}

function createSection(title: string, files: GitFile[], isStaged: boolean): HTMLElement {
  const section = document.createElement("div");
  section.className = "git-section";

  const header = document.createElement("div");
  header.className = "git-section-header";
  header.textContent = title;
  section.appendChild(header);

  const list = document.createElement("div");
  list.className = "git-file-list";

  for (const file of files) {
    const row = document.createElement("div");
    row.className = `git-file-row ${statusClass(file.status)}`;

    // Status icon
    const statusIcon = document.createElement("span");
    statusIcon.className = `git-file-icon ${statusClass(file.status)}`;
    statusIcon.title = statusLabel(file.status);
    row.appendChild(statusIcon);

    // File name (just basename)
    const name = document.createElement("span");
    name.className = "git-file-name";
    name.textContent = file.path.split("/").pop() || file.path;
    name.title = file.path;
    row.appendChild(name);

    // Diff stats
    if (file.added_lines > 0 || file.removed_lines > 0) {
      const stats = document.createElement("span");
      stats.className = "git-diff-stats";
      if (file.added_lines > 0) {
        const added = document.createElement("span");
        added.className = "git-stat-added";
        added.textContent = `+${file.added_lines}`;
        stats.appendChild(added);
      }
      if (file.removed_lines > 0) {
        const removed = document.createElement("span");
        removed.className = "git-stat-removed";
        removed.textContent = `−${file.removed_lines}`;
        stats.appendChild(removed);
      }
      row.appendChild(stats);
    }

    // Stage/unstage checkbox
    const checkbox = document.createElement("button");
    checkbox.className = `git-file-checkbox ${isStaged ? "checked" : ""}`;
    checkbox.title = isStaged ? "Unstage" : "Stage";
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isStaged) {
        unstageFile(file.path);
      } else {
        stageFile(file.path);
      }
    });
    row.appendChild(checkbox);

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
