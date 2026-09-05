use agents::{
    AgentAuthenticationStatus, AgentId, AgentRuntime, AgentSessionControlsSnapshot, AgentSessionId,
    EnsureAgentSessionInput, SessionAuthenticationEvidence, SessionLaunchLock,
    resolve_session_authentication_evidence,
};
use chrono::{Duration, Utc};
use db::models::agent_capability_catalog::AgentCapabilityCatalogRecord;
use services::services::agent_management::AgentManagementApplicationService;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{
    ConversationServiceError, host::parse_management_authentication,
    resolve_agent_runtime_launch_settings,
};

pub const CAPABILITY_CATALOG_TTL: Duration = Duration::minutes(10);

pub async fn open_capability_catalog_fingerprint(
    pool: &SqlitePool,
    launch_lock: &SessionLaunchLock,
) -> Result<String, ConversationServiceError> {
    let mut digest = Sha256::new();
    // v3 invalidates catalogs captured before effort/permission were merged
    // from Grok's vendor `_meta` into the standard session-control snapshot.
    digest.update(b"open-agent-capability-catalog-v3:");
    digest.update(launch_lock.agent_id.as_str().as_bytes());
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
    if let Some(row) = sqlx::query(
        r#"SELECT authentication, observation_generation,
                  runtime_available, acp_handshake, authentication_required
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
        for index in 2..5 {
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
    Ok(format!("{:x}", digest.finalize()))
}

fn catalog_controls_if_fresh(
    record: AgentCapabilityCatalogRecord,
    now: chrono::DateTime<Utc>,
) -> Option<AgentSessionControlsSnapshot> {
    if record.is_stale_at(now, CAPABILITY_CATALOG_TTL) {
        return None;
    }
    serde_json::from_str(&record.controls_json).ok()
}

pub async fn read_matching_open_capability_catalog(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, ConversationServiceError> {
    let launch = match resolve_agent_runtime_launch_settings(pool, agent_id).await {
        Ok(launch) => launch,
        Err(_) => return Ok(None),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch.launch_lock).await?;
    let Some(record) =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
    else {
        return Ok(None);
    };
    Ok(catalog_controls_if_fresh(record, Utc::now()))
}

pub async fn capability_catalog_is_fresh(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<bool, ConversationServiceError> {
    let launch = match resolve_agent_runtime_launch_settings(pool, agent_id).await {
        Ok(launch) => launch,
        Err(_) => return Ok(false),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch.launch_lock).await?;
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
    let launch = resolve_agent_runtime_launch_settings(pool, agent_id).await?;
    let launch_lock = launch.launch_lock;
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch_lock).await?;
    let expected_generation =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?
            .map(|record| record.generation);
    let session_id = AgentSessionId(Uuid::new_v4());
    let working_dir = std::env::temp_dir()
        .join("vibex-agent-capability-probe")
        .join(agent_id.as_str())
        .join(session_id.to_string());
    std::fs::create_dir_all(&working_dir).map_err(|error| {
        ConversationServiceError::Internal(format!(
            "failed to create capability probe directory: {error}"
        ))
    })?;

    let discovery = settle_session_authentication(
        pool,
        agent_id,
        agent_runtime
            .prepare_session(EnsureAgentSessionInput {
                agent_id: agent_id.clone(),
                launch_lock: launch_lock.clone(),
                workspace_id: Uuid::new_v4(),
                working_dir: working_dir.clone(),
                additional_directories: Vec::new(),
                session_id,
                acp_session_id: format!("vibex-capability-probe-{}", session_id),
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env,
                preferences: Default::default(),
            })
            .await,
    )
    .await;
    let persist_result = match discovery {
        Ok(prepared) => {
            persist_capability_catalog(pool, agent_id, &launch_lock, &prepared.controls).await
        }
        Err(error) => {
            if let Some(expected_generation) = expected_generation {
                let _ = AgentCapabilityCatalogRecord::record_refresh_error_if_generation(
                    pool,
                    agent_id.as_str(),
                    &fingerprint,
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

async fn persist_capability_catalog(
    pool: &SqlitePool,
    agent_id: &AgentId,
    launch_lock: &SessionLaunchLock,
    controls: &AgentSessionControlsSnapshot,
) -> Result<(), ConversationServiceError> {
    let persist_fingerprint = open_capability_catalog_fingerprint(pool, launch_lock).await?;
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
    result: Result<T, agents::AgentError>,
) -> Result<T, ConversationServiceError> {
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
    use std::{collections::BTreeMap, path::PathBuf};

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

    fn launch_lock() -> SessionLaunchLock {
        SessionLaunchLock {
            agent_id: AgentId::parse("catalog-agent").unwrap(),
            absolute_acp_program: PathBuf::from("/managed/catalog-agent"),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
            runtime_version: "1.0.0".to_string(),
            acp_version: "0.8".to_string(),
        }
    }

    #[tokio::test]
    async fn fingerprint_includes_probe_generation_not_probe_time() {
        let pool = fingerprint_pool().await;
        let lock = launch_lock();
        sqlx::query(
            r#"INSERT INTO agent_probe
               VALUES (?, 'not_required', '2026-07-30T01:00:00Z', 7, 1, 1, 0)"#,
        )
        .bind(lock.agent_id.as_str())
        .execute(&pool)
        .await
        .unwrap();
        let before = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();

        sqlx::query("UPDATE agent_probe SET probed_at = '2026-07-30T02:00:00Z'")
            .execute(&pool)
            .await
            .unwrap();
        let after = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();
        assert_eq!(before, after);

        sqlx::query("UPDATE agent_probe SET observation_generation = 8")
            .execute(&pool)
            .await
            .unwrap();
        let next = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();
        assert_ne!(after, next);
    }

    #[tokio::test]
    async fn fingerprint_includes_agent_settings() {
        let pool = fingerprint_pool().await;
        let lock = launch_lock();
        let without_settings = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_setting (agent_type, updated_at, config_json, env_json)
               VALUES (?, '2026-07-30T01:00:00Z', '{"model":"grok"}', '{}')"#,
        )
        .bind(lock.agent_id.as_str())
        .execute(&pool)
        .await
        .unwrap();
        let with_settings = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();
        assert_ne!(without_settings, with_settings);
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
    fn capability_probe_cleanup_failure_does_not_hide_a_persisted_catalog() {
        assert!(
            capability_probe_result(
                Ok(()),
                Ok(()),
                Err(ConversationServiceError::Internal(
                    "failed to remove capability probe directory: os error 32".to_string()
                )),
            )
            .is_ok()
        );
        assert!(
            capability_probe_result(
                Ok(()),
                Err(ConversationServiceError::Internal(
                    "session discard failed".to_string()
                )),
                Err(ConversationServiceError::Internal(
                    "failed to remove capability probe directory: os error 32".to_string()
                )),
            )
            .is_ok()
        );
    }

    #[test]
    fn capability_probe_still_returns_persist_errors() {
        let error = capability_probe_result(
            Err(ConversationServiceError::Internal(
                "ACP session preparation failed".to_string(),
            )),
            Ok(()),
            Err(ConversationServiceError::Internal(
                "failed to remove capability probe directory: os error 32".to_string(),
            )),
        );
        assert!(matches!(
            error,
            Err(ConversationServiceError::Internal(message))
                if message.contains("ACP session preparation failed")
        ));
    }
}
