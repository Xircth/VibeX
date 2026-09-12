//! Throwaway ACP turns used by settings-driven helpers such as prompt
//! enhancement and PR description generation.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use agents::{
    AgentContentBlock, AgentSessionControlsSnapshot, AgentSessionId, EnsureAgentSessionInput,
    SendAgentPromptInput,
    events::{
        AgentEvent, AgentEventEnvelope, AgentSessionConfigOverride, SessionControlPreferences,
    },
    permissions::AgentAutoApproveMode,
    runtime::AgentRuntime,
    state::{AgentPromptStatus, AgentSessionSnapshot},
};
use api_types::AgentId;
use db::models::agent_management::SessionDefaultRepository;
use tokio::sync::broadcast::{self, error::RecvError};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const ONESHOT_WORKSPACE_ID: Uuid = Uuid::nil();

pub struct OneshotAgentTurn {
    pub agent_id: AgentId,
    pub prompt: String,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<AgentSessionConfigOverride>,
    pub timeout: Duration,
    pub failure_prefix: &'static str,
}

pub async fn validated_enabled_agent(
    configured_agent: Option<&str>,
    pool: &sqlx::SqlitePool,
    settings_path: &str,
    purpose: &str,
) -> Result<AgentId, AppError> {
    let Some(raw_agent_id) = configured_agent else {
        return Err(AppError::BadRequest(format!(
            "Choose an Agent in Settings → {settings_path} before using {purpose}."
        )));
    };
    let agent_id = AgentId::parse(raw_agent_id).map_err(|_| {
        AppError::BadRequest(format!(
            "The saved {purpose} Agent `{raw_agent_id}` is not valid. Choose an Agent in Settings → {settings_path}."
        ))
    })?;
    let enabled = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
           FROM agent_membership membership
           JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           WHERE membership.agent_id = ?
             AND membership.enabled = 1
             AND membership.retired = 0
             AND installation.current_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    if enabled == 0 {
        return Err(AppError::BadRequest(format!(
            "The saved {purpose} Agent `{agent_id}` is not enabled. Choose an enabled Agent in Settings → {settings_path}."
        )));
    }
    Ok(agent_id)
}

pub fn oneshot_working_dir(agent_id: &AgentId, session_id: AgentSessionId) -> PathBuf {
    std::env::temp_dir()
        .join("vibex-oneshot-agent")
        .join(agent_id.as_str())
        .join(session_id.to_string())
}

fn ensure_oneshot_workspace(dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dir).map_err(|error| {
        AppError::Internal(format!(
            "failed to create one-shot Agent workspace: {error}"
        ))
    })?;
    if dir.join(".git").exists() {
        return Ok(());
    }
    let _ = Command::new("git").arg("init").current_dir(dir).status();
    Ok(())
}

fn advertised_config_overrides(
    snapshot: &AgentSessionControlsSnapshot,
) -> Vec<AgentSessionConfigOverride> {
    snapshot
        .config_options
        .iter()
        .filter_map(|option| {
            let value = option.value.as_ref().and_then(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| value.as_bool().map(|flag| flag.to_string()))
            })?;
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            Some(AgentSessionConfigOverride {
                key: option.key.clone(),
                value: value.to_string(),
            })
        })
        .collect()
}

fn overlay_config_overrides(
    mut values: BTreeMap<String, String>,
    overrides: impl IntoIterator<Item = AgentSessionConfigOverride>,
) -> BTreeMap<String, String> {
    for item in overrides {
        let key = item.key.trim();
        let value = item.value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        values.insert(key.to_string(), value.to_string());
    }
    values
}

