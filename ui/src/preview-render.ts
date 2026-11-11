import { marked, type Token } from "marked";
import DOMPurify from "dompurify";
import { Idiomorph } from "idiomorph";
import { refreshPreviewSearch } from "./preview-search.ts";
import {
  scrollState,
  buildScrollAnchors,
  markProgrammaticScroll,
  syncPreviewToCursor,
} from "./scroll-sync.ts";
import { escapeHtml, copySvgAsPng } from "./html-utils.ts";
import { open as openMermaidViewer } from "./mermaid-viewer.ts";
import { dirname } from "./path-utils.ts";
import { blankFrontmatter } from "./document-structure.ts";

const { invoke, convertFileSrc } = window.__TAURI__.core;

// --- Local image path resolution ---

let getFilePath: (() => string | null) | null = null;

export function setFilePathGetter(getter: () => string | null) {
  getFilePath = getter;
}

function resolveLocalImageSrc(href: string): string {
  if (!href) return href;
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("data:")) {
    return href;
  }
  let absolute: string;
  if (href.startsWith("/")) {
    absolute = href;
  } else {
    const filePath = getFilePath?.();
    if (!filePath) return href;
    const base = dirname(filePath);
    if (!base) return href;
    try {
      const resolved = new URL(href, `file://${base}/`);
      absolute = decodeURIComponent(resolved.pathname);
    } catch {
      return href;
    }
  }
  return convertFileSrc(absolute);
}

// --- Lazy-loaded modules ---

let hljsModule: any = null;

const HLJS_LANGUAGES: [string, () => Promise<any>][] = [
  ["bash", () => import("highlight.js/lib/languages/bash")],
  ["c", () => import("highlight.js/lib/languages/c")],
  ["cpp", () => import("highlight.js/lib/languages/cpp")],
  ["csharp", () => import("highlight.js/lib/languages/csharp")],
  ["css", () => import("highlight.js/lib/languages/css")],
  ["diff", () => import("highlight.js/lib/languages/diff")],
  ["go", () => import("highlight.js/lib/languages/go")],
  ["graphql", () => import("highlight.js/lib/languages/graphql")],
  ["ini", () => import("highlight.js/lib/languages/ini")],
  ["java", () => import("highlight.js/lib/languages/java")],
  ["javascript", () => import("highlight.js/lib/languages/javascript")],
  ["json", () => import("highlight.js/lib/languages/json")],
  ["kotlin", () => import("highlight.js/lib/languages/kotlin")],
  ["markdown", () => import("highlight.js/lib/languages/markdown")],
  ["perl", () => import("highlight.js/lib/languages/perl")],
  ["python", () => import("highlight.js/lib/languages/python")],
  ["ruby", () => import("highlight.js/lib/languages/ruby")],
  ["rust", () => import("highlight.js/lib/languages/rust")],
  ["shell", () => import("highlight.js/lib/languages/shell")],
  ["sql", () => import("highlight.js/lib/languages/sql")],
  ["swift", () => import("highlight.js/lib/languages/swift")],
  ["typescript", () => import("highlight.js/lib/languages/typescript")],
  ["xml", () => import("highlight.js/lib/languages/xml")],
  ["yaml", () => import("highlight.js/lib/languages/yaml")],
];

async function getHljs() {
  if (hljsModule) return hljsModule;
  const { default: hljs } = await import("highlight.js/lib/core");
  const loaded = await Promise.all(HLJS_LANGUAGES.map(([, fn]) => fn()));
  HLJS_LANGUAGES.forEach(([name], i) => hljs.registerLanguage(name, loaded[i].default));
  hljsModule = hljs;
  return hljs;
}

let katexModule: any = null;

async function getKaTeX() {
  if (katexModule) return katexModule;
  const { default: katex } = await import("katex");
  katexModule = katex;
  return katex;
}

let mermaidModule: any = null;

