interface Env {
  AI: Ai;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
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

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/render") {
      return handleRender(url, env);
    }

    if (request.method !== "POST" || url.pathname !== "/convert") {
      return new Response(JSON.stringify({ error: "POST /convert or GET /render?url= only" }), {
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

async function handleRender(url: URL, env: Env): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return new Response(
      JSON.stringify({ error: "Missing ?url= parameter" }),
      { status: 400, headers: { ...corsHeaders(), "content-type": "application/json" } }
    );
  }

  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return new Response(
      JSON.stringify({ error: "CF_ACCOUNT_ID and CF_API_TOKEN secrets are required for rendering" }),
      { status: 500, headers: { ...corsHeaders(), "content-type": "application/json" } }
    );
  }

  try {
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`;

    const apiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: targetUrl,
        rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        gotoOptions: { waitUntil: "networkidle0" },
      }),
    });

    if (!apiResponse.ok) {
      const errorBody = await apiResponse.text();
      return new Response(
        JSON.stringify({ error: `Browser Rendering API error (${apiResponse.status}): ${errorBody}` }),
        { status: apiResponse.status, headers: { ...corsHeaders(), "content-type": "application/json" } }
      );
    }

    const data = await apiResponse.json<{ success: boolean; result: string; errors?: unknown[] }>();

    if (!data.success) {
      return new Response(
        JSON.stringify({ error: "Browser Rendering API returned failure", details: data.errors }),
        { status: 500, headers: { ...corsHeaders(), "content-type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ markdown: data.result }),
      { status: 200, headers: { ...corsHeaders(), "content-type": "application/json" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: `Render failed: ${message}` }),
      { status: 500, headers: { ...corsHeaders(), "content-type": "application/json" } }
    );
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
