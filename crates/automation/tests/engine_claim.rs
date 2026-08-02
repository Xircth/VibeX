use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use automation::{
    AutomationEngine, ClaimStorePort, ClaimedRun, Clock, EngineError, FileOwnerLock, OwnerLockPort,
};
use chrono::{DateTime, TimeZone, Utc};
use uuid::Uuid;

#[derive(Clone, Default)]
struct FakeOwnerLock {
    held: Arc<Mutex<HashSet<String>>>,
}

struct FakeOwnerLease {
    key: String,
    held: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[derive(Clone)]
struct FakeClaimStore {
    state: Arc<Mutex<FakeClaimState>>,
}

struct FakeClaimState {
    automation_id: Uuid,
    due_at: DateTime<Utc>,
    next_run_at: DateTime<Utc>,
    running_runs: Vec<ClaimedRun>,
}

impl FakeClaimStore {
    fn due(now: DateTime<Utc>) -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeClaimState {
                automation_id: Uuid::new_v4(),
                due_at: now,
                next_run_at: now,
                running_runs: Vec::new(),
            })),
        }
    }

    fn snapshot(&self) -> (DateTime<Utc>, Vec<ClaimedRun>) {
        let state = self.state.lock().unwrap();
        (state.next_run_at, state.running_runs.clone())
    }
}

#[async_trait]
impl ClaimStorePort for FakeClaimStore {
    async fn claim_due(&self, now: DateTime<Utc>) -> Result<Vec<ClaimedRun>, EngineError> {
        let mut state = self.state.lock().unwrap();
        if state.next_run_at > now || !state.running_runs.is_empty() {
            return Ok(Vec::new());
        }
        let scheduled_for = state.due_at;
        state.next_run_at = now + chrono::Duration::hours(1);
        let run = ClaimedRun {
            run_id: Uuid::new_v4(),
            automation_id: state.automation_id,
            scheduled_for,
            next_run_at: Some(state.next_run_at),
        };
        state.running_runs.push(run.clone());
        Ok(vec![run])
    }
}

impl Drop for FakeOwnerLease {
    fn drop(&mut self) {
        self.held.lock().unwrap().remove(&self.key);
    }
}

#[async_trait]
impl OwnerLockPort for FakeOwnerLock {
    type Lease = FakeOwnerLease;

    async fn try_acquire(&self, data_dir_key: &str) -> Result<Option<Self::Lease>, EngineError> {
        let mut held = self.held.lock().unwrap();
        if !held.insert(data_dir_key.to_string()) {
            return Ok(None);
        }
        Ok(Some(FakeOwnerLease {
            key: data_dir_key.to_string(),
            held: self.held.clone(),
        }))
    }
}

#[tokio::test]
async fn only_one_engine_can_own_a_data_directory() {
    let owner = FakeOwnerLock::default();

    let first = AutomationEngine::acquire("db-a", owner.clone())
        .await
        .expect("owner check")
        .expect("first engine owns directory");
    let second = AutomationEngine::acquire("db-a", owner.clone())
        .await
        .expect("owner check");

    assert!(second.is_none());
    drop(first);
    assert!(
        AutomationEngine::acquire("db-a", owner)
            .await
            .expect("owner check")
            .is_some()
    );
}

#[tokio::test]
async fn concurrent_ticks_claim_one_run_after_advancing_next_run() {
    let now = Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).single().unwrap();
    let store = FakeClaimStore::due(now);
    let engine = AutomationEngine::acquire("db-a", FakeOwnerLock::default())
        .await
        .expect("owner check")
        .expect("engine owner")
        .with_claim_store(store.clone(), FixedClock(now));

    let (first, second) = tokio::join!(engine.tick(), engine.tick());
    let claimed = first
        .expect("first tick")
        .into_iter()
        .chain(second.expect("second tick"))
        .collect::<Vec<_>>();
    let (next_run_at, running) = store.snapshot();

    assert_eq!(claimed.len(), 1);
    assert_eq!(running, claimed);
    assert!(next_run_at > now);
    assert_eq!(claimed[0].next_run_at, Some(next_run_at));
}

#[tokio::test]
async fn file_owner_lock_excludes_two_real_engines_for_one_data_directory() {
    let data_dir = tempfile::tempdir().expect("data directory");
    let key = data_dir.path().to_string_lossy();

    let first = AutomationEngine::acquire(&key, FileOwnerLock::default())
        .await
        .expect("first lock")
        .expect("first owns data directory");
    assert!(
        AutomationEngine::acquire(&key, FileOwnerLock::default())
            .await
            .expect("second lock")
            .is_none()
    );
    drop(first);
    assert!(
        AutomationEngine::acquire(&key, FileOwnerLock::default())
            .await
            .expect("lock after release")
            .is_some()
    );
}
