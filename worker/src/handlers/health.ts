import type { Env } from "../types.js";
import { WORKER_VERSION } from "../config.js";
import { jsonResponse, checkAuth, hasSecrets, hasCache, hasBatch, hasPublish, hasSearch } from "../utils.js";

export async function handleHealth(request: Request, env: Env): Promise<Response> {
  return jsonResponse({
    status: "ok",
    version: WORKER_VERSION,
    auth: await checkAuth(request, env),
    capabilities: {
      fetch: true,
      convert: true,
      render: hasSecrets(env),
      json: hasSecrets(env),
      crawl: hasSecrets(env),
      cache: hasCache(env),
      batch: hasBatch(env),
      publish: hasPublish(env),
      search: hasSearch(env),
    },
  });
}
