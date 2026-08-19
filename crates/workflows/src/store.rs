use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Row, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    WorkflowBinding, WorkflowDefinition, WorkflowError, WorkflowPolicy, WorkflowStep,
    WorkflowStepSpec, spec::deterministic_order,
};

const EVENT_VERSION: i64 = 2;

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
    fn kind(&self) -> &'static str {
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

#[derive(Clone)]
pub struct WorkflowStore {
    pool: SqlitePool,
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

    pub(crate) async fn start(
        &self,
        version: &WorkflowVersionView,
        request: PersistWorkflowRun<'_>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let definition = version.definition()?;
        let deadline_at = Utc::now() + Duration::seconds(request.policy.deadline_seconds as i64);
        let input_json = serde_json::to_string(request.input)?;
        let policy_json = serde_json::to_string(request.policy)?;
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some(existing) = find_run_by_operation(&mut conn, request.operation_id).await? {
                let existing_digest: String =
                    sqlx::query_scalar("SELECT payload_digest FROM workflow_runs WHERE id = ?")
                        .bind(existing.id)
                        .fetch_one(&mut *conn)
                        .await?;
                if existing_digest != request.payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another workflow run".to_string(),
                    ));
                }
                return Ok(existing);
            }
            let run_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO workflow_runs (
                     id, definition_version_id, workspace_id, status, input_json, policy_json,
                     operation_id, payload_digest, principal_json, deadline_at,
                     fork_step_id, run_mode
                 ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(run_id)
            .bind(version.id)
            .bind(request.workspace_id)
            .bind(&input_json)
            .bind(&policy_json)
            .bind(request.operation_id)
            .bind(request.payload_digest)
            .bind(request.principal_json)
            .bind(deadline_at)
            .bind(request.debug_step_id)
            .bind(request.debug_step_id.map_or("standard", |_| "debug_node"))
            .execute(&mut *conn)
            .await?;
            let ordered = deterministic_order(&definition)?;
            for step_id in &ordered {
                let excluded = request
                    .debug_execution_steps
                    .is_some_and(|steps| !steps.contains(step_id));
                if excluded {
                    sqlx::query(
                        "INSERT INTO workflow_step_runs (
                             id, run_id, step_id, attempt, status, completed_at, execution_mode
                         ) VALUES (?, ?, ?, 1, 'skipped', ?, 'exclude')",
                    )
                    .bind(Uuid::new_v4())
                    .bind(run_id)
                    .bind(step_id)
                    .bind(Utc::now())
                    .execute(&mut *conn)
                    .await?;
                } else {
                    sqlx::query(
                        "INSERT INTO workflow_step_runs (
                             id, run_id, step_id, attempt, status, execution_mode
                         ) VALUES (?, ?, ?, 1, 'pending', 'execute')",
                    )
                    .bind(Uuid::new_v4())
                    .bind(run_id)
                    .bind(step_id)
                    .execute(&mut *conn)
                    .await?;
                }
            }
            append_event(
                &mut conn,
                run_id,
                Some(request.operation_id),
                &WorkflowEvent::RunStarted {
                    definition_version_id: version.id,
                    step_ids: ordered.clone(),
                    input: request.input.clone(),
                    policy: request.policy.clone(),
                    deadline_at,
                },
            )
            .await?;
            if request.debug_execution_steps.is_some() {
                for step_id in &ordered {
                    if request
                        .debug_execution_steps
                        .is_some_and(|steps| !steps.contains(step_id))
                    {
                        append_event(
                            &mut conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepSkipped {
                                step_id: step_id.clone(),
                                attempt: 1,
                            },
                        )
                        .await?;
                    }
                }
            }
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub(crate) async fn start_derived(
        &self,
        version: &WorkflowVersionView,
        request: PersistDerivedWorkflowRun<'_>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let definition = version.definition()?;
        let input: serde_json::Value = serde_json::from_str(&request.parent.input_json)?;
        let policy: WorkflowPolicy = serde_json::from_str(&request.parent.policy_json)?;
        let deadline_at = Utc::now() + Duration::seconds(policy.deadline_seconds as i64);
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some(existing) = find_run_by_operation(&mut conn, request.operation_id).await? {
                let existing_digest: String =
                    sqlx::query_scalar("SELECT payload_digest FROM workflow_runs WHERE id = ?")
                        .bind(existing.id)
                        .fetch_one(&mut *conn)
                        .await?;
                if existing_digest != request.payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another derived Run".to_string(),
                    ));
                }
                return Ok(existing);
            }
            let run_id = Uuid::new_v4();
            let run_mode = match request.scope {
                DebugRunScope::Node => "debug_node",
                DebugRunScope::Downstream => "debug_downstream",
            };
            sqlx::query(
                "INSERT INTO workflow_runs (
                     id, definition_version_id, workspace_id, status, input_json, policy_json,
                     operation_id, payload_digest, principal_json, deadline_at,
                     parent_run_id, fork_step_id, run_mode
                 ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(run_id)
            .bind(version.id)
            .bind(request.parent.workspace_id)
            .bind(&request.parent.input_json)
            .bind(&request.parent.policy_json)
            .bind(request.operation_id)
            .bind(request.payload_digest)
            .bind(request.principal_json)
            .bind(deadline_at)
            .bind(request.parent.id)
            .bind(request.fork_step_id)
            .bind(run_mode)
            .execute(&mut *conn)
            .await?;
            let ordered = deterministic_order(&definition)?;
            append_event(
                &mut conn,
                run_id,
                Some(request.operation_id),
                &WorkflowEvent::RunStarted {
                    definition_version_id: version.id,
                    step_ids: ordered.clone(),
                    input,
                    policy: policy.clone(),
                    deadline_at,
                },
            )
            .await?;
            let mut reused = Vec::new();
            let mut excluded = Vec::new();
            for step_id in &ordered {
                let mode = request
                    .execution_modes
                    .get(step_id)
                    .copied()
                    .unwrap_or("exclude");
                match mode {
                    "reuse" => {
                        let parent_step =
                            find_latest_step(&mut conn, request.parent.id, step_id).await?;
                        if parent_step.status != "completed" {
                            return Err(WorkflowError::Conflict(format!(
                                "step `{step_id}` cannot be reused from {}",
                                parent_step.status
                            )));
                        }
                        let execution_evidence_json = parent_step
                            .execution_evidence_json
                            .as_deref()
                            .map(|evidence| {
                                rebase_reused_execution_evidence(evidence, &version.digest)
                            })
                            .transpose()?;
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                id, run_id, step_id, attempt, status, conversation_id,
                                output_json, output_schema_digest, resolved_input_json,
                                resolved_input_digest, execution_evidence_json, workspace_id,
                                completed_at, execution_mode
                             ) VALUES (?, ?, ?, 1, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, 'reuse')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(step_id)
                        .bind(parent_step.conversation_id)
                        .bind(&parent_step.output_json)
                        .bind(&parent_step.output_schema_digest)
                        .bind(&parent_step.resolved_input_json)
                        .bind(&parent_step.resolved_input_digest)
                        .bind(&execution_evidence_json)
                        .bind(parent_step.workspace_id)
                        .bind(parent_step.completed_at)
                        .execute(&mut *conn)
                        .await?;
                        append_event(
                            &mut conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepReused {
                                step_id: step_id.clone(),
                                conversation_id: parent_step.conversation_id,
                                output_json: parent_step.output_json,
                                output_schema_digest: parent_step.output_schema_digest,
                                resolved_input_json: parent_step.resolved_input_json,
                                resolved_input_digest: parent_step.resolved_input_digest,
                                execution_evidence_json,
                                workspace_id: parent_step.workspace_id,
                                completed_at: parent_step.completed_at,
                            },
                        )
                        .await?;
                        reused.push(step_id.clone());
                    }
                    "execute" => {
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                id, run_id, step_id, attempt, status, execution_mode
                             ) VALUES (?, ?, ?, 1, 'pending', 'execute')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(step_id)
                        .execute(&mut *conn)
                        .await?;
                    }
                    _ => {
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                id, run_id, step_id, attempt, status, completed_at, execution_mode
                             ) VALUES (?, ?, ?, 1, 'skipped', ?, 'exclude')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(step_id)
                        .bind(Utc::now())
                        .execute(&mut *conn)
                        .await?;
                        append_event(
                            &mut conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepSkipped {
                                step_id: step_id.clone(),
                                attempt: 1,
                            },
                        )
                        .await?;
                        excluded.push(step_id.clone());
                    }
                }
            }
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::RunDerived {
                    parent_run_id: request.parent.id,
                    fork_step_id: request.fork_step_id.to_string(),
                    run_mode: request.scope,
                    reused_step_ids: reused,
                    excluded_step_ids: excluded,
                },
            )
            .await?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn run(&self, run_id: Uuid) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.pool.acquire().await?;
        find_run(&mut conn, run_id).await
    }

    /// Runs persisted before the Application layer finished creating their
    /// execution shell. Startup reconciliation completes this preflight rather
    /// than leaving the Run permanently undispatchable.
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

    /// Delete only old terminal Runs and soft-delete their hidden execution
    /// Conversations. Running, waiting, and needs-review Runs are never eligible.
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
                 ORDER BY workspace_id",
            )
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

    /// Resolve a ready step's bindings exclusively from immutable Run input and
    /// accepted outputs of completed dependency attempts.
    pub async fn resolve_step_input(
        &self,
        run_id: Uuid,
        step: &WorkflowStep,
    ) -> Result<ResolvedWorkflowStepInput, WorkflowError> {
        let run = self.run(run_id).await?;
        let run_input: serde_json::Value = serde_json::from_str(&run.input_json)?;
        let mut values = BTreeMap::new();
        for dependency in &step.depends_on {
            let output_json: Option<String> = sqlx::query_scalar(
                "SELECT output_json FROM workflow_step_runs
                 WHERE run_id = ? AND step_id = ? AND status = 'completed'
                   AND output_json IS NOT NULL
                 ORDER BY attempt DESC LIMIT 1",
            )
            .bind(run_id)
            .bind(dependency)
            .fetch_optional(&self.pool)
            .await?;
            let output_json = output_json.ok_or_else(|| {
                WorkflowError::Conflict(format!(
                    "dependency step `{dependency}` has no accepted output"
                ))
            })?;
            values.insert(
                dependency.clone(),
                serde_json::from_str::<serde_json::Value>(&output_json)?,
            );
        }
        for (name, binding) in &step.input_bindings {
            let (source, pointer) = match binding {
                WorkflowBinding::RunInput { pointer } => (&run_input, pointer.as_str()),
                WorkflowBinding::StepOutput { step_id, pointer } => {
                    let output_json: Option<String> = sqlx::query_scalar(
                        "SELECT output_json FROM workflow_step_runs
                         WHERE run_id = ? AND step_id = ? AND status = 'completed'
                           AND output_json IS NOT NULL
                         ORDER BY attempt DESC LIMIT 1",
                    )
                    .bind(run_id)
                    .bind(step_id)
                    .fetch_optional(&self.pool)
                    .await?;
                    let output_json = output_json.ok_or_else(|| {
                        WorkflowError::Conflict(format!(
                            "step `{}` has no accepted output for binding `{name}`",
                            step_id
                        ))
                    })?;
                    let output = serde_json::from_str::<serde_json::Value>(&output_json)?;
                    let selected = select_pointer(&output, pointer).ok_or_else(|| {
                        WorkflowError::Validation(format!(
                            "binding `{name}` pointer `{pointer}` does not exist in step `{step_id}` output"
                        ))
                    })?;
                    values.insert(name.clone(), selected.clone());
                    continue;
                }
            };
            let selected = select_pointer(source, pointer).ok_or_else(|| {
                WorkflowError::Validation(format!(
                    "binding `{name}` pointer `{pointer}` does not exist in Run input"
                ))
            })?;
            values.insert(name.clone(), selected.clone());
        }
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&values)?));
        Ok(ResolvedWorkflowStepInput { values, digest })
    }

    pub async fn prepare_step(
        &self,
        run_id: Uuid,
        step: &WorkflowStep,
        claim_token: Uuid,
        resolved: &ResolvedWorkflowStepInput,
        workspace_id: Uuid,
        workspace_evidence: &serde_json::Value,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let run = self.run(run_id).await?;
        let version = self.version(run.definition_version_id).await?;
        let execution_evidence = match &step.spec {
            WorkflowStepSpec::Agent(agent) => serde_json::json!({
                "definitionDigest": version.digest,
                "resolvedInputDigest": resolved.digest,
                "agentId": agent.agent_id,
                "workspaceAccess": agent.workspace_access,
                "sideEffectClass": agent.side_effect_class,
                "runtimeVersion": { "available": false },
                "toolSetDigest": { "available": false },
                "workspaceCheckpoint": { "available": false },
                "workspace": workspace_evidence,
            }),
            WorkflowStepSpec::Approval(_) | WorkflowStepSpec::Notify(_) => {
                return Err(WorkflowError::Conflict(
                    "approval and notify steps do not have Agent execution evidence".to_string(),
                ));
            }
        };
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step_run = find_step_by_claim(&mut conn, run_id, &step.id, claim_token).await?;
            if let Some(existing_digest) = step_run.resolved_input_digest.as_deref() {
                if existing_digest != resolved.digest || step_run.workspace_id != Some(workspace_id)
                {
                    return Err(WorkflowError::Conflict(format!(
                        "step `{}` preparation evidence changed for the same attempt",
                        step.id
                    )));
                }
                return Ok(step_run);
            }
            let input_json = serde_json::to_string(&resolved.values)?;
            let evidence_json = serde_json::to_string(&execution_evidence)?;
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET resolved_input_json = ?, resolved_input_digest = ?,
                     execution_evidence_json = ?, workspace_id = ?,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?
                   AND status = 'claimed' AND claim_token = ?",
            )
            .bind(input_json)
            .bind(&resolved.digest)
            .bind(evidence_json)
            .bind(workspace_id)
            .bind(run_id)
            .bind(&step.id)
            .bind(step_run.attempt)
            .bind(claim_token)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepPrepared {
                    step_id: step.id.clone(),
                    attempt: step_run.attempt as u32,
                    resolved_input: resolved.values.clone(),
                    resolved_input_digest: resolved.digest.clone(),
                    execution_evidence,
                    workspace_id: Some(workspace_id),
                },
            )
            .await?;
            find_step(&mut conn, run_id, &step.id, step_run.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn record_step_artifacts(
        &self,
        run_id: Uuid,
        step_id: &str,
        artifacts: &serde_json::Value,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let run = find_run(&mut conn, run_id).await?;
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let mut evidence = step
                .execution_evidence_json
                .as_deref()
                .map(serde_json::from_str::<serde_json::Value>)
                .transpose()?
                .unwrap_or_else(|| serde_json::json!({}));
            let evidence = evidence.as_object_mut().ok_or_else(|| {
                WorkflowError::Conflict(format!(
                    "workflow step `{step_id}` has invalid execution evidence"
                ))
            })?;
            let history = evidence
                .entry("artifactHistory")
                .or_insert_with(|| serde_json::json!([]));
            if let Some(history) = history.as_array_mut()
                && !history.contains(artifacts)
            {
                history.push(artifacts.clone());
            }
            let execution_evidence = serde_json::Value::Object(evidence.clone());
            let evidence_json = serde_json::to_string(&execution_evidence)?;
            if evidence_json.len() > policy.max_output_bytes {
                return Err(WorkflowError::Validation(format!(
                    "step evidence exceeds {} bytes",
                    policy.max_output_bytes
                )));
            }
            let evidence_digest = format!("{:x}", Sha256::digest(evidence_json.as_bytes()));
            sqlx::query(
                "UPDATE workflow_step_runs SET execution_evidence_json = ?,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(evidence_json)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepEvidenceRecorded {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    evidence_digest,
                    execution_evidence: Some(execution_evidence),
                },
            )
            .await?;
            find_step(&mut conn, run_id, step_id, step.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn claim_ready(
        &self,
        global_limit: u32,
        claim_ttl: Duration,
    ) -> Result<Option<ClaimedWorkflowStep>, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            recover_stale_claims(&mut conn, Utc::now()).await?;
            let global_active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM workflow_step_runs
                 WHERE status IN ('claimed', 'running')",
            )
            .fetch_one(&mut *conn)
            .await?;
            if global_active >= i64::from(global_limit.max(1)) {
                return Ok(None);
            }
            let candidates = sqlx::query(
                "SELECT ready.run_id, ready.step_id, ready.attempt
                 FROM workflow_ready_steps ready
                 JOIN workflow_runs run ON run.id = ready.run_id
                 WHERE ready.status = 'ready' AND run.status IN ('running', 'waiting')
                   AND run.control_state = 'active'
                   AND run.deadline_at > ?
                   AND run.dispatch_ready = 1
                 ORDER BY ready.ready_sequence, ready.run_id, ready.step_id
                 LIMIT 100",
            )
            .bind(Utc::now())
            .fetch_all(&mut *conn)
            .await?;
            for candidate in candidates {
                let run_id: Uuid = candidate.try_get("run_id")?;
                let step_id: String = candidate.try_get("step_id")?;
                let attempt: i64 = candidate.try_get("attempt")?;
                let run = find_run(&mut conn, run_id).await?;
                let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
                let active: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM workflow_step_runs
                     WHERE run_id = ? AND status IN ('claimed', 'running')",
                )
                .bind(run_id)
                .fetch_one(&mut *conn)
                .await?;
                if active >= i64::from(policy.max_concurrent_agent_steps)
                    || run.agent_calls_started >= i64::from(policy.max_agent_calls)
                {
                    continue;
                }
                let version = version_on_connection(&mut conn, run.definition_version_id).await?;
                let definition = version.definition()?;
                let definition_step = definition
                    .steps
                    .iter()
                    .find(|step| step.id == step_id)
                    .ok_or_else(|| {
                        WorkflowError::Projection(format!(
                            "workflow step `{step_id}` is missing from its definition"
                        ))
                    })?;
                let requires_shared_workspace_lease = matches!(
                    &definition_step.spec,
                    WorkflowStepSpec::Agent(agent)
                        if matches!(
                            agent.workspace_access,
                            crate::WorkspaceAccess::ReadOnlyShared
                                | crate::WorkspaceAccess::WriteSerialized
                        )
                );
                if requires_shared_workspace_lease {
                    // Session transports do not yet expose a portable,
                    // negotiated read-only filesystem capability. Shared
                    // read-only claims therefore serialize with unknown writers.
                    let workspace_active: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*)
                         FROM workflow_step_runs step
                         JOIN workflow_runs active_run ON active_run.id = step.run_id
                         WHERE active_run.workspace_id = ?
                           AND step.status IN ('claimed', 'running')",
                    )
                    .bind(run.workspace_id)
                    .fetch_one(&mut *conn)
                    .await?;
                    if workspace_active > 0 {
                        continue;
                    }
                }
                let claim_token = Uuid::new_v4();
                let claim_deadline = Utc::now() + claim_ttl;
                let updated = sqlx::query(
                    "UPDATE workflow_ready_steps
                     SET status = 'claimed', claim_token = ?, claim_deadline = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'ready'",
                )
                .bind(claim_token)
                .bind(claim_deadline)
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                if updated.rows_affected() != 1 {
                    continue;
                }
                sqlx::query(
                    "UPDATE workflow_step_runs
                     SET status = 'claimed', claim_token = ?, claim_deadline = ?,
                         updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'ready'",
                )
                .bind(claim_token)
                .bind(claim_deadline)
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepClaimed {
                        step_id: step_id.clone(),
                        attempt: attempt as u32,
                        claim_token,
                        claim_deadline,
                    },
                )
                .await?;
                let step = find_step(&mut conn, run_id, &step_id, attempt).await?;
                return Ok(Some(ClaimedWorkflowStep {
                    run,
                    step,
                    definition,
                    claim_token,
                }));
            }
            Ok(None)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn mark_started(
        &self,
        run_id: Uuid,
        step_id: &str,
        claim_token: Uuid,
        conversation_id: Option<Uuid>,
        turn_id: Option<Uuid>,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let updated = sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'running', conversation_id = ?, turn_id = ?, started_at = ?,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ?
                   AND status = 'claimed' AND claim_token = ?",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(claim_token)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(WorkflowError::Conflict(
                    "workflow step claim is stale or no longer owned".to_string(),
                ));
            }
            // A ready-row lease only owns preflight. Once execution is running it
            // must not survive long enough for stale-claim recovery to emit a
            // misleading release or make the same node reclaimable.
            sqlx::query(
                "DELETE FROM workflow_ready_steps
                 WHERE run_id = ? AND step_id = ? AND claim_token = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(claim_token)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1,
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            let step = find_step_by_claim(&mut conn, run_id, step_id, claim_token).await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepStarted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    claim_token,
                    conversation_id,
                    turn_id,
                },
            )
            .await?;
            Ok(step)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn bind_turn(
        &self,
        run_id: Uuid,
        step_id: &str,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let updated = sqlx::query(
                "UPDATE workflow_step_runs SET conversation_id = ?, turn_id = ?,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(WorkflowError::Conflict(format!(
                    "workflow step `{step_id}` is no longer running"
                )));
            }
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepTurnBound {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    conversation_id,
                    turn_id,
                },
            )
            .await?;
            find_step(&mut conn, run_id, step_id, step.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn set_step_awaiting_input(
        &self,
        run_id: Uuid,
        step_id: &str,
        awaiting: bool,
        reason: Option<&str>,
        submitted_turn_id: Option<Uuid>,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` cannot change input state from {}",
                    step.status
                )));
            }
            let conversation_id = step.conversation_id.ok_or_else(|| {
                WorkflowError::Conflict(format!("step `{step_id}` has no child Conversation"))
            })?;
            if step.awaiting_input == awaiting {
                return Ok(step);
            }
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_input = ?,
                        turn_id = CASE WHEN ? THEN NULL ELSE turn_id END,
                        user_intervened = CASE WHEN ? THEN user_intervened ELSE 1 END,
                        waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(awaiting)
            .bind(awaiting)
            .bind(awaiting)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            if awaiting {
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInputRequested {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        conversation_id,
                        reason: reason.map(str::to_string),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_runs SET status = 'waiting',
                            updated_at = datetime('now', 'subsec')
                     WHERE id = ? AND status = 'running'",
                )
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            } else {
                let turn_id = submitted_turn_id.ok_or_else(|| {
                    WorkflowError::Validation(
                        "resuming a step requires the submitted Turn id".to_string(),
                    )
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInputSubmitted {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        conversation_id,
                        turn_id,
                    },
                )
                .await?;
                restore_running_if_not_waiting(&mut conn, run_id).await?;
            }
            find_step(&mut conn, run_id, step_id, step.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    /// Project only the existence of a child Conversation interaction. The
    /// permission/question payload remains exclusively in the Conversation log.
    pub async fn set_interaction_waiting(
        &self,
        run_id: Uuid,
        step_id: &str,
        waiting: bool,
    ) -> Result<bool, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" || step.waiting_interaction == waiting {
                return Ok(false);
            }
            let updated = sqlx::query(
                "UPDATE workflow_step_runs SET waiting_interaction = ?,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(waiting)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Ok(false);
            }
            if waiting {
                let conversation_id = step.conversation_id.ok_or_else(|| {
                    WorkflowError::Projection("waiting step has no child Conversation".to_string())
                })?;
                let turn_id = step.turn_id.ok_or_else(|| {
                    WorkflowError::Projection("waiting step has no active Turn".to_string())
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInteractionWaiting {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        conversation_id,
                        turn_id,
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_runs SET status = 'waiting',
                            updated_at = datetime('now', 'subsec')
                     WHERE id = ? AND status = 'running'",
                )
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            } else {
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInteractionResumed {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                    },
                )
                .await?;
                restore_running_if_not_waiting(&mut conn, run_id).await?;
            }
            Ok(true)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn begin_repair(&self, run_id: Uuid, step_id: &str) -> Result<bool, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let run = find_run(&mut conn, run_id).await?;
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            if run.agent_calls_started >= i64::from(policy.max_agent_calls) {
                return Ok(false);
            }
            let updated = sqlx::query(
                "UPDATE workflow_step_runs SET repair_count = repair_count + 1,
                        turn_id = NULL, updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ?
                   AND attempt = (SELECT MAX(attempt) FROM workflow_step_runs
                                  WHERE run_id = ? AND step_id = ?)
                   AND status = 'running' AND repair_count = 0",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(run_id)
            .bind(step_id)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Ok(false);
            }
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1,
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            let attempt: i64 = sqlx::query_scalar(
                "SELECT MAX(attempt) FROM workflow_step_runs WHERE run_id = ? AND step_id = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .fetch_one(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepRepairRequested {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            Ok(true)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn complete_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        output: Option<&serde_json::Value>,
        schema_digest: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            if step.status == "completed" {
                return find_run(&mut conn, run_id).await;
            }
            if step.awaiting_acceptance {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` has a candidate output awaiting acceptance"
                )));
            }
            if !matches!(step.status.as_str(), "running" | "waiting_approval") {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` cannot complete from {}",
                    step.status
                )));
            }
            if let Some(output) = output {
                let digest = schema_digest.ok_or_else(|| {
                    WorkflowError::Validation("accepted output requires schema digest".to_string())
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepOutputAccepted {
                        step_id: step_id.to_string(),
                        attempt: attempt as u32,
                        output: output.clone(),
                        schema_digest: digest.to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET output_json = ?, output_schema_digest = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(output)?)
                .bind(digest)
                .bind(run_id)
                .bind(step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'completed', completed_at = ?, claim_token = NULL,
                     claim_deadline = NULL, waiting_interaction = 0,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "DELETE FROM workflow_ready_steps
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            let definition = version.definition()?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn stage_step_candidate(
        &self,
        run_id: Uuid,
        step_id: &str,
        output: Option<&serde_json::Value>,
        schema_digest: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` cannot produce a candidate from {}",
                    step.status
                )));
            }
            if step.awaiting_acceptance {
                let same_output = step.candidate_output_json.as_deref()
                    == output.map(serde_json::to_string).transpose()?.as_deref();
                let same_schema = step.candidate_schema_digest.as_deref() == schema_digest;
                if same_output && same_schema {
                    return find_run(&mut conn, run_id).await;
                }
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` already has another candidate output"
                )));
            }
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET candidate_output_json = ?, candidate_schema_digest = ?,
                     awaiting_acceptance = 1, turn_id = NULL,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(output.map(serde_json::to_string).transpose()?)
            .bind(schema_digest)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCandidateProduced {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    output: output.cloned(),
                    schema_digest: schema_digest.map(str::to_string),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'waiting',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status = 'running'",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn accept_step_candidate(
        &self,
        run_id: Uuid,
        step_id: &str,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_step_id, existing_digest)) =
                sqlx::query_as::<_, (Uuid, Option<String>, String)>(
                    "SELECT run_id, step_id, payload_digest
                     FROM workflow_run_control_operations WHERE operation_id = ?",
                )
                .bind(operation_id)
                .fetch_optional(&mut *conn)
                .await?
            {
                if existing_run_id != run_id
                    || existing_step_id.as_deref() != Some(step_id)
                    || existing_digest != payload_digest
                {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another candidate acceptance"
                            .to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" || !step.awaiting_acceptance {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` has no candidate output awaiting acceptance"
                )));
            }
            sqlx::query(
                "INSERT INTO workflow_run_control_operations (
                    operation_id, run_id, action, step_id, payload_digest, principal_json
                 ) VALUES (?, ?, 'accept_candidate', ?, ?, ?)",
            )
            .bind(operation_id)
            .bind(run_id)
            .bind(step_id)
            .bind(payload_digest)
            .bind(principal_json)
            .execute(&mut *conn)
            .await?;
            let output = step
                .candidate_output_json
                .as_deref()
                .map(serde_json::from_str::<serde_json::Value>)
                .transpose()?;
            if let Some(output) = &output {
                sqlx::query(
                    "UPDATE workflow_step_runs
                     SET output_json = ?, output_schema_digest = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(output)?)
                .bind(step.candidate_schema_digest.as_deref())
                .bind(run_id)
                .bind(step_id)
                .bind(step.attempt)
                .execute(&mut *conn)
                .await?;
                if let Some(schema_digest) = step.candidate_schema_digest.as_deref() {
                    append_event(
                        &mut conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepOutputAccepted {
                            step_id: step_id.to_string(),
                            attempt: step.attempt as u32,
                            output: output.clone(),
                            schema_digest: schema_digest.to_string(),
                        },
                    )
                    .await?;
                }
            }
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::StepCandidateAccepted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'completed', completed_at = ?, claim_token = NULL,
                     claim_deadline = NULL, waiting_interaction = 0,
                     awaiting_acceptance = 0,
                     candidate_output_json = NULL, candidate_schema_digest = NULL,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                },
            )
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            let definition = version_on_connection(&mut conn, run.definition_version_id)
                .await?
                .definition()?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn fail_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        code: &str,
        message: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            if matches!(step.status.as_str(), "completed" | "failed" | "cancelled") {
                return find_run(&mut conn, run_id).await;
            }
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'failed', completed_at = ?,
                        claim_token = NULL, claim_deadline = NULL, waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepFailed {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                    code: code.to_string(),
                    message: message.to_string(),
                },
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::RunFailed {
                    code: code.to_string(),
                    message: message.to_string(),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'failed',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status IN ('running', 'waiting')",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn needs_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        reason: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'needs_review',
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?
                   AND status IN ('claimed', 'running')",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepNeedsReview {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                    reason: reason.to_string(),
                },
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::RunNeedsReview {
                    reason: reason.to_string(),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'needs_review',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status IN ('running', 'waiting')",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn retry_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if review_operation_is_retry(&mut conn, run_id, operation_id, payload_digest).await? {
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if run.status != "needs_review" {
                return Err(WorkflowError::Conflict(
                    "workflow run is not awaiting review".to_string(),
                ));
            }
            if run.deadline_at <= Utc::now() {
                return Err(WorkflowError::Conflict(
                    "workflow deadline has expired".to_string(),
                ));
            }
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            if run.agent_calls_started >= i64::from(policy.max_agent_calls) {
                return Err(WorkflowError::Conflict(
                    "workflow agent call budget is exhausted".to_string(),
                ));
            }
            let previous = find_latest_step(&mut conn, run_id, step_id).await?;
            if previous.status != "needs_review" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not awaiting review"
                )));
            }
            record_review_decision(
                &mut conn,
                run_id,
                step_id,
                operation_id,
                payload_digest,
                "retry",
                principal_json,
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ReviewDecided {
                    step_id: step_id.to_string(),
                    from_attempt: previous.attempt as u32,
                    decision: "retry".to_string(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            let attempt = previous.attempt + 1;
            let ready = append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepReady {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            sqlx::query(
                "INSERT INTO workflow_step_runs (id, run_id, step_id, attempt, status)
                 VALUES (?, ?, ?, ?, 'ready')",
            )
            .bind(Uuid::new_v4())
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO workflow_ready_steps (
                     run_id, step_id, attempt, ready_sequence, status
                 ) VALUES (?, ?, ?, ?, 'ready')",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .bind(ready.sequence)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running',
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn accept_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        output: Option<&serde_json::Value>,
        schema_digest: Option<&str>,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if review_operation_is_retry(&mut conn, run_id, operation_id, payload_digest).await? {
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if run.status != "needs_review" {
                return Err(WorkflowError::Conflict(
                    "workflow run is not awaiting review".to_string(),
                ));
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "needs_review" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not awaiting review"
                )));
            }
            record_review_decision(
                &mut conn,
                run_id,
                step_id,
                operation_id,
                payload_digest,
                "accept",
                principal_json,
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ReviewDecided {
                    step_id: step_id.to_string(),
                    from_attempt: step.attempt as u32,
                    decision: "accept".to_string(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            if let Some(output) = output {
                let digest = schema_digest.ok_or_else(|| {
                    WorkflowError::Validation("accepted output requires schema digest".to_string())
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepOutputAccepted {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        output: output.clone(),
                        schema_digest: digest.to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET output_json = ?, output_schema_digest = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(output)?)
                .bind(digest)
                .bind(run_id)
                .bind(step_id)
                .bind(step.attempt)
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'completed', completed_at = ?,
                        waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                },
            )
            .await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &version.definition()?).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn skip_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if review_operation_is_retry(&mut conn, run_id, operation_id, payload_digest).await? {
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if run.status != "needs_review" {
                return Err(WorkflowError::Conflict(
                    "workflow run is not awaiting review".to_string(),
                ));
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "needs_review" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not awaiting review"
                )));
            }
            record_review_decision(
                &mut conn,
                run_id,
                step_id,
                operation_id,
                payload_digest,
                "skip",
                principal_json,
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ReviewDecided {
                    step_id: step_id.to_string(),
                    from_attempt: step.attempt as u32,
                    decision: "skip".to_string(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'skipped', completed_at = ?,
                        waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepSkipped {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                },
            )
            .await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &version.definition()?).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn decide_approval(
        &self,
        run_id: Uuid,
        step_id: &str,
        decision: &serde_json::Value,
        payload_digest: &str,
        operation_id: Uuid,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let existing: Option<(String, String)> = sqlx::query_as(
                "SELECT step_id, payload_digest
                 FROM workflow_approval_decisions WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?;
            if let Some((existing_step, existing_digest)) = existing {
                if existing_step != step_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "approval operation id was already used with another payload".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let step = find_step(&mut conn, run_id, step_id, 1).await?;
            if step.status != "waiting_approval" {
                return Err(WorkflowError::Conflict(format!(
                    "approval step `{step_id}` is no longer waiting"
                )));
            }
            let inserted = sqlx::query(
                "INSERT INTO workflow_approval_decisions (
                     run_id, step_id, attempt, operation_id, principal_json, decision_json,
                     payload_digest
                 ) VALUES (?, ?, 1, ?, ?, ?, ?)
                 ON CONFLICT(run_id, step_id, attempt) DO NOTHING",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(operation_id)
            .bind(principal_json)
            .bind(serde_json::to_string(decision)?)
            .bind(payload_digest)
            .execute(&mut *conn)
            .await?;
            if inserted.rows_affected() != 1 {
                return Err(WorkflowError::Conflict(
                    "approval step already has a decision".to_string(),
                ));
            }
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ApprovalDecided {
                    step_id: step_id.to_string(),
                    attempt: 1,
                    decision: decision.clone(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'completed', output_json = ?,
                        waiting_interaction = 0,
                        completed_at = ?, updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = 1",
            )
            .bind(serde_json::to_string(decision)?)
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: 1,
                },
            )
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &version.definition()?).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn cancel(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        reason: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let payload_digest = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&serde_json::json!({
                    "runId": run_id,
                    "reason": reason,
                }))?)
            );
            let existing: Option<(Uuid, String)> = sqlx::query_as(
                "SELECT run_id, payload_digest
                 FROM workflow_cancel_operations WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?;
            if let Some((existing_run_id, existing_digest)) = existing {
                if existing_run_id != run_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "cancel operation id was already used with another payload".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            sqlx::query(
                "INSERT INTO workflow_cancel_operations (run_id, operation_id, payload_digest)
                 VALUES (?, ?, ?)",
            )
            .bind(run_id)
            .bind(operation_id)
            .bind(&payload_digest)
            .execute(&mut *conn)
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            if is_terminal_run(&run.status) {
                return Ok(run);
            }
            let active = sqlx::query(
                "SELECT step_id, attempt FROM workflow_step_runs
                 WHERE run_id = ? AND status NOT IN (
                     'completed', 'failed', 'cancelled', 'interrupted', 'skipped'
                 ) ORDER BY step_id, attempt",
            )
            .bind(run_id)
            .fetch_all(&mut *conn)
            .await?;
            for row in active {
                let step_id: String = row.try_get("step_id")?;
                let attempt: i64 = row.try_get("attempt")?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET status = 'cancelled', completed_at = ?,
                            waiting_interaction = 0,
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(Utc::now())
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepCancelled {
                        step_id,
                        attempt: attempt as u32,
                    },
                )
                .await?;
            }
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::RunCancelled {
                    reason: reason.map(str::to_string),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'cancelled',
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn request_pause(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        reason: Option<&str>,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_digest)) = sqlx::query_as::<_, (Uuid, String)>(
                "SELECT run_id, payload_digest FROM workflow_run_control_operations
                     WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?
            {
                if existing_run_id != run_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another pause request".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if is_terminal_run(&run.status) {
                return Err(WorkflowError::Conflict(
                    "terminal workflow runs cannot be paused".to_string(),
                ));
            }
            sqlx::query(
                "INSERT INTO workflow_run_control_operations (
                    operation_id, run_id, action, payload_digest, principal_json
                 ) VALUES (?, ?, 'pause', ?, ?)",
            )
            .bind(operation_id)
            .bind(run_id)
            .bind(payload_digest)
            .bind(principal_json)
            .execute(&mut *conn)
            .await?;
            if run.control_state == "active" {
                sqlx::query(
                    "UPDATE workflow_runs SET control_state = 'pausing', pause_reason = ?,
                            updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(reason)
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    Some(operation_id),
                    &WorkflowEvent::RunPauseRequested {
                        reason: reason.map(str::to_string),
                        principal: serde_json::from_str(principal_json)?,
                    },
                )
                .await?;
            }
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn mark_paused(&self, run_id: Uuid) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let run = find_run(&mut conn, run_id).await?;
            if run.control_state == "paused" {
                return Ok(run);
            }
            if run.control_state != "pausing" {
                return Err(WorkflowError::Conflict(
                    "workflow run has no pending pause request".to_string(),
                ));
            }
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'paused', paused_at = ?,
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            append_event(&mut conn, run_id, None, &WorkflowEvent::RunPaused).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn resume_paused_run(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_digest)) = sqlx::query_as::<_, (Uuid, String)>(
                "SELECT run_id, payload_digest FROM workflow_run_control_operations
                     WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?
            {
                if existing_run_id != run_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another resume request".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if !matches!(run.control_state.as_str(), "pausing" | "paused") {
                return Err(WorkflowError::Conflict(
                    "workflow run is not paused".to_string(),
                ));
            }
            sqlx::query(
                "INSERT INTO workflow_run_control_operations (
                    operation_id, run_id, action, payload_digest, principal_json
                 ) VALUES (?, ?, 'resume', ?, ?)",
            )
            .bind(operation_id)
            .bind(run_id)
            .bind(payload_digest)
            .bind(principal_json)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'active', pause_reason = NULL,
                        paused_at = NULL, updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::RunResumed {
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            restore_running_if_not_waiting(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn reconcile_interrupted(&self) -> Result<usize, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            recover_stale_claims(&mut conn, Utc::now()).await?;
            let running = sqlx::query(
                "SELECT step.run_id, step.step_id, step.attempt
                 FROM workflow_step_runs step
                 JOIN workflow_runs run ON run.id = step.run_id
                 WHERE step.status = 'running' AND run.status IN ('running', 'waiting')
                   AND run.control_state = 'active' AND step.awaiting_input = 0
                 ORDER BY step.run_id, step.step_id",
            )
            .fetch_all(&mut *conn)
            .await?;
            let mut affected_runs = BTreeMap::<Uuid, ()>::new();
            for row in running {
                let run_id: Uuid = row.try_get("run_id")?;
                let step_id: String = row.try_get("step_id")?;
                let attempt: i64 = row.try_get("attempt")?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
                )
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepNeedsReview {
                        step_id,
                        attempt: attempt as u32,
                        reason: "host_restarted_after_agent_step_started".to_string(),
                    },
                )
                .await?;
                affected_runs.insert(run_id, ());
            }
            for run_id in affected_runs.keys() {
                append_event(
                    &mut conn,
                    *run_id,
                    None,
                    &WorkflowEvent::RunNeedsReview {
                        reason: "one or more running steps may have produced side effects"
                            .to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            }
            Ok(affected_runs.len())
        }
        .await;
        self.finish(conn, result).await
    }

    /// Fail closed when a completed upstream Step in an active Run no longer
    /// matches the immutable definition/input/workspace identity captured at
    /// preparation time. Optional runtime/tool/checkpoint evidence remains
    /// inspectable but its absence must not invalidate a completed Step after
    /// an ordinary app restart.
    pub async fn reconcile_completed_evidence(&self) -> Result<usize, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let rows = sqlx::query(
                "SELECT step.run_id, step.step_id, step.attempt,
                        step.resolved_input_digest, step.execution_evidence_json,
                        step.workspace_id, run.definition_version_id
                 FROM workflow_step_runs step
                 JOIN workflow_runs run ON run.id = step.run_id
                 WHERE step.status = 'completed' AND run.status IN ('running', 'waiting')
                 ORDER BY step.run_id, step.step_id, step.attempt",
            )
            .fetch_all(&mut *conn)
            .await?;
            let mut affected = BTreeMap::<Uuid, ()>::new();
            for row in rows {
                let run_id: Uuid = row.try_get("run_id")?;
                let step_id: String = row.try_get("step_id")?;
                let attempt: i64 = row.try_get("attempt")?;
                let resolved_input_digest: Option<String> = row.try_get("resolved_input_digest")?;
                let evidence_json: Option<String> = row.try_get("execution_evidence_json")?;
                let workspace_id: Option<Uuid> = row.try_get("workspace_id")?;
                let definition_version_id: Uuid = row.try_get("definition_version_id")?;
                let version = version_on_connection(&mut conn, definition_version_id).await?;
                let evidence = evidence_json
                    .as_deref()
                    .map(serde_json::from_str::<serde_json::Value>)
                    .transpose()?;
                let consistent = evidence.as_ref().is_some_and(|evidence| {
                    evidence
                        .get("definitionDigest")
                        .and_then(serde_json::Value::as_str)
                        == Some(version.digest.as_str())
                        && evidence
                            .get("resolvedInputDigest")
                            .and_then(serde_json::Value::as_str)
                            == resolved_input_digest.as_deref()
                        && evidence
                            .get("workspace")
                            .and_then(|workspace| workspace.get("workspaceId"))
                            .and_then(serde_json::Value::as_str)
                            .and_then(|value| Uuid::parse_str(value).ok())
                            == workspace_id
                });
                if consistent {
                    continue;
                }
                sqlx::query(
                    "UPDATE workflow_step_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'completed'",
                )
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepNeedsReview {
                        step_id,
                        attempt: attempt as u32,
                        reason: "completed_step_evidence_mismatch".to_string(),
                    },
                )
                .await?;
                affected.insert(run_id, ());
            }
            for run_id in affected.keys() {
                sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                    .bind(run_id)
                    .execute(&mut *conn)
                    .await?;
                append_event(
                    &mut conn,
                    *run_id,
                    None,
                    &WorkflowEvent::RunNeedsReview {
                        reason: "completed step evidence no longer matches the active Run"
                            .to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            }
            Ok(affected.len())
        }
        .await;
        self.finish(conn, result).await
    }

    /// Rebuild the mutable Run, Step, and ready projections from the append-only
    /// event stream. Stable command identity fields remain on `workflow_runs`;
    /// every lifecycle field is replaced from events in one transaction.
    pub async fn rebuild_run_projection(&self, run_id: Uuid) -> Result<(), WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            find_run(&mut conn, run_id).await?;
            let records = sqlx::query_as::<_, WorkflowEventRecord>(
                "SELECT id, run_id, sequence, event_version, event_kind, payload_json,
                        operation_id, created_at
                 FROM workflow_events WHERE run_id = ? ORDER BY sequence",
            )
            .bind(run_id)
            .fetch_all(&mut *conn)
            .await?;
            if records.is_empty() {
                return Err(WorkflowError::Projection(format!(
                    "workflow run {run_id} has no event history"
                )));
            }

            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            sqlx::query("DELETE FROM workflow_step_runs WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running', agent_calls_started = 0,
                        last_sequence = 0, updated_at = created_at WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;

            for record in &records {
                apply_projection_event(&mut conn, record).await?;
            }
            let last = records.last().expect("non-empty checked above");
            sqlx::query("UPDATE workflow_runs SET last_sequence = ?, updated_at = ? WHERE id = ?")
                .bind(last.sequence)
                .bind(last.created_at)
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            Ok(())
        }
        .await;
        self.finish(conn, result).await
    }

    async fn begin_immediate(
        &self,
    ) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, WorkflowError> {
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        Ok(conn)
    }

    async fn finish<T>(
        &self,
        mut conn: sqlx::pool::PoolConnection<sqlx::Sqlite>,
        result: Result<T, WorkflowError>,
    ) -> Result<T, WorkflowError> {
        match result {
            Ok(value) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error)
            }
        }
    }
}

