//! SQLite adapter for the transport-neutral Automation v2 domain.

use async_trait::async_trait;
use automation::{
    AutomationDraft, ClaimStorePort, ClaimedRun, EngineError, IsolationSpec, PreparedWorkspace,
    RecoveryStorePort, RunError, RunSnapshot, RunStatus, RunStorePort, ScheduleSpec,
    TurnLaunchCorrelation, TurnLaunchSpec, next_run_after,
};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, Sqlite, SqliteConnection, SqlitePool, Transaction};
use uuid::Uuid;

#[derive(Clone)]
pub struct SqliteAutomationStore {
    pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutomationRecord {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
    pub spec_version: u16,
    pub trigger: ScheduleSpec,
    pub next_run_at: Option<DateTime<Utc>>,
    pub launch_spec: TurnLaunchSpec,
    pub legacy_migration_status: String,
    pub last_run_status: Option<String>,
    pub unseen_failure_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutomationRunRecord {
    pub snapshot: RunSnapshot,
    pub trigger: String,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub stop_reason: Option<String>,
    pub summary: Option<String>,
    pub seen: bool,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct AutomationRow {
    id: Uuid,
    name: String,
    enabled: bool,
    spec_version: i64,
    trigger_kind: String,
    cron: Option<String>,
    timezone: String,
    next_run_at: Option<DateTime<Utc>>,
    turn_launch_spec_json: String,
    legacy_migration_status: String,
    last_run_status: Option<String>,
    unseen_failure_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct RunRow {
    id: Uuid,
    automation_id: Uuid,
    trigger: String,
    scheduled_for: Option<DateTime<Utc>>,
    status: String,
    conversation_id: Option<Uuid>,
    turn_id: Option<Uuid>,
    connection_id: Option<String>,
    worktree_workspace_id: Option<Uuid>,
    resolved_versions_json: String,
    cancellation_requested: bool,
    stop_reason: Option<String>,
    summary: Option<String>,
    error: Option<String>,
    seen: bool,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

const AUTOMATION_COLUMNS: &str = "id,name,enabled,spec_version,trigger_kind,cron,timezone,\
    next_run_at,turn_launch_spec_json,legacy_migration_status,last_run_status,\
    unseen_failure_count,created_at,updated_at";
const RUN_COLUMNS: &str = "id,automation_id,trigger,scheduled_for,status,conversation_id,turn_id,\
    connection_id,worktree_workspace_id,resolved_versions_json,cancellation_requested,error,\
    stop_reason,summary,seen,started_at,finished_at";

impl SqliteAutomationStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn create(
        &self,
        draft: AutomationDraft,
        now: DateTime<Utc>,
    ) -> Result<AutomationRecord, sqlx::Error> {
        let launch_spec =
            TurnLaunchSpec::from_automation_draft(draft.launch).map_err(protocol_error)?;
        let next_run_at = if draft.enabled {
            next_run_after(&draft.trigger, now).map_err(protocol_error)?
        } else {
            None
        };
        let (trigger_kind, cron, timezone) = schedule_columns(&draft.trigger);
        let id = Uuid::new_v4();
        let launch_json = serde_json::to_string(&launch_spec).map_err(protocol_error)?;
        sqlx::query(
            "INSERT INTO automations
             (id,name,enabled,spec_version,trigger_kind,cron,timezone,next_run_at,
              turn_launch_spec_json,isolation,project_id,root_folder,branch,
              legacy_migration_status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)",
        )
        .bind(id)
        .bind(draft.name)
        .bind(draft.enabled)
        .bind(i64::from(launch_spec.spec_version))
        .bind(trigger_kind)
        .bind(cron)
        .bind(timezone)
        .bind(next_run_at)
        .bind(launch_json)
        .bind(isolation_str(&launch_spec.workspace.isolation))
        .bind(launch_spec.workspace.project_id)
        .bind(&launch_spec.workspace.root_folder)
        .bind(&launch_spec.workspace.branch)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.find(id).await?.ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn find(&self, id: Uuid) -> Result<Option<AutomationRecord>, sqlx::Error> {
        let row = sqlx::query_as::<_, AutomationRow>(&format!(
            "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(parse_automation_row).transpose()
    }

    pub async fn update(
        &self,
        id: Uuid,
        draft: AutomationDraft,
        now: DateTime<Utc>,
    ) -> Result<AutomationRecord, sqlx::Error> {
        let launch_spec =
            TurnLaunchSpec::from_automation_draft(draft.launch).map_err(protocol_error)?;
        let next_run_at = if draft.enabled {
            next_run_after(&draft.trigger, now).map_err(protocol_error)?
        } else {
            None
        };
        let (trigger_kind, cron, timezone) = schedule_columns(&draft.trigger);
        let launch_json = serde_json::to_string(&launch_spec).map_err(protocol_error)?;
        let result = sqlx::query(
            "UPDATE automations
             SET name=?,enabled=?,spec_version=?,trigger_kind=?,cron=?,timezone=?,
                 next_run_at=?,turn_launch_spec_json=?,isolation=?,project_id=?,
                 root_folder=?,branch=?,legacy_migration_status='ready',updated_at=?
             WHERE id=?",
        )
        .bind(draft.name)
        .bind(draft.enabled)
        .bind(i64::from(launch_spec.spec_version))
        .bind(trigger_kind)
        .bind(cron)
        .bind(timezone)
        .bind(next_run_at)
        .bind(launch_json)
        .bind(isolation_str(&launch_spec.workspace.isolation))
        .bind(launch_spec.workspace.project_id)
        .bind(&launch_spec.workspace.root_folder)
        .bind(&launch_spec.workspace.branch)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::RowNotFound);
        }
        self.find(id).await?.ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn list(&self) -> Result<Vec<AutomationRecord>, sqlx::Error> {
        let rows = sqlx::query_as::<_, AutomationRow>(&format!(
            "SELECT {AUTOMATION_COLUMNS} FROM automations ORDER BY updated_at DESC"
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(parse_automation_row).collect()
    }

    pub async fn set_enabled(
        &self,
        id: Uuid,
        enabled: bool,
        now: DateTime<Utc>,
    ) -> Result<AutomationRecord, sqlx::Error> {
        let automation = self.find(id).await?.ok_or(sqlx::Error::RowNotFound)?;
        if enabled
            && (automation.legacy_migration_status != "ready"
                || automation
                    .launch_spec
                    .workspace
                    .root_folder
                    .trim()
                    .is_empty())
        {
            return Err(protocol_error(
                "legacy automation must be reviewed before it can be enabled",
            ));
        }
        let next_run_at = if enabled {
            next_run_after(&automation.trigger, now).map_err(protocol_error)?
        } else {
            None
        };
        sqlx::query("UPDATE automations SET enabled=?,next_run_at=?,updated_at=? WHERE id=?")
            .bind(enabled)
            .bind(next_run_at)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.find(id).await?.ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn delete(&self, id: Uuid) -> Result<(), sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM automation_runs WHERE automation_id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM automation_legacy_evidence WHERE automation_id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM automations WHERE id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn unseen_failure_count(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM automation_runs
             WHERE status IN ('failed','interrupted') AND seen=0",
        )
        .fetch_one(&self.pool)
        .await
    }

    pub async fn mark_all_seen(&self) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE automation_runs SET seen=1 WHERE seen=0")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn run_now(
        &self,
        automation_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<AutomationRunRecord, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let executable: Option<(String, String)> = sqlx::query_as(
            "SELECT legacy_migration_status,root_folder
             FROM automations WHERE id = ?",
        )
        .bind(automation_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let (migration_status, root_folder) = executable.ok_or(sqlx::Error::RowNotFound)?;
        if migration_status != "ready" || root_folder.trim().is_empty() {
            return Err(protocol_error(
                "legacy automation must be reviewed before it can run",
            ));
        }
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM automation_runs
             WHERE automation_id = ? AND status = 'running'",
        )
        .bind(automation_id)
        .fetch_one(&mut *transaction)
        .await?;
        let run_id = Uuid::new_v4();
        if active > 0 {
            sqlx::query(
                "INSERT INTO automation_runs
                 (id,automation_id,trigger,status,error,started_at,finished_at)
                 VALUES (?,?,'manual','skipped','previous run still active',?,?)",
            )
            .bind(run_id)
            .bind(automation_id)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        } else {
            insert_running(&mut transaction, run_id, automation_id, "manual", None, now).await?;
        }
        transaction.commit().await?;
        self.run(run_id).await?.ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn request_cancel(&self, run_id: Uuid) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE automation_runs SET cancellation_requested = 1
             WHERE id = ? AND status = 'running'",
        )
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn run(&self, run_id: Uuid) -> Result<Option<AutomationRunRecord>, sqlx::Error> {
        let row = sqlx::query_as::<_, RunRow>(&format!(
            "SELECT {RUN_COLUMNS} FROM automation_runs WHERE id = ?"
        ))
        .bind(run_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(parse_run_row).transpose()
    }

    pub async fn runs(
        &self,
        automation_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AutomationRunRecord>, sqlx::Error> {
        let rows = sqlx::query_as::<_, RunRow>(&format!(
            "SELECT {RUN_COLUMNS} FROM automation_runs
             WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?"
        ))
        .bind(automation_id)
        .bind(limit.clamp(1, 200))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(parse_run_row).collect()
    }

    pub async fn running_runs(&self) -> Result<Vec<AutomationRunRecord>, sqlx::Error> {
        let rows = sqlx::query_as::<_, RunRow>(&format!(
            "SELECT {RUN_COLUMNS} FROM automation_runs
             WHERE status = 'running' ORDER BY started_at ASC"
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(parse_run_row).collect()
    }

    pub async fn try_acquire_shared_root(
        &self,
        root_folder: &str,
        run_id: Uuid,
        now: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "INSERT INTO automation_shared_root_locks
             (root_folder,run_id,acquired_at) VALUES (?,?,?)
             ON CONFLICT(root_folder) DO NOTHING",
        )
        .bind(root_folder)
        .bind(run_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn release_shared_root(&self, run_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM automation_shared_root_locks WHERE run_id = ?")
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn claim_with_trigger(
        &self,
        now: DateTime<Utc>,
        run_trigger: &str,
    ) -> Result<Vec<ClaimedRun>, EngineError> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
        let result = self
            .claim_on_connection(&mut connection, now, run_trigger)
            .await;
        match result {
            Ok(claimed) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *connection).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                    return Err(EngineError::ClaimStore(error.to_string()));
                }
                Ok(claimed)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    async fn claim_on_connection(
        &self,
        connection: &mut SqliteConnection,
        now: DateTime<Utc>,
        run_trigger: &str,
    ) -> Result<Vec<ClaimedRun>, EngineError> {
        let due = sqlx::query_as::<_, AutomationRow>(&format!(
            "SELECT {AUTOMATION_COLUMNS} FROM automations
             WHERE enabled = 1 AND trigger_kind = 'schedule'
               AND legacy_migration_status = 'ready'
               AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at ASC"
        ))
        .bind(now)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
        let mut claimed = Vec::new();
        for row in due {
            let Some(slot) = row.next_run_at else {
                continue;
            };
            let trigger = ScheduleSpec::Schedule {
                cron: row.cron.clone().unwrap_or_default(),
                timezone: row.timezone.clone(),
            };
            let next = next_run_after(&trigger, now)
                .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
            let advanced = sqlx::query(
                "UPDATE automations SET next_run_at = ?, updated_at = ?
                 WHERE id = ? AND next_run_at = ? AND enabled = 1",
            )
            .bind(next)
            .bind(now)
            .bind(row.id)
            .bind(slot)
            .execute(&mut *connection)
            .await
            .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
            if advanced.rows_affected() != 1 {
                continue;
            }
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM automation_runs
                 WHERE automation_id = ? AND status = 'running'",
            )
            .bind(row.id)
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
            let run_id = Uuid::new_v4();
            if active > 0 {
                sqlx::query(
                    "INSERT INTO automation_runs
                     (id,automation_id,trigger,scheduled_for,status,error,started_at,finished_at)
                     VALUES (?,?,?,?,'skipped','previous run still active',?,?)",
                )
                .bind(run_id)
                .bind(row.id)
                .bind(run_trigger)
                .bind(slot)
                .bind(now)
                .bind(now)
                .execute(&mut *connection)
                .await
                .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
                continue;
            }
            insert_running_on_connection(connection, run_id, row.id, run_trigger, Some(slot), now)
                .await
                .map_err(|error| EngineError::ClaimStore(error.to_string()))?;
            claimed.push(ClaimedRun {
                run_id,
                automation_id: row.id,
                scheduled_for: slot,
                next_run_at: next,
            });
        }
        Ok(claimed)
    }
}

#[async_trait]
impl ClaimStorePort for SqliteAutomationStore {
    async fn claim_due(&self, now: DateTime<Utc>) -> Result<Vec<ClaimedRun>, EngineError> {
        self.claim_with_trigger(now, "schedule").await
    }
}

#[async_trait]
impl RecoveryStorePort for SqliteAutomationStore {
    async fn interrupt_running(&self, now: DateTime<Utc>) -> Result<Vec<Uuid>, EngineError> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|error| EngineError::RecoveryStore(error.to_string()))?;
        let ids = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM automation_runs WHERE status = 'running'",
        )
        .fetch_all(&mut *transaction)
        .await
        .map_err(|error| EngineError::RecoveryStore(error.to_string()))?;
        sqlx::query(
            "UPDATE automation_runs
             SET status = 'interrupted', stop_reason = 'host_restarted',
                 finished_at = ?
             WHERE status = 'running'",
        )
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| EngineError::RecoveryStore(error.to_string()))?;
        sqlx::query("DELETE FROM automation_shared_root_locks")
            .execute(&mut *transaction)
            .await
            .map_err(|error| EngineError::RecoveryStore(error.to_string()))?;
        transaction
            .commit()
            .await
            .map_err(|error| EngineError::RecoveryStore(error.to_string()))?;
        Ok(ids)
    }

    async fn claim_catch_up(&self, now: DateTime<Utc>) -> Result<Vec<ClaimedRun>, EngineError> {
        self.claim_with_trigger(now, "catch_up")
            .await
            .map_err(|error| EngineError::RecoveryStore(error.to_string()))
    }
}

#[async_trait]
impl RunStorePort for SqliteAutomationStore {
    async fn cancellation_requested(&self, run_id: Uuid) -> Result<bool, RunError> {
        sqlx::query_scalar("SELECT cancellation_requested FROM automation_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| RunError::Store(error.to_string()))?
            .ok_or_else(|| RunError::Store(format!("run {run_id} not found")))
    }

    async fn attach_workspace(
        &self,
        run_id: Uuid,
        workspace: &PreparedWorkspace,
    ) -> Result<(), RunError> {
        sqlx::query(
            "UPDATE automation_runs SET worktree_workspace_id = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(workspace.workspace_id)
        .bind(run_id)
        .execute(&self.pool)
        .await
        .map_err(|error| RunError::Store(error.to_string()))?;
        Ok(())
    }

    async fn attach_launch(
        &self,
        run_id: Uuid,
        launch: &TurnLaunchCorrelation,
    ) -> Result<(), RunError> {
        let evidence = serde_json::to_string(&launch.resolved_versions)
            .map_err(|error| RunError::Store(error.to_string()))?;
        sqlx::query(
            "UPDATE automation_runs
             SET conversation_id = ?, connection_id = ?, resolved_versions_json = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(launch.conversation_id)
        .bind(&launch.connection_id)
        .bind(evidence)
        .bind(run_id)
        .execute(&self.pool)
        .await
        .map_err(|error| RunError::Store(error.to_string()))?;
        Ok(())
    }

    async fn attach_turn(&self, run_id: Uuid, turn_id: Uuid) -> Result<(), RunError> {
        sqlx::query(
            "UPDATE automation_runs SET turn_id = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(turn_id)
        .bind(run_id)
        .execute(&self.pool)
        .await
        .map_err(|error| RunError::Store(error.to_string()))?;
        Ok(())
    }

    async fn settle(
        &self,
        run_id: Uuid,
        status: RunStatus,
        error: Option<String>,
    ) -> Result<bool, RunError> {
        let now = Utc::now();
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|error| RunError::Store(error.to_string()))?;
        let result = sqlx::query(
            "UPDATE automation_runs
             SET status = ?, error = ?, finished_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(run_status_str(status))
        .bind(error)
        .bind(now)
        .bind(run_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| RunError::Store(error.to_string()))?;
        if result.rows_affected() == 1 {
            sqlx::query("DELETE FROM automation_shared_root_locks WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *transaction)
                .await
                .map_err(|error| RunError::Store(error.to_string()))?;
            sqlx::query(
                "UPDATE automations
                 SET last_run_at = ?,
                     last_run_status = ?,
                     last_run_conversation_id = (
                         SELECT conversation_id FROM automation_runs WHERE id = ?
                     ),
                     unseen_failure_count = unseen_failure_count +
                         CASE WHEN ? IN ('failed','interrupted') THEN 1 ELSE 0 END,
                     updated_at = ?
                 WHERE id = (
                     SELECT automation_id FROM automation_runs WHERE id = ?
                 )",
            )
            .bind(now)
            .bind(run_status_str(status))
            .bind(run_id)
            .bind(run_status_str(status))
            .bind(now)
            .bind(run_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| RunError::Store(error.to_string()))?;
        }
        transaction
            .commit()
            .await
            .map_err(|error| RunError::Store(error.to_string()))?;
        Ok(result.rows_affected() == 1)
    }
}

async fn insert_running(
    transaction: &mut Transaction<'_, Sqlite>,
    run_id: Uuid,
    automation_id: Uuid,
    trigger: &str,
    scheduled_for: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO automation_runs
         (id,automation_id,trigger,scheduled_for,status,started_at)
         VALUES (?,?,?,?,'running',?)",
    )
    .bind(run_id)
    .bind(automation_id)
    .bind(trigger)
    .bind(scheduled_for)
    .bind(now)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn insert_running_on_connection(
    connection: &mut SqliteConnection,
    run_id: Uuid,
    automation_id: Uuid,
    trigger: &str,
    scheduled_for: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO automation_runs
         (id,automation_id,trigger,scheduled_for,status,started_at)
         VALUES (?,?,?,?,'running',?)",
    )
    .bind(run_id)
    .bind(automation_id)
    .bind(trigger)
    .bind(scheduled_for)
    .bind(now)
    .execute(connection)
    .await?;
    Ok(())
}

fn parse_automation_row(row: AutomationRow) -> Result<AutomationRecord, sqlx::Error> {
    let trigger = match row.trigger_kind.as_str() {
        "manual" => ScheduleSpec::Manual,
        "schedule" => ScheduleSpec::Schedule {
            cron: row.cron.unwrap_or_default(),
            timezone: row.timezone,
        },
        other => return Err(protocol_error(format!("unknown trigger kind `{other}`"))),
    };
    Ok(AutomationRecord {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        spec_version: u16::try_from(row.spec_version).map_err(protocol_error)?,
        trigger,
        next_run_at: row.next_run_at,
        launch_spec: serde_json::from_str(&row.turn_launch_spec_json).map_err(protocol_error)?,
        legacy_migration_status: row.legacy_migration_status,
        last_run_status: row.last_run_status,
        unseen_failure_count: row.unseen_failure_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn parse_run_row(row: RunRow) -> Result<AutomationRunRecord, sqlx::Error> {
    let status = parse_run_status(&row.status).map_err(protocol_error)?;
    let resolved_versions = if row.resolved_versions_json == "{}" {
        None
    } else {
        Some(serde_json::from_str(&row.resolved_versions_json).map_err(protocol_error)?)
    };
    Ok(AutomationRunRecord {
        snapshot: RunSnapshot {
            run_id: row.id,
            automation_id: row.automation_id,
            status,
            cancellation_requested: row.cancellation_requested,
            workspace_id: row.worktree_workspace_id,
            conversation_id: row.conversation_id,
            turn_id: row.turn_id,
            connection_id: row.connection_id,
            resolved_versions,
            error: row.error,
        },
        trigger: row.trigger,
        scheduled_for: row.scheduled_for,
        stop_reason: row.stop_reason,
        summary: row.summary,
        seen: row.seen,
        started_at: row.started_at,
        finished_at: row.finished_at,
    })
}

fn schedule_columns(spec: &ScheduleSpec) -> (&'static str, Option<&str>, &str) {
    match spec {
        ScheduleSpec::Manual => ("manual", None, "UTC"),
        ScheduleSpec::Schedule { cron, timezone } => {
            ("schedule", Some(cron.as_str()), timezone.as_str())
        }
    }
}

fn isolation_str(isolation: &IsolationSpec) -> &'static str {
    match isolation {
        IsolationSpec::WorktreePerRun => "worktree_per_run",
        IsolationSpec::SharedInRoot => "shared_in_root",
    }
}

fn run_status_str(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Interrupted => "interrupted",
        RunStatus::Skipped => "skipped",
    }
}

fn parse_run_status(raw: &str) -> Result<RunStatus, String> {
    match raw {
        "running" => Ok(RunStatus::Running),
        "completed" => Ok(RunStatus::Completed),
        "failed" => Ok(RunStatus::Failed),
        "cancelled" => Ok(RunStatus::Cancelled),
        "interrupted" => Ok(RunStatus::Interrupted),
        "skipped" => Ok(RunStatus::Skipped),
        other => Err(format!("unknown run status `{other}`")),
    }
}

fn protocol_error(error: impl std::fmt::Display) -> sqlx::Error {
    sqlx::Error::Protocol(error.to_string())
}
