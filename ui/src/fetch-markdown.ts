// Shared URL fetch → Markdown pipeline.
// Used by file-ops.ts (URL bar) and link-context-menu.ts (context menu).

import { normalizeMarkdown } from "./normalize.ts";
import { isRenderAvailable } from "./settings.ts";

const { invoke } = window.__TAURI__.core;

export interface FetchResult {
  body: string;
  is_markdown: boolean;
}

export interface WorkerFetchResult {
  markdown: string;
  source: string;
  spa_detected: boolean;
}

async function fetchPipeline(
  url: string,
  workerUrl: string | null,
  autoRender: boolean,
  onStatus?: (msg: string) => void,
): Promise<{ content: string; method: string }> {
  // 1. Try Markdown for Agents (free, no Worker needed)
  const result = await invoke<FetchResult>("fetch_url_as_markdown", { url });

  if (result.is_markdown) {
    return { content: normalizeMarkdown(result.body), method: "Markdown for Agents" };
  }

  // 2. HTML returned — try Worker /fetch for AI.toMarkdown() conversion
  if (workerUrl) {
    try {
      const fetchResult = await invoke<WorkerFetchResult>("fetch_url_via_worker", {
        url,
        workerUrl,
      });

      // 2a. If SPA detected and render available, auto-fallback to Browser Rendering
      if (autoRender && fetchResult.spa_detected && isRenderAvailable()) {
        try {
          onStatus?.("JS detected, rendering…");
          const rendered = await invoke<string>("fetch_rendered_url_as_markdown", {
            url,
            workerUrl,
          });
          return { content: normalizeMarkdown(rendered), method: "Browser Rendering (auto)" };
        } catch {
          // Render failed — use fetch result as best effort
        }
      }

      return { content: normalizeMarkdown(fetchResult.markdown), method: "AI.toMarkdown" };
    } catch {
      // Fall through to raw HTML
    }
  }

  // 3. Fallback: raw HTML as-is
  return { content: result.body, method: "raw HTML" };
}

/**
 * Smart fetch: Markdown for Agents → Worker /fetch → auto-render if SPA → raw HTML fallback.
 */
export function getUrlAsMarkdown(
  url: string,
  workerUrl: string | null,
  onStatus?: (msg: string) => void,
): Promise<{ content: string; method: string }> {
  return fetchPipeline(url, workerUrl, true, onStatus);
}

/**
 * Fetch a URL (static only, no SPA auto-fallback).
 * Pipeline: Markdown for Agents → Worker AI.toMarkdown() → raw HTML fallback.
 */
export function fetchUrlAsMarkdown(
  url: string,
  workerUrl: string | null,
): Promise<{ content: string; method: string }> {
  return fetchPipeline(url, workerUrl, false);
}

/**
 * Render a URL via Browser Rendering and convert to Markdown.
 */
export async function renderUrlAsMarkdown(url: string, workerUrl: string): Promise<string> {
  const markdown = await invoke<string>("fetch_rendered_url_as_markdown", { url, workerUrl });
  return normalizeMarkdown(markdown);
}
