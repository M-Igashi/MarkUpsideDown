import type { Env } from "./types.js";

// --- CORS ---

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, cache-control",
};

// --- JSON response ---

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", ...extraHeaders },
  });
}

export async function parseJsonBody<T>(request: Request): Promise<T | Response> {
  try {
    return await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
}

// --- Capability checks ---

export function hasSecrets(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
}

export function hasCache(env: Env): boolean {
  return Boolean(env.CACHE);
}

export function hasBatch(env: Env): boolean {
  return Boolean(env.CONVERT_QUEUE && env.CACHE);
}

export function hasPublish(env: Env): boolean {
  return Boolean(env.PUBLISH_BUCKET);
}

export function hasSearch(env: Env): boolean {
  return Boolean(env.VECTORS);
}

// --- KV cache helpers ---

export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function shouldBypassCache(request: Request): boolean {
  return request.headers.get("cache-control") === "no-cache";
}

export async function kvGet(env: Env, key: string): Promise<string | null> {
  if (!env.CACHE) return null;
  return env.CACHE.get(key);
}

export async function kvPut(env: Env, key: string, value: string, ttl: number, metadata: Record<string, string>): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.put(key, value, { expirationTtl: ttl, metadata });
}

// --- AI conversion helper ---

export async function htmlToMarkdown(html: string, env: Env): Promise<string> {
  const blob = new Blob([html], { type: "text/html" });
  const result = await env.AI.toMarkdown([{ name: "page.html", blob }]);
  return result
    .filter((r) => r.format === "markdown")
    .map((r) => r.data)
    .join("\n\n");
}

// --- SPA detection ---

export function detectSpa(html: string): boolean {
  // Empty SPA mount points
  if (/<div\s+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) return true;

  // Framework markers
  if (/data-reactroot|ng-version=|data-server-rendered/i.test(html)) return true;

  // Noscript with JS requirement
  const noscript = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/i);
  if (noscript && /javascript|enable|activate/i.test(noscript[1])) return true;

  // Low text content ratio: strip tags, check visible text length.
  // Loop until stable — nested fragments like <scr<script>ipt> can
  // reform a tag after a single replacement pass.
  let stripped = html;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped
      .replace(/<script\b[^<]*(?:(?!<\/script[\s>])<[^<]*)*<\/script\b[^>]*>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style[\s>])<[^<]*)*<\/style\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "");
  } while (stripped !== prev);
  const textContent = stripped.replace(/\s+/g, " ").trim();
  if (html.length > 5000 && textContent.length < 200) return true;

  return false;
}

// --- Unconverted HTML detection ---

const HTML_BLOCK_TAGS = /<(?:div|span|section|article|main|table|thead|tbody|tr|td|th|form|input|button|select|textarea|iframe|script|style|link|meta)\b[^>]*>/gi;

export function isUnconvertedHtml(text: string): boolean {
  if (text.length < 100) return false;
  const tagMatches = text.match(HTML_BLOCK_TAGS);
  if (!tagMatches) return false;
  const density = (tagMatches.length / text.length) * 1000;
  return density > 5;
}

// --- JSON Schema wrapper ---

/** Wrap a raw JSON Schema into the format expected by Browser Rendering APIs. */
export function wrapJsonSchema(schema: unknown): unknown {
  if (typeof schema === "object" && schema !== null && "type" in schema && (schema as Record<string, unknown>).type === "json_schema") {
    return schema;
  }
  return {
    type: "json_schema",
    json_schema: {
      name: "extraction",
      schema,
    },
  };
}

// --- MIME helpers ---

export function mimeToFilename(mimeType: string, mimeToExt: Record<string, string>): string {
  const ext = mimeToExt[mimeType] ?? mimeType.split("/").pop() ?? "bin";
  return `file.${ext}`;
}
