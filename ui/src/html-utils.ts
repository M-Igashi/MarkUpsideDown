/** Write a text file via Tauri IPC. Shared helper to avoid duplicating the invoke wrapper. */
export function writeTextFile(path: string, content: string): Promise<void> {
  return window.__TAURI__.core.invoke("write_text_file", { path, content });
}

/** Write bytes to a new file via Tauri IPC. Fails if the file already exists. */
export function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  return window.__TAURI__.core.invoke("write_file_bytes", bytes, {
    headers: { path: encodeURIComponent(path) },
  });
}

/** Copy text to the system clipboard. Shows an error dialog and returns false on failure. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await window.__TAURI__.core.invoke("copy_to_clipboard", { text });
    return true;
  } catch (e) {
    window.__TAURI__.dialog.message(`Copy failed: ${e}`, { kind: "error" });
    return false;
  }
}

/** Show "Copied!" on a button for a moment, then restore its label. */
export function flashCopied(btn: HTMLElement) {
  const label = btn.textContent;
  if (label === "Copied!") return;
  btn.textContent = "Copied!";
  setTimeout(() => {
    btn.textContent = label;
  }, 1500);
}

/** Escape HTML special characters to prevent injection. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Copy an SVG element to clipboard as a 2x PNG (Retina). */
export function copySvgAsPng(svgEl: SVGElement, btn: HTMLButtonElement) {
  const svgData = new XMLSerializer().serializeToString(svgEl);
  const img = new Image();
  img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard
        .write([new ClipboardItem({ "image/png": blob })])
        .then(() => flashCopied(btn));
    });
  };
}

/** Move an absolutely positioned popup back inside the viewport if it overflows. */
export function clampToViewport(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    el.style.left = `${window.innerWidth - rect.width - 4}px`;
  }
  if (rect.bottom > window.innerHeight) {
    el.style.top = `${window.innerHeight - rect.height - 4}px`;
  }
}
