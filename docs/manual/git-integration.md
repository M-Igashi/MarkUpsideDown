# Git Integration

MarkUpsideDown has a built-in Git panel for common version control operations. You can view changes, stage files, commit, push, and pull — all without leaving the app.

## Opening the Git Panel

Click the **Git** icon in the sidebar's bottom navigation bar, or switch from the Files panel. The Git panel appears in the sidebar.

![Git panel showing staged and unstaged files](images/git-integration/git-panel.png)

If no folder is open, the panel shows "Open a folder to see git status." If the folder is not a Git repository, it offers an **Initialize Repository** button.

## Viewing Changes

The Git panel shows three sections:

### Staged Files

Files that are ready to be committed. Each file row shows:

- **Status badge** — color-coded letter (M for modified, A for added, D for deleted, R for renamed)
- **Filename**
- **Diff stats** — additions and deletions (e.g., +12 −3)
- **Unstage button** — click to move the file back to unstaged

### Unstaged Files

Files with changes that are not yet staged. In addition to the same info as staged files, each row has:

- **Stage button** — click to stage the file
- **Discard button** (⟲) — revert the file to its last committed state

At the top, **"Stage All"** and **"⟲ Discard All"** buttons operate on all unstaged files.

### Inline Diff

Click any file row to expand an inline diff view below it. The diff shows added lines in green and removed lines in red, with hunk headers in gray.

## Committing

At the bottom of the Git panel:

1. Type your commit message in the textarea (a timestamp is pre-filled as a default)
2. Click **Commit** to commit staged files, or **Commit All** to stage and commit everything
3. Use **Cmd+Enter** as a shortcut while the commit message textarea is focused

A status message appears briefly after a successful commit (green) or an error (red).

## Push, Pull, and Fetch

The bottom bar shows:

- **Branch name** with the current branch
- **⟳ Fetch** button — fetch remote changes
- **↓ Pull** button — pull changes (shows a count badge when behind remote)
- **↑ Push** button — push changes (shows a count badge when ahead of remote)

## Recent Commits

Below the file list, the **Recent Commits** section shows recent commit history:

- Short hash
- Commit message (truncated)
- Relative time (e.g., "2 hours ago")
- **⟲ Revert** button to revert a commit

Click a commit row to expand a multi-file inline diff of that commit.

## Cloning a Repository

Switch to the **Clone** panel in the sidebar (clone icon in the bottom nav). Enter a repository URL (HTTPS or SSH) and click Clone. The repository is cloned and opened in the editor.

