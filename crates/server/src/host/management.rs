mod auth_projection;
mod diagnostics_and_env;
mod native_preflight;

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::{
    AgentId, AgentUpdateCheckInput, BuiltInProfileCatalog, NativeConfigProvider, NativeFileSystem,
    NpmRegistryHttpFetcher, ObservedUserComponent, ProfileComponent, ProfileManagementActionKind,
    RegistryCacheFreshness, TokioNativeFileSystem, apply_built_in_auth_mode_policy,
    apply_codex_auth_mode, apply_component_versions, auth_mode_kind,
    authentication_from_account_command, built_in_auth_mode_policy, compose_agent_update_check,
    headless_account_env, official_account_present, plan_runtime_acp_compatibility_warning,
    resolve_observed_authentication,
};
use api_types::{
    AgentAccountFlowStatus, AgentAccountFlowView, AgentAuthModeKind, AgentAuthModeView,
    AgentAuthenticationStatus, AgentDiagnosticView, AgentDiscoveryProgressView,
    AgentEnvironmentDiagnosticsView, AgentEnvironmentPatchRequest, AgentLifecycleState,
    AgentManagementActionReceipt, AgentManagementActionView, AgentManagementActionsView,
    AgentPreflightItemView, AgentPreflightView, AgentUpdateCheckView,
};
use application::ApplicationError;
use chrono::Utc;
use db::models::agent_management::RegistrySnapshotRepository;
use serde::Deserialize;
use serde_json::Value;
use services::services::{
    agent_management::AgentManagementApplicationService, agent_registry::AgentRegistrySnapshotStore,
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use self::{
    auth_projection::{
        bound_provider_has_credentials, preflight_auth_item, project_auth_mode_view_at,
        read_json_object_or_empty, release_provider_projection, resolve_agent_home,
        with_account_label,
    },
    diagnostics_and_env::{
        InstalledComponent, apply_environment_patch, build_environment_diagnostics,
        execute_non_antigravity_action, management_action_kind, management_program_names,
        parse_agent_env, probe_profile_dependencies,
        project_agent_environment, resolve_management_program_from_components,
        spawn_antigravity_login_flow,
    },
    native_preflight::{
        LEGACY_SHIM_REPAIR_DETAIL, PrimaryRuntimePreflightInput,
        build_primary_runtime_preflight_item, is_native_engine_profile,
    },
};
pub(crate) use self::diagnostics_and_env::{discover_profile_acp, probe_first_output_line};
use super::{
    account_flow,
    native::{model_providers, provider_store_path},
};
use crate::domains::{internal_error, parse, serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: AgentId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreflightArgs {
    agent_id: AgentId,
    scope: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunActionArgs {
    agent_id: AgentId,
    action_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthModeSetArgs {
    agent_id: AgentId,
    mode: String,
    api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckUpdateArgs {
    pub(crate) agent_id: AgentId,
    pub(crate) runtime_version: Option<String>,
    pub(crate) acp_version: Option<String>,
    pub(crate) force: Option<bool>,
}

pub async fn dispatch_preflight(pool: &SqlitePool, args: Value) -> Result<Value, ApplicationError> {
    let args: PreflightArgs = parse(args)?;
    serialize(preflight(pool, args.agent_id, args.scope.as_deref()).await?)
}

pub async fn dispatch_diagnostics(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(diagnostics(pool, args.agent_id).await?)
}

pub async fn dispatch_mark_diagnostics_read(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    mark_diagnostics_read(pool, &args.agent_id).await?;
    Ok(Value::Null)
}

pub async fn dispatch_clear_diagnostics(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    clear_diagnostics(pool, &args.agent_id).await?;
    Ok(Value::Null)
}

pub async fn dispatch_environment_diagnostics(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(environment_diagnostics(pool, args.agent_id).await?)
}

pub async fn dispatch_actions(pool: &SqlitePool, args: Value) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(actions(pool, args.agent_id).await?)
}

pub async fn dispatch_run_action(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: RunActionArgs = parse(args)?;
    serialize(run_action(pool, args.agent_id, args.action_id).await?)
}

pub async fn dispatch_account_flow(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(account_flow_status(pool, args.agent_id).await?)
}

pub async fn dispatch_auth_mode(pool: &SqlitePool, args: Value) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(auth_mode(pool, args.agent_id).await?)
}

pub async fn dispatch_auth_mode_set(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AuthModeSetArgs = parse(args)?;
    serialize(auth_mode_set(pool, args.agent_id, args.mode, args.api_key).await?)
}

pub async fn check_update(
    pool: &SqlitePool,
    args: CheckUpdateArgs,
    freshness: RegistryCacheFreshness,
) -> Result<AgentUpdateCheckView, ApplicationError> {
    let agent_id = args.agent_id;
    let components = installed_components(pool, &agent_id).await?;
    let current = components
        .iter()
        .filter(|component| !agents::launch_program_is_legacy_acp_shim(&agent_id, &component.path))
        .map(|component| ObservedUserComponent {
            component_id: component.kind.clone(),
            version: Some(component.version.clone()),
        })
        .collect::<Vec<_>>();
    let snapshot = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(pool.clone()))
        .load()
        .await
        .map_err(internal_error)?;
    let (mut plan, mut overlay_fetched) =
        match crate::plan_host_agent_install_with_overlay(pool, agent_id.as_str()).await {
            Ok((plan, overlay_fetched)) => (Some(plan), overlay_fetched),
            Err(_) => (None, Vec::new()),
        };
    let runtime = args
        .runtime_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let acp = args
        .acp_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(plan) = plan.as_mut()
        && (runtime.is_some() || acp.is_some())
    {
        apply_component_versions(plan, runtime, acp).map_err(ApplicationError::bad_request)?;
        if acp.is_some() {
            overlay_fetched.push("acp_adapter".to_string());
            overlay_fetched.push("combined_runtime".to_string());
        }
        if runtime.is_some() {
            overlay_fetched.push("agent_runtime".to_string());
        }
    }
    let compatibility_warning = match plan.as_ref() {
        Some(plan) => {
            plan_runtime_acp_compatibility_warning(plan, &NpmRegistryHttpFetcher::new()).await
        }
        None => None,
    };
    let fresh = freshness == RegistryCacheFreshness::Fresh
        || snapshot.as_ref().is_some_and(|snapshot| {
            Utc::now().signed_duration_since(snapshot.fetched_at) <= chrono::Duration::hours(24)
        })
        || !overlay_fetched.is_empty();
    Ok(compose_agent_update_check(AgentUpdateCheckInput {
        agent_id,
        current: &current,
        plan: plan.as_ref(),
        overlay_fetched: &overlay_fetched,
        snapshot_id: snapshot.as_ref().map(|snapshot| snapshot.id.to_string()),
        fetched_at: snapshot
            .as_ref()
            .map(|snapshot| snapshot.fetched_at.to_rfc3339()),
        fresh,
        compatibility_warning,
    }))
}

pub async fn dispatch_discovery_progress(
    runtime: &services::services::agent_management_runtime::AgentManagementRuntimeState,
) -> Result<Value, ApplicationError> {
    serialize(discovery_progress(runtime).await?)
}

pub async fn preflight(
    pool: &SqlitePool,
    agent_id: AgentId,
    scope: Option<&str>,
) -> Result<AgentPreflightView, ApplicationError> {
    require_membership(pool, &agent_id).await?;
    let env = read_agent_environment(pool, &agent_id).await?;
    if scope == Some("authentication") {
        let authentication = persist_observed_authentication(pool, &agent_id)
            .await
            .unwrap_or(observed_authentication(pool, &agent_id, &env).await);
        let item = auth_mode_preflight_item(pool, &agent_id, &env, authentication).await?;
        return Ok(AgentPreflightView {
            agent_id,
            checked_at: Utc::now().to_rfc3339(),
            items: item.into_iter().collect(),
        });
    }

    let view = AgentManagementApplicationService::new(pool.clone())
        .list()
        .await
        .map_err(internal_error)?
        .into_iter()
        .find(|view| view.agent_id == agent_id)
        .ok_or_else(|| ApplicationError::not_found("Agent 尚未添加"))?;

    let components = installed_components(pool, &agent_id).await?;
    let acp = components
        .iter()
        .find(|component| matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime"));
    let runtime = components.iter().find(|component| {
        matches!(
            component.kind.as_str(),
            "agent_runtime" | "combined_runtime"
        ) && !agents::launch_program_is_legacy_acp_shim(&agent_id, &component.path)
    });
    let catalog = BuiltInProfileCatalog::management();
    let has_managed_installer = catalog.profile(&agent_id).is_none_or(|_| {
        agents::InstallPlanner::bundled()
            .plan(agents::InstallPlanningInput {
                agent_id: agent_id.clone(),
                platform: agents::current_platform(),
                source: agents::InstallCandidateSource::BuiltInProfile,
                environment: agents::InstallEnvironment {
                    node_verified: true,
                    uv_verified: true,
                    python_verified: true,
                },
            })
            .is_ok()
    });
    let native_engine = is_native_engine_profile(&agent_id);
    let legacy_shim_locked = native_engine
        && acp.is_some_and(|component| {
            agents::launch_program_is_legacy_acp_shim(&agent_id, &component.path)
        });
    let mut acp_ok = view.lifecycle != AgentLifecycleState::Uninstalled
        && acp.is_some_and(|component| component.exists)
        && !legacy_shim_locked;
    let mut acp_error = None;
    let mut discovered_acp_path = None;
    if !acp_ok {
        if (native_engine
            || view.lifecycle != AgentLifecycleState::Uninstalled
            || !has_managed_installer
            || agent_id.as_str() == "kiro")
            && let Some(path) = discover_profile_acp(&agent_id).await
        {
            acp_ok = true;
            discovered_acp_path = Some(path);
        } else if legacy_shim_locked {
            acp_error = Some(LEGACY_SHIM_REPAIR_DETAIL.to_string());
        } else if acp.is_some() {
            acp_error = Some(if native_engine {
                "已记录安装路径，但找不到原生引擎 CLI 可执行文件。".to_string()
            } else {
                "ACP executable is missing on disk".to_string()
            });
        }
    }
    let version_args = catalog
        .profile(&agent_id)
        .and_then(|profile| {
            profile
                .external_candidates
                .iter()
                .find(|candidate| {
                    matches!(
                        candidate.component,
                        ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
                    )
                })
                .map(|candidate| candidate.version_args)
        })
        .unwrap_or(&["--version"]);
    let discovered_acp_version = match discovered_acp_path.as_ref() {
        Some(path) => probe_first_output_line(path, version_args).await,
        None => None,
    };
    if legacy_shim_locked {
        reconcile_legacy_shim_lock(
            pool,
            &agent_id,
            discovered_acp_path.as_deref(),
            discovered_acp_version.as_deref(),
        )
        .await;
    } else if native_engine
        && view.enabled
        && !view.retired
        && let Some(path) = discovered_acp_path.as_deref()
    {
        let fallback_version = discovered_acp_version
            .as_deref()
            .or(view.runtime_version.as_deref())
            .or(Some("0.0.0"));
        let _ = services::services::native_engine_adopt::adopt_native_engine_if_needed(
            pool,
            &agent_id,
            path,
            fallback_version,
            None,
        )
        .await;
    }
    let runtime_ok =
        runtime.is_some_and(|component| component.exists) || view.local_runtime.is_some() || acp_ok;

    let dependency_items = if let Some(profile) = catalog.profile(&agent_id) {
        probe_profile_dependencies(profile).await
    } else {
        Vec::new()
    };

    let authentication = observed_authentication(pool, &agent_id, &env).await;
    let authentication_required = catalog
        .profile(&agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (auth_mode_item, auth_mode_ready) =
        match auth_mode_preflight_item(pool, &agent_id, &env, authentication).await? {
            Some(item) => {
                let ready = item.status == "pass";
                (Some(item), ready)
            }
            None => (None, true),
        };

    let dependencies_ok = dependency_items.iter().all(|item| item.status != "fail");
    let lifecycle = if !acp_ok || !dependencies_ok {
        AgentLifecycleState::NeedsRepair
    } else if !auth_mode_ready
        || (authentication_required
            && auth_mode_item.is_none()
            && matches!(
                authentication,
                AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
            ))
    {
        AgentLifecycleState::NeedsAuth
    } else {
        AgentLifecycleState::Ready
    };
    AgentManagementApplicationService::new(pool.clone())
        .record_probe(
            &agent_id,
            lifecycle,
            authentication,
            runtime_ok,
            acp_ok && dependencies_ok,
            authentication_required,
        )
        .await
        .map_err(internal_error)?;

    let valid_acp = acp.filter(|_| !legacy_shim_locked);
    let primary_item_version = valid_acp
        .map(|component| component.version.clone())
        .or(discovered_acp_version)
        .or_else(|| {
            (!legacy_shim_locked)
                .then(|| {
                    if native_engine {
                        view.runtime_version.clone().or_else(|| view.acp_version.clone())
                    } else {
                        view.acp_version.clone()
                    }
                })
                .flatten()
        });
    let primary_item_path = valid_acp
        .map(|component| component.path.display().to_string())
        .or_else(|| discovered_acp_path.map(|path| path.display().to_string()));
    let external_installer_url = (!has_managed_installer && agent_id.as_str() == "kiro")
        .then_some("https://kiro.dev/docs/getting-started/installation/");
    let adapter_relation = agents::acp_adapter_relation(agent_id.as_str());
    let vendor_cli_path = match adapter_relation {
        Some(relation) => {
            agents::resolve_vendor_cli(relation.native_cmd, relation.extra_dirs).await
        }
        None => None,
    };
    let mut items = vec![build_primary_runtime_preflight_item(
        PrimaryRuntimePreflightInput {
            retired: view.retired,
            native_engine,
            acp_ok,
            legacy_shim_locked,
            has_recorded_component: acp.is_some(),
            acp_error: acp_error.as_deref(),
            external_installer_url,
            adapter_relation,
            vendor_cli_path: vendor_cli_path.as_deref(),
            version: primary_item_version,
            path: primary_item_path,
            repairable: has_managed_installer,
        },
    )];
    items.extend(dependency_items);
    items.extend(auth_mode_item);
    Ok(AgentPreflightView {
        agent_id,
        checked_at: Utc::now().to_rfc3339(),
        items,
    })
}

async fn reconcile_legacy_shim_lock(
    pool: &SqlitePool,
    agent_id: &AgentId,
    native_path: Option<&Path>,
    probed_version: Option<&str>,
) {
    let sha256 = match native_path {
        Some(path) => tokio::fs::read(path)
            .await
            .ok()
            .map(|bytes| format!("{:x}", Sha256::digest(bytes))),
        None => None,
    };
    let _ = AgentManagementApplicationService::new(pool.clone())
        .reconcile_legacy_shim_lock(agent_id, native_path, probed_version, sha256.as_deref())
        .await;
}

pub async fn diagnostics(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<Vec<AgentDiagnosticView>, ApplicationError> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
        ),
    >(
        r#"SELECT id, operation_kind, severity, message, redacted_output, created_at, read_at
           FROM agent_diagnostic WHERE agent_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 20"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await
    .map_err(internal_error)?;
    Ok(rows
        .into_iter()
        .map(
            |(id, operation_kind, severity, message, redacted_output, created_at, read_at)| {
                AgentDiagnosticView {
                    id,
                    agent_id: agent_id.clone(),
                    operation_kind,
                    severity,
                    message,
                    redacted_output,
                    created_at,
                    read: read_at.is_some(),
                }
            },
        )
        .collect())
}

pub async fn mark_diagnostics_read(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<(), ApplicationError> {
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ? AND read_at IS NULL"#,
    )
    .bind(agent_id.as_str())
    .execute(pool)
    .await
    .map_err(internal_error)?;
    Ok(())
}

pub async fn clear_diagnostics(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<(), ApplicationError> {
    sqlx::query("DELETE FROM agent_diagnostic WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(pool)
        .await
        .map_err(internal_error)?;
    Ok(())
}

pub async fn environment_diagnostics(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentEnvironmentDiagnosticsView, ApplicationError> {
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog
        .profile(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("环境诊断当前只适用于内置 Agent"))?;
    require_membership(pool, &agent_id).await?;
    let installed = installed_components(pool, &agent_id).await?;
    Ok(build_environment_diagnostics(agent_id, profile, &installed).await)
}

pub async fn actions(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentManagementActionsView, ApplicationError> {
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        ApplicationError::not_found(format!("Agent `{agent_id}` 没有内置账号管理动作"))
    })?;
    let environment = read_agent_environment(pool, &agent_id).await?;
    let mut actions = Vec::with_capacity(profile.management_actions.len());
    for action in profile.management_actions {
        let program =
            resolve_management_action_program(pool, &agent_id, action, &environment).await;
        let available = action.url.is_some() || program.is_some();
        let translation_prefix = format!(
            "agents.managementAction.{}.{}",
            agent_id.as_str(),
            action.id
        );
        actions.push(AgentManagementActionView {
            id: action.id.to_string(),
            label: action.label.to_string(),
            description: action.description.to_string(),
            label_key: format!("{translation_prefix}.label"),
            description_key: format!("{translation_prefix}.description"),
            kind: management_action_kind(action.kind),
            available,
            unavailable_reason: (!available).then(|| {
                format!(
                    "未找到 {}；请重新安装或修复此 Agent。",
                    management_program_names(action)
                )
            }),
            url: action.url.map(str::to_string),
        });
    }
    Ok(AgentManagementActionsView { agent_id, actions })
}

pub async fn run_action(
    pool: &SqlitePool,
    agent_id: AgentId,
    action_id: String,
) -> Result<AgentManagementActionReceipt, ApplicationError> {
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        ApplicationError::not_found(format!("Agent `{agent_id}` 没有内置账号管理动作"))
    })?;
    let action = profile
        .management_actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| {
            ApplicationError::bad_request(format!("Agent `{agent_id}` 不支持动作 `{action_id}`"))
        })?;

    if action.kind == ProfileManagementActionKind::Login
        && agents::AgentKind::Antigravity.matches_id(agent_id.as_str())
    {
        return start_antigravity_login(pool, agent_id, action).await;
    }

    let (environment, resolved_program) = if action.url.is_some() {
        (HashMap::new(), None)
    } else {
        let environment = read_agent_environment(pool, &agent_id).await?;
        let program =
            resolve_management_action_program(pool, &agent_id, action, &environment).await;
        (environment, program)
    };
    execute_non_antigravity_action(&agent_id, action, &environment, resolved_program).await?;

    Ok(AgentManagementActionReceipt {
        agent_id,
        action_id,
        launched: true,
    })
}

async fn start_antigravity_login(
    pool: &SqlitePool,
    agent_id: AgentId,
    action: &agents::ProfileManagementAction,
) -> Result<AgentManagementActionReceipt, ApplicationError> {
    if let Some(pending) = account_flow::peek_account_flow(&agent_id) {
        let is_finished =
            if let Ok(contents) = tokio::fs::read_to_string(&pending.result_path).await {
                account_flow::parse_account_flow_exit(&contents).is_some()
            } else {
                false
            };
        if is_finished {
            account_flow::take_account_flow(&agent_id);
            let _ = tokio::fs::remove_file(&pending.result_path).await;
        } else {
            return Err(ApplicationError::conflict(
                "登录正在进行，请先在浏览器中完成",
            ));
        }
    }
    let environment = read_agent_environment(pool, &agent_id).await?;
    let program = resolve_management_action_program(pool, &agent_id, action, &environment)
        .await
        .ok_or_else(|| {
            ApplicationError::bad_request(format!(
                "未找到 {}；请重新安装或修复此 Agent。",
                management_program_names(action)
            ))
        })?;
    spawn_antigravity_login_flow(agent_id, action, environment, program).await
}

pub async fn account_flow_status(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentAccountFlowView, ApplicationError> {
    let Some(pending) = account_flow::peek_account_flow(&agent_id) else {
        return Ok(account_flow::idle_account_flow(agent_id));
    };
    let Ok(contents) = tokio::fs::read_to_string(&pending.result_path).await else {
        return Ok(account_flow::pending_account_flow_view(
            agent_id,
            pending.action_id,
        ));
    };
    let Some(exit_code) = account_flow::parse_account_flow_exit(&contents) else {
        return Ok(account_flow::pending_account_flow_view(
            agent_id,
            pending.action_id,
        ));
    };
    account_flow::take_account_flow(&agent_id);
    let _ = tokio::fs::remove_file(&pending.result_path).await;
    let recorded = recorded_authentication(pool, &agent_id).await;
    let authentication =
        authentication_from_account_command(pending.kind, exit_code).unwrap_or(recorded);
    let service = AgentManagementApplicationService::new(pool.clone());
    if authentication != recorded {
        service
            .sync_authentication(&agent_id, authentication, None)
            .await
            .map_err(internal_error)?;
    }
    if let Some(commanded) = authentication_from_account_command(pending.kind, exit_code) {
        service
            .set_account_signed_out(
                &agent_id,
                commanded == AgentAuthenticationStatus::NotLoggedIn,
            )
            .await
            .map_err(internal_error)?;
    }
    if exit_code == 0 {
        crate::host::events::current_host_events()
            .emit("agent-management-snapshot-invalidated", ());
    }
    Ok(AgentAccountFlowView {
        agent_id,
        action_id: Some(pending.action_id),
        status: if exit_code == 0 {
            AgentAccountFlowStatus::Succeeded
        } else {
            AgentAccountFlowStatus::Failed
        },
        exit_code: Some(exit_code),
        authentication: Some(authentication),
    })
}

pub async fn auth_mode(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentAuthModeView, ApplicationError> {
    let env = read_agent_environment(pool, &agent_id).await?;
    with_account_label(project_auth_mode_view(pool, agent_id, &env).await?).await
}

pub async fn auth_mode_set(
    pool: &SqlitePool,
    agent_id: AgentId,
    mode: String,
    api_key: Option<String>,
) -> Result<AgentAuthModeView, ApplicationError> {
    if agent_id.as_str() == "codex" {
        return set_codex_auth_mode(pool, agent_id, &mode, api_key.as_deref()).await;
    }
    let policy = built_in_auth_mode_policy(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("此 Agent 没有独立鉴权模式"))?;
    if !policy.modes.contains(&mode.as_str()) {
        return Err(ApplicationError::bad_request(format!(
            "不支持鉴权模式 `{mode}`"
        )));
    }
    let mut env = read_agent_environment(pool, &agent_id).await?;
    env.insert(policy.mode_env.to_string(), mode.clone());
    if policy.credential_modes.contains(&mode.as_str()) {
        if let Some(api_key) = api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env.insert(policy.credential_env.to_string(), api_key.to_string());
        }
        if env
            .get(policy.credential_env)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(ApplicationError::bad_request(format!(
                "{} 模式需要 {}",
                mode, policy.credential_env
            )));
        }
    }
    if mode != "model_provider" {
        let home =
            dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
        release_provider_projection(&home, &provider_store_path(), &agent_id, &env).await?;
    }
    apply_built_in_auth_mode_policy(&agent_id, &mut env);
    persist_agent_environment(pool, &agent_id, &env).await?;
    if agents::AgentKind::Antigravity.matches_id(agent_id.as_str()) {
        let report = agents::apply_antigravity_launch_env(&mut env.clone());
        if let (agents::AntigravitySyncStatus::Skipped, Some(reason)) =
            (report.status, report.reason)
        {
            return Err(ApplicationError::bad_request(format!(
                "无法写入 Antigravity 认证设置：{reason}"
            )));
        }
    }
    let _ = persist_observed_authentication(pool, &agent_id).await;
    with_account_label(project_auth_mode_view(pool, agent_id, &env).await?).await
}

pub async fn discovery_progress(
    runtime: &services::services::agent_management_runtime::AgentManagementRuntimeState,
) -> Result<AgentDiscoveryProgressView, ApplicationError> {
    Ok(
        services::services::agent_management_runtime::local_runtime_discovery_progress_view(
            runtime.local_runtime_discovery_progress().await,
        ),
    )
}

async fn project_auth_mode_view(
    _pool: &SqlitePool,
    agent_id: AgentId,
    env: &HashMap<String, String>,
) -> Result<AgentAuthModeView, ApplicationError> {
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    project_auth_mode_view_at(&home, &provider_store_path(), agent_id, env).await
}

async fn set_codex_auth_mode(
    pool: &SqlitePool,
    agent_id: AgentId,
    mode: &str,
    api_key: Option<&str>,
) -> Result<AgentAuthModeView, ApplicationError> {
    if !agents::CODEX_AUTH_MODES.contains(&mode) {
        return Err(ApplicationError::bad_request(format!(
            "不支持鉴权模式 `{mode}`"
        )));
    }
    let env = read_agent_environment(pool, &agent_id).await?;
    if mode == "model_provider" && bound_provider_id(pool, &agent_id).await?.is_none() {
        return Err(ApplicationError::bad_request(
            "请先在 Model Provider 区域绑定一个 Codex Provider",
        ));
    }
    if mode != "model_provider" {
        let home =
            dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
        release_provider_projection(&home, &provider_store_path(), &agent_id, &env).await?;
        let codex_home = resolve_agent_home(&home, &env, "CODEX_HOME", ".codex");
        let auth_path = codex_home.join("auth.json");
        let mut document = read_json_object_or_empty(&auth_path).await?;
        apply_codex_auth_mode(&mut document, mode, api_key)
            .map_err(ApplicationError::bad_request)?;
        let bytes = serde_json::to_vec_pretty(&document).map_err(internal_error)?;
        TokioNativeFileSystem
            .write_atomic(&auth_path, &bytes, true)
            .await
            .map_err(internal_error)?;
    }
    let _ = persist_observed_authentication(pool, &agent_id).await;
    with_account_label(project_auth_mode_view(pool, agent_id, &env).await?).await
}

async fn auth_mode_preflight_item(
    pool: &SqlitePool,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
    authentication: AgentAuthenticationStatus,
) -> Result<Option<AgentPreflightItemView>, ApplicationError> {
    if built_in_auth_mode_policy(agent_id).is_none() && agent_id.as_str() != "codex" {
        return Ok(None);
    }
    let view = match project_auth_mode_view(pool, agent_id.clone(), env).await {
        Ok(view) => view,
        Err(_) => {
            return Ok(Some(preflight_auth_item(
                false,
                "无法读取鉴权模式。".to_string(),
                "unknown",
            )));
        }
    };
    let headless_token_present = view
        .headless_account_env
        .as_deref()
        .and_then(|key| env.get(key))
        .is_some_and(|value| !value.trim().is_empty());
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog.profile(agent_id);
    let auth_required = profile.is_some_and(|profile| profile.authentication_required_by_default);
    let account_evidence_untracked =
        profile.is_some_and(|profile| profile.account_evidence.is_none());
    let ready = match auth_mode_kind(agent_id, &view.mode) {
        AgentAuthModeKind::OfficialApi | AgentAuthModeKind::Provider => view.credential_present,
        AgentAuthModeKind::Subscription => {
            matches!(authentication, AgentAuthenticationStatus::Account)
                || headless_token_present
                || (agent_id.as_str() == "opencode" && view.credential_present)
                || (!auth_required
                    && (matches!(authentication, AgentAuthenticationStatus::NotRequired)
                        || account_evidence_untracked))
        }
    };
    Ok(Some(preflight_auth_item(
        ready,
        if ready {
            String::new()
        } else {
            format!("当前鉴权模式 `{}` 尚未就绪。", view.mode)
        },
        &view.mode,
    )))
}

pub(crate) async fn persist_observed_authentication(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<AgentAuthenticationStatus, ApplicationError> {
    let env = read_agent_environment(pool, agent_id).await?;
    let authentication = observed_authentication(pool, agent_id, &env).await;
    persist_authentication_probe(pool, agent_id, authentication).await?;
    Ok(authentication)
}

async fn persist_authentication_probe(
    pool: &SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
) -> Result<(), ApplicationError> {
    let still_required = BuiltInProfileCatalog::management()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default)
        && matches!(
            authentication,
            AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
        );
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(agent_id, authentication, Some(still_required))
        .await
        .map_err(internal_error)
}

async fn observed_authentication(
    pool: &SqlitePool,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> AgentAuthenticationStatus {
    let recorded = recorded_authentication(pool, agent_id).await;
    let account_signed_out = AgentManagementApplicationService::new(pool.clone())
        .account_signed_out(agent_id)
        .await
        .unwrap_or(false);
    let headless_present = headless_account_env(agent_id)
        .and_then(|key| env.get(key))
        .is_some_and(|value| !value.trim().is_empty());
    let env_api_key_present = built_in_auth_mode_policy(agent_id)
        .map(|policy| policy.credential_env)
        .filter(|key| !key.is_empty())
        .and_then(|key| env.get(key))
        .is_some_and(|value| !value.trim().is_empty());
    let home = match dirs::home_dir() {
        Some(home) => home,
        None => return recorded,
    };
    let account_logged_in =
        official_account_present(&home, agent_id, env).await || headless_present;
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        env.clone().into_iter().collect::<BTreeMap<_, _>>(),
    );
    let auth_required_by_default = BuiltInProfileCatalog::management()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let native = match provider.read(agent_id, account_logged_in).await {
        Ok(snapshot) => {
            if snapshot.authentication == AgentAuthenticationStatus::NotLoggedIn {
                if account_logged_in {
                    AgentAuthenticationStatus::Account
                } else if env_api_key_present {
                    AgentAuthenticationStatus::ApiKey
                } else {
                    AgentAuthenticationStatus::NotLoggedIn
                }
            } else {
                snapshot.authentication
            }
        }
        Err(agents::NativeConfigError::Unsupported(_)) => {
            if !auth_required_by_default {
                AgentAuthenticationStatus::NotRequired
            } else if account_logged_in {
                AgentAuthenticationStatus::Account
            } else if env_api_key_present {
                AgentAuthenticationStatus::ApiKey
            } else {
                AgentAuthenticationStatus::NotLoggedIn
            }
        }
        Err(_) => recorded,
    };
    resolve_observed_authentication(
        recorded,
        native,
        bound_provider_has_credentials(agent_id, env).await,
        account_signed_out,
    )
}

async fn recorded_authentication(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> AgentAuthenticationStatus {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match value.as_deref() {
        Some("account") => AgentAuthenticationStatus::Account,
        Some("api_key") => AgentAuthenticationStatus::ApiKey,
        Some("multiple_unknown") => AgentAuthenticationStatus::MultipleUnknown,
        Some("not_required") => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

async fn installed_components(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<Vec<InstalledComponent>, ApplicationError> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        r#"SELECT component.component_kind, component.absolute_path,
                  component.version, component.ownership
           FROM agent_installation installation
           JOIN agent_install_component component
             ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
           ORDER BY component.component_kind"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await
    .map_err(internal_error)?;
    Ok(rows
        .into_iter()
        .map(|(kind, path, version, ownership)| {
            let path = PathBuf::from(path);
            InstalledComponent {
                exists: path.is_file(),
                kind,
                path,
                version,
                ownership,
            }
        })
        .collect())
}

pub(crate) struct ResolvedManagementProgram {
    pub args: Vec<String>,
    pub path: PathBuf,
}

pub(crate) async fn resolve_management_action_program(
    pool: &SqlitePool,
    agent_id: &AgentId,
    action: &agents::ProfileManagementAction,
    environment: &HashMap<String, String>,
) -> Option<ResolvedManagementProgram> {
    for entry in action.programs {
        let Some(path) =
            resolve_management_program(pool, agent_id, entry.program, environment).await
        else {
            continue;
        };
        return Some(ResolvedManagementProgram {
            args: entry
                .args
                .iter()
                .map(|argument| (*argument).to_string())
                .collect(),
            path,
        });
    }
    None
}

pub(crate) async fn resolve_management_program(
    pool: &SqlitePool,
    agent_id: &AgentId,
    program: &str,
    environment: &HashMap<String, String>,
) -> Option<PathBuf> {
    let components = sqlx::query_scalar::<_, String>(
        r#"SELECT component.absolute_path
           FROM agent_installation installation
           JOIN agent_install_component component ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
           ORDER BY CASE component.component_kind WHEN 'agent_runtime' THEN 0 ELSE 1 END"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await
    .ok()?;
    resolve_management_program_from_components(agent_id, program, environment, &components).await
}

async fn require_membership(pool: &SqlitePool, agent_id: &AgentId) -> Result<(), ApplicationError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM agent_membership WHERE agent_id = ?)",
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await
    .map_err(internal_error)?;
    if exists {
        Ok(())
    } else {
        Err(ApplicationError::not_found("Agent 尚未添加"))
    }
}

pub(crate) async fn read_agent_environment(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, ApplicationError> {
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    parse_agent_env(env_json.as_deref()).map_err(internal_error)
}

pub(crate) async fn persist_agent_environment(
    pool: &SqlitePool,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> Result<(), ApplicationError> {
    let env_json = serde_json::to_string(env).map_err(internal_error)?;
    sqlx::query(
        r#"INSERT INTO agent_setting (agent_type, env_json)
           VALUES (?, ?)
           ON CONFLICT(agent_type) DO UPDATE SET env_json = excluded.env_json"#,
    )
    .bind(agent_id.as_str())
    .bind(env_json)
    .execute(pool)
    .await
    .map_err(internal_error)?;
    Ok(())
}

pub(crate) async fn dispatch_environment(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse(args)?;
    serialize(project_agent_environment(
        args.agent_id.clone(),
        &read_agent_environment(pool, &args.agent_id).await?,
    ))
}

pub(crate) async fn dispatch_environment_write(
    pool: &SqlitePool,
    args: Value,
) -> Result<(AgentId, Value), ApplicationError> {
    #[derive(Deserialize)]
    struct EnvironmentWriteArgs {
        request: AgentEnvironmentPatchRequest,
    }
    let EnvironmentWriteArgs { request } = if args.get("request").is_some() {
        parse(args)?
    } else {
        EnvironmentWriteArgs {
            request: parse(args)?,
        }
    };
    let agent_id = request.agent_id.clone();
    let mut environment = read_agent_environment(pool, &agent_id).await?;
    let projected = apply_environment_patch(&mut environment, request)?;
    persist_agent_environment(pool, &agent_id, &environment).await?;
    let view = serialize(projected)?;
    Ok((agent_id, view))
}

async fn bound_provider_id(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<Option<String>, ApplicationError> {
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    let env = read_agent_environment(pool, agent_id).await?;
    let native_home = model_providers::provider_native_home(&home, &env, agent_id);
    let view = model_providers::list_with_native(
        &provider_store_path(),
        agent_id.clone(),
        Some(&native_home),
    )
    .await
    .map_err(|error| ApplicationError::internal(error.to_string()))?;
    Ok(view.bound_provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn probe_pool(
        agent_id: &str,
        lifecycle: &str,
        authentication: &str,
        authentication_required: i64,
    ) -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_installation (
                 agent_id TEXT PRIMARY KEY,
                 lifecycle TEXT NOT NULL,
                 current_lock_id TEXT
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_probe (
                 agent_id TEXT PRIMARY KEY,
                 lifecycle TEXT NOT NULL,
                 authentication TEXT NOT NULL,
                 detail_json TEXT NOT NULL,
                 probed_at TEXT NOT NULL,
                 runtime_available INTEGER NOT NULL DEFAULT 0,
                 acp_handshake INTEGER NOT NULL DEFAULT 0,
                 authentication_required INTEGER NOT NULL DEFAULT 0,
                 observation_generation INTEGER NOT NULL DEFAULT 0
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_installation VALUES (?, ?, 'lock-1')")
            .bind(agent_id)
            .bind(lifecycle)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_probe
               VALUES (?, ?, ?, '{}', '2026-08-01T00:00:00Z', 1, 1, ?, 1)"#,
        )
        .bind(agent_id)
        .bind(lifecycle)
        .bind(authentication)
        .bind(authentication_required)
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn persisting_api_key_observation_clears_needs_auth() {
        let pool = probe_pool("claude_code", "needs_auth", "not_logged_in", 1).await;
        let agent_id = AgentId::parse("claude_code").unwrap();
        persist_authentication_probe(&pool, &agent_id, AgentAuthenticationStatus::ApiKey)
            .await
            .unwrap();
        let row = sqlx::query_as::<_, (String, String, bool)>(
            "SELECT lifecycle, authentication, authentication_required FROM agent_probe WHERE agent_id = ?",
        )
        .bind(agent_id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("ready".into(), "api_key".into(), false));
    }

    #[tokio::test]
    async fn codebuddy_subscription_preflight_and_probe_do_not_require_static_account_evidence() {
        let pool = probe_pool("codebuddy", "needs_auth", "not_logged_in", 1).await;
        let agent_id = AgentId::parse("codebuddy").unwrap();
        persist_authentication_probe(&pool, &agent_id, AgentAuthenticationStatus::NotLoggedIn)
            .await
            .unwrap();
        let row = sqlx::query_as::<_, (String, String, bool)>(
            "SELECT lifecycle, authentication, authentication_required FROM agent_probe WHERE agent_id = ?",
        )
        .bind(agent_id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("ready".into(), "not_logged_in".into(), false));

        let temp = tempfile::tempdir().unwrap();
        let env = HashMap::from([
            (
                "CODEBUDDY_CONFIG_DIR".to_string(),
                temp.path().display().to_string(),
            ),
            (
                "CODEBUDDY_AUTH_MODE".to_string(),
                "official_subscription".to_string(),
            ),
        ]);
        let item = auth_mode_preflight_item(
            &pool,
            &agent_id,
            &env,
            AgentAuthenticationStatus::NotLoggedIn,
        )
        .await
        .unwrap()
        .expect("codebuddy auth mode preflight item");
        assert_eq!(item.status, "pass");
        assert_eq!(item.version.as_deref(), Some("official_subscription"));

        let api_env = HashMap::from([
            (
                "CODEBUDDY_CONFIG_DIR".to_string(),
                temp.path().display().to_string(),
            ),
            (
                "CODEBUDDY_AUTH_MODE".to_string(),
                "official_api".to_string(),
            ),
        ]);
        let api_item = auth_mode_preflight_item(
            &pool,
            &agent_id,
            &api_env,
            AgentAuthenticationStatus::NotLoggedIn,
        )
        .await
        .unwrap()
        .expect("codebuddy official_api preflight item");
        assert_eq!(api_item.status, "fail");
    }

    async fn lock_pool(agent_id: &str, components: &[(&str, &Path)]) -> sqlx::SqlitePool {
        use sqlx::{SqlitePool, query};
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        query("CREATE TABLE agent_installation (agent_id TEXT PRIMARY KEY, current_lock_id TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        query(
            "CREATE TABLE agent_install_component (
                 lock_id TEXT NOT NULL,
                 component_kind TEXT NOT NULL,
                 absolute_path TEXT NOT NULL
               )",
        )
        .execute(&pool)
        .await
        .unwrap();
        query("INSERT INTO agent_installation VALUES (?, 'lock-1')")
            .bind(agent_id)
            .execute(&pool)
            .await
            .unwrap();
        for (kind, path) in components {
            query("INSERT INTO agent_install_component VALUES ('lock-1', ?, ?)")
                .bind(*kind)
                .bind(path.display().to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    fn two_entry_action() -> agents::ProfileManagementAction {
        agents::ProfileManagementAction {
            id: "login",
            label: "登录",
            description: "登录",
            kind: ProfileManagementActionKind::Login,
            programs: &[
                agents::ProfileManagementProgram {
                    program: "vibex-test-agent-cli",
                    args: &["cli-login"],
                },
                agents::ProfileManagementProgram {
                    program: "vibex-test-agent-acp",
                    args: &["--cli", "adapter-login"],
                },
            ],
            url: None,
        }
    }

    #[tokio::test]
    async fn management_action_falls_back_to_the_adapter_entry_point() {
        let temp = tempfile::tempdir().unwrap();
        let adapter = temp.path().join("vibex-test-agent-acp.cmd");
        std::fs::write(&adapter, []).unwrap();
        let pool = lock_pool("vibex_test_agent", &[("acp_adapter", &adapter)]).await;
        let agent_id = AgentId::parse("vibex_test_agent").unwrap();

        let resolved = resolve_management_action_program(
            &pool,
            &agent_id,
            &two_entry_action(),
            &HashMap::new(),
        )
        .await
        .expect("the adapter entry point resolves");

        assert_eq!(resolved.path, adapter);
        assert_eq!(resolved.args, vec!["--cli", "adapter-login"]);
    }

    #[tokio::test]
    async fn management_action_prefers_the_standalone_cli_entry_point() {
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("vibex-test-agent-cli.cmd");
        std::fs::write(&cli, []).unwrap();
        let pool = lock_pool("vibex_test_agent", &[("agent_runtime", &cli)]).await;
        let agent_id = AgentId::parse("vibex_test_agent").unwrap();

        let resolved = resolve_management_action_program(
            &pool,
            &agent_id,
            &two_entry_action(),
            &HashMap::new(),
        )
        .await
        .expect("the standalone entry point resolves");

        assert_eq!(resolved.path, cli);
        assert_eq!(resolved.args, vec!["cli-login"]);
    }
}
