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
                            .map(|item| {
                                item.as_str()
                                    .map(str::to_string)
                                    .unwrap_or_else(|| item.to_string())
                            })
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
}
