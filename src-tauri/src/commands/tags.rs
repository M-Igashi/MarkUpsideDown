//! File tags, stored per project in `.markupsidedown/tags.json`.
//!
//! Every window on a project and the MCP bridge change the file through
//! `apply_tag_ops`, which re-reads it, applies only the requested change, and
//! writes it back under one lock. A whole-file write from a stale in-memory
//! copy would silently undo changes made elsewhere.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::files::validate_path;
use crate::error::{AppError, Result};

const MAX_TAG_NAME_CHARS: usize = 24;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct TagsData {
    /// Tag name → definition (`{ "color": "#rrggbb" }`), in creation order.
    #[serde(default)]
    pub tags: serde_json::Map<String, serde_json::Value>,
    /// Project-relative path → tag names.
    #[serde(default)]
    pub files: BTreeMap<String, Vec<String>>,
}

/// One change to the tags of a project. Paths are project-relative.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TagsOp {
    CreateTag { name: String, color: String },
    /// Remove the definition and take the tag off every file.
    DeleteTag { name: String },
    /// Replace the tags of one path.
    SetFileTags { path: String, tags: Vec<String> },
    AddFileTag { paths: Vec<String>, tag: String },
    RemoveFileTag { paths: Vec<String>, tag: String },
    /// Re-key a path and everything under it.
    RenamePath { from: String, to: String },
    /// Drop a path and everything under it.
    DeletePath { path: String },
}

fn missing_tag(name: &str) -> AppError {
    AppError::Validation(format!("Tag '{name}' does not exist. Create it first with create_tag."))
}

fn apply(data: &mut TagsData, op: TagsOp) -> Result<()> {
    match op {
        TagsOp::CreateTag { name, color } => {
            if name.is_empty() || name.chars().count() > MAX_TAG_NAME_CHARS {
                return Err(AppError::Validation(format!(
                    "Tag name must be 1-{MAX_TAG_NAME_CHARS} characters"
                )));
            }
            if data.tags.contains_key(&name) {
                return Err(AppError::Validation(format!("Tag '{name}' already exists")));
            }
            data.tags.insert(name, serde_json::json!({ "color": color }));
        }
        TagsOp::DeleteTag { name } => {
            // shift_remove keeps the other tags in creation order
            if data.tags.shift_remove(&name).is_none() {
                return Err(AppError::Validation(format!("Tag '{name}' not found")));
            }
            for tags in data.files.values_mut() {
                tags.retain(|t| t != &name);
            }
        }
        TagsOp::SetFileTags { path, tags } => {
            if let Some(unknown) = tags.iter().find(|t| !data.tags.contains_key(*t)) {
                return Err(missing_tag(unknown));
            }
            data.files.insert(path, tags);
        }
        TagsOp::AddFileTag { paths, tag } => {
            if !data.tags.contains_key(&tag) {
                return Err(missing_tag(&tag));
            }
            for path in paths {
                let tags = data.files.entry(path).or_default();
                if !tags.contains(&tag) {
                    tags.push(tag.clone());
                }
            }
        }
        TagsOp::RemoveFileTag { paths, tag } => {
            for path in paths {
                if let Some(tags) = data.files.get_mut(&path) {
                    tags.retain(|t| t != &tag);
                }
            }
        }
        TagsOp::RenamePath { from, to } => rekey(data, &from, Some(&to)),
        TagsOp::DeletePath { path } => rekey(data, &path, None),
    }
    Ok(())
}

/// Move the entries for `from` and everything under it to `to`, or drop them.
fn rekey(data: &mut TagsData, from: &str, to: Option<&str>) {
    let prefix = format!("{from}/");
    let affected: Vec<String> = data
        .files
        .keys()
        .filter(|path| *path == from || path.starts_with(&prefix))
        .cloned()
        .collect();
    for path in affected {
        let Some(tags) = data.files.remove(&path) else { continue };
        if let Some(to) = to {
            data.files.insert(format!("{to}{}", &path[from.len()..]), tags);
        }
    }
}

fn tags_file(root: &Path) -> std::path::PathBuf {
    root.join(".markupsidedown").join("tags.json")
}

async fn read(root: &Path) -> TagsData {
    match tokio::fs::read_to_string(tags_file(root)).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => TagsData::default(),
    }
}