async fn find_version_by_digest(
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

async fn apply_projection_event(
    conn: &mut SqliteConnection,
    record: &WorkflowEventRecord,
) -> Result<(), WorkflowError> {
    let run_id = record.run_id;
    match record.event()? {
        WorkflowEvent::RunStarted { step_ids, .. } => {
            for step_id in step_ids {
                sqlx::query(
                    "INSERT INTO workflow_step_runs (id, run_id, step_id, attempt, status)
                     VALUES (?, ?, ?, 1, 'pending')",
                )
                .bind(Uuid::new_v4())
                .bind(run_id)
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
        }
        WorkflowEvent::RunDerived {
            reused_step_ids,
            excluded_step_ids,
            ..
        } => {
            for step_id in reused_step_ids {
                sqlx::query(
                    "UPDATE workflow_step_runs SET execution_mode = 'reuse'
                     WHERE run_id = ? AND step_id = ? AND attempt = 1",
                )
                .bind(run_id)
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
            for step_id in excluded_step_ids {
                sqlx::query(
                    "UPDATE workflow_step_runs SET execution_mode = 'exclude'
                     WHERE run_id = ? AND step_id = ? AND attempt = 1",
                )
                .bind(run_id)
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
        }
        WorkflowEvent::StepReused {
            step_id,
            conversation_id,
            output_json,
            output_schema_digest,
            resolved_input_json,
            resolved_input_digest,
            execution_evidence_json,
            workspace_id,
            completed_at,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'completed', conversation_id = ?,
                        output_json = ?, output_schema_digest = ?, resolved_input_json = ?,
                        resolved_input_digest = ?, execution_evidence_json = ?, workspace_id = ?,
                        completed_at = ?, execution_mode = 'reuse', updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = 1",
            )
            .bind(conversation_id)
            .bind(output_json)
            .bind(output_schema_digest)
            .bind(resolved_input_json)
            .bind(resolved_input_digest)
            .bind(execution_evidence_json)
            .bind(workspace_id)
            .bind(completed_at)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepReady { step_id, attempt } => {
            sqlx::query(
                "INSERT INTO workflow_step_runs (id, run_id, step_id, attempt, status, updated_at)
                 VALUES (?, ?, ?, ?, 'ready', ?)
                 ON CONFLICT(run_id, step_id, attempt) DO UPDATE SET
                   status = 'ready', claim_token = NULL, claim_deadline = NULL,
                   updated_at = excluded.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .bind(record.created_at)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO workflow_ready_steps (
                     run_id, step_id, attempt, ready_sequence, status
                 ) VALUES (?, ?, ?, ?, 'ready')
                 ON CONFLICT(run_id, step_id, attempt) DO UPDATE SET
                   ready_sequence = excluded.ready_sequence, status = 'ready',
                   claim_token = NULL, claim_deadline = NULL",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .bind(record.sequence)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running' WHERE id = ?
                 AND status IN ('waiting', 'needs_review')",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepClaimed {
            step_id,
            attempt,
            claim_token,
            claim_deadline,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'claimed', claim_token = ?,
                        claim_deadline = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(claim_token)
            .bind(claim_deadline)
            .bind(record.created_at)
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_ready_steps SET status = 'claimed', claim_token = ?,
                        claim_deadline = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(claim_token)
            .bind(claim_deadline)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepClaimReleased { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'ready', claim_token = NULL,
                        claim_deadline = NULL, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_ready_steps SET status = 'ready', claim_token = NULL,
                        claim_deadline = NULL
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepPrepared {
            step_id,
            attempt,
            resolved_input,
            resolved_input_digest,
            execution_evidence,
            workspace_id,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET resolved_input_json = ?,
                        resolved_input_digest = ?, execution_evidence_json = ?,
                        workspace_id = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&resolved_input)?)
            .bind(resolved_input_digest)
            .bind(serde_json::to_string(&execution_evidence)?)
            .bind(workspace_id)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepEvidenceRecorded {
            step_id,
            attempt,
            execution_evidence,
            ..
        } => {
            if let Some(execution_evidence) = execution_evidence {
                sqlx::query(
                    "UPDATE workflow_step_runs SET execution_evidence_json = ?, updated_at = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(&execution_evidence)?)
                .bind(record.created_at)
                .bind(run_id)
                .bind(step_id)
                .bind(i64::from(attempt))
                .execute(&mut *conn)
                .await?;
            }
        }
        WorkflowEvent::StepStarted {
            step_id,
            attempt,
            conversation_id,
            turn_id,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'running', conversation_id = ?,
                        turn_id = ?, started_at = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(record.created_at)
            .bind(record.created_at)
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "DELETE FROM workflow_ready_steps
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1
                 WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepTurnBound {
            step_id,
            attempt,
            conversation_id,
            turn_id,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET conversation_id = ?, turn_id = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepWaitingApproval { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'waiting_approval', updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepInteractionWaiting {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET waiting_interaction = 1, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepInteractionResumed { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET waiting_interaction = 0, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            restore_running_if_not_waiting(conn, run_id).await?;
        }
        WorkflowEvent::StepInputRequested {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_input = 1, turn_id = NULL,
                        waiting_interaction = 0, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepInputSubmitted {
            step_id,
            attempt,
            turn_id,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_input = 0, turn_id = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(turn_id)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            restore_running_if_not_waiting(conn, run_id).await?;
        }
        WorkflowEvent::StepOutputAccepted {
            step_id,
            attempt,
            output,
            schema_digest,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET output_json = ?, output_schema_digest = ?,
                        updated_at = ? WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&output)?)
            .bind(schema_digest)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepCandidateProduced {
            step_id,
            attempt,
            output,
            schema_digest,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET candidate_output_json = ?,
                        candidate_schema_digest = ?, awaiting_acceptance = 1,
                        turn_id = NULL, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(output.as_ref().map(serde_json::to_string).transpose()?)
            .bind(schema_digest)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepCandidateAccepted {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_acceptance = 0,
                        candidate_output_json = NULL, candidate_schema_digest = NULL,
                        updated_at = ? WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepRepairRequested { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET repair_count = repair_count + 1,
                        turn_id = NULL, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1
                 WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepCompleted { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "completed").await?;
        }
        WorkflowEvent::StepFailed {
            step_id, attempt, ..
        } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "failed").await?;
        }
        WorkflowEvent::StepCancelled { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "cancelled").await?;
        }
        WorkflowEvent::StepInterrupted { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "interrupted").await?;
        }
        WorkflowEvent::StepSkipped { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "skipped").await?;
        }
        WorkflowEvent::StepNeedsReview {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'needs_review', updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::ReviewDecided { .. } => {
            sqlx::query("UPDATE workflow_runs SET status = 'running' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::ApprovalDecided {
            step_id,
            attempt,
            decision,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET output_json = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&decision)?)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunCompleted => set_rebuilt_run_status(conn, record, "completed").await?,
        WorkflowEvent::RunFailed { .. } => set_rebuilt_run_status(conn, record, "failed").await?,
        WorkflowEvent::RunCancelled { .. } => {
            set_rebuilt_run_status(conn, record, "cancelled").await?
        }
        WorkflowEvent::RunPauseRequested { reason, .. } => {
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'pausing', pause_reason = ?,
                        updated_at = ? WHERE id = ?",
            )
            .bind(reason)
            .bind(record.created_at)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunPaused => {
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'paused', paused_at = ?,
                        updated_at = ? WHERE id = ?",
            )
            .bind(record.created_at)
            .bind(record.created_at)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunResumed { .. } => {
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'active', pause_reason = NULL,
                        paused_at = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunNeedsReview { .. } => {
            set_rebuilt_run_status(conn, record, "needs_review").await?
        }
    }
    Ok(())
}

async fn set_rebuilt_step_terminal(
    conn: &mut SqliteConnection,
    record: &WorkflowEventRecord,
    step_id: &str,
    attempt: u32,
    status: &str,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "UPDATE workflow_step_runs SET status = ?, completed_at = ?, claim_token = NULL,
                claim_deadline = NULL, waiting_interaction = 0, updated_at = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ?",
    )
    .bind(status)
    .bind(record.created_at)
    .bind(record.created_at)
    .bind(record.run_id)
    .bind(step_id)
    .bind(i64::from(attempt))
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM workflow_ready_steps WHERE run_id = ? AND step_id = ? AND attempt = ?",
    )
    .bind(record.run_id)
    .bind(step_id)
    .bind(i64::from(attempt))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn restore_running_if_not_waiting(
    conn: &mut SqliteConnection,
    run_id: Uuid,
) -> Result<(), WorkflowError> {
    let needs_review: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_step_runs
         WHERE run_id = ? AND status = 'needs_review'",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    if needs_review > 0 {
        return Ok(());
    }
    let waiting: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_step_runs
         WHERE run_id = ? AND (
           status = 'waiting_approval' OR waiting_interaction = 1 OR awaiting_input = 1
         )",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    let status = if waiting == 0 { "running" } else { "waiting" };
    sqlx::query(
        "UPDATE workflow_runs SET status = ?, updated_at = datetime('now', 'subsec')
         WHERE id = ? AND status IN ('waiting', 'needs_review')",
    )
    .bind(status)
    .bind(run_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn set_rebuilt_run_status(
    conn: &mut SqliteConnection,
    record: &WorkflowEventRecord,
    status: &str,
) -> Result<(), WorkflowError> {
    sqlx::query("UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(record.created_at)
        .bind(record.run_id)
        .execute(&mut *conn)
        .await?;
    if status != "running" {
        sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
            .bind(record.run_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

async fn append_event(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    operation_id: Option<Uuid>,
    event: &WorkflowEvent,
) -> Result<WorkflowEventRecord, WorkflowError> {
    if let Some(operation_id) = operation_id
        && let Some(existing) = sqlx::query_as::<_, WorkflowEventRecord>(
            "SELECT id, run_id, sequence, event_version, event_kind, payload_json,
                    operation_id, created_at
             FROM workflow_events WHERE run_id = ? AND operation_id = ?",
        )
        .bind(run_id)
        .bind(operation_id)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(existing);
    }
    let sequence: i64 = sqlx::query_scalar(
        "UPDATE workflow_runs SET last_sequence = last_sequence + 1,
                updated_at = datetime('now', 'subsec')
         WHERE id = ? RETURNING last_sequence",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query_as::<_, WorkflowEventRecord>(
        "INSERT INTO workflow_events (
             id, run_id, sequence, event_version, event_kind, payload_json, operation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, run_id, sequence, event_version, event_kind, payload_json,
                   operation_id, created_at",
    )
    .bind(Uuid::new_v4())
    .bind(run_id)
    .bind(sequence)
    .bind(EVENT_VERSION)
    .bind(event.kind())
    .bind(serde_json::to_string(event)?)
    .bind(operation_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(WorkflowError::from)
}

async fn review_operation_is_retry(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    operation_id: Uuid,
    payload_digest: &str,
) -> Result<bool, WorkflowError> {
    let existing: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT run_id, payload_digest FROM workflow_review_decisions WHERE operation_id = ?",
    )
    .bind(operation_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((existing_run_id, existing_digest)) = existing else {
        return Ok(false);
    };
    if existing_run_id != run_id || existing_digest != payload_digest {
        return Err(WorkflowError::Conflict(
            "review operation id was already used with another payload".to_string(),
        ));
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
async fn record_review_decision(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    step_id: &str,
    operation_id: Uuid,
    payload_digest: &str,
    decision_kind: &str,
    principal_json: &str,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "INSERT INTO workflow_review_decisions (
             run_id, step_id, operation_id, payload_digest, decision_kind, principal_json
         ) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(run_id)
    .bind(step_id)
    .bind(operation_id)
    .bind(payload_digest)
    .bind(decision_kind)
    .bind(principal_json)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn enqueue_newly_ready(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    definition: &WorkflowDefinition,
) -> Result<(), WorkflowError> {
    let mut completed_notify = false;
    loop {
        let mut progressed = false;
        for step in &definition.steps {
            let current: String = sqlx::query_scalar(
                "SELECT status FROM workflow_step_runs
             WHERE run_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1",
            )
            .bind(run_id)
            .bind(&step.id)
            .fetch_one(&mut *conn)
            .await?;
            if current != "pending" {
                continue;
            }
            let mut ready = true;
            for dependency in &step.depends_on {
                let status: String = sqlx::query_scalar(
                    "SELECT status FROM workflow_step_runs
                 WHERE run_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1",
                )
                .bind(run_id)
                .bind(dependency)
                .fetch_one(&mut *conn)
                .await?;
                if !matches!(status.as_str(), "completed" | "skipped") {
                    ready = false;
                    break;
                }
            }
            if !ready {
                continue;
            }
            match step.spec {
                WorkflowStepSpec::Approval(_) => {
                    sqlx::query(
                        "UPDATE workflow_step_runs SET status = 'waiting_approval',
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = 1 AND status = 'pending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepWaitingApproval {
                            step_id: step.id.clone(),
                            attempt: 1,
                        },
                    )
                    .await?;
                    sqlx::query(
                        "UPDATE workflow_runs SET status = 'waiting',
                            updated_at = datetime('now', 'subsec')
                     WHERE id = ? AND status = 'running'",
                    )
                    .bind(run_id)
                    .execute(&mut *conn)
                    .await?;
                }
                WorkflowStepSpec::Agent(_) => {
                    let event = append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepReady {
                            step_id: step.id.clone(),
                            attempt: 1,
                        },
                    )
                    .await?;
                    sqlx::query(
                        "UPDATE workflow_step_runs SET status = 'ready',
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = 1 AND status = 'pending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .execute(&mut *conn)
                    .await?;
                    sqlx::query(
                        "INSERT INTO workflow_ready_steps (
                         run_id, step_id, attempt, ready_sequence, status
                     ) VALUES (?, ?, 1, ?, 'ready')",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(event.sequence)
                    .execute(&mut *conn)
                    .await?;
                }
                WorkflowStepSpec::Notify(_) => {
                    sqlx::query(
                        "UPDATE workflow_step_runs
                     SET status = 'completed',
                         completed_at = datetime('now', 'subsec'),
                         updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = 1 AND status = 'pending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepCompleted {
                            step_id: step.id.clone(),
                            attempt: 1,
                        },
                    )
                    .await?;
                    progressed = true;
                    completed_notify = true;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    if completed_notify {
        settle_if_complete(conn, run_id).await?;
    }
    Ok(())
}

async fn settle_if_complete(
    conn: &mut SqliteConnection,
    run_id: Uuid,
) -> Result<(), WorkflowError> {
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_step_runs step
         WHERE run_id = ?
           AND attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest
                          WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id)
           AND status NOT IN ('completed', 'skipped')",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    if remaining == 0 {
        append_event(conn, run_id, None, &WorkflowEvent::RunCompleted).await?;
        sqlx::query(
            "UPDATE workflow_runs SET status = 'completed',
                    updated_at = datetime('now', 'subsec')
             WHERE id = ? AND status IN ('running', 'waiting')",
        )
        .bind(run_id)
        .execute(&mut *conn)
        .await?;
    } else {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workflow_step_runs step
             WHERE run_id = ?
               AND attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest
                              WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id)
               AND status = 'waiting_approval'",
        )
        .bind(run_id)
        .fetch_one(&mut *conn)
        .await?;
        if waiting == 0 {
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status = 'waiting'",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

async fn recover_stale_claims(
    conn: &mut SqliteConnection,
    now: DateTime<Utc>,
) -> Result<usize, WorkflowError> {
    let rows = sqlx::query(
        "SELECT run_id, step_id, attempt FROM workflow_ready_steps
         WHERE status = 'claimed' AND claim_deadline < ? ORDER BY ready_sequence",
    )
    .bind(now)
    .fetch_all(&mut *conn)
    .await?;
    for row in &rows {
        let run_id: Uuid = row.try_get("run_id")?;
        let step_id: String = row.try_get("step_id")?;
        let attempt: i64 = row.try_get("attempt")?;
        sqlx::query(
            "UPDATE workflow_ready_steps SET status = 'ready', claim_token = NULL,
                    claim_deadline = NULL WHERE run_id = ? AND step_id = ? AND attempt = ?",
        )
        .bind(run_id)
        .bind(&step_id)
        .bind(attempt)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "UPDATE workflow_step_runs SET status = 'ready', claim_token = NULL,
                    claim_deadline = NULL, updated_at = datetime('now', 'subsec')
             WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'claimed'",
        )
        .bind(run_id)
        .bind(&step_id)
        .bind(attempt)
        .execute(&mut *conn)
        .await?;
        append_event(
            conn,
            run_id,
            None,
            &WorkflowEvent::StepClaimReleased {
                step_id: step_id.clone(),
                attempt: attempt as u32,
            },
        )
        .await?;
    }
    Ok(rows.len())
}

async fn find_run(
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

async fn find_run_by_operation(
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

async fn find_step(
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

async fn find_latest_step(
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

async fn find_step_by_claim(
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

async fn version_on_connection(
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

fn is_terminal_run(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

fn rebase_reused_execution_evidence(
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

fn select_pointer<'a>(
    value: &'a serde_json::Value,
    pointer: &str,
) -> Option<&'a serde_json::Value> {
    if pointer.is_empty() {
        Some(value)
    } else {
        value.pointer(pointer)
    }
}
