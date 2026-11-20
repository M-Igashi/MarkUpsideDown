// Semantic search via Worker's /embed and /search endpoints (AI Search).
// The search UI lives in the command palette (`?` prefix / Cmd+5).

import { workerFetch } from "./worker-fetch.ts";

// --- Index ---

// Each document is one AI Search upload, and a Workers Free plan request
// can make at most 50 subrequests, so large sets are sent in chunks.
const INDEX_BATCH_SIZE = 20;

export interface IndexResult {
  indexed: number;
  /** Documents the Worker could not index. */
  failed: number;
}

export async function indexDocuments(
  docs: { id: string; content: string }[],
): Promise<IndexResult> {
  let indexed = 0;
  let failed = 0;
  for (let i = 0; i < docs.length; i += INDEX_BATCH_SIZE) {
    const resp = await workerFetch<{ indexed: number; errors?: string[] }>("/embed", {
      method: "POST",
      body: JSON.stringify({ documents: docs.slice(i, i + INDEX_BATCH_SIZE) }),
    });
    indexed += resp.indexed;
    failed += resp.errors?.length ?? 0;
  }
  return { indexed, failed };
}

export function indexDocument(id: string, content: string): Promise<IndexResult> {
  return indexDocuments([{ id, content }]);
}

// --- Search ---

export interface SearchResult {
  id: string;
  score: number;
  text?: string;
}

export async function semanticSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const resp = await workerFetch<{ results: SearchResult[] }>("/search", {
    method: "POST",
    body: JSON.stringify({ query, limit }),
  });
  return resp.results;
}
