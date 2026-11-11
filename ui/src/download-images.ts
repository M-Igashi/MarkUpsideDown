import type { EditorView } from "@codemirror/view";
import {
  IMAGE_EXTENSIONS,
  basename,
  getAssetsDir,
  getExtension,
  sanitizeFilename,
} from "./path-utils.ts";

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

function urlToFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = basename(pathname) || "image";
    // Sanitize filename
    const clean = sanitizeFilename(last);
    // Ensure it has an extension
    if (!clean.includes(".") || !IMAGE_EXTENSIONS.has(getExtension(clean))) {
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
  const urls = [...doc.matchAll(new RegExp(IMAGE_URL_REGEX.source, "g"))].map((m) => m[2]);

  if (urls.length === 0) {
    deps.statusEl.textContent = "No external images found";
    return;
  }

  const assetsDir = getAssetsDir(filePath);
  // download_image overwrites, so avoid names already in ./assets/ (which
  // other documents may reference)
  const existing = await invoke<{ name: string }[]>("list_directory", { path: assetsDir }).catch(
    () => [],
  );
  const usedNames = new Set(existing.map((e) => e.name));
  const urlToLocal = new Map<string, string>();
  let downloaded = 0;
  let failed = 0;

  deps.statusEl.textContent = `Downloading ${urls.length} image(s)…`;

  // Deduplicate by URL
  const uniqueUrls = [...new Set(urls)];

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

  const failMsg = failed > 0 ? `, ${failed} failed` : "";

  // The user may have switched documents during the download
  if (deps.getCurrentFilePath() !== filePath) {
    deps.statusEl.textContent = `Downloaded ${downloaded} image(s) to ./assets/${failMsg}; the document was switched, so links were not updated`;
    return;
  }

  // Rewrite links in the current document (it may have been edited meanwhile)
  // with targeted changes instead of replacing the whole document
  const current = deps.editor.state.doc.toString();
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const match of current.matchAll(new RegExp(IMAGE_URL_REGEX.source, "g"))) {
    const localPath = urlToLocal.get(match[2]);
    if (!localPath) continue;
    changes.push({
      from: match.index,
      to: match.index + match[0].length,
      insert: `![${match[1]}](${localPath})`,
    });
  }
  if (changes.length > 0) deps.editor.dispatch({ changes });

  deps.statusEl.textContent = `Downloaded ${downloaded} image(s) to ./assets/${failMsg}`;
}
