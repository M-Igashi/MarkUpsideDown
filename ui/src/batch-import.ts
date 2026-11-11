// Batch file import: converts several files in parallel via the Worker's
// /convert endpoint and saves each result as a .md file next to its source.

import { normalizeMarkdown } from "./normalize.ts";
import { basename, dirname } from "./path-utils.ts";
import { ensureWorkerUrl, getWorkerKey } from "./settings.ts";

const { invoke } = window.__TAURI__.core;

const CONCURRENCY = 4;

export interface BatchResult {
  saved: string[];
  failed: { name: string; error: string }[];
}

/**
 * Write `content` to `<dir>/<stem>.md`, or `<stem>-1.md`, `<stem>-2.md`, … when
 * the name is taken. write_file_bytes uses create_new, so this never
 * overwrites, even when two conversions race for the same name.
 */
async function writeNewMarkdownFile(dir: string, stem: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  for (let n = 0; ; n++) {
    const path = `${dir}/${stem}${n ? `-${n}` : ""}.md`;
    try {
      await invoke("write_file_bytes", bytes, { headers: { path: encodeURIComponent(path) } });
      return path;
    } catch (e) {
      if (!String(e).includes("already exists") || n >= 99) throw e;
    }
  }
}

/** Convert files and save each next to its source. Returns null if no Worker is configured. */
export async function convertFiles(filePaths: string[]): Promise<BatchResult | null> {
  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) return null;
  const workerKey = getWorkerKey() || null;

  const result: BatchResult = { saved: [], failed: [] };
  const queue = [...filePaths];
  const worker = async () => {
    for (let filePath = queue.shift(); filePath; filePath = queue.shift()) {
      const name = basename(filePath);
      try {
        const { markdown } = await invoke<{ markdown: string }>("convert_file_to_markdown", {
          filePath,
          workerUrl,
          workerKey,
        });
        const stem = name.replace(/\.[^.]+$/, "");
        const outPath = await writeNewMarkdownFile(
          dirname(filePath),
          stem,
          normalizeMarkdown(markdown),
        );
        result.saved.push(outPath);
      } catch (e) {
        result.failed.push({ name, error: String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, worker));
  return result;
}
