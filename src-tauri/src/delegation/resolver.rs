//! Background task that turns a delegated child's turn completion into a broker
//! result. It accumulates the child's assistant text from `MessageChunk` events
//! and, on `PromptFinished`, builds the outcome and calls `complete_call`.
//!
//! This lives OUTSIDE the spawner (which the broker owns) to avoid an `Arc`
//! cycle: the resolver references the broker, never the reverse.

use std::collections::HashMap;
use std::sync::Arc;

use agents::events::{AgentContentBlock, AgentEvent};
use agents::runtime::AgentRuntime;
use delegation::{DelegationBroker, outcome_from_turn};
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
        // Accumulated assistant text per delegated child session.
        let mut texts: HashMap<Uuid, String> = HashMap::new();
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            };
            let Some(session_id) = envelope.session_id.map(|id| id.0) else {
                continue;
            };
            match envelope.event {
                AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text { text },
                } => {
                    if map.lock().await.contains_key(&session_id) {
                        texts.entry(session_id).or_default().push_str(&text);
                    }
                }
                AgentEvent::PromptFinished { finished } => {
                    let entry = map.lock().await.remove(&session_id);
                    if let Some((call_id, agent_type)) = entry {
                        let body = texts.remove(&session_id).unwrap_or_default();
                        let outcome = outcome_from_turn(
                            finished.stop_reason.as_deref(),
                            body,
                            session_id,
                            agent_type,
                            1,
                            0,
                        );
                        broker.complete_call(&call_id, outcome).await;
                    }
                }
                _ => {}
            }
        }
    });
}
