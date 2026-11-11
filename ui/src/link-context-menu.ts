// Context menu for external links in the preview pane.
// Offers: Open in Browser, Get/Fetch/Render as Markdown, Crawl Site.

import { getWorkerUrl } from "./settings.ts";
import { closeContextMenu, showContextMenu } from "./context-menu.ts";

const { invoke } = window.__TAURI__.core;

// URL bar actions from file-ops / crawl; the menu runs them on the clicked link.
type UrlAction = (urlInput: HTMLInputElement, urlBar: HTMLElement) => unknown;

interface LinkMenuDeps {
  getUrl: UrlAction;
  fetchUrl: UrlAction;
  renderUrl: UrlAction;
  crawlUrl: UrlAction;
  urlInput: HTMLInputElement;
  urlBar: HTMLElement;
}

let deps: LinkMenuDeps;

export function initLinkContextMenu(previewPane: HTMLElement, d: LinkMenuDeps) {
  deps = d;

  previewPane.addEventListener("contextmenu", (e) => {
    const anchor = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;

    e.preventDefault();
    showMenu(e.clientX, e.clientY, href);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeContextMenu();
  });
}

function showMenu(x: number, y: number, url: string) {
  const needsWorker = !getWorkerUrl();
  const workerHint = needsWorker ? "Configure Worker URL in Settings" : undefined;
  const run = (action: UrlAction) => () => {
    deps.urlInput.value = url;
    action(deps.urlInput, deps.urlBar);
  };

  showContextMenu(
    x,
    y,
    [
      { label: "Open in Browser", action: () => invoke("plugin:shell|open", { path: url }) },
      { label: "Get as Markdown", action: run(deps.getUrl) },
      null,
      { label: "Fetch as Markdown", action: run(deps.fetchUrl) },
      {
        label: "Render as Markdown",
        action: run(deps.renderUrl),
        disabled: needsWorker,
        title: workerHint,
      },
      { label: "Crawl Site", action: run(deps.crawlUrl), disabled: needsWorker, title: workerHint },
    ],
    "link-context",
  );
}
