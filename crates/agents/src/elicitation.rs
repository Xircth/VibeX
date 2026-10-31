//! Structured user-input requests (ACP `elicitation/create`, form mode).
//!
//! An elicitation is the agent asking the *user* a question — distinct from a
//! permission request, which is a security decision about a tool call. Claude
//! Code surfaces its built-in `AskUserQuestion` tool this way, and MCP servers
//! reach the user through the same channel.
//!
//! The ACP elicitation surface is still unstable upstream, so the requested
//! schema is carried verbatim as JSON rather than mirrored type-by-type: the
//! frontend renders the (primitive-typed) JSON Schema directly, and a spec
//! change doesn't ripple through generated types.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{AgentElicitationId, AgentSessionId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentElicitationRequest {
    pub id: AgentElicitationId,
    pub session_id: AgentSessionId,
    /// Human-readable message describing what input is needed.
    pub message: String,
    /// ACP form-mode requested schema: a JSON Schema object whose properties
    /// are primitives (string/enum, number, integer, boolean, string-array).
    pub requested_schema: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "action", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentElicitationResponse {
    /// The user filled the form. `content` is an object matching the requested
    /// schema (primitive values keyed by property name).
    Accept {
        #[serde(default)]
        content: serde_json::Value,
    },
    /// The user explicitly declined to answer.
    Decline,
    /// The request was cancelled (turn ended, connection dropped, UI dismissed).
    Cancel,
}

impl AgentElicitationResponse {
    /// Human-readable one-line summary for timeline history.
    pub fn summary(&self) -> String {
        match self {
            Self::Accept { content } => match content {
                serde_json::Value::Object(map) if !map.is_empty() => map
                    .values()
                    .map(|value| match value {
                        serde_json::Value::String(text) => text.clone(),
                        serde_json::Value::Array(items) => items
                            .iter()
                            .filter_map(format_elicitation_array_item)
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join(", "),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(" · "),
                _ => "accepted".to_string(),
            },
            Self::Decline => "declined".to_string(),
            Self::Cancel => "cancelled".to_string(),
        }
    }
}

fn format_elicitation_array_item(item: &serde_json::Value) -> Option<String> {
    if let Some(text) = item.as_str() {
        return Some(text.to_string());
    }
    if let Some(obj) = item.as_object() {
        for key in ["labels", "selected"] {
            if let Some(labels) = obj.get(key).and_then(serde_json::Value::as_array) {
                let parts = labels
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                if !parts.is_empty() {
                    return Some(parts.join(", "));
                }
            }
        }
        if let Some(label) = obj
            .get("label")
            .or_else(|| obj.get("answer"))
            .or_else(|| obj.get("value"))
            .and_then(serde_json::Value::as_str)
        {
            let trimmed = label.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    Some(item.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_serializes_action_tagged() {
        let accept = AgentElicitationResponse::Accept {
            content: serde_json::json!({ "choice": "red" }),
        };
        let value = serde_json::to_value(&accept).unwrap();
        assert_eq!(value["action"], "accept");
        assert_eq!(value["content"]["choice"], "red");

        let decline: AgentElicitationResponse =
            serde_json::from_value(serde_json::json!({ "action": "decline" })).unwrap();
        assert_eq!(decline, AgentElicitationResponse::Decline);
    }

    #[test]
    fn summary_joins_accepted_values() {
        let response = AgentElicitationResponse::Accept {
            content: serde_json::json!({ "a": "x", "b": ["y", "z"] }),
        };
        assert_eq!(response.summary(), "x · y, z");
        assert_eq!(AgentElicitationResponse::Decline.summary(), "declined");
    }

    #[test]
    fn summary_extracts_question_answer_labels() {
        let response = AgentElicitationResponse::Accept {
            content: serde_json::json!({
                "answers": [
                    {
                        "questionId": "question-1",
                        "labels": ["仅会话界面可见"]
                    }
                ]
            }),
        };
        assert_eq!(response.summary(), "仅会话界面可见");
    }
}
