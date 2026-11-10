import type { Env } from "../types.js";
import { SEARCH_INSTANCE, SEARCH_LIMIT_DEFAULT } from "../config.js";
import { jsonResponse, parseJsonBody } from "../utils.js";

// Semantic search on AI Search: chunking, embedding (a multilingual model),
// and hybrid keyword + vector retrieval are handled by the managed instance.

const SEARCH_MISSING_ERROR =
  "AI Search binding is missing on this Worker. Click Update Worker in MarkUpsideDown Settings.";

// Max chunks requested per query. Several chunks can come from one document.
const SEARCH_CHUNKS_MAX = 50;

const INSTANCE_CONFIG: AiSearchConfig = {
  id: SEARCH_INSTANCE,
  index_method: { vector: true, keyword: true },
  // Trigram keyword matching works for CJK text, which has no word spaces.
  indexing_options: { keyword_tokenizer: "trigram" },
  custom_metadata: [{ field_name: "doc_id", data_type: "text" }],
};

interface EmbedDocument {
  id: string;
  content: string;
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && (e.name.includes("NotFound") || /not[\s_-]?found/i.test(e.message));
}

// AI Search picks the parser from the key's extension, so content converted
// from e.g. "report.pdf" is stored as "report.pdf.md".
function itemKey(docId: string): string {
  return docId.endsWith(".md") ? docId : `${docId}.md`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Get the search instance, creating it on first use. */
async function getInstance(ns: AiSearchNamespace): Promise<AiSearchInstance> {
  const instance = ns.get(SEARCH_INSTANCE);
  try {
    await instance.info();
    return instance;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  try {
    return await ns.create(INSTANCE_CONFIG);
  } catch (createError) {
    // Another request may have created it in the meantime.
    await instance.info().catch(() => {
      throw createError;
    });
    return instance;
  }
}

export async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const ns = env.AI_SEARCH;
  if (!ns) {
    return jsonResponse({ error: SEARCH_MISSING_ERROR }, 500);
  }

  const body = await parseJsonBody<{ documents: EmbedDocument[] }>(request);
  if (body instanceof Response) return body;

  if (!body.documents?.length) {
    return jsonResponse({ error: "Missing 'documents' array" }, 400);
  }

  let instance: AiSearchInstance;
  try {
    instance = await getInstance(ns);
  } catch (e) {
    return jsonResponse({ error: `AI Search unavailable: ${errorMessage(e)}` }, 500);
  }

  // Upload is an upsert, so re-indexing a document replaces its old chunks.
  // Indexing continues in the background after the upload returns.
  const results = await Promise.allSettled(
    body.documents.map((doc) => instance.items.upload(itemKey(doc.id), doc.content, { metadata: { doc_id: doc.id } })),
  );
  const errors = results.flatMap((r, i) =>
    r.status === "rejected" ? [`${body.documents[i].id}: ${errorMessage(r.reason)}`] : [],
  );
  const indexed = results.length - errors.length;
  if (indexed === 0) {
    return jsonResponse({ error: `Indexing failed: ${errors[0]}` }, 500);
  }

  return jsonResponse({ indexed, ...(errors.length > 0 ? { errors } : {}) });
}

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  if (!env.AI_SEARCH) {
    return jsonResponse({ error: SEARCH_MISSING_ERROR }, 500);
  }

  const body = await parseJsonBody<{ query: string; limit?: number }>(request);
  if (body instanceof Response) return body;

  if (!body.query) {
    return jsonResponse({ error: "Missing 'query' field" }, 400);
  }

  const limit = Math.max(1, Math.min(body.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_CHUNKS_MAX));
  let response: AiSearchSearchResponse;
  try {
    response = await env.AI_SEARCH.get(SEARCH_INSTANCE).search({
      query: body.query,
      ai_search_options: { retrieval: { max_num_results: Math.min(limit * 3, SEARCH_CHUNKS_MAX) } },
    });
  } catch (e) {
    // Nothing has been indexed yet.
    if (isNotFound(e)) return jsonResponse({ results: [] });
    return jsonResponse({ error: `Search failed: ${errorMessage(e)}` }, 500);
  }

  // One result per document, keeping its best-scoring chunk.
  const best = new Map<string, { id: string; score: number; text: string }>();
  for (const chunk of response.chunks) {
    const id = typeof chunk.item.metadata?.doc_id === "string" ? chunk.item.metadata.doc_id : chunk.item.key;
    const current = best.get(id);
    if (!current || chunk.score > current.score) {
      best.set(id, { id, score: chunk.score, text: chunk.text });
    }
  }
  const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  return jsonResponse({ results });
}

export async function handleEmbedDelete(docId: string, env: Env): Promise<Response> {
  if (!env.AI_SEARCH) {
    return jsonResponse({ error: SEARCH_MISSING_ERROR }, 500);
  }

  const instance = env.AI_SEARCH.get(SEARCH_INSTANCE);
  try {
    const { result } = await instance.items.list({ key: itemKey(docId) });
    await Promise.all(result.map((item) => instance.items.delete(item.id)));
  } catch (e) {
    if (!isNotFound(e)) return jsonResponse({ error: `Delete failed: ${errorMessage(e)}` }, 500);
  }

  return jsonResponse({ deleted: docId });
}
