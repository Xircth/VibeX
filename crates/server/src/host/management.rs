use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentId, BuiltInProfile, BuiltInProfileCatalog, NativeConfigProvider, NativeConfigSnapshot,
    NativeFileSystem, ProfileComponent, ProfileManagementActionKind, TokioNativeFileSystem,
    apply_built_in_auth_mode_policy, apply_codex_auth_mode, auth_mode_credential_env,
    auth_mode_kind, authentication_from_account_command, built_in_auth_mode_policy,
    native_uses_custom_endpoint, official_api_url, project_codex_auth_mode, resolve_account_label,
    resolve_built_in_auth_mode, version_at_least,
};
use api_types::{
    AgentAccountFlowStatus, AgentAccountFlowView, AgentAuthModeKind, AgentAuthModeOptionView,
    AgentAuthModeView, AgentAuthenticationStatus, AgentDiagnosticView, AgentDiscoveryPhase,
    AgentDiscoveryProgressView, AgentEnvironmentDiagnosticCheckView,
    AgentEnvironmentDiagnosticLevel, AgentEnvironmentDiagnosticSectionView,
    AgentEnvironmentDiagnosticsView, AgentEnvironmentEntryView, AgentEnvironmentPatchRequest,
    AgentEnvironmentView, AgentLifecycleState, AgentManagementActionKind,
    AgentManagementActionReceipt, AgentManagementActionView, AgentManagementActionsView,
    AgentPreflightItemView, AgentPreflightView, AgentUpdateCheckView,
};
use application::ApplicationError;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use services::services::agent_management::AgentManagementApplicationService;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use super::{
    account_flow,
    native::{model_providers, provider_store_path},
};
use crate::domains::{internal_error, parse, serialize};

const DIAGNOSTIC_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_AGENT_ENVIRONMENT_ENTRIES: usize = 256;
const MAX_AGENT_ENVIRONMENT_NAME_BYTES: usize = 128;
const MAX_AGENT_ENVIRONMENT_VALUE_BYTES: usize = 64 * 1024;
const MAX_AGENT_ENVIRONMENT_BYTES: usize = 256 * 1024;
const SAFE_ENVIRONMENT_KEYS: &[&str] = &[
    "SHELL",
    "LANG",
    "NVM_DIR",
    "FNM_DIR",
    "FNM_MULTISHELL_PATH",
    "VOLTA_HOME",
    "ASDF_DATA_DIR",
    "MISE_DATA_DIR",
    "N_PREFIX",
    "HOMEBREW_PREFIX",
    "npm_config_prefix",
];

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
struct CheckUpdateArgs {
    agent_id: AgentId,
}

