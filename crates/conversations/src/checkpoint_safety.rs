//! Pre-flight workspace safety verification and short-lived lease locking for checkpoint rollback.
//!
//! Prevents destructive `git checkout` / working-tree restores from colliding with concurrent
//! agent turns, overlapping rollback operations, or shared non-isolated working directories.

use chrono::Utc;
use db::models::{
    conversation::ConversationAgentBindingRecord, conversation_turn::ConversationTurnRecord,
    session::Session, workspace::Workspace,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

/// Default TTL (in seconds) for a workspace rollback lease so a crashed host never
/// permanently bricks workspace rollbacks.
pub const DEFAULT_ROLLBACK_LEASE_TTL_SECS: i64 = 30;

#[derive(Debug, Error)]
pub enum RollbackSafetyError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error("conversation {0} not found")]
    ConversationNotFound(Uuid),

    #[error("checkpoint '{checkpoint_id}' not found for conversation {conversation_id}")]
    CheckpointNotFound {
        conversation_id: Uuid,
        checkpoint_id: String,
    },

    #[error(
        "workspace {workspace_id} is locked by rollback holder '{holder}' until unix timestamp {expires_at}"
    )]
    WorkspaceLocked {
        workspace_id: Uuid,
        holder: String,
        expires_at: i64,
    },
}

/// Wire-compatible rollback pre-flight classification consumed by `RewindConfirmDialog`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "lowercase")]
#[ts(export)]
pub enum RollbackSafetyReport {
    Safe {
        #[serde(rename = "engineSupportsRevert", alias = "engine_supports_revert")]
        #[ts(rename = "engineSupportsRevert")]
        engine_supports_revert: bool,
    },
    Degraded {
        reason: String,
    },
    Unsafe {
        reason: String,
    },
}

impl RollbackSafetyReport {
    pub fn is_safe_or_degraded(&self) -> bool {
        !matches!(self, Self::Unsafe { .. })
    }
}

/// RAII-friendly handle for an acquired `workspace_leases` row.
#[derive(Debug)]
pub struct WorkspaceRollbackLeaseGuard {
    pool: SqlitePool,
    workspace_id: Uuid,
    lease_holder: String,
    expires_at: i64,
    released: bool,
}

impl WorkspaceRollbackLeaseGuard {
    pub fn workspace_id(&self) -> Uuid {
        self.workspace_id
    }

    pub fn lease_holder(&self) -> &str {
        &self.lease_holder
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    /// Explicitly release the lease in SQLite before returning from the rollback command.
    pub async fn release(mut self) -> Result<(), sqlx::Error> {
        self.released = true;
        CheckpointRollbackSafety::release_rollback_lease(
            &self.pool,
            self.workspace_id,
            &self.lease_holder,
        )
        .await
    }
}

impl Drop for WorkspaceRollbackLeaseGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let pool = self.pool.clone();
            let workspace_id = self.workspace_id;
            let holder = self.lease_holder.clone();
            handle.spawn(async move {
                let _ =
                    CheckpointRollbackSafety::release_rollback_lease(&pool, workspace_id, &holder)
                        .await;
            });
        }
    }
}

/// Stateless coordinator for checkpoint rollback pre-flight checks and workspace leases.
pub struct CheckpointRollbackSafety;

/// Idempotently ensure the `workspace_leases` table exists.
pub async fn ensure_workspace_leases_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS workspace_leases (
               workspace_id TEXT PRIMARY KEY,
               lease_holder TEXT NOT NULL,
               acquired_at INTEGER NOT NULL,
               expires_at INTEGER NOT NULL
           )"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

