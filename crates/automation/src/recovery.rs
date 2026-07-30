use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{ClaimedRun, Clock, EngineError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartupRecoveryReport {
    pub interrupted_run_ids: Vec<Uuid>,
    pub catch_up_runs: Vec<ClaimedRun>,
}

#[async_trait]
pub trait RecoveryStorePort: Clone + Send + Sync + 'static {
    /// Atomically settles every orphaned running row as interrupted.
    async fn interrupt_running(&self, now: DateTime<Utc>) -> Result<Vec<Uuid>, EngineError>;

    /// Atomically advances each due schedule from `now` and returns at most one
    /// catch-up row per Automation.
    async fn claim_catch_up(&self, now: DateTime<Utc>) -> Result<Vec<ClaimedRun>, EngineError>;
}

#[derive(Clone, Debug)]
pub struct StartupReconciler<S, C> {
    store: S,
    clock: C,
}

impl<S, C> StartupReconciler<S, C>
where
    S: RecoveryStorePort,
    C: Clock,
{
    pub fn new(store: S, clock: C) -> Self {
        Self { store, clock }
    }

    pub async fn reconcile(&self) -> Result<StartupRecoveryReport, EngineError> {
        let now = self.clock.now();
        let interrupted_run_ids = self.store.interrupt_running(now).await?;
        let catch_up_runs = self.store.claim_catch_up(now).await?;
        Ok(StartupRecoveryReport {
            interrupted_run_ids,
            catch_up_runs,
        })
    }
}