#[derive(Debug)]
struct InstalledComponent {
    kind: String,
    path: PathBuf,
    version: String,
    ownership: String,
    exists: bool,
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

pub async fn dispatch_check_update(
    pool: &SqlitePool,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: CheckUpdateArgs = parse(args)?;
    serialize(check_update(pool, args.agent_id).await?)
}

pub async fn dispatch_discovery_progress(pool: &SqlitePool) -> Result<Value, ApplicationError> {
    serialize(discovery_progress(pool).await?)
}

pub async fn preflight(
    pool: &SqlitePool,
    agent_id: AgentId,
    scope: Option<&str>,
) -> Result<AgentPreflightView, ApplicationError> {
    require_membership(pool, &agent_id).await?;
    let env = read_agent_environment(pool, &agent_id).await?;
    if scope == Some("authentication") {
        let authentication = observed_authentication(pool, &agent_id, &env).await;
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
        )
    });
    let mut acp_ok = acp.is_some_and(|component| component.exists);
    let mut acp_error = None;
    let mut discovered_acp_path = None;
    if !acp_ok {
        if let Some(path) = discover_profile_acp(&agent_id).await {
            acp_ok = true;
            discovered_acp_path = Some(path);
        } else if acp.is_some() {
            acp_error = Some("ACP executable is missing on disk".to_string());
        }
    }
    let runtime_ok =
        runtime.is_some_and(|component| component.exists) || view.local_runtime.is_some() || acp_ok;

    let catalog = BuiltInProfileCatalog::bundled();
    let (dependency_items, required_dependencies_ok) =
        if let Some(profile) = catalog.profile(&agent_id) {
            probe_profile_dependencies(profile).await
        } else {
            (Vec::new(), true)
        };

    let authentication = observed_authentication(pool, &agent_id, &env).await;
    let authentication_required = catalog
        .profile(&agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (auth_mode_item, auth_mode_ready, auth_satisfies) =
        match auth_mode_preflight_item(pool, &agent_id, &env, authentication).await? {
            Some(item) => {
                let ready = item.status == "pass";
                let satisfies = ready
                    || !matches!(
                        authentication,
                        AgentAuthenticationStatus::NotLoggedIn
                            | AgentAuthenticationStatus::MultipleUnknown
                    );
                (Some(item), ready, satisfies)
            }
            None => (None, true, true),
        };

    let lifecycle = if !acp_ok || !required_dependencies_ok {
        AgentLifecycleState::NeedsRepair
    } else if !auth_mode_ready
        || (authentication_required
            && !auth_satisfies
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
            acp_ok,
            authentication_required,
        )
        .await
        .map_err(internal_error)?;

    let status = |pass: bool| if pass { "pass" } else { "fail" }.to_string();
    let mut items = vec![
        AgentPreflightItemView {
            id: "membership".to_string(),
            label: "运行入口".to_string(),
            status: status(!view.retired),
            detail: if view.retired {
                "此 Agent 仅保留历史记录。".to_string()
            } else {
                "Agent 已加入本地列表。".to_string()
            },
            version: None,
            path: None,
            source: None,
            repairable: false,
            update_available: false,
            available_version: None,
            update_group: None,
        },
        AgentPreflightItemView {
            id: "acp".to_string(),
            label: "ACP 适配器".to_string(),
            status: status(acp_ok),
            detail: if acp_ok {
                String::new()
            } else if let Some(error) = acp_error.as_ref() {
                error.clone()
            } else if acp.is_none() {
                "未发现 ACP 安装组件。".to_string()
            } else {
                "已记录安装路径，但找不到 ACP 可执行文件。".to_string()
            },
            version: acp.map(|component| component.version.clone()),
            path: acp
                .map(|component| component.path.display().to_string())
                .or_else(|| discovered_acp_path.map(|path| path.display().to_string())),
            source: None,
            repairable: true,
            update_available: false,
            available_version: None,
            update_group: None,
        },
        AgentPreflightItemView {
            id: "runtime".to_string(),
            label: "运行时".to_string(),
            status: status(runtime_ok),
            detail: if runtime_ok {
                String::new()
            } else {
                "未发现可用运行时。".to_string()
            },
            version: runtime
                .map(|component| component.version.clone())
                .or_else(|| {
                    view.local_runtime
                        .as_ref()
                        .and_then(|runtime| runtime.version.clone())
                }),
            path: runtime
                .map(|component| component.path.display().to_string())
                .or_else(|| {
                    view.local_runtime
                        .as_ref()
                        .map(|runtime| runtime.path.clone())
                }),
            source: None,
            repairable: true,
            update_available: false,
            available_version: None,
            update_group: None,
        },
    ];
    items.extend(dependency_items);
    items.extend(auth_mode_item);
    Ok(AgentPreflightView {
        agent_id,
        checked_at: Utc::now().to_rfc3339(),
        items,
    })
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
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog
        .profile(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("环境诊断当前只适用于内置 Agent"))?;
    require_membership(pool, &agent_id).await?;

    let app_path = std::env::var_os("PATH").unwrap_or_default();
    let app_path_entries = std::env::split_paths(&app_path)
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let target_command = profile
        .external_candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
            )
        })
        .or_else(|| profile.external_candidates.first())
        .map(|candidate| candidate.executable)
        .unwrap_or(profile.agent_id.as_str());
    let target_on_app_path = resolve_on_path(target_command).await;
    let terminal = terminal_path_probe(target_command, &app_path_entries).await;
    let installed = installed_components(pool, &agent_id).await?;

    let mut runtime_checks = vec![
        check(
            "os_arch",
            "agents.environmentDiagnosticOsArch",
            format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "app_version",
            "agents.environmentDiagnosticAppVersion",
            env!("CARGO_PKG_VERSION").to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "shell",
            "agents.environmentDiagnosticShell",
            std::env::var("SHELL").unwrap_or_else(|_| "N/A".to_string()),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "app_path",
            "agents.environmentDiagnosticAppPath",
            app_path_entries.len().to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            Some("agents.environmentDiagnosticAppPathHint"),
        ),
    ];
    runtime_checks.extend(SAFE_ENVIRONMENT_KEYS.iter().filter_map(|key| {
        std::env::var(key).ok().map(|value| {
            check(
                &format!("environment.{key}"),
                "agents.environmentDiagnosticSafeEnvironment",
                format!("{key}={value}"),
                AgentEnvironmentDiagnosticLevel::Info,
                None,
            )
        })
    }));

    let mut dependency_checks = Vec::with_capacity(profile.dependencies.len());
    let mut missing_required_dependency = false;
    for dependency in profile.dependencies {
        let path = resolve_on_path(dependency.executable).await;
        let version = match path.as_ref() {
            Some(path) => probe_first_output_line(path, dependency.version_args).await,
            None => None,
        };
        let version_ok = version
            .as_deref()
            .map(|version| dependency_version_ok(dependency.requirement, version))
            .unwrap_or(path.is_some());
        let healthy = path.is_some() && version_ok;
        if dependency.required && !healthy {
            missing_required_dependency = true;
        }
        let level = if healthy {
            AgentEnvironmentDiagnosticLevel::Ok
        } else if dependency.required {
            AgentEnvironmentDiagnosticLevel::Error
        } else {
            AgentEnvironmentDiagnosticLevel::Warning
        };
        let value = match (version, path) {
            (Some(version), Some(path)) => format!("{version} ({})", path.display()),
            (None, Some(path)) => path.display().to_string(),
            _ => format!("NOT FOUND · {}", dependency.requirement),
        };
        dependency_checks.push(check(
            &format!("dependency.{}", dependency.id),
            &format!("agents.environmentDiagnosticDependency.{}", dependency.id),
            value,
            level,
            (!healthy).then_some(if dependency.required {
                "agents.environmentDiagnosticDependencyRequired"
            } else {
                "agents.environmentDiagnosticDependencyOptional"
            }),
        ));
    }
    if dependency_checks.is_empty() {
        dependency_checks.push(check(
            "dependency.none",
            "agents.environmentDiagnosticNoDependencies",
            "N/A".to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ));
    }

    let managed_launchable = installed.iter().any(|component| {
        component.exists && matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime")
    });
    let launchable = managed_launchable || target_on_app_path.is_some();
    let mut installation_checks = installed
        .iter()
        .map(|component| {
            check(
                &format!("component.{}", component.kind),
                &format!("agents.environmentDiagnosticComponent.{}", component.kind),
                format!(
                    "{} · {} · {}",
                    component.version,
                    component.ownership,
                    component.path.display()
                ),
                if component.exists {
                    AgentEnvironmentDiagnosticLevel::Ok
                } else {
                    AgentEnvironmentDiagnosticLevel::Error
                },
                (!component.exists).then_some("agents.environmentDiagnosticComponentMissing"),
            )
        })
        .collect::<Vec<_>>();
    installation_checks.push(check(
        "target_command",
        "agents.environmentDiagnosticTargetCommand",
        target_on_app_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| {
                if managed_launchable {
                    "user environment".to_string()
                } else {
                    "NOT RESOLVED".to_string()
                }
            }),
        if launchable {
            AgentEnvironmentDiagnosticLevel::Ok
        } else {
            AgentEnvironmentDiagnosticLevel::Error
        },
        managed_launchable.then_some("agents.environmentDiagnosticManagedLaunch"),
    ));

    let terminal_has_gap = target_on_app_path.is_none() && terminal.command_path.is_some();
    let mut terminal_checks = vec![check(
        "terminal_command",
        "agents.environmentDiagnosticTerminalCommand",
        terminal
            .command_path
            .clone()
            .or(terminal.note.clone())
            .unwrap_or_else(|| "NOT RESOLVED".to_string()),
        if terminal_has_gap {
            AgentEnvironmentDiagnosticLevel::Warning
        } else {
            AgentEnvironmentDiagnosticLevel::Info
        },
        terminal_has_gap.then_some("agents.environmentDiagnosticTerminalGap"),
    )];
    terminal_checks.push(check(
        "terminal_extra_paths",
        "agents.environmentDiagnosticTerminalExtraPaths",
        if terminal.extra_directories.is_empty() {
            "none".to_string()
        } else {
            terminal.extra_directories.join("\n")
        },
        if terminal.extra_directories.is_empty() {
            AgentEnvironmentDiagnosticLevel::Ok
        } else {
            AgentEnvironmentDiagnosticLevel::Warning
        },
        (!terminal.extra_directories.is_empty())
            .then_some("agents.environmentDiagnosticTerminalExtraPathsHint"),
    ));

    let (verdict_code, verdict_level) = if missing_required_dependency {
        ("dependency_missing", AgentEnvironmentDiagnosticLevel::Error)
    } else if !launchable && terminal_has_gap {
        (
            "terminal_path_gap",
            AgentEnvironmentDiagnosticLevel::Warning,
        )
    } else if !launchable {
        ("agent_not_resolved", AgentEnvironmentDiagnosticLevel::Error)
    } else if installed.iter().any(|component| !component.exists) {
        (
            "installation_invalid",
            AgentEnvironmentDiagnosticLevel::Error,
        )
    } else {
        ("ok", AgentEnvironmentDiagnosticLevel::Ok)
    };

    let sections = vec![
        section(
            "runtime",
            "agents.environmentDiagnosticRuntime",
            runtime_checks,
        ),
        section(
            "dependencies",
            "agents.environmentDiagnosticDependencies",
            dependency_checks,
        ),
        section(
            "installation",
            "agents.environmentDiagnosticInstallation",
            installation_checks,
        ),
        section(
            "terminal",
            "agents.environmentDiagnosticTerminal",
            terminal_checks,
        ),
    ];
    let generated_at = Utc::now().to_rfc3339();
    let plain_text = render_plain_text(
        &agent_id,
        verdict_code,
        &sections,
        &generated_at,
        &app_path_entries,
    );
    Ok(AgentEnvironmentDiagnosticsView {
        agent_id,
        verdict_code: verdict_code.to_string(),
        verdict_level,
        sections,
        generated_at,
        plain_text,
    })
}

