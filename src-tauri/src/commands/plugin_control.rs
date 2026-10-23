use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use plugins::NativePluginAdapter;
use tauri::{AppHandle, Manager};

use crate::{error::AppError, state::AppState};

pub(crate) async fn refresh_official_product_runtime(
    plane: &plugins::PluginControlPlane,
    broker: &delegation::DelegationBroker,
    config: &services::services::config::Config,
) -> Result<(), AppError> {
    server::refresh_official_product_runtime(plane, broker, config)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

async fn apply_official_product_runtime(state: &AppState) -> Result<(), AppError> {
    let config = state.deployment.config().read().await.clone();
    refresh_official_product_runtime(
        &state.plugin_control_plane,
        &state.delegation.broker,
        &config,
    )
    .await
}

pub async fn import_cli_inbox(app: AppHandle) -> Result<(), AppError> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let inbox = home.join(".vibex").join("imports");
    let Ok(entries) = std::fs::read_dir(&inbox) else {
        return Ok(());
    };
    let state = app.state::<AppState>();
    let _ = state
        .plugin_control_plane
        .import_queued_developer_links()
        .await;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_cli_inbox_package(&path) {
            continue;
        }
        let marker = cli_inbox_marker(&path);
        if marker.exists() {
            continue;
        }
        let lock = read_origin_sidecar(&path);
        let result = import_cli_package(&app, &state, &path, lock).await;
        match result {
            Ok(plugin_id) => {
                tracing::info!(plugin = %plugin_id, path = %path.display(), "imported CLI marketplace package");
                let _ = std::fs::write(&marker, format!("{plugin_id}\n"));
            }
            Err(AppError::Conflict(_)) => {
                let _ = std::fs::write(&marker, "installed\n");
            }
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "CLI marketplace package import failed"
                );
            }
        }
    }
    Ok(())
}

async fn import_cli_package(
    app: &AppHandle,
    state: &AppState,
    input: &Path,
    lock: InboxOriginLock,
) -> Result<String, AppError> {
    let source_kind = if plugins::origin_kind(lock.origin.as_deref()) == Some("marketplace") {
        plugins::PluginSourceKind::Marketplace
    } else {
        plugins::PluginSourceKind::Snapshot
    };
    let decision = plugins::ConflictDecision::KeepInstalled;
    let extracted = if input.is_file() {
        Some(extract_plugin_archive(input)?)
    } else {
        None
    };
    let source = extracted
        .as_ref()
        .map(|archive| archive.root.as_path())
        .unwrap_or(input);
    if !source.join(".vibex-plugin/plugin.json").is_file() {
        return import_native_plugin(source, source_kind, decision).await;
    }
    let incoming = plugins::PluginPackage::inspect(source, source_kind).map_err(plugin_error)?;
    let installed = state
        .plugin_control_plane
        .plugin(incoming.id.as_str())
        .await
        .map_err(plugin_error)?;
    if installed.is_some() {
        return Ok(incoming.id.as_str().to_owned());
    }
    let storage = plugin_snapshot_root(app)?;
    let mut package =
        plugins::PluginPackage::materialize(source, &storage, source_kind).map_err(plugin_error)?;
    package.source.kind = source_kind;
    package.source.origin = lock.origin.or(package.source.origin);
    package.source.git_ref = lock.git_ref.or(package.source.git_ref);
    package.source.git_sha = lock.git_sha.or(package.source.git_sha);
    package.source.locked = lock.locked.unwrap_or(package.source.locked);

    let imported = state
        .plugin_control_plane
        .import(package, decision)
        .await
        .map_err(plugin_error)?;
    let plugin_id = imported.plugin.id().to_owned();
    if let Err(error) = enable_imported_plugin(app, state, &plugin_id).await {
        tracing::warn!(
            plugin = %plugin_id,
            %error,
            "post-import automatic plugin activation failed; keeping plugin installed"
        );
    }
    Ok(plugin_id)
}

async fn enable_imported_plugin(
    app: &AppHandle,
    state: &AppState,
    plugin_id: &str,
) -> Result<(), AppError> {
    let installed = state
        .plugin_control_plane
        .plugin(plugin_id)
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(plugin_id.to_owned()))?;
    let has_worker = installed.package.entrypoints.worker.is_some();
    ensure_package_runtimes(app, state, &installed.package, &installed.package_digest).await?;
    let grants =
        plugins::candidate_capability_grants(&installed.package, &[], &[]).map_err(plugin_error)?;
    state
        .plugin_control_plane
        .validate_runtime_readiness(plugin_id)
        .await
        .map_err(|error| AppError::Conflict(format!("{}: {error}", error.code())))?;
    let plugin = if has_worker {
        let node = state
            .plugin_worker_runtime
            .resolve()
            .await
            .map_err(plugin_error)?;
        state
            .plugin_control_plane
            .activate_and_enable(
                &node,
                plugin_id,
                &grants,
                state.plugin_capability_broker.clone(),
            )
            .await
            .map_err(|error| AppError::Internal(format!("{}: {error}", error.code())))?
    } else {
        state
            .plugin_control_plane
            .set_enabled(plugin_id, true)
            .await
            .map_err(plugin_error)?
    };
    apply_official_product_runtime(state).await?;
    configure_plugin_default_projections(state, &plugin).await
}

