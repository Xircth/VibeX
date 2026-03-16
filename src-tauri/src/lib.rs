use tauri::Manager;

mod commands;
mod error;
mod events;
mod preview_proxy;
mod state;
use state::AppState;

#[tauri::command]
async fn health_check() -> Result<String, String> {
    Ok("ok".to_string())
}

#[tauri::command]
async fn toggle_main_window_devtools(app: tauri::AppHandle) -> Result<bool, String> {
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let is_open = webview.is_devtools_open();
    if is_open {
        webview.close_devtools();
        Ok(false)
    } else {
        webview.open_devtools();
        Ok(true)
    }
}

#[tauri::command]
async fn get_preview_proxy_url(url: String) -> Result<String, String> {
    preview_proxy::get_proxy_url(&url).ok_or_else(|| {
        format!(
            "Preview proxy is unavailable or unsupported for url: {}",
            url
        )
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(error) = tauri::async_runtime::block_on(preview_proxy::ensure_started()) {
                tracing::error!("Failed to start preview proxy: {}", error);
            }

            let state = tauri::async_runtime::block_on(AppState::new())
                .expect("Failed to initialize app state");
            events::start_event_forwarding(&app.handle().clone(), &state);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            toggle_main_window_devtools,
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
            commands::tasks::create_task,
            commands::tasks::create_task_and_start,
            commands::tasks::update_task,
            commands::tasks::delete_task,
            commands::workspaces::get_workspaces,
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
            commands::events::subscribe_tasks_stream,
            commands::events::subscribe_projects_stream,
            commands::events::subscribe_scratch_stream,
            commands::events::subscribe_slash_commands_stream,
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            // Filesystem commands
            commands::filesystem::list_directory,
            commands::filesystem::list_git_repos,
            // Repo commands
            commands::repos::get_repos,
            commands::repos::register_repo,
            commands::repos::get_recent_repos,
            commands::repos::init_repo,
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
            commands::config::get_mcp_servers,
            commands::config::update_mcp_servers,
            commands::config::get_profiles,
            commands::config::update_profiles,
            commands::config::check_editor_availability,
            commands::config::check_agent_availability,
            commands::config::get_claude_settings,
            commands::config::update_claude_settings,
            commands::config::read_agent_native_configs,
            commands::config::write_agent_native_config,
            // Agent settings commands
            commands::agent_settings::list_agents,
            commands::agent_settings::update_agent_preferences,
            commands::agent_settings::reorder_agents,
            commands::agent_settings::agent_preflight,
            commands::agent_settings::detect_agent_local_version,
            // Settings window commands
            commands::settings_window::open_settings_window,
            // Tag commands
            commands::tags::get_tags,
            commands::tags::create_tag,
            commands::tags::update_tag,
            commands::tags::delete_tag,
            // Approval commands
            commands::approvals::respond_to_approval,
            // Execution process commands
            commands::execution_processes::get_execution_process,
            commands::execution_processes::stop_execution_process,
            commands::execution_processes::get_execution_process_repo_states,
            // File tree commands
            commands::file_tree::get_file_tree,
            commands::file_tree::read_file_content,
            commands::file_tree::save_file_content,
            commands::file_tree::delete_file,
            commands::file_tree::get_file_at_head,
            commands::file_tree::get_claude_settings_path,
            commands::file_tree::list_directory_children,
            commands::file_tree::read_file_with_truncation,
            commands::file_tree::trash_item,
            commands::file_tree::copy_item,
            commands::file_tree::create_directory,
            commands::file_tree::search_workspace_text,
            // Skills commands
            commands::skills::get_popular_skills,
            commands::skills::install_skill,
            commands::skills::uninstall_skill,
            commands::skills::ensure_aimax_installed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