pub async fn actions(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentManagementActionsView, ApplicationError> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        ApplicationError::not_found(format!("Agent `{agent_id}` 没有内置账号管理动作"))
    })?;
    let environment = read_agent_environment(pool, &agent_id).await?;
    let mut actions = Vec::with_capacity(profile.management_actions.len());
    for action in profile.management_actions {
        let program = match action.program {
            Some(program) => {
                resolve_management_program(pool, &agent_id, program, &environment).await
            }
            None => None,
        };
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
                    "未找到 `{}`；请先安装或修复此 Agent。",
                    action.program.unwrap_or("命令")
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
    let catalog = BuiltInProfileCatalog::bundled();
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

    if let Some(url) = action.url {
        utils::browser::open_browser(url)
            .await
            .map_err(internal_error)?;
    } else {
        let program_name = action
            .program
            .ok_or_else(|| ApplicationError::bad_request("账号管理动作缺少内置命令"))?;
        let environment = read_agent_environment(pool, &agent_id).await?;
        let program = resolve_management_program(pool, &agent_id, program_name, &environment)
            .await
            .ok_or_else(|| {
                ApplicationError::bad_request(format!(
                    "未找到 `{program_name}`；请先安装或修复此 Agent。"
                ))
            })?;
        let command = std::iter::once(program.display().to_string())
            .chain(action.args.iter().map(|argument| (*argument).to_string()))
            .map(|part| shell_quote_management_part(&part))
            .collect::<Vec<_>>()
            .join(" ");
        let command = management_command_with_environment(&command, &environment);
        let watches_account = matches!(
            action.kind,
            ProfileManagementActionKind::Login | ProfileManagementActionKind::Logout
        );
        let command = if watches_account {
            let result_path = account_flow::account_flow_result_path(&agent_id);
            let _ = tokio::fs::remove_file(&result_path).await;
            account_flow::register_account_flow(
                &agent_id,
                action.id,
                action.kind,
                result_path.clone(),
            );
            account_flow::wrap_account_flow_command(&command, &result_path)
        } else {
            command
        };
        spawn_agent_management_terminal(&command)
            .await
            .map_err(internal_error)?;
    }

    Ok(AgentManagementActionReceipt {
        agent_id,
        action_id,
        launched: true,
    })
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
    if authentication != recorded {
        AgentManagementApplicationService::new(pool.clone())
            .sync_authentication(&agent_id, authentication, None)
            .await
            .map_err(internal_error)?;
    }
    if exit_code == 0 {
        crate::host::events::global_host_events().emit("agent-management-snapshot-invalidated", ());
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
    apply_built_in_auth_mode_policy(&agent_id, &mut env);
    persist_agent_environment(pool, &agent_id, &env).await?;
    with_account_label(project_auth_mode_view(pool, agent_id, &env).await?).await
}

pub async fn check_update(
    pool: &SqlitePool,
    agent_id: AgentId,
) -> Result<AgentUpdateCheckView, ApplicationError> {
    let components = installed_components(pool, &agent_id).await?;
    let version_of = |id: &str| {
        components
            .iter()
            .find(|component| component.kind == id)
            .map(|component| component.version.clone())
    };
    let runtime_current = version_of("agent_runtime").or_else(|| version_of("combined_runtime"));
    let acp_current = version_of("acp_adapter").or_else(|| version_of("combined_runtime"));
    Ok(AgentUpdateCheckView {
        agent_id,
        current_version: acp_current.clone().or(runtime_current.clone()),
        available_version: None,
        update_available: false,
        runtime_current,
        runtime_available: None,
        acp_current,
        acp_available: None,
        compatibility_warning: None,
        snapshot_id: None,
        fetched_at: None,
        fresh: false,
    })
}

pub async fn discovery_progress(
    pool: &SqlitePool,
) -> Result<AgentDiscoveryProgressView, ApplicationError> {
    let ids = sqlx::query_scalar::<_, String>("SELECT agent_id FROM agent_membership")
        .fetch_all(pool)
        .await
        .map_err(internal_error)?;
    let checked_agent_ids = ids
        .iter()
        .filter_map(|id| AgentId::parse(id).ok())
        .collect::<Vec<_>>();
    let total = checked_agent_ids.len() as u32;
    Ok(AgentDiscoveryProgressView {
        phase: AgentDiscoveryPhase::Complete,
        completed: total,
        total,
        found: total,
        checked_agent_ids,
        timed_out: false,
    })
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

async fn project_auth_mode_view_at(
    home: &Path,
    store_path: &Path,
    agent_id: AgentId,
    env: &HashMap<String, String>,
) -> Result<AgentAuthModeView, ApplicationError> {
    let native_home = model_providers::provider_native_home(home, env, &agent_id);
    let providers =
        match model_providers::list_with_native(store_path, agent_id.clone(), Some(&native_home))
            .await
        {
            Ok(view) => view,
            Err(error) if error.contains("不支持可复用 Model Provider") => {
                api_types::AgentModelProvidersView {
                    agent_id: agent_id.clone(),
                    providers: Vec::new(),
                    bound_provider_id: None,
                }
            }
            Err(error) => return Err(ApplicationError::internal(error.to_string())),
        };
    let bound = providers.bound_provider_id.is_some();
    if agent_id.as_str() == "codex" {
        return read_codex_auth_mode(home, env, bound, &providers).await;
    }
    let policy = built_in_auth_mode_policy(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("此 Agent 没有独立鉴权模式"))?;
    let snapshot = read_native_auth_snapshot(home, env, &agent_id).await;
    let native_custom = snapshot
        .as_ref()
        .is_some_and(|snapshot| native_uses_custom_endpoint(&agent_id, snapshot));
    let mode = resolve_built_in_auth_mode(
        &agent_id,
        policy,
        env,
        bound,
        native_custom,
        snapshot.as_ref(),
    );
    let credential_env =
        auth_mode_credential_env(&agent_id, &mode).unwrap_or(policy.credential_env);
    let credential_present = credential_present_for_mode(
        &agent_id,
        &mode,
        env,
        credential_env,
        &providers,
        snapshot.as_ref(),
    );
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, policy.modes),
        agent_id,
        mode,
        modes: policy
            .modes
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: credential_env.to_string(),
        credential_present,
        account_label: None,
    })
}