fn is_cli_inbox_package(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if name.ends_with(".imported") {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".vxp") || lower.ends_with(".zip")
}

fn read_origin_sidecar(path: &Path) -> InboxOriginLock {
    let sidecar = {
        let mut name = path.as_os_str().to_os_string();
        name.push(".origin.json");
        PathBuf::from(name)
    };
    let Ok(text) = std::fs::read_to_string(sidecar) else {
        return InboxOriginLock::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return InboxOriginLock::default();
    };
    InboxOriginLock {
        origin: value
            .get("origin")
            .and_then(serde_json::Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned),
        git_ref: value
            .get("gitRef")
            .and_then(serde_json::Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned),
        git_sha: value
            .get("gitSha")
            .and_then(serde_json::Value::as_str)
            .filter(|item| !item.is_empty())
            .map(str::to_owned),
        locked: value.get("locked").and_then(serde_json::Value::as_bool),
    }
}

#[derive(Default)]
struct InboxOriginLock {
    origin: Option<String>,
    git_ref: Option<String>,
    git_sha: Option<String>,
    locked: Option<bool>,
}

fn cli_inbox_marker(path: &Path) -> PathBuf {
    let mut marker = path.as_os_str().to_os_string();
    marker.push(".imported");
    PathBuf::from(marker)
}

async fn import_native_plugin(
    source: &Path,
    source_kind: plugins::PluginSourceKind,
    decision: plugins::ConflictDecision,
) -> Result<String, AppError> {
    let adapters = native_import_adapters(source)?;
    let mut imported_id: Option<String> = None;
    for adapter in adapters {
        let descriptor = adapter
            .install(source, source_kind, decision)
            .await
            .map_err(plugin_error)?;
        if let Some(ref current_id) = imported_id {
            if current_id != &descriptor.id {
                return Err(AppError::BadRequest(
                    "co-located native manifests must declare the same plugin ID".to_owned(),
                ));
            }
        } else {
            imported_id = Some(descriptor.id);
        }
    }
    imported_id.ok_or_else(|| {
        AppError::BadRequest(
            "plugin source must contain a VibeX, Codex, or Claude Code manifest".to_owned(),
        )
    })
}

fn native_import_adapters(
    source: &Path,
) -> Result<Vec<plugins::FilesystemNativePluginAdapter>, AppError> {
    let home = dirs::home_dir()
        .ok_or_else(|| AppError::Internal("cannot resolve the user home directory".to_owned()))?;
    let mut adapters = Vec::new();
    if source.join(".codex-plugin/plugin.json").is_file() {
        adapters.push(plugins::FilesystemNativePluginAdapter::codex(
            home.join(".codex/plugins/cache"),
        ));
    }
    if source.join(".claude-plugin/plugin.json").is_file() {
        adapters.push(plugins::FilesystemNativePluginAdapter::claude_code(
            home.join(".claude/plugins/cache"),
        ));
    }
    Ok(adapters)
}

/// Project a Plugin's currently-enabled Skills onto the Agents it is bound to
/// and persist the resulting bindings.
async fn configure_plugin_skill_projections(
    state: &AppState,
    plugin: &plugins::PluginPackage,
) -> Result<(), AppError> {
    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let installed = state
        .agent_management_runtime
        .local_runtimes()
        .await
        .keys()
        .map(|agent| agent.as_str().to_owned())
        .collect::<BTreeSet<_>>();
    let saved_agents = sqlx::query_scalar::<_, String>(
        "SELECT agent_id FROM plugin_agent_bindings_v4
         WHERE plugin_id = ? AND desired = 1",
    )
    .bind(plugin.id.as_str())
    .fetch_all(&state.deployment.db().pool)
    .await?;
    let has_saved_agent_preferences = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM plugin_agent_bindings_v4 WHERE plugin_id = ?",
    )
    .bind(plugin.id.as_str())
    .fetch_one(&state.deployment.db().pool)
    .await?
        > 0;
    let desired_agents = if has_saved_agent_preferences {
        saved_agents.into_iter().collect::<BTreeSet<_>>()
    } else {
        known.clone()
    };
    let targets = desired_agents
        .intersection(&installed)
        .cloned()
        .collect::<Vec<_>>();
    let skill_sources = plugin
        .enabled_skills()
        .map(|skill| (skill.id.clone(), plugin.source.path.join(&skill.path)))
        .collect::<Vec<_>>();
    let projections =
        agents::skills::project_plugin_skills(plugin.id.as_str(), &skill_sources, targets, true)
            .map_err(|error| AppError::Internal(error.to_string()))?;
    persist_agent_bindings(
        state,
        plugin.id.as_str(),
        &known,
        &desired_agents,
        &installed,
        &projections,
    )
    .await
}

