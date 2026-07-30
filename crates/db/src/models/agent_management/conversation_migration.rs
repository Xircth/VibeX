use api_types::AgentId;
use sqlx::{FromRow, SqlitePool};

use super::AgentManagementRepositoryError;

const MIGRATION_KEY: &str = "conversation-agent-id-v1";

pub struct LegacyConversationAgentMigration;

impl LegacyConversationAgentMigration {
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

        sqlx::query(
            r#"UPDATE sessions
               SET agent_id = CASE LOWER(COALESCE(agent_type, executor))
                   WHEN 'claudecode' THEN 'claude_code'
                   WHEN 'claude-code' THEN 'claude_code'
                   WHEN 'claude_code' THEN 'claude_code'
                   WHEN 'open_code' THEN 'opencode'
                   WHEN 'open_claw' THEN 'openclaw'
                   ELSE LOWER(COALESCE(agent_type, executor))
               END
               WHERE COALESCE(agent_type, executor) IS NOT NULL
                 AND TRIM(COALESCE(agent_type, executor)) <> ''"#,
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE conversation_agent_bindings
               SET agent_id = CASE LOWER(agent_type)
                   WHEN 'claudecode' THEN 'claude_code'
                   WHEN 'claude-code' THEN 'claude_code'
                   WHEN 'claude_code' THEN 'claude_code'
                   WHEN 'open_code' THEN 'opencode'
                   WHEN 'open_claw' THEN 'openclaw'
                   ELSE LOWER(agent_type)
               END
               WHERE agent_id IS NULL OR TRIM(agent_id) = ''"#,
        )
        .execute(&mut *transaction)
        .await?;

        for (agent_id, display_name) in [("openclaw", "OpenClaw"), ("hermes", "Hermes")] {
            sqlx::query(
                r#"INSERT OR IGNORE INTO retired_agent_history
                   (agent_id, display_name, first_seen_at, last_seen_at)
                   SELECT ?, ?, MIN(created_at), MAX(updated_at)
                   FROM sessions
                   WHERE agent_id = ?
                   HAVING COUNT(*) > 0"#,
            )
            .bind(agent_id)
            .bind(display_name)
            .bind(agent_id)
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetiredAgentHistory {
    pub agent_id: AgentId,
    pub display_name: String,
    pub first_seen_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, FromRow)]
struct RetiredAgentHistoryRow {
    agent_id: String,
    display_name: String,
    first_seen_at: Option<String>,
    last_seen_at: Option<String>,
}

#[derive(Clone)]
pub struct RetiredAgentHistoryRepository {
    pool: SqlitePool,
}

impl RetiredAgentHistoryRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> Result<Vec<RetiredAgentHistory>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, RetiredAgentHistoryRow>(
            r#"SELECT agent_id, display_name, first_seen_at, last_seen_at
               FROM retired_agent_history ORDER BY agent_id ASC"#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            let raw_id = row.agent_id;
            Ok(RetiredAgentHistory {
                agent_id: AgentId::parse(&raw_id)
                    .map_err(|_| AgentManagementRepositoryError::InvalidAgentId(raw_id))?,
                display_name: row.display_name,
                first_seen_at: row.first_seen_at,
                last_seen_at: row.last_seen_at,
                read_only: true,
            })
        })
        .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationAgentReference {
    pub conversation_id: uuid::Uuid,
    pub agent_id: AgentId,
    pub external_session_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct ConversationAgentReferenceRow {
    conversation_id: uuid::Uuid,
    agent_id: String,
    external_session_id: Option<String>,
}

#[derive(Clone)]
pub struct ConversationAgentReferenceRepository {
    pool: SqlitePool,
}

impl ConversationAgentReferenceRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(
        &self,
    ) -> Result<Vec<ConversationAgentReference>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, ConversationAgentReferenceRow>(
            r#"SELECT id AS conversation_id, agent_id, external_session_id
               FROM sessions
               WHERE agent_id IS NOT NULL AND TRIM(agent_id) <> ''
               ORDER BY created_at ASC, id ASC"#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| {
            let raw_id = row.agent_id;
            Ok(ConversationAgentReference {
                conversation_id: row.conversation_id,
                agent_id: AgentId::parse(&raw_id)
                    .map_err(|_| AgentManagementRepositoryError::InvalidAgentId(raw_id))?,
                external_session_id: row.external_session_id,
            })
        })
        .collect()
    }
}
