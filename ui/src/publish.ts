// Publish Markdown files to Cloudflare R2 via the Worker's /publish endpoint.
// Local state is persisted in .markupsidedown/published.json alongside tags.json.

import { basename } from "./path-utils.ts";
import { workerFetch } from "./worker-fetch.ts";
import { writeTextFile } from "./html-utils.ts";
import type { MenuItem } from "./context-menu.ts";

const { invoke } = window.__TAURI__.core;
const { message } = window.__TAURI__.dialog;
const { join } = window.__TAURI__.path;

// --- Types ---

interface PublishEntry {
  key: string;
  url: string;
  publishedAt: string;
  expiresAt: string | null;
}

interface PublishState {
  files: Record<string, PublishEntry>;
}

// --- Local State ---

let projectRoot: string | null = null;
let state: PublishState = { files: {} };

export function setPublishProjectRoot(root: string | null) {
  projectRoot = root;
}

async function statePath(): Promise<string | null> {
  if (!projectRoot) return null;
  return join(projectRoot, ".markupsidedown", "published.json");
}

export async function loadPublishState(): Promise<void> {
  const path = await statePath();
  if (!path) return;
  try {
    const raw = await invoke<string>("read_text_file", { path });
    state = JSON.parse(raw);
  } catch {
    state = { files: {} };
  }
}

async function savePublishState(): Promise<void> {
  const path = await statePath();
  if (!path || !projectRoot) return;
  const dir = await join(projectRoot, ".markupsidedown");
  try {
    await invoke("create_directory", { path: dir });
  } catch {
    // already exists
  }
  await writeTextFile(path, JSON.stringify(state, null, 2));
}

// --- Publish / Unpublish ---

/**
 * Build a new publish key: a readable slug of the path plus a random suffix.
 * The R2 bucket is shared by every project, and non-ASCII names slugify to
 * nothing, so the slug alone would collide (README.md in two projects, or
 * 報告書.md and 議事録.md) and silently replace another document.
 */
function newPublishKey(relativePath: string): string {
  const slug = relativePath
    .replace(/\.md$/i, "")
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .toLowerCase();
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    (b % 36).toString(36),
  ).join("");
  return `${slug || "doc"}-${suffix}`;
}

export type ExpiryOption = "permanent" | "1h" | "24h" | "7d";

const EXPIRY_SECONDS: Record<ExpiryOption, number> = {
  permanent: 0,
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
};

async function upload(
  relativePath: string,
  key: string,
  content: string,
  expiresIn: number,
): Promise<PublishEntry> {
  const resp = await workerFetch<{
    key: string;
    url: string;
    publishedAt: string;
    expiresAt: string | null;
  }>("/publish", {
    method: "PUT",
    body: JSON.stringify({
      key,
      content,
      filename: basename(relativePath) || "untitled.md",
      expires_in: expiresIn || undefined,
    }),
  });

  const entry: PublishEntry = {
    key: resp.key,
    url: resp.url,
    publishedAt: resp.publishedAt,
    expiresAt: resp.expiresAt,
  };

  state.files[relativePath] = entry;
  await savePublishState();
  return entry;
}

export function publishFile(
  relativePath: string,
  content: string,
  expiry: ExpiryOption = "permanent",
): Promise<PublishEntry> {
  // Publishing an already-published file again keeps its URL
  const key = state.files[relativePath]?.key ?? newPublishKey(relativePath);
  return upload(relativePath, key, content, EXPIRY_SECONDS[expiry]);
}

/** Replace the published content at the same URL, keeping the original expiry time. */
export async function updatePublishedFile(
  relativePath: string,
  content: string,
): Promise<PublishEntry> {
  const entry = state.files[relativePath];
  if (!entry) throw new Error("This file is not published");
  const remaining = entry.expiresAt
    ? Math.ceil((Date.parse(entry.expiresAt) - Date.now()) / 1000)
    : 0;
  if (entry.expiresAt && remaining <= 0) throw new Error("The published link has expired");
  return upload(relativePath, entry.key, content, remaining);
}

export async function unpublishFile(relativePath: string): Promise<void> {
  const entry = state.files[relativePath];
  if (!entry) return;

  await workerFetch(`/publish/${entry.key}`, { method: "DELETE" });
  delete state.files[relativePath];
  await savePublishState();
}

// --- Query ---

export function isPublished(relativePath: string): boolean {
  const entry = state.files[relativePath];
  if (!entry) return false;
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
    delete state.files[relativePath];
    savePublishState().catch(() => {});
    return false;
  }
  return true;
}

export function getPublishUrl(relativePath: string): string | null {
  return state.files[relativePath]?.url ?? null;
}

// --- Menu actions (sidebar context menu and toolbar Publish button) ---

const PUBLISH_OPTIONS: { label: string; expiry: ExpiryOption }[] = [
  { label: "Publish as Permanent Link", expiry: "permanent" },
  { label: "Publish for 1 Hour", expiry: "1h" },
  { label: "Publish for 24 Hours", expiry: "24h" },
  { label: "Publish for 7 Days", expiry: "7d" },
];

async function copyText(text: string) {
  try {
    await invoke("copy_to_clipboard", { text });
  } catch (e) {
    message(`Copy failed: ${e}`, { kind: "error" });
  }
}

type BeforeRead = () => Promise<void>;
const noop: BeforeRead = async () => {};

/**
 * Menu items that publish the saved file at `absPath` with each expiry option.
 * `beforeRead` runs first, e.g. to save pending edits.
 */
export function publishOptionItems(
  absPath: string,
  relPath: string,
  onChange: () => void,
  beforeRead: BeforeRead = noop,
): MenuItem[] {
  return PUBLISH_OPTIONS.map(({ label, expiry }) => ({
    label,
    action: async () => {
      try {
        await beforeRead();
        const content = await invoke<string>("read_text_file", { path: absPath });
        const entry = await publishFile(relPath, content, expiry);
        await copyText(entry.url);
        message(`Published! URL copied to clipboard.\n${entry.url}`, {
          title: "Published",
          kind: "info",
        });
        onChange();
      } catch (e) {
        message(`Publish failed: ${e}`, { title: "Error", kind: "error" });
      }
    },
  }));
}

/** Menu items for a file that is already published: update, copy URL, unpublish. */
export function publishedItems(
  absPath: string,
  relPath: string,
  onChange: () => void,
  beforeRead: BeforeRead = noop,
): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Update Published Version",
      action: async () => {
        try {
          await beforeRead();
          const content = await invoke<string>("read_text_file", { path: absPath });
          await updatePublishedFile(relPath, content);
          message("The published URL now shows the saved version of this file.", {
            title: "Published",
            kind: "info",
          });
        } catch (e) {
          message(`Update failed: ${e}`, { title: "Error", kind: "error" });
        }
      },
    },
  ];
  const url = getPublishUrl(relPath);
  if (url) items.push({ label: "Copy Public URL", action: () => copyText(url) });
  items.push({
    label: "Unpublish",
    danger: true,
    action: async () => {
      try {
        await unpublishFile(relPath);
        onChange();
      } catch (e) {
        message(`Unpublish failed: ${e}`, { title: "Error", kind: "error" });
      }
    },
  });
  return items;
}
