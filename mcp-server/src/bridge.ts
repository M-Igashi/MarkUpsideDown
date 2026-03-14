import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT_FILE = join(homedir(), ".markupsidedown-bridge-port");
const TIMEOUT = 5000;

async function getBridgeUrl(): Promise<string | null> {
  try {
    const port = (await readFile(PORT_FILE, "utf-8")).trim();
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

async function bridgeRequest(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<unknown> {
  const baseUrl = await getBridgeUrl();
  if (!baseUrl) {
    throw new Error(
      "MarkUpsideDown app is not running (no bridge port file found)"
    );
  }

  const url = `${baseUrl}${path}`;
  const init: RequestInit = {
    method: options?.method ?? "GET",
    signal: AbortSignal.timeout(TIMEOUT),
  };

  if (options?.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Bridge returned ${response.status}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function isAppRunning(): Promise<boolean> {
  try {
    await bridgeRequest("/health");
    return true;
  } catch {
    return false;
  }
}

export async function getEditorContent(): Promise<string> {
  const data = (await bridgeRequest("/editor/content")) as {
    content: string;
  };
  return data.content;
}

export async function setEditorContent(content: string): Promise<void> {
  await bridgeRequest("/editor/content", {
    method: "POST",
    body: { content },
  });
}

export async function insertText(
  text: string,
  position?: string
): Promise<void> {
  await bridgeRequest("/editor/insert", {
    method: "POST",
    body: { text, position },
  });
}

export async function getEditorState(): Promise<{
  file_path: string | null;
  worker_url: string | null;
  cursor_pos: number;
}> {
  return (await bridgeRequest("/editor/state")) as {
    file_path: string | null;
    worker_url: string | null;
    cursor_pos: number;
  };
}

export async function openFile(path: string): Promise<void> {
  await bridgeRequest("/editor/open-file", {
    method: "POST",
    body: { path },
  });
}

export async function saveFile(path?: string): Promise<void> {
  await bridgeRequest("/editor/save-file", {
    method: "POST",
    body: { path: path ?? null },
  });
}

export async function exportPdf(): Promise<void> {
  await bridgeRequest("/editor/export-pdf", { method: "POST" });
}
