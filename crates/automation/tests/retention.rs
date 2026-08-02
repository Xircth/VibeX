use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use automation::{
    AutomationRetentionService, RetainedRun, RetentionError, RetentionPolicy, RetentionStorePort,
    RunStatus, WorkspaceRetentionPort,
};
use chrono::{TimeZone, Utc};
use uuid::Uuid;

#[derive(Clone, Default)]
struct FakeRetentionStore {
    runs: Arc<Mutex<Vec<RetainedRun>>>,
}

#[async_trait]
impl RetentionStorePort for FakeRetentionStore {
    async fn terminal_runs_oldest_first(&self) -> Result<Vec<RetainedRun>, RetentionError> {
        Ok(self.runs.lock().expect("runs").clone())
    }

    async fn delete_run(&self, run_id: Uuid) -> Result<(), RetentionError> {
        self.runs
            .lock()
            .expect("runs")
            .retain(|run| run.run_id != run_id);
        Ok(())
    }
}

#[derive(Clone, Default)]
struct FakeWorkspaces {
    failures: Arc<Mutex<BTreeSet<Uuid>>>,
    released: Arc<Mutex<Vec<Uuid>>>,
}

#[async_trait]
impl WorkspaceRetentionPort for FakeWorkspaces {
    async fn release_retained_workspace(&self, workspace_id: Uuid) -> Result<(), RetentionError> {
        if self
            .failures
            .lock()
            .expect("failures")
            .contains(&workspace_id)
        {
            return Err(RetentionError::Workspace(
                "fixture cleanup failure".to_string(),
            ));
        }
        self.released.lock().expect("released").push(workspace_id);
        Ok(())
    }
}

#[tokio::test]
async fn retention_expires_old_runs_and_enforces_quota_without_touching_running_work() {
    let now = Utc.with_ymd_and_hms(2026, 7, 31, 5, 0, 0).unwrap();
    let old_id = Uuid::new_v4();
    let quota_id = Uuid::new_v4();
    let newest_id = Uuid::new_v4();
    let running_id = Uuid::new_v4();
    let failed_cleanup_id = Uuid::new_v4();
    let failed_workspace = Uuid::new_v4();
    let workspaces = FakeWorkspaces::default();
    workspaces
        .failures
        .lock()
        .expect("failures")
        .insert(failed_workspace);
    let store = FakeRetentionStore {
        runs: Arc::new(Mutex::new(vec![
            RetainedRun {
                run_id: old_id,
                status: RunStatus::Completed,
                finished_at: Some(now - chrono::Duration::days(31)),
                workspace_id: Some(Uuid::new_v4()),
                storage_bytes: 60,
            },
            RetainedRun {
                run_id: failed_cleanup_id,
                status: RunStatus::Failed,
                finished_at: Some(now - chrono::Duration::days(30)),
                workspace_id: Some(failed_workspace),
                storage_bytes: 10,
            },
            RetainedRun {
                run_id: quota_id,
                status: RunStatus::Completed,
                finished_at: Some(now - chrono::Duration::days(2)),
                workspace_id: Some(Uuid::new_v4()),
                storage_bytes: 60,
            },
            RetainedRun {
                run_id: newest_id,
                status: RunStatus::Completed,
                finished_at: Some(now - chrono::Duration::days(1)),
                workspace_id: Some(Uuid::new_v4()),
                storage_bytes: 50,
            },
            RetainedRun {
                run_id: running_id,
                status: RunStatus::Running,
                finished_at: None,
                workspace_id: Some(Uuid::new_v4()),
                storage_bytes: 1_000,
            },
        ])),
    };
    let service = AutomationRetentionService::new(
        store.clone(),
        workspaces,
        RetentionPolicy {
            max_age: chrono::Duration::days(30),
            max_total_bytes: 100,
        },
    );

    let report = service.enforce(now).await.expect("retention report");

    assert_eq!(report.deleted_run_ids, vec![old_id, quota_id]);
    assert_eq!(report.deferred_run_ids, vec![failed_cleanup_id]);
    assert_eq!(report.retained_bytes, 60);
    assert!(!report.deleted_run_ids.contains(&running_id));
    assert!(!report.deleted_run_ids.contains(&newest_id));
}
