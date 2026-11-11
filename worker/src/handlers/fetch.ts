import type { Env } from "../types.js";
import { jsonResponse, parseJsonBody, htmlToMarkdown, detectSpa, errorMessage } from "../utils.js";
import { fetchWithSsrfCheck } from "../ssrf.js";

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<{ url: string }>(request);
  if (body instanceof Response) return body;

  if (!body.url) {
    return jsonResponse({ error: "Missing 'url' field" }, 400);
  }

  try {
    const result = await fetchWithSsrfCheck(body.url, {
      headers: { "Accept": "text/markdown, text/html;q=0.9, */*;q=0.8" },
    });
    if ("error" in result) {
      return jsonResponse({ error: result.error }, 400);
    }
    const { response, finalUrl } = result;

    if (!response.ok) {
      // 502, not the upstream status: a 401/403 from the target site must not
      // look like a rejected Worker API key
      return jsonResponse({ error: `Fetch failed (${response.status}): ${response.statusText}` }, 502);
    }

    // If the server returned Markdown directly (Markdown for Agents), pass through
    if (response.headers.get("content-type")?.includes("text/markdown")) {
      const markdown = await response.text();
      return jsonResponse({ markdown, source: "markdown-for-agents", spa_detected: false });
    }

    // Otherwise, convert HTML via AI.toMarkdown(), resolving relative links
    // against the final URL so they still work in a local file.
    const html = await response.text();
    const markdown = await htmlToMarkdown(html, finalUrl, env);
    return jsonResponse({ markdown, source: "ai-to-markdown", spa_detected: detectSpa(html) });
  } catch (e) {
    return jsonResponse({ error: `Fetch failed: ${errorMessage(e)}` }, 500);
  }
}
