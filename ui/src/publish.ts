// Publish Markdown files to Cloudflare R2 via the Worker's /publish endpoint.
// Local state is persisted in .markupsidedown/published.json alongside tags.json.

import { basename } from "./path-utils.ts";
import { workerFetch } from "./worker-fetch.ts";

const { readTextFile, writeTextFile } = window.__TAURI__.fs;
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
    const raw = await readTextFile(path);
    state = JSON.parse(raw);
  } catch {
    state = { files: {} };
  }
}

async function savePublishState(): Promise<void> {
  const path = await statePath();
  if (!path) return;
  await writeTextFile(path, JSON.stringify(state, null, 2));
}

// --- Publish / Unpublish ---

function slugifyPath(relativePath: string): string {
  return relativePath
    .replace(/\.md$/i, "")
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

export type ExpiryOption = "permanent" | "1h" | "24h" | "7d";

const EXPIRY_SECONDS: Record<ExpiryOption, number> = {
  permanent: 0,
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
};

export async function publishFile(
  relativePath: string,
  content: string,
  expiry: ExpiryOption = "permanent",
): Promise<PublishEntry> {
  const key = slugifyPath(relativePath);
  const expiresIn = EXPIRY_SECONDS[expiry];

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
    return false;
  }
  return true;
}

export function getPublishUrl(relativePath: string): string | null {
  return state.files[relativePath]?.url ?? null;
}

export function getPublishEntry(relativePath: string): PublishEntry | null {
  return state.files[relativePath] ?? null;
}

export function getAllPublished(): Record<string, PublishEntry> {
  return { ...state.files };
}
