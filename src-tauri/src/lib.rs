use tauri::{Manager, image::Image};

pub mod commands;
mod error;
mod events;
mod preview_proxy;
mod state;
mod workspace_paths;
use state::AppState;

const APP_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");

fn install_rustls_crypto_provider() {
    // The workspace uses reqwest's no-provider rustls mode, so the application
    // must select a process-wide crypto provider before any TLS client is built.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

pub(crate) fn load_app_icon() -> Result<Image<'static>, tauri::Error> {
    Image::from_bytes(APP_ICON_BYTES).map(|icon| icon.to_owned())
}

pub(crate) fn apply_app_icon(window: &tauri::WebviewWindow) -> Result<(), String> {
    let icon = load_app_icon().map_err(|error| error.to_string())?;
    window.set_icon(icon).map_err(|error| error.to_string())
}

#[tauri::command]
async fn health_check() -> Result<String, String> {
    Ok("ok".to_string())
}

#[tauri::command]
async fn get_preview_proxy_url(
    url: String,
    bridge_token: Option<String>,
) -> Result<String, String> {
    preview_proxy::get_proxy_url(&url, bridge_token.as_deref()).ok_or_else(|| {
        format!(
            "Preview proxy is unavailable or unsupported for url: {}",
            url
        )
    })
}