fn credential_present_for_mode(
    agent_id: &AgentId,
    mode: &str,
    env: &HashMap<String, String>,
    credential_env: &str,
    providers: &api_types::AgentModelProvidersView,
    snapshot: Option<&NativeConfigSnapshot>,
) -> bool {
    match (agent_id.as_str(), mode) {
        (_, "model_provider") => providers
            .providers
            .iter()
            .find(|provider| Some(&provider.id) == providers.bound_provider_id.as_ref())
            .is_some_and(|provider| provider.credential_present),
        ("claude_code", "official_api" | "custom") => {
            snapshot.is_some_and(|snapshot| snapshot.field_present("anthropic_api_key"))
        }
        ("grok", "api_key" | "custom") => {
            snapshot.is_some_and(|snapshot| snapshot.field_present("grok_api_key"))
        }
        ("antigravity" | "gemini", "gemini-api-key") => {
            snapshot.is_some_and(|snapshot| snapshot.field_present("antigravity_api_key"))
        }
        ("antigravity" | "gemini", "agent-platform") => snapshot.is_some_and(|snapshot| {
            snapshot.field_present("antigravity_google_api_key")
                || (snapshot.field_text("antigravity_cloud_project").is_some()
                    && snapshot.field_text("antigravity_cloud_location").is_some())
        }),
        _ => env
            .get(credential_env)
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

async fn read_native_auth_snapshot(
    home: &Path,
    env: &HashMap<String, String>,
    agent_id: &AgentId,
) -> Option<NativeConfigSnapshot> {
    NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home.to_path_buf(),
        env.clone().into_iter().collect(),
    )
    .read(agent_id, false)
    .await
    .ok()
}

async fn read_codex_auth_mode(
    home: &Path,
    env: &HashMap<String, String>,
    bound: bool,
    providers: &api_types::AgentModelProvidersView,
) -> Result<AgentAuthModeView, ApplicationError> {
    let agent_id = AgentId::parse("codex").map_err(internal_error)?;
    let codex_home = resolve_agent_home(home, env, "CODEX_HOME", ".codex");
    let auth = read_json_object_or_empty(&codex_home.join("auth.json")).await?;
    let projection = project_codex_auth_mode(&auth, bound);
    let mut credential_present = projection.credential_present;
    if let Some(bound_provider) = providers.providers.iter().find(|provider| provider.bound) {
        credential_present = credential_present || bound_provider.credential_present;
    }
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, agents::CODEX_AUTH_MODES),
        agent_id,
        mode: projection.mode.to_string(),
        modes: agents::CODEX_AUTH_MODES
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: "OPENAI_API_KEY".to_string(),
        credential_present,
        account_label: None,
    })
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
    with_account_label(project_auth_mode_view(pool, agent_id, &env).await?).await
}

async fn with_account_label(
    view: AgentAuthModeView,
) -> Result<AgentAuthModeView, ApplicationError> {
    Ok(AgentAuthModeView {
        account_label: resolve_account_label(&view.agent_id).await,
        ..view
    })
}

