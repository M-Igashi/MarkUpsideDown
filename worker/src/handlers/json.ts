import type { Env } from "../types.js";
import { jsonResponse, hasSecrets, wrapJsonSchema } from "../utils.js";
import { validateUrlForSsrf } from "../ssrf.js";

export async function handleJson(request: Request, env: Env): Promise<Response> {
  if (!hasSecrets(env)) {
    return jsonResponse({ error: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN secrets are required for JSON extraction" }, 500);
  }

  let body: {
    url: string;
    prompt?: string;
    response_format?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

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

  const jsonUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/json`;
  const jsonBody: Record<string, unknown> = {
    url: body.url,
    gotoOptions: { waitUntil: "networkidle0" },
    rejectResourceTypes: ["image", "media", "font"],
  };
  if (body.prompt) jsonBody.prompt = body.prompt;
  if (body.response_format) {
    jsonBody.response_format = wrapJsonSchema(body.response_format);
  }

  try {
    const response = await fetch(jsonUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jsonBody),
    });

    const status = response.status;
    const data = await response.json<{ success: boolean; result: unknown; errors?: unknown[]; rawAiResponse?: string }>();

    if (!response.ok) {
      return jsonResponse({ error: `Browser Rendering JSON API error (${status})`, details: data.errors }, status);
    }

    if (data.success && data.result) {
      return jsonResponse({ data: data.result });
    }

    if (data.rawAiResponse) {
      try {
        const parsed = JSON.parse(data.rawAiResponse);
        return jsonResponse({ data: parsed });
      } catch {
        return jsonResponse({ data: data.rawAiResponse });
      }
    }

    return jsonResponse({ error: "No data in response", details: data.errors }, 500);
  } catch (e) {
    return jsonResponse({ error: `JSON extraction failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}
