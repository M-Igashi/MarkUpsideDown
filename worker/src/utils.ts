import type { Env } from "./types.js";

// --- CORS ---

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, cache-control, authorization",
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

// --- API key auth ---

export type AuthStatus = "valid" | "invalid" | "missing" | "unconfigured";

function sha256Bytes(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

export async function checkAuth(request: Request, env: Env): Promise<AuthStatus> {
  if (!env.API_KEY) return "unconfigured";
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return "missing";
  // Compare fixed-length digests so the comparison is constant-time.
  const [given, expected] = await Promise.all([sha256Bytes(match[1]), sha256Bytes(env.API_KEY)]);
  return crypto.subtle.timingSafeEqual(given, expected) ? "valid" : "invalid";
}

export function authErrorResponse(status: Exclude<AuthStatus, "valid">): Response {
  if (status === "unconfigured") {
    return jsonResponse(
      { error: "API_KEY secret is not set on this Worker. Click Update Worker in MarkUpsideDown Settings, or run `wrangler secret put API_KEY`." },
      500,
    );
  }
  return jsonResponse(
    { error: `Unauthorized: ${status} API key. Set the Worker API key in MarkUpsideDown Settings (MCP: MARKUPSIDEDOWN_WORKER_KEY).` },
    401,
  );
}

// --- Capability checks ---

export function hasCrawlSecrets(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
}

export function hasPublish(env: Env): boolean {
  return Boolean(env.PUBLISH_BUCKET);
}

// --- Browser Run ---

export const BROWSER_MISSING_ERROR =
  "Browser Run binding is missing on this Worker. Click Update Worker in MarkUpsideDown Settings.";

/** Join the error messages of a failed Browser Run response. */
export function browserRunError(data: unknown): string {
  const errors = (data as { errors?: { message?: string }[] } | null)?.errors;
  return errors?.map((e) => e.message).filter(Boolean).join("; ") || "unknown error";
}

// --- AI conversion helpers ---

/** Flatten an AI.toMarkdown() result into a single Markdown string. */
export function toMarkdownText(result: ConversionResponse[]): string {
  const failed = result.find((r) => r.format === "error");
  if (failed?.format === "error") throw new Error(failed.error);
  return result
    .map((r) => (r.format === "error" ? "" : r.data))
    .filter(Boolean)
    .join("\n\n");
}

/** Convert HTML to Markdown, resolving relative links against the page URL. */
export async function htmlToMarkdown(html: string, pageUrl: string, env: Env): Promise<string> {
  const blob = new Blob([html], { type: "text/html" });
  const result = await env.AI.toMarkdown([{ name: "page.html", blob }], {
    conversionOptions: { html: { hostname: pageUrl } },
  });
  return toMarkdownText(result);
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

/** Wrap a raw JSON Schema into the format expected by Browser Run APIs. */
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