/// Write through a temporary file so a reader never sees half a file.
async fn write(root: &Path, data: &TagsData) -> Result<()> {
    let path = tags_file(root);
    let io = |what: &str, e: std::io::Error| AppError::Io(format!("Failed to {what}: {e}"));
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| io("create directory", e))?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| AppError::Io(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, json).await.map_err(|e| io("write tags", e))?;
    tokio::fs::rename(&tmp, &path).await.map_err(|e| io("write tags", e))
}

static TAGS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Read, modify, and write `tags.json` as one step. Nothing is written (and
/// no `.markupsidedown` folder is created) when the ops change nothing.
async fn apply_at(root: &Path, change: impl FnOnce(&mut TagsData) -> Result<()>) -> Result<TagsData> {
    let _guard = TAGS_LOCK.lock().await;
    let before = read(root).await;
    let mut data = before.clone();
    change(&mut data)?;
    data.files.retain(|_, tags| !tags.is_empty());
    if data != before {
        write(root, &data).await?;
    }
    Ok(data)
}

/// Tell every window that the tags of the project at `root` changed.
fn notify_changed(app: &AppHandle, root: &str) {
    let _ = app.emit("tags:changed", root);
}

/// Drop entries whose file is gone: renamed or deleted in Finder, in a
/// terminal, or by git, where nothing could update the tags.
async fn prune_at(root: &Path) -> Result<(TagsData, bool)> {
    let mut pruned = false;
    let data = apply_at(root, |data| {
        let before = data.files.len();
        data.files.retain(|path, _| root.join(path).exists());
        pruned = data.files.len() != before;
        Ok(())
    })
    .await?;
    Ok((data, pruned))
}

/// Tags for the sidebar, with stale entries removed.
#[tauri::command]
pub async fn load_tags(app: AppHandle, root: String) -> Result<TagsData> {
    let (data, pruned) = prune_at(&validate_path(&root)?).await?;
    if pruned {
        notify_changed(&app, &root);
    }
    Ok(data)
}

pub async fn read_tags(root: &str) -> Result<TagsData> {
    Ok(read(&validate_path(root)?).await)
}

pub async fn apply_tag_ops(app: &AppHandle, root: &str, ops: Vec<TagsOp>) -> Result<TagsData> {
    let dir = validate_path(root)?;
    let data = apply_at(&dir, |data| ops.into_iter().try_for_each(|op| apply(data, op))).await?;
    notify_changed(app, root);
    Ok(data)
}

/// Replace the whole file. Only for MCP servers older than `/tags/update`,
/// which may still be running after an app update.
pub async fn replace_tags(app: &AppHandle, root: &str, data: TagsData) -> Result<()> {
    let dir = validate_path(root)?;
    apply_at(&dir, |current| {
        *current = data;
        Ok(())
    })
    .await?;
    notify_changed(app, root);
    Ok(())
}

#[tauri::command]
pub async fn update_tags(app: AppHandle, root: String, ops: Vec<TagsOp>) -> Result<TagsData> {
    apply_tag_ops(&app, &root, ops).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(json: serde_json::Value) -> Vec<TagsOp> {
        serde_json::from_value(json).unwrap()
    }

    fn apply_all(data: &mut TagsData, json: serde_json::Value) -> Result<()> {
        ops(json).into_iter().try_for_each(|op| apply(data, op))
    }

    fn sample() -> TagsData {
        let mut data = TagsData::default();
        apply_all(
            &mut data,
            serde_json::json!([
                { "op": "create_tag", "name": "todo", "color": "#d94545" },
                { "op": "create_tag", "name": "done", "color": "#4a9e5c" },
                { "op": "add_file_tag", "paths": ["docs/a.md", "docs/sub/b.md", "docs.md"], "tag": "todo" },
                { "op": "add_file_tag", "paths": ["docs/a.md"], "tag": "done" },
            ]),
        )
        .unwrap();
        data
    }

    #[test]
    fn renames_and_deletes_a_path_with_everything_under_it() {
        let mut data = sample();
        apply_all(&mut data, serde_json::json!([{ "op": "rename_path", "from": "docs", "to": "notes" }])).unwrap();
        let keys: Vec<&str> = data.files.keys().map(String::as_str).collect();
        // "docs.md" only shares the prefix, it is not under "docs/"
        assert_eq!(keys, ["docs.md", "notes/a.md", "notes/sub/b.md"]);
        assert_eq!(data.files["notes/a.md"], ["todo", "done"]);

        apply_all(&mut data, serde_json::json!([{ "op": "delete_path", "path": "notes/sub" }])).unwrap();
        assert!(!data.files.contains_key("notes/sub/b.md"));
        assert!(data.files.contains_key("notes/a.md"));
    }

    #[test]
    fn deleting_a_tag_takes_it_off_every_file_and_keeps_tag_order() {
        let mut data = sample();
        apply_all(
            &mut data,
            serde_json::json!([
                { "op": "create_tag", "name": "later", "color": "#4a7ab5" },
                { "op": "delete_tag", "name": "todo" },
            ]),
        )
        .unwrap();
        assert_eq!(data.tags.keys().collect::<Vec<_>>(), ["done", "later"]);
        assert_eq!(data.files["docs/a.md"], ["done"]);
        assert!(data.files["docs.md"].is_empty());
    }

    #[test]
    fn rejects_unknown_and_duplicate_tags() {
        let mut data = sample();
        let err = |data: &mut TagsData, json| apply_all(data, json).unwrap_err().to_string();
        assert!(err(&mut data, serde_json::json!([{ "op": "create_tag", "name": "todo", "color": "#000" }])).contains("already exists"));
        assert!(err(&mut data, serde_json::json!([{ "op": "delete_tag", "name": "nope" }])).contains("not found"));
        assert!(err(&mut data, serde_json::json!([{ "op": "set_file_tags", "path": "x.md", "tags": ["nope"] }])).contains("does not exist"));
        assert!(err(&mut data, serde_json::json!([{ "op": "create_tag", "name": "", "color": "#000" }])).contains("1-24"));
    }

    #[tokio::test]
    async fn concurrent_changes_all_survive() {
        let root = std::env::temp_dir().join(format!("mud-tags-test-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(&root).await.unwrap();

        // A rename with no tagged files writes nothing
        apply_at(&root, |d| apply_all(d, serde_json::json!([{ "op": "rename_path", "from": "a", "to": "b" }])))
            .await
            .unwrap();
        assert!(!root.join(".markupsidedown").exists());

        apply_at(&root, |d| apply_all(d, serde_json::json!([{ "op": "create_tag", "name": "t", "color": "#000" }])))
            .await
            .unwrap();
        // Each task stands for a window (or an MCP agent) changing one file
        let tasks: Vec<_> = (0..20)
            .map(|i| {
                let root = root.clone();
                tokio::spawn(async move {
                    apply_at(&root, |d| {
                        apply_all(d, serde_json::json!([{ "op": "add_file_tag", "paths": [format!("f{i}.md")], "tag": "t" }]))
                    })
                    .await
                    .unwrap();
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        let data = read(&root).await;
        assert_eq!(data.files.len(), 20);
        // An emptied entry is dropped from the file
        apply_at(&root, |d| apply_all(d, serde_json::json!([{ "op": "remove_file_tag", "paths": ["f0.md"], "tag": "t" }])))
            .await
            .unwrap();
        assert_eq!(read(&root).await.files.len(), 19);

        tokio::fs::remove_dir_all(&root).await.unwrap();
    }

    #[tokio::test]
    async fn loading_drops_entries_whose_file_is_gone() {
        let root = std::env::temp_dir().join(format!("mud-tags-prune-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(root.join("docs")).await.unwrap();
        tokio::fs::write(root.join("docs/kept.md"), "").await.unwrap();
        apply_at(&root, |d| {
            apply_all(
                d,
                serde_json::json!([
                    { "op": "create_tag", "name": "t", "color": "#000" },
                    { "op": "add_file_tag", "paths": ["docs/kept.md", "docs/gone.md", "docs"], "tag": "t" },
                ]),
            )
        })
        .await
        .unwrap();

        let (data, pruned) = prune_at(&root).await.unwrap();
        assert!(pruned);
        assert_eq!(data.files.keys().collect::<Vec<_>>(), ["docs", "docs/kept.md"]);
        assert_eq!(read(&root).await, data);
        // The tag definition stays even when no file uses it
        assert!(data.tags.contains_key("t"));
        assert!(!prune_at(&root).await.unwrap().1);

        tokio::fs::remove_dir_all(&root).await.unwrap();
    }
}
