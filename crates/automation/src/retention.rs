use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::RunStatus;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetentionPolicy {
    pub max_age: Duration,
    pub max_total_bytes: u64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            max_age: Duration::days(30),
            max_total_bytes: 10 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetainedRun {
    pub run_id: Uuid,
    pub status: RunStatus,
    pub finished_at: Option<DateTime<Utc>>,
    pub workspace_id: Option<Uuid>,
    pub storage_bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionReport {
    pub deleted_run_ids: Vec<Uuid>,
    pub deferred_run_ids: Vec<Uuid>,
    pub retained_bytes: u64,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RetentionError {
    #[error("automation retention store failed: {0}")]
    Store(String),
    #[error("automation retained workspace cleanup failed: {0}")]
    Workspace(String),
}

impl RetentionError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Store(_) => "automation_retention_store_failed",
            Self::Workspace(_) => "automation_retention_workspace_failed",
        }
    }
}

#[async_trait]
pub trait RetentionStorePort: Clone + Send + Sync + 'static {
    async fn terminal_runs_oldest_first(&self) -> Result<Vec<RetainedRun>, RetentionError>;
    async fn delete_run(&self, run_id: Uuid) -> Result<(), RetentionError>;
}

#[async_trait]
pub trait WorkspaceRetentionPort: Clone + Send + Sync + 'static {
    async fn release_retained_workspace(&self, workspace_id: Uuid) -> Result<(), RetentionError>;
}

#[derive(Clone)]
pub struct AutomationRetentionService<S, W> {
    store: S,
    workspaces: W,
    policy: RetentionPolicy,
}

impl<S, W> AutomationRetentionService<S, W>
where
    S: RetentionStorePort,
    W: WorkspaceRetentionPort,
{
    pub fn new(store: S, workspaces: W, policy: RetentionPolicy) -> Self {
        Self {
            store,
            workspaces,
            policy,
        }
    }

    pub async fn enforce(&self, now: DateTime<Utc>) -> Result<RetentionReport, RetentionError> {
        let runs = self
            .store
            .terminal_runs_oldest_first()
            .await?
            .into_iter()
            .filter(|run| run.status != RunStatus::Running)
            .collect::<Vec<_>>();
        let mut retained_bytes = runs
            .iter()
            .fold(0_u64, |total, run| total.saturating_add(run.storage_bytes));
        let expiry = now - self.policy.max_age;
        let mut report = RetentionReport::default();

        for run in runs {
            let expired = run.finished_at.is_some_and(|finished| finished <= expiry);
            if !expired && retained_bytes <= self.policy.max_total_bytes {
                continue;
            }
            if let Some(workspace_id) = run.workspace_id
                && self
                    .workspaces
                    .release_retained_workspace(workspace_id)
                    .await
                    .is_err()
            {
                report.deferred_run_ids.push(run.run_id);
                continue;
            }
            if self.store.delete_run(run.run_id).await.is_err() {
                report.deferred_run_ids.push(run.run_id);
                continue;
            }
            retained_bytes = retained_bytes.saturating_sub(run.storage_bytes);
            report.deleted_run_ids.push(run.run_id);
        }

        report.retained_bytes = retained_bytes;
        Ok(report)
    }
}