fn project_auth_mode_options(agent_id: &AgentId, modes: &[&str]) -> Vec<AgentAuthModeOptionView> {
    modes
        .iter()
        .filter(|mode| !(**mode == "custom" && matches!(agent_id.as_str(), "claude_code" | "grok")))
        .map(|mode| {
            let (label_key, description_key) = auth_mode_translation_keys(agent_id, mode);
            let credential_env = auth_mode_credential_env(agent_id, mode)
                .map(str::to_string)
                .or_else(|| {
                    (agent_id.as_str() == "codex" && *mode == "api_key")
                        .then(|| "OPENAI_API_KEY".to_string())
                });
            AgentAuthModeOptionView {
                value: (*mode).to_string(),
                kind: auth_mode_kind(agent_id, mode),
                label_key: label_key.to_string(),
                description_key: description_key.to_string(),
                credential_required: credential_env.is_some(),
                credential_env,
                native_config_field_id: native_auth_config_field_id(agent_id, mode)
                    .map(str::to_string),
                official_api_url: official_api_url(agent_id, mode).map(str::to_string),
            }
        })
        .collect()
}

fn native_auth_config_field_id(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_api" | "custom") => Some("anthropic_api_key"),
        ("codex", "api_key") => Some("openai_api_key"),
        ("grok", "api_key") => Some("grok_api_key"),
        ("antigravity" | "gemini", "gemini-api-key") => Some("antigravity_api_key"),
        ("antigravity" | "gemini", "agent-platform") => Some("antigravity_google_api_key"),
        ("deepseek_harness", "deepseek" | "custom") => Some("deepseek_harness_api_key"),
        _ => None,
    }
}

fn auth_mode_translation_keys(agent_id: &AgentId, mode: &str) -> (&'static str, &'static str) {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescClaudeSubscription",
        ),
        ("claude_code", "official_api" | "custom") => (
            "agents.authModeOfficialApi",
            "agents.authDescClaudeOfficialApi",
        ),
        ("claude_code", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescClaudeProvider")
        }
        ("antigravity" | "gemini", "oauth-personal") => (
            "agents.authModeGoogleLogin",
            "agents.authDescAntigravityOauthPersonal",
        ),
        ("antigravity" | "gemini", "oauth-business") => (
            "agents.authModeAntigravityEnterprise",
            "agents.authDescAntigravityOauthBusiness",
        ),
        ("antigravity" | "gemini", "gemini-api-key") => (
            "agents.authModeGeminiKey",
            "agents.authDescAntigravityApiKey",
        ),
        ("antigravity" | "gemini", "agent-platform") => (
            "agents.authModeAntigravityPlatform",
            "agents.authDescAntigravityPlatform",
        ),
        ("antigravity" | "gemini", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGeminiProvider")
        }
        ("codex", "chatgpt_subscription") => {
            ("agents.authModeChatGpt", "agents.authDescCodexSubscription")
        }
        ("codex", "api_key") => (
            "agents.authModeOfficialApi",
            "agents.authDescCodexOfficialApi",
        ),
        ("codex", "model_provider") => ("agents.authModeProvider", "agents.authDescCodexProvider"),
        ("grok", "subscription") => (
            "agents.authModeSubscription",
            "agents.authDescGrokSubscription",
        ),
        ("grok", "api_key") => (
            "agents.authModeOfficialApi",
            "agents.authDescGrokOfficialApi",
        ),
        ("grok", "custom" | "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGrokProvider")
        }
        ("cursor", "subscription") => (
            "agents.authModeSubscription",
            "agents.authDescCursorSubscription",
        ),
        ("cursor", "custom") => (
            "agents.authModeOfficialApi",
            "agents.authDescCursorOfficialApi",
        ),
        ("deepseek_harness", "deepseek") => {
            ("agents.authModeOfficialApi", "agents.authDescDeepseekApi")
        }
        ("deepseek_harness", "custom") => {
            ("agents.authModeProvider", "agents.authDescDeepseekCustom")
        }
        ("opencode", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescOpencodeGo",
        ),
        ("opencode", "official_api") => {
            ("agents.authModeOfficialApi", "agents.authDescOpencodeZen")
        }
        ("opencode", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescOpencodeProvider")
        }
        ("hermes", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescHermesSubscription",
        ),
        ("hermes", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescHermesOfficialApi",
        ),
        ("hermes", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescHermesProvider")
        }
        ("kimi_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescKimiSubscription",
        ),
        ("kimi_code", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescKimiOfficialApi",
        ),
        ("kimi_code", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescKimiProvider")
        }
        ("cline", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescClineSubscription",
        ),
        ("cline", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescClineOfficialApi",
        ),
        ("cline", "model_provider") => ("agents.authModeProvider", "agents.authDescClineProvider"),
        ("codebuddy", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescCodebuddySubscription",
        ),
        ("qoder", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescQoderSubscription",
        ),
        ("pi" | "openclaw", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGenericProvider")
        }
        _ => ("agents.authModeUnknown", "agents.authDescUnknown"),
    }
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
    let ready = match auth_mode_kind(agent_id, &view.mode) {
        AgentAuthModeKind::OfficialApi | AgentAuthModeKind::Provider => view.credential_present,
        AgentAuthModeKind::Subscription => !matches!(
            authentication,
            AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
        ),
    };
    let ready = ready
        || matches!(
            authentication,
            AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
        );
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

fn preflight_auth_item(ready: bool, detail: String, version: &str) -> AgentPreflightItemView {
    AgentPreflightItemView {
        id: "authentication".to_string(),
        label: "鉴权".to_string(),
        status: if ready { "pass" } else { "fail" }.to_string(),
        detail,
        version: Some(version.to_string()),
        path: None,
        source: None,
        repairable: true,
        update_available: false,
        available_version: None,
        update_group: None,
    }
}

