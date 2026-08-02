use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::Clock;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum EngineError {
    #[error("automation engine owner lock failed: {0}")]
    OwnerLock(String),
    #[error("automation claim store failed: {0}")]
    ClaimStore(String),
    #[error("automation recovery store failed: {0}")]
    RecoveryStore(String),
}

impl EngineError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::OwnerLock(_) => "automation_owner_lock_failed",
            Self::ClaimStore(_) => "automation_claim_store_failed",
            Self::RecoveryStore(_) => "automation_recovery_store_failed",
        }
    }
}

#[async_trait]
pub trait OwnerLockPort: Clone + Send + Sync + 'static {
    type Lease: Send + Sync + 'static;

    async fn try_acquire(&self, data_dir_key: &str) -> Result<Option<Self::Lease>, EngineError>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedRun {
    pub run_id: Uuid,
    pub automation_id: Uuid,
    pub scheduled_for: DateTime<Utc>,
    pub next_run_at: Option<DateTime<Utc>>,
}

#[async_trait]
pub trait ClaimStorePort: Clone + Send + Sync + 'static {
    /// Atomically advances the due key and inserts the returned running rows
    /// before this future resolves.
    async fn claim_due(&self, now: DateTime<Utc>) -> Result<Vec<ClaimedRun>, EngineError>;
}

pub struct AutomationEngine<L> {
    owner_lease: L,
}

pub struct AutomationService<L, S, C> {
    _owner_lease: L,
    claim_store: S,
    clock: C,
}

impl AutomationEngine<()> {
    pub async fn acquire<O>(
        data_dir_key: &str,
        owner_lock: O,
    ) -> Result<Option<AutomationEngine<O::Lease>>, EngineError>
    where
        O: OwnerLockPort,
    {
        Ok(owner_lock
            .try_acquire(data_dir_key)
            .await?
            .map(|lease| AutomationEngine { owner_lease: lease }))
    }
}

impl<L> AutomationEngine<L>
where
    L: Send + Sync + 'static,
{
    pub fn with_claim_store<S, C>(self, claim_store: S, clock: C) -> AutomationService<L, S, C>
    where
        S: ClaimStorePort,
        C: Clock,
    {
        AutomationService {
            _owner_lease: self.owner_lease,
            claim_store,
            clock,
        }
    }
}

impl<L, S, C> AutomationService<L, S, C>
where
    L: Send + Sync + 'static,
    S: ClaimStorePort,
    C: Clock,
{
    pub async fn tick(&self) -> Result<Vec<ClaimedRun>, EngineError> {
        self.claim_store.claim_due(self.clock.now()).await
    }
}