/// Project a Plugin's managed MCP servers onto the Agents it is bound to.
async fn configure_plugin_default_mcp(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
) -> Result<(), AppError> {
    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let (_, desired_mcp) = desired_plugin_mcp_agents(state, plugin.id()).await?;
    let all_mcp_agents = desired_mcp == known;
    for error in configure_plugin_mcp(state, plugin, all_mcp_agents, &desired_mcp).await {
        tracing::warn!(plugin_id = plugin.id(), %error, "default MCP projection failed");
    }
    Ok(())
}

async fn configure_plugin_default_projections(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
) -> Result<(), AppError> {
    configure_plugin_skill_projections(state, plugin).await?;
    configure_plugin_default_mcp(state, plugin).await
}

/// Re-materialize enabled plugin projections after Host startup.
///
/// Skill projections are filesystem links into Agent skill directories; they
/// must be replayed because enable can persist while a later projection call
/// fails. Managed MCP specs also contain App-lifetime connection details.
pub(crate) async fn refresh_enabled_plugin_projections(state: &AppState) {
    let plugins = match state.plugin_control_plane.catalog().await {
        Ok(plugins) => plugins,
        Err(error) => {
            tracing::warn!(%error, "enabled plugin projection refresh failed");
            return;
        }
    };
    let _ = apply_official_product_runtime(state).await;
    if let Err(error) = services::services::mcp::patch_grok_product_mcp_startup_timeout() {
        tracing::warn!(%error, "Grok product MCP startup timeout patch failed");
    }
    for plugin in plugins
        .iter()
        .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
    {
        if let Err(error) = configure_plugin_default_projections(state, plugin).await {
            tracing::warn!(
                plugin_id = plugin.id(),
                %error,
                "enabled plugin projection refresh failed"
            );
        }
    }
}

async fn desired_plugin_mcp_agents(
    state: &AppState,
    plugin_id: &str,
) -> Result<(BTreeSet<String>, BTreeSet<String>), AppError> {
    let known = agents::skills::skill_capable_agent_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    let saved = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT agent_id FROM plugin_mcp_bindings_v4
         WHERE plugin_id = ? AND desired = 1",
    )
    .bind(plugin_id)
    .fetch_all(&state.deployment.db().pool)
    .await?;
    let has_saved_preferences = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM plugin_mcp_bindings_v4 WHERE plugin_id = ?",
    )
    .bind(plugin_id)
    .fetch_one(&state.deployment.db().pool)
    .await?
        > 0;
    let desired = if has_saved_preferences {
        saved.into_iter().collect()
    } else {
        known.clone()
    };
    Ok((known, desired))
}

async fn ensure_package_runtimes(
    app: &AppHandle,
    state: &AppState,
    package: &plugins::PluginPackage,
    package_digest: &str,
) -> Result<(), AppError> {
    let installed = state
        .plugin_control_plane
        .plugin(package.id.as_str())
        .await
        .map_err(plugin_error)?
        .ok_or_else(|| AppError::NotFound(package.id.as_str().to_owned()))?;
    for runtime in &package.runtimes {
        let ready = state
            .plugin_control_plane
            .runtime_for_package(package.id.as_str(), package_digest, &runtime.id)
            .await
            .map_err(plugin_error)?
            .is_some_and(|locked| runtime_lock_matches(runtime, &locked));
        if !ready {
            install_declared_runtime(app, state, &installed, runtime, package_digest).await?;
        }
    }
    Ok(())
}

fn runtime_lock_matches(
    declared: &plugins::RuntimeContribution,
    locked: &plugins::RuntimeInstallation,
) -> bool {
    declared
        .version
        .as_deref()
        .is_none_or(|version| version == locked.version)
        && (declared.target.is_empty() || declared.target == locked.target)
        && (declared.content_digest.is_empty() || declared.content_digest == locked.content_digest)
        && locked.executable_path.is_absolute()
        && locked.executable_path.is_file()
}

