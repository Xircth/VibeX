use std::{collections::HashMap, path::Path};

use agents::{AgentCapability, agent_capabilities};
use db::models::execution_process::ExecutionProcess;
use executors::profile::ExecutorConfigs;
use serde::{Deserialize, Serialize};
use serde_json::json;
use services::services::{
    config::{
        Config, SoundFile,
        editor::{EditorConfig, EditorType},
        load_config_from_file, save_config_to_file,
    },
    worktree_manager::WorktreeManager,
};
use sqlx::Acquire;
use tauri::Emitter;

use crate::{error::AppError, state::AppState};

mod claude_settings;

pub use claude_settings::ClaudeSettings;
// MCP marketplace + prompt-enhancement logic now lives in `crates/services`
// (架构报告 A-1); re-export the frontend-facing types so the command signatures
// below stay unchanged.
pub use services::services::mcp::{
    LocalMcpServer, McpAppType, McpMarketplaceInstallOption, McpMarketplaceInstallParameter,
    McpMarketplaceItem, McpMarketplaceProvider, McpMarketplaceServerDetail,
};
pub use services::services::prompt_enhancement::{
    PromptEnhancementContextMessage, PromptEnhancementRequest, PromptEnhancementResponse,
};

/// Models available to prompt enhancement, merged from fingerprint-matching
/// persisted capability catalogs without starting a second runtime.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnhancementModelsResponse {
    pub models: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Environment {
    pub os_type: String,
    pub os_version: String,
    pub os_architecture: String,
    pub bitness: String,
}

impl Environment {
    pub fn new() -> Self {
        let info = os_info::get();
        Environment {
            os_type: info.os_type().to_string(),
            os_version: info.version().to_string(),
            os_architecture: info.architecture().unwrap_or("unknown").to_string(),
            bitness: info.bitness().to_string(),
        }
    }
}

impl Default for Environment {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserSystemInfo {
    pub config: Config,
    #[serde(flatten)]
    pub profiles: ExecutorConfigs,
    pub environment: Environment,
    pub capabilities: HashMap<String, Vec<AgentCapability>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProfilesContent {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClearLocalDataResponse {
    pub cleared: bool,
    pub requires_reload: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckEditorAvailabilityResponse {
    pub available: bool,
}

#[tauri::command]
pub async fn get_user_system_info(
    state: tauri::State<'_, AppState>,
) -> Result<UserSystemInfo, AppError> {
    // Re-read on every public settings query so direct edits made by a user or
    // agent become visible without restarting VibeX.
    let config = load_config_from_file(&utils::assets::settings_path()).await;
    {
        let mut current = state.deployment.config().write().await;
        *current = config.clone();
    }
    WorktreeManager::set_workspace_dir_override(
        config
            .workspace_dir
            .as_ref()
            .map(|workspace_dir| utils::path::expand_tilde(workspace_dir)),
    );

    let profiles = ExecutorConfigs::get_cached();
    let capabilities = {
        let mut caps: HashMap<String, Vec<AgentCapability>> = HashMap::new();
        let profs = ExecutorConfigs::get_cached();
        for key in profs.executors.keys() {
            caps.insert(key.to_string(), agent_capabilities());
        }
        caps
    };

    Ok(UserSystemInfo {
        config,
        profiles,
        environment: Environment::new(),
        capabilities,
    })
}

#[tauri::command]
pub async fn update_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    new_config: Config,
) -> Result<Config, AppError> {
    let config_path = utils::assets::settings_path();
    let previous_theme = state.deployment.config().read().await.theme.clone();

    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return Err(AppError::BadRequest(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes."
                .to_string(),
        ));
    }

    save_config_to_file(&new_config, &config_path).await?;

    let mut config = state.deployment.config().write().await;
    *config = new_config.clone();
    drop(config);

    let workspace_dir_override = new_config
        .workspace_dir
        .as_ref()
        .map(|workspace_dir| utils::path::expand_tilde(workspace_dir));
    WorktreeManager::set_workspace_dir_override(workspace_dir_override);

    if std::mem::discriminant(&previous_theme) != std::mem::discriminant(&new_config.theme) {
        app.emit(
            "theme-changed",
            json!({ "theme": new_config.theme.clone() }),
        )
        .map_err(|e| AppError::Internal(format!("Failed to emit theme change: {}", e)))?;
    }

    Ok(new_config)
}

fn remove_path_if_exists(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|error| {
            AppError::Internal(format!(
                "Failed to remove directory {}: {error}",
                path.display()
            ))
        })?;
    } else {
        std::fs::remove_file(path).map_err(|error| {
            AppError::Internal(format!("Failed to remove file {}: {error}", path.display()))
        })?;
    }

