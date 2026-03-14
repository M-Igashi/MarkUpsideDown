interface Env {
  AI: Ai;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

const SUPPORTED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/html",
  "text/csv",
  "application/xml",
  "text/xml",
  ...IMAGE_TYPES,
]);

const RENDER_CACHE_TTL = 3600; // 1 hour

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/render") {
      return handleRender(url, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/convert") {
      return handleConvert(request, env);
    }

    return jsonResponse({ error: "POST /convert or GET /render?url= only" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleConvert(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  const mimeType = contentType.split(";")[0].trim();

  if (!SUPPORTED_TYPES.has(mimeType)) {
    return jsonResponse({ error: `Unsupported format: ${mimeType}`, supported: [...SUPPORTED_TYPES] }, 415);
  }

  try {
    const isImage = IMAGE_TYPES.has(mimeType);
    const body = await request.arrayBuffer();
    const blob = new Blob([body], { type: mimeType });
    const result = await env.AI.toMarkdown([blob]);
    const markdown = result.map((r: { data: string }) => r.data).join("\n\n");
    return jsonResponse({ markdown, is_image: isImage });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
}

async function handleRender(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "Missing ?url= parameter" }, 400);
  }

  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return jsonResponse({ error: "CF_ACCOUNT_ID and CF_API_TOKEN secrets are required for rendering" }, 500);
  }

  const skipCache = url.searchParams.get("nocache") === "1";
  const cacheKey = new Request(`${url.origin}/render?url=${encodeURIComponent(targetUrl)}`);
  const cache = caches.default;

  if (!skipCache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("x-cache", "HIT");
      return new Response(cached.body, { status: cached.status, headers });
    }
  }

  try {
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`;
    const apiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: targetUrl,
        rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        gotoOptions: { waitUntil: "networkidle0" },
      }),
    });

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      return jsonResponse({ error: `Browser Rendering API error (${apiResponse.status}): ${errorBody}` }, apiResponse.status);
    }

    const data = await apiResponse.json<{ success: boolean; result: string; errors?: unknown[] }>();
    if (!data.success) {
      return jsonResponse({ error: "Browser Rendering API returned failure", details: data.errors }, 500);
    }

    const response = jsonResponse({ markdown: data.result }, 200, { "x-cache": "MISS" });

    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ markdown: data.result }), {
          headers: { ...corsHeaders(), "content-type": "application/json", "cache-control": `public, max-age=${RENDER_CACHE_TTL}` },
        })
      )
    );

    return response;
  } catch (e) {
    return jsonResponse({ error: `Render failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
  }
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "content-type": "application/json", ...extraHeaders },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