async fn install_declared_runtime(
    app: &AppHandle,
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    runtime: &plugins::RuntimeContribution,
    package_digest: &str,
) -> Result<(), AppError> {
    if let Some(existing) = state
        .plugin_control_plane
        .runtime_inventory()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .find(|locked| runtime_lock_matches(runtime, locked))
    {
        state
            .plugin_control_plane
            .record_runtime_for_package(plugin.id(), package_digest, existing)
            .await
            .map_err(plugin_error)?;
        return Ok(());
    }
    let managed_root = crate::managed_artifacts::directory(app)
        .map_err(|error| AppError::Internal(error.to_string()))?
        .join("plugins/runtimes");
    let host =
        plugins::ContentAddressedRuntimeHost::new(managed_root, runtime).map_err(plugin_error)?;
    record_plugin_audit(
        state,
        plugin.id(),
        "runtime_install_started",
        serde_json::json!({
            "runtimeId": runtime.id,
            "installer": runtime_installer(&runtime.install),
            "sourcePath": plugin.source.path,
        }),
    )
    .await?;
    let installation = match plugins::GlobalRuntimeInstaller::new(&host)
        .install(plugin.id(), runtime)
        .await
    {
        Ok(installation) => installation,
        Err(error) => {
            record_plugin_audit(
                state,
                plugin.id(),
                "runtime_install_failed",
                serde_json::json!({
                    "runtimeId": runtime.id,
                    "errorCode": error.code(),
                    "error": error.message(),
                }),
            )
            .await?;
            return Err(plugin_error(error));
        }
    };

    state
        .plugin_control_plane
        .record_runtime_for_package(plugin.id(), package_digest, installation.clone())
        .await
        .map_err(plugin_error)?;
    record_plugin_audit(
        state,
        plugin.id(),
        "runtime_install",
        serde_json::json!({
            "runtimeId": installation.id,
            "version": installation.version,
            "executablePath": installation.executable_path,
            "exitStatus": "success",
            "probe": "passed",
        }),
    )
    .await?;
    Ok(())
}

async fn record_plugin_audit(
    state: &AppState,
    plugin_id: &str,
    operation: &str,
    summary: serde_json::Value,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO plugin_audit_v4
             (plugin_id, publisher, operation_id, event, evidence_json, created_at)
         SELECT ?, publisher, NULL, ?, ?, datetime('now','subsec')
         FROM plugin_installations_v4 WHERE plugin_id = ?",
    )
    .bind(plugin_id)
    .bind(operation)
    .bind(summary.to_string())
    .bind(plugin_id)
    .execute(&state.deployment.db().pool)
    .await?;
    Ok(())
}

