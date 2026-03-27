interface Env {
  AI: Ai;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
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
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    if (request.method === "POST" && url.pathname === "/fetch") {
      return handleFetch(request, env);
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

    return jsonResponse({ error: "GET /health, POST /fetch, POST /convert, GET /render?url=, POST /json, POST /crawl, or GET /crawl/:job_id" }, 404);
  },
} satisfies ExportedHandler<Env>;

function handleHealth(env: Env): Response {
  return jsonResponse({
    status: "ok",
    capabilities: {
      fetch: true,
      convert: true,
      render: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
      json: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
      crawl: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
    },
  });
}

// --- Fetch URL → AI.toMarkdown() ---

async function handleFetch(request: Request, env: Env): Promise<Response> {
  let body: { url: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
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
      return jsonResponse({ markdown, source: "markdown-for-agents", spa_detected: false });
    }

    // Otherwise, convert HTML via AI.toMarkdown()
    const html = await response.text();
    const spaDetected = detectSpa(html);
    const markdown = await htmlToMarkdown(html, env);
    return jsonResponse({ markdown, source: "ai-to-markdown", spa_detected: spaDetected });
  } catch (e) {
    return jsonResponse({ error: `Fetch failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
  }
}

async function htmlToMarkdown(html: string, env: Env): Promise<string> {
  const blob = new Blob([html], { type: "text/html" });
  const result = await env.AI.toMarkdown([{ name: "page.html", blob }]);
  return result
    .filter((r) => r.format === "markdown")
    .map((r) => r.data)
    .join("\n\n");
}

// --- Convert uploaded files → AI.toMarkdown() ---

async function handleConvert(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  const mimeType = contentType.split(";")[0].trim();

  if (!SUPPORTED_TYPES.has(mimeType)) {
    return jsonResponse({ error: `Unsupported format: ${mimeType}`, supported: [...SUPPORTED_TYPES] }, 415);
  }

  try {
    const isImage = IMAGE_TYPES.has(mimeType);
    const body = await request.arrayBuffer();
    const originalSize = body.byteLength;
    const blob = new Blob([body], { type: mimeType });
    const fileName = `file.${mimeType.split("/").pop() || "bin"}`;
    const result = await env.AI.toMarkdown([{ name: fileName, blob }]);
    const markdown = result
      .filter((r) => r.format === "markdown")
      .map((r) => r.data)
      .join("\n\n");
    const warning = isUnconvertedHtml(markdown) ? "Conversion result may contain unconverted HTML" : undefined;
    return jsonResponse({ markdown, is_image: isImage, original_size: originalSize, warning });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
}

async function handleRender(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "Missing ?url= parameter" }, 400);
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for rendering" }, 500);
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

  const ssrfError = await validateUrlForSsrf(targetUrl);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  try {
    // Step 1: Get JS-rendered HTML via Browser Rendering /content endpoint
    const contentResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/content`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          gotoOptions: { waitUntil: "networkidle0" },
          rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        }),
      },
    );

    if (!contentResponse.ok) {
      const errorBody = await contentResponse.text();
      return jsonResponse({ error: `Browser Rendering API error (${contentResponse.status}): ${errorBody}` }, contentResponse.status);
    }

    const contentData = await contentResponse.json<{ success: boolean; result: string; errors?: unknown[] }>();
    if (!contentData.success) {
      return jsonResponse({ error: "Browser Rendering content API returned failure", details: contentData.errors }, 500);
    }

    // Step 2: Convert rendered HTML to Markdown via AI.toMarkdown()
    const markdown = await htmlToMarkdown(contentData.result, env);

    const response = jsonResponse({ markdown }, 200, { "x-cache": "MISS" });

    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ markdown }), {
          headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": `public, max-age=${RENDER_CACHE_TTL}` },
        })
      )
    );

    return response;
  } catch (e) {
    return jsonResponse({ error: `Render failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
  }
}

// --- JSON Extraction (Browser Rendering /json API proxy) ---

async function handleJson(request: Request, env: Env): Promise<Response> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for JSON extraction" }, 500);
  }

  let body: {
    url: string;
    prompt?: string;
    response_format?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
  }

  if (!body.prompt && !body.response_format) {
    return jsonResponse({ error: "At least one of 'prompt' or 'response_format' is required" }, 400);
  }

  const ssrfError = await validateUrlForSsrf(body.url);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  const jsonUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/json`;
  const jsonBody: Record<string, unknown> = {
    url: body.url,
    gotoOptions: { waitUntil: "networkidle0" },
    rejectResourceTypes: ["image", "media", "font"],
  };
  if (body.prompt) jsonBody.prompt = body.prompt;
  if (body.response_format) jsonBody.response_format = body.response_format;

  try {
    const response = await fetch(jsonUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jsonBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return jsonResponse({ error: `Browser Rendering JSON API error (${response.status}): ${errorBody}` }, response.status);
    }

    const data = await response.json<{ success: boolean; result: unknown; errors?: unknown[] }>();
    if (!data.success) {
      return jsonResponse({ error: "Browser Rendering JSON API returned failure", details: data.errors }, 500);
    }

    return jsonResponse({ data: data.result });
  } catch (e) {
    return jsonResponse({ error: `JSON extraction failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
  }
}

// --- Crawl (Browser Rendering /crawl API proxy) ---

async function handleCrawlStart(request: Request, env: Env): Promise<Response> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for crawling" }, 500);
  }

  let body: {
    url: string;
    limit?: number;
    depth?: number;
    render?: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
    formats?: string[];
    response_format?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
  }

  const ssrfError = await validateUrlForSsrf(body.url);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  const crawlUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl`;
  const formats = body.formats ?? ["markdown"];
  const crawlBody: Record<string, unknown> = {
    url: body.url,
    limit: Math.min(body.limit ?? 50, 100000),
    depth: body.depth ?? 3,
    formats,
    render: body.render ?? true,
    rejectResourceTypes: ["image", "media", "font", "stylesheet"],
  };
  if (formats.includes("json") && body.response_format) {
    crawlBody.response_format = body.response_format;
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
    return jsonResponse({ error: `Crawl failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
  }
}

async function handleCrawlStatus(jobId: string, url: URL, env: Env): Promise<Response> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required" }, 500);
  }

  const limit = url.searchParams.get("limit") || "100";
  const status = url.searchParams.get("status") || "";
  const cursor = url.searchParams.get("cursor") || "";

  let crawlUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/crawl/${jobId}?limit=${limit}`;
  if (status) crawlUrl += `&status=${status}`;
  if (cursor) crawlUrl += `&cursor=${cursor}`;

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

    const data = await response.json();
    return jsonResponse(data);
  } catch (e) {
    return jsonResponse({ error: `Crawl status failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
  }
}

// --- SSRF Prevention ---

const PRIVATE_IP_RANGES: Array<{ prefix: number[]; bits: number }> = [
  // IPv4 private/reserved
  { prefix: [10], bits: 8 },           // 10.0.0.0/8
  { prefix: [172, 16], bits: 12 },     // 172.16.0.0/12
  { prefix: [192, 168], bits: 16 },    // 192.168.0.0/16
  { prefix: [127], bits: 8 },          // 127.0.0.0/8 (loopback)
  { prefix: [169, 254], bits: 16 },    // 169.254.0.0/16 (link-local)
  { prefix: [0], bits: 8 },            // 0.0.0.0/8
  { prefix: [100, 64], bits: 10 },     // 100.64.0.0/10 (CGNAT)
  { prefix: [192, 0, 0], bits: 24 },   // 192.0.0.0/24
  { prefix: [192, 0, 2], bits: 24 },   // 192.0.2.0/24 (TEST-NET-1)
  { prefix: [198, 51, 100], bits: 24 },// 198.51.100.0/24 (TEST-NET-2)
  { prefix: [203, 0, 113], bits: 24 }, // 203.0.113.0/24 (TEST-NET-3)
  { prefix: [224], bits: 4 },          // 224.0.0.0/4 (multicast)
  { prefix: [240], bits: 4 },          // 240.0.0.0/4 (reserved)
];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;

  for (const range of PRIVATE_IP_RANGES) {
    if (ipMatchesCidr(parts, range.prefix, range.bits)) return true;
  }
  return false;
}

function ipMatchesCidr(ip: number[], prefix: number[], bits: number): boolean {
  const ipNum = (ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3];
  // Pad prefix to 4 octets
  const p = [...prefix, 0, 0, 0, 0].slice(0, 4);
  const prefixNum = (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits));
  return (ipNum & mask) === (prefixNum & mask);
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;                    // loopback
  if (lower === "::") return true;                     // unspecified
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 (ULA)
  if (lower.startsWith("fe80")) return true;           // fe80::/10 (link-local)
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIpv4(v4Mapped[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

async function resolveHostname(hostname: string): Promise<string[]> {
  // Use Cloudflare DNS-over-HTTPS to resolve the hostname
  const dohUrl = `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
  const response = await fetch(dohUrl, {
    headers: { Accept: "application/dns-json" },
  });
  if (!response.ok) return [];
  const data = await response.json<{ Answer?: Array<{ type: number; data: string }> }>();
  if (!data.Answer) return [];
  // type 1 = A record, type 28 = AAAA record
  return data.Answer.filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
}

async function validateUrlForSsrf(input: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return "Invalid URL";
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked: unsupported protocol "${parsed.protocol}"`;
  }

  const hostname = parsed.hostname;

  // Check if hostname is a raw IP
  if (isPrivateIp(hostname)) {
    return "Blocked: URL resolves to a private/reserved IP address";
  }

  // Resolve hostname and check each IP
  const ips = await resolveHostname(hostname);
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return "Blocked: URL resolves to a private/reserved IP address";
    }
  }

  return null;
}

// --- SPA Detection ---

function detectSpa(html: string): boolean {
  // Empty SPA mount points
  if (/<div\s+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) return true;

  // Framework markers
  if (/data-reactroot|ng-version=|data-server-rendered/i.test(html)) return true;

  // Noscript with JS requirement
  const noscript = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/i);
  if (noscript && /javascript|enable|activate/i.test(noscript[1])) return true;

  // Low text content ratio: strip tags, check visible text length
  let stripped = html;
  // Loop to handle nested/malformed tags (e.g. <scr<script>ipt>)
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<script\b[^<]*(?:(?!<\/script[\s>])<[^<]*)*<\/script\b[^>]*>/gi, "");
  } while (stripped !== prev);
  do {
    prev = stripped;
    stripped = stripped.replace(/<style\b[^<]*(?:(?!<\/style[\s>])<[^<]*)*<\/style\b[^>]*>/gi, "");
  } while (stripped !== prev);
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]+>/g, "");
  } while (stripped !== prev);
  const textContent = stripped.replace(/\s+/g, " ").trim();
  if (html.length > 5000 && textContent.length < 200) return true;

  return false;
}

// --- Unconverted HTML Detection ---

const HTML_BLOCK_TAGS = /<(?:div|span|section|article|main|table|thead|tbody|tr|td|th|form|input|button|select|textarea|iframe|script|style|link|meta)\b[^>]*>/gi;

function isUnconvertedHtml(text: string): boolean {
  // Short text is unlikely to be unconverted HTML
  if (text.length < 100) return false;

  const tagMatches = text.match(HTML_BLOCK_TAGS);
  if (!tagMatches) return false;

  // Density: HTML tags per 1000 chars
  const density = (tagMatches.length / text.length) * 1000;
  return density > 5;
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", ...extraHeaders },
  });
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
