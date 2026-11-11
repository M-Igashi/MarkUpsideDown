// Reading and editor appearance (Settings > Appearance), shared by all windows.

import { KEY_APPEARANCE } from "./storage-keys.ts";

export type ReadingFont = "sans" | "serif";
export type ReadingSize = "small" | "medium" | "large";

export interface Appearance {
  font: ReadingFont;
  size: ReadingSize;
  lineNumbers: boolean;
}

const DEFAULTS: Appearance = { font: "sans", size: "medium", lineNumbers: false };
const SIZES: Record<ReadingSize, string> = { small: "16px", medium: "18px", large: "20px" };
const CHANGE_EVENT = "appearance-change";

export function getAppearance(): Appearance {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY_APPEARANCE) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setAppearance(change: Partial<Appearance>) {
  localStorage.setItem(KEY_APPEARANCE, JSON.stringify({ ...getAppearance(), ...change }));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function applyReadingStyle({ font, size }: Appearance) {
  const root = document.documentElement.style;
  root.setProperty("--reading-font", font === "serif" ? "var(--font-serif)" : "var(--font-sans)");
  root.setProperty("--reading-size", SIZES[size] ?? SIZES.medium);
}

/** Apply the stored appearance now and whenever it changes in any window. */
export function watchAppearance(onChange: (appearance: Appearance) => void) {
  const apply = () => {
    const appearance = getAppearance();
    applyReadingStyle(appearance);
    onChange(appearance);
  };
  window.addEventListener(CHANGE_EVENT, apply);
  // Other windows write the same localStorage key
  window.addEventListener("storage", (e) => {
    if (e.key === KEY_APPEARANCE) apply();
  });
  apply();
}
