use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use crate::{WaitForEventStepSpec, WorkflowDefinition, WorkflowError, WorkflowPolicy};

pub(crate) const EVENT_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowRunStatus {
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    NeedsReview,
}

impl FromStr for WorkflowRunStatus {
    type Err = WorkflowError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            "needs_review" => Ok(Self::NeedsReview),
            _ => Err(WorkflowError::Projection(format!(
                "unknown workflow run status `{value}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowStepStatus {
    Pending,
    Ready,
    Claimed,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    NeedsReview,
    Skipped,
}

impl FromStr for WorkflowStepStatus {
    type Err = WorkflowError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "ready" => Ok(Self::Ready),
            "claimed" => Ok(Self::Claimed),
            "running" => Ok(Self::Running),
            "waiting_approval" => Ok(Self::WaitingApproval),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            "needs_review" => Ok(Self::NeedsReview),
            "skipped" => Ok(Self::Skipped),
            _ => Err(WorkflowError::Projection(format!(
                "unknown workflow step status `{value}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowEvent {
    RunStarted {
        definition_version_id: Uuid,
        step_ids: Vec<String>,
        input: serde_json::Value,
        policy: WorkflowPolicy,
        deadline_at: DateTime<Utc>,
    },
    RunDerived {
        parent_run_id: Uuid,
        fork_step_id: String,
        run_mode: DebugRunScope,
        reused_step_ids: Vec<String>,
        excluded_step_ids: Vec<String>,
    },
    StepReused {
        step_id: String,
        conversation_id: Option<Uuid>,
        output_json: Option<String>,
        output_schema_digest: Option<String>,
        resolved_input_json: Option<String>,
        resolved_input_digest: Option<String>,
        execution_evidence_json: Option<String>,
        workspace_id: Option<Uuid>,
        completed_at: Option<DateTime<Utc>>,
    },
    StepReady {
        step_id: String,
        attempt: u32,
    },
    StepClaimed {
        step_id: String,
        attempt: u32,
        claim_token: Uuid,
        claim_deadline: DateTime<Utc>,
    },
    StepClaimReleased {
        step_id: String,
        attempt: u32,
    },
    StepPrepared {
        step_id: String,
        attempt: u32,
        resolved_input: BTreeMap<String, serde_json::Value>,
        resolved_input_digest: String,
        execution_evidence: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<Uuid>,
    },
    StepEvidenceRecorded {
        step_id: String,
        attempt: u32,
        evidence_digest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_evidence: Option<serde_json::Value>,
    },
    StepStarted {
        step_id: String,
        attempt: u32,
        claim_token: Uuid,
        conversation_id: Option<Uuid>,
        turn_id: Option<Uuid>,
    },
    StepTurnBound {
        step_id: String,
        attempt: u32,
        conversation_id: Uuid,
        turn_id: Uuid,
    },
    StepWaitingApproval {
        step_id: String,
        attempt: u32,
    },
    StepWaitingEvent {
        step_id: String,
        attempt: u32,
        resolved_input: serde_json::Value,
        resolved_input_digest: String,
        execution_evidence: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_at: Option<DateTime<Utc>>,
    },
    StepEventReceived {
        step_id: String,
        attempt: u32,
        event_id: String,
        event_type: String,
    },
    StepLoopIterated {
        loop_step_id: String,
        next_loop_attempt: u32,
        target_steps: Vec<(String, u32)>,
    },
    StepInteractionWaiting {
        step_id: String,
        attempt: u32,
        conversation_id: Uuid,
        turn_id: Uuid,
    },
    StepInteractionResumed {
        step_id: String,
        attempt: u32,
    },
    StepInputRequested {
        step_id: String,
        attempt: u32,
        conversation_id: Uuid,
        reason: Option<String>,
    },
    StepInputSubmitted {
        step_id: String,
        attempt: u32,
        conversation_id: Uuid,
        turn_id: Uuid,
    },
    StepOutputAccepted {
        step_id: String,
        attempt: u32,
        output: serde_json::Value,
        schema_digest: String,
    },
    StepCandidateProduced {
        step_id: String,
        attempt: u32,
        output: Option<serde_json::Value>,
        schema_digest: Option<String>,
    },
    StepCandidateAccepted {
        step_id: String,
        attempt: u32,
        principal: serde_json::Value,
    },
    StepRepairRequested {
        step_id: String,
        attempt: u32,
    },
    StepCompleted {
        step_id: String,
        attempt: u32,
    },
    StepFailed {
        step_id: String,
        attempt: u32,
        code: String,
        message: String,
    },
    StepCancelled {
        step_id: String,
        attempt: u32,
    },
    StepInterrupted {
        step_id: String,
        attempt: u32,
    },
    StepSkipped {
        step_id: String,
        attempt: u32,
    },
    StepNeedsReview {
        step_id: String,
        attempt: u32,
        reason: String,
    },
    ReviewDecided {
        step_id: String,
        from_attempt: u32,
        decision: String,
        principal: serde_json::Value,
    },
    ApprovalDecided {
        step_id: String,
        attempt: u32,
        decision: serde_json::Value,
        principal: serde_json::Value,
    },
    RunCompleted,
    RunFailed {
        code: String,
        message: String,
    },
    RunCancelled {
        reason: Option<String>,
    },
    RunPauseRequested {
        reason: Option<String>,
        principal: serde_json::Value,
    },
    RunPaused,
    RunResumed {
        principal: serde_json::Value,
    },
    RunNeedsReview {
        reason: String,
    },
}

impl WorkflowEvent {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run_started",
            Self::RunDerived { .. } => "run_derived",
            Self::StepReused { .. } => "step_reused",
            Self::StepReady { .. } => "step_ready",
            Self::StepClaimed { .. } => "step_claimed",
            Self::StepClaimReleased { .. } => "step_claim_released",
            Self::StepPrepared { .. } => "step_prepared",
            Self::StepEvidenceRecorded { .. } => "step_evidence_recorded",
            Self::StepStarted { .. } => "step_started",
            Self::StepTurnBound { .. } => "step_turn_bound",
            Self::StepWaitingApproval { .. } => "step_waiting_approval",
            Self::StepWaitingEvent { .. } => "step_waiting_event",
            Self::StepEventReceived { .. } => "step_event_received",
            Self::StepLoopIterated { .. } => "step_loop_iterated",
            Self::StepInteractionWaiting { .. } => "step_interaction_waiting",
            Self::StepInteractionResumed { .. } => "step_interaction_resumed",
            Self::StepInputRequested { .. } => "step_input_requested",
            Self::StepInputSubmitted { .. } => "step_input_submitted",
            Self::StepOutputAccepted { .. } => "step_output_accepted",
            Self::StepCandidateProduced { .. } => "step_candidate_produced",
            Self::StepCandidateAccepted { .. } => "step_candidate_accepted",
            Self::StepRepairRequested { .. } => "step_repair_requested",
            Self::StepCompleted { .. } => "step_completed",
            Self::StepFailed { .. } => "step_failed",
            Self::StepCancelled { .. } => "step_cancelled",
            Self::StepInterrupted { .. } => "step_interrupted",
            Self::StepSkipped { .. } => "step_skipped",
            Self::StepNeedsReview { .. } => "step_needs_review",
            Self::ReviewDecided { .. } => "review_decided",
            Self::ApprovalDecided { .. } => "approval_decided",
            Self::RunCompleted => "run_completed",
            Self::RunFailed { .. } => "run_failed",
            Self::RunCancelled { .. } => "run_cancelled",
            Self::RunPauseRequested { .. } => "run_pause_requested",
            Self::RunPaused => "run_paused",
            Self::RunResumed { .. } => "run_resumed",
            Self::RunNeedsReview { .. } => "run_needs_review",
        }
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowVersionView {
    pub id: Uuid,
    pub definition_id: Uuid,
    pub version: i64,
    pub digest: String,
    pub normalized_json: String,
    pub source_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowDefinitionSummary {
    pub id: Uuid,
    pub name: String,
    pub latest_version_id: Option<Uuid>,
    pub latest_version: Option<i64>,
    pub updated_at: DateTime<Utc>,
}

impl WorkflowVersionView {
    pub fn definition(&self) -> Result<WorkflowDefinition, WorkflowError> {
        serde_json::from_str(&self.normalized_json).map_err(WorkflowError::from)
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowRunView {
    pub id: Uuid,
    pub definition_version_id: Uuid,
    pub workspace_id: Uuid,
    pub status: String,
    pub control_state: String,
    pub pause_reason: Option<String>,
    pub paused_at: Option<DateTime<Utc>>,
    pub parent_run_id: Option<Uuid>,
    pub fork_step_id: Option<String>,
    pub run_mode: String,
    pub input_json: String,
    pub policy_json: String,
    pub deadline_at: DateTime<Utc>,
    pub agent_calls_started: i64,
    pub last_sequence: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl WorkflowRunView {
    pub fn typed_status(&self) -> Result<WorkflowRunStatus, WorkflowError> {
        WorkflowRunStatus::from_str(&self.status)
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowStepView {
    pub id: Uuid,
    pub run_id: Uuid,
    pub step_id: String,
    pub attempt: i64,
    pub status: String,
    pub conversation_id: Option<Uuid>,
    pub turn_id: Option<Uuid>,
    pub output_json: Option<String>,
    pub output_schema_digest: Option<String>,
    pub candidate_output_json: Option<String>,
    pub candidate_schema_digest: Option<String>,
    pub awaiting_acceptance: bool,
    pub awaiting_input: bool,
    pub execution_mode: String,
    pub resolved_input_json: Option<String>,
    pub resolved_input_digest: Option<String>,
    pub execution_evidence_json: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub waiting_interaction: bool,
    pub repair_count: i64,
    pub claim_token: Option<Uuid>,
    pub claim_deadline: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

impl WorkflowStepView {
    pub fn typed_status(&self) -> Result<WorkflowStepStatus, WorkflowError> {
        WorkflowStepStatus::from_str(&self.status)
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowEventRecord {
    pub id: Uuid,
    pub run_id: Uuid,
    pub sequence: i64,
    pub event_version: i64,
    pub event_kind: String,
    pub payload_json: String,
    pub operation_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

impl WorkflowEventRecord {
    pub fn event(&self) -> Result<WorkflowEvent, WorkflowError> {
        serde_json::from_str(&self.payload_json).map_err(WorkflowError::from)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ClaimedWorkflowStep {
    pub run: WorkflowRunView,
    pub step: WorkflowStepView,
    pub definition: WorkflowDefinition,
    pub claim_token: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ResolvedWorkflowStepInput {
    pub values: BTreeMap<String, serde_json::Value>,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DebugRunScope {
    #[default]
    Node,
    Downstream,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRetentionCandidate {
    pub run_id: Uuid,
    pub isolated_workspace_ids: Vec<Uuid>,
}

/// Snapshot of an active `WaitForEvent` Saga step suspended on incoming Pulse events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WaitingWorkflowStep {
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    pub step_id: String,
    pub attempt: u32,
    pub spec: WaitForEventStepSpec,
    pub correlation_context: serde_json::Value,
    pub timeout_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub struct WorkflowStore {
    pub(crate) pool: SqlitePool,
}

pub(crate) struct PersistWorkflowRun<'a> {
    pub workspace_id: Uuid,
    pub input: &'a serde_json::Value,
    pub policy: &'a WorkflowPolicy,
    pub operation_id: Uuid,
    pub payload_digest: &'a str,
    pub principal_json: &'a str,
    pub debug_step_id: Option<&'a str>,
    pub debug_execution_steps: Option<&'a BTreeSet<String>>,
}

pub(crate) struct PersistDerivedWorkflowRun<'a> {
    pub parent: &'a WorkflowRunView,
    pub fork_step_id: &'a str,
    pub scope: DebugRunScope,
    pub execution_modes: &'a BTreeMap<String, &'static str>,
    pub operation_id: Uuid,
    pub payload_digest: &'a str,
    pub principal_json: &'a str,
}

pub(crate) struct ImmediateTx {
    pub(crate) conn: sqlx::pool::PoolConnection<sqlx::Sqlite>,
    pub(crate) changes_at_start: i64,
}

impl std::ops::Deref for ImmediateTx {
    type Target = SqliteConnection;

    fn deref(&self) -> &Self::Target {
        &self.conn
    }
}

impl std::ops::DerefMut for ImmediateTx {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.conn
    }
}

impl WorkflowStore {
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn publish(
        &self,
        definition_id: Option<Uuid>,
        definition: &WorkflowDefinition,
        digest: &str,
        source_path: Option<&str>,
        operation_id: Uuid,
        principal_json: &str,
    ) -> Result<WorkflowVersionView, WorkflowError> {
        let normalized_json = serde_json::to_string(definition)?;
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some(existing) = sqlx::query_as::<_, WorkflowVersionView>(
                "SELECT id, definition_id, version, digest, normalized_json, source_path, created_at
                 FROM workflow_definition_versions WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?
            {
                if existing.digest != digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another definition".to_string(),
                    ));
                }
                return Ok(existing);
            }
            let definition_id = match (definition_id, source_path) {
                (Some(definition_id), _) => definition_id,
                (None, Some(source_path)) => sqlx::query_scalar::<_, Uuid>(
                    "SELECT definition_id FROM workflow_definition_versions
                     WHERE source_path = ? ORDER BY created_at DESC, version DESC LIMIT 1",
                )
                .bind(source_path)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or_else(Uuid::new_v4),
                (None, None) => Uuid::new_v4(),
            };
            if let Some((existing, publication_kind)) =
                find_version_by_digest(&mut conn, definition_id, digest).await?
            {
                if publication_kind == "debug" {
                    let version: i64 = sqlx::query_scalar(
                        "SELECT COALESCE(MAX(version), 0) + 1
                         FROM workflow_definition_versions
                         WHERE definition_id = ? AND publication_kind = 'published'",
                    )
                    .bind(definition_id)
                    .fetch_one(&mut *conn)
                    .await?;
                    return sqlx::query_as::<_, WorkflowVersionView>(
                        "UPDATE workflow_definition_versions
                         SET version = ?, publication_kind = 'published'
                         WHERE id = ?
                         RETURNING id, definition_id, version, digest, normalized_json,
                                   source_path, created_at",
                    )
                    .bind(version)
                    .bind(existing.id)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(WorkflowError::from);
                }
                return Ok(existing);
            }
            sqlx::query(
                "INSERT INTO workflow_definitions (id, name) VALUES (?, ?)
                 ON CONFLICT(id) DO NOTHING",
            )
            .bind(definition_id)
            .bind(&definition.name)
            .execute(&mut *conn)
            .await?;
            let version: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version), 0) + 1
                 FROM workflow_definition_versions
                 WHERE definition_id = ? AND publication_kind = 'published'",
            )
            .bind(definition_id)
            .fetch_one(&mut *conn)
            .await?;
            let id = Uuid::new_v4();
            sqlx::query_as::<_, WorkflowVersionView>(
                "INSERT INTO workflow_definition_versions (
                     id, definition_id, version, digest, normalized_json,
                     operation_id, payload_digest, principal_json, source_path,
                     publication_kind
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
                 RETURNING id, definition_id, version, digest, normalized_json, source_path, created_at",
            )
            .bind(id)
            .bind(definition_id)
            .bind(version)
            .bind(digest)
            .bind(normalized_json)
            .bind(operation_id)
            .bind(digest)
            .bind(principal_json)
            .bind(source_path)
            .fetch_one(&mut *conn)
            .await
            .map_err(WorkflowError::from)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn materialize_debug(
        &self,
        definition_id: Option<Uuid>,
        definition: &WorkflowDefinition,
        digest: &str,
        source_path: Option<&str>,
        operation_id: Uuid,
        principal_json: &str,
    ) -> Result<WorkflowVersionView, WorkflowError> {
        let normalized_json = serde_json::to_string(definition)?;
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some(existing) = sqlx::query_as::<_, WorkflowVersionView>(
                "SELECT id, definition_id, version, digest, normalized_json, source_path, created_at
                 FROM workflow_definition_versions WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?
            {
                if existing.digest != digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another definition".to_string(),
                    ));
                }
                return Ok(existing);
            }
            let definition_id = match (definition_id, source_path) {
                (Some(definition_id), _) => definition_id,
                (None, Some(source_path)) => sqlx::query_scalar::<_, Uuid>(
                    "SELECT definition_id FROM workflow_definition_versions
                     WHERE source_path = ? ORDER BY created_at DESC, version DESC LIMIT 1",
                )
                .bind(source_path)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or_else(Uuid::new_v4),
                (None, None) => Uuid::new_v4(),
            };
            if let Some((existing, _)) =
                find_version_by_digest(&mut conn, definition_id, digest).await?
            {
                return Ok(existing);
            }
            sqlx::query(
                "INSERT INTO workflow_definitions (id, name) VALUES (?, ?)
                 ON CONFLICT(id) DO NOTHING",
            )
            .bind(definition_id)
            .bind(&definition.name)
            .execute(&mut *conn)
            .await?;
            let version: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MIN(version), 0) - 1
                 FROM workflow_definition_versions
                 WHERE definition_id = ? AND publication_kind = 'debug'",
            )
            .bind(definition_id)
            .fetch_one(&mut *conn)
            .await?;
            let id = Uuid::new_v4();
            sqlx::query_as::<_, WorkflowVersionView>(
                "INSERT INTO workflow_definition_versions (
                     id, definition_id, version, digest, normalized_json,
                     operation_id, payload_digest, principal_json, source_path,
                     publication_kind
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'debug')
                 RETURNING id, definition_id, version, digest, normalized_json, source_path, created_at",
            )
            .bind(id)
            .bind(definition_id)
            .bind(version)
            .bind(digest)
            .bind(normalized_json)
            .bind(operation_id)
            .bind(digest)
            .bind(principal_json)
            .bind(source_path)
            .fetch_one(&mut *conn)
            .await
            .map_err(WorkflowError::from)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn version(&self, id: Uuid) -> Result<WorkflowVersionView, WorkflowError> {
        sqlx::query_as::<_, WorkflowVersionView>(
            "SELECT id, definition_id, version, digest, normalized_json, source_path, created_at
             FROM workflow_definition_versions WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| WorkflowError::NotFound(format!("workflow version {id}")))
    }

    pub async fn version_by_source_digest(
        &self,
        source_path: &str,
        digest: &str,
    ) -> Result<WorkflowVersionView, WorkflowError> {
        sqlx::query_as::<_, WorkflowVersionView>(
            "SELECT id, definition_id, version, digest, normalized_json, source_path, created_at
             FROM workflow_definition_versions
             WHERE source_path = ? AND digest = ? AND publication_kind = 'published'
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(source_path)
        .bind(digest)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            WorkflowError::NotFound(format!(
                "workflow version for source `{source_path}` and digest `{digest}`"
            ))
        })
    }

    pub async fn definitions(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, WorkflowError> {
        sqlx::query_as::<_, WorkflowDefinitionSummary>(
            "SELECT definition.id, definition.name,
                    latest.id AS latest_version_id,
                    latest.version AS latest_version,
                    MAX(definition.created_at,
                        COALESCE(latest.created_at, definition.created_at)) AS updated_at
             FROM workflow_definitions definition
             LEFT JOIN workflow_definition_versions latest
              ON latest.definition_id = definition.id
             AND latest.publication_kind = 'published'
              AND latest.version = (
                  SELECT MAX(version) FROM workflow_definition_versions
                  WHERE definition_id = definition.id
                    AND publication_kind = 'published'
              )
             WHERE latest.id IS NOT NULL
             ORDER BY updated_at DESC, definition.id
             LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 1_000)))
        .fetch_all(&self.pool)
        .await
        .map_err(WorkflowError::from)
    }

    pub async fn versions(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, WorkflowError> {
        sqlx::query_as::<_, WorkflowVersionView>(
            "SELECT id, definition_id, version, digest, normalized_json, source_path, created_at
             FROM workflow_definition_versions
             WHERE definition_id = ? AND publication_kind = 'published'
             ORDER BY version DESC LIMIT ?",
        )
        .bind(definition_id)
        .bind(i64::from(limit.clamp(1, 1_000)))
        .fetch_all(&self.pool)
        .await
        .map_err(WorkflowError::from)
    }

    pub async fn run(&self, run_id: Uuid) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.pool.acquire().await?;
        find_run(&mut conn, run_id).await
    }

    pub async fn runs_awaiting_dispatch(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowRunView>, WorkflowError> {
        sqlx::query_as::<_, WorkflowRunView>(
            "SELECT id, definition_version_id, workspace_id, status, control_state,
                    pause_reason, paused_at, parent_run_id, fork_step_id, run_mode,
                    input_json, policy_json,
                    deadline_at, agent_calls_started, last_sequence, created_at, updated_at
             FROM workflow_runs
             WHERE status = 'running' AND dispatch_ready = 0
             ORDER BY created_at, id LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 1_000)))
        .fetch_all(&self.pool)
        .await
        .map_err(WorkflowError::from)
    }

    pub async fn enable_dispatch(&self, run_id: Uuid) -> Result<(), WorkflowError> {
        let updated = sqlx::query(
            "UPDATE workflow_runs SET dispatch_ready = 1,
                    updated_at = datetime('now', 'subsec') WHERE id = ?",
        )
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(WorkflowError::NotFound(format!("workflow run {run_id}")));
        }
        crate::wake::notify_workflow_work();
        Ok(())
    }

    pub async fn steps(&self, run_id: Uuid) -> Result<Vec<WorkflowStepView>, WorkflowError> {
        sqlx::query_as::<_, WorkflowStepView>(
            "SELECT id, run_id, step_id, attempt, status, conversation_id, turn_id,
                    output_json, output_schema_digest, candidate_output_json,
                    candidate_schema_digest, awaiting_acceptance, awaiting_input, execution_mode,
                    resolved_input_json,
                    resolved_input_digest, execution_evidence_json,
                    workspace_id, waiting_interaction,
                    repair_count, claim_token, claim_deadline,
                    started_at, completed_at, updated_at
             FROM workflow_step_runs WHERE run_id = ? ORDER BY step_id, attempt",
        )
        .bind(run_id)
        .fetch_all(&self.pool)
        .await
        .map_err(WorkflowError::from)
    }

    pub async fn events_since(
        &self,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, WorkflowError> {
        sqlx::query_as::<_, WorkflowEventRecord>(
            "SELECT id, run_id, sequence, event_version, event_kind, payload_json,
                    operation_id, created_at
             FROM workflow_events
             WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
        )
        .bind(run_id)
        .bind(after_sequence)
        .bind(limit.clamp(1, 10_000))
        .fetch_all(&self.pool)
        .await
        .map_err(WorkflowError::from)
    }

    pub async fn cleanup_terminal_before(
        &self,
        cutoff: DateTime<Utc>,
        limit: u32,
    ) -> Result<Vec<Uuid>, WorkflowError> {
        let candidates = self.retention_candidates(cutoff, limit).await?;
        let mut deleted = Vec::new();
        for candidate in candidates {
            if self.cleanup_terminal_run(candidate.run_id, cutoff).await? {
                deleted.push(candidate.run_id);
            }
        }
        Ok(deleted)
    }

    pub async fn retention_candidates(
        &self,
        cutoff: DateTime<Utc>,
        limit: u32,
    ) -> Result<Vec<WorkflowRetentionCandidate>, WorkflowError> {
        let run_ids = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM workflow_runs
             WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
               AND updated_at <= ?
             ORDER BY updated_at, id LIMIT ?",
        )
        .bind(cutoff)
        .bind(i64::from(limit.clamp(1, 1_000)))
        .fetch_all(&self.pool)
        .await?;
        let mut candidates = Vec::with_capacity(run_ids.len());
        for run_id in run_ids {
            let isolated_workspace_ids = sqlx::query_scalar::<_, Uuid>(
                "SELECT DISTINCT workspace_id FROM workflow_step_runs
                 WHERE run_id = ? AND workspace_id IS NOT NULL
                   AND workspace_id <> (SELECT workspace_id FROM workflow_runs WHERE id = ?)
                   AND NOT EXISTS (
                       SELECT 1 FROM workflow_runs other_run
                       WHERE other_run.id <> ?
                         AND other_run.workspace_id = workflow_step_runs.workspace_id
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM workflow_step_runs other_step
                       WHERE other_step.run_id <> ?
                         AND other_step.workspace_id = workflow_step_runs.workspace_id
                   )
                 ORDER BY workspace_id",
            )
            .bind(run_id)
            .bind(run_id)
            .bind(run_id)
            .bind(run_id)
            .fetch_all(&self.pool)
            .await?;
            candidates.push(WorkflowRetentionCandidate {
                run_id,
                isolated_workspace_ids,
            });
        }
        Ok(candidates)
    }

    pub async fn cleanup_terminal_run(
        &self,
        run_id: Uuid,
        cutoff: DateTime<Utc>,
    ) -> Result<bool, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let eligible: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM workflow_runs
                    WHERE id = ?
                      AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
                      AND updated_at <= ?
                 )",
            )
            .bind(run_id)
            .bind(cutoff)
            .fetch_one(&mut *conn)
            .await?;
            if !eligible {
                return Ok(false);
            }
            let now = Utc::now();
            sqlx::query(
                "UPDATE sessions SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
                 WHERE id = ? OR id IN (
                     SELECT child_conversation_id FROM conversation_relations
                     WHERE parent_conversation_id = ? AND kind = 'workflow_step'
                 )",
            )
            .bind(now)
            .bind(now)
            .bind(run_id)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "DELETE FROM conversation_relations
                 WHERE parent_conversation_id = ? AND kind = 'workflow_step'",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            let deleted = sqlx::query("DELETE FROM workflow_runs WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            Ok(deleted.rows_affected() == 1)
        }
        .await;
        self.finish(conn, result).await
    }

    pub(crate) async fn begin_immediate(&self) -> Result<ImmediateTx, WorkflowError> {
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let changes_at_start: i64 = sqlx::query_scalar("SELECT total_changes()")
            .fetch_one(&mut *conn)
            .await?;
        Ok(ImmediateTx {
            conn,
            changes_at_start,
        })
    }

    pub(crate) async fn finish<T>(
        &self,
        mut tx: ImmediateTx,
        result: Result<T, WorkflowError>,
    ) -> Result<T, WorkflowError> {
        match result {
            Ok(value) => {
                let wrote = sqlx::query_scalar::<_, i64>("SELECT total_changes()")
                    .fetch_one(&mut *tx.conn)
                    .await
                    .map(|changes_now| changes_now != tx.changes_at_start)
                    .unwrap_or(true);
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *tx.conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *tx.conn).await;
                    return Err(error.into());
                }
                if wrote {
                    crate::wake::notify_workflow_work();
                }
                Ok(value)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *tx.conn).await;
                Err(error)
            }
        }
    }
}

