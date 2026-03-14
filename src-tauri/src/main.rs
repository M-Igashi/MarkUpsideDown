// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;

use std::sync::Arc;

fn main() {
    let editor_state = Arc::new(commands::EditorState::default());
    let editor_state_managed = editor_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(editor_state_managed)
        .setup(move |app| {
            bridge::start(app.handle().clone(), editor_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch_url_as_markdown,
            commands::fetch_rendered_url_as_markdown,
            commands::convert_file_to_markdown,
            commands::detect_file_is_image,
            commands::github_fetch_issue,
            commands::github_fetch_pr,
            commands::github_list_repos,
            commands::sync_editor_state,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                bridge::cleanup();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MarkUpsideDown");
}
