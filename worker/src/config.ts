// Bump this when adding/changing endpoints so the app can detect outdated Workers.
export const WORKER_VERSION = 11;

// --- Cache TTLs (seconds) ---
export const RENDER_CACHE_TTL = 3600; // 1 hour
export const FETCH_KV_TTL = 86400; // 24 hours
export const RENDER_KV_TTL = 3600; // 1 hour
export const BATCH_TTL = 3600; // 1 hour

// --- Batch ---
export const BATCH_SEND_MAX = 100; // Queue.sendBatch max messages per call

// --- Crawl ---
export const CRAWL_LIMIT_MAX = 100_000;
export const CRAWL_DEPTH_DEFAULT = 3;
export const CRAWL_LIMIT_DEFAULT = 50;

// --- Embedding ---
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const MAX_CHUNK_TOKENS = 512;
export const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4; // ~4 chars per token
export const VECTORIZE_UPSERT_MAX = 1000;
export const EMBED_DELETE_MAX_CHUNKS = 100;

// --- R2 ---
export const PUBLISH_LIST_LIMIT = 1000;

// --- MIME types ---
export const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
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

export const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  csv: "text/csv",
  xml: "application/xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};
