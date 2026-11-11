import { expect, test } from "vite-plus/test";
import { blankFrontmatter } from "./document-structure.ts";

test("blankFrontmatter hides the block and keeps line numbers", () => {
  const source = "---\ntitle: X\n---\n\n# Head\nbody";
  const out = blankFrontmatter(source);
  expect(out).toBe("\n\n\n\n# Head\nbody");
  expect(out.split("\n")).toHaveLength(source.split("\n").length);
});

test("blankFrontmatter leaves documents without frontmatter alone", () => {
  expect(blankFrontmatter("# Head\n---\ntext")).toBe("# Head\n---\ntext");
  expect(blankFrontmatter("---\nno closing rule")).toBe("---\nno closing rule");
});
