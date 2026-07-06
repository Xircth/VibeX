use tauri::{Emitter, Manager, image::Image};

pub mod bridge;
pub mod commands;
pub mod conversation_bundle;
pub mod conversation_service;
mod deeplink;
mod delegation;
mod error;
mod logging;
mod tray;
mod events;
mod preview_proxy;
mod state;
mod workspace_paths;
use state::AppState;

const APP_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");
const MAIN_WINDOW_CLOSE_REQUESTED_EVENT: &str = "main-window-close-requested";

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

#[tauri::command]
async fn exit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

pub fn run() {
    // Install the file+stderr tracing subscriber first so startup is logged. The
    // guard flushes the non-blocking writer on drop; we drop it from RunEvent::Exit
    // (tao's process::exit doesn't unwind, so a scope-drop would never flush) (P2-8).
    let mut log_guard = Some(logging::init_logging());
    install_rustls_crypto_provider();

    tauri::Builder::default()
        // single-instance MUST come first and before deep-link (P2-5): it forwards
        // a second launch's args (carrying the vibex:// URL on Windows/Linux) into
        // the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            deeplink::route_deep_link_args(app, &args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Apply the saved system-proxy setting to process env FIRST, before any
            // reqwest client is built or any ACP agent is spawned — otherwise the
            // proxy never reaches them (agents inherit it via merged_agent_env) and
            // e.g. codex-acp can't reach OpenAI.
            tauri::async_runtime::block_on(commands::system_settings::init_system_proxy());

            let state = tauri::async_runtime::block_on(AppState::new())
                .expect("Failed to initialize app state");
            // Startup crash-recovery (ADR-0001): reconcile turns orphaned by a prior
            // process lifecycle before the UI connects. Best-effort — a failure here
            // must not block app launch; the worst case is a stale in-flight turn.
            if let Err(error) = tauri::async_runtime::block_on(
                conversation_service::ConversationSessionService::new(state.conversation_context())
                    .recover_interrupted_turns(),
            ) {
                tracing::error!("startup crash-recovery failed: {}", error);
            }
            events::start_event_forwarding(&app.handle().clone(), &state);
            events::start_agent_event_forwarding(&app.handle().clone(), &state);
            events::start_agent_terminal_forwarding(&app.handle().clone(), &state);

            // Backfill the conversation full-text index for any conversation not
            // yet indexed (first run after the FTS migration, imported histories).
            // Background + best-effort so it never delays launch (P1-2).
            let search_pool = state.deployment.db().pool.clone();
            tauri::async_runtime::spawn(async move {
                match conversations::backfill_missing(&search_pool).await {
                    Ok(indexed) if indexed > 0 => {
                        tracing::info!("indexed {indexed} conversations for search")
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!("conversation search backfill failed: {error}")
                    }
                }
            });

            app.manage(state);
            // Bidirectional IM channels: run inbound loops + conversation command dispatch.
            commands::chat_channel::set_audit_pool(
                app.state::<state::AppState>().deployment.db().pool.clone(),
            );
            commands::chat_channel::start_inbound_manager(app.handle().clone());

            // Automations (P0-3): recover orphaned runs, then start the cron poller.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let pool = handle.state::<state::AppState>().deployment.db().pool.clone();
                    if let Err(error) = commands::automation::recover_automation_runs(&pool).await {
                        tracing::warn!("automation run recovery failed: {error}");
                    }
                });
                commands::automation::start_automation_scheduler(app.handle().clone());
            }

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
            if let Err(error) = tauri::async_runtime::block_on(
                commands::web_service::ensure_web_service_autostart(app.handle().clone()),
            ) {
                tracing::warn!("Failed to autostart web service: {}", error);
            }

            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(error) = apply_app_icon(&main_window) {
                    tracing::warn!("Failed to apply app icon to main window: {}", error);
                }

                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = app_handle.emit(MAIN_WINDOW_CLOSE_REQUESTED_EVENT, ());
                    }
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

            // System tray (P2-5). Best-effort: on Linux the tray may be absent
            // (no StatusNotifierWatcher) even on success, so log and continue.
            if let Err(error) = tray::install_tray_icon(app.handle()) {
                tracing::warn!("Failed to install tray icon: {}", error);
            }

            // Deep links (P2-5). macOS delivers URLs here; register the scheme at
            // runtime too so it works in dev on Linux/Windows (best-effort).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let deep_link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    deeplink::route_deep_link_urls(&deep_link_handle, &event.urls());
                });
                let _ = app.deep_link().register_all();
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Tray menu clicks (Show / Hide / Quit) share this dispatcher (P2-5).
            tray::handle_menu_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            get_preview_proxy_url,
            exit_app,
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
            commands::workspaces::stash_workspace,
            commands::workspaces::list_workspace_stashes,
            commands::workspaces::apply_workspace_stash,
            commands::workspaces::pop_workspace_stash,
            commands::workspaces::drop_workspace_stash,
            commands::workspaces::show_workspace_stash,
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
            commands::sessions::reset_session_process,
            commands::conversations::conversation_detail,
            commands::conversations::conversation_list,
            commands::conversations::conversation_start_turn,
            commands::conversations::conversation_events_since,
            commands::conversations::conversation_timeline_page,
            commands::conversations::conversation_respond_permission,
            commands::conversations::conversation_cancel_turn,
            commands::conversations::conversation_truncate_to_turn,
            commands::conversations::conversation_close,
            commands::conversations::conversation_export,
            commands::conversations::conversation_export_markdown,
            commands::conversations::conversation_export_html,
            commands::conversations::conversation_search,
            commands::conversations::conversation_import,
            commands::conversations::conversation_fork,
            commands::automation::automation_list,
            commands::automation::automation_create,
            commands::automation::automation_update,
            commands::automation::automation_set_enabled,
            commands::automation::automation_delete,
            commands::automation::automation_run_now,
            commands::automation::automation_runs,
            commands::automation::automation_unseen_failures,
            commands::automation::automation_mark_seen,
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
            commands::terminal::open_external_terminal,
            commands::terminal::attach_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            // Filesystem commands
            commands::filesystem::list_directory,
            commands::filesystem::list_git_repos,
            commands::filesystem::reveal_in_file_manager,
            // Log viewer commands (P2-8)
            commands::logs::get_app_logs,
            commands::logs::get_logs_dir,
            // Tray badge (P2-5)
            tray::update_tray_badge,
            // Repo commands
            commands::repos::get_repos,
            commands::repos::register_repo,
            commands::repos::get_recent_repos,
            commands::repos::init_repo,
            commands::repos::check_git_repo_path,
            commands::repos::clone_repo,
            commands::repos::add_repo_remote,
            commands::repos::remove_repo_remote,
            commands::repos::set_repo_remote_url,
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
            commands::config::read_agent_native_files,
            commands::config::write_agent_native_files,
            commands::config::mcp_scan_local,
            commands::config::mcp_list_marketplaces,
            commands::config::mcp_search_marketplace,
            commands::config::mcp_get_marketplace_server_detail,
            commands::config::mcp_install_marketplace_server,
            commands::config::mcp_upsert_local_server,
            commands::config::mcp_uninstall_server,
            commands::desktop_toast::show_desktop_toast,
            commands::desktop_toast::is_main_window_focused,
            commands::desktop_toast::activate_desktop_toast,
            commands::desktop_toast::desktop_toast_window_ready,
            commands::project_rail_window::set_project_rail_window_visible,
            commands::project_rail_window::sync_project_rail_window_bounds,
            commands::project_rail_window::activate_project_rail_target,
            commands::project_rail_window::request_project_rail_project_dialog,
            // Agent settings commands
            commands::agent_settings::list_agents,
            commands::agent_settings::update_agent_preferences,
            commands::agent_settings::reorder_agents,
            commands::agent_settings::agent_preflight,
            commands::agent_settings::detect_agent_local_version,
            commands::agent_settings::run_agent_fix,
            commands::agent_settings::open_agent_login_terminal,
            commands::version_control::get_version_control_settings,
            commands::version_control::update_version_control_settings,
            commands::version_control::detect_git_version,
            commands::version_control::test_git_path,
            commands::version_control::get_github_cli_status,
            commands::version_control::open_github_cli_login,
            commands::version_control::logout_github_cli,
            commands::system_settings::get_system_proxy_settings,
            commands::system_settings::update_system_proxy_settings,
            commands::system_settings::get_system_rendering_settings,
            commands::system_settings::update_system_rendering_settings,
            commands::backup::backup_create,
            commands::backup::backup_inspect,
            commands::backup::backup_restore_stage,
            commands::backup::backup_cancel,
            commands::web_service::get_web_service_config,
            commands::web_service::update_web_service_config,
            commands::web_service::get_web_server_status,
            commands::web_service::start_web_server,
            commands::web_service::stop_web_server,
            commands::web_service::probe_web_service_port,
            commands::web_service::generate_web_service_token,
            commands::model_provider::list_agent_providers,
            commands::model_provider::create_agent_provider,
            commands::model_provider::update_agent_provider,
            commands::model_provider::delete_agent_provider,
            commands::model_provider::apply_agent_provider,
            commands::model_provider::preview_agent_provider,
            commands::model_provider::clear_agent_provider_key,
            commands::model_provider::fetch_agent_provider_models,
            commands::chat_channel::list_chat_channels,
            commands::chat_channel::list_chat_channel_message_logs,
            commands::chat_channel::create_chat_channel,
            commands::chat_channel::update_chat_channel,
            commands::chat_channel::delete_chat_channel,
            commands::chat_channel::save_chat_channel_token,
            commands::chat_channel::get_chat_channel_has_token,
            commands::chat_channel::delete_chat_channel_token,
            commands::chat_channel::test_chat_channel,
            commands::chat_channel::get_chat_event_filter,
            commands::chat_channel::set_chat_event_filter,
            commands::chat_channel::get_chat_command_prefix,
            commands::chat_channel::set_chat_command_prefix,
            commands::chat_channel::get_chat_include_prompt_text,
            commands::chat_channel::set_chat_include_prompt_text,
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
            commands::instructions::list_instructions,
            commands::instructions::list_official_instructions,
            commands::instructions::create_instruction,
            commands::instructions::update_instruction,
            commands::instructions::delete_instruction,
            commands::instructions::install_official_instruction,
            // Approval commands
            commands::approvals::respond_to_approval,
            // ACP-native agent platform commands
            commands::agents::agent_registry_list,
            commands::agents::agent_config_surfaces,
            commands::agents::agent_mcp_surfaces,
            commands::agents::agent_skills_surfaces,
            commands::agents::agent_install_plans,
            commands::agents::agent_runtime_snapshot,
            commands::agents::agent_connection_snapshot,
            commands::agents::agent_load_session,
            commands::agents::agent_list_session_commands,
            commands::agents::agent_set_auto_approve,
            commands::agents::agent_connect,
            commands::agents::agent_new_session,
            commands::agents::agent_resume_session,
            commands::agents::agent_send_prompt,
            commands::agents::agent_reset_to_checkpoint,
            commands::agents::agent_cancel_prompt,
            commands::agents::agent_disconnect,
            commands::agents::agent_respond_permission,
            commands::agents::agent_terminal_snapshot,
            commands::agents::agent_history_sources,
            commands::agents::agent_history_import,
            commands::agents::agent_config_read,
            commands::agents::agent_config_write,
            commands::agents::agent_mcp_list,
            commands::agents::agent_mcp_write,
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
            commands::agent_skills::list_agent_skills,
            commands::agent_skills::read_agent_skill,
            commands::agent_skills::save_agent_skill,
            commands::agent_skills::delete_agent_skill,
            commands::agent_skills::scan_local_skills,
            commands::agent_skills::read_local_skill,
            commands::agent_skills::search_skill_market,
            commands::agent_skills::get_market_skill_detail,
            commands::agent_skills::install_market_skill,
            commands::agent_skills::set_skill_hosting,
            commands::agent_skills::uninstall_skill,
            // Local usage commands
            commands::local_usage::get_project_usage_statistics,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            // Flush the non-blocking log writer on exit before the process leaves.
            if let tauri::RunEvent::Exit = event {
                log_guard.take();
            }
        });
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