async fn oneshot_session_preferences(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    mode_override: Option<String>,
    explicit: Vec<AgentSessionConfigOverride>,
) -> Result<SessionControlPreferences, AppError> {
    let catalog = conversations::read_matching_open_capability_catalog(pool, agent_id)
        .await
        .map_err(AppError::from)?;
    let mut values = BTreeMap::new();
    if let Some(snapshot) = &catalog {
        values = overlay_config_overrides(values, advertised_config_overrides(snapshot));
    }

    let records = SessionDefaultRepository::new(pool.clone())
        .list_for_agent(agent_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let mut requested = BTreeMap::new();
    let mut stale_ids = Vec::new();
    for record in records {
        match serde_json::from_str(&record.value_json) {
            Ok(value) => {
                requested.insert(record.option_id, value);
            }
            Err(_) => stale_ids.push(record.option_id),
        }
    }
    let defaults = agents::resolve_session_defaults(
        requested,
        stale_ids,
        catalog
            .as_ref()
            .map(|snapshot| snapshot.config_options.as_slice()),
    );
    values = overlay_config_overrides(
        values,
        defaults.valid.into_iter().filter_map(|(key, value)| {
            let value = value.as_str().map(str::to_string).or_else(|| {
                value
                    .as_bool()
                    .map(|flag| flag.to_string())
                    .or_else(|| value.as_i64().map(|number| number.to_string()))
            })?;
            Some(AgentSessionConfigOverride { key, value })
        }),
    );
    values = overlay_config_overrides(values, explicit);

    let mode = mode_override
        .and_then(|mode| {
            let trimmed = mode.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .or_else(|| catalog.and_then(|snapshot| snapshot.current_mode));

    Ok(SessionControlPreferences {
        mode,
        config: values
            .into_iter()
            .map(|(key, value)| AgentSessionConfigOverride { key, value })
            .collect(),
    })
}

pub async fn run_oneshot_agent_turn(
    state: &AppState,
    turn: OneshotAgentTurn,
) -> Result<String, AppError> {
    let pool = &state.deployment.db().pool;
    let launch = crate::commands::agents::agent_runtime_launch_settings_for_session_from_pool(
        pool,
        &turn.agent_id,
    )
    .await?;
    let preferences = oneshot_session_preferences(
        pool,
        &turn.agent_id,
        turn.mode_override.clone(),
        turn.config_overrides.clone(),
    )
    .await?;
    let session_id = AgentSessionId::new();
    let working_dir = oneshot_working_dir(&turn.agent_id, session_id);
    ensure_oneshot_workspace(&working_dir)?;
    let runtime = &state.agent_runtime;
    let events = runtime.subscribe_events();
    let prepared = match crate::commands::agents::settle_session_authentication(
        pool,
        &turn.agent_id,
        runtime
            .prepare_session(EnsureAgentSessionInput {
                agent_id: turn.agent_id.clone(),
                launch_lock: launch.launch_lock,
                workspace_id: ONESHOT_WORKSPACE_ID,
                working_dir: working_dir.clone(),
                additional_directories: Vec::new(),
                session_id,
                acp_session_id: String::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: launch.env,
                preferences,
            })
            .await,
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Err(cleanup_error) = utils::path::remove_dir_all_retrying(&working_dir).await {
                tracing::warn!(
                    path = %working_dir.display(),
                    %cleanup_error,
                    "failed to remove one-shot Agent workspace"
                );
            }
            return Err(error);
        }
    };
    let result = collect_oneshot_response(runtime, events, &prepared.session, &turn).await;
    let _ = runtime.discard_prepared_session(prepared.session.id).await;
    if let Err(error) = utils::path::remove_dir_all_retrying(&working_dir).await {
        tracing::warn!(
            path = %working_dir.display(),
            %error,
            "failed to remove one-shot Agent workspace"
        );
    }
    result
}

async fn collect_oneshot_response(
    runtime: &AgentRuntime,
    events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
    turn: &OneshotAgentTurn,
) -> Result<String, AppError> {
    let prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text {
                text: turn.prompt.clone(),
            }],
            mode_override: turn.mode_override.clone(),
            config_overrides: turn.config_overrides.clone(),
        })
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to run {} Agent: {error}",
                turn.failure_prefix
            ))
        })?;

    if let AgentPromptStatus::Failed { message } = &prompt.status {
        return Err(AppError::Internal(format!(
            "{} Agent failed: {message}",
            turn.failure_prefix
        )));
    }

    match tokio::time::timeout(turn.timeout, collect_response_text(events, session, turn)).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Internal(format!(
            "{} Agent timed out after {} seconds",
            turn.failure_prefix,
            turn.timeout.as_secs()
        ))),
    }
}

