// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod cloudflare;
mod commands;
mod menu;
mod util;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_cli::CliExt;

fn main() {
    let editor_states = Arc::new(commands::EditorStates::default());
    let editor_states_managed = editor_states.clone();
    let editor_states_events = editor_states.clone();
    let http_client = reqwest::Client::builder()
        .build()
        .expect("Failed to create HTTP client");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_cli::init())
        .manage(editor_states_managed)
        .manage(http_client)

        .setup(move |app| {
            let m = menu::build(app.handle())?;
            app.set_menu(m)?;
            bridge::start(app.handle().clone(), editor_states.clone());

            // Handle CLI file argument
            if let Ok(matches) = app.cli().matches() {
                if let Some(file_arg) = matches.args.get("file") {
                    if let Some(path_str) = file_arg.value.as_str().filter(|s| !s.is_empty()) {
                        let path = if PathBuf::from(path_str).is_absolute() {
                            PathBuf::from(path_str)
                        } else {
                            std::env::current_dir()
                                .unwrap_or_default()
                                .join(path_str)
                        };
                        if path.exists() {
                            let path_string = path.to_string_lossy().to_string();
                            let handle = app.handle().clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                let _ = handle.emit("cli:open-file", path_string);
                            });
                        }
                    }
                }
            }

            Ok(())
        })
        .on_menu_event(|handle, event| {
            menu::handle_event(handle, &event);
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
            commands::git_clone,
            commands::sync_editor_state,
            commands::fetch_page_title,
            commands::download_image,
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
            commands::git_diff,
            commands::git_discard,
            commands::git_discard_all,
            commands::git_log,
            commands::git_revert,
            commands::git_show,
            cloudflare::check_wrangler_status,
            cloudflare::wrangler_login,
            cloudflare::deploy_worker,
            cloudflare::setup_worker_secrets,
            cloudflare::setup_worker_secrets_with_token,
            menu::add_recent_file,
        ])
        .on_window_event(move |window, event| {
            match event {
                tauri::WindowEvent::Focused(true) => {
                    editor_states_events.set_focused(window.label().to_string());
                }
                tauri::WindowEvent::Destroyed => {
                    // Remove this window's editor state
                    editor_states_events.remove_window(window.label());
                    // Only clean up bridge when the last window closes
                    if window.app_handle().webview_windows().len() <= 1 {
                        bridge::cleanup();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MarkUpsideDown");
}
