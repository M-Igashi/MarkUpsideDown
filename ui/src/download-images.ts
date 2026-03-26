// Download external images referenced in the document to a local folder,
// rewriting URLs to relative paths.

import type { EditorView } from "@codemirror/view";
import { basename, dirname } from "./path-utils.ts";

const { invoke } = window.__TAURI__.core;

const IMAGE_URL_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

interface DownloadImagesDeps {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
}

let deps: DownloadImagesDeps;

export function initDownloadImages(d: DownloadImagesDeps) {
  deps = d;
}

function getAssetsDir(filePath: string): string {
  return `${dirname(filePath)}/assets`;
}

function urlToFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = basename(pathname) || "image";
    // Sanitize filename
    const clean = last.replace(/[^a-zA-Z0-9._-]/g, "_");
    // Ensure it has an extension
    if (!/\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?)$/i.test(clean)) {
      return `${clean}.png`;
    }
    return clean;
  } catch {
    return "image.png";
  }
}

function makeUnique(name: string, existing: Set<string>): string {
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : "";
  let n = 2;
  while (existing.has(`${stem}-${n}${ext}`)) n++;
  const unique = `${stem}-${n}${ext}`;
  existing.add(unique);
  return unique;
}

export async function downloadExternalImages() {
  const filePath = deps.getCurrentFilePath();
  if (!filePath) {
    deps.statusEl.textContent = "Save the file first to download images";
    return;
  }

  const doc = deps.editor.state.doc.toString();
  const matches: { fullMatch: string; alt: string; url: string; from: number }[] = [];
  let m: RegExpExecArray | null;
  const regex = new RegExp(IMAGE_URL_REGEX.source, "g");

  while ((m = regex.exec(doc)) !== null) {
    matches.push({
      fullMatch: m[0],
      alt: m[1],
      url: m[2],
      from: m.index,
    });
  }

  if (matches.length === 0) {
    deps.statusEl.textContent = "No external images found";
    return;
  }

  const assetsDir = getAssetsDir(filePath);
  const usedNames = new Set<string>();
  const urlToLocal = new Map<string, string>();
  let downloaded = 0;
  let failed = 0;

  deps.statusEl.textContent = `Downloading ${matches.length} image(s)…`;

  // Deduplicate by URL
  const uniqueUrls = [...new Set(matches.map((m) => m.url))];

  // Pre-assign filenames (must be sequential for uniqueness)
  const urlFilenames = uniqueUrls.map((url) => ({
    url,
    filename: makeUnique(urlToFilename(url), usedNames),
  }));

  // Download in parallel
  const results = await Promise.allSettled(
    urlFilenames.map(({ url, filename }) =>
      invoke<string>("download_image", { url, destPath: `${assetsDir}/${filename}` }).then(() => ({
        url,
        localPath: `./assets/${filename}`,
      })),
    ),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      urlToLocal.set(r.value.url, r.value.localPath);
      downloaded++;
    } else {
      failed++;
    }
  }

  // Rewrite URLs in the document (process from end to start to preserve positions)
  const sortedMatches = [...matches].sort((a, b) => b.from - a.from);
  let newDoc = doc;
  for (const match of sortedMatches) {
    const localPath = urlToLocal.get(match.url);
    if (!localPath) continue;
    const replacement = `![${match.alt}](${localPath})`;
    newDoc =
      newDoc.slice(0, match.from) + replacement + newDoc.slice(match.from + match.fullMatch.length);
  }

  if (newDoc !== doc) {
    deps.editor.dispatch({
      changes: { from: 0, to: doc.length, insert: newDoc },
    });
  }

  const failMsg = failed > 0 ? `, ${failed} failed` : "";
  deps.statusEl.textContent = `Downloaded ${downloaded} image(s) to ./assets/${failMsg}`;
}
