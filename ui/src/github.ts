// GitHub issues and pull requests as editable Markdown documents.
//
// An item is rendered as one document: YAML frontmatter holding the title,
// the Markdown body, then a read-only comment log. Only the frontmatter title
// and the body are sent back to GitHub.

import { parseFrontmatter } from "./document-structure.ts";
import type { RemoteRef, Tab } from "./tabs.ts";

const { invoke } = window.__TAURI__.core;

export type GhKind = "issue" | "pr";

export interface GhUser {
  login: string;
}

export interface GhLabel {
  name: string;
  color: string;
}

export interface GhComment {
  author: GhUser | null;
  body: string;
  created_at: string;
}

export interface GhItem {
  number: number;
  title: string;
  state: string;
  updated_at: string;
  author: GhUser | null;
  labels: GhLabel[];
  url: string;
  is_draft: boolean;
}

export interface GhItemDetail extends GhItem {
  body: string;
  comments: GhComment[];
}

export interface GhStatus {
  cli_available: boolean;
  authenticated: boolean;
  repo: string | null;
}

/** Everything below this line is regenerated on load and never pushed back. */
export const COMMENTS_MARKER =
  "<!-- markupsidedown:github-comments (read-only below this line) -->";

// --- Backend calls ---

export function ghStatus(repoPath: string): Promise<GhStatus> {
  return invoke<GhStatus>("gh_status", { repoPath });
}

export function ghList(
  repo: string,
  kind: GhKind,
  state: string,
  limit?: number,
  search?: string,
): Promise<GhItem[]> {
  return invoke<GhItem[]>("gh_list", { repo, kind, state, limit, search });
}

export function ghView(repo: string, kind: GhKind, number: number): Promise<GhItemDetail> {
  return invoke<GhItemDetail>("gh_view", { repo, kind, number });
}

// --- Document format ---

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildDocument(detail: GhItemDetail): string {
  const lines = ["---", `title: ${detail.title}`, `state: ${detail.state.toLowerCase()}`];
  if (detail.author?.login) lines.push(`author: ${detail.author.login}`);
  if (detail.labels.length > 0) {
    lines.push(`labels: ${detail.labels.map((l) => l.name).join(", ")}`);
  }
  if (detail.is_draft) lines.push("draft: true");
  lines.push(`url: ${detail.url}`, "---", "");

  const body = detail.body.trim();
  lines.push(body, "");

  if (detail.comments.length > 0) {
    lines.push(COMMENTS_MARKER, "");
    for (const c of detail.comments) {
      const who = c.author?.login ? `@${c.author.login}` : "unknown";
      lines.push(`### ${who} · ${formatDate(c.created_at)}`, "", c.body.trim(), "");
    }
  }

  return lines.join("\n");
}

/** Recover the pushable title and body from an edited document. */
export function parseDocument(
  content: string,
  fallbackTitle: string,
): { title: string; body: string } {
  const markerIndex = content.indexOf(COMMENTS_MARKER);
  const head = markerIndex >= 0 ? content.slice(0, markerIndex) : content;

  const lines = head.split("\n");
  const fm = parseFrontmatter(lines);
  const title = fm?.parsed?.title?.trim() || fallbackTitle;
  const bodyLines = fm ? lines.slice(fm.endLine) : lines;

  return { title, body: bodyLines.join("\n").trim() };
}

// --- Tabs ---

export function remoteTabName(kind: GhKind, number: number, title: string): string {
  const prefix = kind === "pr" ? `PR #${number}` : `#${number}`;
  const trimmed = title.length > 40 ? `${title.slice(0, 39)}…` : title;
  return `${prefix} ${trimmed}`.trim();
}

export function toRemoteRef(repo: string, kind: GhKind, detail: GhItemDetail): RemoteRef {
  return { service: "github", kind, repo, number: detail.number, url: detail.url };
}

/**
 * Push the edited title and body back to GitHub.
 *
 * The body the tab was opened with is recovered from `savedContent` and sent
 * as `expectedBody`, so an edit made on GitHub in the meantime is reported
 * instead of silently overwritten.
 */
export async function pushRemoteTab(
  tab: Tab,
  content: string,
): Promise<{ document: string; detail: GhItemDetail }> {
  const remote = tab.remote;
  if (!remote) throw new Error("Tab is not backed by a remote item");

  const { title, body } = parseDocument(content, tab.name);
  const expectedBody =
    tab.savedContent !== null ? parseDocument(tab.savedContent, tab.name).body : undefined;

  const detail = await invoke<GhItemDetail>("gh_update", {
    repo: remote.repo,
    kind: remote.kind,
    number: remote.number,
    title,
    body,
    expectedBody,
  });

  return { document: buildDocument(detail), detail };
}

export async function reloadRemoteTab(
  remote: RemoteRef,
): Promise<{ document: string; detail: GhItemDetail }> {
  const detail = await ghView(remote.repo, remote.kind, remote.number);
  return { document: buildDocument(detail), detail };
}