async fn persist_agent_bindings(
    state: &AppState,
    plugin_id: &str,
    known: &BTreeSet<String>,
    desired: &BTreeSet<String>,
    installed: &BTreeSet<String>,
    projections: &[agents::skills::PluginSkillProjectionResult],
) -> Result<(), AppError> {
    let outcomes =
        projections
            .iter()
            .fold(BTreeMap::<&str, bool>::new(), |mut outcomes, projection| {
                let ready =
                    projection.status == agents::skills::PluginSkillProjectionStatus::Projected;
                outcomes
                    .entry(&projection.agent_id)
                    .and_modify(|current| *current &= ready)
                    .or_insert(ready);
                outcomes
            });
    let pool = &state.deployment.db().pool;
    let mut transaction = pool.begin().await?;
    for agent_id in known {
        let wanted = desired.contains(agent_id);
        let applied = wanted
            && installed.contains(agent_id)
            && outcomes.get(agent_id.as_str()) == Some(&true);
        let pending_reason = if wanted && !installed.contains(agent_id) {
            Some("agent_not_installed")
        } else if wanted && !applied {
            Some("projection_incomplete")
        } else {
            None
        };
        sqlx::query(
            "INSERT INTO plugin_agent_bindings_v4
                 (plugin_id, agent_id, desired, applied, pending_reason, error_code, error_message, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(plugin_id, agent_id) DO UPDATE SET
                 desired = excluded.desired,
                 applied = excluded.applied,
                 pending_reason = excluded.pending_reason,
                 error_code = NULL,
                 error_message = NULL,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(plugin_id)
        .bind(agent_id)
        .bind(i64::from(wanted))
        .bind(i64::from(applied))
        .bind(pending_reason)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn configure_plugin_mcp(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    all_agents: bool,
    desired: &BTreeSet<String>,
) -> Vec<String> {
    let pool = &state.deployment.db().pool;
    if let Err(error) = sqlx::query("DELETE FROM plugin_mcp_bindings_v4 WHERE plugin_id = ?")
        .bind(plugin.id())
        .execute(pool)
        .await
    {
        return vec![format!("control-plane binding reset: {error}")];
    }
    let raw_mcp = &plugin.mcp;
    if raw_mcp.is_null() {
        return Vec::new();
    }
    let servers = raw_mcp
        .get("mcpServers")
        .unwrap_or(raw_mcp)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let apps = if all_agents {
        Vec::new()
    } else {
        desired
            .iter()
            .filter_map(|agent| {
                serde_json::from_value::<services::services::mcp::McpAppType>(
                    serde_json::Value::String(agent.clone()),
                )
                .ok()
            })
            .collect()
    };
    let mut errors = Vec::new();
    for (server_id, spec) in servers {
        let projected_id = plugins::projected_mcp_server_id(plugin.id(), &server_id, &spec);
        let legacy_id = plugins::legacy_projected_mcp_server_id(plugin.id(), &server_id, &spec);
        if legacy_id != projected_id {
            let _ = services::services::mcp::uninstall_server(legacy_id).await;
        }
        let materialized = match materialize_plugin_mcp_spec(state, plugin, &server_id, spec).await
        {
            Ok(spec) => spec,
            Err(error) => {
                errors.push(format!("{server_id}: {error}"));
                if let Err(uninstall_error) =
                    services::services::mcp::uninstall_server(projected_id.clone()).await
                {
                    errors.push(format!("{server_id}: {uninstall_error}"));
                }
                continue;
            }
        };
        let error_message = match materialized {
            None => {
                if let Err(error) =
                    services::services::mcp::uninstall_server(projected_id.clone()).await
                {
                    errors.push(format!("{server_id}: {error}"));
                    Some(error.to_string())
                } else {
                    None
                }
            }
            Some(spec) => {
                let result = services::services::mcp::upsert_local_server(
                    projected_id,
                    spec,
                    all_agents,
                    apps.clone(),
                )
                .await;
                result.as_ref().err().map(ToString::to_string)
            }
        };
        if let Some(error) = &error_message {
            errors.push(format!("{server_id}: {error}"));
        }
        let known_agents = agents::skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        for agent_id in &known_agents {
            let wanted = desired.contains(agent_id);
            let binding_error_code =
                (wanted && error_message.is_some()).then_some("mcp_projection_failed");
            let binding_error_message = if wanted {
                error_message.as_deref()
            } else {
                None
            };
            if let Err(error) = sqlx::query(
                "INSERT INTO plugin_mcp_bindings_v4
                     (plugin_id, mcp_id, agent_id, desired, applied, error_code, error_message, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(plugin_id, mcp_id, agent_id) DO UPDATE SET
                     desired = excluded.desired,
                     applied = excluded.applied,
                     error_code = excluded.error_code,
                     error_message = excluded.error_message,
                     updated_at = CURRENT_TIMESTAMP",
            )
            .bind(plugin.id())
            .bind(&server_id)
            .bind(agent_id)
            .bind(i64::from(wanted))
            .bind(i64::from(wanted && error_message.is_none()))
            .bind(binding_error_code)
            .bind(binding_error_message)
            .execute(pool)
            .await
            {
                errors.push(format!("{server_id}/{agent_id} binding: {error}"));
            }
        }
    }
    errors
}

fn is_host_family_binary_mcp(spec: &serde_json::Value) -> bool {
    spec.get("managedRuntime")
        .and_then(|value| value.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("hostFamilyBinary")
}

fn materialize_host_family_binary_mcp(
    state: &AppState,
    server_id: &str,
    spec: &serde_json::Value,
) -> Result<Option<serde_json::Value>, AppError> {
    let Some(product) = plugins::host_family_product(spec) else {
        return Err(AppError::BadRequest(format!(
            "managed MCP `{server_id}` hostFamilyBinary requires a known product"
        )));
    };
    let gate = state.plugin_control_plane.official_product_mcp_gate();
    if !gate
        .bindings()
        .iter()
        .any(|binding| binding.product == product)
    {
        return Ok(None);
    }
    let binary_id = spec
        .get("managedRuntime")
        .and_then(|value| value.get("binaryId"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "managed MCP `{server_id}` hostFamilyBinary requires managedRuntime.binaryId"
            ))
        })?;
    let Some(command) = utils::host_bin::locate_runnable_host_family_binary(binary_id) else {
        tracing::warn!(
            binary_id,
            "skipping host-family MCP projection; sidecar is missing or empty"
        );
        return Ok(None);
    };
    if product == "workflow" {
        return Ok(Some(plugins::host_family_stdio_spec(
            &command.to_string_lossy(),
            product,
            "",
            None,
            None,
        )));
    }
    let token = gate.token_for_product(product);
    let http_base = gate.http_base();
    if token.as_ref().is_none_or(|value| value.is_empty())
        || http_base.as_ref().is_none_or(|value| value.is_empty())
    {
        return Err(AppError::Internal(format!(
            "host family MCP `{server_id}` is not ready for native projection"
        )));
    }
    let features = match product {
        "delegation" => "delegation,sessions,collaboration".to_string(),
        "session" => plugins::session_feature_arg(gate.session_features()),
        "plugin-dev" => "plugin-dev".to_string(),
        other => other.to_string(),
    };
    Ok(Some(plugins::host_family_stdio_spec(
        &command.to_string_lossy(),
        product,
        &features,
        http_base.as_deref(),
        token.as_deref(),
    )))
}

async fn materialize_worker_http_mcp(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    server_id: &str,
    managed: &serde_json::Map<String, serde_json::Value>,
) -> Result<Option<serde_json::Value>, AppError> {
    if managed.get("entrypoint").is_some() {
        return Err(AppError::BadRequest(format!(
            "managed MCP `{server_id}` workerHttp must not set entrypoint"
        )));
    }
    let handler = managed
        .get("handler")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "managed MCP `{server_id}` workerHttp requires managedRuntime.handler"
            ))
        })?;
    let lease = state
        .plugin_control_plane
        .activation_lease(plugin.id())
        .await
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "managed MCP `{server_id}` workerHttp requires an active Worker"
            ))
        })?;
    let endpoint = lease
        .invoke_with_timeout(handler, serde_json::Value::Null, Duration::from_secs(30))
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    plugins::worker_http_mcp_spec_from_endpoint(&endpoint)
        .map(Some)
        .map_err(AppError::BadRequest)
}

