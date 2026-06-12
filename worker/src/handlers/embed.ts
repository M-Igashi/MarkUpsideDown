import type { Env } from "../types.js";
import { EMBEDDING_MODEL, MAX_CHUNK_CHARS, VECTORIZE_UPSERT_MAX, EMBED_DELETE_MAX_CHUNKS } from "../config.js";
import { jsonResponse, parseJsonBody } from "../utils.js";

interface EmbedDocument {
  id: string;
  content: string;
  metadata?: Record<string, string>;
}

/** Split a Markdown document into heading-based chunks. */
function chunkDocument(id: string, content: string): { chunkId: string; text: string }[] {
  const lines = content.split("\n");
  const chunks: { chunkId: string; text: string }[] = [];
  let current = "";
  let headingPrefix = "";
  let chunkIndex = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (current.trim()) {
        chunks.push({ chunkId: `${id}#${chunkIndex}`, text: `${headingPrefix}\n${current}`.trim() });
        chunkIndex++;
      }
      headingPrefix = line;
      current = "";
    } else {
      current += line + "\n";
      if (current.length > MAX_CHUNK_CHARS) {
        chunks.push({ chunkId: `${id}#${chunkIndex}`, text: `${headingPrefix}\n${current}`.trim() });
        chunkIndex++;
        current = "";
      }
    }
  }
  if (current.trim()) {
    chunks.push({ chunkId: `${id}#${chunkIndex}`, text: `${headingPrefix}\n${current}`.trim() });
  }

  return chunks.length > 0 ? chunks : [{ chunkId: `${id}#0`, text: content.slice(0, MAX_CHUNK_CHARS) }];
}

async function getEmbeddings(texts: string[], env: Env): Promise<number[][]> {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  return (result as { data: number[][] }).data;
}

export async function handleEmbed(request: Request, env: Env): Promise<Response> {
  if (!env.VECTORS) {
    return jsonResponse({ error: "Vectorize index not configured" }, 500);
  }

  const body = await parseJsonBody<{ documents: EmbedDocument[] }>(request);
  if (body instanceof Response) return body;

  if (!body.documents?.length) {
    return jsonResponse({ error: "Missing 'documents' array" }, 400);
  }

  const chunkCounts = await Promise.all(
    body.documents.map(async (doc) => {
      const chunks = chunkDocument(doc.id, doc.content);
      const texts = chunks.map((c) => c.text);
      const embeddings = await getEmbeddings(texts, env);

      const vectors = chunks.map((c, i) => ({
        id: c.chunkId,
        values: embeddings[i],
        metadata: {
          docId: doc.id,
          ...(doc.metadata ?? {}),
        },
      }));

      for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_MAX) {
        await env.VECTORS!.upsert(vectors.slice(i, i + VECTORIZE_UPSERT_MAX));
      }
      return chunks.length;
    }),
  );
  const totalChunks = chunkCounts.reduce((a, b) => a + b, 0);

  return jsonResponse({ indexed: body.documents.length, chunks: totalChunks });
}

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  if (!env.VECTORS) {
    return jsonResponse({ error: "Vectorize index not configured" }, 500);
  }

  const body = await parseJsonBody<{ query: string; limit?: number }>(request);
  if (body instanceof Response) return body;

  if (!body.query) {
    return jsonResponse({ error: "Missing 'query' field" }, 400);
  }

  const [queryEmbedding] = await getEmbeddings([body.query], env);
  const results = await env.VECTORS.query(queryEmbedding, {
    topK: body.limit ?? 10,
    returnMetadata: "all",
  });

  return jsonResponse({
    results: results.matches.map((m) => ({
      id: m.id,
      score: m.score,
      metadata: m.metadata,
    })),
  });
}

export async function handleEmbedDelete(docId: string, env: Env): Promise<Response> {
  if (!env.VECTORS) {
    return jsonResponse({ error: "Vectorize index not configured" }, 500);
  }

  // Chunk IDs are sequential; delete in batches, probing past each batch so
  // documents larger than one batch are fully removed.
  let start = 0;
  for (;;) {
    const ids = Array.from({ length: EMBED_DELETE_MAX_CHUNKS }, (_, i) => `${docId}#${start + i}`);
    await env.VECTORS.deleteByIds(ids);
    start += EMBED_DELETE_MAX_CHUNKS;
    const probe = await env.VECTORS.getByIds([`${docId}#${start}`]);
    if (probe.length === 0) break;
  }

  return jsonResponse({ deleted: docId });
}
