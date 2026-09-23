# Keyboard Shortcuts

All commands are also accessible via the **Command Palette** (Cmd+K).

> **Note:** Shortcuts listed below use macOS modifier keys. MarkUpsideDown currently supports macOS only.

## Formatting

| Shortcut | Action | Markdown |
|----------|--------|----------|
| Cmd+B | Bold | `**text**` |
| Cmd+I | Italic | `*text*` |
| Cmd+Shift+X | Strikethrough | `~~text~~` |
| Cmd+\` | Inline code | `` `text` `` |

## File & Tabs

| Shortcut | Action |
|----------|--------|
| Cmd+S | Save file |
| Cmd+W | Close current tab |
| Cmd+Shift+[ | Switch to previous tab |
| Cmd+Shift+] | Switch to next tab |

## Panels

| Shortcut | Action |
|----------|--------|
| Cmd+K | Open Command Palette |
| Cmd+1 | Toggle sidebar |
| Cmd+2 | Toggle editor pane |
| Cmd+3 | Toggle preview pane |
| Cmd+4 | Toggle Table of Contents |
| Cmd+5 | Open Semantic Search |
| Cmd+F | Find in the active pane: editor search, or preview search when the preview was last clicked or scrolled |

## Smart Copy (Cmd+C)

The copy behavior changes depending on which pane is focused and whether text is selected:

| Focus | Selection | Behavior |
|-------|-----------|----------|
| Editor | Text selected | Copy selection as plain Markdown |
| Editor | No selection | Copy entire document as plain Markdown |
| Preview | Text selected | Copy selection as rich text (HTML + plain text) |
| Preview | No selection | Copy entire preview as rich text (HTML + plain text) |

This means you can copy rendered content (with formatting preserved) from the preview pane and paste it directly into apps like Google Docs, Notion, or email clients.

## Sidebar (File Tree)

| Shortcut | Action |
|----------|--------|
| Cmd+A | Select all files |
| Cmd+C | Copy selected files |
| Cmd+X | Cut selected files |
| Cmd+V | Paste files |
| Cmd+Click | Toggle individual file selection |
| Shift+Click | Select range of files |

## Table Editor

These shortcuts are active when the table editor dialog is open:

| Shortcut | Action |
|----------|--------|
| Tab | Move to next cell (creates new row at end) |
| Shift+Tab | Move to previous cell |
| Enter | Move to cell below (creates new row at bottom) |
| Arrow Up/Down | Move to cell above/below |
| Cmd+Z | Undo |
| Cmd+Shift+Z or Cmd+Y | Redo |
| Escape | Close table editor |

## Git Panel

| Shortcut | Action |
|----------|--------|
| Cmd+Enter | Commit (when commit message is focused) |

## Mermaid Diagram Viewer

These shortcuts are active when the fullscreen Mermaid viewer is open:

| Shortcut | Action |
|----------|--------|
| + or = | Zoom in |
| - | Zoom out |
| 0 | Reset to 100% |
| F | Fit diagram to view |
| Escape | Close viewer |

## Presentation Mode

These shortcuts are active during a slide presentation:

| Shortcut | Action |
|----------|--------|
| Arrow Right / Arrow Down / Space | Next slide |
| Arrow Left / Arrow Up | Previous slide |
| Home | First slide |
| End | Last slide |
| Escape | Exit presentation |

You can also click the right half of the screen to advance and the left half to go back.

## Semantic Search

| Shortcut | Action |
|----------|--------|
| Arrow Up/Down | Navigate results |
| Enter | Open selected result |
| Escape | Close search |

## Command Palette

| Shortcut | Action |
|----------|--------|
| Arrow Up/Down | Navigate commands |
| Enter | Execute selected command |
| Escape | Close palette |

Type `?` followed by a query to switch to semantic search mode within the command palette.