pub fn run() {
    install_rustls_crypto_provider();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = tauri::async_runtime::block_on(AppState::new())
                .expect("Failed to initialize app state");
            events::start_event_forwarding(&app.handle().clone(), &state);
            events::start_agent_terminal_forwarding(&app.handle().clone(), &state);
            app.manage(state);

            if let Err(error) = tauri::async_runtime::block_on(preview_proxy::ensure_started()) {
                tracing::error!("Failed to start preview proxy: {}", error);
            }

            if let Err(error) = commands::desktop_toast::ensure_desktop_toast_window(app.handle()) {
                tracing::warn!("Failed to initialize desktop toast window: {}", error);
            }
            if let Err(error) =
                commands::project_rail_window::ensure_project_rail_window(app.handle())
            {
                tracing::warn!("Failed to initialize project rail window: {}", error);
            }

            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(error) = apply_app_icon(&main_window) {
                    tracing::warn!("Failed to apply app icon to main window: {}", error);
                }

                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
                    | tauri::WindowEvent::Focused(true) => {
                        let _ =
                            commands::project_rail_window::sync_project_rail_window(&app_handle);
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            get_preview_proxy_url,
            commands::projects::get_projects,
            commands::projects::get_project,
            commands::projects::create_project,
            commands::projects::update_project,
            commands::projects::delete_project,
            commands::projects::search_project_files,
            commands::projects::open_project_in_editor,
            commands::projects::get_project_repositories,
            commands::projects::add_project_repository,
            commands::projects::delete_project_repository,
            commands::projects::get_project_repository,
            commands::tasks::get_tasks,
            commands::tasks::get_task,
            commands::tasks::get_task_images,
            commands::tasks::create_task,
            commands::tasks::create_task_and_start,
            commands::tasks::update_task,
            commands::tasks::delete_task,
            commands::tasks::upload_image,
            commands::tasks::upload_image_for_task,
            commands::tasks::upload_image_for_workspace,
            commands::tasks::delete_image,
            commands::tasks::get_task_image_metadata,
            commands::tasks::get_workspace_image_metadata,
            commands::workspaces::get_workspaces,
            commands::workspaces::get_project_workspaces,
            commands::workspaces::get_workspace,
            commands::workspaces::get_workspace_count,
            commands::workspaces::create_workspace,
            commands::workspaces::update_workspace,
            commands::workspaces::delete_workspace,
            commands::workspaces::stop_workspace_execution,
            commands::workspaces::get_workspace_branch_status,
            commands::workspaces::merge_workspace,
            commands::workspaces::push_workspace_branch,
            commands::workspaces::rebase_workspace,
            commands::workspaces::rebase_back_workspace,
            commands::workspaces::continue_rebase_workspace,
            commands::workspaces::abort_conflicts_workspace,
            commands::workspaces::change_workspace_target_branch,
            commands::workspaces::rename_workspace_branch,
            commands::workspaces::start_workspace_dev_server,
            commands::workspaces::install_web_companion,
            commands::workspaces::run_agent_setup,
            commands::workspaces::gh_cli_setup,
            commands::workspaces::run_setup_script,
            commands::workspaces::run_cleanup_script,
            commands::workspaces::run_archive_script,
            commands::workspaces::open_workspace_in_editor,
            commands::workspaces::get_workspace_children,
            commands::workspaces::get_workspace_repos,
            commands::workspaces::get_first_user_message,
            commands::workspaces::mark_workspace_seen,
            commands::workspaces::create_workspace_pr,
            commands::workspaces::attach_workspace_pr,
            commands::workspaces::get_workspace_pr_comments,
            commands::workspaces::create_workspace_from_pr,
            commands::workspaces::get_workspace_commit_history,
            commands::workspaces::get_workspace_commit_graph,
            commands::workspaces::pull_workspace_branch,
            commands::workspaces::fetch_workspace,
            commands::workspaces::checkout_workspace_branch,
            commands::workspaces::create_workspace_branch,
            commands::workspaces::delete_workspace_branch,
            commands::workspaces::get_workspace_git_status,
            commands::workspaces::stage_workspace_file,
            commands::workspaces::stage_workspace_all,
            commands::workspaces::unstage_workspace_file,
            commands::workspaces::revert_workspace_file,
            commands::workspaces::revert_workspace_all,
            commands::workspaces::get_workspace_file_diffs,
            commands::workspaces::commit_workspace_changes,
            commands::workspaces::get_workspace_git_log,
            commands::workspaces::get_workspace_commit_detail,
            commands::workspaces::get_workspace_commit_diffs,
            commands::workspaces::git_cherry_pick,
            commands::workspaces::git_revert_commit,
            commands::workspaces::git_reset_to_commit,
            commands::workspaces::git_create_branch_at_commit,
            commands::sessions::get_sessions,
            commands::sessions::get_session_summaries,
            commands::sessions::get_session,
            commands::sessions::create_session,
            commands::sessions::create_project_root_session,
            commands::sessions::ensure_project_workspace,
            commands::sessions::create_project_session,
            commands::sessions::rename_session,
            commands::sessions::update_session_status,
            commands::sessions::delete_session,
            commands::sessions::follow_up,
            commands::sessions::reset_session_process,
            commands::sessions::start_review,
            commands::sessions::queue_message,
            commands::sessions::cancel_queued_message,
            commands::sessions::get_queue_status,
            commands::events::subscribe_diff_stream,
            commands::events::subscribe_conversation_stream,
            commands::events::subscribe_log_stream,
            commands::events::subscribe_execution_processes_stream,
            commands::events::subscribe_project_workspaces_stream,
            commands::events::subscribe_projects_stream,
            commands::events::subscribe_file_tree_stream,
            commands::events::subscribe_scratch_stream,
            commands::events::subscribe_slash_commands_stream,
            commands::scratch::create_scratch,
            commands::scratch::get_scratch,
            commands::scratch::update_scratch,
            commands::scratch::delete_scratch,
            commands::terminal::create_terminal,
            commands::terminal::attach_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            // Filesystem commands
            commands::filesystem::list_directory,
            commands::filesystem::list_git_repos,
            commands::filesystem::reveal_in_file_manager,
            // Repo commands
            commands::repos::get_repos,
            commands::repos::register_repo,
            commands::repos::get_recent_repos,
            commands::repos::init_repo,
            commands::repos::check_git_repo_path,
            commands::repos::init_repo_at_path,
            commands::repos::get_repos_batch,
            commands::repos::get_repo,
            commands::repos::update_repo,
            commands::repos::get_repo_branches,
            commands::repos::get_repo_remotes,
            commands::repos::list_open_prs,
            commands::repos::list_repo_issues,
            commands::repos::search_repo,
            commands::repos::open_repo_in_editor,
            commands::repos::get_repo_git_status,
            commands::repos::get_repo_file_diffs,
            commands::repos::stage_repo_file,
            commands::repos::unstage_repo_file,
            commands::repos::revert_repo_file,
            commands::repos::stage_repo_all,
            commands::repos::revert_repo_all,
            commands::repos::commit_repo_changes,
            commands::repos::push_repo,
            commands::repos::pull_repo,
            commands::repos::fetch_repo,
            commands::repos::get_repo_git_log,
            commands::repos::get_repo_commit_detail,
            commands::repos::get_repo_commit_diffs,
            commands::repos::checkout_repo_branch,
            commands::repos::create_repo_branch,
            commands::repos::delete_repo_branch,
            // Config commands
            commands::config::get_user_system_info,
            commands::config::update_config,
            commands::config::clear_local_app_data,
            commands::config::get_mcp_servers,
            commands::config::update_mcp_servers,
            commands::config::get_profiles,
            commands::config::update_profiles,
            commands::config::check_editor_availability,
            commands::config::check_agent_availability,
            commands::config::play_notification_sound,
            commands::config::enhance_prompt,
            commands::config::list_opencode_models,
            commands::config::get_claude_settings,
            commands::config::update_claude_settings,
            commands::config::read_agent_native_configs,
            commands::config::write_agent_native_config,
            commands::desktop_toast::show_desktop_toast,
            commands::desktop_toast::activate_desktop_toast,
            commands::desktop_toast::desktop_toast_window_ready,
            commands::project_rail_window::set_project_rail_window_visible,
            commands::project_rail_window::sync_project_rail_window_bounds,
            commands::project_rail_window::activate_project_rail_target,
            // Agent settings commands
            commands::agent_settings::list_agents,
            commands::agent_settings::update_agent_preferences,
            commands::agent_settings::reorder_agents,
            commands::agent_settings::agent_preflight,
            commands::agent_settings::detect_agent_local_version,
            commands::agent_settings::run_agent_fix,
            commands::system_maintenance::get_system_maintenance_status,
            commands::system_maintenance::check_app_release,
            commands::system_maintenance::install_system_dependencies,
            // Settings window commands
            commands::settings_window::open_settings_window,
            // Tag commands
            commands::tags::get_tags,
            commands::tags::create_tag,
            commands::tags::update_tag,
            commands::tags::delete_tag,
            // Approval commands
            commands::approvals::respond_to_approval,
            // Codex account commands
            commands::codex_account::get_codex_account_rate_limits,
            // Execution process commands
            commands::execution_processes::get_execution_process,
            commands::execution_processes::stop_execution_process,
            commands::execution_processes::get_execution_process_repo_states,
            // File tree commands
            commands::file_tree::get_file_tree,
            commands::file_tree::read_file_content,
            commands::file_tree::read_document_preview,
            commands::file_tree::read_binary_asset,
            commands::file_tree::save_file_content,
            commands::file_tree::delete_file,
            commands::file_tree::get_file_at_head,
            commands::file_tree::get_claude_settings_path,
            commands::file_tree::list_directory_children,
            commands::file_tree::read_file_with_truncation,
            commands::file_tree::trash_item,
            commands::file_tree::copy_item,
            commands::file_tree::move_item,
            commands::file_tree::create_directory,
            commands::file_tree::search_workspace_text,
            // Skills commands
            commands::skills::list_local_agent_skills,
            // Local usage commands
            commands::local_usage::get_project_usage_statistics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::install_rustls_crypto_provider;

    #[test]
    fn installs_rustls_crypto_provider_for_reqwest_clients() {
        install_rustls_crypto_provider();

        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
