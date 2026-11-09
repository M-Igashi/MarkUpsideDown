export interface Env {
  AI: Ai;
  API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CACHE?: KVNamespace;
  CONVERT_QUEUE?: Queue;
  PUBLISH_BUCKET?: R2Bucket;
  R2_PUBLIC_URL?: string;
  VECTORS?: VectorizeIndex;
}

export interface ConvertMessage {
  batchId: string;
  index: number;
  name: string;
}
