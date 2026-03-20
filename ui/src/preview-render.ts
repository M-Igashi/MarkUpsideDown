import { marked } from "marked";
import DOMPurify from "dompurify";
import { Idiomorph } from "idiomorph";
import {
  scrollState,
  buildScrollAnchors,
  markProgrammaticScroll,
  syncPreviewToCursor,
} from "./scroll-sync.ts";
import { escapeHtml } from "./settings.ts";

const { invoke } = window.__TAURI__.core;

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

async function getMermaid() {
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
        const match = src.match(/^\$([^\s$](?:[^$]*[^\s$])?)\$/);
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

marked.use(mathExtension);

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

// --- Shared renderer ---

const previewRenderer = new marked.Renderer() as any;
previewRenderer.code = function ({ text, lang, _sourceLine }: any) {
  const sl = slAttr(_sourceLine);
  if (lang === "mermaid") {
    return `<div${sl} class="mermaid-container" data-mermaid-source="${encodeURIComponent(text)}"></div>`;
  }
  const escaped = escapeHtml(text);
  const langAttr = lang ? ` data-hljs-lang="${lang}"` : "";
  return `<pre${sl}><code class="hljs"${langAttr}>${escaped}</code></pre>`;
};
previewRenderer.heading = function (this: any, { tokens, depth, _sourceLine }: any) {
  return `<h${depth}${slAttr(_sourceLine)}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
};
previewRenderer.paragraph = function (this: any, { tokens, _sourceLine }: any) {
  return `<p${slAttr(_sourceLine)}>${this.parser.parseInline(tokens)}</p>\n`;
};
previewRenderer.blockquote = function (this: any, { tokens, _sourceLine }: any) {
  return `<blockquote${slAttr(_sourceLine)}>\n${this.parser.parse(tokens)}</blockquote>\n`;
};
previewRenderer.list = function (this: any, { items, ordered, start, _sourceLine }: any) {
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
  const body = items.map((item: any) => this.listitem(item)).join("");
  return `<${tag}${startAttr}${slAttr(_sourceLine)}>\n${body}</${tag}>\n`;
};
previewRenderer.listitem = function (this: any, { tokens, _sourceLine }: any) {
  return `<li${slAttr(_sourceLine)}>${this.parser.parse(tokens)}</li>\n`;
};
previewRenderer.table = function (this: any, { header, rows, _sourceLine }: any) {
  const headerRow = `<tr>${header.map((h: any) => `<th${h.align ? ` align="${h.align}"` : ""}>${this.parser.parseInline(h.tokens)}</th>`).join("")}</tr>`;
  const bodyRows = rows
    .map(
      (row: any) =>
        `<tr>${row.map((c: any) => `<td${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`,
    )
    .join("\n");
  const tbody = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
  return `<div class="table-wrapper"${slAttr(_sourceLine)}><table><thead>${headerRow}</thead>${tbody}</table></div>\n`;
};
previewRenderer.hr = function ({ _sourceLine }: any) {
  return `<hr${slAttr(_sourceLine)}>\n`;
};
previewRenderer.html = function ({ text, _sourceLine }: any) {
  return _sourceLine ? text.replace(/^<(\w+)/, `<$1${slAttr(_sourceLine)}`) : text;
};

// --- SVG inlining ---

const SVG_CACHE_MAX = 50;
const svgCache = new Map<string, string>();

export function clearSvgCache() {
  svgCache.clear();
}

async function inlineSvgImages(container: HTMLElement) {
  const imgs = container.querySelectorAll('img[src$=".svg"]');
  if (imgs.length === 0) return false;
  let changed = false;
  const tasks = Array.from(imgs).map(async (img) => {
    const url = (img as HTMLImageElement).src;
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;

    try {
      let svgText: string | undefined;
      if (svgCache.has(url)) {
        svgText = svgCache.get(url);
        // Move to end for LRU eviction
        svgCache.delete(url);
        svgCache.set(url, svgText!);
      } else {
        svgText = await invoke<string>("fetch_svg", { url });
        if (svgCache.size >= SVG_CACHE_MAX) {
          const oldest = svgCache.keys().next().value!;
          svgCache.delete(oldest);
        }
        svgCache.set(url, svgText);
      }

      const wrapper = document.createElement("span");
      wrapper.className = "inline-svg";
      wrapper.innerHTML = svgText!;

      const alt = (img as HTMLImageElement).alt;
      const svgEl = wrapper.querySelector("svg");
      if (svgEl && alt) {
        svgEl.setAttribute("aria-label", alt);
        svgEl.setAttribute("role", "img");
      }

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

let previewPane: HTMLElement;

export function initPreview(pp: HTMLElement) {
  previewPane = pp;
}

export async function renderPreview(source: string) {
  const hasMermaid = /```mermaid\b/.test(source);

  scrollState.renderingPreview = true;
  cancelAnimationFrame(scrollState.syncRAF);

  const savedScrollTop = previewPane.scrollTop;
  const savedActiveSide = scrollState.activeSide;

  let mermaidRenderCount = 0;

  const tokens = marked.lexer(source);
  annotateTokensWithSourceLines(tokens);

  const html = marked.parser(tokens, { renderer: previewRenderer });

  const sanitizedHtml = DOMPurify.sanitize(
    `<article class="preview-page" lang="en">${html}</article>`,
    {
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: [
        "data-mermaid-source",
        "data-source-line",
        "data-math-source",
        "data-math-display",
        "data-math-rendered",
        "data-hljs-lang",
        "data-hljs-rendered",
      ],
    },
  );

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
        if (oldNode.classList.contains("inline-svg")) {
          return false;
        }
        return true;
      },
    },
  });

  // Single DOM pass: collect all elements needing post-render processing
  const postRenderEls = previewPane.querySelectorAll(
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
    } else if (el.tagName === "PRE" && !he.dataset.copyBtn) {
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

  if (hasMermaid && mermaidEls.length > 0) {
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
            const copyBtn = document.createElement("button");
            copyBtn.className = "mermaid-copy-btn";
            copyBtn.textContent = "Copy as PNG";
            copyBtn.addEventListener("click", () => copyMermaidAsPng(el, copyBtn));
            el.appendChild(copyBtn);
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
          el.innerHTML = `<code class="math-error">${src}</code>`;
          el.dataset.mathRendered = "true";
        }
      }
    } catch (err) {
      console.error("KaTeX failed to load:", err);
    }
  }

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

  inlineSvgImages(previewPane)
    .then((changed) => {
      if (changed) buildScrollAnchors();
    })
    .catch(() => {});
}

function copyMermaidAsPng(container: HTMLElement, btn: HTMLButtonElement) {
  const svg = container.querySelector("svg");
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  img.onload = () => {
    const scale = 2; // Retina
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
