use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemBundlePluginManifest {
    pub id: &'static str,
    pub package_name: &'static str,
    pub plane: &'static str,
    pub version: &'static str,
    pub bundle: &'static str,
    pub locked: bool,
    pub commands: &'static [&'static str],
}

pub const SYSTEM_BUNDLE_PLUGIN_MANIFESTS: &[SystemBundlePluginManifest] = &[
    SystemBundlePluginManifest {
        id: "vibex.core.plugin-manager",
        package_name: "@vibex/core-plugin-manager",
        plane: "boot",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "plugin_control_catalog",
            "plugin_product_detail",
            "plugin_save_config",
            "plugin_contribution_catalog",
            "plugin_control_set_enabled",
            "plugin_control_grant_permissions",
            "plugin_control_install_runtime",
            "plugin_control_import",
            "plugin_control_import_cli",
            "plugin_marketplace_catalog",
            "plugin_marketplace_listing",
            "plugin_marketplace_install",
            "plugin_check_updates",
            "plugin_control_logs",
            "plugin_control_diagnostics",
            "plugin_control_uninstall",
            "plugin_control_gc_runtimes",
            "plugin_command_invoke",
            "plugin_host_call",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.hmr",
        package_name: "@vibex/core-hmr",
        plane: "boot",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "plugin_control_logs",
            "plugin_control_diagnostics",
            "plugin_surface_open",
            "plugin_surface_invoke",
            "plugin_surface_revoke",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.settings",
        package_name: "@vibex/core-settings",
        plane: "boot",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "get_user_system_info",
            "update_config",
            "get_frontend_preferences",
            "update_frontend_preferences",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.credentials",
        package_name: "@vibex/core-credentials",
        plane: "boot",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "agent_auth_mode",
            "agent_auth_mode_set",
            "pi_credentials_save",
            "codex_request_device_code",
            "codex_poll_device_code",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.agent-runtime",
        package_name: "@vibex/core-agent-runtime",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "agent_management_bar",
            "agent_capability_catalog",
            "agent_capability_catalog_fresh",
            "agent_refresh_capability_catalog",
            "agent_connect",
            "agent_prepare_session",
            "agent_new_session",
            "agent_resume_session",
            "agent_send_prompt",
            "agent_cancel_prompt",
            "agent_disconnect",
            "agent_respond_permission",
            "agent_runtime_snapshot",
            "agent_connection_snapshot",
            "agent_load_session",
            "agent_list_session_commands",
            "agent_registry_view",
            "agent_registry_refresh",
            "agent_plan_usage",
            "enhance_prompt",
            "cancel_enhance_prompt",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.session",
        package_name: "@vibex/core-session",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "conversation_detail",
            "conversation_events_since",
            "conversation_ensure_session_controls",
            "conversation_touch",
            "conversation_timeline_page",
            "conversation_timeline_image",
            "conversation_rebind_session",
            "conversation_truncate_to_turn",
            "conversation_search",
            "conversation_export_markdown",
            "conversation_export_html",
            "conversation_export",
            "conversation_close",
            "conversation_checkpoint_preview",
            "conversation_import",
            "conversation_fork",
            "get_scratch",
            "create_scratch",
            "update_scratch",
            "delete_scratch",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.llm-providers",
        package_name: "@vibex/core-llm-providers",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "provider_catalog_list",
            "agent_model_providers",
            "agent_model_provider_save",
            "agent_model_provider_delete",
            "agent_model_provider_bind",
            "agent_model_provider_catalog",
            "agent_model_provider_probe",
            "agent_model_provider_import",
            "agent_model_provider_import_preview",
            "codex_model_catalog",
            "codex_model_catalog_apply",
            "codex_model_catalog_config",
            "cursor_model_catalog",
            "kimi_model_catalog",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.skills",
        package_name: "@vibex/core-skills",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "list_agent_skills",
            "scan_local_skills",
            "read_local_skill",
            "search_skill_market",
            "get_market_skill_detail",
            "install_market_skill",
            "set_skill_hosting",
            "uninstall_skill",
            "read_agent_skill",
            "save_agent_skill",
            "delete_agent_skill",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.mcp",
        package_name: "@vibex/core-mcp",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "official_product_mcp_state",
            "plugin_mcp_status",
            "plugin_mcp_ensure_running",
            "plugin_control_configure_mcp",
            "mcp_scan_local",
            "mcp_list_marketplaces",
            "mcp_search_marketplace",
            "mcp_get_marketplace_server_detail",
            "mcp_install_marketplace_server",
            "mcp_upsert_local_server",
            "mcp_uninstall_server",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.delegation",
        package_name: "@vibex/core-delegation",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &["collaboration_call", "delegation_cancel"],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.compaction",
        package_name: "@vibex/core-compaction",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "conversation_truncate_to_turn",
            "conversation_checkpoint_preview",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.approval",
        package_name: "@vibex/core-approval",
        plane: "agent",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &["agent_respond_permission", "plugin_resolve_provider_bind"],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.shell",
        package_name: "@vibex/core-shell",
        plane: "execution",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "agent_list_live_terminals",
            "agent_terminal_snapshot",
            "create_terminal",
            "write_terminal",
            "resize_terminal",
            "close_terminal",
            "attach_terminal",
            "terminal_snapshot",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.workspace-git",
        package_name: "@vibex/core-workspace-git",
        plane: "execution",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "get_projects",
            "get_project_repositories",
            "get_repo_branches",
            "create_workspace",
            "update_workspace",
            "delete_workspace",
            "mark_workspace_seen",
            "get_workspace_children",
            "get_workspace_branch_status",
            "get_workspace_commit_history",
            "get_workspace_commit_graph",
            "get_workspace_commit_diffs",
            "push_workspace_branch",
            "pull_workspace_branch",
            "fetch_workspace",
            "merge_workspace",
            "rebase_workspace",
            "rebase_back_workspace",
            "continue_rebase_workspace",
            "abort_conflicts_workspace",
            "stash_workspace",
            "list_workspace_stashes",
            "apply_workspace_stash",
            "pop_workspace_stash",
            "drop_workspace_stash",
            "rename_workspace_branch",
            "change_workspace_target_branch",
            "update_repo",
            "push_repo",
            "pull_repo",
            "fetch_repo",
            "get_repo_remotes",
            "add_repo_remote",
            "remove_repo_remote",
            "set_repo_remote_url",
            "get_repo_commit_detail",
            "get_repo_commit_diffs",
            "search_repo",
            "list_repo_issues",
            "list_open_prs",
            "get_project_worktree_settings",
            "update_project_worktree_settings",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.filesystem",
        package_name: "@vibex/core-filesystem",
        plane: "execution",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "artifact_list",
            "artifact_open_preview",
            "artifact_close_preview",
            "plugin_resolve_file_opener",
            "plugin_open_file_preview",
            "plugin_close_file_preview",
            "plugin_renew_file_preview",
            "read_binary_asset",
            "trash_item",
            "get_file_tree",
            "read_file_content",
            "save_file_content",
            "delete_file",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.automation",
        package_name: "@vibex/core-automation",
        plane: "execution",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "automation_list",
            "automation_engine_status",
            "automation_create",
            "automation_create_workflow",
            "automation_update",
            "automation_update_workflow",
            "automation_set_enabled",
            "automation_delete",
            "automation_run_now",
            "automation_cancel_run",
            "automation_runs",
            "automation_preview_next_runs",
            "automation_templates",
            "automation_unseen_failures",
            "automation_mark_seen",
            "automation_export_spec",
            "automation_import_spec",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.core.channels",
        package_name: "@vibex/core-channels",
        plane: "execution",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "get_chat_event_webhooks",
            "set_chat_event_webhooks",
            "get_chat_message_language",
            "set_chat_message_language",
            "weixin_get_qrcode",
            "weixin_check_qrcode",
            "list_chat_channels",
            "create_chat_channel",
            "update_chat_channel",
            "delete_chat_channel",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.webui.layout",
        package_name: "@vibex/webui-layout",
        plane: "webui",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "get_frontend_preferences",
            "update_frontend_preferences",
            "attention_inbox_list",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.webui.conversation",
        package_name: "@vibex/webui-conversation",
        plane: "webui",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "conversation_detail",
            "conversation_timeline_page",
            "conversation_search",
            "enhance_prompt",
            "cancel_enhance_prompt",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.webui.kanban",
        package_name: "@vibex/webui-kanban",
        plane: "webui",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &[
            "get_task",
            "create_task",
            "create_task_and_start",
            "update_task",
            "delete_task",
            "get_tags",
            "create_tag",
            "update_tag",
            "delete_tag",
        ],
    },
    SystemBundlePluginManifest {
        id: "vibex.webui.commands",
        package_name: "@vibex/webui-commands",
        plane: "webui",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &["plugin_action_catalog", "plugin_command_invoke"],
    },
    SystemBundlePluginManifest {
        id: "vibex.webui.theme",
        package_name: "@vibex/webui-theme",
        plane: "webui",
        version: "2.0.0",
        bundle: "system",
        locked: true,
        commands: &["get_frontend_preferences", "update_frontend_preferences"],
    },
];