impl CheckpointRollbackSafety {
    /// Verify whether rolling `conversation_id` back to `checkpoint_id` is safe, degraded, or unsafe.
    pub async fn verify_safety(
        pool: &SqlitePool,
        conversation_id: Uuid,
        checkpoint_id: &str,
    ) -> Result<RollbackSafetyReport, RollbackSafetyError> {
        ensure_workspace_leases_schema(pool).await?;

        let session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or(RollbackSafetyError::ConversationNotFound(conversation_id))?;
        let workspace_id = session.workspace_id;

        // 1. Active workspace rollback lease check.
        let now_ts = Utc::now().timestamp();
        if let Some((holder, expires_at)) = active_lease_holder(pool, workspace_id, now_ts).await? {
            let remaining = (expires_at - now_ts).max(1);
            return Ok(RollbackSafetyReport::Unsafe {
                reason: format!(
                    "Another rollback operation ('{holder}') currently holds the workspace lock ({remaining}s remaining)."
                ),
            });
        }

        // 2. Concurrent active turn check across all conversations in the same workspace.
        let in_flight_conversations =
            ConversationTurnRecord::in_flight_conversation_ids_for_workspace(pool, workspace_id)
                .await?;
        if !in_flight_conversations.is_empty() {
            let self_running = in_flight_conversations.contains(&conversation_id);
            let reason = if self_running && in_flight_conversations.len() == 1 {
                "This conversation still has an active turn in progress. Stop the current turn before rolling back.".to_string()
            } else {
                let sibling_count = in_flight_conversations
                    .iter()
                    .filter(|&&id| id != conversation_id)
                    .count()
                    .max(1);
                format!(
                    "{sibling_count} conversation(s) in this workspace currently have an active turn running. Rolling back files now would corrupt concurrent work."
                )
            };
            return Ok(RollbackSafetyReport::Unsafe { reason });
        }

        // 3. Shared non-worktree directory check across sibling workspaces / active bindings.
        if let Some(shared_reason) =
            detect_shared_directory_conflict(pool, conversation_id, workspace_id).await?
        {
            return Ok(RollbackSafetyReport::Unsafe {
                reason: shared_reason,
            });
        }

        // 4. Optional checkpoint existence check if a specific checkpoint identifier was supplied.
        let trimmed_cp = checkpoint_id.trim();
        if !trimmed_cp.is_empty() && !checkpoint_exists(pool, conversation_id, trimmed_cp).await? {
            return Err(RollbackSafetyError::CheckpointNotFound {
                conversation_id,
                checkpoint_id: trimmed_cp.to_string(),
            });
        }

        // 5. Engine native revert capability check.
        let latest_binding =
            ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?;
        match latest_binding {
            None => Ok(RollbackSafetyReport::Safe {
                engine_supports_revert: false,
            }),
            Some(binding) => {
                if binding_supports_native_revert(
                    binding.agent_id.as_str(),
                    &binding.session_capabilities_json,
                    binding.load_supported,
                    binding.resume_supported,
                ) {
                    Ok(RollbackSafetyReport::Safe {
                        engine_supports_revert: true,
                    })
                } else {
                    Ok(RollbackSafetyReport::Degraded {
                        reason: format!(
                            "Engine '{}' does not advertise native session revert; Dimo will restore workspace files from the Git checkpoint and fork/re-seed local conversation history.",
                            binding.agent_id.as_str()
                        ),
                    })
                }
            }
        }
    }

    /// Acquire an exclusive workspace rollback lease with the default 30-second TTL.
    pub async fn acquire_rollback_lease(
        pool: &SqlitePool,
        workspace_id: Uuid,
        lease_holder: &str,
    ) -> Result<WorkspaceRollbackLeaseGuard, RollbackSafetyError> {
        Self::acquire_rollback_lease_with_ttl(
            pool,
            workspace_id,
            lease_holder,
            DEFAULT_ROLLBACK_LEASE_TTL_SECS,
        )
        .await
    }

