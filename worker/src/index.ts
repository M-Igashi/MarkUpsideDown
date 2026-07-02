import type { Env, ConvertMessage } from "./types.js";
import { CORS_HEADERS, jsonResponse } from "./utils.js";
import { handleHealth } from "./handlers/health.js";
import { handleFetch } from "./handlers/fetch.js";
import { handleConvert } from "./handlers/convert.js";
import { handleRender } from "./handlers/render.js";
import { handleJson } from "./handlers/json.js";
import { handleCrawlStart, handleCrawlStatus } from "./handlers/crawl.js";
import { handleBatchSubmit, handleBatchStatus, handleBatchFile, processBatchQueue } from "./handlers/batch.js";
import { handlePublish, handleServePublished, handleUnpublish, handlePublishedList } from "./handlers/publish.js";
import { handleEmbed, handleSearch, handleEmbedDelete } from "./handlers/embed.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    if (request.method === "POST" && url.pathname === "/fetch") {
      return handleFetch(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/render") {
      return handleRender(url, env, ctx);
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

    if (request.method === "POST" && url.pathname === "/batch") {
      return handleBatchSubmit(request, env);
    }

    const batchMatch = url.pathname.match(/^\/batch\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && batchMatch) {
      return handleBatchStatus(batchMatch[1], env);
    }

    const batchFileMatch = url.pathname.match(/^\/batch\/([a-zA-Z0-9_-]+)\/(\d+)$/);
    if (request.method === "GET" && batchFileMatch) {
      return handleBatchFile(batchFileMatch[1], parseInt(batchFileMatch[2]), env);
    }

    if (request.method === "PUT" && url.pathname === "/publish") {
      return handlePublish(request, env);
    }

    if (request.method === "GET" && url.pathname === "/published") {
      return handlePublishedList(env);
    }

    const publishKeyMatch = url.pathname.match(/^\/p\/(.+)$/);
    if (request.method === "GET" && publishKeyMatch) {
      return handleServePublished(publishKeyMatch[1], env);
    }

    const deletePublishMatch = url.pathname.match(/^\/publish\/(.+)$/);
    if (request.method === "DELETE" && deletePublishMatch) {
      return handleUnpublish(deletePublishMatch[1], env);
    }

    if (request.method === "POST" && url.pathname === "/embed") {
      return handleEmbed(request, env);
    }

    if (request.method === "POST" && url.pathname === "/search") {
      return handleSearch(request, env);
    }

    const embedDeleteMatch = url.pathname.match(/^\/embed\/(.+)$/);
    if (request.method === "DELETE" && embedDeleteMatch) {
      return handleEmbedDelete(embedDeleteMatch[1], env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async queue(batch: MessageBatch<ConvertMessage>, env: Env): Promise<void> {
    await processBatchQueue(batch, env);
  },
} satisfies ExportedHandler<Env, ConvertMessage>;
