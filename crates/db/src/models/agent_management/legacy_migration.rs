use std::collections::HashMap;

use api_types::{AgentId, AgentSource};
use sqlx::{FromRow, SqlitePool};

use super::{AgentManagementRepositoryError, source_key};

const MIGRATION_KEY: &str = "legacy-agent-settings-v1";
const BUILT_INS: [&str; 3] = ["claude_code", "codex", "opencode"];
const GENERIC_CANDIDATES: [&str; 2] = ["gemini", "cline"];

#[derive(Debug, FromRow)]
struct LegacyAgentSetting {
    agent_type: String,
    enabled: bool,
    installed_version: Option<String>,
    env_json: Option<String>,
    config_json: Option<String>,
    auto_approve_mode: String,
    runtime_cli_path: Option<String>,
    runtime_cli_version: Option<String>,
    runtime_cli_revision: Option<String>,
    runtime_acp_path: Option<String>,
    runtime_acp_version: Option<String>,
    runtime_acp_revision: Option<String>,
}

impl LegacyAgentSetting {
    fn has_persisted_evidence(&self) -> bool {
        non_empty(&self.installed_version)
            || meaningful_json(&self.env_json)
            || meaningful_json(&self.config_json)
            || self.auto_approve_mode != "off"
            || [
                &self.runtime_cli_path,
                &self.runtime_cli_version,
                &self.runtime_cli_revision,
                &self.runtime_acp_path,
                &self.runtime_acp_version,
                &self.runtime_acp_revision,
            ]
            .into_iter()
            .any(non_empty)
    }
}

fn non_empty(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

fn meaningful_json(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !matches!(value.trim(), "" | "{}" | "[]" | "null"))
}

pub struct LegacyAgentMigration;

impl LegacyAgentMigration {
    pub async fn run(pool: &SqlitePool) -> Result<(), AgentManagementRepositoryError> {
        let mut transaction = pool.begin().await?;
        let complete = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM agent_management_migration_state WHERE migration_key = ?",
        )
        .bind(MIGRATION_KEY)
        .fetch_one(&mut *transaction)
        .await?
            > 0;
        if complete {
            transaction.commit().await?;
            return Ok(());
        }

        let legacy = sqlx::query_as::<_, LegacyAgentSetting>(
            r#"SELECT agent_type, enabled, installed_version,
                      env_json, config_json, auto_approve_mode,
                      runtime_cli_path, runtime_cli_version, runtime_cli_revision,
                      runtime_acp_path, runtime_acp_version, runtime_acp_revision
               FROM agent_setting ORDER BY sort_order ASC, id ASC"#,
        )
        .fetch_all(&mut *transaction)
        .await?;
        let by_id = legacy
            .iter()
            .map(|row| (row.agent_type.as_str(), row))
            .collect::<HashMap<_, _>>();

        let mut selected = Vec::<(&str, AgentSource, bool, bool)>::new();
        for row in &legacy {
            let canonical = canonical_legacy_id(&row.agent_type);
            if BUILT_INS.contains(&canonical) {
                selected.push((canonical, AgentSource::BuiltInProfile, true, row.enabled));
            } else if GENERIC_CANDIDATES.contains(&canonical)
                && (row.has_persisted_evidence()
                    || has_history_evidence(&mut transaction, canonical).await?)
            {
                selected.push((canonical, AgentSource::OfficialRegistry, false, row.enabled));
            }
        }

        for built_in in BUILT_INS {
            if !selected.iter().any(|(id, _, _, _)| *id == built_in) {
                selected.push((
                    built_in,
                    AgentSource::BuiltInProfile,
                    true,
                    by_id.get(built_in).is_none_or(|row| row.enabled),
                ));
            }
        }
        selected.push(("pi", AgentSource::BuiltInProfile, true, true));

        for (position, (raw_id, source, built_in, enabled)) in selected.into_iter().enumerate() {
            let agent_id = AgentId::parse(raw_id)
                .map_err(|_| AgentManagementRepositoryError::InvalidAgentId(raw_id.to_string()))?;
            sqlx::query(
                r#"INSERT INTO agent_membership
                   (agent_id, source, built_in, retired, enabled, position)
                   VALUES (?, ?, ?, 0, ?, ?)
                   ON CONFLICT(agent_id) DO NOTHING"#,
            )
            .bind(agent_id.as_str())
            .bind(source_key(source))
            .bind(built_in)
            .bind(enabled)
            .bind(position as i64)
            .execute(&mut *transaction)
            .await?;
        }

        sqlx::query(
            r#"INSERT INTO agent_management_migration_state (migration_key, completed_at)
               VALUES (?, datetime('now', 'subsec'))"#,
        )
        .bind(MIGRATION_KEY)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }
}

fn canonical_legacy_id(value: &str) -> &str {
    match value {
        "open_code" => "opencode",
        "open_claw" => "openclaw",
        other => other,
    }
}

async fn has_history_evidence(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    agent_id: &str,
) -> Result<bool, sqlx::Error> {
    let sessions = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE agent_type = ? OR executor = ?)",
    )
    .bind(agent_id)
    .bind(agent_id)
    .fetch_one(&mut **transaction)
    .await?;
    if sessions != 0 {
        return Ok(true);
    }
    let bindings = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM conversation_agent_bindings WHERE agent_type = ?)",
    )
    .bind(agent_id)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(bindings != 0)
}
