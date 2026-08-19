//! Grok's ACP reverse-request for leaving plan mode.
//!
//! `exit_plan_mode` blocks on `x.ai/exit_plan_mode` until the client returns
//! `{ outcome, feedback? }`. Official outcomes are `approved`, `cancelled`
//! (stay in plan mode; `feedback` carries revision notes), and `abandoned`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    elicitation::AgentElicitationResponse,
    ext_question::{answer_entries, normalize_method, question_schema, unwrap_params},
};

pub const EXIT_PLAN_MODE_METHOD: &str = "x.ai/exit_plan_mode";

const APPROVE_LABEL: &str = "Approve";
const REQUEST_CHANGES_LABEL: &str = "Request changes";
const ABANDON_LABEL: &str = "Abandon";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPlanModeExtRequest {
    pub session_id: String,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub plan_content: Option<String>,
}

pub fn is_exit_plan_mode_method(method: &str) -> bool {
    normalize_method(method) == EXIT_PLAN_MODE_METHOD
}

pub fn parse_request(params: &str) -> Result<ExitPlanModeExtRequest, String> {
    serde_json::from_value(unwrap_params(params)?)
        .map_err(|error| format!("invalid exit_plan_mode: {error}"))
}

pub fn question_prompt(request: &ExitPlanModeExtRequest) -> String {
    request
        .plan_content
        .as_deref()
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .unwrap_or("Approve this plan?")
        .to_string()
}

pub fn plan_question_schema(request: &ExitPlanModeExtRequest) -> Value {
    question_schema([json!({
        "id": "plan",
        "header": "Plan",
        "question": question_prompt(request),
        "multiSelect": false,
        "options": [
            {
                "label": APPROVE_LABEL,
                "description": "Start implementing.",
            },
            {
                "label": REQUEST_CHANGES_LABEL,
                "description": "Revise the plan.",
            },
            {
                "label": ABANDON_LABEL,
                "description": "Drop this plan.",
            },
        ],
    })])
}

pub fn ext_response_from_elicitation(response: AgentElicitationResponse) -> Value {
    match response {
        AgentElicitationResponse::Accept { content } => {
            let labels = answer_entries(&content)
                .into_iter()
                .flat_map(|(_, labels)| labels)
                .collect::<Vec<_>>();
            if labels
                .iter()
                .any(|label| label.eq_ignore_ascii_case(APPROVE_LABEL))
            {
                return json!({ "outcome": "approved" });
            }
            if labels
                .iter()
                .any(|label| label.eq_ignore_ascii_case(ABANDON_LABEL))
            {
                return json!({ "outcome": "abandoned" });
            }
            let feedback = labels
                .into_iter()
                .filter(|label| !label.eq_ignore_ascii_case(REQUEST_CHANGES_LABEL))
                .collect::<Vec<_>>()
                .join("\n");
            if feedback.is_empty() {
                json!({ "outcome": "cancelled" })
            } else {
                json!({
                    "outcome": "cancelled",
                    "feedback": feedback,
                })
            }
        }
        AgentElicitationResponse::Decline | AgentElicitationResponse::Cancel => {
            json!({ "outcome": "cancelled" })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_exit_plan_mode() {
        assert!(is_exit_plan_mode_method("x.ai/exit_plan_mode"));
        assert!(is_exit_plan_mode_method("_x.ai/exit_plan_mode"));
        assert!(!is_exit_plan_mode_method("x.ai/ask_user_question"));
    }

    #[test]
    fn parses_camel_case_request() {
        let request = parse_request(
            r#"{
                "sessionId": "sess-1",
                "toolCallId": "call-1",
                "planContent": "Ship login"
            }"#,
        )
        .expect("request");
        assert_eq!(request.session_id, "sess-1");
        assert_eq!(request.tool_call_id, "call-1");
        assert_eq!(request.plan_content.as_deref(), Some("Ship login"));
    }

    #[test]
    fn maps_approve_abandon_and_revision_notes() {
        assert_eq!(
            ext_response_from_elicitation(AgentElicitationResponse::Accept {
                content: json!({
                    "answers": [{ "questionId": "plan", "labels": ["Approve"] }]
                }),
            })["outcome"],
            "approved"
        );
        assert_eq!(
            ext_response_from_elicitation(AgentElicitationResponse::Accept {
                content: json!({
                    "answers": [{ "questionId": "plan", "labels": ["Abandon"] }]
                }),
            })["outcome"],
            "abandoned"
        );
        let revised = ext_response_from_elicitation(AgentElicitationResponse::Accept {
            content: json!({
                "answers": [{
                    "questionId": "plan",
                    "labels": ["Request changes", "Add rate limits"]
                }]
            }),
        });
        assert_eq!(revised["outcome"], "cancelled");
        assert_eq!(revised["feedback"], "Add rate limits");
    }

    #[test]
    fn maps_cancel_without_feedback() {
        let response = ext_response_from_elicitation(AgentElicitationResponse::Cancel);
        assert_eq!(response["outcome"], "cancelled");
        assert!(response.get("feedback").is_none());
    }
}
