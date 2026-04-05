# File Management

MarkUpsideDown includes a built-in file browser in the sidebar. You can browse, create, rename, and delete files without leaving the app.

## Sidebar

Toggle the sidebar with **Cmd+1**. The sidebar has three panels, selectable from the navigation bar at the bottom:

- **Files** — File tree browser
- **Git** — Git panel (see [Git Integration](git-integration.md))
- **Clone** — Clone a repository (see [Git Integration](git-integration.md))

![Sidebar file browser](images/file-management/sidebar-files.png)

### Opening a Folder

Click the **Open** button in the toolbar or use the folder icon in the sidebar header to open a folder. The file tree will populate with the folder's contents.

### File Tree

The file tree shows files and folders with:

- **Folder expansion** — click to expand/collapse folders
- **Git status badges** — M (modified), A (added), D (deleted), R (renamed), ? (untracked)
- **Tag dots** — colored dots indicating file tags (see [Tags & Organization](tags.md))
- **Publish indicator** — shows when a file has been published
- **Dotfile toggle** — show or hide dotfiles with the toggle button in the sidebar header

### Search and Sort

At the top of the Files panel:

- **Search input** — filter files by name as you type
- **Sort dropdown** — sort by Name, Date, Type, or Tag

You can also filter files to a specific folder (shown as a "in: FolderName" badge) or by tag (shown as a "tag: TagName" badge). Click the ✕ on the badge to clear the filter.

### File Operations

**Right-click** a file or folder in the sidebar for a context menu with:

- New File / New Folder
- Rename
- Duplicate
- Delete
- Copy / Cut / Paste
- Reveal in Finder
- Open in Terminal
- Publish (see [Publishing](publishing.md))
- Tag (see [Tags & Organization](tags.md))

![File context menu](images/file-management/file-context-menu.png)

### Multi-Select

- **Cmd+Click** — toggle selection on individual files
- **Shift+Click** — select a range of files
- **Cmd+A** — select all files

Selected files can be cut (Cmd+X), copied (Cmd+C), and pasted (Cmd+V) to move or duplicate them.

### Drag & Drop

- Drag files within the sidebar to move them to a different folder
- Drop supported files (PDF, DOCX, images, etc.) onto the editor to import them

## Tabs

Each open file gets its own tab at the top of the editor pane.

![Editor tabs](images/file-management/tabs.png)

| Action | How |
|--------|-----|
| Switch tabs | Click a tab, or Cmd+Shift+[ / Cmd+Shift+] |
| Close tab | Click the ✕ on the tab, or Cmd+W |
| Reorder tabs | Drag a tab to a new position |

Tab state — which files are open and their scroll positions — is persisted across app restarts.

### Collapsing the Sidebar

When collapsed, the sidebar becomes a narrow strip. Click the collapse button (chevron) in the sidebar header, or use **Cmd+1** to toggle.


## Auto-Save

When enabled in Settings, auto-save writes the file automatically after a brief pause in typing. This is off by default — enable it in **Settings → Editor → Auto-save**.

## File Watcher

MarkUpsideDown watches open files for external changes. If a file is modified outside the app (by another editor, a script, or an AI agent), the content is automatically reloaded. This is especially useful when working alongside Claude Code or other tools that edit files directly.