    /// Acquire an exclusive workspace rollback lease with an explicit TTL in seconds.
    ///
    /// Expired leases (`expires_at <= now`) are atomically evicted and replaced inside a
    /// `BEGIN IMMEDIATE` transaction.
    pub async fn acquire_rollback_lease_with_ttl(
        pool: &SqlitePool,
        workspace_id: Uuid,
        lease_holder: &str,
        ttl_secs: i64,
    ) -> Result<WorkspaceRollbackLeaseGuard, RollbackSafetyError> {
        ensure_workspace_leases_schema(pool).await?;
        let holder = lease_holder.trim();
        let holder = if holder.is_empty() {
            "rollback"
        } else {
            holder
        };
        let ws_key = workspace_id.to_string();
        let now_ts = Utc::now().timestamp();
        let expires_at = now_ts.saturating_add(ttl_secs.max(1));

        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

        let outcome: Result<(), RollbackSafetyError> = async {
            // Reclaim any expired lease first.
            sqlx::query("DELETE FROM workspace_leases WHERE workspace_id = ? AND expires_at <= ?")
                .bind(&ws_key)
                .bind(now_ts)
                .execute(&mut *conn)
                .await?;

            if let Some(row) = sqlx::query(
                "SELECT lease_holder, expires_at FROM workspace_leases WHERE workspace_id = ?",
            )
            .bind(&ws_key)
            .fetch_optional(&mut *conn)
            .await?
            {
                let existing_holder: String = row.try_get("lease_holder")?;
                let existing_expires: i64 = row.try_get("expires_at")?;
                if existing_holder != holder {
                    return Err(RollbackSafetyError::WorkspaceLocked {
                        workspace_id,
                        holder: existing_holder,
                        expires_at: existing_expires,
                    });
                }
                sqlx::query(
                    "UPDATE workspace_leases SET acquired_at = ?, expires_at = ? WHERE workspace_id = ?",
                )
                .bind(now_ts)
                .bind(expires_at)
                .bind(&ws_key)
                .execute(&mut *conn)
                .await?;
            } else {
                sqlx::query(
                    "INSERT INTO workspace_leases (workspace_id, lease_holder, acquired_at, expires_at) \
                     VALUES (?, ?, ?, ?)",
                )
                .bind(&ws_key)
                .bind(holder)
                .bind(now_ts)
                .bind(expires_at)
                .execute(&mut *conn)
                .await?;
            }
            Ok(())
        }
        .await;

        match outcome {
            Ok(()) => {
                sqlx::query("COMMIT").execute(&mut *conn).await?;
                Ok(WorkspaceRollbackLeaseGuard {
                    pool: pool.clone(),
                    workspace_id,
                    lease_holder: holder.to_string(),
                    expires_at,
                    released: false,
                })
            }
            Err(err) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(err)
            }
        }
    }

    /// Release a workspace rollback lease held by `lease_holder`.
    pub async fn release_rollback_lease(
        pool: &SqlitePool,
        workspace_id: Uuid,
        lease_holder: &str,
    ) -> Result<(), sqlx::Error> {
        ensure_workspace_leases_schema(pool).await?;
        sqlx::query("DELETE FROM workspace_leases WHERE workspace_id = ? AND lease_holder = ?")
            .bind(workspace_id.to_string())
            .bind(lease_holder.trim())
            .execute(pool)
            .await?;
        Ok(())
    }
}

async fn active_lease_holder(
    pool: &SqlitePool,
    workspace_id: Uuid,
    now_ts: i64,
) -> Result<Option<(String, i64)>, sqlx::Error> {
    sqlx::query_as::<_, (String, i64)>(
        "SELECT lease_holder, expires_at \
         FROM workspace_leases \
         WHERE workspace_id = ? AND expires_at > ?",
    )
    .bind(workspace_id.to_string())
    .bind(now_ts)
    .fetch_optional(pool)
    .await
}

