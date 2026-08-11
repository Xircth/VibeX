//! Thin Tauri adapter for the managed Office Artifact provider.

use plugins::{
    DependencyState, PluginActivation, PluginMembership, PluginReadiness, ProviderState, SkillState,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use crate::{error::AppError, state::AppState};

pub const OFFICECLI_INSTALL_EVENT: &str = "officecli-install";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficecliInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub runtime_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArtifactPreviewLeaseDto {
    pub lease_id: uuid::Uuid,
    pub artifact_id: uuid::Uuid,
    pub provider_id: String,
    pub loopback_port: u16,
    pub capability_token: String,
    pub expires_at_unix_ms: u64,
    pub docx_fallback_supported: bool,
}

impl OfficecliInfo {
    fn missing() -> Self {
        Self {
            installed: false,
            version: None,
            path: None,
            runtime_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct OfficecliInstallEvent {
    task_id: String,
    kind: &'static str,
    payload: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OfficePluginCatalog {
    plugin: OfficePluginIdentity,
    actions: Vec<OfficePluginAction>,
    readiness: OfficePluginReadiness,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OfficePluginIdentity {
    id: String,
    name: String,
    version: String,
    membership: &'static str,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OfficePluginAction {
    plugin_id: String,
    action_id: String,
    label: String,
    required_skills: Vec<String>,
    required_tools: Vec<String>,
    prompt_blocks: Vec<OfficePromptBlock>,
    artifact_intent: Option<OfficeArtifactIntent>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OfficePromptBlock {
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    kind: &'static str,
    text: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OfficeArtifactIntent {
    media_types: Vec<String>,
    provider: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OfficePluginReadiness {
    enabled: bool,
    dependency: OfficeComponentReadiness,
    skills: Vec<OfficeComponentReadiness>,
    providers: Vec<OfficeComponentReadiness>,
    overall: &'static str,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OfficeComponentReadiness {
    id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn dependency_readiness(id: String, state: &DependencyState) -> OfficeComponentReadiness {
    match state {
        DependencyState::Missing => OfficeComponentReadiness {
            id,
            status: "missing",
            version: None,
            error: None,
        },
        DependencyState::Installing => OfficeComponentReadiness {
            id,
            status: "installing",
            version: None,
            error: None,
        },
        DependencyState::Ready { version, .. } => OfficeComponentReadiness {
            id,
            status: "ready",
            version: Some(version.clone()),
            error: None,
        },
        DependencyState::Failed { message, .. } => OfficeComponentReadiness {
            id,
            status: "failed",
            version: None,
            error: Some(message.clone()),
        },
        DependencyState::Incompatible { message, .. } => OfficeComponentReadiness {
            id,
            status: "incompatible",
            version: None,
            error: Some(message.clone()),
        },
    }
}

fn skill_readiness(id: String, state: &SkillState) -> OfficeComponentReadiness {
    match state {
        SkillState::Missing => OfficeComponentReadiness {
            id,
            status: "missing",
            version: None,
            error: None,
        },
        SkillState::Ready => OfficeComponentReadiness {
            id,
            status: "ready",
            version: None,
            error: None,
        },
        SkillState::Failed { message, .. } => OfficeComponentReadiness {
            id,
            status: "failed",
            version: None,
            error: Some(message.clone()),
        },
    }
}

fn provider_readiness(id: String, state: &ProviderState) -> OfficeComponentReadiness {
    match state {
        ProviderState::Unavailable => OfficeComponentReadiness {
            id,
            status: "unavailable",
            version: None,
            error: None,
        },
        ProviderState::Ready => OfficeComponentReadiness {
            id,
            status: "ready",
            version: None,
            error: None,
        },
        ProviderState::Degraded { message, .. } => OfficeComponentReadiness {
            id,
            status: "degraded",
            version: None,
            error: Some(message.clone()),
        },
    }
}

fn office_plugin_catalog(state: &AppState) -> Result<OfficePluginCatalog, AppError> {
    let manifest = state.office_runtime.bundled_plugin();
    let snapshot = state
        .office_runtime
        .bundled_plugin_snapshot()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let dependency = snapshot
        .dependencies
        .iter()
        .next()
        .map(|(id, state)| dependency_readiness(id.clone(), state))
        .ok_or_else(|| AppError::Internal("Office plugin dependency is missing".into()))?;

    Ok(OfficePluginCatalog {
        plugin: OfficePluginIdentity {
            id: manifest.id.as_str().to_owned(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            membership: match snapshot.membership {
                PluginMembership::Builtin => "builtin",
                PluginMembership::Added => "added",
            },
        },
        actions: manifest
            .actions
            .iter()
            .map(|action| OfficePluginAction {
                plugin_id: manifest.id.as_str().to_owned(),
                action_id: action.id.as_str().to_owned(),
                label: action.label.clone(),
                required_skills: action
                    .required_skills
                    .iter()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
                required_tools: action
                    .required_tools
                    .iter()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
                prompt_blocks: action
                    .prompt_blocks
                    .iter()
                    .map(|block| match block {
                        plugins::PromptBlock::Text { text } => OfficePromptBlock {
                            kind: "text",
                            text: text.clone(),
                        },
                    })
                    .collect(),
                artifact_intent: action.artifact_intent.as_ref().map(|intent| {
                    OfficeArtifactIntent {
                        media_types: intent.media_types.clone(),
                        provider: intent.provider.clone(),
                    }
                }),
            })
            .collect(),
        readiness: OfficePluginReadiness {
            enabled: snapshot.activation == PluginActivation::Enabled,
            dependency,
            skills: snapshot
                .skills
                .iter()
                .map(|(id, state)| skill_readiness(id.clone(), state))
                .collect(),
            providers: snapshot
                .providers
                .iter()
                .map(|(id, state)| provider_readiness(id.clone(), state))
                .collect(),
            overall: match snapshot.readiness {
                PluginReadiness::Ready => "ready",
                PluginReadiness::NotReady { .. } => "not_ready",
            },
        },
    })
}

pub fn plugin_action_catalog(state: State<'_, AppState>) -> Result<OfficePluginCatalog, AppError> {
    office_plugin_catalog(&state)
}

#[tauri::command]
pub async fn plugin_skills_configure(
    state: State<'_, AppState>,
    plugin_id: String,
    apps: Vec<String>,
    all_agents: bool,
    link: bool,
) -> Result<Vec<agents::skills::LocalSkill>, AppError> {
    state
        .office_runtime
        .configure_bundled_skills(&plugin_id, apps, all_agents, link)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn office_plugin_set_enabled(
    state: State<'_, AppState>,
    enabled: bool,
    task_id: String,
) -> Result<OfficePluginCatalog, AppError> {
    if task_id.trim().is_empty() {
        return Err(AppError::BadRequest("taskId must not be empty".into()));
    }
    state
        .office_runtime
        .set_bundled_enabled(enabled, &task_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    office_plugin_catalog(&state)
}

fn emit_install(app: &AppHandle, task_id: &str, kind: &'static str, payload: impl Into<String>) {
    let _ = app.emit(
        OFFICECLI_INSTALL_EVENT,
        OfficecliInstallEvent {
            task_id: task_id.to_owned(),
            kind,
            payload: payload.into(),
        },
    );
}

#[tauri::command]
pub async fn officecli_detect(state: State<'_, AppState>) -> Result<OfficecliInfo, AppError> {
    Ok(match state.office_runtime.detect().await {
        Ok(Some(lock)) => OfficecliInfo {
            installed: true,
            version: Some(lock.version),
            path: Some(lock.executable_path.to_string_lossy().into_owned()),
            runtime_error: None,
        },
        Ok(None) => OfficecliInfo::missing(),
        Err(error) => OfficecliInfo {
            runtime_error: Some(error.to_string()),
            ..OfficecliInfo::missing()
        },
    })
}

#[tauri::command]
pub async fn officecli_install(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<OfficecliInfo, AppError> {
    if task_id.trim().is_empty() {
        return Err(AppError::BadRequest("taskId must not be empty".into()));
    }
    emit_install(
        &app,
        &task_id,
        "started",
        "Downloading the version-locked OfficeCLI distribution…",
    );
    emit_install(
        &app,
        &task_id,
        "log",
        "The download will be verified with the bundled SHA-256 before execution.",
    );
    match state.office_runtime.install(&task_id).await {
        Ok(lock) => {
            emit_install(
                &app,
                &task_id,
                "completed",
                format!("OfficeCLI {} is ready.", lock.version),
            );
            Ok(OfficecliInfo {
                installed: true,
                version: Some(lock.version),
                path: Some(lock.executable_path.to_string_lossy().into_owned()),
                runtime_error: None,
            })
        }
        Err(error) => {
            emit_install(&app, &task_id, "failed", error.to_string());
            Err(AppError::Internal(error.to_string()))
        }
    }
}

#[tauri::command]
pub async fn officecli_cancel_install(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, AppError> {
    Ok(state.office_runtime.cancel_install(&task_id).await)
}

#[tauri::command]
pub async fn artifact_open_preview(
    state: State<'_, AppState>,
    artifact_id: uuid::Uuid,
) -> Result<ArtifactPreviewLeaseDto, AppError> {
    let lease = state
        .office_runtime
        .artifact_service()
        .open_preview(artifacts::OpenPreview { artifact_id })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(ArtifactPreviewLeaseDto {
        lease_id: lease.id,
        artifact_id: lease.artifact_id,
        provider_id: lease.provider_id,
        loopback_port: lease.loopback_port,
        capability_token: lease.capability_token,
        expires_at_unix_ms: lease.expires_at_unix_ms,
        docx_fallback_supported: lease.docx_fallback_supported,
    })
}

#[tauri::command]
pub async fn artifact_close_preview(
    state: State<'_, AppState>,
    lease_id: uuid::Uuid,
) -> Result<(), AppError> {
    state
        .office_runtime
        .artifact_service()
        .close_preview(lease_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn officecli_uninstall(state: State<'_, AppState>) -> Result<OfficecliInfo, AppError> {
    state
        .office_runtime
        .uninstall()
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(OfficecliInfo::missing())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWatchStartResult {
    pub port: Option<u16>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[tauri::command]
pub async fn start_office_watch(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<OfficeWatchStartResult, AppError> {
    Ok(
        match state
            .office_runtime
            .start_compatibility_preview(&file_path)
            .await
        {
            Ok(port) => OfficeWatchStartResult {
                port: Some(port),
                error_code: None,
                error_message: None,
            },
            Err(error) => OfficeWatchStartResult {
                port: None,
                error_code: Some(error.code().to_owned()),
                error_message: Some(error.to_string()),
            },
        },
    )
}

#[tauri::command]
pub async fn stop_office_watch(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<(), AppError> {
    state
        .office_runtime
        .stop_compatibility_preview(&file_path)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{OfficeComponentReadiness, OfficecliInfo};

    #[test]
    fn missing_info_preserves_frontend_contract() {
        let value = serde_json::to_value(OfficecliInfo::missing()).unwrap();
        assert_eq!(value["installed"], false);
        assert!(value["version"].is_null());
        assert!(value["path"].is_null());
        assert!(value["runtimeError"].is_null());
    }

    #[test]
    fn readiness_component_serializes_without_legacy_install_semantics() {
        let value = serde_json::to_value(OfficeComponentReadiness {
            id: "officecli".into(),
            status: "ready",
            version: Some("1.0.140".into()),
            error: None,
        })
        .unwrap();
        assert_eq!(value["id"], "officecli");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["version"], "1.0.140");
        assert!(value.get("installCommand").is_none());
    }
}
