// Slide presentation mode: split document at horizontal rules
// and display one slide at a time in fullscreen.

import { markdownToSlides, renderSlide } from "./preview-render.ts";
import { parseFrontmatter } from "./document-structure.ts";

let overlay: HTMLElement | null = null;
let slides: string[] = [];
let currentSlide = 0;

export function startPresentation(content: string) {
  const lines = content.split("\n");
  const fm = parseFrontmatter(lines);
  slides = markdownToSlides(fm ? lines.slice(fm.endLine).join("\n") : content);

  if (slides.length === 0) return;

  if (overlay) stopPresentation();
  currentSlide = 0;
  createOverlay();
  showSlide(currentSlide);

  document.addEventListener("keydown", handleKey);
}

export function stopPresentation() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  document.removeEventListener("keydown", handleKey);
  slides = [];
}

function createOverlay() {
  overlay = document.createElement("div");
  overlay.className = "presentation-overlay";

  const slideContainer = document.createElement("div");
  slideContainer.className = "presentation-slide";
  overlay.appendChild(slideContainer);

  const counter = document.createElement("div");
  counter.className = "presentation-counter";
  overlay.appendChild(counter);

  // Click to advance (right half) or go back (left half)
  overlay.addEventListener("click", (e) => {
    const x = e.clientX;
    if (x > window.innerWidth / 2) {
      navigate(1);
    } else {
      navigate(-1);
    }
  });

  document.body.appendChild(overlay);
}

function handleKey(e: KeyboardEvent) {
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      stopPresentation();
      break;
    case "ArrowRight":
    case "ArrowDown":
    case " ":
      e.preventDefault();
      navigate(1);
      break;
    case "ArrowLeft":
    case "ArrowUp":
      e.preventDefault();
      navigate(-1);
      break;
    case "Home":
      e.preventDefault();
      currentSlide = 0;
      showSlide(currentSlide);
      break;
    case "End":
      e.preventDefault();
      currentSlide = slides.length - 1;
      showSlide(currentSlide);
      break;
  }
}

function navigate(dir: number) {
  const next = currentSlide + dir;
  if (next >= 0 && next < slides.length) {
    currentSlide = next;
    showSlide(currentSlide);
  }
}

function showSlide(index: number) {
  if (!overlay) return;

  const slideEl = overlay.querySelector<HTMLElement>(".presentation-slide")!;
  const counterEl = overlay.querySelector(".presentation-counter")!;

  void renderSlide(slideEl, slides[index]);
  counterEl.textContent = `${index + 1} / ${slides.length}`;
}
