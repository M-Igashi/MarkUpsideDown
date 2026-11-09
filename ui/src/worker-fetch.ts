// Shared Worker API fetch helper.
// Used by batch-import.ts, publish.ts, and semantic-search.ts.

import { getWorkerKey, getWorkerUrl } from "./settings.ts";

export async function workerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error("Worker URL not configured");
  const workerKey = getWorkerKey();
  const resp = await fetch(`${workerUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(workerKey ? { authorization: `Bearer ${workerKey}` } : {}),
      ...init?.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}
