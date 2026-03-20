import { basename } from "./path-utils.ts";

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
  ahead: number;
  behind: number;
}

let panelEl: HTMLElement | null = null;
let repoPath: string | null = null;
let gitData: GitData | null = null;
let onFileClick: ((path: string) => void) | null = null;
let onRefreshCb: (() => void) | null = null;
let commitMessage = generateDefaultMessage();

const DEFAULT_MSG_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function generateDefaultMessage(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function initGitPanel(
  el: HTMLElement,
  { onOpen, onRefresh }: { onOpen: (path: string) => void; onRefresh?: () => void },
) {
  panelEl = el;
  onFileClick = onOpen;
  onRefreshCb = onRefresh ?? null;
  render();
}

export function setRepoPath(path: string | null, skipRefresh = false) {
  repoPath = path;
  if (path) {
    if (!skipRefresh) refresh();
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
  onRefreshCb?.();
}

export function getBranch(): string | null {
  return gitData?.is_repo ? gitData.branch || null : null;
}

export function isRepo(): boolean {
  return gitData?.is_repo ?? false;
}

const HIDDEN_FILES = [".DS_Store", "Thumbs.db"];

function isHiddenFile(path: string): boolean {
  return HIDDEN_FILES.includes(basename(path));
}

export function getChangeCount(): number {
  if (!gitData?.files) return 0;
  const paths = new Set(gitData.files.filter((f) => !isHiddenFile(f.path)).map((f) => f.path));
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
    commitMessage = generateDefaultMessage();
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

const STATUS_MAP: Record<string, { label: string; cls: string; suffix: string }> = {
  M: { label: "modified", cls: "git-modified", suffix: "modified" },
  A: { label: "added", cls: "git-added", suffix: "added" },
  D: { label: "deleted", cls: "git-deleted", suffix: "deleted" },
  R: { label: "renamed", cls: "git-renamed", suffix: "renamed" },
  C: { label: "copied", cls: "git-modified", suffix: "modified" },
  "?": { label: "untracked", cls: "git-untracked", suffix: "untracked" },
};

const DEFAULT_STATUS = { label: "", cls: "git-modified", suffix: "modified" };

function statusLabel(status: string): string {
  return (STATUS_MAP[status] || DEFAULT_STATUS).label || status;
}

export function statusClass(status: string): string {
  return (STATUS_MAP[status] || DEFAULT_STATUS).cls;
}

export function statusSuffix(status: string): string {
  return (STATUS_MAP[status] || DEFAULT_STATUS).suffix;
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

// Persistent bottom section elements (survive re-renders to preserve textarea focus)
let bottomEl: HTMLElement | null = null;
let branchLabelEl: HTMLElement | null = null;
let pullBtnEl: HTMLButtonElement | null = null;
let pushBtnEl: HTMLButtonElement | null = null;
let commitBtnEl: HTMLButtonElement | null = null;

function ensureBottom(): HTMLElement {
  if (bottomEl) return bottomEl;

  const bottom = document.createElement("div");
  bottom.className = "git-bottom";

  const statusMsg = document.createElement("div");
  statusMsg.className = "git-status-msg";
  bottom.appendChild(statusMsg);

  const branchRow = document.createElement("div");
  branchRow.className = "git-branch-row";

  branchLabelEl = document.createElement("span");
  branchLabelEl.className = "git-branch-label";
  branchRow.appendChild(branchLabelEl);

  const fetchBtn = document.createElement("button");
  fetchBtn.className = "git-fetch-btn";
  fetchBtn.innerHTML = "⟳ Fetch";
  fetchBtn.addEventListener("click", () => gitRemoteAction("git_fetch", "Fetch", fetchBtn));
  branchRow.appendChild(fetchBtn);

  bottom.appendChild(branchRow);

  const commitArea = document.createElement("div");
  commitArea.className = "git-commit-area";

  const textarea = document.createElement("textarea");
  textarea.className = "git-commit-textarea";
  textarea.placeholder = "Enter commit message";
  textarea.value = commitMessage;
  textarea.rows = 3;
  textarea.addEventListener("input", () => {
    commitMessage = textarea.value;
    if (commitBtnEl) commitBtnEl.disabled = !commitMessage.trim();
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && commitMessage.trim()) {
      e.preventDefault();
      const hasStaged = gitData?.files.some((f) => f.staged && !isHiddenFile(f.path));
      commitChanges(hasStaged ? "staged" : "tracked");
    }
  });
  commitArea.appendChild(textarea);

  const actionRow = document.createElement("div");
  actionRow.className = "git-action-row";

  const leftActions = document.createElement("div");
  leftActions.className = "git-action-left";

  pullBtnEl = document.createElement("button");
  pullBtnEl.className = "git-icon-btn";
  pullBtnEl.title = "Pull";
  pullBtnEl.addEventListener("click", () => gitRemoteAction("git_pull", "Pull", pullBtnEl!));
  leftActions.appendChild(pullBtnEl);

  pushBtnEl = document.createElement("button");
  pushBtnEl.className = "git-icon-btn";
  pushBtnEl.title = "Push";
  pushBtnEl.addEventListener("click", () => gitRemoteAction("git_push", "Push", pushBtnEl!));
  leftActions.appendChild(pushBtnEl);

  actionRow.appendChild(leftActions);

  commitBtnEl = document.createElement("button");
  commitBtnEl.className = "git-commit-btn";
  commitBtnEl.addEventListener("click", () => {
    const hasStaged = gitData?.files.some((f) => f.staged && !isHiddenFile(f.path));
    commitChanges(hasStaged ? "staged" : "tracked");
  });
  actionRow.appendChild(commitBtnEl);

  commitArea.appendChild(actionRow);
  bottom.appendChild(commitArea);

  bottomEl = bottom;
  return bottom;
}

function updateBottom(staged: GitFile[]) {
  if (!gitData || !branchLabelEl || !pullBtnEl || !pushBtnEl || !commitBtnEl) return;

  // Refresh timestamp if the message is still the default pattern
  if (DEFAULT_MSG_RE.test(commitMessage)) {
    commitMessage = generateDefaultMessage();
    const textarea = bottomEl?.querySelector<HTMLTextAreaElement>(".git-commit-textarea");
    if (textarea) textarea.value = commitMessage;
  }

  branchLabelEl.textContent = `\u{e0a0} ${gitData.branch || "HEAD (detached)"}`;

  pullBtnEl.innerHTML =
    gitData.behind > 0 ? `↓ Pull <span class="git-count-badge">${gitData.behind}</span>` : "↓ Pull";
  pushBtnEl.innerHTML =
    gitData.ahead > 0 ? `↑ Push <span class="git-count-badge">${gitData.ahead}</span>` : "↑ Push";

  commitBtnEl.textContent = staged.length > 0 ? "Commit" : "Commit All";
  commitBtnEl.disabled = !commitMessage.trim();
}

function render() {
  if (!panelEl) return;

  if (!repoPath || !gitData || !gitData.is_repo) {
    panelEl.innerHTML = "";
    bottomEl = null;
    branchLabelEl = null;
    pullBtnEl = null;
    pushBtnEl = null;
    commitBtnEl = null;
    const msg = document.createElement("div");
    msg.className = "git-panel-clean";
    msg.textContent = repoPath ? "Not a git repository" : "Open a folder to see git status";
    panelEl.appendChild(msg);
    return;
  }

  const visibleFiles = gitData.files.filter((f) => !isHiddenFile(f.path));
  const staged = visibleFiles.filter((f) => f.staged);
  const unstaged = visibleFiles.filter((f) => !f.staged);
  const totalChanges = getChangeCount();

  // --- Rebuild only the file list area ---
  const existingFileArea = panelEl.querySelector(".git-file-area");
  const fileArea = document.createElement("div");
  fileArea.className = "git-file-area";

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

  if (staged.length > 0) {
    fileArea.appendChild(createSection("Staged", staged, true));
  }

  if (unstaged.length > 0) {
    const label = staged.length > 0 ? "Unstaged" : "Tracked";
    fileArea.appendChild(createSection(label, unstaged, false));
  }

  if (existingFileArea) {
    existingFileArea.replaceWith(fileArea);
  } else {
    panelEl.innerHTML = "";
    panelEl.appendChild(fileArea);
  }

  // --- Bottom: create once, update in-place ---
  const bottom = ensureBottom();
  updateBottom(staged);
  if (!bottom.parentNode) {
    panelEl.appendChild(bottom);
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
    name.textContent = basename(file.path);
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
