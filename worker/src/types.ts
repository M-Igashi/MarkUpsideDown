export interface Env {
  AI: Ai;
  API_KEY?: string;
  BROWSER?: BrowserRun;
  AI_SEARCH?: AiSearchNamespace;
  // Only needed for /crawl, which Browser Run exposes through the REST API only.
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  PUBLISH_BUCKET?: R2Bucket;
  R2_PUBLIC_URL?: string;
}
