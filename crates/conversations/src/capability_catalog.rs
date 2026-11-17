use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use agents::{
    AgentAuthenticationStatus, AgentId, AgentKind, AgentRuntime, AgentSessionControlsSnapshot,
    AgentSessionId, EnsureAgentSessionInput, SessionAuthenticationEvidence,
    resolve_session_authentication_evidence,
};
use chrono::{Duration, Utc};
use db::models::agent_capability_catalog::AgentCapabilityCatalogRecord;
use services::services::agent_management::AgentManagementApplicationService;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use tokio::sync::watch;
use uuid::Uuid;

use crate::{
    AgentRuntimeLaunchSettings, ConversationServiceError, host::parse_management_authentication,
    resolve_agent_runtime_launch_settings_for_provider_instance,
};

pub const CAPABILITY_CATALOG_TTL: Duration = Duration::minutes(10);

pub async fn open_capability_catalog_fingerprint(
    pool: &SqlitePool,
    launch: &AgentRuntimeLaunchSettings,
) -> Result<String, ConversationServiceError> {
    let launch_lock = &launch.launch_lock;
    let instance_id = db::models::session::normalize_provider_instance_id(
        launch
            .env
            .get("DIMO_PROVIDER_INSTANCE_ID")
            .map(String::as_str),
    );
    let mut digest = Sha256::new();
    // v7 includes normalized provider instance identity and instance-scoped files.
    digest.update(b"open-agent-capability-catalog-v7:");
    digest.update(launch_lock.agent_id.as_str().as_bytes());
    digest.update(b"\0instance:");
    digest.update(instance_id.as_deref().unwrap_or("local").as_bytes());
    digest.update(b"\0");
    digest.update(
        launch_lock
            .absolute_acp_program
            .to_string_lossy()
            .as_bytes(),
    );
    for argument in &launch_lock.args {
        digest.update(b"\0arg:");
        digest.update(argument.as_bytes());
    }
    for (key, value) in &launch_lock.env {
        digest.update(b"\0env:");
        digest.update(key.as_bytes());
        digest.update(b"=");
        digest.update(value.as_bytes());
    }
    digest.update(b"\0runtime:");
    digest.update(launch_lock.runtime_version.as_bytes());
    digest.update(b"\0acp:");
    digest.update(launch_lock.acp_version.as_bytes());
    if let Some(row) = sqlx::query(
        r#"SELECT updated_at, COALESCE(config_json, ''), COALESCE(env_json, '')
           FROM agent_setting WHERE agent_type = ?"#,
    )
    .bind(launch_lock.agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
    {
        digest.update(b"\0setting:");
        digest.update(
            row.try_get::<String, _>(0)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                .as_bytes(),
        );
        digest.update(
            row.try_get::<String, _>(1)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                .as_bytes(),
        );
        digest.update(
            row.try_get::<String, _>(2)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                .as_bytes(),
        );
    }
    for row in sqlx::query(
        r#"SELECT provider_id, revision, fingerprint, updated_at
           FROM agent_config_binding
           WHERE agent_id = ?
           ORDER BY provider_id"#,
    )
    .bind(launch_lock.agent_id.as_str())
    .fetch_all(pool)
    .await
    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
    {
        digest.update(b"\0config:");
        for index in 0..4 {
            digest.update(
                row.try_get::<String, _>(index)
                    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                    .as_bytes(),
            );
            digest.update(b"\0");
        }
    }
    if let Some(ref custom_instance_id) = instance_id {
        let candidates = db::models::provider_instance::candidate_provider_agent_ids(
            launch_lock.agent_id.as_str(),
        );
        for candidate in candidates {
            if let Ok(Some(row)) = sqlx::query(
                r#"SELECT auth_mode, COALESCE(secret_bindings_json, ''), updated_at
                   FROM provider_instances
                   WHERE agent_id = ? AND instance_id = ?"#,
            )
            .bind(&candidate)
            .bind(custom_instance_id)
            .fetch_optional(pool)
            .await
            {
                digest.update(b"\0provider_instance:");
                for index in 0..3 {
                    digest.update(
                        row.try_get::<String, _>(index)
                            .unwrap_or_default()
                            .as_bytes(),
                    );
                    digest.update(b"\0");
                }
                break;
            }
        }
        let instances_root = launch
            .env
            .get("DIMO_PROVIDER_INSTANCES_ROOT")
            .map(String::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        if let Some(instance_dir) = crate::host_isolation::isolated_instance_root(
            &launch_lock.agent_id,
            custom_instance_id,
            instances_root.as_deref(),
        ) {
            for file in ["instance-env.json", "agent-model-providers.json"] {
                digest.update(b"\0instfile:");
                digest.update(file.as_bytes());
                if let Ok(bytes) = std::fs::read(instance_dir.join(file)) {
                    digest.update(&bytes);
                }
            }
        }
    } else if let Some(row) = sqlx::query(
        r#"SELECT authentication, observation_generation,
                  acp_handshake, authentication_required
           FROM agent_probe WHERE agent_id = ?"#,
    )
    .bind(launch_lock.agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
    {
        digest.update(b"\0auth:");
        digest.update(
            row.try_get::<String, _>(0)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                .as_bytes(),
        );
        digest.update(b"\0");
        digest.update(
            row.try_get::<i64, _>(1)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                .to_le_bytes(),
        );
        digest.update(b"\0");
        for index in 2..4 {
            digest.update(
                if row
                    .try_get::<bool, _>(index)
                    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                {
                    b"1"
                } else {
                    b"0"
                },
            );
            digest.update(b"\0");
        }
    }
    hash_native_model_sources(&mut digest, launch);
    Ok(format!("{:x}", digest.finalize()))
}

/// The environment the Agent process actually starts with: it inherits the
/// Host process, then the Agent settings env (after launch policy), then the
/// install lock env. Native config homes must be resolved from this, not from
/// the lock env alone, which normally carries only `PATH`.
fn effective_launch_environment(launch: &AgentRuntimeLaunchSettings) -> BTreeMap<String, String> {
    let mut environment: BTreeMap<String, String> = std::env::vars().collect();
    environment.extend(launch.env.clone());
    environment.extend(launch.launch_lock.env.clone());
    environment
}

fn hash_native_model_sources(digest: &mut Sha256, launch: &AgentRuntimeLaunchSettings) {
    let agent_id = launch.launch_lock.agent_id.as_str();
    digest.update(b"\0native:");
    digest.update(agent_id.as_bytes());
    let environment = effective_launch_environment(launch);
    let Some(home) = environment
        .get("HOME")
        .or_else(|| environment.get("USERPROFILE"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
    else {
        return;
    };
    let Some(source) = native_model_source(agent_id, &environment, &home) else {
        return;
    };
    for file in source.files {
        digest.update(b"\0file:");
        digest.update(file.as_bytes());
        if let Ok(bytes) = std::fs::read(source.dir.join(file)) {
            digest.update(&bytes);
        }
    }
    if agent_id == "omp" {
        for credential in agents::omp_credential_fingerprint(&source.dir) {
            digest.update(b"\0credential:");
            digest.update(credential.as_bytes());
        }
    }
}

/// Native config files that decide which models and providers an Agent
/// advertises. Volatile state stores (auth tokens, usage databases) are left
/// out so the catalog is not invalidated on every turn.
struct NativeModelSource {
    dir: PathBuf,
    files: &'static [&'static str],
}

fn native_model_source(
    agent_id: &str,
    environment: &BTreeMap<String, String>,
    home: &Path,
) -> Option<NativeModelSource> {
    let configured = |keys: &[&str], fallback: &str| {
        keys.iter()
            .find_map(|key| {
                environment
                    .get(*key)
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
            })
            .map(|value| agents::pi_trust::expand_pi_home(value, home))
            .unwrap_or_else(|| home.join(fallback))
    };
    let (dir, files): (PathBuf, &'static [&'static str]) = match agent_id {
        "codex" => (
            configured(&["CODEX_HOME"], ".codex"),
            &[
                "config.toml",
                "dimo-model-catalog.json",
                "dimo-model-catalog.source.json",
            ],
        ),
        "claude_code" => (
            configured(&["CLAUDE_CONFIG_DIR"], ".claude"),
            &["settings.json"],
        ),
        // Pi reads `PI_CODING_AGENT_DIR`; `PI_HOME` is not a variable pi knows.
        // Kept as a fallback only so a lock written before this keeps hashing the
        // directory it always did.
        "pi" => (
            configured(&["PI_CODING_AGENT_DIR", "PI_HOME"], ".pi/agent"),
            &["settings.json", "models.json"],
        ),
        "omp" => (
            agents::omp_agent_dir(home, environment),
            &["models.yml", "config.yml"],
        ),
        "grok" => (configured(&["GROK_HOME"], ".grok"), &["config.toml"]),
        "openclaw" => (
            configured(&["OPENCLAW_HOME"], ".openclaw"),
            &["openclaw.json"],
        ),
        "kimi_code" => (
            configured(&["KIMI_CODE_HOME"], ".kimi-code"),
            &["config.toml"],
        ),
        "hermes" => (configured(&["HERMES_HOME"], ".hermes"), &["config.yaml"]),
        "codebuddy" => (
            configured(&["CODEBUDDY_CONFIG_DIR"], ".codebuddy"),
            &[".env"],
        ),
        "qoder" => (
            configured(&["QODER_CONFIG_DIR"], ".qoder"),
            &["settings.json"],
        ),
        "auggie" => (
            configured(&["AUGMENT_CACHE_DIR"], ".augment"),
            &["settings.json"],
        ),
        "trae" => (configured(&["TRAE_HOME"], ".trae"), &["traecli.toml"]),
        "command_code" => (
            configured(&["COMMAND_CODE_HOME"], ".commandcode"),
            &["providers.json"],
        ),
        "zcode" => (configured(&["ZCODE_HOME"], ".zcode"), &["settings.json"]),
        "opencode" => (
            configured(&["XDG_CONFIG_HOME"], ".config").join("opencode"),
            &["opencode.json", "opencode.jsonc"],
        ),
        id if AgentKind::Antigravity.matches_id(id) => (
            configured(&["GEMINI_HOME"], ".gemini"),
            &["settings.json", "antigravity-acp/settings.json"],
        ),
        _ => return None,
    };
    Some(NativeModelSource { dir, files })
}

pub async fn invalidate_open_capability_catalog(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<(), ConversationServiceError> {
    AgentCapabilityCatalogRecord::delete_for_agent(pool, agent_id.as_str())
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    Ok(())
}

pub async fn invalidate_open_capability_catalog_for_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<(), ConversationServiceError> {
    let launch = match resolve_agent_runtime_launch_settings_for_provider_instance(
        pool,
        agent_id,
        provider_instance_id,
    )
    .await
    {
        Ok(launch) => launch,
        Err(_) => return Ok(()),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch).await?;
    AgentCapabilityCatalogRecord::delete_for_fingerprint(pool, agent_id.as_str(), &fingerprint)
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    Ok(())
}

fn catalog_controls_if_fresh(
    record: AgentCapabilityCatalogRecord,
    now: chrono::DateTime<Utc>,
) -> Option<AgentSessionControlsSnapshot> {
    if record.is_stale_at(now, CAPABILITY_CATALOG_TTL) {
        return None;
    }
    catalog_controls_for_defaults(record)
}

fn catalog_controls_for_defaults(
    record: AgentCapabilityCatalogRecord,
) -> Option<AgentSessionControlsSnapshot> {
    serde_json::from_str(&record.controls_json).ok()
}

async fn read_matching_capability_catalog_record(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<Option<AgentCapabilityCatalogRecord>, ConversationServiceError> {
    let launch = match resolve_agent_runtime_launch_settings_for_provider_instance(
        pool,
        agent_id,
        provider_instance_id,
    )
    .await
    {
        Ok(launch) => launch,
        Err(_) => return Ok(None),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch).await?;
    AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint)
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))
}

pub async fn read_matching_open_capability_catalog(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, ConversationServiceError> {
    read_matching_open_capability_catalog_for_provider_instance(pool, agent_id, None).await
}

pub async fn read_matching_open_capability_catalog_for_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<Option<AgentSessionControlsSnapshot>, ConversationServiceError> {
    let Some(record) =
        read_matching_capability_catalog_record(pool, agent_id, provider_instance_id).await?
    else {
        return Ok(None);
    };
    Ok(catalog_controls_if_fresh(record, Utc::now()))
}

/// Last matching catalog for this Agent fingerprint, including TTL-expired
/// rows. Session-control surfaces (create session, create assistant, session
/// defaults) show this immediately; `capability_catalog_is_fresh` says whether
/// a background probe is due. Saving defaults must not fail only because the
/// probe cache aged out while a live session is still advertising the same
/// options.
pub async fn read_matching_capability_catalog_for_defaults(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, ConversationServiceError> {
    read_matching_capability_catalog_for_defaults_for_provider_instance(pool, agent_id, None).await
}

pub async fn read_matching_capability_catalog_for_defaults_for_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<Option<AgentSessionControlsSnapshot>, ConversationServiceError> {
    let Some(record) =
        read_matching_capability_catalog_record(pool, agent_id, provider_instance_id).await?
    else {
        return Ok(None);
    };
    Ok(catalog_controls_for_defaults(record))
}

pub async fn load_capability_catalog_for_session_defaults(
    pool: &SqlitePool,
    agent_runtime: &AgentRuntime,
    agent_id: &AgentId,
) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
    load_capability_catalog_for_session_defaults_for_provider_instance(
        pool,
        agent_runtime,
        agent_id,
        None,
    )
    .await
}

pub async fn load_capability_catalog_for_session_defaults_for_provider_instance(
    pool: &SqlitePool,
    agent_runtime: &AgentRuntime,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
    if let Some(snapshot) = read_matching_capability_catalog_for_defaults_for_provider_instance(
        pool,
        agent_id,
        provider_instance_id,
    )
    .await?
    {
        return Ok(snapshot);
    }
    refresh_open_capability_catalog_for_provider_instance(
        pool,
        agent_runtime,
        agent_id,
        provider_instance_id,
    )
    .await?;
    read_matching_capability_catalog_for_defaults_for_provider_instance(
        pool,
        agent_id,
        provider_instance_id,
    )
    .await?
    .ok_or_else(|| {
        ConversationServiceError::Conflict(
            "Agent capability catalog is unavailable; refresh it before saving defaults".into(),
        )
    })
}

pub async fn capability_catalog_is_fresh(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<bool, ConversationServiceError> {
    capability_catalog_is_fresh_for_provider_instance(pool, agent_id, None).await
}

pub async fn capability_catalog_is_fresh_for_provider_instance(
    pool: &SqlitePool,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<bool, ConversationServiceError> {
    let launch = match resolve_agent_runtime_launch_settings_for_provider_instance(
        pool,
        agent_id,
        provider_instance_id,
    )
    .await
    {
        Ok(launch) => launch,
        Err(_) => return Ok(false),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch).await?;
    Ok(
        match AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
        {
            Some(record) => !record.is_stale_at(Utc::now(), CAPABILITY_CATALOG_TTL),
            None => false,
        },
    )
}

pub async fn refresh_open_capability_catalog(
    pool: &SqlitePool,
    agent_runtime: &AgentRuntime,
    agent_id: &AgentId,
) -> Result<bool, ConversationServiceError> {
    refresh_open_capability_catalog_for_provider_instance(pool, agent_runtime, agent_id, None).await
}

type CatalogRefreshResult = Result<bool, ConversationServiceError>;
type CatalogRefreshSender = watch::Sender<Option<CatalogRefreshResult>>;
type CatalogRefreshReceiver = watch::Receiver<Option<CatalogRefreshResult>>;

static IN_FLIGHT_CATALOG_REFRESHES: OnceLock<
    Mutex<HashMap<(String, String), CatalogRefreshReceiver>>,
> = OnceLock::new();

fn in_flight_catalog_refreshes() -> &'static Mutex<HashMap<(String, String), CatalogRefreshReceiver>>
{
    IN_FLIGHT_CATALOG_REFRESHES.get_or_init(|| Mutex::new(HashMap::new()))
}

struct CatalogRefreshLeaderGuard {
    key: (String, String),
    sender: Option<CatalogRefreshSender>,
}

impl CatalogRefreshLeaderGuard {
    fn finish(mut self, result: CatalogRefreshResult) -> CatalogRefreshResult {
        {
            let mut map = in_flight_catalog_refreshes()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            map.remove(&self.key);
        }
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(Some(result.clone()));
        }
        result
    }
}

impl Drop for CatalogRefreshLeaderGuard {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            {
                let mut map = in_flight_catalog_refreshes()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                map.remove(&self.key);
            }
            let _ = sender.send(Some(Err(ConversationServiceError::Internal(
                "capability catalog refresh cancelled".to_string(),
            ))));
        }
    }
}

enum CatalogRefreshRegistration {
    Leader(CatalogRefreshLeaderGuard),
    Follower(CatalogRefreshReceiver),
}

fn register_or_join_catalog_refresh(
    agent_id: &AgentId,
    fingerprint: &str,
) -> CatalogRefreshRegistration {
    let key = (agent_id.as_str().to_string(), fingerprint.to_string());
    let mut map = in_flight_catalog_refreshes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(rx) = map.get(&key) {
        return CatalogRefreshRegistration::Follower(rx.clone());
    }
    let (tx, rx) = watch::channel(None);
    map.insert(key.clone(), rx);
    CatalogRefreshRegistration::Leader(CatalogRefreshLeaderGuard {
        key,
        sender: Some(tx),
    })
}

pub async fn refresh_open_capability_catalog_for_provider_instance(
    pool: &SqlitePool,
    agent_runtime: &AgentRuntime,
    agent_id: &AgentId,
    provider_instance_id: Option<&str>,
) -> Result<bool, ConversationServiceError> {
    let launch = resolve_agent_runtime_launch_settings_for_provider_instance(
        pool,
        agent_id,
        provider_instance_id,
    )
    .await?;
    let is_custom_instance = db::models::session::normalize_provider_instance_id(
        launch
            .env
            .get("DIMO_PROVIDER_INSTANCE_ID")
            .map(String::as_str),
    )
    .is_some();
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch).await?;

    let leader_guard = match register_or_join_catalog_refresh(agent_id, &fingerprint) {
        CatalogRefreshRegistration::Leader(guard) => guard,
        CatalogRefreshRegistration::Follower(mut rx) => {
            let result = match rx.wait_for(|value| value.is_some()).await {
                Ok(value) => value.as_ref().expect("wait_for guarantees Some").clone(),
                Err(_) => Err(ConversationServiceError::Internal(
                    "capability catalog refresh channel closed".to_string(),
                )),
            };
            if let Ok(ok) = result {
                if AgentCapabilityCatalogRecord::find_matching(
                    pool,
                    agent_id.as_str(),
                    &fingerprint,
                )
                .await
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
                .is_some()
                {
                    return Ok(ok);
                }
                // Different backing database (e.g. parallel in-memory tests): run locally.
                return refresh_open_capability_catalog_uncached(
                    pool,
                    agent_runtime,
                    agent_id,
                    &launch,
                    is_custom_instance,
                    &fingerprint,
                )
                .await;
            }
            return result;
        }
    };

    let result = refresh_open_capability_catalog_uncached(
        pool,
        agent_runtime,
        agent_id,
        &launch,
        is_custom_instance,
        &fingerprint,
    )
    .await;
    leader_guard.finish(result)
}

async fn refresh_open_capability_catalog_uncached(
    pool: &SqlitePool,
    agent_runtime: &AgentRuntime,
    agent_id: &AgentId,
    launch: &AgentRuntimeLaunchSettings,
    is_custom_instance: bool,
    fingerprint: &str,
) -> Result<bool, ConversationServiceError> {
    let expected_generation =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), fingerprint)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
            .map(|record| record.generation);
    let session_id = AgentSessionId(Uuid::new_v4());
    let working_dir = capability_probe_working_dir(agent_id, session_id);
    std::fs::create_dir_all(&working_dir).map_err(|error| {
        ConversationServiceError::Internal(format!(
            "failed to create capability probe directory: {error}"
        ))
    })?;

    let discovery = settle_session_authentication(
        pool,
        agent_id,
        is_custom_instance,
        agent_runtime
            .prepare_session(EnsureAgentSessionInput {
                agent_id: agent_id.clone(),
                launch_lock: launch.launch_lock.clone(),
                workspace_id: Uuid::new_v4(),
                working_dir: working_dir.clone(),
                additional_directories: Vec::new(),
                session_id,
                acp_session_id: String::new(),
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env.clone(),
                preferences: Default::default(),
            })
            .await,
    )
    .await;
    let persist_result = match discovery {
        Ok(prepared) => {
            persist_capability_catalog(pool, agent_id, launch, &prepared.controls).await
        }
        Err(error) => {
            if let Some(expected_generation) = expected_generation {
                let _ = AgentCapabilityCatalogRecord::record_refresh_error_if_generation(
                    pool,
                    agent_id.as_str(),
                    fingerprint,
                    expected_generation,
                    "probe_failed",
                )
                .await;
            }
            Err(error)
        }
    };
    let discard_result = agent_runtime
        .discard_prepared_session(session_id)
        .await
        .map_err(ConversationServiceError::from);
    let directory_result = utils::path::remove_dir_all_retrying(&working_dir)
        .await
        .map_err(|error| {
            ConversationServiceError::Internal(format!(
                "failed to remove capability probe directory: {error}"
            ))
        });
    capability_probe_result(persist_result, discard_result, directory_result)?;
    Ok(true)
}