async fn detect_shared_directory_conflict(
    pool: &SqlitePool,
    conversation_id: Uuid,
    workspace_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    if let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await?
        && let Some(container_ref) = workspace
            .container_ref
            .as_deref()
            .map(normalize_dir_key)
            .filter(|s| !s.is_empty())
    {
        // Check if another non-archived workspace points at the exact same physical directory
        // AND has an in-flight turn or active binding.
        let rows = sqlx::query(
            "SELECT id, container_ref FROM workspaces WHERE id != ? AND archived = 0 AND container_ref IS NOT NULL",
        )
        .bind(workspace_id)
        .fetch_all(pool)
        .await?;

        for row in rows {
            let other_ws_id: Uuid = row.try_get("id")?;
            let other_ref: String = row.try_get("container_ref")?;
            if normalize_dir_key(&other_ref) == container_ref {
                let other_in_flight =
                    ConversationTurnRecord::in_flight_conversation_ids_for_workspace(
                        pool,
                        other_ws_id,
                    )
                    .await?;
                if !other_in_flight.is_empty() {
                    return Ok(Some(format!(
                        "Directory '{}' is shared with another active workspace ({other_ws_id}) that has a running turn.",
                        workspace.container_ref.unwrap_or_default()
                    )));
                }
                return Ok(Some(format!(
                    "Directory '{}' is shared across multiple non-isolated workspaces ({workspace_id} and {other_ws_id}); rolling back files would mutate sibling workspace state.",
                    workspace.container_ref.unwrap_or_default()
                )));
            }
        }
    }

    // Also inspect `working_dir` on active bindings from OTHER workspaces that might be running
    // a turn in the same directory without a dedicated worktree container_ref.
    if let Some(binding) =
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?
    {
        let my_dir = normalize_dir_key(&binding.working_dir);
        if !my_dir.is_empty() {
            let active_other_dirs: Vec<(Uuid, String)> = sqlx::query_as(
                "SELECT b.conversation_id, b.working_dir \
                 FROM conversation_agent_bindings b \
                 JOIN conversation_turns t ON t.conversation_id = b.conversation_id \
                 WHERE b.conversation_id != ? \
                   AND t.status IN ('pending', 'running', 'blocked')",
            )
            .bind(conversation_id)
            .fetch_all(pool)
            .await?;

            for (other_conv, other_dir) in active_other_dirs {
                if normalize_dir_key(&other_dir) == my_dir {
                    return Ok(Some(format!(
                        "Working directory '{}' has an active turn in conversation {other_conv}.",
                        binding.working_dir
                    )));
                }
            }
        }
    }

    Ok(None)
}

fn normalize_dir_key(path: &str) -> String {
    let trimmed = path.trim().replace('\\', "/");
    let trimmed = trimmed.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn binding_supports_native_revert(
    agent_id: &str,
    session_capabilities_json: &str,
    load_supported: bool,
    resume_supported: bool,
) -> bool {
    if let Ok(caps) = serde_json::from_str::<serde_json::Value>(session_capabilities_json) {
        if caps
            .get("fork_session")
            .or_else(|| caps.get("forkSession"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            return true;
        }
        if caps
            .get("revert_session")
            .or_else(|| caps.get("revertSession"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            return true;
        }
    }

    let normalized_agent = agent_id
        .split(':')
        .next()
        .unwrap_or(agent_id)
        .trim()
        .to_ascii_lowercase();
    matches!(
        agents::AgentKind::from_lenient(normalized_agent.as_str()),
        Some(agents::AgentKind::Codex | agents::AgentKind::ClaudeCode)
    ) && (resume_supported || load_supported)
}

async fn checkpoint_exists(
    pool: &SqlitePool,
    conversation_id: Uuid,
    checkpoint_id: &str,
) -> Result<bool, sqlx::Error> {
    if let Ok(cp_uuid) = Uuid::parse_str(checkpoint_id) {
        if table_exists(pool, "conversation_checkpoints").await? {
            let found: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM conversation_checkpoints WHERE id = ? AND conversation_id = ?)",
            )
            .bind(cp_uuid)
            .bind(conversation_id)
            .fetch_one(pool)
            .await?;
            if found != 0 {
                return Ok(true);
            }
        }

        if table_exists(pool, "session_checkpoints").await? {
            let found: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM session_checkpoints WHERE id = ? AND session_id = ?)",
            )
            .bind(cp_uuid)
            .bind(conversation_id)
            .fetch_one(pool)
            .await?;
            if found != 0 {
                return Ok(true);
            }
        }

        // Also allow turn_id references when the UI passes a turn UUID to rewind to.
        let turn_found: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE id = ? AND conversation_id = ?)",
        )
        .bind(cp_uuid)
        .bind(conversation_id)
        .fetch_one(pool)
        .await?;
        if turn_found != 0 {
            return Ok(true);
        }
    }

    if let Ok(ordinal) = checkpoint_id.parse::<i64>() {
        if table_exists(pool, "session_checkpoints").await? {
            let found: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM session_checkpoints WHERE session_id = ? AND ordinal = ?)",
            )
            .bind(conversation_id)
            .bind(ordinal)
            .fetch_one(pool)
            .await?;
            if found != 0 {
                return Ok(true);
            }
        }
        let turn_ord_found: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND ordinal = ?)",
        )
        .bind(conversation_id)
        .bind(ordinal)
        .fetch_one(pool)
        .await?;
        if turn_ord_found != 0 {
            return Ok(true);
        }
    }

    Ok(false)
}

