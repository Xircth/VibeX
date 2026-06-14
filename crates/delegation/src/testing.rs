//! Shared mock trait implementations for broker unit tests. Test-only.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agents::registry::AgentType;
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::event_emitter::{
    DelegationCompletedEvent, DelegationEventEmitter, DelegationStartedEvent,
};
use crate::lookups::{ChildStatusLookup, ChildStatusRecord, DepthLookup};
use crate::meta_writer::DelegationMetaWriter;
use crate::spawner::{ConnectionSpawner, SpawnerError};
use crate::types::{DelegationError, DelegationLink};

#[derive(Default)]
pub struct MockSpawnerCalls {
    pub spawned: Vec<(String, AgentType, Option<String>)>,
    pub prompts: Vec<(String, String)>,
    pub canceled: Vec<String>,
    pub disconnected: Vec<String>,
}

/// Returns fixed child ids and records every call. Set `spawn_error` /
/// `send_error` to exercise failure paths; set `child_session_id` per test.
///
/// For deterministic setup-window race tests, `release_gate` (when set) parks
/// `send_prompt_linked` until the test releases it; `send_reached_gate` is
/// notified when the send is parked, and `captured_call_id` exposes the
/// in-flight call id (from the delegation link) to the test.
pub struct MockSpawner {
    pub child_connection_id: String,
    pub child_session_id: Uuid,
    pub spawn_error: Option<String>,
    pub send_error: Option<String>,
    pub calls: Mutex<MockSpawnerCalls>,
    pub captured_call_id: Arc<Mutex<Option<String>>>,
    pub send_reached_gate: Arc<Notify>,
    pub release_gate: Option<Arc<Notify>>,
}

impl MockSpawner {
    pub fn new() -> Self {
        Self {
            child_connection_id: "child-conn".to_string(),
            child_session_id: Uuid::from_u128(0xC417D),
            spawn_error: None,
            send_error: None,
            calls: Mutex::new(MockSpawnerCalls::default()),
            captured_call_id: Arc::new(Mutex::new(None)),
            send_reached_gate: Arc::new(Notify::new()),
            release_gate: None,
        }
    }
}

impl Default for MockSpawner {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ConnectionSpawner for MockSpawner {
    async fn spawn(
        &self,
        parent_connection_id: &str,
        agent_type: AgentType,
        working_dir: Option<String>,
    ) -> Result<String, SpawnerError> {
        if let Some(message) = &self.spawn_error {
            return Err(SpawnerError::Spawn(message.clone()));
        }
        self.calls.lock().unwrap().spawned.push((
            parent_connection_id.to_string(),
            agent_type,
            working_dir,
        ));
        Ok(self.child_connection_id.clone())
    }

    async fn send_prompt_linked(
        &self,
        child_connection_id: &str,
        task: String,
        link: DelegationLink,
    ) -> Result<Uuid, SpawnerError> {
        if let Some(message) = &self.send_error {
            return Err(SpawnerError::SendPrompt(message.clone()));
        }
        *self.captured_call_id.lock().unwrap() = Some(link.delegation_call_id.clone());
        self.calls
            .lock()
            .unwrap()
            .prompts
            .push((child_connection_id.to_string(), task));
        self.send_reached_gate.notify_one();
        if let Some(gate) = &self.release_gate {
            gate.notified().await;
        }
        Ok(self.child_session_id)
    }

    async fn cancel(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        self.calls
            .lock()
            .unwrap()
            .canceled
            .push(child_connection_id.to_string());
        Ok(())
    }

    async fn disconnect(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        self.calls
            .lock()
            .unwrap()
            .disconnected
            .push(child_connection_id.to_string());
        Ok(())
    }
}

/// Depth lookup backed by an explicit child→parent map. Empty map → every
/// session is a root (depth 0).
#[derive(Default)]
pub struct MockDepthLookup {
    pub parents: HashMap<Uuid, Uuid>,
}

impl MockDepthLookup {
    /// Build a linear chain `ids[0] (root) -> ids[1] -> ... -> ids[n-1]`.
    pub fn chain(ids: &[Uuid]) -> Self {
        let mut parents = HashMap::new();
        for pair in ids.windows(2) {
            parents.insert(pair[1], pair[0]);
        }
        Self { parents }
    }
}

#[async_trait]
impl DepthLookup for MockDepthLookup {
    async fn parent_session_id(&self, session_id: Uuid) -> Result<Option<Uuid>, DelegationError> {
        Ok(self.parents.get(&session_id).copied())
    }
}

/// Status lookup returning a preset record (or `None`).
#[derive(Default)]
pub struct MockStatusLookup {
    pub record: Option<ChildStatusRecord>,
}

#[async_trait]
impl ChildStatusLookup for MockStatusLookup {
    async fn status_by_call_id(&self, _call_id: &str) -> Option<ChildStatusRecord> {
        self.record.clone()
    }
}

/// Records every meta write.
#[derive(Default)]
pub struct RecordingMetaWriter {
    pub writes: Mutex<Vec<(String, String, Value)>>,
}

#[async_trait]
impl DelegationMetaWriter for RecordingMetaWriter {
    async fn write_meta(&self, parent_connection_id: &str, parent_tool_use_id: &str, meta: Value) {
        self.writes.lock().unwrap().push((
            parent_connection_id.to_string(),
            parent_tool_use_id.to_string(),
            meta,
        ));
    }
}

/// Records every lifecycle event.
#[derive(Default)]
pub struct RecordingEventEmitter {
    pub started: Mutex<Vec<DelegationStartedEvent>>,
    pub completed: Mutex<Vec<DelegationCompletedEvent>>,
}

#[async_trait]
impl DelegationEventEmitter for RecordingEventEmitter {
    async fn emit_started(&self, event: DelegationStartedEvent) {
        self.started.lock().unwrap().push(event);
    }

    async fn emit_completed(&self, event: DelegationCompletedEvent) {
        self.completed.lock().unwrap().push(event);
    }
}
