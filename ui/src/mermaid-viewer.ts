import { copySvgAsPng } from "./html-utils.ts";

let overlay: HTMLDivElement | null = null;
let scale = 1;
let translateX = 0;
let translateY = 0;
let baseWidth = 0;
let baseHeight = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartTX = 0;
let dragStartTY = 0;

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const ZOOM_STEP = 0.15;
const FIT_PADDING = 48;

function getSvg(): SVGElement | null {
  return overlay?.querySelector<SVGElement>(".mermaid-viewer-svg svg") ?? null;
}

function getViewport(): HTMLElement | null {
  return overlay?.querySelector<HTMLElement>(".mermaid-viewer-viewport") ?? null;
}

function getWrapper(): HTMLElement | null {
  return overlay?.querySelector<HTMLElement>(".mermaid-viewer-svg") ?? null;
}

function applyView() {
  const svgEl = getSvg();
  const wrapper = getWrapper();
  if (!svgEl || !wrapper) return;

  // Set SVG to rendered size — vectors re-rasterize crisply at any zoom
  svgEl.setAttribute("width", String(baseWidth * scale));
  svgEl.setAttribute("height", String(baseHeight * scale));

  // Translate only (no CSS scale)
  wrapper.style.transform = `translate(${translateX}px, ${translateY}px)`;
  updateZoomLabel();
}

function fitToView() {
  const viewport = getViewport();
  if (!viewport || baseWidth === 0 || baseHeight === 0) return;

  const vw = viewport.clientWidth - FIT_PADDING * 2;
  const vh = viewport.clientHeight - FIT_PADDING * 2;

  scale = Math.min(vw / baseWidth, vh / baseHeight);
  translateX = (viewport.clientWidth - baseWidth * scale) / 2;
  translateY = (viewport.clientHeight - baseHeight * scale) / 2;
  applyView();
}

function resetView() {
  const viewport = getViewport();
  if (!viewport) return;
  scale = 1;
  translateX = (viewport.clientWidth - baseWidth) / 2;
  translateY = (viewport.clientHeight - baseHeight) / 2;
  applyView();
}

function zoom(delta: number, cx?: number, cy?: number) {
  const prev = scale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
  if (cx !== undefined && cy !== undefined) {
    const ratio = scale / prev;
    translateX = cx - ratio * (cx - translateX);
    translateY = cy - ratio * (cy - translateY);
  }
  applyView();
}

function handleWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const delta = e.deltaY < 0 ? ZOOM_STEP * scale : -ZOOM_STEP * scale;
  zoom(delta, cx, cy);
}

function handlePointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragStartTX = translateX;
  dragStartTY = translateY;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  (e.currentTarget as HTMLElement).style.cursor = "grabbing";
}

function handlePointerMove(e: PointerEvent) {
  if (!dragging) return;
  translateX = dragStartTX + (e.clientX - dragStartX);
  translateY = dragStartTY + (e.clientY - dragStartY);
  const wrapper = getWrapper();
  if (wrapper) wrapper.style.transform = `translate(${translateX}px, ${translateY}px)`;
}

function handlePointerUp(e: PointerEvent) {
  if (!dragging) return;
  dragging = false;
  (e.currentTarget as HTMLElement).style.cursor = "grab";
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
  if (e.key === "=" || e.key === "+") zoom(ZOOM_STEP * scale);
  if (e.key === "-") zoom(-ZOOM_STEP * scale);
  if (e.key === "0") resetView();
  if (e.key === "f") fitToView();
}

function updateZoomLabel() {
  const label = overlay?.querySelector<HTMLElement>(".mermaid-viewer-zoom-label");
  if (label) label.textContent = `${Math.round(scale * 100)}%`;
}

export function open(mermaidContainer: HTMLElement) {
  if (overlay) close();

  const svg = mermaidContainer.querySelector("svg");
  if (!svg) return;

  // Capture natural dimensions from the source SVG
  baseWidth = svg.viewBox.baseVal.width || svg.clientWidth || svg.getBoundingClientRect().width;
  baseHeight = svg.viewBox.baseVal.height || svg.clientHeight || svg.getBoundingClientRect().height;
  if (baseWidth === 0 || baseHeight === 0) return;

  overlay = document.createElement("div");
  overlay.className = "mermaid-viewer-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Viewport
  const viewport = document.createElement("div");
  viewport.className = "mermaid-viewer-viewport";
  viewport.addEventListener("wheel", handleWheel, { passive: false });
  viewport.addEventListener("pointerdown", handlePointerDown);
  viewport.addEventListener("pointermove", handlePointerMove);
  viewport.addEventListener("pointerup", handlePointerUp);
  viewport.addEventListener("pointercancel", handlePointerUp);

  const svgWrapper = document.createElement("div");
  svgWrapper.className = "mermaid-viewer-svg";

  // Clone SVG and ensure viewBox is set for scalable rendering
  const cloned = svg.cloneNode(true) as SVGElement;
  if (!cloned.getAttribute("viewBox") && baseWidth > 0 && baseHeight > 0) {
    cloned.setAttribute("viewBox", `0 0 ${baseWidth} ${baseHeight}`);
  }
  svgWrapper.appendChild(cloned);
  viewport.appendChild(svgWrapper);
  overlay.appendChild(viewport);

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-viewer-toolbar";

  const closeBtn = makeBtn("Close", close);
  closeBtn.classList.add("mermaid-viewer-text-btn", "mermaid-viewer-close-btn");

  const zoomOut = makeBtn("\u2212", () => zoom(-ZOOM_STEP * scale));
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "mermaid-viewer-zoom-label";
  const zoomIn = makeBtn("+", () => zoom(ZOOM_STEP * scale));
  const fitBtn = makeBtn("Fit", fitToView);
  fitBtn.classList.add("mermaid-viewer-text-btn");

  const copyBtn = document.createElement("button");
  copyBtn.className = "mermaid-viewer-btn mermaid-viewer-text-btn";
  copyBtn.textContent = "Copy as PNG";
  copyBtn.addEventListener("click", () => copySvgAsPng(cloned as unknown as SVGElement, copyBtn));

  const hint = document.createElement("span");
  hint.className = "mermaid-viewer-hint";
  hint.textContent = "Esc to close";

  toolbar.append(closeBtn, zoomOut, zoomLabel, zoomIn, fitBtn, copyBtn, hint);
  overlay.appendChild(toolbar);

  document.body.appendChild(overlay);
  document.addEventListener("keydown", handleKeyDown);

  // Fit after layout is ready
  requestAnimationFrame(() => fitToView());
}

function makeBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "mermaid-viewer-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

export function close() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  document.removeEventListener("keydown", handleKeyDown);
}
