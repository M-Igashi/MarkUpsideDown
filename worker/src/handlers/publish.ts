import type { Env } from "../types.js";
import { PUBLISH_LIST_LIMIT } from "../config.js";
import { jsonResponse, parseJsonBody, CORS_HEADERS, R2_MISSING_ERROR } from "../utils.js";

const MAX_EXPIRES_IN = 10 * 365 * 24 * 60 * 60;

interface PublishRequest {
  key: string;
  content: string;
  filename: string;
  expires_in?: number; // seconds (0 or omitted = permanent)
}

function isExpired(expiresAt: string | undefined, now = Date.now()): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

/** Cron job: delete expired documents. Needed because R2 public URLs
 *  (R2_PUBLIC_URL) bypass the expiry check in handleServePublished. */
export async function deleteExpiredPublished(env: Env): Promise<void> {
  if (!env.PUBLISH_BUCKET) return;
  const now = Date.now();
  let cursor: string | undefined;
  do {
    const listed = await env.PUBLISH_BUCKET.list({ cursor, include: ["customMetadata"] });
    const expired = listed.objects
      .filter((obj) => isExpired(obj.customMetadata?.expiresAt, now))
      .map((obj) => obj.key);
    if (expired.length > 0) {
      await env.PUBLISH_BUCKET.delete(expired);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function handlePublish(request: Request, env: Env): Promise<Response> {
  if (!env.PUBLISH_BUCKET) {
    return jsonResponse({ error: R2_MISSING_ERROR }, 500);
  }

  const body = await parseJsonBody<PublishRequest>(request);
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Request body must be a JSON object" }, 400);
  }

  if (!body.key || body.content == null) {
    return jsonResponse(
      { error: `Missing required fields: ${!body.key ? "'key'" : ""}${!body.key && body.content == null ? " and " : ""}${body.content == null ? "'content'" : ""}` },
      400,
    );
  }

  const ttl = body.expires_in;
  if (ttl !== undefined && ttl !== null && ttl !== 0 && !(typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_EXPIRES_IN)) {
    return jsonResponse({ error: `'expires_in' must be a number of seconds between 1 and ${MAX_EXPIRES_IN}` }, 400);
  }

  const now = new Date();
  const expiresAt = ttl ? new Date(now.getTime() + ttl * 1000).toISOString() : null;

  await env.PUBLISH_BUCKET.put(body.key, body.content, {
    // Served directly by R2 when R2_PUBLIC_URL is set, so the type must be stored
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: {
      filename: body.filename || "untitled.md",
      publishedAt: now.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    },
  });

  let base = env.R2_PUBLIC_URL;
  if (base) {
    while (base.endsWith("/")) base = base.slice(0, -1);
  }
  const keyPath = body.key.split("/").map(encodeURIComponent).join("/");
  const publicUrl = base ? `${base}/${keyPath}` : `${new URL(request.url).origin}/p/${keyPath}`;

  return jsonResponse({
    key: body.key,
    url: publicUrl,
    publishedAt: now.toISOString(),
    expiresAt,
  });
}

export async function handleServePublished(key: string, env: Env): Promise<Response> {
  if (!env.PUBLISH_BUCKET) {
    return jsonResponse({ error: R2_MISSING_ERROR }, 500);
  }

  const obj = await env.PUBLISH_BUCKET.get(key);
  if (!obj) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  const expiresAt = obj.customMetadata?.expiresAt;
  if (isExpired(expiresAt)) {
    await env.PUBLISH_BUCKET.delete(key);
    return new Response("Gone — this content has expired", { status: 410, headers: CORS_HEADERS });
  }

  return new Response(obj.body, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/markdown; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...(expiresAt ? { "x-expires-at": expiresAt } : {}),
    },
  });
}

export async function handleUnpublish(key: string, env: Env): Promise<Response> {
  if (!env.PUBLISH_BUCKET) {
    return jsonResponse({ error: R2_MISSING_ERROR }, 500);
  }

  await env.PUBLISH_BUCKET.delete(key);
  return jsonResponse({ deleted: key });
}

export async function handlePublishedList(env: Env): Promise<Response> {
  if (!env.PUBLISH_BUCKET) {
    return jsonResponse({ error: R2_MISSING_ERROR }, 500);
  }

  const listed = await env.PUBLISH_BUCKET.list({ limit: PUBLISH_LIST_LIMIT });
  const files = listed.objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));

  return jsonResponse({ files });
}
