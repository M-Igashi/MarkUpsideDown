// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::fetch_url_as_markdown,
            commands::fetch_rendered_url_as_markdown,
            commands::convert_file_to_markdown,
            commands::detect_file_is_image,
            commands::github_fetch_issue,
            commands::github_fetch_pr,
            commands::github_list_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MarkUpsideDown");
}
