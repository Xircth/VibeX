use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, Path, PathBuf},
};

use agents::{
    AgentAuthenticationStatus, AgentAutoApproveMode, AgentContentBlock, AgentId,
    AgentLifecycleState, AgentManagementSnapshot, SessionGate, SessionGateInput, SessionLaunchLock,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use db::models::{repo::Repo, workspace::Workspace};
use serde::Deserialize;
use sqlx::{Row, SqlitePool};

use crate::{AgentRuntimeLaunchSettings, ConversationHost, ConversationServiceError};

/// Product-owned host behavior shared by the desktop and headless composition
/// roots. All executable paths come from the persisted installation lock.
#[derive(Debug, Default)]
pub struct DefaultConversationHost;

#[async_trait::async_trait]
impl ConversationHost for DefaultConversationHost {
    fn resolve_working_dir(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
    ) -> Option<String> {
        resolve_workspace_agent_working_dir(workspace, container_ref, repos)
    }

    async fn build_prompt_blocks(
        &self,
        working_dir: &str,
        text: String,
        images: &[String],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        workspace_prompt_blocks(working_dir, text, images).await
    }

    async fn launch_settings(
        &self,
        pool: &SqlitePool,
        agent_id: &AgentId,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
        resolve_agent_runtime_launch_settings(pool, agent_id).await
    }
}

pub async fn resolve_agent_runtime_launch_settings(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError> {
    #[derive(Deserialize, Default)]
    struct LockedLaunchPayload {
        absolute_acp_program: Option<PathBuf>,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        runtime_version: Option<String>,
        acp_version: Option<String>,
    }

    let row = sqlx::query(
        r#"SELECT membership.enabled,
                  COALESCE(probe.lifecycle, installation.lifecycle, 'uninstalled') AS lifecycle,
                  COALESCE(probe.authentication, 'not_logged_in') AS authentication,
                  lock.resolved_json,
                  lock.id
           FROM agent_membership membership
           LEFT JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           LEFT JOIN agent_install_lock lock
             ON lock.id = installation.current_lock_id
           LEFT JOIN agent_probe probe
             ON probe.agent_id = membership.agent_id
           WHERE membership.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        ConversationServiceError::NotFound(format!("Agent `{agent_id}` has not been added"))
    })?;

    let snapshot = AgentManagementSnapshot {
        agent_id: agent_id.clone(),
        enabled: row.try_get("enabled")?,
        lifecycle: parse_management_lifecycle(row.try_get::<String, _>("lifecycle")?.as_str()),
        authentication: parse_management_authentication(
            row.try_get::<String, _>("authentication")?.as_str(),
        ),
        required_components: Vec::new(),
    };
    let resolved_json = row
        .try_get::<Option<String>, _>("resolved_json")?
        .ok_or_else(|| {
            ConversationServiceError::BadRequest(
                "Agent has no current Installation lock".to_string(),
            )
        })?;
    let payload: LockedLaunchPayload = serde_json::from_str(&resolved_json)?;
    let lock_id = row.try_get::<Option<String>, _>("id")?.ok_or_else(|| {
        ConversationServiceError::BadRequest("Agent has no current Installation lock".to_string())
    })?;
    let acp_component = sqlx::query(
        r#"SELECT absolute_path, version
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('acp', 'acp_adapter', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'acp' THEN 0 WHEN 'acp_adapter' THEN 1 ELSE 2 END
           LIMIT 1"#,
    )
    .bind(&lock_id)
    .fetch_optional(pool)
    .await?;
    let runtime_component = sqlx::query(
        r#"SELECT version
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('runtime', 'agent_runtime', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'runtime' THEN 0 WHEN 'agent_runtime' THEN 1 ELSE 2 END
           LIMIT 1"#,
    )
    .bind(&lock_id)
    .fetch_optional(pool)
    .await?;
    let absolute_acp_program = match acp_component.as_ref() {
        Some(component) => PathBuf::from(component.try_get::<String, _>("absolute_path")?),
        None => payload.absolute_acp_program.ok_or_else(|| {
            ConversationServiceError::Internal(
                "Installation lock has no ACP component path".to_string(),
            )
        })?,
    };
    if !absolute_acp_program.is_absolute() {
        return Err(ConversationServiceError::Internal(
            "Installation lock ACP component path is not absolute".to_string(),
        ));
    }
    let acp_version = match acp_component.as_ref() {
        Some(component) => component.try_get::<String, _>("version")?,
        None => payload.acp_version.ok_or_else(|| {
            ConversationServiceError::Internal("Installation lock has no ACP version".to_string())
        })?,
    };
    let runtime_version = match runtime_component.as_ref() {
        Some(component) => component.try_get::<String, _>("version")?,
        None => payload.runtime_version.ok_or_else(|| {
            ConversationServiceError::Internal(
                "Installation lock has no local Runtime version".to_string(),
            )
        })?,
    };
    let authorization = SessionGate
        .authorize(SessionGateInput {
            snapshot,
            current_lock: Some(SessionLaunchLock {
                agent_id: agent_id.clone(),
                absolute_acp_program,
                args: payload.args,
                env: payload.env,
                runtime_version,
                acp_version,
            }),
            requested_defaults: BTreeMap::new(),
            advertised_option_ids: Vec::new(),
            existing_binding: None,
            explicit_rebind: false,
        })
        .map_err(|error| ConversationServiceError::BadRequest(error.to_string()))?;

    Ok(AgentRuntimeLaunchSettings {
        auto_approve_mode: AgentAutoApproveMode::Off,
        env: HashMap::new(),
        launch_lock: SessionLaunchLock {
            agent_id: authorization.agent_id,
            absolute_acp_program: authorization.absolute_acp_program,
            args: authorization.args,
            env: authorization.env,
            runtime_version: authorization.runtime_version,
            acp_version: authorization.acp_version,
        },
    })
}

pub async fn workspace_prompt_blocks(
    working_dir: &str,
    text: String,
    images: &[String],
) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
    let mut blocks = if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    };
    for image in images {
        blocks.push(read_workspace_image_block(working_dir, image).await?);
    }
    if blocks.is_empty() {
        return Err(ConversationServiceError::BadRequest(
            "Prompt must include text or an image".to_string(),
        ));
    }
    Ok(blocks)
}

async fn read_workspace_image_block(
    working_dir: &str,
    relative_path: &str,
) -> Result<AgentContentBlock, ConversationServiceError> {
    let relative = relative_agent_asset_path(relative_path)?;
    let file_path = Path::new(working_dir).join(&relative);
    if !file_path.is_file() {
        return Err(ConversationServiceError::NotFound(format!(
            "Image not found: {relative_path}"
        )));
    }
    let bytes = tokio::fs::read(&file_path).await.map_err(|error| {
        ConversationServiceError::Internal(format!("Failed to read image {relative_path}: {error}"))
    })?;
    Ok(AgentContentBlock::Image {
        data: BASE64.encode(bytes),
        mime_type: mime_type_for_agent_asset(&file_path).to_string(),
        uri: Some(relative.to_string_lossy().replace('\\', "/")),
    })
}

fn relative_agent_asset_path(path: &str) -> Result<PathBuf, ConversationServiceError> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(ConversationServiceError::BadRequest(format!(
            "Image path must be workspace-relative: {path}"
        )));
    }
    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => relative.push(segment),
            Component::CurDir => {}
            _ => {
                return Err(ConversationServiceError::BadRequest(format!(
                    "Image path must stay inside the workspace: {path}"
                )));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(ConversationServiceError::BadRequest(
            "Image path cannot be empty".to_string(),
        ));
    }
    Ok(relative)
}

