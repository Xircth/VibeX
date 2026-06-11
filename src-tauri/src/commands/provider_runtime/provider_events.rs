use executors::logs::TokenUsageInfo;
use serde_json::Value;

use super::{
    ClaudeEventAdapter, CodexEventAdapter, NativeToolUpdate, OpencodeEventAdapter, ProviderId,
    ProviderRuntimeEvent, ProviderRuntimeNormalizedEvent, codex_config_model_context_window,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ProviderDiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
pub(super) enum NormalizedProviderEvent {
    TurnStarted {
        thread_id: Option<String>,
        turn_id: Option<String>,
    },
    TurnCompleted {
        thread_id: Option<String>,
        turn_id: Option<String>,
    },
    TurnError {
        thread_id: Option<String>,
        turn_id: Option<String>,
        message: String,
    },
    AssistantTextDelta {
        id: Option<String>,
        text: String,
    },
    AssistantTextSnapshot {
        id: Option<String>,
        text: String,
    },
    ToolUpdate(Box<NativeToolUpdate>),
    TokenUsage(TokenUsageInfo),
    Diagnostic {
        level: ProviderDiagnosticLevel,
        message: String,
    },
    Raw {
        event: Value,
    },
}

pub(super) trait ProviderEventAdapter: Send + Sync {
    fn normalize_event(&self, event: &Value) -> Vec<NormalizedProviderEvent>;
}

pub(super) fn provider_runtime_normalized_events(
    events: &[NormalizedProviderEvent],
) -> Vec<ProviderRuntimeNormalizedEvent> {
    events
        .iter()
        .filter_map(|event| match event {
            NormalizedProviderEvent::TurnStarted { thread_id, turn_id } => {
                Some(ProviderRuntimeNormalizedEvent::TurnStarted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                })
            }
            NormalizedProviderEvent::TurnCompleted { thread_id, turn_id } => {
                Some(ProviderRuntimeNormalizedEvent::TurnCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                })
            }
            NormalizedProviderEvent::TurnError {
                thread_id,
                turn_id,
                message,
            } => Some(ProviderRuntimeNormalizedEvent::TurnError {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                message: message.clone(),
            }),
            NormalizedProviderEvent::AssistantTextDelta { id, text } => {
                Some(ProviderRuntimeNormalizedEvent::AssistantTextDelta {
                    id: id.clone(),
                    text: text.clone(),
                })
            }
            NormalizedProviderEvent::AssistantTextSnapshot { id, text } => {
                Some(ProviderRuntimeNormalizedEvent::AssistantTextSnapshot {
                    id: id.clone(),
                    text: text.clone(),
                })
            }
            NormalizedProviderEvent::ToolUpdate(update) => {
                Some(ProviderRuntimeNormalizedEvent::ToolUpdate {
                    id: Some(update.id.clone()),
                    tool_name: update.tool_name.clone(),
                    status: Some(format!("{:?}", update.status).to_ascii_lowercase()),
                })
            }
            NormalizedProviderEvent::TokenUsage(_) => {
                Some(ProviderRuntimeNormalizedEvent::TokenUsage)
            }
            NormalizedProviderEvent::Diagnostic { level, message } => {
                Some(ProviderRuntimeNormalizedEvent::Diagnostic {
                    level: format!("{level:?}").to_ascii_lowercase(),
                    message: message.clone(),
                })
            }
            NormalizedProviderEvent::Raw { .. } => None,
        })
        .collect()
}

pub(super) fn normalize_provider_runtime_event(
    mut event: ProviderRuntimeEvent,
) -> ProviderRuntimeEvent {
    if event.normalized.is_empty() {
        let normalized = match event.provider {
            ProviderId::Claude => ClaudeEventAdapter.normalize_event(&event.event),
            ProviderId::Codex => CodexEventAdapter::new(codex_config_model_context_window())
                .normalize_event(&event.event),
            ProviderId::Opencode => OpencodeEventAdapter.normalize_event(&event.event),
        };
        event.normalized = provider_runtime_normalized_events(&normalized);
    }
    event
}
