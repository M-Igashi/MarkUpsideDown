// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod cloudflare;
mod commands;
mod util;

use std::sync::Arc;

fn main() {
    let editor_state = Arc::new(commands::EditorState::default());
    let editor_state_managed = editor_state.clone();
    let http_client = reqwest::Client::builder()
        .build()
        .expect("Failed to create HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(editor_state_managed)
        .manage(http_client)
        .setup(move |app| {
            bridge::start(app.handle().clone(), editor_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_worker_url,
            commands::fetch_url_as_markdown,
            commands::fetch_rendered_url_as_markdown,
            commands::convert_file_to_markdown,
            commands::detect_file_is_image,
            commands::github_fetch_issue,
            commands::github_fetch_pr,
            commands::github_list_repos,
            commands::sync_editor_state,
            commands::fetch_svg,
            commands::get_mcp_binary_path,
            commands::read_text_file,
            commands::list_directory,
            commands::create_file,
            commands::create_directory,
            commands::rename_entry,
            commands::delete_entry,
            commands::duplicate_entry,
            commands::reveal_in_finder,
            commands::git_status,
            commands::git_stage,
            commands::git_unstage,
            commands::git_commit,
            commands::git_push,
            commands::git_pull,
            commands::git_fetch,
            cloudflare::check_wrangler_status,
            cloudflare::wrangler_login,
            cloudflare::deploy_worker,
            cloudflare::setup_worker_secrets,
            cloudflare::setup_worker_secrets_with_token,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                bridge::cleanup();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MarkUpsideDown");
}