fn mime_type_for_agent_asset(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("heic") => "image/heic",
        Some("heif") => "image/heif",
        _ => "application/octet-stream",
    }
}

pub fn resolve_workspace_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    normalized_agent_working_dir(workspace, container_ref, repos)
        .or_else(|| infer_single_repo_working_dir(workspace, container_ref, repos))
}

fn normalized_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let raw = workspace
        .agent_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|directory| !directory.is_empty())?;
    let [repo] = repos else {
        return Some(raw.to_string());
    };
    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);
    let mut segments = raw
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if container_is_repo_root
        && segments
            .first()
            .is_some_and(|segment| segment == &repo.name)
    {
        segments.remove(0);
        return rebuild_relative_path(&segments);
    }
    if workspace.use_worktree
        && !container_is_repo_root
        && segments.first().is_none_or(|segment| segment != &repo.name)
    {
        segments.insert(0, repo.name.clone());
        return rebuild_relative_path(&segments);
    }
    Some(raw.to_string())
}

fn infer_single_repo_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let [repo] = repos else {
        return None;
    };
    let default_working_dir = repo
        .default_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|directory| !directory.is_empty());
    if !workspace.use_worktree {
        return default_working_dir.map(ToOwned::to_owned);
    }
    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);
    match default_working_dir {
        Some(subdirectory) if container_is_repo_root => Some(subdirectory.to_string()),
        Some(subdirectory) => Some(
            PathBuf::from(&repo.name)
                .join(subdirectory)
                .to_string_lossy()
                .to_string(),
        ),
        None if container_is_repo_root => None,
        None => Some(repo.name.clone()),
    }
}

fn single_repo_base_path_is_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repo: &Repo,
) -> bool {
    if !workspace.use_worktree {
        return true;
    }
    let mut next = workspace.clone();
    next.container_ref = Some(container_ref.to_string());
    next.repo_path(repo)
        .is_some_and(|path| path == Path::new(container_ref))
}

fn rebuild_relative_path(segments: &[String]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }
    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    Some(path.to_string_lossy().to_string())
}

fn parse_management_lifecycle(value: &str) -> AgentLifecycleState {
    match value {
        "retired" => AgentLifecycleState::Retired,
        "platform_unsupported" => AgentLifecycleState::PlatformUnsupported,
        "queued" => AgentLifecycleState::Queued,
        "installing" => AgentLifecycleState::Installing,
        "updating" => AgentLifecycleState::Updating,
        "repairing" => AgentLifecycleState::Repairing,
        "needs_auth" => AgentLifecycleState::NeedsAuth,
        "needs_config" => AgentLifecycleState::NeedsConfig,
        "ready" => AgentLifecycleState::Ready,
        "uninstalled" => AgentLifecycleState::Uninstalled,
        _ => AgentLifecycleState::NeedsRepair,
    }
}

fn parse_management_authentication(value: &str) -> AgentAuthenticationStatus {
    match value {
        "account" => AgentAuthenticationStatus::Account,
        "api_key" => AgentAuthenticationStatus::ApiKey,
        "multiple_unknown" => AgentAuthenticationStatus::MultipleUnknown,
        "not_required" => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}