export async function getMermaid() {
  if (mermaidModule) return mermaidModule;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
    themeVariables: {
      primaryColor: "#dce4f0",
      primaryTextColor: "#2c2c2c",
      primaryBorderColor: "#4a7ab5",
      lineColor: "#8a8578",
      secondaryColor: "#eee8e0",
      tertiaryColor: "#f5f1eb",
      background: "#faf7f2",
      mainBkg: "#dce4f0",
      nodeBorder: "#4a7ab5",
      clusterBkg: "#f5f1eb",
      titleColor: "#2c2c2c",
      edgeLabelBackground: "#faf7f2",
    },
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  });
  mermaidModule = mermaid;
  return mermaid;
}

// --- KaTeX math extension for marked ---

const mathExtension = {
  extensions: [
    {
      name: "mathBlock",
      level: "block" as const,
      start(src: string) {
        return src.indexOf("$$");
      },
      tokenizer(src: string) {
        const match = src.match(/^\$\$([\s\S]+?)\$\$/);
        if (match) {
          return { type: "mathBlock", raw: match[0], text: match[1].trim() };
        }
      },
      renderer(token: { text: string }) {
        return `<div class="math-block" data-math-source="${encodeURIComponent(token.text)}" data-math-display="true"></div>`;
      },
    },
    {
      name: "mathInline",
      level: "inline" as const,
      start(src: string) {
        return src.indexOf("$");
      },
      tokenizer(src: string) {
        // (?!\d) prevents matching currency like $0.01
        const match = src.match(/^\$(?!\d)([^\s$](?:[^$\n]*[^\s$])?)\$/);
        if (match) {
          return { type: "mathInline", raw: match[0], text: match[1] };
        }
      },
      renderer(token: { text: string }) {
        return `<span data-math-source="${encodeURIComponent(token.text)}" data-math-display="false"></span>`;
      },
    },
  ],
};

// --- Figure caption extension for marked ---
// ![alt](url) followed immediately by *caption* → <figure> + <figcaption>

const figureExtension = {
  extensions: [
    {
      name: "figureBlock",
      level: "block" as const,
      start(src: string) {
        return src.match(/^!\[/)?.index;
      },
      tokenizer(src: string) {
        const match = src.match(/^!\[([^\]]*)\]\(([^)]+)\)\n\*([^*\n]+)\*(?:\n|$)/);
        if (match) {
          return {
            type: "figureBlock",
            raw: match[0],
            alt: match[1],
            src: match[2],
            caption: match[3],
          };
        }
      },
      renderer(token: { alt: string; src: string; caption: string }) {
        const altAttr = escapeHtml(token.alt);
        const srcAttr = escapeHtml(resolveLocalImageSrc(token.src));
        const captionHtml = escapeHtml(token.caption);
        return `<figure><img src="${srcAttr}" alt="${altAttr}" loading="lazy"><figcaption>${captionHtml}</figcaption></figure>\n`;
      },
    },
  ],
};

marked.use(mathExtension);
marked.use(figureExtension);

// --- CJK emphasis fix ---
// Insert hair spaces (U+200A) at CJK boundaries so emphasis delimiters
// pass CommonMark flanking checks without visible layout impact.

import { fixCjkEmphasisWith } from "./cjk-emphasis.ts";

function fixCjkEmphasis(source: string): string {
  return fixCjkEmphasisWith(source, "\u200A");
}

// --- Source line annotation helpers ---

function countNewlines(str: string, from: number, to: number) {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (str.charCodeAt(i) === 10) n++;
  }
  return n;
}

function annotateTokensWithSourceLines(tokens: any[]) {
  let lineNum = 1;
  for (const token of tokens) {
    if (!token.raw) continue;
    if (token.type === "space") {
      lineNum += countNewlines(token.raw, 0, token.raw.length);
      continue;
    }
    token._sourceLine = lineNum;
    if (token.type === "list" && token.items) {
      let itemLine = lineNum;
      for (const item of token.items) {
        item._sourceLine = itemLine;
        itemLine += countNewlines(item.raw, 0, item.raw.length);
      }
    }
    lineNum += countNewlines(token.raw, 0, token.raw.length);
  }
}

function slAttr(sourceLine: number | undefined) {
  return sourceLine ? ` data-source-line="${sourceLine}"` : "";
}

// --- GFM alert types (hoisted for hot-path reuse) ---

const ALERT_LABELS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

// --- Shared renderer ---

