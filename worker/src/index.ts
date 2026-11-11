import type { Env } from "./types.js";
import { CORS_HEADERS, jsonResponse, checkAuth, authErrorResponse } from "./utils.js";
import { handleHealth } from "./handlers/health.js";
import { handleFetch } from "./handlers/fetch.js";
import { handleConvert } from "./handlers/convert.js";
import { handleRender } from "./handlers/render.js";
import { handleJson } from "./handlers/json.js";
import { handleCrawlStart, handleCrawlStatus, handleCrawlCancel } from "./handlers/crawl.js";
import { handlePublish, handleServePublished, handleUnpublish, handlePublishedList, deleteExpiredPublished } from "./handlers/publish.js";
import { handleEmbed, handleSearch, handleEmbedDelete } from "./handlers/embed.js";

/** Clients may percent-encode keys/ids (e.g. `/` as `%2F`); null when malformed. */
function decodePathParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

  // Public routes: health check and published documents.
  if (request.method === "GET" && url.pathname === "/health") {
    return handleHealth(request, env);
  }

  const publishKeyMatch = url.pathname.match(/^\/p\/(.+)$/);
  if (request.method === "GET" && publishKeyMatch) {
    const key = decodePathParam(publishKeyMatch[1]);
    if (key === null) return jsonResponse({ error: "Invalid key" }, 400);
    return handleServePublished(key, env);
  }

  // Everything else requires the API key.
  const auth = await checkAuth(request, env);
  if (auth !== "valid") {
    return authErrorResponse(auth);
  }

  if (request.method === "POST" && url.pathname === "/fetch") {
    return handleFetch(request, env);
  }

  if (request.method === "GET" && url.pathname === "/render") {
    return handleRender(url, env);
  }

  if (request.method === "POST" && url.pathname === "/convert") {
    return handleConvert(request, env);
  }

  if (request.method === "POST" && url.pathname === "/json") {
    return handleJson(request, env);
  }

  if (request.method === "POST" && url.pathname === "/crawl") {
    return handleCrawlStart(request, env);
  }

  const crawlMatch = url.pathname.match(/^\/crawl\/([a-zA-Z0-9_-]+)$/);
  if (request.method === "GET" && crawlMatch) {
    return handleCrawlStatus(crawlMatch[1], url, env);
  }
  if (request.method === "DELETE" && crawlMatch) {
    return handleCrawlCancel(crawlMatch[1], env);
  }

  if (request.method === "PUT" && url.pathname === "/publish") {
    return handlePublish(request, env);
  }

  if (request.method === "GET" && url.pathname === "/published") {
    return handlePublishedList(env);
  }

  const deletePublishMatch = url.pathname.match(/^\/publish\/(.+)$/);
  if (request.method === "DELETE" && deletePublishMatch) {
    const key = decodePathParam(deletePublishMatch[1]);
    if (key === null) return jsonResponse({ error: "Invalid key" }, 400);
    return handleUnpublish(key, env);
  }

  if (request.method === "POST" && url.pathname === "/embed") {
    return handleEmbed(request, env);
  }

  if (request.method === "POST" && url.pathname === "/search") {
    return handleSearch(request, env);
  }

  const embedDeleteMatch = url.pathname.match(/^\/embed\/(.+)$/);
  if (request.method === "DELETE" && embedDeleteMatch) {
    const docId = decodePathParam(embedDeleteMatch[1]);
    if (docId === null) return jsonResponse({ error: "Invalid document ID" }, 400);
    return handleEmbedDelete(docId, env);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      // Without this an uncaught error returns Cloudflare's HTML 1101 page
      // with no CORS headers, which clients can only report as "Unknown error"
      console.error(e);
      return jsonResponse({ error: `Internal error: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await deleteExpiredPublished(env);
  },
} satisfies ExportedHandler<Env>;
