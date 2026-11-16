use api_types::AgentId;
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::conversation::{
    BINDING_COLUMNS, BindingStatus, ConversationAgentBindingRecord, CreateConversationAgentBinding,
};

impl ConversationAgentBindingRecord {
    pub async fn active_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        Self::active_on_connection(&mut *pool.acquire().await?, conversation_id).await
    }

    pub(super) async fn active_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {BINDING_COLUMNS} FROM conversation_agent_bindings WHERE id =
             (SELECT active_agent_binding_id FROM sessions WHERE id = ?)"
        ))
        .bind(conversation_id)
        .fetch_optional(conn)
        .await
    }

    pub async fn activate(
        pool: &SqlitePool,
        conversation_id: Uuid,
        binding_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        Self::activate_on_connection(&mut *pool.acquire().await?, conversation_id, binding_id).await
    }

    /// Find the resume head for a given continuation key.
    pub async fn resume_head_for_key(
        pool: &SqlitePool,
        conversation_id: Uuid,
        continuation_key: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(&format!(
            "SELECT {BINDING_COLUMNS} FROM conversation_agent_bindings \
             WHERE conversation_id = ? AND continuation_key = ? \
             AND is_resume_head = 1 AND resume_allowed = 1 LIMIT 1"
        ))
        .bind(conversation_id)
        .bind(continuation_key)
        .fetch_optional(pool)
        .await
    }

    pub(super) async fn activate_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        binding_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let result = sqlx::query(
            "UPDATE sessions SET active_agent_binding_id = ?1,
                 binding_revision = binding_revision + CASE WHEN active_agent_binding_id IS ?1 THEN 0 ELSE 1 END,
                 model = CASE
                     WHEN agent_id IS NOT NULL AND agent_id != (SELECT agent_id FROM conversation_agent_bindings WHERE id = ?1)
                     THEN NULL
                     ELSE model
                 END,
                 agent_id = (SELECT agent_id FROM conversation_agent_bindings WHERE id = ?1),
                 agent_type = (SELECT agent_id FROM conversation_agent_bindings WHERE id = ?1),
                 executor = (SELECT agent_id FROM conversation_agent_bindings WHERE id = ?1),
                 external_session_id = (SELECT acp_session_id FROM conversation_agent_bindings WHERE id = ?1),
                 updated_at = datetime('now', 'subsec')
             WHERE id = ?2 AND EXISTS (SELECT 1 FROM conversation_agent_bindings
                 WHERE id = ?1 AND conversation_id = ?2 AND resume_allowed = 1)",
        )
        .bind(binding_id)
        .bind(conversation_id)
        .execute(&mut *conn)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "binding is absent, invalidated or belongs to another conversation".into(),
            ));
        }
        let key = sqlx::query_scalar::<_, Option<String>>(
            "SELECT continuation_key FROM conversation_agent_bindings WHERE id = ?1",
        )
        .bind(binding_id)
        .fetch_optional(&mut *conn)
        .await?
        .flatten()
        .filter(|value| !value.is_empty());
        if let Some(key) = key {
            sqlx::query(
                "UPDATE conversation_agent_bindings SET is_resume_head = 0
                 WHERE conversation_id = ?1 AND continuation_key = ?2 AND id != ?3",
            )
            .bind(conversation_id)
            .bind(&key)
            .bind(binding_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE conversation_agent_bindings SET is_resume_head = 1 WHERE id = ?1")
                .bind(binding_id)
                .execute(&mut *conn)
                .await?;
        }
        Ok(())
    }

    /// Keep the native identity as evidence, but never load this generation again.
    pub async fn invalidate_active(
        pool: &SqlitePool,
        conversation_id: Uuid,
        reason: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE conversation_agent_bindings SET resume_allowed = 0, invalidated_reason = ?, connection_id = NULL, status = 'recovering' WHERE id = (SELECT active_agent_binding_id FROM sessions WHERE id = ?)")
            .bind(reason).bind(conversation_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE sessions SET external_session_id = NULL, binding_revision = binding_revision + 1 WHERE id = ?")
            .bind(conversation_id).execute(&mut *tx).await?;
        tx.commit().await
    }

    /// A reconnect keeps its generation; a new native identity creates a new row.
    pub async fn invalidate_connection(
        pool: &SqlitePool,
        conversation_id: Uuid,
        connection_id: &str,
        reason: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE sessions SET external_session_id = NULL, binding_revision = binding_revision + 1 WHERE id = ? AND active_agent_binding_id IN (SELECT id FROM conversation_agent_bindings WHERE conversation_id = ? AND connection_id = ? AND resume_allowed = 1)")
            .bind(conversation_id).bind(conversation_id).bind(connection_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE conversation_agent_bindings SET resume_allowed = 0, invalidated_reason = ?, connection_id = NULL, status = 'recovering' WHERE conversation_id = ? AND connection_id = ? AND resume_allowed = 1")
            .bind(reason).bind(conversation_id).bind(connection_id).execute(&mut *tx).await?;
        tx.commit().await
    }

    /// A reconnect keeps its generation; a new native identity creates a new row.
    pub async fn link_native_session(
        pool: &SqlitePool,
        conversation_id: Uuid,
        agent_id: &AgentId,
        working_dir: &str,
        native_id: &str,
        connection_id: &str,
    ) -> Result<Self, sqlx::Error> {
        Self::store_native_session(
            pool,
            conversation_id,
            agent_id,
            working_dir,
            native_id,
            connection_id,
            None,
            true,
        )
        .await
    }

    /// Reserve a generation without changing the selected execution identity.
    pub async fn prepare_native_session(
        pool: &SqlitePool,
        conversation_id: Uuid,
        agent_id: &AgentId,
        working_dir: &str,
        native_id: &str,
        connection_id: &str,
    ) -> Result<Self, sqlx::Error> {
        Self::store_native_session(
            pool,
            conversation_id,
            agent_id,
            working_dir,
            native_id,
            connection_id,
            None,
            false,
        )
        .await
    }

    /// Reserve a generation scoped to a specific continuation key without
    /// changing the selected execution identity.
    pub async fn prepare_native_session_with_continuation_key(
        pool: &SqlitePool,
        conversation_id: Uuid,
        agent_id: &AgentId,
        working_dir: &str,
        native_id: &str,
        connection_id: &str,
        continuation_key: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        Self::store_native_session(
            pool,
            conversation_id,
            agent_id,
            working_dir,
            native_id,
            connection_id,
            continuation_key,
            false,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn store_native_session(
        pool: &SqlitePool,
        conversation_id: Uuid,
        agent_id: &AgentId,
        working_dir: &str,
        native_id: &str,
        connection_id: &str,
        continuation_key: Option<&str>,
        activate: bool,
    ) -> Result<Self, sqlx::Error> {
        let requested_continuation_key = continuation_key
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut tx = pool.begin().await?;
        // The newest generation for this Agent is a barrier after rebind. Never
        // search older generations for a matching native ID.
        let previous: Option<Self> = sqlx::query_as(&format!(
            "SELECT {BINDING_COLUMNS} FROM conversation_agent_bindings
             WHERE conversation_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 1"
        ))
        .bind(conversation_id)
        .bind(agent_id.as_str())
        .fetch_optional(&mut *tx)
        .await?;
        let latest_overall: Option<Self> = sqlx::query_as(&format!(
            "SELECT {BINDING_COLUMNS} FROM conversation_agent_bindings
             WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1"
        ))
        .bind(conversation_id)
        .fetch_optional(&mut *tx)
        .await?;
        let active = Self::active_on_connection(&mut tx, conversation_id).await?;
        let previous = active
            .clone()
            .filter(|b| b.agent_id == *agent_id)
            .or(previous);
        let reusable = previous.as_ref().filter(|b| {
            let is_current_generation =
                latest_overall.as_ref().is_some_and(|latest| latest.id == b.id);
            let continuation_key_matches = requested_continuation_key.is_none_or(|target_key| {
                b.continuation_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|existing| !existing.is_empty())
                    .is_none_or(|existing| existing == target_key)
            });
            b.resume_allowed
                && continuation_key_matches
                && (b.working_dir.is_empty()
                    || working_dir.is_empty()
                    || b.working_dir == working_dir)
                && match b.acp_session_id.as_deref() {
                    Some(id) if !is_placeholder_acp_session_id(id) => id == native_id,
                    _ => is_current_generation,
                }
        });
        let inherited_working_dir = reusable
            .map(|b| b.working_dir.as_str())
            .filter(|dir| !dir.is_empty())
            .or_else(|| {
                previous
                    .as_ref()
                    .map(|b| b.working_dir.as_str())
                    .filter(|dir| !dir.is_empty())
            })
            .or_else(|| {
                active
                    .as_ref()
                    .map(|b| b.working_dir.as_str())
                    .filter(|dir| !dir.is_empty())
            })
            .unwrap_or("");
        let effective_working_dir = if working_dir.is_empty() {
            inherited_working_dir
        } else {
            working_dir
        };
        let effective_continuation_key = requested_continuation_key
            .map(str::to_string)
            .or_else(|| {
                reusable
                    .and_then(|b| b.continuation_key.as_deref())
                    .map(str::trim)
                    .filter(|existing| !existing.is_empty())
                    .map(str::to_string)
            })
            .or_else(|| {
                (!effective_working_dir.is_empty())
                    .then(|| format!("{agent_id}|{effective_working_dir}"))
            });
        let binding = if let Some(binding) = reusable {
            binding.clone()
        } else {
            let prefs = previous.as_ref();
            Self::insert_on_connection(
                &mut tx,
                Uuid::new_v4(),
                CreateConversationAgentBinding {
                    conversation_id,
                    agent_id,
                    working_dir: effective_working_dir,
                    acp_session_id: Some(native_id),
                    continuation_key: effective_continuation_key.as_deref(),
                    acp_protocol_version: None,
                    runtime_version: None,
                    acp_version: None,
                    load_supported: false,
                    resume_supported: false,
                    close_supported: false,
                    terminal_supported: false,
                    additional_directories_supported: false,
                    prompt_capabilities_json: "{}",
                    session_capabilities_json: "{}",
                    client_capabilities_json: "{}",
                    mcp_servers_json: "[]",
                    modes_json: "[]",
                    config_options_json: "[]",
                    current_mode: prefs.and_then(|b| b.current_mode.as_deref()),
                    config_selection_json: prefs.map_or("{}", |b| b.config_selection_json.as_str()),
                    status: BindingStatus::Ready,
                },
            )
            .await?
        };
        sqlx::query(
            "UPDATE conversation_agent_bindings
             SET acp_session_id = ?,
                 connection_id = ?,
                 resume_allowed = 1,
                 working_dir = CASE WHEN ? = '' THEN working_dir ELSE ? END,
                 continuation_key = COALESCE(?, continuation_key),
                 status = 'ready',
                 updated_at = datetime('now', 'subsec')
             WHERE id = ?",
        )
        .bind(native_id)
        .bind(connection_id)
        .bind(effective_working_dir)
        .bind(effective_working_dir)
        .bind(effective_continuation_key.as_deref())
        .bind(binding.id)
        .execute(&mut *tx)
        .await?;
        if activate {
            Self::activate_on_connection(&mut tx, conversation_id, binding.id).await?;
        } else if active.as_ref().is_some_and(|act| act.id == binding.id)
            && let Some(ref key) = effective_continuation_key
        {
            sqlx::query(
                "UPDATE conversation_agent_bindings SET is_resume_head = 0
                 WHERE conversation_id = ?1 AND continuation_key = ?2 AND id != ?3",
            )
            .bind(conversation_id)
            .bind(key)
            .bind(binding.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE conversation_agent_bindings SET is_resume_head = 1 WHERE id = ?1")
                .bind(binding.id)
                .execute(&mut *tx)
                .await?;
        }
        let result = sqlx::query_as(&format!(
            "SELECT {BINDING_COLUMNS} FROM conversation_agent_bindings WHERE id = ?"
        ))
        .bind(binding.id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(result)
    }
}

fn is_placeholder_acp_session_id(acp_session_id: &str) -> bool {
    acp_session_id.is_empty()
        || acp_session_id.starts_with("dimo-new-session-")
        || acp_session_id.starts_with("vibex-new-session-")
        || acp_session_id.starts_with("prepared-")
        || acp_session_id.starts_with("pending-")
        || acp_session_id.starts_with("claude-native-")
        || acp_session_id.starts_with("codex-native-")
}