    Ok(())
}

async fn clear_database_rows(pool: &sqlx::SqlitePool) -> Result<(), AppError> {
    let mut connection = pool.acquire().await?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await?;

    let clear_result: Result<(), AppError> = async {
        let mut tx = connection.begin().await?;

        // Virtual tables are derived indexes, and deleting their shadow tables directly can
        // corrupt them before SQLite gets a chance to clear the virtual table itself. Capture
        // their schemas, remove them first, then recreate them after the authoritative tables
        // have been cleared.
        let virtual_tables: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, sql FROM sqlite_master \
             WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
        )
        .fetch_all(&mut *tx)
        .await?;

        for (table_name, create_sql) in &virtual_tables {
            let escaped_name = table_name.replace('"', "\"\"");

            // Older reset attempts could empty the FTS5 config shadow table before failing.
            // SQLite refuses to drop such an index until its format version is restored.
            if create_sql.to_ascii_lowercase().contains("using fts5") {
                let config_name = format!("{table_name}_config").replace('"', "\"\"");
                let version_query =
                    format!("SELECT v FROM \"{config_name}\" WHERE k = 'version'");
                let version = sqlx::query_scalar::<_, i64>(&version_query)
                    .fetch_optional(&mut *tx)
                    .await;

                if !matches!(version, Ok(Some(4 | 5))) {
                    let repair_query = format!(
                        "INSERT OR REPLACE INTO \"{config_name}\"(k, v) VALUES('version', 4)"
                    );
                    sqlx::query(&repair_query).execute(&mut *tx).await?;
                }
            }

            let statement = format!("DROP TABLE \"{escaped_name}\"");
            sqlx::query(&statement).execute(&mut *tx).await?;
        }

        let table_names: Vec<String> = sqlx::query_scalar::<_, String>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations'",
        )
        .fetch_all(&mut *tx)
        .await?;

        for table_name in table_names {
            let escaped: String = table_name.replace('"', "\"\"");
            let statement = format!("DELETE FROM \"{escaped}\"");
            sqlx::query(&statement).execute(&mut *tx).await?;
        }

        let _ = sqlx::query("DELETE FROM sqlite_sequence")
            .execute(&mut *tx)
            .await;

        for (_, create_sql) in virtual_tables {
            sqlx::query(&create_sql).execute(&mut *tx).await?;
        }

        tx.commit().await?;
        Ok(())
    }
    .await;

    let restore_result = sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await;
    if restore_result.is_err() {
        connection.close_on_drop();
    }
    restore_result
        .map_err(|error| AppError::Internal(format!("Failed to restore foreign keys: {error}")))?;
    clear_result?;
    drop(connection);

    let _ = sqlx::query("VACUUM").execute(pool).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_local_app_data(
    state: tauri::State<'_, AppState>,
) -> Result<ClearLocalDataResponse, AppError> {
    let pool = &state.deployment.db().pool;
    let running_processes = ExecutionProcess::find_running(pool).await?;
    if !running_processes.is_empty() {
        state
            .deployment
            .container()
            .kill_all_running_processes()
            .await?;

        let still_running = ExecutionProcess::find_running(pool).await?;
        if !still_running.is_empty() {
            return Err(AppError::Conflict(
                "Some running processes could not be stopped. Please stop them manually and try again."
                    .to_string(),
            ));
        }
    }

    remove_path_if_exists(&utils::assets::profiles_path())?;
    if let Err(error) = remove_path_if_exists(&utils::cache_dir()) {
        tracing::warn!("Failed to clear cache directory during local data reset: {error}");
    }
    ExecutorConfigs::reload();

    clear_database_rows(pool).await?;

    let default_config = Config::default();
    remove_path_if_exists(&utils::assets::settings_path())?;
    save_config_to_file(&default_config, &utils::assets::settings_path()).await?;
    {
        let mut config = state.deployment.config().write().await;
        *config = default_config;
    }
    WorktreeManager::set_workspace_dir_override(None);

    state.file_tree_watchers.lock().await.clear();
    state.conversation_streams.lock().await.clear();
    state.local_usage_cache.lock().await.clear();
    state.agent_management_runtime.reset().await;
    *state.desktop_toast_state.lock().await = Default::default();

    Ok(ClearLocalDataResponse {
        cleared: true,
        requires_reload: true,
    })
}

