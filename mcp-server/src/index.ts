#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as bridge from "./bridge.js";
import { readFile } from "node:fs/promises";

const WORKER_URL = process.env.MARKUPSIDEDOWN_WORKER_URL;

function getWorkerUrl(bridgeWorkerUrl: string | null): string {
  const url = WORKER_URL || bridgeWorkerUrl;
  if (!url) {
    throw new Error(
      "Worker URL not configured. Set MARKUPSIDEDOWN_WORKER_URL env var or configure in app Settings."
    );
  }
  return url;
}

const server = new McpServer({
  name: "markupsidedown",
  version: "0.1.0",
});

// --- Editor Tools (require running app) ---

server.tool("get_editor_content", "Get current Markdown content from the editor", {}, async () => {
  const content = await bridge.getEditorContent();
  return { content: [{ type: "text", text: content }] };
});

server.tool(
  "set_editor_content",
  "Replace the editor content with the provided Markdown",
  { markdown: z.string().describe("Markdown content to set") },
  async ({ markdown }) => {
    await bridge.setEditorContent(markdown);
    return { content: [{ type: "text", text: "Editor content updated" }] };
  }
);

server.tool(
  "insert_text",
  "Insert text at cursor position, start, or end of the editor",
  {
    text: z.string().describe("Text to insert"),
    position: z
      .enum(["cursor", "start", "end"])
      .optional()
      .describe("Where to insert (default: end)"),
  },
  async ({ text, position }) => {
    await bridge.insertText(text, position);
    return { content: [{ type: "text", text: "Text inserted" }] };
  }
);

// --- Conversion Tools (use Worker, no app needed) ---

server.tool(
  "fetch_markdown",
  "Fetch a URL and return its content as Markdown using Cloudflare Markdown for Agents",
  { url: z.string().url().describe("URL to fetch") },
  async ({ url }) => {
    const response = await fetch(url, {
      headers: { Accept: "text/markdown" },
    });
    const body = await response.text();
    const isMarkdown = (response.headers.get("content-type") || "").includes(
      "text/markdown"
    );
    const tokens = response.headers.get("x-markdown-tokens");
    let info = isMarkdown ? "Markdown" : "HTML (no Markdown for Agents support)";
    if (tokens) info += ` | ${tokens} tokens`;
    return {
      content: [
        { type: "text", text: `--- ${info} ---\n\n${body}` },
      ],
    };
  }
);

server.tool(
  "render_markdown",
  "Fetch a JavaScript-rendered page as Markdown via Browser Rendering",
  { url: z.string().url().describe("URL to render and convert") },
  async ({ url }) => {
    const state = await bridge.getEditorState().catch(() => null);
    const workerUrl = getWorkerUrl(state?.worker_url ?? null);
    const renderUrl = `${workerUrl}/render?url=${encodeURIComponent(url)}`;
    const response = await fetch(renderUrl);
    const data = (await response.json()) as {
      markdown?: string;
      error?: string;
    };
    if (data.error) throw new Error(data.error);
    return {
      content: [{ type: "text", text: data.markdown ?? "" }],
    };
  }
);

server.tool(
  "convert_to_markdown",
  "Convert a local document (PDF, DOCX, XLSX, PPTX, HTML, CSV, XML, images) to Markdown via Workers AI",
  { file_path: z.string().describe("Absolute path to the file to convert") },
  async ({ file_path }) => {
    const state = await bridge.getEditorState().catch(() => null);
    const workerUrl = getWorkerUrl(state?.worker_url ?? null);

    const ext = file_path.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      html: "text/html",
      htm: "text/html",
      csv: "text/csv",
      xml: "application/xml",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
    };
    const mime = mimeMap[ext];
    if (!mime) throw new Error(`Unsupported file type: .${ext}`);

    const bytes = await readFile(file_path);
    const response = await fetch(`${workerUrl}/convert`, {
      method: "POST",
      headers: { "Content-Type": mime },
      body: bytes,
    });
    const data = (await response.json()) as {
      markdown?: string;
      error?: string;
    };
    if (data.error) throw new Error(data.error);
    return {
      content: [{ type: "text", text: data.markdown ?? "" }],
    };
  }
);

// --- File Tools (require running app) ---

server.tool(
  "open_file",
  "Open a Markdown file in the editor",
  { path: z.string().describe("Absolute path to the Markdown file") },
  async ({ path }) => {
    await bridge.openFile(path);
    return { content: [{ type: "text", text: `Opened: ${path}` }] };
  }
);

server.tool(
  "save_file",
  "Save the current editor content to a file",
  {
    path: z
      .string()
      .optional()
      .describe("File path to save to (uses current file if omitted)"),
  },
  async ({ path }) => {
    await bridge.saveFile(path);
    return {
      content: [{ type: "text", text: path ? `Saved to: ${path}` : "File saved" }],
    };
  }
);

server.tool(
  "export_pdf",
  "Export the current editor content as PDF (opens print dialog in the app)",
  {},
  async () => {
    await bridge.exportPdf();
    return { content: [{ type: "text", text: "PDF export triggered" }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