async fn table_exists(pool: &SqlitePool, name: &str) -> Result<bool, sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
    )
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(exists != 0)
}

#[cfg(test)]
mod tests {
    use agents::AgentId;
    use db::{
        DBService,
        models::{
            conversation::{BindingStatus, CreateConversationAgentBinding},
            conversation_turn::CreateConversationTurn,
        },
    };

    use super::*;

    async fn seed_workspace_and_session(
        pool: &SqlitePool,
        workspace_id: Uuid,
        conversation_id: Uuid,
        container_ref: Option<&str>,
    ) {
        let project_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO projects (id, name, created_at, updated_at) \
             VALUES (?, 'Proj', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(pool)
        .await
        .expect("insert project");

        sqlx::query(
            "INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) \
             VALUES (?, ?, 'Task', 'todo', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("insert task");

        sqlx::query(
            "INSERT INTO workspaces (id, task_id, project_id, container_ref, branch, setup_completed_at, created_at, updated_at, archived, pinned) \
             VALUES (?, ?, ?, ?, 'main', NULL, datetime('now'), datetime('now'), 0, 0)",
        )
        .bind(workspace_id)
        .bind(task_id)
        .bind(project_id)
        .bind(container_ref)
        .execute(pool)
        .await
        .expect("insert workspace");

        sqlx::query(
            "INSERT INTO sessions (id, workspace_id, task_id, name, status, created_at, updated_at) \
             VALUES (?, ?, ?, 'Chat', 'todo', datetime('now'), datetime('now'))",
        )
        .bind(conversation_id)
        .bind(workspace_id)
        .bind(task_id)
        .execute(pool)
        .await
        .expect("insert session");
    }

    #[tokio::test]
    async fn rollback_safety_classifies_safe_degraded_concurrent_turn_and_lease_ttl() {
        let db = DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory db");
        let pool = db.writer().as_pool();

        let ws_id = Uuid::new_v4();
        let conv_a = Uuid::new_v4();
        let conv_b = Uuid::new_v4();
        seed_workspace_and_session(pool, ws_id, conv_a, Some("/worktrees/ws-a")).await;
        sqlx::query(
            "INSERT INTO sessions (id, workspace_id, name, status, created_at, updated_at) \
             VALUES (?, ?, 'Sibling Chat', 'todo', datetime('now'), datetime('now'))",
        )
        .bind(conv_b)
        .bind(ws_id)
        .execute(pool)
        .await
        .expect("insert sibling session");

        // Bind conv_a to Claude with fork_session = true -> Safe { engine_supports_revert: true }.
        let claude_id = AgentId::parse("claude").expect("parse claude agent id");
        ConversationAgentBindingRecord::create(
            pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id: conv_a,
                agent_id: &claude_id,
                working_dir: "/worktrees/ws-a",
                acp_session_id: Some("acp-1"),
                continuation_key: None,
                acp_protocol_version: Some("1"),
                runtime_version: None,
                acp_version: None,
                load_supported: true,
                resume_supported: true,
                close_supported: true,
                terminal_supported: true,
                additional_directories_supported: false,
                prompt_capabilities_json: "{}",
                session_capabilities_json: r#"{"fork_session":true}"#,
                client_capabilities_json: "{}",
                mcp_servers_json: "[]",
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                config_selection_json: "{}",
                status: BindingStatus::Ready,
            },
        )
        .await
        .expect("create claude binding");

        let safe = CheckpointRollbackSafety::verify_safety(pool, conv_a, "")
            .await
            .expect("verify safe");
        assert_eq!(
            safe,
            RollbackSafetyReport::Safe {
                engine_supports_revert: true
            }
        );
        let wire = serde_json::to_value(&safe).expect("serialize safe");
        assert_eq!(wire["status"], "safe");
        assert_eq!(wire["engineSupportsRevert"], true);

        // Bind conv_b to custom engine without fork/revert -> Degraded.
        let custom_id = AgentId::parse("custom-acp").expect("parse custom-acp agent id");
        ConversationAgentBindingRecord::create(
            pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id: conv_b,
                agent_id: &custom_id,
                working_dir: "/worktrees/ws-a",
                acp_session_id: Some("acp-2"),
                continuation_key: None,
                acp_protocol_version: Some("1"),
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
                current_mode: None,
                config_selection_json: "{}",
                status: BindingStatus::Ready,
            },
        )
        .await
        .expect("create custom binding");

        let degraded = CheckpointRollbackSafety::verify_safety(pool, conv_b, "")
            .await
            .expect("verify degraded");
        assert!(matches!(degraded, RollbackSafetyReport::Degraded { .. }));

        // Start a running turn on sibling conv_b -> conv_a becomes Unsafe!
        let sibling_turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id: conv_b,
                prompt_id: Some("p-1"),
                text_preview: Some("running"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create pending turn");

        let unsafe_concurrent = CheckpointRollbackSafety::verify_safety(pool, conv_a, "")
            .await
            .expect("verify concurrent turn");
        assert!(matches!(
            unsafe_concurrent,
            RollbackSafetyReport::Unsafe { .. }
        ));

        ConversationTurnRecord::mark_completed(
            pool,
            sibling_turn.id,
            Some("end_turn"),
            None,
            None,
        )
        .await
        .expect("complete sibling turn");

        // Acquire active lease -> second caller blocked & verify_safety returns Unsafe.
        let guard = CheckpointRollbackSafety::acquire_rollback_lease(pool, ws_id, "holder-1")
            .await
            .expect("acquire lease");
        let second = CheckpointRollbackSafety::acquire_rollback_lease(pool, ws_id, "holder-2")
            .await
            .expect_err("second holder must be rejected");
        assert!(matches!(
            second,
            RollbackSafetyError::WorkspaceLocked { .. }
        ));

        let unsafe_leased = CheckpointRollbackSafety::verify_safety(pool, conv_a, "")
            .await
            .expect("verify while leased");
        assert!(matches!(unsafe_leased, RollbackSafetyReport::Unsafe { .. }));

        guard.release().await.expect("release lease");

        // Expired lease is reclaimed automatically.
        sqlx::query(
            "INSERT INTO workspace_leases (workspace_id, lease_holder, acquired_at, expires_at) \
             VALUES (?, 'crashed-holder', 100, 130)",
        )
        .bind(ws_id.to_string())
        .execute(pool)
        .await
        .expect("insert expired lease");

        let reclaimed =
            CheckpointRollbackSafety::acquire_rollback_lease(pool, ws_id, "holder-after-crash")
                .await
                .expect("reclaim expired lease");
        reclaimed.release().await.expect("release reclaimed");
    }
}
