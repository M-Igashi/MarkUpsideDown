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

    if (request.method === "GET" && url.pathname === "/render") {
      return handleRender(url, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/convert") {
      return handleConvert(request, env);
    }

    return jsonResponse({ error: "GET /health, POST /convert, or GET /render?url=" }, 404);
  },
} satisfies ExportedHandler<Env>;

function handleHealth(env: Env): Response {
  return jsonResponse({
    status: "ok",
    capabilities: {
      convert: true,
      render: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
    },
  });
}

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
    const result = await env.AI.toMarkdown([blob]);
    const markdown = result.map((r: { data: string }) => r.data).join("\n\n");
    return jsonResponse({ markdown, is_image: isImage, original_size: originalSize });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
}

async function handleRender(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "Missing ?url= parameter" }, 400);
  }

  const ssrfError = await validateUrlForSsrf(targetUrl);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
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

  try {
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering`;
    const authHeaders = {
      "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    };
    const browserOptions = {
      url: targetUrl,
      rejectResourceTypes: ["image", "media", "font", "stylesheet"],
      gotoOptions: { waitUntil: "networkidle0" },
    };

    // Step 1: Get rendered HTML via /content endpoint
    const contentResponse = await fetch(`${baseUrl}/content`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(browserOptions),
    });

    if (!contentResponse.ok) {
      const errorBody = await contentResponse.text();
      return jsonResponse({ error: `Browser Rendering API error (${contentResponse.status}): ${errorBody}` }, contentResponse.status);
    }

    const contentData = await contentResponse.json<{ success: boolean; result: string; errors?: unknown[] }>();
    if (!contentData.success) {
      return jsonResponse({ error: "Browser Rendering content API returned failure", details: contentData.errors }, 500);
    }

    // Step 2: Clean HTML — strip nav, header, footer, aside, etc.
    const cleanedHtml = await stripBoilerplate(contentData.result);

    // Step 3: Convert cleaned HTML to markdown via /markdown endpoint
    const apiResponse = await fetch(`${baseUrl}/markdown`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ html: cleanedHtml }),
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
          headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": `public, max-age=${RENDER_CACHE_TTL}` },
        })
      )
    );

    return response;
  } catch (e) {
    return jsonResponse({ error: `Render failed: ${e instanceof Error ? e.message : "Unknown error"}` }, 500);
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

async function stripBoilerplate(html: string): Promise<string> {
  const remove = { element(el: Element) { el.remove(); } };
  const rewriter = new HTMLRewriter()
    // Structural boilerplate
    .on("nav", remove)
    .on("header", remove)
    .on("footer", remove)
    .on("aside", remove)
    .on("script", remove)
    .on("style", remove)
    .on("noscript", remove)
    // ARIA roles
    .on("[role='navigation']", remove)
    .on("[role='banner']", remove)
    .on("[role='contentinfo']", remove)
    .on("[role='complementary']", remove)
    .on("[aria-hidden='true']", remove)
    // Cookie consent / privacy banners
    .on("[class*='cookie']", remove)
    .on("[class*='consent']", remove)
    .on("[id*='cookie']", remove)
    .on("[id*='consent']", remove)
    .on("[class*='gdpr']", remove)
    // Ad containers
    .on("[class*='adsbygoogle']", remove)
    .on("[class*='ad-container']", remove)
    .on("[class*='ad-wrapper']", remove)
    .on("[id*='google_ads']", remove)
    .on("ins.adsbygoogle", remove)
    // Social sharing widgets
    .on("[class*='share-buttons']", remove)
    .on("[class*='social-share']", remove)
    .on("[class*='sharing-buttons']", remove);
  return rewriter.transform(new Response(html)).text();
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
