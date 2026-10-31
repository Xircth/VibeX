//! Background task that turns a delegated child's turn completion into a broker
//! result. It accumulates the child's assistant text from `MessageChunk` events
//! and, on `PromptFinished`, builds the outcome and calls `complete_call`.
//!
//! This lives OUTSIDE the spawner (which the broker owns) to avoid an `Arc`
//! cycle: the resolver references the broker, never the reverse.

use std::{collections::HashMap, sync::Arc};

use agents::runtime::AgentRuntime;
use delegation::{AssistantReplyAccumulator, DelegationBroker, process_resolver_event};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::delegation::spawner::ResolverMap;

pub(crate) fn spawn_resolver(
    broker: Arc<DelegationBroker>,
    runtime: Arc<AgentRuntime>,
    map: ResolverMap,
) {
    tauri::async_runtime::spawn(async move {
        let mut events = runtime.subscribe_events();
        let mut replies: HashMap<Uuid, AssistantReplyAccumulator> = HashMap::new();
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            };
            let completed = {
                let mut guard = map.lock().await;
                process_resolver_event(&envelope, &mut guard, &mut replies)
            };
            for (call_id, outcome) in completed {
                broker.complete_call(&call_id, outcome).await;
            }
        }
    });
}