/// Persist live session controls as the matching capability catalog so
/// "save as defaults" can validate against what the Agent is advertising
/// after an ACP update, without waiting for a separate probe.
pub async fn record_open_capability_catalog(
    pool: &SqlitePool,
    agent_id: &AgentId,
    launch: &AgentRuntimeLaunchSettings,
    controls: &AgentSessionControlsSnapshot,
) -> Result<(), ConversationServiceError> {
    let fingerprint = open_capability_catalog_fingerprint(pool, launch).await?;
    let controls_json = serde_json::to_string(controls)
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    AgentCapabilityCatalogRecord::replace(pool, agent_id.as_str(), &fingerprint, &controls_json)
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    Ok(())
}

async fn persist_capability_catalog(
    pool: &SqlitePool,
    agent_id: &AgentId,
    launch: &AgentRuntimeLaunchSettings,
    controls: &AgentSessionControlsSnapshot,
) -> Result<(), ConversationServiceError> {
    let persist_fingerprint = open_capability_catalog_fingerprint(pool, launch).await?;
    let persist_expected_generation =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &persist_fingerprint)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
            .map(|record| record.generation);
    let controls_json = serde_json::to_string(controls)
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    AgentCapabilityCatalogRecord::replace_if_generation(
        pool,
        agent_id.as_str(),
        &persist_fingerprint,
        &controls_json,
        persist_expected_generation,
    )
    .await
    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    Ok(())
}

