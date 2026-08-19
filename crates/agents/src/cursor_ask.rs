//! Cursor ACP reverse-requests for questions and plan approval.
//!
//! Cursor does not use `elicitation/create`. It blocks on vendor ext-methods
//! `cursor/ask_question` and `cursor/create_plan` until the client returns a
//! nested `{ outcome: { outcome, ... } }` payload. This module owns those wire
//! shapes and the conversion onto VibeX's existing question card.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    elicitation::AgentElicitationResponse,
    ext_question::{
        answer_entries, normalize_method, prompt_from_texts, question_header, question_schema,
        unwrap_params,
    },
};

pub const ASK_QUESTION_METHOD: &str = "cursor/ask_question";
pub const CREATE_PLAN_METHOD: &str = "cursor/create_plan";

const APPROVE_LABEL: &str = "Approve";
const REJECT_LABEL: &str = "Reject";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAskQuestionRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub questions: Vec<CursorAskQuestion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAskQuestion {
    #[serde(default)]
    pub id: String,
    #[serde(default, alias = "question")]
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<CursorAskOption>,
    #[serde(default, alias = "multiSelect")]
    pub allow_multiple: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorAskOption {
    #[serde(default)]
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorCreatePlanRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub todos: Vec<CursorPlanTodo>,
    #[serde(default)]
    pub is_project: Option<bool>,
    #[serde(default)]
    pub phases: Vec<CursorPlanPhase>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorPlanTodo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorPlanPhase {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub todos: Vec<CursorPlanTodo>,
}

pub fn is_ask_question_method(method: &str) -> bool {
    normalize_method(method) == ASK_QUESTION_METHOD
}

pub fn is_create_plan_method(method: &str) -> bool {
    normalize_method(method) == CREATE_PLAN_METHOD
}

pub fn parse_ask_request(params: &str) -> Result<CursorAskQuestionRequest, String> {
    serde_json::from_value(unwrap_params(params)?)
        .map_err(|error| format!("invalid cursor/ask_question: {error}"))
}

pub fn parse_plan_request(params: &str) -> Result<CursorCreatePlanRequest, String> {
    serde_json::from_value(unwrap_params(params)?)
        .map_err(|error| format!("invalid cursor/create_plan: {error}"))
}

pub fn ask_question_schema(request: &CursorAskQuestionRequest) -> Value {
    question_schema(
        request
            .questions
            .iter()
            .enumerate()
            .map(|(index, question)| {
                json!({
                    "id": question_id(question, index),
                    "header": question_header(&question.prompt, index),
                    "question": question.prompt,
                    "multiSelect": question.allow_multiple.unwrap_or(false),
                    "options": question.options.iter().map(|option| {
                        json!({
                            "label": option.label,
                            "description": option.description.clone().unwrap_or_default(),
                        })
                    }).collect::<Vec<_>>(),
                })
            }),
    )
}

pub fn ask_prompt(request: &CursorAskQuestionRequest) -> String {
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());
    let questions = prompt_from_texts(
        request
            .questions
            .iter()
            .map(|question| question.prompt.as_str()),
    );
    match title {
        Some(title) if questions.is_empty() => title.to_string(),
        Some(title) => format!("{title}\n{questions}"),
        None => questions,
    }
}

pub fn plan_question_schema(request: &CursorCreatePlanRequest) -> Value {
    question_schema([json!({
        "id": "plan",
        "header": request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("Plan"),
        "question": plan_prompt(request),
        "multiSelect": false,
        "options": [
            { "label": APPROVE_LABEL, "description": "Start implementing." },
            { "label": REJECT_LABEL, "description": "Do not implement this plan." },
        ],
    })])
}

pub fn plan_prompt(request: &CursorCreatePlanRequest) -> String {
    let mut parts = Vec::new();
    push_trimmed(&mut parts, request.name.as_deref());
    push_trimmed(&mut parts, request.overview.as_deref());
    push_trimmed(&mut parts, Some(request.plan.as_str()));
    let todos = format_todos(&request.todos);
    if !todos.is_empty() {
        parts.push(todos);
    }
    for phase in &request.phases {
        let name = phase.name.trim();
        let items = format_todos(&phase.todos);
        if name.is_empty() && items.is_empty() {
            continue;
        }
        if name.is_empty() {
            parts.push(items);
        } else if items.is_empty() {
            parts.push(name.to_string());
        } else {
            parts.push(format!("{name}\n{items}"));
        }
    }
    if parts.is_empty() {
        "Approve this plan?".to_string()
    } else {
        parts.join("\n\n")
    }
}

pub fn ask_response_from_elicitation(
    response: AgentElicitationResponse,
    questions: &[CursorAskQuestion],
) -> Value {
    match response {
        AgentElicitationResponse::Accept { content } => json!({
            "outcome": {
                "outcome": "answered",
                "answers": cursor_answers(&content, questions),
            }
        }),
        AgentElicitationResponse::Decline => json!({
            "outcome": { "outcome": "skipped" }
        }),
        AgentElicitationResponse::Cancel => json!({
            "outcome": { "outcome": "cancelled" }
        }),
    }
}

pub fn plan_response_from_elicitation(response: AgentElicitationResponse) -> Value {
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
                json!({ "outcome": { "outcome": "accepted" } })
            } else {
                let reason = labels
                    .into_iter()
                    .filter(|label| !label.eq_ignore_ascii_case(REJECT_LABEL))
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut rejected = json!({ "outcome": "rejected" });
                if !reason.is_empty() {
                    rejected["reason"] = Value::String(reason);
                }
                json!({ "outcome": rejected })
            }
        }
        AgentElicitationResponse::Decline => json!({
            "outcome": { "outcome": "rejected" }
        }),
        AgentElicitationResponse::Cancel => json!({
            "outcome": { "outcome": "cancelled" }
        }),
    }
}

