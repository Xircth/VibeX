use serde_json::Value;

use super::{
    NormalizedProviderEvent, ProviderDiagnosticLevel, ProviderEventAdapter,
    codex_turn_from_response, extract_provider_assistant_entry_id,
    extract_provider_diagnostic_text, extract_provider_error, extract_provider_stream_text,
    extract_provider_text, extract_provider_token_usage_info_with_codex_context_window,
    extract_provider_tool_updates, extract_thread_id, extract_turn_id,
};

pub(super) struct CodexEventAdapter {
    context_window_fallback: Option<u32>,
}

impl CodexEventAdapter {
    pub(super) fn new(context_window_fallback: Option<u32>) -> Self {
        Self {
            context_window_fallback,
        }
    }
}

impl ProviderEventAdapter for CodexEventAdapter {
    fn normalize_event(&self, event: &Value) -> Vec<NormalizedProviderEvent> {
        let mut normalized = Vec::new();
        let method = event.get("method").and_then(Value::as_str);
        let thread_id = extract_thread_id(event);
        let turn_id = extract_turn_id(event);

        match method {
            Some("turn/started") => normalized.push(NormalizedProviderEvent::TurnStarted {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
            }),
            Some("turn/completed") | Some("thread/compacted") => {
                normalized.push(NormalizedProviderEvent::TurnCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                });
            }
            Some("turn/error") | Some("error") | Some("thread/compactionFailed") => {
                normalized.push(NormalizedProviderEvent::TurnError {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    message: extract_provider_error(event)
                        .unwrap_or_else(|| "Codex native runtime reported an error".to_string()),
                });
            }
            _ => {
                if codex_turn_from_response(event).is_some()
                    && let Some(status) = codex_turn_from_response(event)
                        .and_then(|turn| turn.get("status"))
                        .and_then(Value::as_str)
                {
                    let status = status.to_ascii_lowercase();
                    if matches!(
                        status.as_str(),
                        "completed" | "complete" | "succeeded" | "success"
                    ) {
                        normalized.push(NormalizedProviderEvent::TurnCompleted {
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                        });
                    } else if matches!(
                        status.as_str(),
                        "failed" | "error" | "cancelled" | "canceled"
                    ) {
                        normalized.push(NormalizedProviderEvent::TurnError {
                            thread_id: thread_id.clone(),
                            turn_id: turn_id.clone(),
                            message: format!("Codex turn ended with status `{status}`"),
                        });
                    }
                }
            }
        }

        if let Some(token_usage) = extract_provider_token_usage_info_with_codex_context_window(
            event,
            self.context_window_fallback,
        ) {
            normalized.push(NormalizedProviderEvent::TokenUsage(token_usage));
        }

        if !matches!(
            method,
            Some("turn/error" | "error" | "thread/compactionFailed")
        ) && let Some(error) = extract_provider_error(event)
        {
            normalized.push(NormalizedProviderEvent::Diagnostic {
                level: ProviderDiagnosticLevel::Error,
                message: error,
            });
        } else if method == Some("item/command/output")
            && let Some(message) = event
                .get("params")
                .and_then(|params| params.get("output"))
                .and_then(extract_provider_diagnostic_text)
        {
            normalized.push(NormalizedProviderEvent::Diagnostic {
                level: ProviderDiagnosticLevel::Info,
                message,
            });
        } else if matches!(
            method,
            Some("command/exec/outputDelta" | "process/outputDelta")
        ) && let Some(stream) = event
            .get("params")
            .and_then(|params| params.get("stream"))
            .and_then(Value::as_str)
            && stream.eq_ignore_ascii_case("stderr")
            && let Some(message) = event
                .get("params")
                .and_then(|params| {
                    params
                        .get("delta")
                        .or_else(|| params.get("output"))
                        .or_else(|| params.get("text"))
                })
                .and_then(extract_provider_diagnostic_text)
        {
            normalized.push(NormalizedProviderEvent::Diagnostic {
                level: ProviderDiagnosticLevel::Warning,
                message,
            });
        }

        for tool_update in extract_provider_tool_updates(event) {
            normalized.push(NormalizedProviderEvent::ToolUpdate(Box::new(tool_update)));
        }

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

        normalized.push(NormalizedProviderEvent::Raw {
            event: event.clone(),
        });
        normalized
    }
}
