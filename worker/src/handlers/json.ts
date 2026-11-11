import type { Env } from "../types.js";
import { BROWSER_RUN_GOTO } from "../config.js";
import { jsonResponse, parseJsonBody, wrapJsonSchema, browserRunError, BROWSER_MISSING_ERROR, errorMessage } from "../utils.js";
import { validateUrlForSsrf } from "../ssrf.js";

export async function handleJson(request: Request, env: Env): Promise<Response> {
  if (!env.BROWSER) {
    return jsonResponse({ error: BROWSER_MISSING_ERROR }, 500);
  }

  const body = await parseJsonBody<{
    url: string;
    prompt?: string;
    response_format?: unknown;
  }>(request);
  if (body instanceof Response) return body;

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
  }

  if (!body.prompt && !body.response_format) {
    return jsonResponse({ error: "At least one of 'prompt' or 'response_format' is required" }, 400);
  }

  const ssrfError = await validateUrlForSsrf(body.url);
  if (ssrfError) {
    return jsonResponse({ error: ssrfError }, 400);
  }

  const options = {
    url: body.url,
    gotoOptions: BROWSER_RUN_GOTO,
    rejectResourceTypes: ["image", "media", "font"],
    ...(body.prompt ? { prompt: body.prompt } : {}),
    ...(body.response_format ? { response_format: wrapJsonSchema(body.response_format) } : {}),
  } as BrowserRunJsonOptions;

  try {
    const response = await env.BROWSER.quickAction("json", options);
    const data = await response.json<
      { success: boolean; result?: unknown; errors?: unknown[]; rawAiResponse?: string }
    >();

    if (data.success && data.result) {
      return jsonResponse({ data: data.result });
    }

    // The model sometimes returns valid JSON that fails schema validation.
    if (data.rawAiResponse) {
      try {
        return jsonResponse({ data: JSON.parse(data.rawAiResponse) });
      } catch {
        return jsonResponse({ data: data.rawAiResponse });
      }
    }

    return jsonResponse(
      { error: `Browser Run JSON extraction failed (${response.status}): ${browserRunError(data)}` },
      response.ok ? 500 : response.status,
    );
  } catch (e) {
    return jsonResponse({ error: `JSON extraction failed: ${errorMessage(e)}` }, 500);
  }
}