async fn materialize_plugin_mcp_spec(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    server_id: &str,
    spec: serde_json::Value,
) -> Result<Option<serde_json::Value>, AppError> {
    let Some(managed) = spec
        .get("managedRuntime")
        .and_then(serde_json::Value::as_object)
    else {
        let mut spec = spec;
        plugins::prepare_plugin_mcp_projection(&mut spec, plugin.package.content_root());
        if spec.get("command").and_then(serde_json::Value::as_str) == Some("node") {
            let node = state
                .plugin_worker_runtime
                .resolve()
                .await
                .map_err(plugin_error)?;
            if let Some(object) = spec.as_object_mut() {
                object.insert(
                    "command".to_owned(),
                    serde_json::Value::String(plugins::spawnable_fs_path(&node)),
                );
            }
        }
        return inject_plugin_host_call(state, plugin, spec).await;
    };
    if is_host_family_binary_mcp(&spec) {
        return materialize_host_family_binary_mcp(state, server_id, &spec);
    }
    if managed.get("kind").and_then(serde_json::Value::as_str) == Some("workerHttp") {
        return materialize_worker_http_mcp(state, plugin, server_id, managed).await;
    }
    let entrypoint = managed
        .get("entrypoint")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "managed MCP `{server_id}` requires managedRuntime.entrypoint"
            ))
        })?;
    let relative = Path::new(entrypoint);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(AppError::BadRequest(format!(
            "managed MCP `{server_id}` entrypoint must be a package-relative path"
        )));
    }
    let package_root = plugin
        .source
        .path
        .canonicalize()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let entrypoint = package_root
        .join(relative)
        .canonicalize()
        .map_err(|error| AppError::NotFound(error.to_string()))?;
    if !entrypoint.starts_with(&package_root) || !entrypoint.is_file() {
        return Err(AppError::BadRequest(format!(
            "managed MCP `{server_id}` entrypoint escapes the installed package"
        )));
    }
    let node = state
        .plugin_worker_runtime
        .resolve()
        .await
        .map_err(plugin_error)?;
    let scopes = managed
        .get("hostScopes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect::<Vec<_>>();
    let token = serde_json::json!({
        "typ": "vibex.plugin-mcp",
        "plugin_id": plugin.id(),
        "mcp_id": server_id,
        "scopes": scopes,
    })
    .to_string();
    inject_plugin_host_call(
        state,
        plugin,
        serde_json::json!({
            "type": "stdio",
            "command": plugins::spawnable_fs_path(&node),
            "args": [plugins::spawnable_fs_path(&entrypoint)],
            "env": {
                "VIBEX_PLUGIN_MCP_TOKEN": token,
                "VIBEX_MCP_PROTOCOL_REVISION": managed
                    .get("protocolRevision")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("2026-07-28")
            }
        }),
    )
    .await
}

async fn inject_plugin_host_call(
    state: &AppState,
    plugin: &plugins::InstalledPlugin,
    mut spec: serde_json::Value,
) -> Result<Option<serde_json::Value>, AppError> {
    plugins::strip_mcp_advertisement_fields(&mut spec);
    let Some(host_call) = plugins::PluginHostCall::process_instance() else {
        tracing::warn!(
            plugin_id = plugin.id(),
            "projecting plugin MCP without host.call; loopback is not listening"
        );
        return Ok(Some(spec));
    };
    let generation = state
        .plugin_control_plane
        .active_generation(plugin.id())
        .await
        .unwrap_or(0);
    let ctx = host_call
        .issue(plugin.id(), generation)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    plugins::attach_host_call_env(&mut spec, &ctx, Some(plugin.package.content_root()));
    Ok(Some(spec))
}

fn plugin_snapshot_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("plugins/snapshots"))
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn plugin_error(error: plugins::PluginError) -> AppError {
    match error.code() {
        "plugin_not_found" => AppError::NotFound(error.message().to_owned()),
        "plugin_id_conflict" => AppError::Conflict(error.message().to_owned()),
        "plugin_manifest_invalid" | "plugin_skill_required" => {
            AppError::BadRequest(error.message().to_owned())
        }
        _ => AppError::Internal(error.message().to_owned()),
    }
}

fn runtime_installer(installer: &plugins::RuntimeInstall) -> &'static str {
    match installer {
        plugins::RuntimeInstall::Existing => "existing",
        plugins::RuntimeInstall::Binary { .. } => "binary",
        plugins::RuntimeInstall::Archive { .. } => "archive",
        plugins::RuntimeInstall::Npm { .. } => "npm",
        plugins::RuntimeInstall::Pipx { .. } => "pipx",
        plugins::RuntimeInstall::Cargo { .. } => "cargo",
    }
}

const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_PLUGIN_ARCHIVE_PATH_DEPTH: usize = 20;

#[derive(Debug)]
struct ExtractedPluginArchive {
    _staging: tempfile::TempDir,
    root: PathBuf,
}

