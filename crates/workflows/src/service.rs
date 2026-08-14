use sha2::{Digest, Sha256};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    WorkflowDefinition, WorkflowPolicy, WorkflowRunView, WorkflowStepSpec, WorkflowStore,
    WorkflowVersionView, normalize_definition, spec::MAX_WORKFLOW_INPUT_BYTES,
    store::PersistWorkflowRun, validate_json_value,
};

#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("workflow projection error: {0}")]
    Projection(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct PublishWorkflow {
    pub definition_id: Option<Uuid>,
    pub definition: WorkflowDefinition,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct WorkflowValidationView {
    pub normalized: WorkflowDefinition,
    pub digest: String,
}

#[derive(Debug, Clone)]
pub struct StartWorkflow {
    pub definition_version_id: Uuid,
    pub workspace_id: Uuid,
    pub input: serde_json::Value,
    pub policy_override: Option<WorkflowPolicy>,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct CompleteWorkflowStep {
    pub run_id: Uuid,
    pub step_id: String,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct DecideApproval {
    pub run_id: Uuid,
    pub step_id: String,
    pub decision: serde_json::Value,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum WorkflowReviewDecision {
    Retry {
        step_id: String,
    },
    Accept {
        step_id: String,
        output: Option<serde_json::Value>,
    },
    Skip {
        step_id: String,
    },
    Cancel {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ReviewWorkflow {
    pub run_id: Uuid,
    pub decision: WorkflowReviewDecision,
    pub operation_id: Uuid,
    pub principal: serde_json::Value,
}

#[derive(Clone)]
pub struct WorkflowCore {
    store: WorkflowStore,
}

impl WorkflowCore {
    pub const fn new(store: WorkflowStore) -> Self {
        Self { store }
    }

    pub fn validate(
        &self,
        definition: WorkflowDefinition,
    ) -> Result<WorkflowValidationView, WorkflowError> {
        let normalized = normalize_definition(definition)?;
        let digest = digest_json(&normalized)?;
        Ok(WorkflowValidationView { normalized, digest })
    }

    pub async fn publish(
        &self,
        input: PublishWorkflow,
    ) -> Result<WorkflowVersionView, WorkflowError> {
        let definition = normalize_definition(input.definition)?;
        let digest = digest_json(&definition)?;
        self.store
            .publish(
                input.definition_id,
                &definition,
                &digest,
                input.operation_id,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn start(&self, input: StartWorkflow) -> Result<WorkflowRunView, WorkflowError> {
        let version = self.store.version(input.definition_version_id).await?;
        let definition = version.definition()?;
        if serde_json::to_vec(&input.input)?.len() > MAX_WORKFLOW_INPUT_BYTES {
            return Err(WorkflowError::Validation(format!(
                "workflow input exceeds {MAX_WORKFLOW_INPUT_BYTES} bytes"
            )));
        }
        if let Some(schema) = &definition.input_schema {
            validate_json_value(schema, &input.input)?;
        }
        let policy = input.policy_override.unwrap_or(definition.policy);
        let payload_digest = digest_json(&serde_json::json!({
            "definitionVersionId": input.definition_version_id,
            "workspaceId": input.workspace_id,
            "input": &input.input,
            "policy": &policy,
        }))?;
        let principal_json = serde_json::to_string(&input.principal)?;
        self.store
            .start(
                &version,
                PersistWorkflowRun {
                    workspace_id: input.workspace_id,
                    input: &input.input,
                    policy: &policy,
                    operation_id: input.operation_id,
                    payload_digest: &payload_digest,
                    principal_json: &principal_json,
                },
            )
            .await
    }

    pub async fn complete_step(
        &self,
        input: CompleteWorkflowStep,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let run = self.store.run(input.run_id).await?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await?
            .definition()?;
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        let schema = match &step.spec {
            WorkflowStepSpec::Agent(agent) => agent.output_schema.as_ref(),
            WorkflowStepSpec::Approval(_) => {
                return Err(WorkflowError::Conflict(
                    "approval steps complete through decide".to_string(),
                ));
            }
        };
        let (output, schema_digest) = match (schema, input.output.as_ref()) {
            (Some(schema), Some(output)) => {
                validate_json_value(schema, output)?;
                let bytes = serde_json::to_vec(output)?;
                let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
                if bytes.len() > policy.max_output_bytes {
                    return Err(WorkflowError::Validation(format!(
                        "step output exceeds {} bytes",
                        policy.max_output_bytes
                    )));
                }
                (Some(output), Some(digest_json(schema)?))
            }
            (Some(_), None) => {
                return Err(WorkflowError::Validation(
                    "step requires structured output".to_string(),
                ));
            }
            (None, Some(_)) => {
                return Err(WorkflowError::Validation(
                    "step has no output schema".to_string(),
                ));
            }
            (None, None) => (None, None),
        };
        self.store
            .complete_step(
                input.run_id,
                &input.step_id,
                output,
                schema_digest.as_deref(),
            )
            .await
    }

    pub async fn decide(&self, input: DecideApproval) -> Result<WorkflowRunView, WorkflowError> {
        let run = self.store.run(input.run_id).await?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await?
            .definition()?;
        let step = definition
            .steps
            .iter()
            .find(|step| step.id == input.step_id)
            .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {}", input.step_id)))?;
        let WorkflowStepSpec::Approval(approval) = &step.spec else {
            return Err(WorkflowError::Conflict(format!(
                "step `{}` is not an approval",
                input.step_id
            )));
        };
        let principal_scope = input
            .principal
            .get("scopes")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|scopes| {
                scopes
                    .iter()
                    .any(|scope| scope.as_str() == Some(&approval.approver_scope))
            });
        if !principal_scope {
            return Err(WorkflowError::Conflict(format!(
                "principal lacks approval scope `{}`",
                approval.approver_scope
            )));
        }
        validate_json_value(&approval.decision_schema, &input.decision)?;
        let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
        if serde_json::to_vec(&input.decision)?.len() > policy.max_output_bytes {
            return Err(WorkflowError::Validation(format!(
                "approval output exceeds {} bytes",
                policy.max_output_bytes
            )));
        }
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "stepId": &input.step_id,
            "decision": &input.decision,
        }))?;
        self.store
            .decide_approval(
                input.run_id,
                &input.step_id,
                &input.decision,
                &payload_digest,
                input.operation_id,
                &serde_json::to_string(&input.principal)?,
            )
            .await
    }

    pub async fn cancel(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        reason: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        self.store.cancel(run_id, operation_id, reason).await
    }

    pub async fn review(&self, input: ReviewWorkflow) -> Result<WorkflowRunView, WorkflowError> {
        let payload_digest = digest_json(&serde_json::json!({
            "runId": input.run_id,
            "decision": &input.decision,
        }))?;
        let principal_json = serde_json::to_string(&input.principal)?;
        match &input.decision {
            WorkflowReviewDecision::Retry { step_id } => {
                self.store
                    .retry_review_step(
                        input.run_id,
                        step_id,
                        input.operation_id,
                        &payload_digest,
                        &principal_json,
                    )
                    .await
            }
            WorkflowReviewDecision::Accept { step_id, output } => {
                let run = self.store.run(input.run_id).await?;
                let definition = self
                    .store
                    .version(run.definition_version_id)
                    .await?
                    .definition()?;
                let step = definition
                    .steps
                    .iter()
                    .find(|step| step.id == *step_id)
                    .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {step_id}")))?;
                let WorkflowStepSpec::Agent(agent) = &step.spec else {
                    return Err(WorkflowError::Conflict(
                        "only agent steps can accept review evidence".to_string(),
                    ));
                };
                let schema_digest = match (&agent.output_schema, output) {
                    (Some(schema), Some(output)) => {
                        validate_json_value(schema, output)?;
                        let bytes = serde_json::to_vec(output)?;
                        let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
                        if bytes.len() > policy.max_output_bytes {
                            return Err(WorkflowError::Validation(format!(
                                "step output exceeds {} bytes",
                                policy.max_output_bytes
                            )));
                        }
                        Some(digest_json(schema)?)
                    }
                    (Some(_), None) => {
                        return Err(WorkflowError::Validation(
                            "accepted review evidence requires structured output".to_string(),
                        ));
                    }
                    (None, Some(_)) => {
                        return Err(WorkflowError::Validation(
                            "step has no output schema".to_string(),
                        ));
                    }
                    (None, None) => None,
                };
                self.store
                    .accept_review_step(
                        input.run_id,
                        step_id,
                        output.as_ref(),
                        schema_digest.as_deref(),
                        input.operation_id,
                        &payload_digest,
                        &principal_json,
                    )
                    .await
            }
            WorkflowReviewDecision::Skip { step_id } => {
                let run = self.store.run(input.run_id).await?;
                let definition = self
                    .store
                    .version(run.definition_version_id)
                    .await?
                    .definition()?;
                let step = definition
                    .steps
                    .iter()
                    .find(|step| step.id == *step_id)
                    .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {step_id}")))?;
                let WorkflowStepSpec::Agent(agent) = &step.spec else {
                    return Err(WorkflowError::Conflict(
                        "only agent steps can be skipped during review".to_string(),
                    ));
                };
                if !agent.allow_skip_on_review {
                    return Err(WorkflowError::Conflict(format!(
                        "step `{step_id}` does not allow review skip"
                    )));
                }
                self.store
                    .skip_review_step(
                        input.run_id,
                        step_id,
                        input.operation_id,
                        &payload_digest,
                        &principal_json,
                    )
                    .await
            }
            WorkflowReviewDecision::Cancel { reason } => {
                self.store
                    .cancel(input.run_id, input.operation_id, reason.as_deref())
                    .await
            }
        }
    }
}

fn digest_json(value: &impl serde::Serialize) -> Result<String, WorkflowError> {
    let bytes = serde_json::to_vec(value)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, str::FromStr, time::Duration as StdDuration};

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        AgentStepSpec, ApprovalStepSpec, SideEffectClass, WorkflowStep, WorkspaceAccess,
        store::{WorkflowRunStatus, WorkflowStepStatus},
    };

    async fn setup() -> (WorkflowCore, WorkflowStore) {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let store = WorkflowStore::new(pool);
        (WorkflowCore::new(store.clone()), store)
    }

    async fn setup_multi_connection() -> (TempDir, WorkflowCore, WorkflowStore) {
        let temporary = TempDir::new().expect("temporary sqlite directory");
        let database_path = temporary.path().join("workflow-claims.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .create_if_missing(true)
            .foreign_keys(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(StdDuration::from_secs(5));
        let migration_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .expect("connect migration db");
        sqlx::migrate!("../db/migrations")
            .run(&migration_pool)
            .await
            .expect("run migrations");
        migration_pool.close().await;
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("PRAGMA foreign_keys = OFF")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .expect("connect multi-connection db");
        let store = WorkflowStore::new(pool);
        (temporary, WorkflowCore::new(store.clone()), store)
    }

    fn definition() -> WorkflowDefinition {
        let agent = |id: &str, depends_on: &[&str]| WorkflowStep {
            id: id.to_string(),
            depends_on: depends_on.iter().map(|value| value.to_string()).collect(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Agent(AgentStepSpec {
                agent_id: "codex".to_string(),
                prompt: format!("run {id}"),
                output_schema: None,
                workspace_access: WorkspaceAccess::ReadOnlyShared,
                side_effect_class: SideEffectClass::ReadOnly,
                allow_one_repair: false,
                allow_skip_on_review: false,
            }),
        };
        WorkflowDefinition {
            format_version: 1,
            name: "release".to_string(),
            description: None,
            input_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["repo"],
                "properties": {"repo": {"type": "string"}},
                "additionalProperties": false
            })),
            steps: vec![
                agent("build", &[]),
                agent("test", &[]),
                WorkflowStep {
                    id: "approve".to_string(),
                    depends_on: vec!["build".to_string(), "test".to_string()],
                    phase: None,
                    input_bindings: BTreeMap::new(),
                    spec: WorkflowStepSpec::Approval(ApprovalStepSpec {
                        title: "Ship?".to_string(),
                        decision_schema: serde_json::json!({
                            "type": "object",
                            "required": ["approved"],
                            "properties": {"approved": {"type": "boolean"}},
                            "additionalProperties": false
                        }),
                        approver_scope: "workflow.approve".to_string(),
                        skippable: false,
                    }),
                },
                agent("ship", &["approve"]),
            ],
            policy: WorkflowPolicy::default(),
        }
    }

    async fn publish_and_start(core: &WorkflowCore) -> (WorkflowVersionView, WorkflowRunView) {
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition: definition(),
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        core.store.enable_dispatch(run.id).await.unwrap();
        (version, run)
    }

    #[tokio::test]
    async fn publish_and_start_are_idempotent_and_payload_bound() {
        let (core, _) = setup().await;
        let publish_operation = Uuid::new_v4();
        let request = PublishWorkflow {
            definition_id: None,
            definition: definition(),
            operation_id: publish_operation,
            principal: serde_json::json!({"id": "owner"}),
        };
        let first = core.publish(request.clone()).await.unwrap();
        let retry = core.publish(request).await.unwrap();
        assert_eq!(first.id, retry.id);

        let operation = Uuid::new_v4();
        let start = StartWorkflow {
            definition_version_id: first.id,
            workspace_id: Uuid::new_v4(),
            input: serde_json::json!({"repo": "vibex"}),
            policy_override: None,
            operation_id: operation,
            principal: serde_json::json!({"id": "owner"}),
        };
        let workspace_id = start.workspace_id;
        let run = core.start(start.clone()).await.unwrap();
        assert_eq!(core.start(start).await.unwrap().id, run.id);
        let conflict = core
            .start(StartWorkflow {
                input: serde_json::json!({"repo": "other"}),
                operation_id: operation,
                definition_version_id: first.id,
                workspace_id,
                policy_override: None,
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap_err();
        assert!(matches!(conflict, WorkflowError::Conflict(_)));
    }

    #[tokio::test]
    async fn run_input_and_approval_output_obey_persisted_byte_limits() {
        let (core, _) = setup().await;
        let mut approval_definition = definition();
        approval_definition.steps = vec![WorkflowStep {
            id: "approve".to_string(),
            depends_on: Vec::new(),
            phase: None,
            input_bindings: BTreeMap::new(),
            spec: WorkflowStepSpec::Approval(ApprovalStepSpec {
                title: "Approve".to_string(),
                decision_schema: serde_json::json!({
                    "type": "object",
                    "required": ["note"],
                    "properties": {
                        "note": {"type": "string", "maxLength": 4096}
                    },
                    "additionalProperties": false
                }),
                approver_scope: "workflow.approve".to_string(),
                skippable: false,
            }),
        }];
        approval_definition.policy.max_output_bytes = 1024;
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition: approval_definition,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();

        let oversized_decision = core
            .decide(DecideApproval {
                run_id: run.id,
                step_id: "approve".to_string(),
                decision: serde_json::json!({"note": "x".repeat(1025)}),
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({
                    "id": "human",
                    "scopes": ["workflow.approve"]
                }),
            })
            .await
            .unwrap_err();
        assert!(
            oversized_decision
                .to_string()
                .contains("exceeds 1024 bytes")
        );

        let oversized_input = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "x".repeat(4 * 1024 * 1024)}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap_err();
        assert!(oversized_input.to_string().contains("input exceeds"));
    }

    #[tokio::test]
    async fn child_interaction_waiting_is_a_summary_projection_and_does_not_block_other_ready_steps()
     {
        let (core, store) = setup().await;
        let mut isolated = definition();
        for step in &mut isolated.steps {
            if let WorkflowStepSpec::Agent(agent) = &mut step.spec {
                agent.workspace_access = WorkspaceAccess::WriteIsolated;
                agent.side_effect_class = SideEffectClass::MutatingUnknown;
            }
        }
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition: isolated,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        store.enable_dispatch(run.id).await.unwrap();
        let first = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        store
            .mark_started(
                run.id,
                &first.step.step_id,
                first.claim_token,
                Some(conversation_id),
                Some(turn_id),
            )
            .await
            .unwrap();

        assert!(
            store
                .set_interaction_waiting(run.id, &first.step.step_id, true)
                .await
                .unwrap()
        );
        assert_eq!(store.run(run.id).await.unwrap().status, "waiting");
        let waiting = store
            .steps(run.id)
            .await
            .unwrap()
            .into_iter()
            .find(|step| step.step_id == first.step.step_id)
            .unwrap();
        assert!(waiting.waiting_interaction);

        let parallel = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .expect("a different ready root remains dispatchable");
        assert_ne!(parallel.step.step_id, first.step.step_id);

        assert!(
            store
                .set_interaction_waiting(run.id, &first.step.step_id, false)
                .await
                .unwrap()
        );
        assert_eq!(store.run(run.id).await.unwrap().status, "running");
        store.rebuild_run_projection(run.id).await.unwrap();
        assert_eq!(store.run(run.id).await.unwrap().status, "running");
        let rebuilt = store
            .steps(run.id)
            .await
            .unwrap()
            .into_iter()
            .find(|step| step.step_id == first.step.step_id)
            .unwrap();
        assert!(!rebuilt.waiting_interaction);
    }

    #[tokio::test]
    async fn completed_step_with_unknown_runtime_evidence_requires_review() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claim = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        let definition_step = claim
            .definition
            .steps
            .iter()
            .find(|step| step.id == claim.step.step_id)
            .unwrap();
        let resolved = store
            .resolve_step_input(run.id, definition_step)
            .await
            .unwrap();
        store
            .prepare_step(
                run.id,
                definition_step,
                claim.claim_token,
                &resolved,
                run.workspace_id,
                &serde_json::json!({
                    "isolated": false,
                    "workspaceId": run.workspace_id,
                }),
            )
            .await
            .unwrap();
        store
            .mark_started(run.id, &claim.step.step_id, claim.claim_token, None, None)
            .await
            .unwrap();
        core.complete_step(CompleteWorkflowStep {
            run_id: run.id,
            step_id: claim.step.step_id.clone(),
            output: None,
        })
        .await
        .unwrap();

        assert_eq!(store.reconcile_completed_evidence().await.unwrap(), 1);
        assert_eq!(store.run(run.id).await.unwrap().status, "needs_review");
    }

    #[tokio::test]
    async fn completed_upstream_step_is_reused_only_while_persisted_evidence_matches() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claim = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        let definition_step = claim
            .definition
            .steps
            .iter()
            .find(|step| step.id == claim.step.step_id)
            .unwrap();
        let resolved = store
            .resolve_step_input(run.id, definition_step)
            .await
            .unwrap();
        store
            .prepare_step(
                run.id,
                definition_step,
                claim.claim_token,
                &resolved,
                run.workspace_id,
                &serde_json::json!({
                    "isolated": false,
                    "workspaceId": run.workspace_id,
                }),
            )
            .await
            .unwrap();
        store
            .mark_started(run.id, &claim.step.step_id, claim.claim_token, None, None)
            .await
            .unwrap();
        core.complete_step(CompleteWorkflowStep {
            run_id: run.id,
            step_id: claim.step.step_id.clone(),
            output: None,
        })
        .await
        .unwrap();

        let evidence_json: String = sqlx::query_scalar(
            "SELECT execution_evidence_json FROM workflow_step_runs
             WHERE run_id = ? AND step_id = ?",
        )
        .bind(run.id)
        .bind(&claim.step.step_id)
        .fetch_one(store.pool())
        .await
        .unwrap();
        let mut evidence: serde_json::Value = serde_json::from_str(&evidence_json).unwrap();
        evidence["runtimeVersion"] =
            serde_json::json!({ "available": true, "value": "test-runtime-1" });
        evidence["toolSetDigest"] =
            serde_json::json!({ "available": true, "digest": "test-tools" });
        evidence["workspaceCheckpoint"] =
            serde_json::json!({ "available": true, "digest": "test-checkpoint" });
        sqlx::query(
            "UPDATE workflow_step_runs SET execution_evidence_json = ?
             WHERE run_id = ? AND step_id = ?",
        )
        .bind(serde_json::to_string(&evidence).unwrap())
        .bind(run.id)
        .bind(&claim.step.step_id)
        .execute(store.pool())
        .await
        .unwrap();

        assert_eq!(store.reconcile_completed_evidence().await.unwrap(), 0);
        sqlx::query(
            "UPDATE workflow_step_runs SET execution_evidence_json = '{\"definitionDigest\":\"tampered\"}'
             WHERE run_id = ? AND step_id = ?",
        )
        .bind(run.id)
        .bind(&claim.step.step_id)
        .execute(store.pool())
        .await
        .unwrap();
        assert_eq!(store.reconcile_completed_evidence().await.unwrap(), 1);
        assert_eq!(store.run(run.id).await.unwrap().status, "needs_review");
        let reviewed = store
            .steps(run.id)
            .await
            .unwrap()
            .into_iter()
            .find(|step| step.step_id == claim.step.step_id)
            .unwrap();
        assert_eq!(reviewed.status, "needs_review");
        assert!(
            store
                .events_since(run.id, 0, 1_000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.event_kind == "run_needs_review")
        );
    }

    #[tokio::test]
    async fn parallel_roots_then_approval_then_final_step_are_deterministic() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let mut steps = store.steps(run.id).await.unwrap();
        steps.sort_by(|left, right| left.step_id.cmp(&right.step_id));
        assert_eq!(
            steps
                .iter()
                .map(|step| (&step.step_id, step.typed_status().unwrap()))
                .collect::<Vec<_>>(),
            vec![
                (&"approve".to_string(), WorkflowStepStatus::Pending),
                (&"build".to_string(), WorkflowStepStatus::Ready),
                (&"ship".to_string(), WorkflowStepStatus::Pending),
                (&"test".to_string(), WorkflowStepStatus::Ready),
            ]
        );

        for expected in ["build", "test"] {
            let claimed = store
                .claim_ready(4, chrono::Duration::seconds(30))
                .await
                .unwrap()
                .expect("ready step");
            assert_eq!(claimed.step.step_id, expected);
            store
                .mark_started(run.id, expected, claimed.claim_token, None, None)
                .await
                .unwrap();
            core.complete_step(CompleteWorkflowStep {
                run_id: run.id,
                step_id: expected.to_string(),
                output: None,
            })
            .await
            .unwrap();
        }
        assert_eq!(
            store.run(run.id).await.unwrap().typed_status().unwrap(),
            WorkflowRunStatus::Waiting
        );
        let operation = Uuid::new_v4();
        core.decide(DecideApproval {
            run_id: run.id,
            step_id: "approve".to_string(),
            decision: serde_json::json!({"approved": true}),
            operation_id: operation,
            principal: serde_json::json!({"id": "human", "scopes": ["workflow.approve"]}),
        })
        .await
        .unwrap();
        let claimed = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .expect("ship ready");
        assert_eq!(claimed.step.step_id, "ship");
        store
            .mark_started(run.id, "ship", claimed.claim_token, None, None)
            .await
            .unwrap();
        core.complete_step(CompleteWorkflowStep {
            run_id: run.id,
            step_id: "ship".to_string(),
            output: None,
        })
        .await
        .unwrap();
        assert_eq!(
            store.run(run.id).await.unwrap().typed_status().unwrap(),
            WorkflowRunStatus::Completed
        );
    }

    #[tokio::test]
    async fn downstream_bindings_resolve_run_input_and_accepted_step_output() {
        let (core, store) = setup().await;
        let mut bindings = BTreeMap::new();
        bindings.insert(
            "repo".to_string(),
            crate::WorkflowBinding::RunInput {
                pointer: "/repo".to_string(),
            },
        );
        bindings.insert(
            "artifact".to_string(),
            crate::WorkflowBinding::StepOutput {
                step_id: "build".to_string(),
                pointer: "/artifact".to_string(),
            },
        );
        let definition = WorkflowDefinition {
            format_version: 1,
            name: "bindings".to_string(),
            description: None,
            input_schema: Some(serde_json::json!({
                "type": "object",
                "required": ["repo"],
                "properties": {"repo": {"type": "string"}}
            })),
            steps: vec![
                WorkflowStep {
                    id: "build".to_string(),
                    depends_on: Vec::new(),
                    phase: None,
                    input_bindings: BTreeMap::new(),
                    spec: WorkflowStepSpec::Agent(AgentStepSpec {
                        agent_id: "codex".to_string(),
                        prompt: "build".to_string(),
                        output_schema: Some(serde_json::json!({
                            "type": "object",
                            "required": ["artifact"],
                            "properties": {"artifact": {"type": "string"}}
                        })),
                        workspace_access: WorkspaceAccess::WriteSerialized,
                        side_effect_class: SideEffectClass::MutatingUnknown,
                        allow_one_repair: false,
                        allow_skip_on_review: false,
                    }),
                },
                WorkflowStep {
                    id: "ship".to_string(),
                    depends_on: vec!["build".to_string()],
                    phase: None,
                    input_bindings: bindings,
                    spec: WorkflowStepSpec::Agent(AgentStepSpec {
                        agent_id: "codex".to_string(),
                        prompt: "ship".to_string(),
                        output_schema: None,
                        workspace_access: WorkspaceAccess::WriteSerialized,
                        side_effect_class: SideEffectClass::MutatingUnknown,
                        allow_one_repair: false,
                        allow_skip_on_review: false,
                    }),
                },
            ],
            policy: WorkflowPolicy::default(),
        };
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        store.enable_dispatch(run.id).await.unwrap();
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(run.id, "build", claimed.claim_token, None, None)
            .await
            .unwrap();
        core.complete_step(CompleteWorkflowStep {
            run_id: run.id,
            step_id: "build".to_string(),
            output: Some(serde_json::json!({"artifact": "bundle.zip"})),
        })
        .await
        .unwrap();

        let definition = version.definition().unwrap();
        let ship = definition
            .steps
            .iter()
            .find(|step| step.id == "ship")
            .unwrap();
        let resolved = store.resolve_step_input(run.id, ship).await.unwrap();
        assert_eq!(resolved.values["repo"], "vibex");
        assert_eq!(resolved.values["artifact"], "bundle.zip");
        assert_eq!(resolved.digest.len(), 64);
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        let prepared = store
            .prepare_step(
                run.id,
                ship,
                claimed.claim_token,
                &resolved,
                run.workspace_id,
                &serde_json::json!({"isolated": false}),
            )
            .await
            .unwrap();
        store
            .prepare_step(
                run.id,
                ship,
                claimed.claim_token,
                &resolved,
                run.workspace_id,
                &serde_json::json!({"isolated": false}),
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .events_since(run.id, 0, 1_000)
                .await
                .unwrap()
                .iter()
                .filter(|event| event.event_kind == "step_prepared")
                .count(),
            1
        );
        assert_eq!(
            prepared.resolved_input_digest.as_deref(),
            Some(resolved.digest.as_str())
        );
        let evidence: serde_json::Value = serde_json::from_str(
            prepared
                .execution_evidence_json
                .as_deref()
                .expect("execution evidence"),
        )
        .unwrap();
        assert_eq!(evidence["definitionDigest"], version.digest);
        assert_eq!(evidence["workspaceCheckpoint"]["available"], false);
        let recorded = store
            .record_step_artifacts(
                run.id,
                "ship",
                &serde_json::json!({
                    "turnId": Uuid::new_v4(),
                    "fileChanges": [{"path": "release.txt", "changeKind": "added"}],
                    "autoMerge": false,
                }),
            )
            .await
            .unwrap();
        let evidence: serde_json::Value =
            serde_json::from_str(recorded.execution_evidence_json.as_deref().unwrap()).unwrap();
        assert_eq!(evidence["artifactHistory"][0]["autoMerge"], false);
        let oversized = store
            .record_step_artifacts(
                run.id,
                "ship",
                &serde_json::json!({"blob": "x".repeat(1024 * 1024)}),
            )
            .await
            .unwrap_err();
        assert!(oversized.to_string().contains("evidence exceeds"));
    }

    #[tokio::test]
    async fn event_log_rebuild_restores_run_step_ready_and_evidence_projections() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        let definition = claimed.definition.clone();
        let definition_step = definition
            .steps
            .iter()
            .find(|step| step.id == claimed.step.step_id)
            .unwrap();
        let resolved = store
            .resolve_step_input(run.id, definition_step)
            .await
            .unwrap();
        let step_workspace_id = Uuid::new_v4();
        store
            .prepare_step(
                run.id,
                definition_step,
                claimed.claim_token,
                &resolved,
                step_workspace_id,
                &serde_json::json!({"isolated": true, "head": "abc123"}),
            )
            .await
            .unwrap();
        let conversation_id = Uuid::new_v4();
        let first_turn_id = Uuid::new_v4();
        store
            .mark_started(
                run.id,
                &claimed.step.step_id,
                claimed.claim_token,
                Some(conversation_id),
                Some(first_turn_id),
            )
            .await
            .unwrap();
        assert!(
            store
                .begin_repair(run.id, &claimed.step.step_id)
                .await
                .unwrap()
        );
        let repair_turn_id = Uuid::new_v4();
        store
            .bind_turn(
                run.id,
                &claimed.step.step_id,
                conversation_id,
                repair_turn_id,
            )
            .await
            .unwrap();
        store
            .record_step_artifacts(
                run.id,
                &claimed.step.step_id,
                &serde_json::json!({"diff": "build.patch", "autoMerge": false}),
            )
            .await
            .unwrap();

        let before_run = store.run(run.id).await.unwrap();
        let before_steps = store.steps(run.id).await.unwrap();
        let before_ready_statuses = sqlx::query_scalar::<_, String>(
            "SELECT status FROM workflow_ready_steps WHERE run_id = ?
             ORDER BY step_id, attempt",
        )
        .bind(run.id)
        .fetch_all(store.pool())
        .await
        .unwrap();
        sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
            .bind(run.id)
            .execute(store.pool())
            .await
            .unwrap();
        sqlx::query(
            "UPDATE workflow_step_runs SET status = 'cancelled', conversation_id = NULL,
                    turn_id = NULL, resolved_input_json = NULL, resolved_input_digest = NULL,
                    execution_evidence_json = NULL, workspace_id = NULL, repair_count = 0
             WHERE run_id = ?",
        )
        .bind(run.id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE workflow_runs SET status = 'failed', agent_calls_started = 0,
                    last_sequence = 0 WHERE id = ?",
        )
        .bind(run.id)
        .execute(store.pool())
        .await
        .unwrap();

        store.rebuild_run_projection(run.id).await.unwrap();

        let after_run = store.run(run.id).await.unwrap();
        let after_steps = store.steps(run.id).await.unwrap();
        assert_eq!(after_run.status, before_run.status);
        assert_eq!(
            after_run.agent_calls_started,
            before_run.agent_calls_started
        );
        assert_eq!(after_run.last_sequence, before_run.last_sequence);
        assert_eq!(after_steps.len(), before_steps.len());
        for (after, before) in after_steps.iter().zip(before_steps.iter()) {
            assert_eq!(after.step_id, before.step_id);
            assert_eq!(after.attempt, before.attempt);
            assert_eq!(after.status, before.status);
            assert_eq!(after.conversation_id, before.conversation_id);
            assert_eq!(after.turn_id, before.turn_id);
            assert_eq!(after.resolved_input_json, before.resolved_input_json);
            assert_eq!(after.resolved_input_digest, before.resolved_input_digest);
            assert_eq!(
                after.execution_evidence_json,
                before.execution_evidence_json
            );
            assert_eq!(after.workspace_id, before.workspace_id);
            assert_eq!(after.repair_count, before.repair_count);
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT status FROM workflow_ready_steps WHERE run_id = ?
                 ORDER BY step_id, attempt"
            )
            .bind(run.id)
            .fetch_all(store.pool())
            .await
            .unwrap(),
            before_ready_statuses
        );
    }

    #[tokio::test]
    async fn restart_requeues_preflight_claim_but_never_running_work() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claimed = store
            .claim_ready(1, chrono::Duration::milliseconds(-1))
            .await
            .unwrap()
            .unwrap();
        let reclaimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reclaimed.step.step_id, claimed.step.step_id);
        store
            .mark_started(
                run.id,
                &reclaimed.step.step_id,
                reclaimed.claim_token,
                None,
                None,
            )
            .await
            .unwrap();

        assert_eq!(store.reconcile_interrupted().await.unwrap(), 1);
        assert_eq!(
            store.run(run.id).await.unwrap().typed_status().unwrap(),
            WorkflowRunStatus::NeedsReview
        );
        assert!(
            store
                .claim_ready(1, chrono::Duration::seconds(30))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn output_repair_is_single_use_and_consumes_the_call_budget() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(
                run.id,
                &claimed.step.step_id,
                claimed.claim_token,
                None,
                None,
            )
            .await
            .unwrap();

        assert!(
            store
                .begin_repair(run.id, &claimed.step.step_id)
                .await
                .unwrap()
        );
        assert!(
            !store
                .begin_repair(run.id, &claimed.step.step_id)
                .await
                .unwrap()
        );

        let repaired = store
            .steps(run.id)
            .await
            .unwrap()
            .into_iter()
            .find(|step| step.step_id == claimed.step.step_id)
            .unwrap();
        assert_eq!(repaired.repair_count, 1);
        assert_eq!(store.run(run.id).await.unwrap().agent_calls_started, 2);
    }

    #[tokio::test]
    async fn output_repair_fails_closed_when_call_budget_is_exhausted() {
        let (core, store) = setup().await;
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition: definition(),
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        let policy = WorkflowPolicy {
            max_agent_calls: 1,
            ..WorkflowPolicy::default()
        };
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: Some(policy),
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        store.enable_dispatch(run.id).await.unwrap();
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(
                run.id,
                &claimed.step.step_id,
                claimed.claim_token,
                None,
                None,
            )
            .await
            .unwrap();

        assert!(
            !store
                .begin_repair(run.id, &claimed.step.step_id)
                .await
                .unwrap()
        );
        assert_eq!(store.run(run.id).await.unwrap().agent_calls_started, 1);
    }

    #[tokio::test]
    async fn review_retry_creates_a_new_attempt_and_preserves_old_evidence() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(
                run.id,
                &claimed.step.step_id,
                claimed.claim_token,
                Some(Uuid::new_v4()),
                Some(Uuid::new_v4()),
            )
            .await
            .unwrap();
        store
            .needs_review_step(run.id, &claimed.step.step_id, "host restarted")
            .await
            .unwrap();

        let operation_id = Uuid::new_v4();
        let review = ReviewWorkflow {
            run_id: run.id,
            decision: WorkflowReviewDecision::Retry {
                step_id: claimed.step.step_id.clone(),
            },
            operation_id,
            principal: serde_json::json!({"id": "owner"}),
        };
        assert_eq!(
            core.review(review.clone())
                .await
                .unwrap()
                .typed_status()
                .unwrap(),
            WorkflowRunStatus::Running
        );
        core.review(review).await.unwrap();

        let attempts = store
            .steps(run.id)
            .await
            .unwrap()
            .into_iter()
            .filter(|step| step.step_id == claimed.step.step_id)
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].attempt, 1);
        assert_eq!(attempts[0].status, "needs_review");
        assert!(attempts[0].conversation_id.is_some());
        assert_eq!(attempts[1].attempt, 2);
        assert_eq!(attempts[1].status, "ready");

        let retried = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retried.step.step_id, claimed.step.step_id);
        assert_eq!(retried.step.attempt, 2);
    }

    #[tokio::test]
    async fn review_operation_id_is_payload_bound() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let claimed = store
            .claim_ready(1, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(
                run.id,
                &claimed.step.step_id,
                claimed.claim_token,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .needs_review_step(run.id, &claimed.step.step_id, "host restarted")
            .await
            .unwrap();
        let operation_id = Uuid::new_v4();
        core.review(ReviewWorkflow {
            run_id: run.id,
            decision: WorkflowReviewDecision::Retry {
                step_id: claimed.step.step_id.clone(),
            },
            operation_id,
            principal: serde_json::json!({"id": "owner"}),
        })
        .await
        .unwrap();
        let error = core
            .review(ReviewWorkflow {
                run_id: run.id,
                decision: WorkflowReviewDecision::Retry {
                    step_id: "different-step".to_string(),
                },
                operation_id,
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap_err();
        assert!(matches!(error, WorkflowError::Conflict(_)));
    }

    #[tokio::test]
    async fn potential_writers_are_serialized_per_workspace() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let first = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(run.id, &first.step.step_id, first.claim_token, None, None)
            .await
            .unwrap();

        assert!(
            store
                .claim_ready(4, chrono::Duration::seconds(30))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sqlite_multi_connection_step_claim_stress_has_one_winner() {
        let (_temporary, core, store) = setup_multi_connection().await;
        let (_, run) = publish_and_start(&core).await;

        let mut claims = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let store = store.clone();
            claims.spawn(async move { store.claim_ready(1, chrono::Duration::seconds(30)).await });
        }
        let mut winners = Vec::new();
        while let Some(result) = claims.join_next().await {
            if let Some(claim) = result.expect("claim task").expect("claim query") {
                winners.push(claim);
            }
        }
        assert_eq!(winners.len(), 1);

        let claimed_events = store
            .events_since(run.id, 0, 1_000)
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.event_kind == "step_claimed")
            .count();
        assert_eq!(claimed_events, 1);
    }

    #[tokio::test]
    async fn explicit_isolated_writers_can_be_claimed_in_parallel() {
        let (core, store) = setup().await;
        let mut definition = definition();
        for step in &mut definition.steps {
            if matches!(step.id.as_str(), "build" | "test")
                && let WorkflowStepSpec::Agent(agent) = &mut step.spec
            {
                agent.workspace_access = WorkspaceAccess::WriteIsolated;
                agent.side_effect_class = SideEffectClass::MutatingUnknown;
            }
        }
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        store.enable_dispatch(run.id).await.unwrap();
        let first = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        store
            .mark_started(run.id, &first.step.step_id, first.claim_token, None, None)
            .await
            .unwrap();
        let second = store
            .claim_ready(4, chrono::Duration::seconds(30))
            .await
            .unwrap()
            .expect("isolated writer remains claimable");

        assert_ne!(first.step.step_id, second.step.step_id);
    }

    #[tokio::test]
    async fn retention_deletes_only_old_terminal_runs() {
        let (core, store) = setup().await;
        let (version, terminal) = publish_and_start(&core).await;
        let review = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({"repo": "vibex"}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "owner"}),
            })
            .await
            .unwrap();
        sqlx::query(
            "UPDATE workflow_runs SET status = 'completed', updated_at = datetime('now', '-31 days')
             WHERE id = ?",
        )
        .bind(terminal.id)
        .execute(store.pool())
        .await
        .unwrap();
        let isolated_workspace_id = Uuid::new_v4();
        sqlx::query(
            "UPDATE workflow_step_runs SET workspace_id = ?
             WHERE run_id = ? AND step_id = 'build'",
        )
        .bind(isolated_workspace_id)
        .bind(terminal.id)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE workflow_runs SET status = 'needs_review', updated_at = datetime('now', '-31 days')
             WHERE id = ?",
        )
        .bind(review.id)
        .execute(store.pool())
        .await
        .unwrap();

        let candidates = store
            .retention_candidates(chrono::Utc::now() - chrono::Duration::days(30), 100)
            .await
            .unwrap();
        assert_eq!(
            candidates[0].isolated_workspace_ids,
            vec![isolated_workspace_id]
        );
        let deleted = store
            .cleanup_terminal_before(chrono::Utc::now() - chrono::Duration::days(30), 100)
            .await
            .unwrap();

        assert_eq!(deleted, vec![terminal.id]);
        assert!(matches!(
            store.run(terminal.id).await,
            Err(WorkflowError::NotFound(_))
        ));
        assert_eq!(store.run(review.id).await.unwrap().status, "needs_review");
    }

    #[tokio::test]
    #[ignore = "fixed-fixture capacity gate; run explicitly before release"]
    async fn validates_and_materializes_one_thousand_ready_steps_within_budget() {
        let (core, store) = setup().await;
        let steps = (0..1_000)
            .map(|index| WorkflowStep {
                id: format!("step-{index:04}"),
                depends_on: Vec::new(),
                phase: Some("capacity".to_string()),
                input_bindings: BTreeMap::new(),
                spec: WorkflowStepSpec::Agent(AgentStepSpec {
                    agent_id: "codex".to_string(),
                    prompt: "inspect".to_string(),
                    output_schema: None,
                    workspace_access: WorkspaceAccess::ReadOnlyShared,
                    side_effect_class: SideEffectClass::ReadOnly,
                    allow_one_repair: false,
                    allow_skip_on_review: false,
                }),
            })
            .collect();
        let definition = WorkflowDefinition {
            format_version: 1,
            name: "one-thousand-step-capacity".to_string(),
            description: None,
            input_schema: Some(serde_json::json!({"type": "object"})),
            steps,
            policy: WorkflowPolicy {
                max_concurrent_agent_steps: 64,
                max_agent_calls: 1_000,
                ..WorkflowPolicy::default()
            },
        };

        let started = std::time::Instant::now();
        core.validate(definition.clone()).unwrap();
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "capacity"}),
            })
            .await
            .unwrap();
        let run = core
            .start(StartWorkflow {
                definition_version_id: version.id,
                workspace_id: Uuid::new_v4(),
                input: serde_json::json!({}),
                policy_override: None,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "capacity"}),
            })
            .await
            .unwrap();
        store.enable_dispatch(run.id).await.unwrap();
        let ready: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workflow_ready_steps WHERE run_id = ? AND status = 'ready'",
        )
        .bind(run.id)
        .fetch_one(store.pool())
        .await
        .unwrap();
        let elapsed = started.elapsed();

        assert_eq!(ready, 1_000);
        assert!(
            elapsed < StdDuration::from_secs(10),
            "1k-step validation/materialization exceeded 10s: {elapsed:?}"
        );
        eprintln!(
            "workflow_capacity steps=1000 ready=1000 elapsed_ms={}",
            elapsed.as_millis()
        );
    }

    #[tokio::test]
    #[ignore = "fixed-fixture capacity gate; run explicitly before release"]
    async fn dispatches_one_hundred_active_runs_without_starvation() {
        let (core, store) = setup().await;
        let mut single = definition();
        single.name = "fair-dispatch-capacity".to_string();
        single.steps.truncate(1);
        single.policy.max_concurrent_agent_steps = 1;
        single.policy.max_agent_calls = 1;
        let version = core
            .publish(PublishWorkflow {
                definition_id: None,
                definition: single,
                operation_id: Uuid::new_v4(),
                principal: serde_json::json!({"id": "capacity"}),
            })
            .await
            .unwrap();
        let started = std::time::Instant::now();
        let mut expected = std::collections::BTreeSet::new();
        for _ in 0..100 {
            let run = core
                .start(StartWorkflow {
                    definition_version_id: version.id,
                    workspace_id: Uuid::new_v4(),
                    input: serde_json::json!({"repo": "vibex"}),
                    policy_override: None,
                    operation_id: Uuid::new_v4(),
                    principal: serde_json::json!({"id": "capacity"}),
                })
                .await
                .unwrap();
            store.enable_dispatch(run.id).await.unwrap();
            expected.insert(run.id);
        }
        let mut observed = std::collections::BTreeSet::new();
        for _ in 0..100 {
            let claim = store
                .claim_ready(1, chrono::Duration::seconds(30))
                .await
                .unwrap()
                .expect("each active run must eventually be claimable");
            observed.insert(claim.run.id);
            store
                .mark_started(
                    claim.run.id,
                    &claim.step.step_id,
                    claim.claim_token,
                    None,
                    None,
                )
                .await
                .unwrap();
            core.complete_step(CompleteWorkflowStep {
                run_id: claim.run.id,
                step_id: claim.step.step_id,
                output: None,
            })
            .await
            .unwrap();
        }
        let elapsed = started.elapsed();

        assert_eq!(observed, expected);
        assert!(
            elapsed < StdDuration::from_secs(15),
            "100-run fair dispatch exceeded 15s: {elapsed:?}"
        );
        eprintln!(
            "workflow_capacity active_runs=100 dispatched=100 elapsed_ms={}",
            elapsed.as_millis()
        );
    }

    #[tokio::test]
    #[ignore = "fixed-fixture capacity gate; run explicitly before release"]
    async fn pages_a_ten_thousand_event_history_without_loading_the_full_log() {
        let (core, store) = setup().await;
        let (_, run) = publish_and_start(&core).await;
        let base_sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), 0) FROM workflow_events WHERE run_id = ?",
        )
        .bind(run.id)
        .fetch_one(store.pool())
        .await
        .unwrap();
        let mut connection = store.pool().acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .unwrap();
        for offset in 1..=10_000_i64 {
            sqlx::query(
                "INSERT INTO workflow_events (
                     id, run_id, sequence, event_version, event_kind, payload_json
                 ) VALUES (?, ?, ?, 999, 'capacity_probe', '{}')",
            )
            .bind(Uuid::new_v4())
            .bind(run.id)
            .bind(base_sequence + offset)
            .execute(&mut *connection)
            .await
            .unwrap();
        }
        sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);

        let started = std::time::Instant::now();
        let first_screen = store.events_since(run.id, 0, 200).await.unwrap();
        let incremental = store
            .events_since(run.id, base_sequence + 9_800, 200)
            .await
            .unwrap();
        let elapsed = started.elapsed();

        assert_eq!(first_screen.len(), 200);
        assert_eq!(incremental.len(), 200);
        assert!(
            elapsed < StdDuration::from_secs(1),
            "10k-event indexed pages exceeded 1s: {elapsed:?}"
        );
        eprintln!(
            "workflow_capacity events=10000 pages=2 page_size=200 elapsed_ms={}",
            elapsed.as_millis()
        );
    }
}
