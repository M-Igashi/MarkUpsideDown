interface Env {
  AI: Ai;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

const SUPPORTED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/html",
  "text/csv",
  "application/xml",
  "text/xml",
  ...IMAGE_TYPES,
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/convert") {
      return new Response(JSON.stringify({ error: "POST /convert only" }), {
        status: 404,
        headers: { ...corsHeaders(), "content-type": "application/json" },
      });
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      const mimeType = contentType.split(";")[0].trim();

      if (!SUPPORTED_TYPES.has(mimeType)) {
        return new Response(
          JSON.stringify({
            error: `Unsupported format: ${mimeType}`,
            supported: [...SUPPORTED_TYPES],
          }),
          {
            status: 415,
            headers: { ...corsHeaders(), "content-type": "application/json" },
          }
        );
      }

      const isImage = IMAGE_TYPES.has(mimeType);
      const body = await request.arrayBuffer();
      const blob = new Blob([body], { type: mimeType });

      const result = await env.AI.toMarkdown([blob]);
      const markdown = result
        .map((r: { data: string }) => r.data)
        .join("\n\n");

      return new Response(
        JSON.stringify({ markdown, is_image: isImage }),
        {
          status: 200,
          headers: { ...corsHeaders(), "content-type": "application/json" },
        }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { ...corsHeaders(), "content-type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
