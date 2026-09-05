use std::collections::{HashMap, HashSet};

use api_types::{AgentId, AgentKind, AgentSource};
use sqlx::{FromRow, SqlitePool};

use super::{AgentManagementRepositoryError, source_key};
use crate::models::agent_setting::AgentSetting;

const MIGRATION_KEY: &str = "legacy-agent-settings-v1";
const BAR_ORDER_MIGRATION_KEY: &str = "built-in-bar-order-v2";
/// Previous Agent Bar seed order. Used to detect installs that still have the
/// factory layout so a one-time rewrite can apply the current default.
const PREVIOUS_BUILT_IN_BAR_ORDER: [&str; 14] = [
    "claude_code",
    "codex",
    "antigravity",
    "openclaw",
    "opencode",
    "cline",
    "hermes",
    "codebuddy",
    "kimi_code",
    "pi",
    "grok",
    "cursor",
    "deepseek_harness",
    "qoder",
];

fn built_in_bar_ids() -> impl Iterator<Item = &'static str> {
    AgentKind::built_in_bar_order().map(AgentKind::as_str)
}

#[derive(Debug, FromRow)]
struct LegacyAgentSetting {
    agent_type: String,
    enabled: bool,
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
            ensure_current_built_ins(&mut transaction).await?;
            apply_built_in_bar_order_v2(&mut transaction).await?;
            transaction.commit().await?;
            return Ok(());
        }

        let legacy = sqlx::query_as::<_, LegacyAgentSetting>(
            "SELECT agent_type, enabled FROM agent_setting ORDER BY sort_order ASC, id ASC",
        )
        .fetch_all(&mut *transaction)
        .await?;
        let by_id = legacy
            .iter()
            .map(|row| (canonical_legacy_id(&row.agent_type), row))
            .collect::<HashMap<_, _>>();

        let selected = built_in_bar_ids()
            .map(|built_in| {
                (
                    built_in,
                    AgentSource::BuiltInProfile,
                    true,
                    by_id.get(built_in).is_none_or(|row| row.enabled),
                )
            })
            .collect::<Vec<_>>();
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
        ensure_current_built_ins(&mut transaction).await?;
        apply_built_in_bar_order_v2(&mut transaction).await?;

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

async fn ensure_current_built_ins(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    let mut next_position =
        sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(position) FROM agent_membership")
            .fetch_one(&mut **transaction)
            .await?
            .unwrap_or(-1)
            + 1;
    for agent_id in built_in_bar_ids() {
        let inserted = sqlx::query(
            r#"INSERT INTO agent_membership
               (agent_id, source, built_in, retired, enabled, position)
               VALUES (?, 'built_in_profile', 1, 0, 1, ?)
               ON CONFLICT(agent_id) DO NOTHING"#,
        )
        .bind(agent_id)
        .bind(next_position)
        .execute(&mut **transaction)
        .await?
        .rows_affected();
        if inserted > 0 {
            next_position += 1;
        } else {
            sqlx::query(
                r#"UPDATE agent_membership
                   SET source = 'built_in_profile', built_in = 1, retired = 0,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE agent_id = ?"#,
            )
            .bind(agent_id)
            .execute(&mut **transaction)
            .await?;
        }
        AgentSetting::ensure_row(&mut **transaction, agent_id).await?;
    }
    Ok(())
}

async fn apply_built_in_bar_order_v2(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), sqlx::Error> {
    let complete = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_management_migration_state WHERE migration_key = ?",
    )
    .bind(BAR_ORDER_MIGRATION_KEY)
    .fetch_one(&mut **transaction)
    .await?
        > 0;
    if complete {
        return Ok(());
    }

    let current: Vec<String> = sqlx::query_scalar(
        "SELECT agent_id FROM agent_membership ORDER BY position ASC, agent_id ASC",
    )
    .fetch_all(&mut **transaction)
    .await?;
    let built_in: Vec<&'static str> = built_in_bar_ids().collect();
    let built_in_set: HashSet<&str> = built_in.iter().copied().collect();
    let current_built_ins: Vec<&str> = current
        .iter()
        .map(String::as_str)
        .filter(|agent_id| built_in_set.contains(agent_id))
        .collect();
    let previous_present: Vec<&str> = PREVIOUS_BUILT_IN_BAR_ORDER
        .into_iter()
        .filter(|agent_id| current_built_ins.contains(agent_id))
        .collect();

    if current_built_ins == previous_present {
        let custom: Vec<&str> = current
            .iter()
            .map(String::as_str)
            .filter(|agent_id| !built_in_set.contains(agent_id))
            .collect();
        let next: Vec<&str> = built_in
            .iter()
            .copied()
            .filter(|agent_id| current_built_ins.contains(agent_id))
            .chain(custom)
            .collect();
        for (position, agent_id) in next.into_iter().enumerate() {
            sqlx::query(
                "UPDATE agent_membership SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            )
            .bind(position as i64)
            .bind(agent_id)
            .execute(&mut **transaction)
            .await?;
        }
    }

    sqlx::query(
        r#"INSERT INTO agent_management_migration_state (migration_key, completed_at)
           VALUES (?, datetime('now', 'subsec'))"#,
    )
    .bind(BAR_ORDER_MIGRATION_KEY)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn canonical_legacy_id(value: &str) -> &str {
    match value {
        "open_code" => "opencode",
        "open_claw" => "openclaw",
        other => other,
    }
}
