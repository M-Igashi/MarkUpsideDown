// Shared URL fetch → Markdown pipeline.
// Used by file-ops.ts (URL bar) and link-context-menu.ts (context menu).

import { normalizeMarkdown } from "./normalize.ts";

const { invoke } = window.__TAURI__.core;

export interface FetchResult {
  body: string;
  is_markdown: boolean;
}

/**
 * Fetch a URL and convert to Markdown.
 * Pipeline: Markdown for Agents → Worker AI.toMarkdown() → raw HTML fallback.
 */
export async function fetchUrlAsMarkdown(
  url: string,
  workerUrl: string | null,
): Promise<{ content: string; method: string }> {
  // First try Markdown for Agents (free, no Worker needed)
  const result = await invoke<FetchResult>("fetch_url_as_markdown", { url });

  if (result.is_markdown) {
    return { content: normalizeMarkdown(result.body), method: "Markdown for Agents" };
  }

  // HTML returned — try Worker /fetch for AI.toMarkdown() conversion
  if (workerUrl) {
    try {
      const markdown = await invoke<string>("fetch_url_via_worker", { url, workerUrl });
      return { content: normalizeMarkdown(markdown), method: "AI.toMarkdown" };
    } catch {
      // Fall through to raw HTML
    }
  }

  // Fallback: raw HTML as-is
  return { content: result.body, method: "raw HTML" };
}

/**
 * Render a URL via Browser Rendering and convert to Markdown.
 */
export async function renderUrlAsMarkdown(url: string, workerUrl: string): Promise<string> {
  const markdown = await invoke<string>("fetch_rendered_url_as_markdown", { url, workerUrl });
  return normalizeMarkdown(markdown);
}
