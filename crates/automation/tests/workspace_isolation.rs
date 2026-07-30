use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use automation::{
    GitWorkspacePort, IsolationSpec, PreparedWorkspace, SharedRootState, WorkspaceError,
    WorkspacePreparationRequest, WorkspaceService, WorkspaceTarget,
};
use uuid::Uuid;

type WorktreeCall = (String, Option<String>, String);

#[derive(Clone, Default)]
struct FakeGit {
    worktrees: Arc<Mutex<Vec<WorktreeCall>>>,
    shared_state: Arc<Mutex<Option<SharedRootState>>>,
}

impl FakeGit {
    fn shared(state: SharedRootState) -> Self {
        Self {
            worktrees: Arc::default(),
            shared_state: Arc::new(Mutex::new(Some(state))),
        }
    }
}

#[async_trait]
impl GitWorkspacePort for FakeGit {
    async fn create_worktree(
        &self,
        root_folder: &str,
        base_branch: Option<&str>,
        run_branch: &str,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        self.worktrees.lock().unwrap().push((
            root_folder.to_string(),
            base_branch.map(ToOwned::to_owned),
            run_branch.to_string(),
        ));
        Ok(PreparedWorkspace {
            workspace_id: Uuid::new_v4(),
            root_folder: format!("{root_folder}-{run_branch}"),
            branch: run_branch.to_string(),
        })
    }

    async fn shared_root_state(
        &self,
        _root_folder: &str,
    ) -> Result<SharedRootState, WorkspaceError> {
        self.shared_state
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| WorkspaceError::Adapter("unexpected shared-root probe".to_string()))
    }
}

#[tokio::test]
async fn dirty_shared_root_is_rejected_before_execution() {
    let service = WorkspaceService::new(FakeGit::shared(SharedRootState {
        clean: false,
        current_branch: "main".to_string(),
    }));
    let request = WorkspacePreparationRequest {
        automation_id: Uuid::new_v4(),
        run_id: Uuid::new_v4(),
        target: WorkspaceTarget {
            project_id: Uuid::new_v4(),
            root_folder: "/repo/vibex".to_string(),
            branch: Some("main".to_string()),
            isolation: IsolationSpec::SharedInRoot,
        },
    };

    let error = service
        .prepare(&request)
        .await
        .expect_err("dirty root must fail");

    assert_eq!(error, WorkspaceError::DirtySharedRoot);
    assert_eq!(error.code(), "automation_shared_root_dirty");
}

#[tokio::test]
async fn shared_root_on_the_wrong_branch_is_rejected() {
    let service = WorkspaceService::new(FakeGit::shared(SharedRootState {
        clean: true,
        current_branch: "feature/unreviewed".to_string(),
    }));
    let request = WorkspacePreparationRequest {
        automation_id: Uuid::new_v4(),
        run_id: Uuid::new_v4(),
        target: WorkspaceTarget {
            project_id: Uuid::new_v4(),
            root_folder: "/repo/vibex".to_string(),
            branch: Some("main".to_string()),
            isolation: IsolationSpec::SharedInRoot,
        },
    };

    let error = service
        .prepare(&request)
        .await
        .expect_err("wrong branch must fail");

    assert_eq!(
        error,
        WorkspaceError::WrongBranch {
            expected: "main".to_string(),
            actual: "feature/unreviewed".to_string(),
        }
    );
    assert_eq!(error.code(), "automation_shared_root_wrong_branch");
}

#[tokio::test]
async fn default_isolation_creates_the_versioned_run_worktree() {
    let git = FakeGit::default();
    let service = WorkspaceService::new(git.clone());
    let automation_id = Uuid::parse_str("da38b89b-f632-49ca-aaf5-7fd93de34f7b").unwrap();
    let run_id = Uuid::parse_str("8fe3d572-2e15-4538-a28b-56a065c1bef0").unwrap();
    let request = WorkspacePreparationRequest {
        automation_id,
        run_id,
        target: WorkspaceTarget {
            project_id: Uuid::new_v4(),
            root_folder: "/repo/vibex".to_string(),
            branch: Some("main".to_string()),
            isolation: IsolationSpec::WorktreePerRun,
        },
    };

    let prepared = service.prepare(&request).await.expect("prepare worktree");

    let expected_branch = format!("automation/{automation_id}/run-{run_id}");
    assert_eq!(prepared.branch, expected_branch);
    assert_eq!(
        git.worktrees.lock().unwrap().as_slice(),
        &[(
            "/repo/vibex".to_string(),
            Some("main".to_string()),
            expected_branch
        )]
    );
}
