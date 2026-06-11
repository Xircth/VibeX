use serde_json::Value;

use super::{
    NormalizedProviderEvent, ProviderDiagnosticLevel, ProviderEventAdapter,
    extract_provider_assistant_entry_id, extract_provider_error, extract_provider_stream_text,
    extract_provider_text, extract_provider_token_usage_info_with_codex_context_window,
    extract_provider_tool_updates, extract_thread_id, extract_turn_id, provider_event_is_user_echo,
};

pub(super) struct OpencodeEventAdapter;

impl ProviderEventAdapter for OpencodeEventAdapter {
    fn normalize_event(&self, event: &Value) -> Vec<NormalizedProviderEvent> {
        let mut normalized = Vec::new();
        let event_type = event.get("type").and_then(Value::as_str);
        let thread_id = extract_thread_id(event);
        let turn_id = extract_turn_id(event);

        match event_type {
            Some("opencode_sdk_error") | Some("stderr") => {
                normalized.push(NormalizedProviderEvent::TurnError {
                    thread_id,
                    turn_id,
                    message: extract_provider_error(event)
                        .unwrap_or_else(|| "OpenCode native runtime reported an error".to_string()),
                });
            }
            Some("opencode_sdk_response") => {
                if let Some(token_usage) =
                    extract_provider_token_usage_info_with_codex_context_window(event, None)
                {
                    normalized.push(NormalizedProviderEvent::TokenUsage(token_usage));
                }
                if let Some(text) = extract_provider_text(event) {
                    normalized.push(NormalizedProviderEvent::AssistantTextSnapshot {
                        id: extract_provider_assistant_entry_id(event),
                        text,
                    });
                }
                normalized.push(NormalizedProviderEvent::TurnCompleted { thread_id, turn_id });
            }
            Some("opencode_sdk_event") => {
                if let Some(token_usage) =
                    extract_provider_token_usage_info_with_codex_context_window(event, None)
                {
                    normalized.push(NormalizedProviderEvent::TokenUsage(token_usage));
                }

                if let Some(inner_type) = event
                    .get("event")
                    .and_then(|inner| inner.get("type"))
                    .and_then(Value::as_str)
                    && matches!(
                        inner_type,
                        "session.error" | "session.failed" | "session.next.error"
                    )
                {
                    normalized.push(NormalizedProviderEvent::TurnError {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        message: extract_provider_error(event)
                            .unwrap_or_else(|| "OpenCode SDK event reported an error".to_string()),
                    });
                }

                for tool_update in extract_provider_tool_updates(event) {
                    normalized.push(NormalizedProviderEvent::ToolUpdate(Box::new(tool_update)));
                }

                if !provider_event_is_user_echo(event) {
                    if let Some(text) = extract_provider_stream_text(event) {
                        normalized.push(NormalizedProviderEvent::AssistantTextDelta {
                            id: extract_provider_assistant_entry_id(event),
                            text,
                        });
                    } else if let Some(text) = extract_provider_text(event) {
                        normalized.push(NormalizedProviderEvent::AssistantTextSnapshot {
                            id: extract_provider_assistant_entry_id(event),
                            text,
                        });
                    }
                }
            }
            _ => {
                if let Some(error) = extract_provider_error(event) {
                    normalized.push(NormalizedProviderEvent::Diagnostic {
                        level: ProviderDiagnosticLevel::Error,
                        message: error,
                    });
                }
            }
        }

        normalized.push(NormalizedProviderEvent::Raw {
            event: event.clone(),
        });
        normalized
    }
}