async fn observed_authentication(
    pool: &SqlitePool,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> AgentAuthenticationStatus {
    let recorded = recorded_authentication(pool, agent_id).await;
    let home = match dirs::home_dir() {
        Some(home) => home,
        None => return recorded,
    };
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        env.clone().into_iter().collect::<BTreeMap<_, _>>(),
    );
    let observed = match provider
        .read(agent_id, recorded == AgentAuthenticationStatus::Account)
        .await
    {
        Ok(snapshot) => snapshot.authentication,
        Err(agents::NativeConfigError::Unsupported(_)) => AgentAuthenticationStatus::NotRequired,
        Err(_) => recorded,
    };
    agents::prefer_recorded_account_over_residue(recorded, observed)
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

async fn probe_profile_dependencies(
    profile: &BuiltInProfile,
) -> (Vec<AgentPreflightItemView>, bool) {
    let mut required_ok = true;
    let mut items = Vec::with_capacity(profile.dependencies.len());
    for dependency in profile.dependencies {
        let path = resolve_on_path(dependency.executable).await;
        let version = match path.as_ref() {
            Some(path) => probe_first_output_line(path, dependency.version_args).await,
            None => None,
        };
        let version_ok = version
            .as_deref()
            .map(|version| dependency_version_ok(dependency.requirement, version))
            .unwrap_or(path.is_some());
        let healthy = path.is_some() && version_ok;
        if dependency.required && !healthy {
            required_ok = false;
        }
        items.push(AgentPreflightItemView {
            id: format!("dependency.{}", dependency.id),
            label: dependency.label.to_string(),
            status: if healthy { "pass" } else { "fail" }.to_string(),
            detail: if healthy {
                String::new()
            } else {
                format!(
                    "未满足依赖 `{}` ({})",
                    dependency.executable, dependency.requirement
                )
            },
            version,
            path: path.map(|path| path.display().to_string()),
            source: None,
            repairable: dependency.repairable,
            update_available: false,
            available_version: None,
            update_group: None,
        });
    }
    (items, required_ok)
}

async fn discover_profile_acp(agent_id: &AgentId) -> Option<PathBuf> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(agent_id)?;
    for candidate in profile.external_candidates {
        if !matches!(
            candidate.component,
            ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
        ) {
            continue;
        }
        if let Some(path) = resolve_on_path(candidate.executable).await {
            return Some(path);
        }
    }
    None
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

pub(crate) async fn resolve_management_program(
    pool: &SqlitePool,
    agent_id: &AgentId,
    program: &str,
    environment: &HashMap<String, String>,
) -> Option<PathBuf> {
    if agent_id.as_str() == "pi"
        && program == "pi"
        && let Some(command) = environment.get("PI_ACP_PI_COMMAND")
    {
        let exact = PathBuf::from(command.trim());
        if exact.is_file() {
            return Some(exact);
        }
        if let Some(first) = command.split_whitespace().next() {
            let candidate = PathBuf::from(first);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
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
    for component in components {
        let path = PathBuf::from(component);
        if executable_matches(&path, program) {
            return Some(path);
        }
        if let Some(parent) = path.parent() {
            for candidate in [
                parent.join(program),
                parent.join(format!("{program}.cmd")),
                parent.join(format!("{program}.exe")),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    utils::shell::resolve_executable_path(program).await
}

fn management_command_with_environment(
    command: &str,
    environment: &HashMap<String, String>,
) -> String {
    let mut variables = environment
        .iter()
        .filter(|(key, value)| {
            !value.trim().is_empty()
                && !["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
                    .iter()
                    .any(|marker| key.contains(marker))
                && (key.ends_with("_HOME")
                    || key.ends_with("_DIR")
                    || key.ends_with("_BASE_URL")
                    || key.starts_with("XDG_"))
        })
        .collect::<Vec<_>>();
    variables.sort_by_key(|(key, _)| *key);
    if variables.is_empty() {
        return command.to_string();
    }
    #[cfg(not(windows))]
    {
        let prefix = variables
            .into_iter()
            .map(|(key, value)| format!("{key}={}", shell_quote_management_part(value)))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{prefix} {command}")
    }
    #[cfg(windows)]
    {
        let prefix = variables
            .into_iter()
            .map(|(key, value)| {
                let escaped = value
                    .replace('^', "^^")
                    .replace('%', "%%")
                    .replace('&', "^&")
                    .replace('|', "^|")
                    .replace('<', "^<")
                    .replace('>', "^>");
                format!("set \"{key}={escaped}\"")
            })
            .collect::<Vec<_>>()
            .join(" && ");
        format!("{prefix} && {command}")
    }
}

fn executable_matches(path: &Path, program: &str) -> bool {
    path.file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(program))
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(program))
}

fn shell_quote_management_part(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:\\".contains(&byte))
    {
        return value.to_string();
    }
    #[cfg(windows)]
    return format!("\"{}\"", value.replace('"', "\\\""));
    #[cfg(not(windows))]
    return format!("'{}'", value.replace('\'', "'\\''"));
}

async fn spawn_agent_management_terminal(command: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", command])
            .spawn()
            .map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let run = format!("{command}; exec $SHELL");
        for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if utils::shell::resolve_executable_path(terminal)
                .await
                .is_some()
                && std::process::Command::new(terminal)
                    .args(["-e", "sh", "-lc", &run])
                    .spawn()
                    .map(|_| ())
                    .is_ok()
            {
                return Ok(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no supported terminal emulator found",
        ))
    }
}

fn management_action_kind(kind: ProfileManagementActionKind) -> AgentManagementActionKind {
    match kind {
        ProfileManagementActionKind::Login => AgentManagementActionKind::Login,
        ProfileManagementActionKind::Logout => AgentManagementActionKind::Logout,
        ProfileManagementActionKind::Setup => AgentManagementActionKind::Setup,
        ProfileManagementActionKind::Subscription => AgentManagementActionKind::Subscription,
    }
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

fn parse_agent_env(value: Option<&str>) -> Result<HashMap<String, String>, serde_json::Error> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map(Option::unwrap_or_default)
}

async fn persist_agent_environment(
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
    if request.values.len() > MAX_AGENT_ENVIRONMENT_ENTRIES {
        return Err(ApplicationError::bad_request("单次环境变量更新项过多"));
    }
    let mut environment = read_agent_environment(pool, &request.agent_id).await?;
    if environment_revision(&environment) != request.base_revision {
        return Err(ApplicationError::conflict(
            "Agent 环境变量已被其它操作修改，请重新读取后再保存",
        ));
    }
    for (name, value) in request.values {
        validate_agent_environment_name(&name)
            .map_err(|message| ApplicationError::bad_request(message))?;
        match value {
            Some(value) => {
                if value.len() > MAX_AGENT_ENVIRONMENT_VALUE_BYTES {
                    return Err(ApplicationError::bad_request(format!(
                        "环境变量 `{name}` 的值超过 64 KiB"
                    )));
                }
                environment.insert(name, value);
            }
            None => {
                environment.remove(&name);
            }
        }
    }
    if environment.len() > MAX_AGENT_ENVIRONMENT_ENTRIES {
        return Err(ApplicationError::bad_request(
            "Agent 环境变量不能超过 256 项",
        ));
    }
    let serialized = serde_json::to_string(&environment).map_err(internal_error)?;
    if serialized.len() > MAX_AGENT_ENVIRONMENT_BYTES {
        return Err(ApplicationError::bad_request(
            "Agent 环境变量总大小超过 256 KiB",
        ));
    }
    persist_agent_environment(pool, &request.agent_id, &environment).await?;
    let view = serialize(project_agent_environment(
        request.agent_id.clone(),
        &environment,
    ))?;
    Ok((request.agent_id, view))
}

fn project_agent_environment(
    agent_id: AgentId,
    environment: &HashMap<String, String>,
) -> AgentEnvironmentView {
    let ordered: BTreeMap<_, _> = environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    AgentEnvironmentView {
        agent_id,
        entries: ordered
            .iter()
            .map(|(name, value)| {
                let secret = is_secret_environment_name(name);
                AgentEnvironmentEntryView {
                    name: name.clone(),
                    value: (!secret).then(|| value.clone()),
                    secret,
                    present: true,
                    masked_value: secret.then(|| "••••••••".to_string()),
                }
            })
            .collect(),
        revision: environment_revision(environment),
    }
}

fn environment_revision(environment: &HashMap<String, String>) -> String {
    let ordered: BTreeMap<_, _> = environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let bytes = serde_json::to_vec(&ordered).expect("environment map is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_agent_environment_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_AGENT_ENVIRONMENT_NAME_BYTES {
        return Err("环境变量名称长度必须为 1 到 128 字节".to_string());
    }
    let mut bytes = name.bytes();
    let first = bytes.next().expect("non-empty environment name");
    if !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return Err(format!("环境变量名称 `{name}` 不合法"));
    }
    Ok(())
}

fn is_secret_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "API_KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "ACCESS_KEY",
    ]
    .iter()
    .any(|marker| upper.contains(marker))
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

fn resolve_agent_home(
    home: &Path,
    env: &HashMap<String, String>,
    override_env: &str,
    relative: &str,
) -> PathBuf {
    env.get(override_env)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(relative))
}

async fn read_json_object_or_empty(path: &Path) -> Result<Value, ApplicationError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(internal_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(internal_error(error)),
    }
}

