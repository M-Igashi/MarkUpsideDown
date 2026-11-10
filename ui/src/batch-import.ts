// Batch file import: converts several files in parallel via the Worker's
// /convert endpoint and saves each result as a .md file.

import { normalizeMarkdown } from "./normalize.ts";
import { basename } from "./path-utils.ts";
import { ensureWorkerUrl, getWorkerKey } from "./settings.ts";
import { writeTextFile } from "./html-utils.ts";

const { invoke } = window.__TAURI__.core;

const CONCURRENCY = 4;

export interface BatchResult {
  saved: string[];
  failed: { name: string; error: string }[];
}

/** Convert files and save them into `targetDir`. Returns null if no Worker is configured. */
export async function convertFiles(
  filePaths: string[],
  targetDir: string,
): Promise<BatchResult | null> {
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
        const outPath = `${targetDir}/${name.replace(/\.[^.]+$/, ".md")}`;
        await writeTextFile(outPath, normalizeMarkdown(markdown));
        result.saved.push(outPath);
      } catch (e) {
        result.failed.push({ name, error: String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, worker));
  return result;
}