fn extract_plugin_archive(path: &Path) -> Result<ExtractedPluginArchive, AppError> {
    if is_gzip_archive(path) {
        return extract_plugin_tar_gz(path);
    }
    extract_plugin_zip(path)
}

fn is_gzip_archive(path: &Path) -> bool {
    let mut magic = [0u8; 2];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == [0x1f, 0x8b]
}

fn extract_plugin_tar_gz(path: &Path) -> Result<ExtractedPluginArchive, AppError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| AppError::BadRequest(format!("cannot read plugin archive: {error}")))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(AppError::BadRequest(
            "plugin archive must be 100 MB or smaller".to_owned(),
        ));
    }
    let file = File::open(path)
        .map_err(|error| AppError::BadRequest(format!("cannot open plugin archive: {error}")))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let staging = tempfile::tempdir()
        .map_err(|error| AppError::Internal(format!("cannot stage plugin archive: {error}")))?;
    let mut extracted_bytes = 0_u64;
    let mut entries = 0_usize;
    for entry in archive
        .entries()
        .map_err(|error| AppError::BadRequest(format!("invalid plugin tar.gz: {error}")))?
    {
        let mut entry = entry
            .map_err(|error| AppError::BadRequest(format!("unreadable tar.gz entry: {error}")))?;
        entries += 1;
        if entries > MAX_PLUGIN_ARCHIVE_ENTRIES {
            return Err(AppError::BadRequest(
                "plugin archive contains more than 5,000 entries".to_owned(),
            ));
        }
        let size = entry.header().size().unwrap_or(0);
        if size > MAX_PLUGIN_ARCHIVE_ENTRY_BYTES {
            return Err(AppError::BadRequest(
                "archive entry exceeds 100 MiB".to_owned(),
            ));
        }
        extracted_bytes = extracted_bytes.saturating_add(size);
        if extracted_bytes > MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES {
            return Err(AppError::BadRequest(
                "plugin archive expands beyond 512 MiB".to_owned(),
            ));
        }
        if !entry.unpack_in(staging.path()).map_err(|error| {
            AppError::BadRequest(format!("cannot extract tar.gz entry: {error}"))
        })? {
            return Err(AppError::BadRequest("unsafe tar.gz entry path".to_owned()));
        }
    }
    if entries == 0 {
        return Err(AppError::BadRequest("plugin archive is empty".to_owned()));
    }
    let root = resolve_extracted_plugin_root(staging.path())?;
    Ok(ExtractedPluginArchive {
        _staging: staging,
        root,
    })
}

fn extract_plugin_zip(path: &Path) -> Result<ExtractedPluginArchive, AppError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| AppError::BadRequest(format!("cannot read plugin ZIP: {error}")))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(AppError::BadRequest(
            "plugin ZIP must be 100 MB or smaller".to_owned(),
        ));
    }
    let file = File::open(path)
        .map_err(|error| AppError::BadRequest(format!("cannot open plugin ZIP: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::BadRequest(format!("invalid plugin ZIP: {error}")))?;
    if archive.is_empty() {
        return Err(AppError::BadRequest("plugin ZIP is empty".to_owned()));
    }
    if archive.len() > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(AppError::BadRequest(
            "plugin ZIP contains more than 5,000 entries".to_owned(),
        ));
    }

    let staging = tempfile::tempdir()
        .map_err(|error| AppError::Internal(format!("cannot stage plugin ZIP: {error}")))?;
    let mut extracted_bytes = 0_u64;
    let mut normalized_paths = BTreeSet::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::BadRequest(format!("unreadable ZIP entry: {error}")))?;
        let raw_name = entry.name().to_owned();
        let path_name = raw_name.strip_suffix('/').unwrap_or(&raw_name);
        if raw_name.is_empty()
            || path_name.trim() != path_name
            || raw_name.contains('\\')
            || path_name
                .split('/')
                .any(|segment| segment.is_empty() || segment == "..")
        {
            return Err(AppError::BadRequest(format!(
                "unsafe ZIP entry path `{raw_name}`"
            )));
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::BadRequest(format!("unsafe ZIP entry path `{raw_name}`")))?;
        if relative.components().count() > MAX_PLUGIN_ARCHIVE_PATH_DEPTH {
            return Err(AppError::BadRequest(format!(
                "ZIP entry path is too deep `{raw_name}`"
            )));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(AppError::BadRequest(format!(
                "ZIP symlinks are not supported `{raw_name}`"
            )));
        }
        let normalized = raw_name.to_lowercase();
        if !normalized_paths.insert(normalized) {
            return Err(AppError::BadRequest(format!(
                "duplicate ZIP entry path `{raw_name}`"
            )));
        }

        let output = staging.path().join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|error| {
                AppError::Internal(format!("cannot create ZIP directory: {error}"))
            })?;
            continue;
        }
        if !entry.is_file() {
            return Err(AppError::BadRequest(format!(
                "unsupported ZIP entry type `{raw_name}`"
            )));
        }
        if entry.size() > MAX_PLUGIN_ARCHIVE_ENTRY_BYTES {
            return Err(AppError::BadRequest(format!(
                "ZIP entry exceeds 100 MiB `{raw_name}`"
            )));
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Internal(format!("cannot create ZIP parent directory: {error}"))
            })?;
        }
        let mut destination = File::create(&output)
            .map_err(|error| AppError::Internal(format!("cannot extract ZIP entry: {error}")))?;
        let remaining_archive_bytes = MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES
            .checked_sub(extracted_bytes)
            .ok_or_else(|| AppError::BadRequest("plugin ZIP expands beyond 512 MiB".to_owned()))?;
        let entry_limit = MAX_PLUGIN_ARCHIVE_ENTRY_BYTES.min(remaining_archive_bytes);
        let copied = io::copy(&mut entry.by_ref().take(entry_limit + 1), &mut destination)
            .map_err(|error| AppError::BadRequest(format!("cannot read ZIP entry: {error}")))?;
        if copied > remaining_archive_bytes {
            return Err(AppError::BadRequest(
                "plugin ZIP expands beyond 512 MiB".to_owned(),
            ));
        }
        if copied > entry_limit {
            return Err(AppError::BadRequest(format!(
                "ZIP entry exceeds 100 MiB `{raw_name}`"
            )));
        }
        extracted_bytes = extracted_bytes
            .checked_add(copied)
            .ok_or_else(|| AppError::BadRequest("plugin ZIP extracted size overflow".to_owned()))?;
    }

    let root = resolve_extracted_plugin_root(staging.path())?;
    Ok(ExtractedPluginArchive {
        _staging: staging,
        root,
    })
}

