/** Extract the lowercase file extension from a path or filename (without the dot). */
export function getExtension(path: string): string {
  return path.split(".").pop()?.toLowerCase() || "";
}

export const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);

export const MD_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/** File extensions that should be opened with the system default app instead of the editor. */
export const SYSTEM_OPEN_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "zip",
  "tar",
  "gz",
  "dmg",
  "mp3",
  "mp4",
  "mov",
  "avi",
  "wav",
  ...IMAGE_EXTENSIONS,
]);

/** Extract the filename from a path (everything after the last `/`). */
export function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** Extract the directory portion of a path (everything before the last `/`). */
export function dirname(path: string): string {
  return path.substring(0, path.lastIndexOf("/"));
}

/** Resolve a relative path (`../a/b.md`, `./b.md`, `b.md`) against a file's directory. */
export function resolveRelativePath(fromFile: string, relative: string): string {
  const parts = dirname(fromFile).split("/");
  for (const seg of relative.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/** Get the assets directory for a given file path. */
export function getAssetsDir(filePath: string): string {
  return `${dirname(filePath)}/assets`;
}

/** Sanitize a string for use as a filename (keep only alphanumeric, dot, hyphen, underscore). */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Path relative to the project root, or the path itself if outside the root. */
export function relativeToRoot(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Compute a relative path from one file to another. */
export function buildRelativePath(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile);
  const toDir = dirname(toFile);
  const toName = basename(toFile);

  if (fromDir === toDir) {
    return `./${toName}`;
  }

  const fromParts = fromDir.split("/");
  const toParts = toDir.split("/");

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const downs = toParts.slice(common);

  return [...Array(ups).fill(".."), ...downs, toName].join("/");
}
