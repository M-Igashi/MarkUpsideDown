# Editor Basics

MarkUpsideDown uses a split-pane layout: the editor on the left, the live preview on the right, and an optional sidebar for file browsing. This chapter covers the editor pane and the tools around it.

![Editor pane with syntax highlighting](images/editor-basics/editor-pane.png)

## The Toolbar

The toolbar at the top of the window provides quick access to common actions:

| Button | Action |
|--------|--------|
| **Open** | Open a folder or file |
| **Save** | Save the current file (Cmd+S) |
| **Import** | Import a document (PDF, DOCX, etc.) and convert it to Markdown |
| **Table** | Open the table editor |
| **Cleanup** | Normalize the document (headings, tables, whitespace, CJK emphasis spacing) |
| **Settings** | Open the settings dialog |


## The URL Bar

Below the toolbar is the URL bar. Type or paste a URL, then:

- Click **Get** to fetch the page and convert it to Markdown
- Click **Crawl** to open the crawl dialog for multi-page crawling

See [Importing Content](importing-content.md) and [Crawling Websites](crawling-websites.md) for details.

## Writing Markdown

The editor is built on CodeMirror 6 and provides:

- **Syntax highlighting** for Markdown elements (headings, links, code, etc.)
- **Line numbers** in the gutter
- **Active line highlighting**
- **Search & replace** (Cmd+F)
- **Bracket matching**

### Formatting Shortcuts

Select text and use these shortcuts to apply formatting:

| Shortcut | Result |
|----------|--------|
| Cmd+B | **Bold** (`**text**`) |
| Cmd+I | *Italic* (`*text*`) |
| Cmd+Shift+X | ~~Strikethrough~~ (`~~text~~`) |
| Cmd+\` | `Inline code` (`` `text` ``) |

If no text is selected, the shortcut inserts the formatting markers and places the cursor between them.

## Command Palette

Press **Cmd+K** to open the command palette. Start typing to fuzzy-search through all available commands. Each command shows its keyboard shortcut (if any) on the right.

![Command palette with fuzzy search](images/editor-basics/command-palette.png)

### Semantic Search in the Command Palette

Type `?` followed by your query to switch to semantic search mode. Instead of matching command names, this searches your indexed documents by meaning and shows results with relevance percentages.


## Panel Layout

Control which panes are visible:

| Shortcut | Panel |
|----------|-------|
| Cmd+1 | Toggle sidebar |
| Cmd+2 | Toggle editor pane |
| Cmd+3 | Toggle preview pane |
| Cmd+4 | Toggle Table of Contents |
| Cmd+5 | Open Semantic Search |

You can drag the divider between the editor and preview to adjust the split ratio (from 20/80 to 80/20).

## Tabs

MarkUpsideDown supports multi-tab editing:

- Open multiple files and switch between them with tabs
- **Cmd+Shift+[** and **Cmd+Shift+]** to switch tabs
- **Cmd+W** to close the current tab
- Drag tabs to reorder them
- Tab state is persisted across sessions

## Status Bar

The status bar at the bottom shows:

- Line count and character count
- Current file path
- Git branch name (when in a Git repository)

## Saving

- **Cmd+S** saves the current file
- **Auto-save** (optional, enabled in Settings) saves automatically after a brief pause in typing
- If a file is changed externally (e.g., by another editor or an AI agent), MarkUpsideDown detects the change and reloads the content automatically

## Multi-Window

You can open multiple windows, each with its own set of tabs and state. Windows are restored when you relaunch the app.

See [Keyboard Shortcuts](keyboard-shortcuts.md) for the complete shortcut reference.