#[tauri::command]
pub async fn get_profiles(state: tauri::State<'_, AppState>) -> Result<ProfilesContent, AppError> {
    let _ = state;
    let profiles_path = utils::assets::profiles_path();

    let profiles = ExecutorConfigs::get_cached();
    let content = serde_json::to_string_pretty(&profiles).unwrap_or_else(|e| {
        tracing::error!("Failed to serialize profiles to JSON: {}", e);
        serde_json::to_string_pretty(&ExecutorConfigs::from_defaults())
            .unwrap_or_else(|_| "{}".to_string())
    });

    Ok(ProfilesContent {
        content,
        path: profiles_path.display().to_string(),
    })
}

#[tauri::command]
pub async fn update_profiles(
    state: tauri::State<'_, AppState>,
    body: String,
) -> Result<String, AppError> {
    let _ = state;

    let executor_profiles: ExecutorConfigs = serde_json::from_str(&body)
        .map_err(|e| AppError::BadRequest(format!("Invalid executor profiles format: {}", e)))?;

    executor_profiles.save_overrides().map_err(|e| {
        tracing::error!("Failed to save executor profiles: {}", e);
        AppError::Internal(format!("Failed to save executor profiles: {}", e))
    })?;

    tracing::info!("Executor profiles saved successfully");
    ExecutorConfigs::reload();

    Ok("Executor profiles updated successfully".to_string())
}

#[tauri::command]
pub async fn check_editor_availability(
    state: tauri::State<'_, AppState>,
    editor_type: EditorType,
) -> Result<CheckEditorAvailabilityResponse, AppError> {
    let _ = state;

    let editor_config = EditorConfig::new(editor_type, None, None, None);
    let available = editor_config.check_availability().await;

    Ok(CheckEditorAvailabilityResponse { available })
}

#[tauri::command]
pub async fn play_notification_sound(
    state: tauri::State<'_, AppState>,
    sound_file: SoundFile,
) -> Result<(), AppError> {
    let _ = state;

    let file_path = sound_file
        .get_path()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve sound file: {}", e)))?;

    if cfg!(target_os = "macos") {
        let _ = utils::process::new_hidden_tokio_command("afplay", [&file_path]).spawn();
    } else if cfg!(target_os = "linux") && !utils::is_wsl2() {
        let _ = utils::process::new_hidden_tokio_command("paplay", [&file_path])
            .spawn()
            .or_else(|_| utils::process::new_hidden_tokio_command("aplay", [&file_path]).spawn());
    } else {
        let file_path = file_path.to_string_lossy().replace('\'', "''");
        let script = format!("(New-Object Media.SoundPlayer '{file_path}').PlaySync()");
        let _ = utils::process::new_hidden_tokio_command(
            "powershell.exe",
            ["-NoProfile", "-Command", &script],
        )
        .spawn();
    }

    Ok(())
}

#[tauri::command]
pub async fn enhance_prompt(
    state: tauri::State<'_, AppState>,
    payload: PromptEnhancementRequest,
) -> Result<PromptEnhancementResponse, AppError> {
    crate::prompt_enhancement::enhance_prompt(&state, payload).await
}

#[tauri::command]
pub async fn list_prompt_enhancement_models(
    state: tauri::State<'_, AppState>,
) -> Result<PromptEnhancementModelsResponse, AppError> {
    Ok(PromptEnhancementModelsResponse {
        models: crate::commands::agents::prompt_enhancement_capability_catalog_models(
            &state.deployment.db().pool,
        )
        .await?,
    })
}

#[tauri::command]
pub async fn get_claude_settings(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeSettings, AppError> {
    claude_settings::get_claude_settings(state).await
}

#[tauri::command]
pub async fn update_claude_settings(
    state: tauri::State<'_, AppState>,
    settings: ClaudeSettings,
) -> Result<ClaudeSettings, AppError> {
    claude_settings::update_claude_settings(state, settings).await
}

// ── MCP marketplace + global hosting ───────────────────────────────────────

async fn saved_mcp_agent_environment(
    state: &AppState,
) -> Result<HashMap<String, String>, AppError> {
    let documents = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE env_json IS NOT NULL",
    )
    .fetch_all(&state.deployment.db().pool)
    .await?;
    let mut merged = HashMap::new();
    for document in documents.into_iter().flatten() {
        let values: HashMap<String, String> = serde_json::from_str(&document)
            .map_err(|error| AppError::Internal(error.to_string()))?;
        for (key, value) in values {
            if matches!(
                key.as_str(),
                "CLAUDE_CONFIG_DIR"
                    | "CODEX_HOME"
                    | "GEMINI_CLI_HOME"
                    | "OPENCLAW_HOME"
                    | "XDG_CONFIG_HOME"
                    | "XDG_DATA_HOME"
                    | "XDG_CACHE_HOME"
                    | "CLINE_DIR"
                    | "HERMES_HOME"
                    | "CODEBUDDY_CONFIG_DIR"
                    | "KIMI_CODE_HOME"
                    | "GROK_HOME"
                    | "CURSOR_CONFIG_DIR"
            ) && !value.trim().is_empty()
            {
                merged.insert(key, value);
            }
        }
    }
    Ok(merged)
}

