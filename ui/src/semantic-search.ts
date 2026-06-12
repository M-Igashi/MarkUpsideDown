// Semantic search via Worker's /embed and /search endpoints (Vectorize).
// The search UI lives in the command palette (`?` prefix / Cmd+5).

import { workerFetch } from "./worker-fetch.ts";

// --- Index ---

export async function indexDocument(
  id: string,
  content: string,
  metadata?: Record<string, string>,
): Promise<{ indexed: number; chunks: number }> {
  return workerFetch("/embed", {
    method: "POST",
    body: JSON.stringify({ documents: [{ id, content, metadata }] }),
  });
}

export async function indexDocuments(
  docs: { id: string; content: string; metadata?: Record<string, string> }[],
): Promise<{ indexed: number; chunks: number }> {
  return workerFetch("/embed", {
    method: "POST",
    body: JSON.stringify({ documents: docs }),
  });
}

// --- Search ---

export interface SearchResult {
  id: string;
  score: number;
  metadata?: Record<string, string>;
}

export async function semanticSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const resp = await workerFetch<{ results: SearchResult[] }>("/search", {
    method: "POST",
    body: JSON.stringify({ query, limit }),
  });
  return resp.results;
}