pub(crate) async fn find_version_by_digest(
    connection: &mut SqliteConnection,
    definition_id: Uuid,
    digest: &str,
) -> Result<Option<(WorkflowVersionView, String)>, WorkflowError> {
    let row = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, publication_kind FROM workflow_definition_versions
         WHERE definition_id = ? AND digest = ?",
    )
    .bind(definition_id)
    .bind(digest)
    .fetch_optional(&mut *connection)
    .await?;
    let Some((id, publication_kind)) = row else {
        return Ok(None);
    };
    Ok(Some((
        version_on_connection(connection, id).await?,
        publication_kind,
    )))
}

pub(crate) async fn find_run(
    conn: &mut SqliteConnection,
    run_id: Uuid,
) -> Result<WorkflowRunView, WorkflowError> {
    sqlx::query_as::<_, WorkflowRunView>(
        "SELECT id, definition_version_id, workspace_id, status, control_state,
                pause_reason, paused_at, parent_run_id, fork_step_id, run_mode,
                input_json, policy_json,
                deadline_at, agent_calls_started, last_sequence, created_at, updated_at
         FROM workflow_runs WHERE id = ?",
    )
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| WorkflowError::NotFound(format!("workflow run {run_id}")))
}

pub(crate) async fn find_run_by_operation(
    conn: &mut SqliteConnection,
    operation_id: Uuid,
) -> Result<Option<WorkflowRunView>, WorkflowError> {
    sqlx::query_as::<_, WorkflowRunView>(
        "SELECT id, definition_version_id, workspace_id, status, control_state,
                pause_reason, paused_at, parent_run_id, fork_step_id, run_mode,
                input_json, policy_json,
                deadline_at, agent_calls_started, last_sequence, created_at, updated_at
         FROM workflow_runs WHERE operation_id = ?",
    )
    .bind(operation_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(WorkflowError::from)
}

pub(crate) async fn find_step(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    step_id: &str,
    attempt: i64,
) -> Result<WorkflowStepView, WorkflowError> {
    sqlx::query_as::<_, WorkflowStepView>(
        "SELECT id, run_id, step_id, attempt, status, conversation_id, turn_id,
                output_json, output_schema_digest, candidate_output_json,
                candidate_schema_digest, awaiting_acceptance, awaiting_input, execution_mode,
                resolved_input_json,
                resolved_input_digest, execution_evidence_json,
                workspace_id, waiting_interaction,
                repair_count, claim_token, claim_deadline,
                started_at, completed_at, updated_at
         FROM workflow_step_runs WHERE run_id = ? AND step_id = ? AND attempt = ?",
    )
    .bind(run_id)
    .bind(step_id)
    .bind(attempt)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {run_id}/{step_id}/{attempt}")))
}

pub(crate) async fn find_latest_step(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    step_id: &str,
) -> Result<WorkflowStepView, WorkflowError> {
    sqlx::query_as::<_, WorkflowStepView>(
        "SELECT id, run_id, step_id, attempt, status, conversation_id, turn_id,
                output_json, output_schema_digest, candidate_output_json,
                candidate_schema_digest, awaiting_acceptance, awaiting_input, execution_mode,
                resolved_input_json,
                resolved_input_digest, execution_evidence_json,
                workspace_id, waiting_interaction,
                repair_count, claim_token, claim_deadline,
                started_at, completed_at, updated_at
         FROM workflow_step_runs WHERE run_id = ? AND step_id = ?
         ORDER BY attempt DESC LIMIT 1",
    )
    .bind(run_id)
    .bind(step_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {run_id}/{step_id}")))
}

pub(crate) async fn find_step_by_claim(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    step_id: &str,
    claim_token: Uuid,
) -> Result<WorkflowStepView, WorkflowError> {
    sqlx::query_as::<_, WorkflowStepView>(
        "SELECT id, run_id, step_id, attempt, status, conversation_id, turn_id,
                output_json, output_schema_digest, candidate_output_json,
                candidate_schema_digest, awaiting_acceptance, awaiting_input, execution_mode,
                resolved_input_json,
                resolved_input_digest, execution_evidence_json,
                workspace_id, waiting_interaction,
                repair_count, claim_token, claim_deadline,
                started_at, completed_at, updated_at
         FROM workflow_step_runs
         WHERE run_id = ? AND step_id = ? AND claim_token = ?",
    )
    .bind(run_id)
    .bind(step_id)
    .bind(claim_token)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| WorkflowError::Conflict("workflow step claim disappeared".to_string()))
}

pub(crate) async fn version_on_connection(
    conn: &mut SqliteConnection,
    id: Uuid,
) -> Result<WorkflowVersionView, WorkflowError> {
    sqlx::query_as::<_, WorkflowVersionView>(
        "SELECT id, definition_id, version, digest, normalized_json, source_path, created_at
         FROM workflow_definition_versions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| WorkflowError::NotFound(format!("workflow version {id}")))
}

pub(crate) fn is_terminal_run(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

pub(crate) fn rebase_reused_execution_evidence(
    evidence_json: &str,
    active_definition_digest: &str,
) -> Result<String, WorkflowError> {
    let mut evidence = serde_json::from_str::<serde_json::Value>(evidence_json)?;
    let object = evidence.as_object_mut().ok_or_else(|| {
        WorkflowError::Projection("workflow execution evidence must be an object".to_string())
    })?;
    if let Some(parent_digest) = object
        .insert(
            "definitionDigest".to_string(),
            serde_json::Value::String(active_definition_digest.to_string()),
        )
        .and_then(|value| value.as_str().map(str::to_string))
    {
        object.insert(
            "reusedFromDefinitionDigest".to_string(),
            serde_json::Value::String(parent_digest),
        );
    }
    serde_json::to_string(&evidence).map_err(WorkflowError::from)
}

pub(crate) fn select_pointer<'a>(
    value: &'a serde_json::Value,
    pointer: &str,
) -> Option<&'a serde_json::Value> {
    if pointer.is_empty() {
        Some(value)
    } else {
        value.pointer(pointer)
    }
}