async fn settle_session_authentication<T>(
    pool: &SqlitePool,
    agent_id: &AgentId,
    is_custom_instance: bool,
    result: Result<T, agents::AgentError>,
) -> Result<T, ConversationServiceError> {
    if is_custom_instance {
        return result.map_err(Into::into);
    }
    let (readiness, output) = match result {
        Ok(value) => (SessionAuthenticationEvidence::SessionReady, Ok(value)),
        Err(error @ agents::AgentError::AuthenticationRequired(_)) => (
            SessionAuthenticationEvidence::AuthenticationRequired,
            Err(error),
        ),
        Err(error) => return Err(error.into()),
    };
    let authentication = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
    .map(|value| parse_management_authentication(&value))
    .unwrap_or(AgentAuthenticationStatus::NotLoggedIn);
    let resolved = resolve_session_authentication_evidence(authentication, readiness);
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(
            agent_id,
            resolved.authentication,
            Some(resolved.authentication_required),
        )
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
    output.map_err(Into::into)
}

fn capability_probe_working_dir(agent_id: &AgentId, session_id: AgentSessionId) -> PathBuf {
    // Process TEMP is often ACCESS_DENIED (os error 5) or C:\Windows on this
    // host. `get_dimo_temp_dir` already probes writability and falls back to
    // LocalAppData / home / the exe directory.
    utils::path::get_dimo_temp_dir()
        .join("agent-capability-probe")
        .join(agent_id.as_str())
        .join(session_id.to_string())
}