#[tauri::command]
pub async fn mcp_scan_local(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalMcpServer>, AppError> {
    Ok(services::services::mcp::with_saved_agent_environment(
        saved_mcp_agent_environment(&state).await?,
        services::services::mcp::scan_local(),
    )
    .await?)
}

#[tauri::command]
pub async fn mcp_list_marketplaces() -> Result<Vec<McpMarketplaceProvider>, AppError> {
    Ok(services::services::mcp::list_marketplaces().await?)
}

#[tauri::command]
pub async fn mcp_search_marketplace(
    provider_id: String,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<McpMarketplaceItem>, AppError> {
    Ok(services::services::mcp::search_marketplace(provider_id, query, limit).await?)
}

#[tauri::command]
pub async fn mcp_get_marketplace_server_detail(
    provider_id: String,
    server_id: String,
) -> Result<McpMarketplaceServerDetail, AppError> {
    Ok(services::services::mcp::get_marketplace_server_detail(provider_id, server_id).await?)
}

#[tauri::command]
// Tauri exposes these marketplace fields as a stable named IPC payload; the
// AppState argument is injected by Tauri and is not part of the wire contract.
#[allow(clippy::too_many_arguments)]
pub async fn mcp_install_marketplace_server(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    server_id: String,
    global: bool,
    apps: Vec<McpAppType>,
    option_id: Option<String>,
    parameter_values: Option<serde_json::Value>,
    spec_override: Option<serde_json::Value>,
) -> Result<Vec<LocalMcpServer>, AppError> {
    Ok(services::services::mcp::with_saved_agent_environment(
        saved_mcp_agent_environment(&state).await?,
        services::services::mcp::install_marketplace_server(
            provider_id,
            server_id,
            global,
            apps,
            option_id,
            parameter_values,
            spec_override,
        ),
    )
    .await?)
}

#[tauri::command]
pub async fn mcp_upsert_local_server(
    state: tauri::State<'_, AppState>,
    server_id: String,
    spec: serde_json::Value,
    global: bool,
    apps: Vec<McpAppType>,
) -> Result<Vec<LocalMcpServer>, AppError> {
    Ok(services::services::mcp::with_saved_agent_environment(
        saved_mcp_agent_environment(&state).await?,
        services::services::mcp::upsert_local_server(server_id, spec, global, apps),
    )
    .await?)
}

#[tauri::command]
pub async fn mcp_uninstall_server(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<Vec<LocalMcpServer>, AppError> {
    Ok(services::services::mcp::with_saved_agent_environment(
        saved_mcp_agent_environment(&state).await?,
        services::services::mcp::uninstall_server(server_id),
    )
    .await?)
}

#[cfg(test)]
mod tests {
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };

    use super::clear_database_rows;

    async fn seeded_pool() -> (tempfile::TempDir, SqlitePool) {
        let temp = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(temp.path().join("reset.sqlite"))
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE durable_data(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO durable_data(value) VALUES('must be cleared')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE VIRTUAL TABLE conversation_fts USING fts5(\
             body, conversation_id UNINDEXED, workspace_id UNINDEXED, \
             title UNINDEXED, tokenize = 'trigram')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_fts(body, conversation_id, workspace_id, title) \
             VALUES('searchable text', 'conversation', 'workspace', 'title')",
        )
        .execute(&pool)
        .await
        .unwrap();

        (temp, pool)
    }

    async fn assert_database_was_cleared(pool: &SqlitePool) {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM durable_data")
                .fetch_one(pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM conversation_fts")
                .fetch_one(pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(pool)
                .await
                .unwrap(),
            "ok"
        );
    }

    #[tokio::test]
    async fn local_data_clear_rebuilds_an_intact_fts_index() {
        let (_temp, pool) = seeded_pool().await;

        clear_database_rows(&pool).await.unwrap();

        assert_database_was_cleared(&pool).await;
    }

    #[tokio::test]
    async fn local_data_clear_recovers_a_partially_cleared_fts_index() {
        let (_temp, pool) = seeded_pool().await;

        // Reproduces the state left by the previous reset implementation: it deleted FTS
        // shadow rows before asking the virtual table to clear itself.
        sqlx::query("DELETE FROM conversation_fts_content")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM conversation_fts_docsize")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM conversation_fts_config")
            .execute(&pool)
            .await
            .unwrap();
        clear_database_rows(&pool).await.unwrap();

        assert_database_was_cleared(&pool).await;
    }
}
