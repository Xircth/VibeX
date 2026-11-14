use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, Weak},
};

use db::models::workspace::Workspace;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Default, Serialize, Deserialize)]
pub struct WorkspaceInitialization {
    pub phase: String,
    pub completed_repos: Vec<Uuid>,
    pub include_uncommitted: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub copied_repos: Vec<Uuid>,
}

pub async fn initialization_status(
    workspace: &Workspace,
) -> Result<WorkspaceInitialization, super::settings_store::SettingsStoreError> {
    let Some(root) = workspace.container_ref.as_deref() else {
        return Ok(WorkspaceInitialization {
            phase: "pending".into(),
            ..Default::default()
        });
    };
    let journal = std::path::Path::new(root).join(".vibex-initialization.json");
    Ok(
        super::settings_store::read_section(&journal, "initialization")
            .await?
            .unwrap_or_else(|| WorkspaceInitialization {
                phase: if workspace.use_worktree {
                    "existing"
                } else {
                    "project_root"
                }
                .into(),
                ..Default::default()
            }),
    )
}

static OPERATIONS: LazyLock<Mutex<HashMap<Uuid, Weak<RwLock<()>>>>> = LazyLock::new(Mutex::default);
static INITIALIZATIONS: LazyLock<Mutex<HashMap<Uuid, tokio_util::sync::CancellationToken>>> =
    LazyLock::new(Mutex::default);

pub struct InitializationRun(Uuid);

impl InitializationRun {
    pub fn begin(id: Uuid) -> Self {
        INITIALIZATIONS
            .lock()
            .expect("initializations")
            .insert(id, tokio_util::sync::CancellationToken::new());
        Self(id)
    }
}

impl Drop for InitializationRun {
    fn drop(&mut self) {
        if let Some(token) = INITIALIZATIONS
            .lock()
            .expect("initializations")
            .remove(&self.0)
        {
            token.cancel();
        }
    }
}

pub fn cancel_initialization(id: Uuid) -> bool {
    let runs = INITIALIZATIONS.lock().expect("initializations");
    if let Some(token) = runs.get(&id) {
        token.cancel();
        true
    } else {
        false
    }
}

pub fn initialization_cancellation(id: Uuid) -> tokio_util::sync::CancellationToken {
    INITIALIZATIONS
        .lock()
        .expect("initializations")
        .get(&id)
        .cloned()
        .unwrap_or_default()
}

pub fn initialization_is_active(id: Uuid) -> bool {
    INITIALIZATIONS
        .lock()
        .expect("initializations")
        .contains_key(&id)
}

/// Initialization/deletion take a write permit; committing a turn takes a read
/// permit until its active state is durable. Keep the Arc alive with the permit.
pub fn workspace_operation(id: Uuid) -> Arc<RwLock<()>> {
    let mut operations = OPERATIONS.lock().expect("workspace operation registry");
    operations.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = operations.get(&id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(RwLock::new(()));
    operations.insert(id, Arc::downgrade(&lock));
    lock
}