async fn resolve_on_path(executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }
    utils::shell::resolve_executable_path(executable).await
}

async fn probe_first_output_line(path: &Path, args: &[&str]) -> Option<String> {
    let mut command = utils::process::new_hidden_tokio_command(path, args.iter().copied());
    command.kill_on_drop(true);
    let output = tokio::time::timeout(DIAGNOSTIC_COMMAND_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(redact_operation_output)
}

fn redact_operation_output(value: &str) -> String {
    let mut redacted = value.to_string();
    for marker in ["sk-", "key-", "token=", "Bearer "] {
        if let Some(index) = redacted.find(marker) {
            redacted.replace_range(index + marker.len().., "***");
            break;
        }
    }
    redacted
}

fn dependency_version_ok(requirement: &str, output: &str) -> bool {
    let requirement = requirement.trim();
    if let Some(min) = requirement.strip_prefix(">=") {
        return version_at_least(output, min.trim());
    }
    if let Some(min) = requirement.strip_prefix('>') {
        return version_at_least(output, min.trim()) && !output.contains(min.trim());
    }
    true
}

#[derive(Debug, Default)]
struct TerminalPathProbe {
    command_path: Option<String>,
    extra_directories: Vec<String>,
    note: Option<String>,
}

#[cfg(not(windows))]
async fn terminal_path_probe(command: &str, app_path: &[PathBuf]) -> TerminalPathProbe {
    if !command
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return TerminalPathProbe {
            note: Some("unsafe command name rejected".to_string()),
            ..TerminalPathProbe::default()
        };
    }
    let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from) else {
        return TerminalPathProbe {
            note: Some("SHELL is not set".to_string()),
            ..TerminalPathProbe::default()
        };
    };
    if !shell.is_absolute() || !shell.is_file() {
        return TerminalPathProbe {
            note: Some("configured shell is unavailable".to_string()),
            ..TerminalPathProbe::default()
        };
    }
    let script =
        format!("printf 'VIBEX_PATH=%s\\n' \"$PATH\"; command -v {command} 2>/dev/null || true");
    let mut process =
        utils::process::new_hidden_tokio_command(&shell, ["-lic", script.as_str()].into_iter());
    process.kill_on_drop(true);
    let output = match tokio::time::timeout(DIAGNOSTIC_COMMAND_TIMEOUT, process.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => {
            return TerminalPathProbe {
                note: Some("login shell probe failed or timed out".to_string()),
                ..TerminalPathProbe::default()
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut shell_path = Vec::new();
    let mut command_path = None;
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(path) = line.strip_prefix("VIBEX_PATH=") {
            shell_path = std::env::split_paths(path).collect();
        } else if command_path.is_none() && Path::new(line).is_absolute() {
            command_path = Some(line.to_string());
        }
    }
    let app_paths = app_path.iter().collect::<HashSet<_>>();
    TerminalPathProbe {
        command_path,
        extra_directories: shell_path
            .iter()
            .filter(|path| !app_paths.contains(path))
            .map(|path| path.display().to_string())
            .collect(),
        note: None,
    }
}

#[cfg(windows)]
async fn terminal_path_probe(_command: &str, _app_path: &[PathBuf]) -> TerminalPathProbe {
    TerminalPathProbe {
        note: Some("login shell comparison is unavailable on Windows".to_string()),
        ..TerminalPathProbe::default()
    }
}

fn check(
    id: &str,
    label_key: &str,
    value: String,
    level: AgentEnvironmentDiagnosticLevel,
    detail_key: Option<&str>,
) -> AgentEnvironmentDiagnosticCheckView {
    AgentEnvironmentDiagnosticCheckView {
        id: id.to_string(),
        label_key: label_key.to_string(),
        value,
        level,
        detail_key: detail_key.map(ToOwned::to_owned),
    }
}

fn section(
    id: &str,
    title_key: &str,
    checks: Vec<AgentEnvironmentDiagnosticCheckView>,
) -> AgentEnvironmentDiagnosticSectionView {
    AgentEnvironmentDiagnosticSectionView {
        id: id.to_string(),
        title_key: title_key.to_string(),
        checks,
    }
}

fn render_plain_text(
    agent_id: &AgentId,
    verdict: &str,
    sections: &[AgentEnvironmentDiagnosticSectionView],
    generated_at: &str,
    app_path: &[PathBuf],
) -> String {
    let mut lines = vec![
        "===== VibeX Agent environment diagnostics =====".to_string(),
        format!("agent: {agent_id}"),
        format!("verdict: {verdict}"),
        format!("generated_at: {generated_at}"),
    ];
    for section in sections {
        lines.push(String::new());
        lines.push(format!("[{}]", section.id));
        lines.extend(
            section
                .checks
                .iter()
                .map(|check| format!("{} [{:?}]: {}", check.id, check.level, check.value)),
        );
    }
    lines.push(String::new());
    lines.push("[app PATH]".to_string());
    lines.extend(app_path.iter().map(|path| path.display().to_string()));
    let mut report = lines.join("\n");
    const MAX_REPORT_BYTES: usize = 128 * 1024;
    if report.len() > MAX_REPORT_BYTES {
        let mut boundary = MAX_REPORT_BYTES;
        while boundary > 0 && !report.is_char_boundary(boundary) {
            boundary -= 1;
        }
        report.truncate(boundary);
        report.push_str("\n[report truncated]");
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_mode_options_cover_policy_modes() {
        let agent_id = AgentId::parse("claude_code").unwrap();
        let policy = built_in_auth_mode_policy(&agent_id).unwrap();
        let options = project_auth_mode_options(&agent_id, policy.modes);
        assert!(
            options
                .iter()
                .any(|option| option.value == "official_subscription")
        );
        assert!(
            options
                .iter()
                .any(|option| option.value == "model_provider")
        );
        assert!(!options.iter().any(|option| option.value == "custom"));
    }

    #[test]
    fn qoder_auth_options_are_subscription_only() {
        let agent_id = AgentId::parse("qoder").unwrap();
        let policy = built_in_auth_mode_policy(&agent_id).unwrap();
        let options = project_auth_mode_options(&agent_id, policy.modes);
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].value, "official_subscription");
        assert_eq!(options[0].kind, AgentAuthModeKind::Subscription);
        assert!(!options[0].credential_required);
    }

    #[test]
    fn copied_diagnostics_include_only_declared_checks_and_path() {
        let agent_id = AgentId::parse("codex").unwrap();
        let sections = vec![section(
            "runtime",
            "agents.environmentDiagnosticRuntime",
            vec![check(
                "shell",
                "agents.environmentDiagnosticShell",
                "/bin/zsh".to_string(),
                AgentEnvironmentDiagnosticLevel::Info,
                None,
            )],
        )];
        let report = render_plain_text(
            &agent_id,
            "ok",
            &sections,
            "2026-08-05T00:00:00Z",
            &[PathBuf::from("/usr/bin")],
        );
        assert!(report.contains("agent: codex"));
        assert!(report.contains("shell [Info]: /bin/zsh"));
        assert!(report.contains("/usr/bin"));
        assert!(!report.contains("API_KEY"));
    }

    #[test]
    fn dependency_requirement_uses_minimum_version() {
        assert!(dependency_version_ok(">=18.0.0", "v20.11.0"));
        assert!(!dependency_version_ok(">=20.0.0", "v18.0.0"));
    }

    #[test]
    fn empty_environment_projects_entries_array_not_raw_object() {
        let view = project_agent_environment(AgentId::parse("codex").unwrap(), &HashMap::new());
        let value = serde_json::to_value(&view).expect("serialize");
        assert!(value.get("entries").and_then(Value::as_array).is_some());
        assert_eq!(view.entries.len(), 0);
        assert!(!view.revision.is_empty());
    }

    #[test]
    fn secret_environment_values_are_masked() {
        let mut environment = HashMap::new();
        environment.insert("MODEL".to_string(), "gpt-5".to_string());
        environment.insert("OPENAI_API_KEY".to_string(), "sk-secret".to_string());
        let view = project_agent_environment(AgentId::parse("codex").unwrap(), &environment);
        let model = view
            .entries
            .iter()
            .find(|entry| entry.name == "MODEL")
            .expect("model");
        let secret = view
            .entries
            .iter()
            .find(|entry| entry.name == "OPENAI_API_KEY")
            .expect("secret");
        assert_eq!(model.value.as_deref(), Some("gpt-5"));
        assert!(!model.secret);
        assert_eq!(secret.value, None);
        assert!(secret.secret);
        assert_eq!(secret.masked_value.as_deref(), Some("••••••••"));
    }

    #[tokio::test]
    async fn native_codex_provider_selects_the_provider_auth_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"sk-native"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("codex").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
        assert_eq!(
            view.options
                .iter()
                .find(|option| option.value == "model_provider")
                .map(|option| option.kind),
            Some(AgentAuthModeKind::Provider)
        );
    }

    #[tokio::test]
    async fn claude_custom_endpoint_selects_the_provider_auth_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let claude_home = home.join(".claude");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-gateway","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            &HashMap::from([("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string())]),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
    }

    #[tokio::test]
    async fn official_claude_api_key_stays_on_the_official_api_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let claude_home = home.join(".claude");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"sk-ant"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "official_api");
    }
}
