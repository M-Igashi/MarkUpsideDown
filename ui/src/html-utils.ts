/** Write a text file via Tauri IPC. Shared helper to avoid duplicating the invoke wrapper. */
export function writeTextFile(path: string, content: string): Promise<void> {
  return window.__TAURI__.core.invoke("write_text_file", { path, content });
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
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy as PNG";
        }, 1500);
      });
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
