import type { EditorView } from "@codemirror/view";
import { dirname, basename } from "./path-utils.ts";

const { invoke } = window.__TAURI__.core;

const IMAGE_MIME_PREFIXES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];

interface ImagePasteDeps {
  editor: EditorView;
  statusEl: HTMLElement;
  getCurrentFilePath: () => string | null;
}

let deps: ImagePasteDeps;

export function initImagePaste(d: ImagePasteDeps) {
  deps = d;
}

function getAssetsDir(filePath: string): string {
  return `${dirname(filePath)}/assets`;
}

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function extensionForMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/bmp") return "bmp";
  return "png";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function saveAndInsert(data: Uint8Array, filename: string, pos: number) {
  const filePath = deps.getCurrentFilePath();
  if (!filePath) {
    deps.statusEl.textContent = "Save the file first to paste images";
    return;
  }

  const assetsDir = getAssetsDir(filePath);
  const destPath = `${assetsDir}/${filename}`;

  try {
    await invoke("save_image", { path: destPath, data: Array.from(data) });
  } catch (e) {
    deps.statusEl.textContent = `Failed to save image: ${e}`;
    return;
  }

  const imageLink = `![](./assets/${filename})`;
  deps.editor.dispatch({
    changes: { from: pos, insert: imageLink },
    selection: { anchor: pos + imageLink.length },
  });
  deps.editor.focus();
  deps.statusEl.textContent = `Saved image: ${filename}`;
}

export async function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (!IMAGE_MIME_PREFIXES.some((p) => item.type.startsWith(p))) continue;
    const blob = item.getAsFile();
    if (!blob) continue;

    e.preventDefault();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ext = extensionForMime(item.type);
    const filename = `clipboard-${formatTimestamp()}.${ext}`;
    const pos = deps.editor.state.selection.main.head;
    await saveAndInsert(bytes, filename, pos);
    return;
  }
}

export async function handleImageDrop(e: DragEvent) {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  if (!IMAGE_MIME_PREFIXES.some((p) => file.type.startsWith(p))) return;

  e.preventDefault();
  e.stopPropagation();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.toLowerCase() || "png";
  const stem = sanitizeFilename(basename(file.name).replace(/\.[^.]+$/, "") || "image");
  const filename = `${stem}-${formatTimestamp()}.${ext}`;

  const pos =
    deps.editor.posAtCoords({ x: e.clientX, y: e.clientY }) ??
    deps.editor.state.selection.main.head;
  await saveAndInsert(bytes, filename, pos);
}
