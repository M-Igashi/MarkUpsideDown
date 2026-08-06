import type { Env } from "../types.js";
import { IMAGE_TYPES, SUPPORTED_TYPES, MIME_TO_EXT } from "../config.js";
import { jsonResponse, isUnconvertedHtml, mimeToFilename, toMarkdownText } from "../utils.js";

export async function handleConvert(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  const mimeType = contentType.split(";")[0].trim();

  if (!SUPPORTED_TYPES.has(mimeType)) {
    return jsonResponse({ error: `Unsupported format: ${mimeType}`, supported: [...SUPPORTED_TYPES] }, 415);
  }

  try {
    const isImage = IMAGE_TYPES.has(mimeType);
    const body = await request.arrayBuffer();
    const originalSize = body.byteLength;
    const blob = new Blob([body], { type: mimeType });
    const fileName = mimeToFilename(mimeType, MIME_TO_EXT);
    const result = await env.AI.toMarkdown([{ name: fileName, blob }]);
    const markdown = toMarkdownText(result);
    const warning = isUnconvertedHtml(markdown) ? "Conversion result may contain unconverted HTML" : undefined;
    return jsonResponse({ markdown, is_image: isImage, original_size: originalSize, warning });
  } catch (e) {
    return jsonResponse({ error: `Conversion failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
}