pub fn system_bundle_plugin_manifests() -> &'static [SystemBundlePluginManifest] {
    SYSTEM_BUNDLE_PLUGIN_MANIFESTS
}

pub fn system_bundle_plugin_manifest(
    plugin_id: &str,
) -> Option<&'static SystemBundlePluginManifest> {
    let trimmed = plugin_id.trim();
    SYSTEM_BUNDLE_PLUGIN_MANIFESTS
        .iter()
        .find(|manifest| manifest.id == trimmed)
}

pub fn is_system_bundle_plugin_id(plugin_id: &str) -> bool {
    system_bundle_plugin_manifest(plugin_id).is_some()
}

/// Resolves a System Bundle `<plugin_id>` and `<command_name>` (either full
/// `DomainCommand` snake_case or domain-scoped short operation alias) into the
/// canonical `DomainCommand` snake_case name.
pub fn resolve_system_bundle_domain_command(
    plugin_id: &str,
    command_name: &str,
) -> Option<&'static str> {
    let manifest = system_bundle_plugin_manifest(plugin_id)?;
    let normalized = command_name.trim().replace(['-', '.'], "_");
    if normalized.is_empty() {
        return None;
    }
    if let Some(exact) = manifest.commands.iter().find(|&&cmd| cmd == normalized) {
        return Some(*exact);
    }

    let alias = match (manifest.id, normalized.as_str()) {
        ("vibex.core.workspace-git", "project_list" | "list_projects" | "projects") => {
            Some("get_projects")
        }
        ("vibex.core.workspace-git", "project_repositories" | "repositories") => {
            Some("get_project_repositories")
        }
        ("vibex.core.workspace-git", "repo_branches" | "branches") => Some("get_repo_branches"),
        ("vibex.core.workspace-git", "workspace_branch_status" | "branch_status" | "status") => {
            Some("get_workspace_branch_status")
        }
        ("vibex.core.workspace-git", "workspace_commit_history" | "commit_history" | "history") => {
            Some("get_workspace_commit_history")
        }
        ("vibex.core.workspace-git", "workspace_commit_graph" | "commit_graph" | "graph") => {
            Some("get_workspace_commit_graph")
        }
        ("vibex.core.workspace-git", "workspace_push" | "push") => Some("push_workspace_branch"),
        ("vibex.core.workspace-git", "workspace_pull" | "pull") => Some("pull_workspace_branch"),
        ("vibex.core.workspace-git", "workspace_fetch" | "fetch") => Some("fetch_workspace"),
        ("vibex.core.workspace-git", "workspace_merge" | "merge") => Some("merge_workspace"),
        ("vibex.core.workspace-git", "workspace_rebase" | "rebase") => Some("rebase_workspace"),
        ("vibex.core.automation", "list") => Some("automation_list"),
        ("vibex.core.automation", "engine_status" | "status") => Some("automation_engine_status"),
        ("vibex.core.automation", "create") => Some("automation_create"),
        ("vibex.core.automation", "create_workflow") => Some("automation_create_workflow"),
        ("vibex.core.automation", "update") => Some("automation_update"),
        ("vibex.core.automation", "set_enabled") => Some("automation_set_enabled"),
        ("vibex.core.automation", "delete") => Some("automation_delete"),
        ("vibex.core.automation", "run_now") => Some("automation_run_now"),
        ("vibex.core.automation", "cancel_run") => Some("automation_cancel_run"),
        ("vibex.core.automation", "runs") => Some("automation_runs"),
        ("vibex.core.automation", "preview" | "preview_next_runs") => {
            Some("automation_preview_next_runs")
        }
        ("vibex.core.automation", "templates") => Some("automation_templates"),
        ("vibex.core.automation", "unseen_failures") => Some("automation_unseen_failures"),
        ("vibex.core.automation", "mark_seen") => Some("automation_mark_seen"),
        ("vibex.core.automation", "export_spec") => Some("automation_export_spec"),
        ("vibex.core.automation", "import_spec") => Some("automation_import_spec"),
        ("vibex.core.session", "detail") => Some("conversation_detail"),
        ("vibex.core.session", "events_since") => Some("conversation_events_since"),
        ("vibex.core.session", "touch") => Some("conversation_touch"),
        ("vibex.core.session", "timeline_page") => Some("conversation_timeline_page"),
        ("vibex.core.session", "search") => Some("conversation_search"),
        ("vibex.core.session", "export_markdown") => Some("conversation_export_markdown"),
        ("vibex.core.session", "export_html") => Some("conversation_export_html"),
        ("vibex.core.session", "export") => Some("conversation_export"),
        ("vibex.core.session", "close") => Some("conversation_close"),
        ("vibex.core.session", "fork") => Some("conversation_fork"),
        ("vibex.core.session", "scratch_get") => Some("get_scratch"),
        ("vibex.core.session", "scratch_create") => Some("create_scratch"),
        ("vibex.core.session", "scratch_update") => Some("update_scratch"),
        ("vibex.core.session", "scratch_delete") => Some("delete_scratch"),
        ("vibex.core.skills", "agent_skills_list" | "list" | "skills") => Some("list_agent_skills"),
        ("vibex.core.agent-runtime", "management_bar" | "list") => Some("agent_management_bar"),
        ("vibex.core.agent-runtime", "capability_catalog") => Some("agent_capability_catalog"),
        ("vibex.core.agent-runtime", "capability_catalog_fresh") => {
            Some("agent_capability_catalog_fresh")
        }
        ("vibex.core.agent-runtime", "refresh_capability_catalog") => {
            Some("agent_refresh_capability_catalog")
        }
        ("vibex.core.agent-runtime", "enhance") => Some("enhance_prompt"),
        ("vibex.core.agent-runtime", "cancel_enhance" | "cancel_prompt_enhancement") => {
            Some("cancel_enhance_prompt")
        }
        ("vibex.core.channels", "get_webhooks" | "webhooks") => Some("get_chat_event_webhooks"),
        ("vibex.core.channels", "set_webhooks") => Some("set_chat_event_webhooks"),
        ("vibex.core.channels", "get_language" | "language") => Some("get_chat_message_language"),
        ("vibex.core.channels", "set_language") => Some("set_chat_message_language"),
        ("vibex.core.channels", "list") => Some("list_chat_channels"),
        ("vibex.core.settings", "user_system_info" | "system_info" | "info") => {
            Some("get_user_system_info")
        }
        ("vibex.core.settings", "frontend_preferences_get") => Some("get_frontend_preferences"),
        ("vibex.core.settings", "frontend_preferences_update") => {
            Some("update_frontend_preferences")
        }
        ("vibex.core.mcp", "status") => Some("plugin_mcp_status"),
        ("vibex.core.mcp", "ensure_running") => Some("plugin_mcp_ensure_running"),
        ("vibex.core.mcp", "state") => Some("official_product_mcp_state"),
        ("vibex.core.delegation", "call") => Some("collaboration_call"),
        ("vibex.core.delegation", "cancel") => Some("delegation_cancel"),
        ("vibex.core.filesystem", "artifacts") => Some("artifact_list"),
        ("vibex.core.plugin-manager", "catalog") => Some("plugin_control_catalog"),
        ("vibex.core.plugin-manager", "contributions") => Some("plugin_contribution_catalog"),
        ("vibex.webui.conversation", "enhance") => Some("enhance_prompt"),
        ("vibex.webui.conversation", "cancel_enhance" | "cancel_prompt_enhancement") => {
            Some("cancel_enhance_prompt")
        }
        ("vibex.webui.kanban", "task_get") => Some("get_task"),
        ("vibex.webui.kanban", "task_create") => Some("create_task"),
        ("vibex.webui.kanban", "task_create_and_start") => Some("create_task_and_start"),
        ("vibex.webui.kanban", "task_update") => Some("update_task"),
        ("vibex.webui.kanban", "task_delete") => Some("delete_task"),
        ("vibex.webui.kanban", "tag_list") => Some("get_tags"),
        ("vibex.webui.kanban", "tag_create") => Some("create_tag"),
        ("vibex.webui.kanban", "tag_update") => Some("update_tag"),
        ("vibex.webui.kanban", "tag_delete") => Some("delete_tag"),
        _ => None,
    };
    if alias.is_some() {
        return alias;
    }

    for candidate in SYSTEM_BUNDLE_PLUGIN_MANIFESTS {
        if let Some(found) = candidate.commands.iter().find(|&&cmd| cmd == normalized) {
            return Some(*found);
        }
    }
    None
}
