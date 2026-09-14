import { expect, test, vi } from "vite-plus/test";

vi.stubGlobal("window", { __TAURI__: { core: { invoke: vi.fn() } } });

const { buildDocument, parseDocument, COMMENTS_MARKER } = await import("./github.ts");

const detail = {
  number: 42,
  title: "Fix: the thing, quickly",
  state: "OPEN",
  updated_at: "2026-09-01T10:00:00Z",
  author: { login: "octocat" },
  labels: [{ name: "bug", color: "d73a4a" }],
  url: "https://github.com/o/r/issues/42",
  is_draft: false,
  body: "## Summary\n\nSomething is broken.\n\n- [ ] fix it\n",
  comments: [
    { author: { login: "alice" }, body: "Any update?", created_at: "2026-09-02T09:30:00Z" },
  ],
};

test("round trips title and body without touching comments", () => {
  const doc = buildDocument(detail);
  expect(doc).toContain(COMMENTS_MARKER);
  expect(doc).toContain("Any update?");

  const parsed = parseDocument(doc, "fallback");
  expect(parsed.title).toBe("Fix: the thing, quickly");
  expect(parsed.body).toBe(detail.body.trim());
});

test("keeps edits and drops the comment log", () => {
  const edited = buildDocument(detail)
    .replace("title: Fix: the thing, quickly", "title: Renamed")
    .replace("Something is broken.", "Something is very broken.");
  const parsed = parseDocument(edited, "fallback");
  expect(parsed.title).toBe("Renamed");
  expect(parsed.body).toContain("Something is very broken.");
  expect(parsed.body).not.toContain("Any update?");
});

test("falls back when the frontmatter is deleted", () => {
  const parsed = parseDocument("just a body\n", "Original Title");
  expect(parsed.title).toBe("Original Title");
  expect(parsed.body).toBe("just a body");
});

test("handles an item with no comments", () => {
  const doc = buildDocument({ ...detail, comments: [] });
  expect(doc).not.toContain(COMMENTS_MARKER);
  expect(parseDocument(doc, "x").body).toBe(detail.body.trim());
});
