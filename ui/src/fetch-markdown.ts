// Shared URL fetch → Markdown pipeline.
// Used by file-ops.ts (URL bar and preview link context menu).

import { normalizeMarkdown } from "./normalize.ts";
import { getWorkerKey, isRenderAvailable } from "./settings.ts";

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
  // 1. Worker /fetch first: it asks for Markdown for Agents itself and converts
  //    HTML with AI.toMarkdown(), so the page is downloaded only once.
  if (workerUrl) {
    try {
      const fetchResult = await invoke<WorkerFetchResult>("fetch_url_via_worker", {
        url,
        workerUrl,
        workerKey: getWorkerKey() || null,
      });
      if (fetchResult.source === "markdown-for-agents") {
        return { content: normalizeMarkdown(fetchResult.markdown), method: "Markdown for Agents" };
      }

      // 1a. If SPA detected and render available, auto-fallback to Browser Run
      if (autoRender && fetchResult.spa_detected && isRenderAvailable()) {
        try {
          onStatus?.("JS detected, rendering…");
          const rendered = await invoke<string>("fetch_rendered_url_as_markdown", {
            url,
            workerUrl,
            workerKey: getWorkerKey() || null,
          });
          return { content: normalizeMarkdown(rendered), method: "Browser Run (auto)" };
        } catch {
          // Render failed — use fetch result as best effort
        }
      }

      return { content: normalizeMarkdown(fetchResult.markdown), method: "AI.toMarkdown" };
    } catch {
      // Fall back to a direct fetch (e.g. intranet URLs the Worker refuses)
    }
  }

  // 2. Direct fetch: Markdown for Agents (no Worker needed), else raw HTML as-is
  const result = await invoke<FetchResult>("fetch_url_as_markdown", { url });
  if (result.is_markdown) {
    return { content: normalizeMarkdown(result.body), method: "Markdown for Agents" };
  }
  return { content: result.body, method: "raw HTML" };
}

/**
 * Smart fetch: Worker /fetch (Markdown for Agents or AI.toMarkdown) → auto-render if SPA
 * → direct fetch fallback (Markdown for Agents or raw HTML).
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
 * Pipeline: Worker /fetch → direct fetch fallback (Markdown for Agents or raw HTML).
 */
export function fetchUrlAsMarkdown(
  url: string,
  workerUrl: string | null,
): Promise<{ content: string; method: string }> {
  return fetchPipeline(url, workerUrl, false);
}

/**
 * Render a URL via Browser Run and convert to Markdown.
 */
export async function renderUrlAsMarkdown(url: string, workerUrl: string): Promise<string> {
  const markdown = await invoke<string>("fetch_rendered_url_as_markdown", {
    url,
    workerUrl,
    workerKey: getWorkerKey() || null,
  });
  return normalizeMarkdown(markdown);
}
