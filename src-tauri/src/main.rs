// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod claude;
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
    let claude_state = claude::new_state();
    let claude_state_cleanup = claude_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(editor_state_managed)
        .manage(http_client)
        .manage(claude_state)

        .setup(move |app| {
            bridge::start(app.handle().clone(), editor_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_worker_url,
            commands::fetch_url_as_markdown,
            commands::fetch_rendered_url_as_markdown,
            commands::fetch_url_via_worker,
            commands::crawl_website,
            commands::crawl_status,
            commands::crawl_save,
            commands::convert_file_to_markdown,
            commands::detect_file_is_image,
            commands::github_fetch_issue,
            commands::github_fetch_pr,
            commands::github_list_repos,
            commands::sync_editor_state,
            commands::fetch_svg,
            commands::get_mcp_binary_path,
            commands::create_cowork_workspace,
            commands::read_text_file,
            commands::list_directory,
            commands::create_file,
            commands::create_directory,
            commands::rename_entry,
            commands::write_file_bytes,
            commands::delete_entry,
            commands::copy_entry,
            commands::duplicate_entry,
            commands::reveal_in_finder,
            commands::open_in_terminal,
            commands::git_status,
            commands::git_stage_all,
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
            claude::claude_start,
            claude::claude_stop,
            claude::claude_send,
            claude::claude_is_running,
        ])
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                bridge::cleanup();
                let state = claude_state_cleanup.clone();
                tokio::spawn(async move {
                    claude::cleanup(&state).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MarkUpsideDown");
}
