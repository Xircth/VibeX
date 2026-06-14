//! Surfaces delegation lifecycle events on the parent connection's stream (via
//! `AgentRuntime::emit_external`, which routes through the normal sink +
//! broadcast path) so the frontend's `agent-events` channel receives them.

use std::sync::Arc;

use agents::events::{AgentEvent, DelegationResultSummary};
use agents::ids::AgentConnectionId;
use agents::runtime::AgentRuntime;
use async_trait::async_trait;
use delegation::{
    DelegationCompletedEvent, DelegationEventEmitter, DelegationMetaWriter, DelegationOutcome,
    DelegationStartedEvent,
};
use uuid::Uuid;

pub(crate) struct RuntimeEventEmitter {
    pub runtime: Arc<AgentRuntime>,
}

fn parse_conn(id: &str) -> Option<AgentConnectionId> {
    Some(AgentConnectionId::from(Uuid::parse_str(id).ok()?))
}

#[async_trait]
impl DelegationEventEmitter for RuntimeEventEmitter {
    async fn emit_started(&self, event: DelegationStartedEvent) {
        let Some(conn) = parse_conn(&event.parent_connection_id) else {
            return;
        };
        self.runtime
            .emit_external(
                conn,
                None,
                AgentEvent::DelegationStarted {
                    parent_tool_use_id: event.parent_tool_use_id,
                    child_session_id: event.child_session_id,
                    agent_type: event.agent_type,
                    task_preview: event.task_preview,
                },
            )
            .await;
    }

    async fn emit_completed(&self, event: DelegationCompletedEvent) {
        let Some(conn) = parse_conn(&event.parent_connection_id) else {
            return;
        };
        let result = match &event.outcome {
            DelegationOutcome::Ok(success) => DelegationResultSummary::Ok {
                duration_ms: Some(success.duration_ms),
                text_preview: Some(preview(&success.text)),
            },
            DelegationOutcome::Err { code, .. } => DelegationResultSummary::Err {
                error_code: code.clone(),
            },
        };
        self.runtime
            .emit_external(
                conn,
                None,
                AgentEvent::DelegationCompleted {
                    parent_tool_use_id: event.parent_tool_use_id,
                    child_session_id: event.child_session_id,
                    agent_type: event.agent_type,
                    result,
                },
            )
            .await;
    }
}

fn preview(text: &str) -> String {
    const CAP: usize = 200;
    if text.len() <= CAP {
        return text.to_string();
    }
    let mut end = CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// v1: delegation `DelegationStarted`/`DelegationCompleted` events are enough for
/// the frontend to render the card. Persisted tool-call meta (for snapshot
/// replay after reload) is deferred to M7.
pub(crate) struct NoopMetaWriter;

#[async_trait]
impl DelegationMetaWriter for NoopMetaWriter {
    async fn write_meta(&self, _parent_connection_id: &str, _parent_tool_use_id: &str, _meta: serde_json::Value) {}
}
