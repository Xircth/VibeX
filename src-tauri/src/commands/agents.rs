use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
};

use agents::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentConfigSurface, AgentConnectionId,
    AgentConnectionSnapshot, AgentContentBlock, AgentHistorySource, AgentInstallPlan, AgentKind,
    AgentMcpConfig, AgentMcpSurface, AgentPermissionId, AgentPermissionResponse,
    AgentPreparedSessionSnapshot, AgentPromptId, AgentPromptSnapshot, AgentRegistryEntry,
    AgentRuntime, AgentSessionControlsSnapshot, AgentSessionId, AgentSessionSnapshot,
    AgentSkillsSurface, AgentTerminalId, AgentTerminalOutputSnapshot, CancelAgentPromptInput,
    ConnectAgentInput, ImportedAgentSession, PlanUsageResult, RespondAgentPermissionInput,
    ResumeAgentSessionInput, RuntimeSnapshot, SendAgentPromptInput, all_agent_types,
    claude_config_path, codex_config_path, config_surface, default_history_sources,
    default_mcp_config_path, import_history_source, mcp_file_config, mcp_surface,
    opencode_config_path, read_agent_mcp_config, registry_entry, skills_surface,
    terminal::agent_terminal_registry, write_agent_mcp_config,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    agent_capability_catalog::AgentCapabilityCatalogRecord,
    agent_setting::AgentSetting,
    conversation_bundle::{ConversationImportRecord, InsertConversationImport},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

