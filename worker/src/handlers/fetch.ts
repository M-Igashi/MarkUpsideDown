import type { Env } from "../types.js";
import { FETCH_KV_TTL } from "../config.js";
import { jsonResponse, parseJsonBody, sha256, shouldBypassCache, kvGet, kvPut, htmlToMarkdown, detectSpa } from "../utils.js";
import { validateUrlForSsrf } from "../ssrf.js";

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await parseJsonBody<{ url: string }>(request);
  if (body instanceof Response) return body;

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
  }

  // KV cache lookup (before SSRF validation to avoid unnecessary DNS-over-HTTPS on cache hits)
  const bypass = shouldBypassCache(request);
  const cacheKey = `md:fetch:${await sha256(body.url)}`;
  if (!bypass) {
    const cached = await kvGet(env, cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return jsonResponse({ ...parsed, cache: "hit" });
    }
  }

  const ssrfError = await validateUrlForSsrf(body.url);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  try {
    const response = await fetch(body.url, {
      headers: { "Accept": "text/markdown, text/html;q=0.9, */*;q=0.8" },
      redirect: "follow",
    });

    if (!response.ok) {
      return jsonResponse({ error: `Fetch failed (${response.status}): ${response.statusText}` }, response.status);
    }

    const contentType = response.headers.get("content-type") || "";

    // If the server returned Markdown directly (Markdown for Agents), pass through
    if (contentType.includes("text/markdown")) {
      const markdown = await response.text();
      const result = { markdown, source: "markdown-for-agents", spa_detected: false };
      ctx.waitUntil(kvPut(env, cacheKey, JSON.stringify(result), FETCH_KV_TTL, { url: body.url, endpoint: "fetch" }));
      return jsonResponse({ ...result, cache: "miss" });
    }

    // Otherwise, convert HTML via AI.toMarkdown()
    const html = await response.text();
    const spaDetected = detectSpa(html);
    const markdown = await htmlToMarkdown(html, env);
    const result = { markdown, source: "ai-to-markdown", spa_detected: spaDetected };
    ctx.waitUntil(kvPut(env, cacheKey, JSON.stringify(result), FETCH_KV_TTL, { url: body.url, endpoint: "fetch" }));
    return jsonResponse({ ...result, cache: "miss" });
  } catch (e) {
    return jsonResponse({ error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}
