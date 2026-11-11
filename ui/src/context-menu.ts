// Shared popup menu used by the sidebar and the preview link menu.

import { clampToViewport } from "./html-utils.ts";

/** A menu entry; `null` renders a separator. */
export type MenuItem = {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  shortcut?: string;
} | null;

let activeMenu: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;
let closeHandler: ((e: Event) => void) | null = null;

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
  }
}

export function closeContextMenu() {
  if (closeHandler) {
    document.removeEventListener("click", closeHandler, true);
    closeHandler = null;
  }
  document.removeEventListener("keydown", onKeyDown, true);
  activeAnchor?.setAttribute("aria-expanded", "false");
  activeAnchor = null;
  activeMenu?.remove();
  activeMenu = null;
}

/** Toggle a menu below `anchor` (a toolbar button); a second click closes it. */
export function showDropdown(anchor: HTMLElement, items: MenuItem[]) {
  if (activeAnchor === anchor) {
    closeContextMenu();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 4, items, "dropdown");
  activeAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
}

/**
 * Show a menu at (x, y), kept inside the viewport, closed by an outside click.
 * `prefix` names the menu (`${prefix}-menu`) for menu-specific styling.
 */
export function showContextMenu(
  x: number,
  y: number,
  items: MenuItem[],
  prefix = "sidebar-context",
) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = `menu ${prefix}-menu`;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const item of items) {
    if (!item) {
      const sep = document.createElement("div");
      sep.className = "menu-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "menu-item";
    if (item.danger) btn.classList.add("danger");
    btn.textContent = item.label;
    if (item.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "menu-shortcut";
      kbd.textContent = item.shortcut;
      btn.appendChild(kbd);
    }
    btn.disabled = !!item.disabled;
    if (item.title) btn.title = item.title;
    btn.addEventListener("click", () => {
      closeContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  activeMenu = menu;
  clampToViewport(menu);

  const handler = (e: Event) => {
    const target = e.target as Node;
    // Clicks on the anchor are left to showDropdown, which toggles the menu
    if (!menu.contains(target) && !activeAnchor?.contains(target)) closeContextMenu();
  };
  closeHandler = handler;
  document.addEventListener("keydown", onKeyDown, true);
  // Defer so the click that opened the menu does not close it.
  setTimeout(() => {
    if (closeHandler === handler) document.addEventListener("click", handler, true);
  }, 0);
}
