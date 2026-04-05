# Advanced Editing

Beyond basic Markdown editing, MarkUpsideDown includes several features that make working with structured content easier.

## Table Editor

The table editor provides a spreadsheet-like interface for creating and editing Markdown tables.

### Opening the Table Editor

- Click the **Table** button in the toolbar
- Or open the Command Palette (Cmd+K) and search for "Table"

If your cursor is inside an existing Markdown table, the table editor opens with that table's data. Otherwise, it creates a new empty table.

![Table editor with spreadsheet-like interface](images/editing-features/table-editor.png)

### Editing

- **Tab** — move to the next cell (creates a new row when at the last cell)
- **Shift+Tab** — move to the previous cell
- **Enter** — move to the cell below (creates a new row at the bottom)
- **Arrow Up/Down** — navigate between rows

### Toolbar

| Button | Action |
|--------|--------|
| + Row | Add a row at the bottom |
| + Column | Add a column to the right |
| - Row | Remove the last row |
| - Column | Remove the last column |
| Alignment | Set column alignment (Left / Center / Right) |

### Paste Support

Paste TSV or CSV data from a spreadsheet to populate multiple cells at once.

### Undo/Redo

- **Cmd+Z** to undo
- **Cmd+Shift+Z** or **Cmd+Y** to redo

## Image Paste

Paste an image from your clipboard or drag and drop an image file onto the editor. The image is saved to `./assets/` relative to the current file, and a Markdown image link is inserted:

```markdown
![](assets/pasted-image-20260403.png)
```

## Auto Link Title

When you paste a URL into the editor, MarkUpsideDown automatically fetches the page title and formats it as a Markdown link:

```
Before: https://example.com/article
After:  [Article Title](https://example.com/article)
```

This works for most web pages and saves you from manually copying titles.

## Link Context Menu

Right-click any link in the preview pane to see a context menu with:

- **Fetch** — convert the linked page to Markdown (static)
- **Render** — convert using Browser Rendering (JavaScript-heavy pages)
- **Crawl** — start a website crawl from that URL

## Smart Typography

When enabled (Settings → Editor → Smart typography), the editor automatically converts common character sequences as you type:

| You type | Result | Character |
|----------|--------|-----------|
| `...` | … | Ellipsis |
| `--` | – | En dash |
| `---` | — | Em dash |

These replacements only apply outside code blocks and inline code.

## Document Cleanup

Click the **Cleanup** button in the toolbar to normalize the current document. This fixes:

- Heading hierarchy
- Table formatting
- List markers
- Whitespace issues
- CJK emphasis spacing (adds spaces around emphasis markers adjacent to CJK characters)

## Frontmatter Panel

If your Markdown file has YAML frontmatter, a collapsible **Frontmatter** panel appears above the editor. It shows key-value pairs in a readable format. Click any row to jump the editor cursor to the frontmatter block.

If the YAML is invalid, an "Invalid YAML" warning badge appears.

![Frontmatter panel showing YAML key-value pairs](images/editing-features/frontmatter-panel.png)

## Table of Contents Panel

Press **Cmd+4** to toggle the Table of Contents panel above the preview. It lists all headings in the document, indented by level. The currently visible heading is highlighted.

Click any heading to scroll the editor to that position.

The panel is hidden when the document has no headings.

![Table of Contents panel with heading tree](images/editing-features/toc-panel.png)

## Note Refactor

Select text in the editor and use the "Extract to new file" command (via Command Palette). The selected text is moved to a new Markdown file, and a link to the new file is inserted in its place. This is useful for breaking long documents into smaller, linked notes.

## TODO Autocomplete

When you're writing a list and type `- [ ] ` to create a checkbox item, pressing Enter automatically continues with another checkbox prefix on the next line.

## Download External Images

The "Download images" command (via Command Palette) scans the current document for external image URLs, downloads them to `./assets/`, and updates the Markdown links to point to the local copies.

## Markdown Linting

When enabled (Settings → Editor → Markdown linting), the editor highlights structural issues in the gutter. The linter checks 11 rules including heading hierarchy, broken links, table formatting, emphasis flanking, and more.
