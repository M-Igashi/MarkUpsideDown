// Batch file import via Worker's /batch endpoint (Queue-based parallel conversion).

import { normalizeMarkdown } from "./normalize.ts";
import { basename } from "./path-utils.ts";
import { workerFetch } from "./worker-fetch.ts";
import { writeTextFile } from "./html-utils.ts";

const { invoke } = window.__TAURI__.core;

interface BatchFile {
  name: string;
  content: string; // base64
}

interface BatchSubmitResponse {
  batch_id: string;
  total: number;
  status: string;
}

interface BatchStatusResponse {
  batch_id: string;
  total: number;
  completed: number;
  failed: number;
  files: { index: number; name: string; status: string; error?: string }[];
}

interface BatchFileResponse {
  markdown: string;
}

export interface BatchProgress {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  files: { name: string; status: string; error?: string }[];
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Read local files and submit them as a batch conversion job. */
export async function submitBatch(
  filePaths: string[],
): Promise<{ batchId: string; total: number }> {
  const files: BatchFile[] = await Promise.all(
    filePaths.map(async (fp) => {
      const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: fp });
      return { name: basename(fp), content: arrayBufferToBase64(bytes) };
    }),
  );

  const resp = await workerFetch<BatchSubmitResponse>("/batch", {
    method: "POST",
    body: JSON.stringify({ files }),
  });

  return { batchId: resp.batch_id, total: resp.total };
}

/** Poll batch status until all files are done or failed. */
export async function pollBatch(
  batchId: string,
  onProgress: (progress: BatchProgress) => void,
  intervalMs = 2000,
): Promise<BatchProgress> {
  for (;;) {
    const status = await workerFetch<BatchStatusResponse>(`/batch/${batchId}`);
    const progress: BatchProgress = {
      batchId,
      total: status.total,
      completed: status.completed,
      failed: status.failed,
      files: status.files,
    };
    onProgress(progress);

    if (status.completed + status.failed >= status.total) return progress;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Retrieve the converted Markdown for a specific file in the batch. */
export async function getBatchResult(batchId: string, index: number): Promise<string> {
  const resp = await workerFetch<BatchFileResponse>(`/batch/${batchId}/${index}`);
  return normalizeMarkdown(resp.markdown);
}

/** Save batch results as .md files into the target directory. */
export async function saveBatchResults(
  batchId: string,
  progress: BatchProgress,
  targetDir: string,
): Promise<string[]> {
  const doneFiles = progress.files
    .map((f, i) => ({ ...f, index: i }))
    .filter((f) => f.status === "done");

  const results = await Promise.all(
    doneFiles.map(async (f) => {
      const md = await getBatchResult(batchId, f.index);
      const mdName = f.name.replace(/\.[^.]+$/, ".md");
      const outPath = `${targetDir}/${mdName}`;
      await writeTextFile(outPath, md);
      return outPath;
    }),
  );
  return results;
}