impl From<agents::AgentError> for AppError {
    fn from(error: agents::AgentError) -> Self {
        match error {
            agents::AgentError::ConnectionNotFound(message)
            | agents::AgentError::SessionNotFound(message)
            | agents::AgentError::PromptNotFound(message)
            | agents::AgentError::UnsupportedAgent(message) => AppError::NotFound(message),
            agents::AgentError::UnsupportedPlatform { agent, platform } => AppError::BadRequest(
                format!("Agent `{agent}` is unsupported on platform `{platform}`"),
            ),
            agents::AgentError::InvalidDistribution(message)
            | agents::AgentError::Runtime(message) => AppError::Internal(message),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectRequest {
    pub agent_type: AgentKind,
    pub workspace_id: String,
    pub working_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNewSessionRequest {
    pub connection_id: String,
    pub acp_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrepareSessionRequest {
    pub agent_type: AgentKind,
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedSessionModeRequest {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedSessionConfigRequest {
    pub session_id: String,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendPromptRequest {
    pub connection_id: String,
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCancelPromptRequest {
    pub connection_id: String,
    pub session_id: String,
    pub prompt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRespondPermissionRequest {
    pub connection_id: String,
    pub permission_id: String,
    pub response: AgentPermissionResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionRequest {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetAutoApproveRequest {
    pub agent_type: AgentKind,
    pub auto_approve_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResumeSessionRequest {
    pub agent_type: AgentKind,
    pub workspace_id: String,
    pub working_dir: String,
    pub session_id: String,
    pub external_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalSnapshotRequest {
    pub terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypeRequest {
    pub agent_type: AgentKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryImportRequest {
    pub agent_type: AgentKind,
    pub path: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigReadRequest {
    pub agent_type: AgentKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigWriteRequest {
    pub agent_type: AgentKind,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpWriteRequest {
    pub agent_type: AgentKind,
    pub config: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigFileDto {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpConfigDto {
    pub path: String,
    pub config: Value,
    pub surface: AgentMcpConfig,
}

#[tauri::command]
pub async fn agent_registry_list() -> Result<Vec<AgentRegistryEntry>, AppError> {
    Ok(AgentRuntime::default().registry())
}

/// Read the matching persisted capability catalog. This command is deliberately
/// side-effect free: opening a selector must never start an ACP process.
#[tauri::command]
pub async fn agent_capability_catalog(
    state: tauri::State<'_, AppState>,
    agent_type: AgentKind,
) -> Result<Option<AgentSessionControlsSnapshot>, AppError> {
    read_matching_capability_catalog_for_pool(&state.deployment.db().pool, agent_type).await
}

/// Read a catalog only when its persisted runtime/config fingerprint still
/// matches the local installation. This is shared by every UI surface that
/// needs session configuration, so no settings screen can accidentally grow a
/// second, static model source or launch a bare runtime.
pub(crate) async fn read_matching_capability_catalog_for_pool(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> Result<Option<AgentSessionControlsSnapshot>, AppError> {
    let Some(fingerprint) = capability_catalog_fingerprint(pool, agent_type).await? else {
        // A local executable changed since the catalog's identity was saved.
        // The startup/preflight verifier will establish a new pair and warm a
        // fresh row; never expose an older row during that gap.
        return Ok(None);
    };
    let Some(record) =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_type.as_str(), &fingerprint)
            .await?
    else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&record.controls_json).ok())
}

/// The prompt-enhancement settings use the exact same persisted OpenCode
/// catalog as session creation. It deliberately returns an empty list while a
/// catalog is absent or stale: inventing static/free-tier choices here would
/// let the UI save a model that the verified runtime cannot use.
pub(crate) async fn opencode_capability_catalog_models(
    pool: &sqlx::SqlitePool,
) -> Result<Vec<String>, AppError> {
    let Some(snapshot) =
        read_matching_capability_catalog_for_pool(pool, AgentKind::Opencode).await?
    else {
        return Ok(Vec::new());
    };
    Ok(opencode_models_from_catalog(&snapshot))
}

fn opencode_models_from_catalog(snapshot: &AgentSessionControlsSnapshot) -> Vec<String> {
    let mut models = Vec::new();
    for option in snapshot
        .config_options
        .iter()
        // `probe_opencode_session_controls` canonically emits this option.
        // Match its key rather than labels, which are presentation-only and
        // may be localized by a future OpenCode release.
        .filter(|option| option.key == "model")
    {
        for choice in &option.choices {
            let Some(model) = choice.value.as_str().map(str::trim) else {
                continue;
            };
            if !model.is_empty() && !models.iter().any(|existing| existing == model) {
                models.push(model.to_string());
            }
        }
    }
    models
}

/// Schedule a discovery refresh explicitly (startup/install/config lifecycle
/// callers use this), never from a selector read.
#[tauri::command]
pub async fn agent_refresh_capability_catalog(
    state: tauri::State<'_, AppState>,
    agent_type: AgentKind,
) -> Result<bool, AppError> {
    refresh_capability_catalog_for_pool(&state.deployment.db().pool, agent_type).await
}

/// Lifecycle callers (startup reconciliation and in-app installer flows) use
/// this pool-based variant so catalog work never needs to hold up Tauri setup
/// or manufacture a `tauri::State` outside a command.
pub(crate) async fn refresh_capability_catalog_for_pool(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> Result<bool, AppError> {
    // An explicit refresh follows an install/update/config change. Do not let
    // a prior failed (or obsolete) discovery result survive that lifecycle
    // boundary for the rest of this app run.
    invalidate_capability_probe(agent_type);
    let probe = probed_session_controls(pool, agent_type).await;
    let Some(snapshot) = probe.snapshot else {
        return Ok(false);
    };
    persist_capability_catalog(pool, agent_type, &snapshot, probe.epoch).await
}

async fn capability_catalog_fingerprint(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> Result<Option<String>, AppError> {
    let setting = AgentSetting::find_by_type(pool, agent_type.as_str()).await?;
    // Resolve the persisted identity exactly once. Apart from avoiding a
    // second manifest hash/PATH scan on every selector read, this prevents a
    // file replacement between two validations from degrading a stale pair
    // into a reusable `unverified` fingerprint.
    let persisted_runtime_identity = setting.as_ref().map(|setting| {
        crate::commands::agent_settings::persisted_runtime_catalog_identity(agent_type, setting)
    });
    if persisted_runtime_identity.as_ref().is_some_and(|identity| {
        matches!(
            identity,
            crate::commands::agent_settings::PersistedRuntimeCatalogIdentity::Stale
        )
    }) {
        // Do not turn a stale identity into a stable "unverified" key. A
        // previous failed/warmup row under such a key could otherwise be read
        // again after a later runtime update. The only safe action is to wait
        // for lifecycle verification to replace the persisted identity.
        return Ok(None);
    }
    let mut digest = Sha256::new();
    digest.update(agent_type.as_str().as_bytes());
    // A catalog belongs to the adapter build that produced it. Without this,
    // a package upgrade can leave an old adapter's model list visible forever
    // even though the current adapter advertises newer capabilities.
    let entry = registry_entry(agent_type);
    digest.update(serde_json::to_vec(&entry.distribution)?);
    if let Some(setting) = setting.as_ref() {
        // Hashing invalidates on account/config changes without persisting
        // sensitive environment/config JSON alongside the catalog.
        digest.update(
            setting
                .installed_version
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        digest.update(setting.env_json.as_deref().unwrap_or_default().as_bytes());
        digest.update(
            setting
                .config_json
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        digest.update(setting.auto_approve_mode.as_bytes());
    }
    append_local_runtime_identity(
        &mut digest,
        agent_type,
        persisted_runtime_identity
            .unwrap_or(crate::commands::agent_settings::PersistedRuntimeCatalogIdentity::Missing),
    );
    append_native_config_revision(&mut digest, agent_type);
    Ok(Some(format!("{:x}", digest.finalize())))
}

/// Capabilities depend on both the ACP bridge and the exact CLI that bridge
/// delegates to. A previously verified pair is persisted in `agent_setting`,
/// allowing a fresh process to validate the catalog via SQLite + filesystem
/// reads only. No selector read can spawn a version probe or ACP process.
///
/// If a persisted revision is stale, do *not* fall back to the in-memory
/// cache: the previous catalog must remain hidden until startup/preflight
/// verifies the replacement runtime. A cache fallback is allowed only for
/// legacy rows that have no persisted identity yet, preserving the current
/// process's startup warmup path during the migration rollout.
fn append_local_runtime_identity(
    digest: &mut Sha256,
    agent_type: AgentKind,
    persisted_runtime_identity: crate::commands::agent_settings::PersistedRuntimeCatalogIdentity,
) {
    use crate::commands::agent_settings::PersistedRuntimeCatalogIdentity;

    digest.update(b"local-runtime-identity-v2:");
    let identity = match persisted_runtime_identity {
        PersistedRuntimeCatalogIdentity::Valid(identity) => Some(identity),
        PersistedRuntimeCatalogIdentity::Stale => {
            digest.update(b"unverified");
            return;
        }
        PersistedRuntimeCatalogIdentity::Missing => {
            crate::commands::agent_settings::cached_verified_local_agent_runtime_identity(
                agent_type,
            )
        }
    };

    match identity {
        Some(identity) => {
            digest.update(identity.cli_path.to_string_lossy().as_bytes());
            digest.update(b"\0");
            digest.update(identity.cli_version.as_bytes());
            digest.update(b"\0");
            digest.update(identity.cli_revision.as_bytes());
            digest.update(b"\0");
            digest.update(identity.acp_path.to_string_lossy().as_bytes());
            digest.update(b"\0");
            digest.update(identity.acp_version.as_bytes());
            digest.update(b"\0");
            digest.update(identity.acp_revision.as_bytes());
        }
        None => digest.update(b"unverified"),
    }
}

/// Native Agent config can change the controls an adapter advertises without
/// touching VibeX's `agent_setting` row. In particular, OpenCode's provider
/// file changes the models returned by `opencode models --verbose`. Fold a
/// content hash into the catalog key so an external/provider-settings edit can
/// never keep a free-model-only catalog alive. The file contents are not
/// persisted or logged; only the enclosing catalog digest is stored.
fn append_native_config_revision(digest: &mut Sha256, agent_type: AgentKind) {
    let Some(path) = default_config_path(agent_type) else {
        return;
    };
    digest.update(b"native-config-path:");
    digest.update(path.to_string_lossy().as_bytes());
    match std::fs::read(&path) {
        Ok(contents) => {
            digest.update(b"native-config-content:");
            digest.update(contents);
        }
        Err(_) => digest.update(b"native-config-missing"),
    }
}

async fn persist_capability_catalog(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
    snapshot: &AgentSessionControlsSnapshot,
    probe_epoch: u64,
) -> Result<bool, AppError> {
    // A CLI/ACP update may invalidate a probe while its throwaway session is
    // completing. Never pair that old snapshot with the new runtime's
    // fingerprint; the lifecycle refresh that advanced the epoch will probe
    // again instead.
    if !is_current_probe_epoch(agent_type, probe_epoch) {
        return Ok(false);
    }
    let Some(fingerprint) = capability_catalog_fingerprint(pool, agent_type).await? else {
        return Ok(false);
    };
    if !is_current_probe_epoch(agent_type, probe_epoch) {
        return Ok(false);
    }
    let controls_json = serde_json::to_string(snapshot)?;
    AgentCapabilityCatalogRecord::replace(pool, agent_type.as_str(), &fingerprint, &controls_json)
        .await?;
    Ok(is_current_probe_epoch(agent_type, probe_epoch))
}

/// Once-per-app-run cache of ACP discovery-probe results (success AND
/// failure), so the create form never re-spawns an agent it already asked.
/// Plain sync mutex: held only for map reads/writes, never across an await.
#[derive(Clone)]
struct CachedProbeResult {
    epoch: u64,
    snapshot: Option<AgentSessionControlsSnapshot>,
}

static PROBED_SESSION_CONTROLS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<AgentKind, CachedProbeResult>>,
> = std::sync::OnceLock::new();

/// Invalidation is a generation boundary, not merely cache deletion. A probe
/// that began with an old local CLI may finish after a Runtime/ACP update; its
/// result must not be cached or persisted under the new runtime identity.
static CAPABILITY_PROBE_EPOCHS: std::sync::OnceLock<std::sync::Mutex<HashMap<AgentKind, u64>>> =
    std::sync::OnceLock::new();

/// Per-agent-type in-flight serialization for the discovery probe (reference
/// pattern: codeg `probe_locks`). Rapid re-opens of the create form would
/// otherwise fan out one real CLI process per query; the per-agent mutex
/// bounds that to one, while different agents still probe in parallel.
static PROBE_LOCKS: std::sync::OnceLock<
    tokio::sync::Mutex<HashMap<AgentKind, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::OnceLock::new();

fn current_probe_epoch(agent_type: AgentKind) -> u64 {
    CAPABILITY_PROBE_EPOCHS
        .get_or_init(Default::default)
        .lock()
        .expect("probe epoch lock")
        .get(&agent_type)
        .copied()
        .unwrap_or_default()
}

fn is_current_probe_epoch(agent_type: AgentKind, epoch: u64) -> bool {
    current_probe_epoch(agent_type) == epoch
}

fn cached_probe_entry(agent_type: AgentKind) -> Option<CachedProbeResult> {
    let epoch = current_probe_epoch(agent_type);
    PROBED_SESSION_CONTROLS
        .get_or_init(Default::default)
        .lock()
        .expect("probe cache lock")
        .get(&agent_type)
        .filter(|cached| cached.epoch == epoch)
        .cloned()
}

#[cfg(test)]
fn cached_probe_result(agent_type: AgentKind) -> Option<Option<AgentSessionControlsSnapshot>> {
    cached_probe_entry(agent_type).map(|cached| cached.snapshot)
}

/// Atomically publish a probe result only while its lifecycle epoch is still
/// current. Both this helper and invalidation take the epoch lock before the
/// cache lock, so an old probe can never reinsert itself after an update has
/// cleared the cache.
fn cache_probe_result_if_current(agent_type: AgentKind, result: CachedProbeResult) -> bool {
    let epochs = CAPABILITY_PROBE_EPOCHS
        .get_or_init(Default::default)
        .lock()
        .expect("probe epoch lock");
    if epochs.get(&agent_type).copied().unwrap_or_default() != result.epoch {
        return false;
    }
    PROBED_SESSION_CONTROLS
        .get_or_init(Default::default)
        .lock()
        .expect("probe cache lock")
        .insert(agent_type, result);
    true
}

/// Drop the in-memory result only. The persisted catalog is fingerprinted and
/// deliberately remains available until a successful explicit refresh replaces
/// it; callers use this after a local Runtime/ACP lifecycle change.
pub(crate) fn invalidate_capability_probe(agent_type: AgentKind) {
    {
        let mut epochs = CAPABILITY_PROBE_EPOCHS
            .get_or_init(Default::default)
            .lock()
            .expect("probe epoch lock");
        let epoch = epochs.entry(agent_type).or_default();
        *epoch = epoch.wrapping_add(1);
    }
    if let Some(cache) = PROBED_SESSION_CONTROLS.get() {
        cache.lock().expect("probe cache lock").remove(&agent_type);
    }
}

/// The agent's REAL advertised controls, obtained without any user-visible
/// session: spawn → initialize → throwaway `session/new` in a scratch dir →
/// capture (incl. follow-up `session/update` pushes) → kill (see
/// `agents::probe`). Only agents verified locally present are probed — never
/// triggering an npx download or poking an agent that cannot start
/// (unauthenticated ones fail fast and are cached as such).
async fn probed_session_controls(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> CachedProbeResult {
    let entry = registry_entry(agent_type);
    // The outer locks-map guard MUST drop before awaiting the per-agent lock,
    // or a queued probe for one agent would block probes for every other.
    let per_agent_lock = {
        let mut locks = PROBE_LOCKS.get_or_init(Default::default).lock().await;
        locks.entry(agent_type).or_default().clone()
    };

    loop {
        if let Some(cached) = cached_probe_entry(agent_type) {
            return cached;
        }

        // Not-installed is NOT negatively cached: the user can install
        // mid-run and the presence check is cheap. It is still fenced by the
        // epoch so a concurrent install retries instead of returning stale
        // absence.
        let readiness_epoch = current_probe_epoch(agent_type);
        if !crate::commands::agent_settings::agent_local_state_for(&entry)
            .await
            .installed
        {
            if is_current_probe_epoch(agent_type, readiness_epoch) {
                return CachedProbeResult {
                    epoch: readiness_epoch,
                    snapshot: None,
                };
            }
            continue;
        }

        let _probe_guard = per_agent_lock.clone().lock_owned().await;
        // Re-check after acquiring: a queued probe finds the winner's result.
        if let Some(cached) = cached_probe_entry(agent_type) {
            return cached;
        }
        let probe_epoch = current_probe_epoch(agent_type);

        let env = match agent_runtime_launch_settings_from_pool(pool, agent_type).await {
            Ok(settings) => settings.env,
            Err(error) => {
                tracing::info!(?agent_type, %error, "skipping capability probe: local runtime unavailable");
                if is_current_probe_epoch(agent_type, probe_epoch) {
                    return CachedProbeResult {
                        epoch: probe_epoch,
                        snapshot: None,
                    };
                }
                continue;
            }
        };
        let scratch = std::env::temp_dir()
            .join("vibex-agent-probe")
            .join(agent_type.as_str());
        let _ = std::fs::create_dir_all(&scratch);

        // Generous cap (reference: 60s) — some agents take ~10s just to answer
        // initialize before session/new can even start.
        let started_at = std::time::Instant::now();
        let discovery = if agent_type == AgentKind::Opencode {
            agents::probe::probe_opencode_session_controls(scratch, env).await
        } else {
            agents::probe::probe_session_controls(
                &entry,
                scratch,
                env,
                std::time::Duration::from_secs(60),
            )
            .await
        };
        let snapshot = match discovery {
            Ok(snapshot) => Some(snapshot),
            Err(error) => {
                tracing::info!(
                    ?agent_type,
                    elapsed_ms = started_at.elapsed().as_millis(),
                    %error,
                    "capability catalog refresh failed"
                );
                None
            }
        };
        if !is_current_probe_epoch(agent_type, probe_epoch) {
            // Drop the lock on this loop iteration; the caller that advanced
            // the epoch will get a fresh probe tied to the updated runtime.
            continue;
        }
        if let Some(snapshot) = snapshot.as_ref() {
            tracing::info!(
                ?agent_type,
                elapsed_ms = started_at.elapsed().as_millis(),
                modes = snapshot.modes.len(),
                config_options = snapshot.config_options.len(),
                "capability catalog refreshed"
            );
        }
        let result = CachedProbeResult {
            epoch: probe_epoch,
            snapshot,
        };
        if cache_probe_result_if_current(agent_type, result.clone()) {
            return result;
        }
        // An invalidation won the race between the final epoch check and
        // cache publication. Start again with the new local runtime.
    }
}

#[tauri::command]
pub async fn agent_config_surfaces() -> Result<Vec<AgentConfigSurface>, AppError> {
    Ok(all_agent_types().into_iter().map(config_surface).collect())
}

#[tauri::command]
pub async fn agent_mcp_surfaces() -> Result<Vec<AgentMcpSurface>, AppError> {
    Ok(all_agent_types().into_iter().map(mcp_surface).collect())
}

#[tauri::command]
pub async fn agent_skills_surfaces() -> Result<Vec<AgentSkillsSurface>, AppError> {
    Ok(all_agent_types().into_iter().map(skills_surface).collect())
}

#[tauri::command]
pub async fn agent_install_plans() -> Result<Vec<AgentInstallPlan>, AppError> {
    Ok(all_agent_types()
        .into_iter()
        .map(registry_entry)
        .map(|entry| AgentInstallPlan::from_registry_entry(&entry))
        .collect())
}

#[tauri::command]
pub async fn agent_runtime_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<RuntimeSnapshot, AppError> {
    // The live runtime is authoritative for pending permissions now that startup
    // recovery (ADR-0001) voids orphaned ones — the old merge from the retired
    // `agent_permissions` shadow table has no reason to exist (批次D).
    Ok(state.agent_runtime.snapshot().await)
}

#[tauri::command]
pub async fn agent_connection_snapshot(
    state: tauri::State<'_, AppState>,
    request: AgentConnectionRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("Connection {connection_id} not found")))
}

#[tauri::command]
pub async fn agent_load_session(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let session_id = parse_agent_session_id(&request.session_id)?;
    state
        .agent_runtime
        .snapshot()
        .await
        .sessions
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| AppError::NotFound(format!("Agent session {session_id} not found")))
}

#[tauri::command]
pub async fn agent_list_session_commands(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<Vec<AgentAvailableCommand>, AppError> {
    let session_id = parse_agent_session_id(&request.session_id)?;
    let snapshot = state.agent_runtime.snapshot().await;

    Ok(snapshot
        .events
        .iter()
        .rev()
        .find_map(|envelope| {
            if envelope.session_id != Some(session_id) {
                return None;
            }
            match &envelope.event {
                agents::AgentEvent::AvailableCommands { commands } => Some(commands.clone()),
                _ => None,
            }
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn agent_set_auto_approve(
    state: tauri::State<'_, AppState>,
    request: AgentSetAutoApproveRequest,
) -> Result<(), AppError> {
    validate_auto_approve_mode(&request.auto_approve_mode)?;
    AgentSetting::update_preferences(
        &state.deployment.db().pool,
        request.agent_type.as_str(),
        None,
        None,
        None,
        Some(&request.auto_approve_mode),
    )
    .await
    .map_err(|error| match error {
        db::models::agent_setting::AgentSettingError::NotFound => {
            AppError::NotFound(format!("Agent setting not found: {}", request.agent_type))
        }
        db::models::agent_setting::AgentSettingError::Database(error) => {
            AppError::Internal(error.to_string())
        }
    })?;
    Ok(())
}

#[tauri::command]
pub async fn agent_connect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let launch_settings = agent_runtime_launch_settings(&state, request.agent_type).await?;
    state
        .agent_runtime
        .connect(ConnectAgentInput {
            agent_type: request.agent_type,
            workspace_id,
            working_dir: PathBuf::from(request.working_dir),
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

async fn agent_runtime_launch_settings(
    state: &tauri::State<'_, AppState>,
    agent_type: AgentKind,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    agent_runtime_launch_settings_from_pool(&state.deployment.db().pool, agent_type).await
}

/// Pool-based variant of [`agent_runtime_launch_settings`] so non-command code
/// (the delegation spawner) can resolve a child agent's auto-approve mode + env
/// without a `tauri::State`.
pub(crate) async fn agent_runtime_launch_settings_from_pool(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    let setting = AgentSetting::find_by_type(pool, agent_type.as_str()).await?;
    let auto_approve_mode = setting
        .as_ref()
        .map(|setting| AgentAutoApproveMode::from_setting(&setting.auto_approve_mode))
        .unwrap_or_default();
    let mut env = parse_agent_env_json(
        setting
            .as_ref()
            .and_then(|setting| setting.env_json.as_deref()),
    )?;
    if let Some(runtime) = agents::local_agent_runtime_spec(agent_type) {
        let cli_verification =
            crate::commands::agent_settings::verify_local_cli_runtime(agent_type).await;
        if !cli_verification.is_supported() {
            let path = cli_verification
                .executable
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| runtime.cli_program.to_string());
            let version = cli_verification
                .version
                .as_deref()
                .unwrap_or("could not be verified");
            let minimum = cli_verification
                .minimum_supported_version
                .as_deref()
                .map(|version| format!(" (minimum supported version: {version})"))
                .unwrap_or_default();
            let detail = cli_verification
                .probe_error
                .as_deref()
                .map(|error| format!(" {error}"))
                .unwrap_or_default();
            return Err(AppError::BadRequest(format!(
                "local Agent runtime at {path} is unavailable or incompatible (detected: {version}){minimum}.{detail} Update it from Settings → Agent before creating a session."
            )));
        }
        let cli_path = cli_verification
            .executable
            .as_ref()
            .expect("supported local CLI verification has an executable path");
        let acp_verification =
            crate::commands::agent_settings::verify_local_acp_runtime(agent_type).await;
        if !acp_verification.is_supported() {
            let component = if runtime.cli_program == runtime.acp_program {
                "local runtime ACP command"
            } else {
                "ACP adapter"
            };
            let path = acp_verification
                .executable
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| runtime.acp_program.to_string());
            let version = acp_verification
                .version
                .as_deref()
                .unwrap_or("could not be verified");
            let minimum = acp_verification
                .minimum_supported_version
                .as_deref()
                .map(|version| format!(" (minimum supported version: {version})"))
                .unwrap_or_default();
            let detail = acp_verification
                .probe_error
                .as_deref()
                .map(|error| format!(" {error}"))
                .unwrap_or_default();
            return Err(AppError::BadRequest(format!(
                "{component} at {path} is unavailable or incompatible (detected: {version}){minimum}.{detail} Update it from Settings → Agent before creating a session."
            )));
        }
        let acp_path = acp_verification
            .executable
            .as_ref()
            .expect("supported local ACP verification has an executable path");
        env.insert(
            agents::ACP_EXECUTABLE_OVERRIDE_ENV.to_string(),
            acp_path.display().to_string(),
        );
        if let Some(key) = runtime.cli_path_env {
            env.insert(key.to_string(), cli_path.display().to_string());
        }
    }
    Ok(conversations::AgentRuntimeLaunchSettings {
        auto_approve_mode,
        env,
    })
}

fn parse_agent_env_json(value: Option<&str>) -> Result<HashMap<String, String>, AppError> {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return Ok(HashMap::new());
    };
    let parsed: Value = serde_json::from_str(value)
        .map_err(|error| AppError::BadRequest(format!("Invalid env JSON: {error}")))?;
    let Some(object) = parsed.as_object() else {
        return Err(AppError::BadRequest(
            "Agent env JSON must be an object".to_string(),
        ));
    };

    let mut env = HashMap::new();
    for (key, value) in object {
        if value.is_null() {
            continue;
        }
        let Some(value) = value
            .as_str()
            .map(str::to_string)
            .or_else(|| value.as_bool().map(|value| value.to_string()))
            .or_else(|| value.as_number().map(|value| value.to_string()))
        else {
            return Err(AppError::BadRequest(format!(
                "Agent env value for {key} must be a string, number, boolean, or null"
            )));
        };
        env.insert(key.clone(), value);
    }
    Ok(env)
}

fn validate_auto_approve_mode(mode: &str) -> Result<(), AppError> {
    match mode {
        "off" | "allow_always" | "yolo" => Ok(()),
        mode => Err(AppError::BadRequest(format!(
            "Unsupported auto approve mode: {mode}"
        ))),
    }
}

#[tauri::command]
pub async fn agent_prepare_session(
    state: tauri::State<'_, AppState>,
    request: AgentPrepareSessionRequest,
) -> Result<AgentPreparedSessionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let session_id = parse_agent_session_id(&request.session_id)?;
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let working_dir = crate::workspace_paths::resolve_workspace_agent_working_dir(
        &workspace,
        &container_ref,
        &repos,
    )
    .unwrap_or_else(|| container_ref.clone());
    let launch_settings = agent_runtime_launch_settings(&state, request.agent_type).await?;

    state
        .agent_runtime
        .prepare_session(agents::EnsureAgentSessionInput {
            agent_type: request.agent_type,
            workspace_id,
            working_dir: PathBuf::from(working_dir),
            session_id,
            acp_session_id: format!("pending-{session_id}"),
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_set_prepared_session_mode(
    state: tauri::State<'_, AppState>,
    request: AgentPreparedSessionModeRequest,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    state
        .agent_runtime
        .set_session_mode(
            parse_agent_session_id(&request.session_id)?,
            request.mode_id,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_set_prepared_session_config(
    state: tauri::State<'_, AppState>,
    request: AgentPreparedSessionConfigRequest,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    state
        .agent_runtime
        .set_session_config_option(
            parse_agent_session_id(&request.session_id)?,
            request.key,
            request.value,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_discard_prepared_session(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .discard_prepared_session(parse_agent_session_id(&request.session_id)?)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_new_session(
    state: tauri::State<'_, AppState>,
    request: AgentNewSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    state
        .agent_runtime
        .new_session(
            connection_id,
            request
                .acp_session_id
                .unwrap_or_else(|| format!("pending-{connection_id}")),
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_resume_session(
    state: tauri::State<'_, AppState>,
    request: AgentResumeSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let launch_settings = agent_runtime_launch_settings(&state, request.agent_type).await?;
    state
        .agent_runtime
        .resume_session(ResumeAgentSessionInput {
            agent_type: request.agent_type,
            workspace_id: parse_uuid("workspace_id", &request.workspace_id)?,
            working_dir: PathBuf::from(request.working_dir),
            session_id: parse_agent_session_id(&request.session_id)?,
            external_session_id: request.external_session_id,
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_send_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentSendPromptRequest,
) -> Result<AgentPromptSnapshot, AppError> {
    state
        .agent_runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            session_id: parse_agent_session_id(&request.session_id)?,
            blocks: text_prompt_blocks(request.text),
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .map_err(Into::into)
}

/// Restore the workspace to the checkpoint recorded before the given user
/// message (its `ordinal`). Destructive when `perform_git_reset` is set; the ACP
/// transcript is append-only and is not truncated. Used by retry/rollback.
#[tauri::command]
pub async fn agent_reset_to_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: String,
    ordinal: i64,
    perform_git_reset: Option<bool>,
    force_when_dirty: Option<bool>,
) -> Result<(), AppError> {
    let session_id = parse_uuid("session_id", &session_id)?;
    state
        .deployment
        .container()
        .reset_agent_session_to_checkpoint(
            session_id,
            ordinal,
            perform_git_reset.unwrap_or(true),
            force_when_dirty.unwrap_or(false),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn agent_cancel_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentCancelPromptRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            session_id: parse_agent_session_id(&request.session_id)?,
            prompt_id: parse_agent_prompt_id(&request.prompt_id)?,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_disconnect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectionRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    state
        .agent_runtime
        .disconnect(parse_agent_connection_id(&request.connection_id)?)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_respond_permission(
    state: tauri::State<'_, AppState>,
    request: AgentRespondPermissionRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .respond_permission(RespondAgentPermissionInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            permission_id: parse_agent_permission_id(&request.permission_id)?,
            response: request.response,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_terminal_snapshot(
    request: AgentTerminalSnapshotRequest,
) -> Result<Option<AgentTerminalOutputSnapshot>, AppError> {
    Ok(agent_terminal_registry()
        .snapshot_output(parse_agent_terminal_id(&request.terminal_id)?)
        .await)
}

#[tauri::command]
pub async fn agent_history_sources(
    request: AgentTypeRequest,
) -> Result<Vec<AgentHistorySource>, AppError> {
    Ok(default_history_sources(request.agent_type))
}

#[tauri::command]
pub async fn agent_history_import(
    state: tauri::State<'_, AppState>,
    request: AgentHistoryImportRequest,
) -> Result<Vec<ImportedAgentSession>, AppError> {
    let workspace_id = request
        .workspace_id
        .as_deref()
        .map(|id| parse_uuid("workspace_id", id))
        .transpose()?;
    let sources = match request.path {
        Some(path) => vec![AgentHistorySource {
            agent_type: request.agent_type,
            path: PathBuf::from(path),
        }],
        None => default_history_sources(request.agent_type)
            .into_iter()
            .filter(|source| source.path.exists())
            .collect(),
    };

    let mut imported = Vec::new();
    for source in sources {
        let sessions = import_history_source(&source).map_err(agent_history_error)?;
        for session in &sessions {
            persist_history_import(&state, session).await?;
            if let Some(workspace_id) = workspace_id {
                crate::commands::conversations::import_agent_session_to_conversation_events(
                    &state.deployment.db().pool,
                    workspace_id,
                    session,
                )
                .await?;
            }
        }
        imported.extend(sessions);
    }
    Ok(imported)
}

#[tauri::command]
pub async fn agent_config_read(
    request: AgentConfigReadRequest,
) -> Result<Option<AgentConfigFileDto>, AppError> {
    let Some(path) = default_config_path(request.agent_type) else {
        return Ok(None);
    };
    let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    Ok(Some(AgentConfigFileDto {
        path: path.display().to_string(),
        content,
    }))
}

#[tauri::command]
pub async fn agent_config_write(request: AgentConfigWriteRequest) -> Result<(), AppError> {
    let path = default_config_path(request.agent_type).ok_or_else(|| {
        AppError::NotFound(format!(
            "No default config file is available for {:?}",
            request.agent_type
        ))
    })?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    tokio::fs::write(path, request.content)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn agent_mcp_list(
    request: AgentTypeRequest,
) -> Result<Option<AgentMcpConfigDto>, AppError> {
    let Some(path) = default_mcp_config_path(request.agent_type) else {
        return Ok(None);
    };
    let Some(surface) = mcp_file_config(request.agent_type) else {
        return Ok(None);
    };
    let config = read_agent_mcp_config(&path, &surface)
        .await
        .map_err(AppError::from)?;
    Ok(Some(AgentMcpConfigDto {
        path: path.display().to_string(),
        config,
        surface,
    }))
}

#[tauri::command]
pub async fn agent_mcp_write(request: AgentMcpWriteRequest) -> Result<(), AppError> {
    let path = default_mcp_config_path(request.agent_type).ok_or_else(|| {
        AppError::NotFound(format!(
            "No default MCP config file is available for {:?}",
            request.agent_type
        ))
    })?;
    let surface = mcp_file_config(request.agent_type).ok_or_else(|| {
        AppError::NotFound(format!(
            "No MCP config adapter is available for {:?}",
            request.agent_type
        ))
    })?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    write_agent_mcp_config(&path, &surface, &request.config)
        .await
        .map_err(AppError::from)
}

/// Probe subscription plan usage for an agent. Runs outside the ACP runtime:
/// Codex via a one-shot `codex app-server` call, Claude Code via the OAuth
/// usage endpoint with locally stored CLI credentials.
#[tauri::command]
pub async fn agent_plan_usage(request: AgentTypeRequest) -> Result<PlanUsageResult, AppError> {
    Ok(agents::plan_usage::probe_plan_usage(request.agent_type).await)
}

fn parse_uuid(label: &str, value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BadRequest(format!("Invalid {label}: {value}")))
}

fn parse_agent_connection_id(value: &str) -> Result<AgentConnectionId, AppError> {
    parse_uuid("connection_id", value).map(AgentConnectionId)
}

fn parse_agent_session_id(value: &str) -> Result<AgentSessionId, AppError> {
    parse_uuid("session_id", value).map(AgentSessionId)
}

fn parse_agent_prompt_id(value: &str) -> Result<AgentPromptId, AppError> {
    parse_uuid("prompt_id", value).map(AgentPromptId)
}

fn parse_agent_permission_id(value: &str) -> Result<AgentPermissionId, AppError> {
    parse_uuid("permission_id", value).map(AgentPermissionId)
}

fn parse_agent_terminal_id(value: &str) -> Result<AgentTerminalId, AppError> {
    parse_uuid("terminal_id", value).map(AgentTerminalId)
}

async fn persist_history_import(
    state: &tauri::State<'_, AppState>,
    session: &ImportedAgentSession,
) -> Result<(), AppError> {
    // The `agent_history_imports` shadow table is retired (批次D); history-import
    // metadata now lives in the canonical `conversation_imports` table. Title /
    // workspace_path / message_count aren't columns there, but the full session is
    // preserved in `raw_json`.
    let raw_json =
        serde_json::to_string(session).map_err(|error| AppError::Internal(error.to_string()))?;
    let source_agent = serde_json::to_value(session.source_agent)
        .map_err(|error| AppError::Internal(error.to_string()))?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let raw_source_path = session
        .raw_source_path
        .as_ref()
        .and_then(|path| path.to_str())
        .map(str::to_string);
    ConversationImportRecord::insert(
        &state.deployment.db().pool,
        InsertConversationImport {
            id: Uuid::new_v4(),
            source: "agent_transcript",
            source_agent: Some(&source_agent),
            external_session_id: Some(&session.external_session_id),
            bundle_version: None,
            raw_source_path: raw_source_path.as_deref(),
            imported_conversation_id: None,
            raw_json: &raw_json,
        },
    )
    .await?;
    Ok(())
}

fn default_config_path(agent_type: AgentKind) -> Option<PathBuf> {
    match agent_type {
        AgentKind::ClaudeCode => claude_config_path(),
        AgentKind::Codex => codex_config_path(),
        AgentKind::Opencode => opencode_config_path(),
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => None,
    }
}

fn agent_history_error(error: agents::AgentHistoryError) -> AppError {
    match error {
        agents::AgentHistoryError::MissingSource(path) => AppError::NotFound(format!(
            "Agent history source not found: {}",
            path.display()
        )),
        agents::AgentHistoryError::Read { path, error }
        | agents::AgentHistoryError::Parse { path, error } => AppError::Internal(format!(
            "Failed to import agent history from {}: {error}",
            path.display()
        )),
    }
}

fn text_prompt_blocks(text: String) -> Vec<AgentContentBlock> {
    if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    }
}

pub(crate) async fn workspace_prompt_blocks(
    working_dir: &str,
    text: String,
    images: &[String],
) -> Result<Vec<AgentContentBlock>, AppError> {
    let mut blocks = text_prompt_blocks(text);
    for image in images {
        blocks.push(read_workspace_image_block(working_dir, image).await?);
    }
    if blocks.is_empty() {
        return Err(AppError::BadRequest(
            "Prompt must include text or an image".to_string(),
        ));
    }
    Ok(blocks)
}

async fn read_workspace_image_block(
    working_dir: &str,
    relative_path: &str,
) -> Result<AgentContentBlock, AppError> {
    let relative = relative_agent_asset_path(relative_path)?;
    let file_path = Path::new(working_dir).join(&relative);
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!(
            "Image not found: {relative_path}"
        )));
    }

    let bytes = tokio::fs::read(&file_path).await.map_err(|err| {
        AppError::Internal(format!("Failed to read image {relative_path}: {err}"))
    })?;

    Ok(AgentContentBlock::Image {
        data: BASE64.encode(bytes),
        mime_type: mime_type_for_agent_asset(&file_path).to_string(),
        uri: Some(relative.to_string_lossy().replace('\\', "/")),
    })
}

fn relative_agent_asset_path(path: &str) -> Result<PathBuf, AppError> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "Image path must be workspace-relative: {path}"
        )));
    }

    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => relative.push(segment),
            Component::CurDir => {}
            _ => {
                return Err(AppError::BadRequest(format!(
                    "Image path must stay inside the workspace: {path}"
                )));
            }
        }
    }

    if relative.as_os_str().is_empty() {
        return Err(AppError::BadRequest(
            "Image path cannot be empty".to_string(),
        ));
    }

    Ok(relative)
}

fn mime_type_for_agent_asset(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_capability_refresh_can_clear_a_cached_probe_failure() {
        let agent_type = AgentKind::QaMock;
        let epoch = current_probe_epoch(agent_type);
        assert!(cache_probe_result_if_current(
            agent_type,
            CachedProbeResult {
                epoch,
                snapshot: None,
            },
        ));

        assert_eq!(cached_probe_result(agent_type), Some(None));
        invalidate_capability_probe(agent_type);
        assert_eq!(cached_probe_result(agent_type), None);
        assert!(!is_current_probe_epoch(agent_type, epoch));
    }

    #[test]
    fn stale_probe_cannot_repopulate_cache_after_runtime_invalidation() {
        let agent_type = AgentKind::Gemini;
        let stale_epoch = current_probe_epoch(agent_type);
        invalidate_capability_probe(agent_type);

        assert!(
            !cache_probe_result_if_current(
                agent_type,
                CachedProbeResult {
                    epoch: stale_epoch,
                    snapshot: None,
                },
            ),
            "a result from the old CLI/ACP epoch must be discarded"
        );
        assert_eq!(cached_probe_result(agent_type), None);
    }

    #[test]
    fn opencode_model_choices_come_only_from_the_persisted_catalog() {
        let snapshot = AgentSessionControlsSnapshot {
            modes: Vec::new(),
            current_mode: None,
            config_options: vec![
                agents::AgentSessionConfigOption {
                    key: "provider".to_string(),
                    label: "Provider".to_string(),
                    description: None,
                    category: None,
                    value: None,
                    choices: vec![agents::AgentSessionConfigChoice {
                        value: serde_json::Value::String("openai".to_string()),
                        label: "OpenAI".to_string(),
                        description: None,
                    }],
                    dependency: None,
                },
                agents::AgentSessionConfigOption {
                    key: "model".to_string(),
                    label: "Model".to_string(),
                    description: None,
                    category: Some("model".to_string()),
                    value: None,
                    choices: vec![
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                            label: "GPT 5.6 Sol".to_string(),
                            description: None,
                        },
                        // Values, not presentation labels, are sent back to
                        // OpenCode. Duplicates and unusable values are not
                        // transformed into invented fallback choices.
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                            label: "A different label".to_string(),
                            description: None,
                        },
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("  ".to_string()),
                            label: "Empty".to_string(),
                            description: None,
                        },
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::Bool(true),
                            label: "Not a model".to_string(),
                            description: None,
                        },
                    ],
                    dependency: None,
                },
            ],
        };

        assert_eq!(
            opencode_models_from_catalog(&snapshot),
            vec!["openai/gpt-5.6-sol".to_string()]
        );
    }

    #[test]
    fn opencode_model_extractor_returns_no_static_fallback_when_catalog_is_empty() {
        let snapshot = AgentSessionControlsSnapshot {
            modes: Vec::new(),
            current_mode: None,
            config_options: Vec::new(),
        };

        assert!(opencode_models_from_catalog(&snapshot).is_empty());
    }

    #[test]
    fn parse_agent_env_json_accepts_scalar_object_values() {
        let env = parse_agent_env_json(Some(
            r#"{
                "STRING_VALUE": "value",
                "NUMBER_VALUE": 42,
                "BOOL_VALUE": true,
                "NULL_VALUE": null
            }"#,
        ))
        .unwrap();

        assert_eq!(env.get("STRING_VALUE").map(String::as_str), Some("value"));
        assert_eq!(env.get("NUMBER_VALUE").map(String::as_str), Some("42"));
        assert_eq!(env.get("BOOL_VALUE").map(String::as_str), Some("true"));
        assert!(!env.contains_key("NULL_VALUE"));
    }

    #[test]
    fn parse_agent_env_json_rejects_non_object_root() {
        let err = parse_agent_env_json(Some(r#"["HTTP_PROXY"]"#)).unwrap_err();

        assert!(
            matches!(err, AppError::BadRequest(message) if message == "Agent env JSON must be an object")
        );
    }

    #[test]
    fn parse_agent_env_json_rejects_nested_values() {
        let err =
            parse_agent_env_json(Some(r#"{"HTTP_PROXY": {"url": "http://proxy"}}"#)).unwrap_err();

        assert!(matches!(err, AppError::BadRequest(message) if message.contains("HTTP_PROXY")));
    }
}