async fn collect_response_text(
    mut events: broadcast::Receiver<AgentEventEnvelope>,
    session: &AgentSessionSnapshot,
    turn: &OneshotAgentTurn,
) -> Result<String, AppError> {
    let mut response_text = String::new();

    loop {
        let envelope = match events.recv().await {
            Ok(envelope) => envelope,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(AppError::Internal(format!(
                    "{} failed: Agent event stream closed",
                    turn.failure_prefix
                )));
            }
        };

        if envelope.session_id != Some(session.id) {
            if envelope.connection_id == session.connection_id
                && let AgentEvent::Error { error } = envelope.event
            {
                return Err(AppError::Internal(format!(
                    "{} Agent failed: {}",
                    turn.failure_prefix, error.message
                )));
            }
            continue;
        }

        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => response_text.push_str(&text),
            AgentEvent::PromptFinished { .. } => return Ok(response_text),
            AgentEvent::Error { error } => {
                return Err(AppError::Internal(format!(
                    "{} Agent failed: {}",
                    turn.failure_prefix, error.message
                )));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use agents::AgentSessionConfigOption;

    use super::*;

    fn option(key: &str, category: &str, value: serde_json::Value) -> AgentSessionConfigOption {
        AgentSessionConfigOption {
            key: key.to_string(),
            label: key.to_string(),
            description: None,
            category: Some(category.to_string()),
            value: Some(value),
            choices: Vec::new(),
            dependency: None,
        }
    }

    #[tokio::test]
    async fn oneshot_agent_requires_a_configured_agent() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("memory sqlite");
        let error = validated_enabled_agent(None, &pool, "General", "prompt enhancement")
            .await
            .expect_err("missing agent");
        assert!(matches!(
            error,
            AppError::BadRequest(message) if message.contains("Settings → General")
        ));
    }

    #[test]
    fn oneshot_agent_rejects_an_invalid_agent_id() {
        assert!(api_types::AgentId::parse("NOT VALID").is_err());
    }

    #[test]
    fn oneshot_workspace_is_isolated_per_agent_session() {
        let agent = AgentId::parse("grok").unwrap();
        let session = AgentSessionId::new();
        let dir = oneshot_working_dir(&agent, session);
        assert_ne!(dir, std::env::temp_dir());
        assert!(dir.ends_with(session.to_string()));
        assert!(dir.to_string_lossy().contains("grok"));
    }

    #[test]
    fn advertised_overrides_include_model_and_effort() {
        let snapshot = AgentSessionControlsSnapshot {
            config_options: vec![
                option("model", "model", serde_json::json!("grok-4.6")),
                option("effort", "thought_level", serde_json::json!("high")),
            ],
            ..AgentSessionControlsSnapshot::default()
        };
        let overrides = advertised_config_overrides(&snapshot);
        assert_eq!(
            overrides
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "grok-4.6"), ("effort", "high")]
        );
    }

    #[test]
    fn explicit_oneshot_overrides_win_over_advertised_values() {
        let mut values = overlay_config_overrides(
            BTreeMap::new(),
            vec![AgentSessionConfigOverride {
                key: "effort".into(),
                value: "high".into(),
            }],
        );
        values = overlay_config_overrides(
            values,
            vec![AgentSessionConfigOverride {
                key: "effort".into(),
                value: "low".into(),
            }],
        );
        assert_eq!(values.get("effort").map(String::as_str), Some("low"));
    }
}
