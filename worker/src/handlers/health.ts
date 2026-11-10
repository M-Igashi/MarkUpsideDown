import type { Env } from "../types.js";
import { WORKER_VERSION } from "../config.js";
import { jsonResponse, checkAuth, hasCrawlSecrets, hasPublish } from "../utils.js";

export async function handleHealth(request: Request, env: Env): Promise<Response> {
  return jsonResponse({
    status: "ok",
    version: WORKER_VERSION,
    auth: await checkAuth(request, env),
    capabilities: {
      fetch: true,
      convert: true,
      render: Boolean(env.BROWSER),
      json: Boolean(env.BROWSER),
      crawl: hasCrawlSecrets(env),
      publish: hasPublish(env),
      search: Boolean(env.AI_SEARCH),
    },
  });
}