fn capability_probe_result(
    persist: Result<(), ConversationServiceError>,
    discard: Result<(), ConversationServiceError>,
    directory: Result<(), ConversationServiceError>,
) -> Result<(), ConversationServiceError> {
    if let Err(error) = &directory {
        tracing::warn!("{error}");
    }
    if persist.is_ok() {
        if let Err(error) = &discard {
            tracing::warn!("{error}");
        }
        return Ok(());
    }
    persist
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use agents::SessionLaunchLock;

    use super::*;

    async fn fingerprint_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for statement in [
            r#"CREATE TABLE agent_setting (
                 agent_type TEXT PRIMARY KEY,
                 updated_at TEXT NOT NULL,
                 config_json TEXT,
                 env_json TEXT
               )"#,
            r#"CREATE TABLE agent_config_binding (
                 agent_id TEXT NOT NULL,
                 provider_id TEXT NOT NULL,
                 revision TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 updated_at TEXT NOT NULL
               )"#,
            r#"CREATE TABLE agent_probe (
                 agent_id TEXT PRIMARY KEY,
                 authentication TEXT NOT NULL,
                 probed_at TEXT NOT NULL,
                 observation_generation INTEGER NOT NULL DEFAULT 0,
                 runtime_available INTEGER NOT NULL,
                 acp_handshake INTEGER NOT NULL,
                 authentication_required INTEGER NOT NULL
               )"#,
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    fn launch() -> AgentRuntimeLaunchSettings {
        AgentRuntimeLaunchSettings {
            auto_approve_mode: Default::default(),
            env: HashMap::new(),
            launch_lock: SessionLaunchLock {
                agent_id: AgentId::parse("catalog-agent").unwrap(),
                absolute_acp_program: PathBuf::from("/managed/catalog-agent"),
                args: vec!["acp".to_string()],
                // Production install locks carry only PATH.
                env: BTreeMap::from([("PATH".to_string(), "/usr/bin".to_string())]),
                runtime_version: "1.0.0".to_string(),
                acp_version: "0.8".to_string(),
            },
        }
    }

    /// A launch whose Agent home is a scratch directory, set the way
    /// production sets it: in the Agent settings env, never the lock env.
    fn launch_at_home(agent_id: &str, home: &Path) -> AgentRuntimeLaunchSettings {
        let mut launch = launch();
        launch.launch_lock.agent_id = AgentId::parse(agent_id).unwrap();
        for key in ["HOME", "USERPROFILE"] {
            launch
                .env
                .insert(key.to_string(), home.to_string_lossy().into_owned());
        }
        // Clear ambient home-override env vars so scratch-home tests do not
        // resolve into the host runner's configured directory (e.g. GEMINI_HOME).
        for key in [
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "PI_CODING_AGENT_DIR",
            "PI_HOME",
            "GROK_HOME",
            "OPENCLAW_HOME",
            "XDG_CONFIG_HOME",
            "GEMINI_HOME",
        ] {
            launch.env.insert(key.to_string(), String::new());
        }
        launch
    }

    #[test]
    fn capability_probe_directory_is_writable_under_host_temp() {
        let agent_id = AgentId::parse("grok").unwrap();
        let session_id = AgentSessionId::new();
        let dir = capability_probe_working_dir(&agent_id, session_id);
        let host = utils::path::get_dimo_temp_dir();
        assert_eq!(
            dir,
            host.join("agent-capability-probe")
                .join("grok")
                .join(session_id.to_string())
        );
        std::fs::create_dir_all(&dir).expect("capability probe directory must be writable");
        std::fs::write(dir.join(".write-probe"), b"ok")
            .expect("capability probe directory must accept a write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pi_model_sources_follow_the_directory_pi_actually_reads() {
        let home = Path::new("/home/developer");
        let mut environment = BTreeMap::from([
            (
                "PI_CODING_AGENT_DIR".to_string(),
                "/custom/pi-agent".to_string(),
            ),
            // A stale `PI_HOME` must not win over the variable pi reads.
            ("PI_HOME".to_string(), "/legacy/pi".to_string()),
        ]);
        let dir = |environment: &BTreeMap<String, String>| {
            native_model_source("pi", environment, home).map(|source| source.dir)
        };
        assert_eq!(dir(&environment), Some(PathBuf::from("/custom/pi-agent")));

        // A lock written before Dimo read `PI_CODING_AGENT_DIR` keeps hashing
        // the directory it always did.
        environment.remove("PI_CODING_AGENT_DIR");
        assert_eq!(dir(&environment), Some(PathBuf::from("/legacy/pi")));

        environment.clear();
        assert_eq!(dir(&environment), Some(home.join(".pi/agent")));
    }

    #[tokio::test]
    async fn fingerprint_includes_probe_generation_not_probe_time() {
        let pool = fingerprint_pool().await;
        let launch = launch();
        sqlx::query(
            r#"INSERT INTO agent_probe
        VALUES (?, 'not_required', '2026-07-30T01:00:00Z', 7, 1, 1, 0)"#,
        )
        .bind(launch.launch_lock.agent_id.as_str())
        .execute(&pool)
        .await
        .unwrap();
        let before = open_capability_catalog_fingerprint(&pool, &launch)
            .await
            .unwrap();

        sqlx::query("UPDATE agent_probe SET probed_at = '2026-07-30T02:00:00Z'")
            .execute(&pool)
            .await
            .unwrap();
        let after = open_capability_catalog_fingerprint(&pool, &launch)
            .await
            .unwrap();
        assert_eq!(before, after);

        sqlx::query("UPDATE agent_probe SET observation_generation = 8")
            .execute(&pool)
            .await
            .unwrap();
        let next = open_capability_catalog_fingerprint(&pool, &launch)
            .await
            .unwrap();
        assert_ne!(after, next);
    }

    #[tokio::test]
    async fn fingerprint_includes_agent_settings() {
        let pool = fingerprint_pool().await;
        let launch = launch();
        let without_settings = open_capability_catalog_fingerprint(&pool, &launch)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_setting (agent_type, updated_at, config_json, env_json)
        VALUES (?, '2026-07-30T01:00:00Z', '{"model":"grok"}', '{}')"#,
        )
        .bind(launch.launch_lock.agent_id.as_str())
        .execute(&pool)
        .await
        .unwrap();
        let with_settings = open_capability_catalog_fingerprint(&pool, &launch)
            .await
            .unwrap();
        assert_ne!(without_settings, with_settings);
    }

    /// Editing an Agent's native model config outside Dimo must invalidate
    /// the catalog even though the install lock env carries only `PATH`.
    #[tokio::test]
    async fn fingerprint_tracks_native_model_config_edits_for_every_agent() {
        let pool = fingerprint_pool().await;
        let cases = [
            ("claude_code", ".claude/settings.json"),
            ("codex", ".codex/config.toml"),
            ("pi", ".pi/agent/models.json"),
            ("omp", ".omp/agent/config.yml"),
            ("grok", ".grok/config.toml"),
            ("opencode", ".config/opencode/opencode.json"),
            ("antigravity", ".gemini/antigravity-acp/settings.json"),
        ];
        let mut stale = Vec::new();
        for (agent_id, relative) in cases {
            let home = tempfile::tempdir().unwrap();
            let file = home.path().join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "before").unwrap();
            let launch = launch_at_home(agent_id, home.path());
            let before = open_capability_catalog_fingerprint(&pool, &launch)
                .await
                .unwrap();
            std::fs::write(&file, "after").unwrap();
            let after = open_capability_catalog_fingerprint(&pool, &launch)
                .await
                .unwrap();
            if before == after {
                stale.push(agent_id);
            }
        }
        assert!(
            stale.is_empty(),
            "catalog ignores native config edits for {stale:?}"
        );
    }

    #[tokio::test]
    async fn fingerprint_tracks_omp_logins_but_not_usage_writes() {
        let pool = fingerprint_pool().await;
        let home = tempfile::tempdir().unwrap();
        let agent_dir = home.path().join(".omp").join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let db = rusqlite_free_db(&agent_dir);
        let launch = launch_at_home("omp", home.path());
        let fingerprint = || open_capability_catalog_fingerprint(&pool, &launch);

        let logged_out = fingerprint().await.unwrap();
        db("INSERT INTO auth_credentials VALUES ('google-antigravity', 'oauth', NULL)");
        let logged_in = fingerprint().await.unwrap();
        assert_ne!(logged_out, logged_in);

        db("INSERT INTO model_usage VALUES ('google-antigravity/x', 1)");
        assert_eq!(logged_in, fingerprint().await.unwrap());

        db("UPDATE auth_credentials SET disabled_cause = 'logout'");
        assert_eq!(logged_out, fingerprint().await.unwrap());
    }

    /// OMP's `agent.db` driven through the `sqlite3`-compatible schema subset
    /// the fingerprint reads, without adding a SQLite client to this crate.
    fn rusqlite_free_db(agent_dir: &Path) -> impl Fn(&str) {
        let url = format!("sqlite://{}?mode=rwc", agent_dir.join("agent.db").display());
        let run = move |sql: &str| {
            let url = url.clone();
            let sql = sql.to_string();
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        let pool = SqlitePool::connect(&url).await.unwrap();
                        sqlx::query(&sql).execute(&pool).await.unwrap();
                        pool.close().await;
                    })
            })
            .join()
            .unwrap();
        };
        run(
            "CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, disabled_cause TEXT)",
        );
        run("CREATE TABLE model_usage (model_key TEXT, last_used_at INTEGER)");
        run
    }

    #[test]
    fn stale_catalog_controls_are_not_read() {
        let now = Utc::now();
        let record = AgentCapabilityCatalogRecord {
            agent_type: "catalog-agent".to_string(),
            fingerprint: "fingerprint".to_string(),
            generation: 1,
            controls_json: serde_json::to_string(&AgentSessionControlsSnapshot::default()).unwrap(),
            retrieved_at: (now - Duration::minutes(11)).to_rfc3339(),
            refresh_error_code: None,
        };
        assert!(catalog_controls_if_fresh(record, now).is_none());
    }

    #[test]
    fn matching_catalog_still_validates_defaults_after_ttl() {
        let now = Utc::now();
        let record = AgentCapabilityCatalogRecord {
            agent_type: "antigravity".to_string(),
            fingerprint: "fingerprint".to_string(),
            generation: 2,
            controls_json: serde_json::to_string(&AgentSessionControlsSnapshot::default()).unwrap(),
            retrieved_at: (now - Duration::minutes(11)).to_rfc3339(),
            refresh_error_code: None,
        };
        assert!(catalog_controls_if_fresh(record.clone(), now).is_none());
        assert!(catalog_controls_for_defaults(record).is_some());
    }

    #[test]
    fn session_control_ui_reads_last_matching_catalog_after_ttl() {
        let now = Utc::now();
        let snapshot = AgentSessionControlsSnapshot {
            modes: vec![agents::AgentSessionMode {
                id: "agent".to_string(),
                label: "Agent".to_string(),
                description: None,
            }],
            current_mode: Some("agent".to_string()),
            ..Default::default()
        };
        let record = AgentCapabilityCatalogRecord {
            agent_type: "codex".to_string(),
            fingerprint: "fingerprint".to_string(),
            generation: 3,
            controls_json: serde_json::to_string(&snapshot).unwrap(),
            retrieved_at: (now - Duration::minutes(11)).to_rfc3339(),
            refresh_error_code: None,
        };
        assert!(catalog_controls_if_fresh(record.clone(), now).is_none());
        let kept = catalog_controls_for_defaults(record).expect("last matching catalog");
        assert_eq!(kept.current_mode.as_deref(), Some("agent"));
        assert_eq!(kept.modes[0].id, "agent");
    }

    #[tokio::test]
    async fn fingerprint_separates_local_and_custom_provider_instances_and_tracks_instance_files() {
        let pool = fingerprint_pool().await;
        sqlx::query(
            r#"CREATE TABLE provider_instances (
                agent_id TEXT NOT NULL,
                instance_id TEXT NOT NULL,
                auth_mode TEXT NOT NULL DEFAULT 'subscription',
                secret_bindings_json TEXT,
                updated_at TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut local_launch = launch_at_home("codex", home.path());
        local_launch.env.insert(
            "DIMO_PROVIDER_INSTANCES_ROOT".to_string(),
            root.path().to_string_lossy().into_owned(),
        );
        local_launch
            .env
            .insert("DIMO_PROVIDER_INSTANCE_ID".to_string(), "local".to_string());

        let mut custom_launch = local_launch.clone();
        custom_launch.env.insert(
            "DIMO_PROVIDER_INSTANCE_ID".to_string(),
            "work-profile".to_string(),
        );

        let local_fp = open_capability_catalog_fingerprint(&pool, &local_launch)
            .await
            .unwrap();
        let custom_fp_1 = open_capability_catalog_fingerprint(&pool, &custom_launch)
            .await
            .unwrap();
        assert_ne!(local_fp, custom_fp_1);

        let instance_dir = crate::host_isolation::isolated_instance_root(
            &AgentId::parse("codex").unwrap(),
            "work-profile",
            Some(root.path()),
        )
        .unwrap();
        std::fs::create_dir_all(&instance_dir).unwrap();
        std::fs::write(
            instance_dir.join("instance-env.json"),
            r#"{"OPENAI_BASE_URL":"https://api.example.com/v1"}"#,
        )
        .unwrap();
        let custom_fp_2 = open_capability_catalog_fingerprint(&pool, &custom_launch)
            .await
            .unwrap();
        assert_ne!(custom_fp_1, custom_fp_2);

        std::fs::write(
            instance_dir.join("agent-model-providers.json"),
            r#"{"providers":[{"id":"p1"}]}"#,
        )
        .unwrap();
        let custom_fp_3 = open_capability_catalog_fingerprint(&pool, &custom_launch)
            .await
            .unwrap();
        assert_ne!(custom_fp_2, custom_fp_3);

        // Changing local agent_probe only affects local, not custom instance fingerprint.
        sqlx::query(
            r#"INSERT INTO agent_probe
               VALUES ('codex', 'logged_in', '2026-11-16T00:00:00Z', 1, 1, 1, 0)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let local_fp_after_probe = open_capability_catalog_fingerprint(&pool, &local_launch)
            .await
            .unwrap();
        let custom_fp_after_probe = open_capability_catalog_fingerprint(&pool, &custom_launch)
            .await
            .unwrap();
        assert_ne!(local_fp, local_fp_after_probe);
        assert_eq!(custom_fp_3, custom_fp_after_probe);
    }

    #[tokio::test]
    async fn singleflight_refresh_coalesces_concurrent_callers_and_recovers_on_drop() {
        let agent_id = AgentId::parse("codex").unwrap();
        let fingerprint = format!("singleflight-test-{}", Uuid::new_v4());

        let leader = match register_or_join_catalog_refresh(&agent_id, &fingerprint) {
            CatalogRefreshRegistration::Leader(guard) => guard,
            CatalogRefreshRegistration::Follower(_) => {
                panic!("first caller should be leader")
            }
        };
        let mut follower = match register_or_join_catalog_refresh(&agent_id, &fingerprint) {
            CatalogRefreshRegistration::Follower(rx) => rx,
            CatalogRefreshRegistration::Leader(_) => {
                panic!("second concurrent caller should join as follower")
            }
        };

        let waiter = tokio::spawn(async move {
            follower
                .wait_for(|value| value.is_some())
                .await
                .unwrap()
                .as_ref()
                .unwrap()
                .clone()
        });

        let finish_result = leader.finish(Ok(true));
        assert!(finish_result.unwrap());
        assert!(waiter.await.unwrap().unwrap());

        // Dropping an unfinished leader notifies followers with an error and cleans up the slot
        // so subsequent refreshes can acquire leadership again.
        let dropped_leader = match register_or_join_catalog_refresh(&agent_id, &fingerprint) {
            CatalogRefreshRegistration::Leader(guard) => guard,
            CatalogRefreshRegistration::Follower(_) => {
                panic!("slot should be free after previous leader finished")
            }
        };
        let mut dropped_follower = match register_or_join_catalog_refresh(&agent_id, &fingerprint) {
            CatalogRefreshRegistration::Follower(rx) => rx,
            CatalogRefreshRegistration::Leader(_) => {
                panic!("concurrent caller should join dropped leader")
            }
        };
        drop(dropped_leader);

        let cancel_err = dropped_follower
            .wait_for(|value| value.is_some())
            .await
            .unwrap()
            .as_ref()
            .unwrap()
            .clone()
            .unwrap_err();
        assert!(cancel_err.to_string().contains("cancelled"));

        match register_or_join_catalog_refresh(&agent_id, &fingerprint) {
            CatalogRefreshRegistration::Leader(guard) => {
                let _ = guard.finish(Ok(true));
            }
            CatalogRefreshRegistration::Follower(_) => {
                panic!("slot should be cleaned up on drop")
            }
        }
    }

    #[tokio::test]
    async fn invalidate_for_provider_instance_only_removes_target_instance_catalog() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();

        let agent_id = AgentId::parse("codex").unwrap();
        let now = "2026-11-16T00:00:00Z";
        let instances_root = tempfile::tempdir().unwrap();
        let exe_path = std::env::current_exe().unwrap();
        let lock_payload = serde_json::json!({
            "absolute_acp_program": exe_path,
            "args": ["acp"],
            "env": {},
            "runtime_version": "1.0.0",
            "acp_version": "0.8"
        })
        .to_string();
        let setting_env = serde_json::json!({
            "DIMO_PROVIDER_INSTANCES_ROOT": instances_root.path().to_string_lossy()
        })
        .to_string();

        sqlx::query(
            r#"INSERT OR IGNORE INTO agent_membership (
                   agent_id, source, built_in, retired, enabled, position, created_at, updated_at
               ) VALUES ('codex', 'built_in_profile', 1, 0, 1, 0, ?, ?)"#,
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT INTO agent_install_lock (
                   id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at
               ) VALUES ('lock-codex', 'codex', '1.0.0', 'test', 'binary', ?, ?)"#,
        )
        .bind(&lock_payload)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT OR REPLACE INTO agent_installation (
                   agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id, active_operation, updated_at
               ) VALUES ('codex', 'external', 'ready', 'lock-codex', NULL, NULL, ?)"#,
        )
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT OR REPLACE INTO agent_probe (
                   agent_id, lifecycle, authentication, detail_json, probed_at
               ) VALUES ('codex', 'ready', 'logged_in', '{}', ?)"#,
        )
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT OR REPLACE INTO agent_setting (
                   agent_type, updated_at, config_json, env_json
               ) VALUES ('codex', ?, '{}', ?)"#,
        )
        .bind(now)
        .bind(&setting_env)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT INTO provider_instances (
                   agent_id, instance_id, display_name, auth_mode, is_default, created_at, updated_at
               ) VALUES
                   ('codex', 'work-a', 'Work A', 'api_key', 0, ?, ?),
                   ('codex', 'work-b', 'Work B', 'api_key', 0, ?, ?)"#,
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

        let snapshot = AgentSessionControlsSnapshot::default();
        let launch_local =
            resolve_agent_runtime_launch_settings_for_provider_instance(&pool, &agent_id, None)
                .await
                .unwrap();
        let launch_a = resolve_agent_runtime_launch_settings_for_provider_instance(
            &pool,
            &agent_id,
            Some("work-a"),
        )
        .await
        .unwrap();
        let launch_b = resolve_agent_runtime_launch_settings_for_provider_instance(
            &pool,
            &agent_id,
            Some("work-b"),
        )
        .await
        .unwrap();

        record_open_capability_catalog(&pool, &agent_id, &launch_local, &snapshot)
            .await
            .unwrap();
        record_open_capability_catalog(&pool, &agent_id, &launch_a, &snapshot)
            .await
            .unwrap();
        record_open_capability_catalog(&pool, &agent_id, &launch_b, &snapshot)
            .await
            .unwrap();

        invalidate_open_capability_catalog_for_provider_instance(&pool, &agent_id, Some("work-a"))
            .await
            .unwrap();

        let fp_local = open_capability_catalog_fingerprint(&pool, &launch_local)
            .await
            .unwrap();
        let fp_a = open_capability_catalog_fingerprint(&pool, &launch_a)
            .await
            .unwrap();
        let fp_b = open_capability_catalog_fingerprint(&pool, &launch_b)
            .await
            .unwrap();

        assert!(
            AgentCapabilityCatalogRecord::find_matching(&pool, agent_id.as_str(), &fp_a)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            AgentCapabilityCatalogRecord::find_matching(&pool, agent_id.as_str(), &fp_local)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            AgentCapabilityCatalogRecord::find_matching(&pool, agent_id.as_str(), &fp_b)
                .await
                .unwrap()
                .is_some()
        );
    }
}
