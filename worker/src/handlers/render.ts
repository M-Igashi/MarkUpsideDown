import type { Env } from "../types.js";
import { RENDER_CACHE_TTL, BROWSER_RUN_GOTO, BROWSER_RUN_REJECT } from "../config.js";
import { jsonResponse, browserRunError, BROWSER_MISSING_ERROR, errorMessage } from "../utils.js";
import { validateUrlForSsrf } from "../ssrf.js";

export async function handleRender(url: URL, env: Env): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "Missing ?url= parameter" }, 400);
  }

  if (!env.BROWSER) {
    return jsonResponse({ error: BROWSER_MISSING_ERROR }, 500);
  }

  const ssrfError = await validateUrlForSsrf(targetUrl);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  try {
    // Browser Run caches the result itself, so repeated renders of the same
    // URL within the TTL do not use browser time.
    const response = await env.BROWSER.quickAction("markdown", {
      url: targetUrl,
      gotoOptions: BROWSER_RUN_GOTO,
      rejectResourceTypes: BROWSER_RUN_REJECT,
      cacheTTL: url.searchParams.get("nocache") === "1" ? 0 : RENDER_CACHE_TTL,
    });
    const data = await response.json<BrowserRunMarkdownSuccessResponse | BrowserRunErrorResponse>();
    if (!response.ok || !data.success) {
      return jsonResponse(
        { error: `Browser Run markdown failed (${response.status}): ${browserRunError(data)}` },
        response.ok ? 500 : response.status,
      );
    }
    return jsonResponse({ markdown: data.result });
  } catch (e) {
    return jsonResponse({ error: `Render failed: ${errorMessage(e)}` }, 500);
  }
}
