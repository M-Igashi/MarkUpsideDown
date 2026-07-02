import type { Env } from "../types.js";
import { CRAWL_LIMIT_MAX, CRAWL_LIMIT_DEFAULT, CRAWL_DEPTH_DEFAULT } from "../config.js";
import { jsonResponse, parseJsonBody, hasSecrets, wrapJsonSchema, CORS_HEADERS } from "../utils.js";
import { validateUrlForSsrf } from "../ssrf.js";

export async function handleCrawlStart(request: Request, env: Env): Promise<Response> {
  if (!hasSecrets(env)) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for crawling" }, 500);
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

  const crawlUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl`;
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
    const response = await fetch(crawlUrl, {
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
  if (!hasSecrets(env)) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required" }, 500);
  }

  const limitRaw = url.searchParams.get("limit") || "100";
  const limit = Math.max(1, Math.min(Number.parseInt(limitRaw, 10) || 100, 10000));
  const status = url.searchParams.get("status") || "";
  const cursor = url.searchParams.get("cursor") || "";

  const validStatuses = ["", "completed", "pending", "failed"];
  if (!validStatuses.includes(status)) {
    return jsonResponse({ error: `Invalid status filter: ${status}` }, 400);
  }

  const crawlStatusUrl = new URL(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl/${jobId}`);
  crawlStatusUrl.searchParams.set("limit", String(limit));
  if (status) crawlStatusUrl.searchParams.set("status", status);
  if (cursor) crawlStatusUrl.searchParams.set("cursor", cursor);
  const crawlUrl = crawlStatusUrl.toString();

  try {
    const response = await fetch(crawlUrl, {
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
