import type { Env } from "../types.js";
import { CRAWL_LIMIT_MAX, CRAWL_LIMIT_DEFAULT, CRAWL_DEPTH_DEFAULT } from "../config.js";
import { jsonResponse, parseJsonBody, hasCrawlSecrets, wrapJsonSchema, CORS_HEADERS } from "../utils.js";
import { validateUrlForSsrf } from "../ssrf.js";

const SECRETS_MISSING_ERROR =
  "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for crawling";

// /crawl is only available through the REST API, not the browser binding.
function crawlApiUrl(env: Env, jobId?: string): string {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-run/crawl`;
  return jobId ? `${base}/${jobId}` : base;
}

export async function handleCrawlStart(request: Request, env: Env): Promise<Response> {
  if (!hasCrawlSecrets(env)) {
    return jsonResponse({ error: SECRETS_MISSING_ERROR }, 500);
  }

  const body = await parseJsonBody<{
    url: string;
    limit?: number;
    depth?: number;
    render?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
    formats?: string[];
    response_format?: unknown;
  }>(request);
  if (body instanceof Response) return body;

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
  }

  const ssrfError = await validateUrlForSsrf(body.url);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  const formats = body.formats ?? ["markdown"];
  const render = body.render ?? true;
  const crawlBody: Record<string, unknown> = {
    url: body.url,
    limit: Math.min(body.limit ?? CRAWL_LIMIT_DEFAULT, CRAWL_LIMIT_MAX),
    depth: body.depth ?? CRAWL_DEPTH_DEFAULT,
    formats,
    render,
  };
  if (render) {
    crawlBody.gotoOptions = { waitUntil: "networkidle2", timeout: 45000 };
    crawlBody.rejectResourceTypes = ["image", "media", "font", "stylesheet"];
  }
  if (formats.includes("json")) {
    const jsonOptions: Record<string, unknown> = {};
    if (body.response_format) {
      jsonOptions.response_format = wrapJsonSchema(body.response_format);
    }
    crawlBody.jsonOptions = jsonOptions;
  }

  const options: Record<string, unknown> = {};
  if (body.includePatterns?.length) options.includePatterns = body.includePatterns;
  if (body.excludePatterns?.length) options.excludePatterns = body.excludePatterns;
  if (Object.keys(options).length > 0) crawlBody.options = options;

  try {
    const response = await fetch(crawlApiUrl(env), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(crawlBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return jsonResponse({ error: `Crawl API error (${response.status}): ${errorBody}` }, response.status);
    }

    const data = await response.json<{ success: boolean; result: string; errors?: unknown[] }>();
    if (!data.success) {
      return jsonResponse({ error: "Crawl API returned failure", details: data.errors }, 500);
    }

    return jsonResponse({ job_id: data.result });
  } catch (e) {
    return jsonResponse({ error: `Crawl failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}

export async function handleCrawlStatus(jobId: string, url: URL, env: Env): Promise<Response> {
  if (!hasCrawlSecrets(env)) {
    return jsonResponse({ error: SECRETS_MISSING_ERROR }, 500);
  }

  const limitRaw = url.searchParams.get("limit") || "100";
  const limit = Math.max(1, Math.min(Number.parseInt(limitRaw, 10) || 100, 10000));
  const status = url.searchParams.get("status") || "";
  const cursor = url.searchParams.get("cursor") || "";

  // Record status filter (completed, queued, errored, disallowed, skipped, ...)
  if (!/^[a-z_]*$/.test(status)) {
    return jsonResponse({ error: `Invalid status filter: ${status}` }, 400);
  }

  const crawlStatusUrl = new URL(crawlApiUrl(env, jobId));
  crawlStatusUrl.searchParams.set("limit", String(limit));
  if (status) crawlStatusUrl.searchParams.set("status", status);
  if (cursor) crawlStatusUrl.searchParams.set("cursor", cursor);

  try {
    const response = await fetch(crawlStatusUrl, {
      headers: {
        "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return jsonResponse({ error: `Crawl status API error (${response.status}): ${errorBody}` }, response.status);
    }

    // Stream the upstream body through — results can be many MB of markdown,
    // buffering + re-serializing them just to add CORS headers wastes CPU/memory
    return new Response(response.body, {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  } catch (e) {
    return jsonResponse({ error: `Crawl status failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}

/** Cancel a running crawl job so it stops using browser time. */
export async function handleCrawlCancel(jobId: string, env: Env): Promise<Response> {
  if (!hasCrawlSecrets(env)) {
    return jsonResponse({ error: SECRETS_MISSING_ERROR }, 500);
  }

  try {
    const response = await fetch(crawlApiUrl(env, jobId), {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    });
    if (!response.ok) {
      const errorBody = await response.text();
      return jsonResponse({ error: `Crawl cancel API error (${response.status}): ${errorBody}` }, response.status);
    }
    return jsonResponse({ cancelled: jobId });
  } catch (e) {
    return jsonResponse({ error: `Crawl cancel failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}