fn question_id(question: &CursorAskQuestion, index: usize) -> String {
    let id = question.id.trim();
    if !id.is_empty() {
        return id.to_string();
    }
    let prompt = question.prompt.trim();
    if prompt.is_empty() {
        format!("question-{}", index + 1)
    } else {
        prompt.to_string()
    }
}

fn cursor_answers(content: &Value, questions: &[CursorAskQuestion]) -> Vec<Value> {
    let entries = answer_entries(content);
    questions
        .iter()
        .enumerate()
        .filter_map(|(index, question)| {
            let id = question_id(question, index);
            let labels = entries
                .iter()
                .find(|(question_id, _)| question_id == &id)
                .map(|(_, labels)| labels.as_slice())
                .filter(|labels| !labels.is_empty())
                .map(|labels| labels.to_vec())
                .unwrap_or_else(|| content.get(&id).map(string_values).unwrap_or_default());
            let selected = labels
                .iter()
                .map(|label| option_id(question, label))
                .collect::<Vec<_>>();
            if selected.is_empty() {
                None
            } else {
                Some(json!({
                    "questionId": id,
                    "selectedOptionIds": selected,
                }))
            }
        })
        .collect()
}

fn option_id(question: &CursorAskQuestion, selected: &str) -> String {
    question
        .options
        .iter()
        .find(|option| option.label == selected || option.id == selected)
        .map(|option| {
            let id = option.id.trim();
            if id.is_empty() {
                option.label.clone()
            } else {
                id.to_string()
            }
        })
        .unwrap_or_else(|| selected.to_string())
}

fn string_values(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
            .collect(),
        Value::String(text) if !text.trim().is_empty() => vec![text.clone()],
        _ => Vec::new(),
    }
}

fn format_todos(todos: &[CursorPlanTodo]) -> String {
    todos
        .iter()
        .filter(|todo| !todo.content.trim().is_empty())
        .map(|todo| format!("- [{}] {}", todo.status.trim(), todo.content.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn push_trimmed(parts: &mut Vec<String>, value: Option<&str>) {
    if let Some(text) = value.map(str::trim).filter(|text| !text.is_empty()) {
        parts.push(text.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_cursor_methods() {
        assert!(is_ask_question_method("cursor/ask_question"));
        assert!(is_ask_question_method("_cursor/ask_question"));
        assert!(is_create_plan_method("cursor/create_plan"));
        assert!(!is_ask_question_method("cursor/create_plan"));
        assert!(!is_create_plan_method("x.ai/ask_user_question"));
    }

    #[test]
    fn parses_official_ask_request() {
        let request = parse_ask_request(
            r#"{
                "toolCallId": "call-1",
                "title": "Decide next step",
                "questions": [{
                    "id": "db",
                    "prompt": "Which database?",
                    "allowMultiple": false,
                    "options": [
                        {"id": "pg", "label": "Postgres"},
                        {"id": "redis", "label": "Redis"}
                    ]
                }]
            }"#,
        )
        .expect("request");
        assert_eq!(request.tool_call_id, "call-1");
        assert_eq!(request.questions[0].id, "db");
        assert_eq!(request.questions[0].options[0].id, "pg");
        assert_eq!(request.questions[0].allow_multiple, Some(false));
    }

    #[test]
    fn maps_accept_labels_to_nested_option_ids() {
        let questions = vec![CursorAskQuestion {
            id: "db".into(),
            prompt: "Which database?".into(),
            options: vec![
                CursorAskOption {
                    id: "pg".into(),
                    label: "Postgres".into(),
                    description: None,
                },
                CursorAskOption {
                    id: "redis".into(),
                    label: "Redis".into(),
                    description: None,
                },
            ],
            allow_multiple: Some(false),
        }];
        let response = ask_response_from_elicitation(
            AgentElicitationResponse::Accept {
                content: json!({
                    "answers": [{
                        "questionId": "db",
                        "labels": ["Postgres"]
                    }]
                }),
            },
            &questions,
        );
        assert_eq!(response["outcome"]["outcome"], "answered");
        assert_eq!(response["outcome"]["answers"][0]["questionId"], "db");
        assert_eq!(
            response["outcome"]["answers"][0]["selectedOptionIds"],
            json!(["pg"])
        );
    }

    #[test]
    fn maps_decline_and_cancel_to_nested_outcomes() {
        let questions = [];
        assert_eq!(
            ask_response_from_elicitation(AgentElicitationResponse::Decline, &questions)["outcome"]
                ["outcome"],
            "skipped"
        );
        assert_eq!(
            ask_response_from_elicitation(AgentElicitationResponse::Cancel, &questions)["outcome"]
                ["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn maps_plan_approval_to_nested_accepted() {
        let response = plan_response_from_elicitation(AgentElicitationResponse::Accept {
            content: json!({
                "answers": [{ "questionId": "plan", "labels": ["Approve"] }]
            }),
        });
        assert_eq!(response["outcome"]["outcome"], "accepted");
    }

    #[test]
    fn maps_plan_rejection_reason() {
        let response = plan_response_from_elicitation(AgentElicitationResponse::Accept {
            content: json!({
                "answers": [{
                    "questionId": "plan",
                    "labels": ["Reject", "Too broad"]
                }]
            }),
        });
        assert_eq!(response["outcome"]["outcome"], "rejected");
        assert_eq!(response["outcome"]["reason"], "Too broad");
    }
}
