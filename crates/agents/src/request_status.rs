//! Facts about one prompt, independent of ACP transport health.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RequestPhase {
    Submitting,
    WaitingAgent,
    WaitingModel,
    Thinking,
    Responding,
    ExecutingTool,
    WaitingUser,
    Retrying,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl RequestPhase {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestRetry {
    pub attempt: Option<u32>,
    pub max_attempts: Option<u32>,
    pub delay_ms: Option<u64>,
    pub reason: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestActivity {
    pub phase: RequestPhase,
    pub retry: Option<RequestRetry>,
}

impl RequestActivity {
    pub fn phase(phase: RequestPhase) -> Self {
        Self { phase, retry: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRequestStatus {
    pub turn_id: Uuid,
    pub prompt_id: Option<String>,
    pub connection_id: Option<String>,
    pub activity: RequestActivity,
    pub since: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationConnectionStatus {
    pub status: crate::conversation::ConversationAgentConnectionStatus,
    pub bound: bool,
    pub connection_id: Option<String>,
    pub message: Option<String>,
    pub since: DateTime<Utc>,
}

pub(crate) fn activity_for_event(event: &crate::AgentEvent) -> Option<RequestActivity> {
    use crate::AgentEvent;
    let phase = match event {
        AgentEvent::RequestActivity { activity, .. } => return Some(activity.clone()),
        AgentEvent::PromptStarted { .. } => RequestPhase::WaitingAgent,
        AgentEvent::MessageChunk { content } if !matches!(content, crate::AgentContentBlock::Text { text } if text.is_empty()) => {
            RequestPhase::Responding
        }
        AgentEvent::ThoughtChunk { content } if !matches!(content, crate::AgentContentBlock::Text { text } if text.is_empty()) => {
            RequestPhase::Thinking
        }
        AgentEvent::ToolCall { tool_call }
            if !matches!(
                tool_call.status.as_deref(),
                Some("completed" | "failed" | "cancelled")
            ) =>
        {
            RequestPhase::ExecutingTool
        }
        AgentEvent::ToolCallUpdate { update }
            if update.status.is_some()
                && !matches!(
                    update.status.as_deref(),
                    Some("completed" | "failed" | "cancelled")
                ) =>
        {
            RequestPhase::ExecutingTool
        }
        AgentEvent::PermissionRequested { .. } | AgentEvent::ElicitationRequested { .. } => {
            RequestPhase::WaitingUser
        }
        AgentEvent::ToolCallUpdate { update } if update.status.is_none() => return None,
        AgentEvent::ToolCall { .. }
        | AgentEvent::ToolCallUpdate { .. }
        | AgentEvent::PermissionResponded { .. }
        | AgentEvent::ElicitationResponded { .. } => RequestPhase::WaitingAgent,
        AgentEvent::RawAcpDiagnostic { raw }
            if raw.get("kind").and_then(serde_json::Value::as_str)
                == Some("prompt_cancel_requested") =>
        {
            RequestPhase::Cancelling
        }
        _ => return None,
    };
    Some(RequestActivity::phase(phase))
}
