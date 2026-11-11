// Bump this when adding/changing endpoints so the app can detect outdated Workers.
export const WORKER_VERSION = 15;

// --- Browser Run ---
// Quick Actions cache their results on Cloudflare's side (max 86,400 seconds).
export const RENDER_CACHE_TTL = 3600; // 1 hour
export const BROWSER_RUN_GOTO = { waitUntil: "networkidle2", timeout: 45000 } as const;
export const BROWSER_RUN_REJECT: ("image" | "media" | "font" | "stylesheet")[] = ["image", "media", "font", "stylesheet"];

// --- Crawl ---
export const CRAWL_LIMIT_MAX = 100_000;
export const CRAWL_DEPTH_DEFAULT = 3;
export const CRAWL_LIMIT_DEFAULT = 50;

// --- Semantic search (AI Search) ---
export const SEARCH_INSTANCE = "markupsidedown-docs";
export const SEARCH_LIMIT_DEFAULT = 10;

// --- R2 ---
export const PUBLISH_LIST_LIMIT = 1000;

// --- MIME types ---
export const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/bmp",
]);

export const SUPPORTED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "text/csv",
  "application/xml",
  "text/xml",
  ...IMAGE_TYPES,
]);

export const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/csv": "csv",
  "application/xml": "xml",
  "text/xml": "xml",
};