fn resolve_extracted_plugin_root(staging: &Path) -> Result<PathBuf, AppError> {
    if has_supported_plugin_manifest(staging) {
        return Ok(staging.to_path_buf());
    }
    let entries = std::fs::read_dir(staging)
        .map_err(|error| AppError::Internal(format!("cannot inspect plugin ZIP: {error}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::Internal(format!("cannot inspect plugin ZIP: {error}")))?;
    if entries.len() != 1 || !entries[0].path().is_dir() {
        return Err(AppError::BadRequest(
            "plugin ZIP must contain exactly one plugin root".to_owned(),
        ));
    }
    let root = entries[0].path();
    if !has_supported_plugin_manifest(&root) {
        return Err(AppError::BadRequest(
            "plugin ZIP does not contain a supported plugin manifest".to_owned(),
        ));
    }
    Ok(root)
}

fn has_supported_plugin_manifest(root: &Path) -> bool {
    root.join(".vibex-plugin/plugin.json").is_file()
        || root.join(".codex-plugin/plugin.json").is_file()
        || root.join(".claude-plugin/plugin.json").is_file()
}

#[cfg(test)]
mod tests {
    use std::{fs::File, io::Write};

    use tempfile::tempdir;
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::*;

    #[test]
    fn host_family_binary_mcp_projects_under_product_identity() {
        let spec = serde_json::json!({
            "managedRuntime": {
                "kind": "hostFamilyBinary",
                "binaryId": "vibex-mcp",
                "product": "delegation"
            }
        });
        assert!(is_host_family_binary_mcp(&spec));
        assert_eq!(
            plugins::projected_mcp_server_id("vibex.multi-agent", "vibex-delegation-mcp", &spec),
            plugins::DELEGATION_MCP_NAME
        );
        assert!(!is_host_family_binary_mcp(&serde_json::json!({
            "command": "npx",
            "args": ["demo-mcp"]
        })));
        assert!(!is_host_family_binary_mcp(&serde_json::json!({
            "managedRuntime": {
                "kind": "node",
                "entrypoint": "dist/mcp/hello.mjs"
            }
        })));
    }

    #[test]
    fn extracts_one_nested_plugin_root_from_zip() {
        let fixture = tempdir().unwrap();
        let archive_path = fixture.path().join("plugin.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file(
                "demo/.vibex-plugin/plugin.json",
                SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(br#"{"id":"demo"}"#).unwrap();
        archive
            .start_file("demo/skills/demo/SKILL.md", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"---\nname: demo\n---\n").unwrap();
        archive.finish().unwrap();

        let extracted = extract_plugin_archive(&archive_path).unwrap();

        assert!(extracted.root.join(".vibex-plugin/plugin.json").is_file());
        assert!(extracted.root.join("skills/demo/SKILL.md").is_file());
    }

    #[test]
    fn rejects_zip_entries_that_escape_the_staging_root() {
        let fixture = tempdir().unwrap();
        let archive_path = fixture.path().join("plugin.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = ZipWriter::new(file);
        archive
            .start_file("../outside", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"unsafe").unwrap();
        archive.finish().unwrap();

        let error = extract_plugin_archive(&archive_path).unwrap_err();

        assert!(error.to_string().contains("unsafe ZIP entry path"));
        assert!(!fixture.path().join("outside").exists());
    }
}