// Register custom renderer via marked.use() so extension token renderers
// (mathInline, mathBlock, figureBlock) remain accessible during parsing.
// Previously, passing a Renderer instance to marked.parser() would shadow
// extension renderers, causing "Token with 'mathInline' type was not found"
// errors on documents containing dollar signs (e.g. "$0.01").
marked.use({
  renderer: {
    code({ text, lang, _sourceLine }: any) {
      const sl = slAttr(_sourceLine);
      let hlLang = lang || "";
      let filename = "";
      const colonIdx = hlLang.indexOf(":");
      if (colonIdx > 0) {
        filename = hlLang.slice(colonIdx + 1);
        hlLang = hlLang.slice(0, colonIdx);
      }
      if (hlLang === "mermaid") {
        return `<div${sl} class="mermaid-container" data-mermaid-source="${encodeURIComponent(text)}"></div>`;
      }
      const escaped = escapeHtml(text);
      const langAttr = hlLang ? ` data-hljs-lang="${escapeHtml(hlLang)}"` : "";
      const filenameEl = filename ? `<div class="code-filename">${escapeHtml(filename)}</div>` : "";
      return `${filenameEl}<pre${sl}><code class="hljs"${langAttr}>${escaped}</code></pre>`;
    },
    heading(this: any, { tokens, depth, _sourceLine }: any) {
      return `<h${depth}${slAttr(_sourceLine)}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    paragraph(this: any, { tokens, _sourceLine }: any) {
      return `<p${slAttr(_sourceLine)}>${this.parser.parseInline(tokens)}</p>\n`;
    },
    blockquote(this: any, { tokens, _sourceLine }: any) {
      const first = tokens[0];
      if (first?.type === "paragraph" && first.tokens?.length > 0) {
        const text = first.tokens[0]?.text as string | undefined;
        if (text) {
          const m = text.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/);
          if (m) {
            const type = m[1] as string;
            const label = ALERT_LABELS[type]!;
            const clone = tokens.map((t: any, i: number) => (i === 0 ? structuredClone(t) : t));
            const firstClone = clone[0];
            firstClone.tokens[0] = {
              ...firstClone.tokens[0],
              raw: firstClone.tokens[0].raw.slice(m[0].length),
              text: firstClone.tokens[0].text.slice(m[0].length),
            };
            if (!firstClone.tokens[0].text && firstClone.tokens.length > 1) {
              const next = firstClone.tokens[1];
              if (next?.type === "br" || (next?.type === "text" && next.text === "\n")) {
                firstClone.tokens.splice(0, 2);
              } else {
                firstClone.tokens.splice(0, 1);
              }
            }
            firstClone.raw = firstClone.tokens.map((t: any) => t.raw).join("");
            firstClone.text = firstClone.tokens.map((t: any) => t.text ?? t.raw).join("");
            const body = this.parser.parse(clone);
            const typeLower = type.toLowerCase();
            return `<blockquote class="gfm-alert gfm-alert-${typeLower}"${slAttr(_sourceLine)}>\n<p class="gfm-alert-title"><span class="gfm-alert-icon" aria-hidden="true"></span>${label}</p>\n${body}</blockquote>\n`;
          }
        }
      }
      return `<blockquote${slAttr(_sourceLine)}>\n${this.parser.parse(tokens)}</blockquote>\n`;
    },
    list(this: any, { items, ordered, start, _sourceLine }: any) {
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      const body = items.map((item: any) => this.listitem(item)).join("");
      return `<${tag}${startAttr}${slAttr(_sourceLine)}>\n${body}</${tag}>\n`;
    },
    listitem(this: any, { tokens, _sourceLine }: any) {
      return `<li${slAttr(_sourceLine)}>${this.parser.parse(tokens)}</li>\n`;
    },
    table(this: any, { header, rows, _sourceLine }: any) {
      const headerRow = `<tr>${header.map((h: any) => `<th${h.align ? ` align="${h.align}"` : ""}>${this.parser.parseInline(h.tokens)}</th>`).join("")}</tr>`;
      const bodyRows = rows
        .map(
          (row: any) =>
            `<tr>${row.map((c: any) => `<td${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`,
        )
        .join("\n");
      const tbody = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
      return `<div class="table-wrapper"${slAttr(_sourceLine)}><table><thead>${headerRow}</thead>${tbody}</table></div>\n`;
    },
    hr({ _sourceLine }: any) {
      return `<hr${slAttr(_sourceLine)}>\n`;
    },
    html({ text, _sourceLine }: any) {
      return _sourceLine ? text.replace(/^<(\w+)/, `<$1${slAttr(_sourceLine)}`) : text;
    },
    image({ href, title, text }: any) {
      const resolved = resolveLocalImageSrc(href ?? "");
      const srcAttr = escapeHtml(resolved);
      const altAttr = escapeHtml(text ?? "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${srcAttr}" alt="${altAttr}"${titleAttr}>`;
    },
  },
});

// --- Remote SVG images ---

// WebKit fails to load many remote SVG <img> sources, so they are fetched
// through the backend. The result is shown through a data: URL in an <img>,
// never inserted as markup: SVG used as an image cannot run scripts, load
// other resources, or apply its <style> to the app.

const SVG_CACHE_MAX = 50;
const svgCache = new Map<string, string>(); // remote URL -> data: URL
// Wrappers created here; a document's own class="inline-svg" must not be kept
const svgWrappers = new WeakSet<HTMLElement>();

async function inlineSvgImages(container: HTMLElement) {
  const imgs = container.querySelectorAll('img[src$=".svg"]');
  if (imgs.length === 0) return false;
  let changed = false;
  const tasks = Array.from(imgs).map(async (img) => {
    const url = (img as HTMLImageElement).src;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;
    if (url.startsWith("https://asset.localhost/") || url.startsWith("http://asset.localhost/"))
      return;

    try {
      let dataUrl = svgCache.get(url);
      if (dataUrl) {
        // Move to end for LRU eviction
        svgCache.delete(url);
      } else {
        const svgText = await invoke<string>("fetch_svg", { url });
        dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
        if (svgCache.size >= SVG_CACHE_MAX) {
          svgCache.delete(svgCache.keys().next().value!);
        }
      }
      svgCache.set(url, dataUrl);

      const wrapper = document.createElement("span");
      wrapper.className = "inline-svg";
      svgWrappers.add(wrapper);
      const svgImg = document.createElement("img");
      svgImg.src = dataUrl;
      svgImg.alt = (img as HTMLImageElement).alt;
      if ((img as HTMLImageElement).title) svgImg.title = (img as HTMLImageElement).title;
      svgImg.loading = "lazy";
      svgImg.decoding = "async";
      wrapper.appendChild(svgImg);

      img.replaceWith(wrapper);
      changed = true;
    } catch {
      // Leave as <img> on failure
    }
  });
  await Promise.all(tasks);
  return changed;
}

// --- Preview rendering ---

// Copy buttons the app added (a document can contain its own
// class="code-copy-btn" elements, which must not survive re-renders)
const copyButtons = new WeakSet<HTMLElement>();

// Never reset: mermaid.render() removes any existing element with the same id
let mermaidRenderCount = 0;

const PURIFY_CONFIG = {
  // Allow Tauri's `asset:` scheme so local images survive sanitization
  // (convertFileSrc returns asset://localhost/... on macOS/Linux). Mirrors
  // DOMPurify's default ALLOWED_URI_REGEXP with `asset` added to the allowlist.
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ADD_TAGS: ["foreignObject"],
  // <style> restyles the whole app, and form controls can submit or
  // impersonate app buttons. Task-list checkboxes (<input>) stay allowed.
  FORBID_TAGS: ["style", "form", "button", "textarea", "select"],
  ADD_ATTR: [
    "data-mermaid-source",
    "data-source-line",
    "data-math-source",
    "data-math-display",
    "data-math-rendered",
    "data-hljs-lang",
    "data-hljs-rendered",
  ],
};

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/** Split Markdown into slides at top-level horizontal rules, as sanitized HTML. */
export function markdownToSlides(source: string): string[] {
  const slides: Token[][] = [[]];
  for (const token of marked.lexer(fixCjkEmphasis(source))) {
    if (token.type === "hr") slides.push([]);
    else slides[slides.length - 1].push(token);
  }
  return slides
    .filter((tokens) => tokens.some((t) => t.type !== "space"))
    .map((tokens) => sanitize(marked.parser(tokens)));
}

/** Render a slide produced by markdownToSlides into `container`. */
export function renderSlide(container: HTMLElement, html: string) {
  container.innerHTML = `<article class="preview-page presentation-content">${html}</article>`;
  return enhanceRendered(container, false);
}

let previewPane: HTMLElement;

export function initPreview(pp: HTMLElement) {
  previewPane = pp;
}

export async function renderPreview(source: string) {
  scrollState.renderingPreview = true;
  cancelAnimationFrame(scrollState.syncRAF);

  const savedScrollTop = previewPane.scrollTop;
  const savedActiveSide = scrollState.activeSide;

  const tokens = marked.lexer(fixCjkEmphasis(blankFrontmatter(source)));
  annotateTokensWithSourceLines(tokens);

  const html = marked.parser(tokens);

  const sanitizedHtml = sanitize(`<article class="preview-page" lang="en">${html}</article>`);

  // Mark programmatic scroll BEFORE morph — morphing adds/removes DOM nodes
  // which can trigger scroll events on previewPane. Without this mark, those
  // events would be treated as user scrolls and corrupt activeSide/schedule syncs.
  markProgrammaticScroll();

  Idiomorph.morph(previewPane, sanitizedHtml, {
    morphStyle: "innerHTML",
    callbacks: {
      beforeNodeMorphed(oldNode: Node, newNode: Node) {
        if (!(oldNode instanceof HTMLElement) || !(newNode instanceof HTMLElement)) return true;
        // Preserve already-rendered Mermaid containers if source unchanged
        if (
          oldNode.classList.contains("mermaid-rendered") &&
          oldNode.dataset.mermaidSource === newNode.dataset.mermaidSource
        ) {
          return false;
        }
        // Preserve already-rendered KaTeX if source unchanged
        if (
          oldNode.dataset.mathRendered &&
          oldNode.dataset.mathSource === newNode.dataset.mathSource
        ) {
          return false;
        }
        // Preserve already-highlighted code blocks if source unchanged
        if (
          oldNode.dataset.hljsRendered &&
          oldNode.tagName === "CODE" &&
          oldNode.dataset.hljsLang === newNode.dataset.hljsLang &&
          oldNode.textContent === newNode.textContent
        ) {
          return false;
        }
        // Preserve inlined SVGs
        if (svgWrappers.has(oldNode)) {
          return false;
        }
        // Keep the copy-btn marker so the post-render pass skips already-done PREs
        if (oldNode.tagName === "PRE" && oldNode.dataset.copyBtn) {
          newNode.dataset.copyBtn = "true";
        }
        return true;
      },
      beforeNodeRemoved(node: Node) {
        // Copy buttons are added post-render and absent from the new HTML —
        // keep them instead of recreating button + listener on every render
        return !(node instanceof HTMLElement && copyButtons.has(node));
      },
    },
  });

  await enhanceRendered(previewPane, true);

  // Restore scroll position — mark as programmatic so scroll event handlers
  // don't treat the morph-triggered scrollTop change as a user scroll
  markProgrammaticScroll();
  previewPane.scrollTop = savedScrollTop;

  // Cancel any sync RAFs that morph-triggered scroll events may have scheduled
  cancelAnimationFrame(scrollState.syncRAF);
  scrollState.activeSide = savedActiveSide;

  buildScrollAnchors();
  scrollState.pendingRender = false;
  scrollState.renderingPreview = false;

  if (scrollState.activeSide === "editor") {
    markProgrammaticScroll();
    syncPreviewToCursor();
  }

  refreshPreviewSearch();

  inlineSvgImages(previewPane)
    .then((changed) => {
      if (changed) buildScrollAnchors();
    })
    .catch(() => {});
}

// Highlighting, Mermaid, and KaTeX for rendered Markdown. `interactive` adds
// the preview's copy buttons and click-to-expand on diagrams.
async function enhanceRendered(root: HTMLElement, interactive: boolean) {
  // Single DOM pass: collect all elements needing post-render processing
  const postRenderEls = root.querySelectorAll(
    ".preview-page img:not([loading]), code[data-hljs-lang]:not([data-hljs-rendered]), pre:not([data-copy-btn]), .mermaid-container:not(.mermaid-rendered), [data-math-source]:not([data-math-rendered])",
  );
  const imgs: HTMLImageElement[] = [];
  const codeEls: HTMLElement[] = [];
  const preEls: HTMLElement[] = [];
  const mermaidEls: HTMLElement[] = [];
  const mathEls: HTMLElement[] = [];
  for (const el of postRenderEls) {
    const he = el as HTMLElement;
    if (el.tagName === "IMG" && !el.hasAttribute("loading")) {
      imgs.push(el as HTMLImageElement);
    } else if (el.tagName === "CODE" && he.dataset.hljsLang && !he.dataset.hljsRendered) {
      codeEls.push(he);
    } else if (interactive && el.tagName === "PRE" && !he.dataset.copyBtn) {
      preEls.push(he);
    } else if (
      he.classList.contains("mermaid-container") &&
      !he.classList.contains("mermaid-rendered")
    ) {
      mermaidEls.push(he);
    } else if (he.dataset.mathSource && !he.dataset.mathRendered) {
      mathEls.push(he);
    }
  }

  for (const img of imgs) {
    img.loading = "lazy";
    img.decoding = "async";
  }

  if (codeEls.length > 0) {
    try {
      const hljs = await getHljs();
      for (const el of codeEls) {
        const lang = el.dataset.hljsLang!;
        if (hljs.getLanguage(lang)) {
          el.innerHTML = hljs.highlight(el.textContent!, { language: lang }).value;
          el.classList.add(`language-${lang}`);
          el.dataset.hljsRendered = "true";
        }
      }
    } catch (err) {
      console.error("highlight.js failed to load:", err);
    }
  }

  // Add copy buttons to code blocks
  for (const pre of preEls) {
    pre.dataset.copyBtn = "true";
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";
    copyButtons.add(btn);
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const text = code ? code.textContent! : pre.textContent!;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1500);
      });
    });
    pre.appendChild(btn);
  }

  if (mermaidEls.length > 0) {
    try {
      const mermaid = await getMermaid();
      await Promise.all(
        mermaidEls.map(async (el) => {
          const src = decodeURIComponent(el.dataset.mermaidSource!);
          const id = `mmd-${mermaidRenderCount++}`;
          try {
            const { svg } = await mermaid.render(id, src);
            el.innerHTML = svg;
            el.classList.add("mermaid-rendered");
            if (!interactive) return;
            const copyBtn = document.createElement("button");
            copyBtn.className = "mermaid-copy-btn";
            copyBtn.textContent = "Copy as PNG";
            copyBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              copyMermaidAsPng(el, copyBtn);
            });
            el.appendChild(copyBtn);
            const expandHint = document.createElement("span");
            expandHint.className = "mermaid-expand-hint";
            expandHint.textContent = "Click to expand";
            el.appendChild(expandHint);
            el.style.cursor = "pointer";
            // Property, not addEventListener: Idiomorph reuses this element when the
            // diagram source changes, and listeners would pile up across renders.
            el.onclick = () => openMermaidViewer(el);
          } catch (err) {
            const pre = document.createElement("pre");
            pre.className = "mermaid-error";
            pre.textContent = (err as Error).message || String(err);
            el.replaceChildren(pre);
            document.getElementById(id)?.remove();
          }
        }),
      );
    } catch (err) {
      console.error("Mermaid failed to load:", err);
    }
  }

  if (mathEls.length > 0) {
    try {
      const katex = await getKaTeX();
      for (const el of mathEls) {
        const src = decodeURIComponent(el.dataset.mathSource!);
        const display = el.dataset.mathDisplay === "true";
        try {
          el.innerHTML = katex.renderToString(src, { displayMode: display, throwOnError: false });
          el.dataset.mathRendered = "true";
        } catch {
          el.innerHTML = `<code class="math-error">${escapeHtml(src)}</code>`;
          el.dataset.mathRendered = "true";
        }
      }
    } catch (err) {
      console.error("KaTeX failed to load:", err);
    }
  }
}

function copyMermaidAsPng(container: HTMLElement, btn: HTMLButtonElement) {
  const svg = container.querySelector("svg");
  if (!svg) return;
  copySvgAsPng(svg, btn);
}
