//! Grok's ACP reverse-request for `ask_user_question`.
//!
//! Grok does not use `elicitation/create`. The tool blocks on the vendor
//! `x.ai/ask_user_question` ext-method until the client returns a typed
//! `{ outcome, answers }` payload. Host routing lives in `ext_question`;
//! this module owns Grok's wire shapes and the card conversion.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::elicitation::AgentElicitationResponse;

pub const ASK_USER_QUESTION_METHOD: &str = "x.ai/ask_user_question";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionExtRequest {
    pub session_id: String,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub questions: Vec<AskUserQuestion>,
    #[serde(default)]
    pub mode: AskUserQuestionMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskUserQuestionMode {
    #[default]
    Default,
    Plan,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestion {
    pub question: String,
    #[serde(default)]
    pub options: Vec<AskUserQuestionOption>,
    #[serde(default, alias = "multi_select")]
    pub multi_select: Option<bool>,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskUserQuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

pub fn normalize_method(method: &str) -> &str {
    method.strip_prefix('_').unwrap_or(method)
}

pub fn is_ask_user_question_method(method: &str) -> bool {
    normalize_method(method) == ASK_USER_QUESTION_METHOD
}

pub fn parse_request(params: &str) -> Result<AskUserQuestionExtRequest, String> {
    let value: Value =
        serde_json::from_str(params).map_err(|error| format!("invalid JSON: {error}"))?;
    let payload = value
        .get("params")
        .filter(|inner| inner.get("questions").is_some() || inner.get("sessionId").is_some())
        .cloned()
        .unwrap_or(value);
    serde_json::from_value(payload).map_err(|error| format!("invalid ask_user_question: {error}"))
}

pub fn question_schema(questions: &[AskUserQuestion]) -> Value {
    json!({
        "type": "object",
        "x-vibex-questions": questions
            .iter()
            .enumerate()
            .map(|(index, question)| {
                json!({
                    "id": question_key(question, index),
                    "header": question_header(question, index),
                    "question": question.question,
                    "multiSelect": question.multi_select.unwrap_or(false),
                    "options": question.options.iter().map(|option| {
                        json!({
                            "label": option.label,
                            "description": option.description,
                        })
                    }).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>(),
    })
}

pub fn prompt_from_questions(questions: &[AskUserQuestion]) -> String {
    questions
        .iter()
        .map(|question| question.question.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn ext_response_from_elicitation(
    response: AgentElicitationResponse,
    questions: &[AskUserQuestion],
) -> Value {
    match response {
        AgentElicitationResponse::Accept { content } => json!({
            "outcome": "accepted",
            "answers": answers_from_content(&content, questions),
        }),
        AgentElicitationResponse::Decline | AgentElicitationResponse::Cancel => {
            json!({ "outcome": "cancelled" })
        }
    }
}

fn question_key(question: &AskUserQuestion, index: usize) -> String {
    question
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(question.question.trim())
        .to_string()
        .if_empty(|| format!("question-{}", index + 1))
}

fn question_header(question: &AskUserQuestion, index: usize) -> String {
    let text = question.question.trim();
    if text.chars().count() <= 16 {
        return if text.is_empty() {
            format!("问题 {}", index + 1)
        } else {
            text.to_string()
        };
    }
    let mut header: String = text.chars().take(16).collect();
    header.push('…');
    header
}

fn answers_from_content(content: &Value, questions: &[AskUserQuestion]) -> Value {
    let mut answers = serde_json::Map::new();
    if let Some(items) = content.get("answers").and_then(Value::as_array) {
        for item in items {
            let Some(question_id) = item.get("questionId").and_then(Value::as_str) else {
                continue;
            };
            let labels = string_list(item.get("labels"));
            if !labels.is_empty() {
                answers.insert(question_id.to_string(), Value::Array(labels));
            }
        }
        if !answers.is_empty() {
            return Value::Object(answers);
        }
    }

    for (index, question) in questions.iter().enumerate() {
        let key = question_key(question, index);
        if let Some(value) = content.get(&key) {
            let labels = match value {
                Value::Array(items) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .map(Value::String)
                    .collect(),
                Value::String(text) if !text.trim().is_empty() => vec![Value::String(text.clone())],
                _ => Vec::new(),
            };
            if !labels.is_empty() {
                answers.insert(key, Value::Array(labels));
            }
        }
    }
    Value::Object(answers)
}

fn string_list(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(|text| Value::String(text.to_string()))
            .collect(),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            vec![Value::String(text.clone())]
        }
        _ => Vec::new(),
    }
}

trait IfEmpty {
    fn if_empty(self, fallback: impl FnOnce() -> String) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() { fallback() } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_both_wire_method_forms() {
        assert!(is_ask_user_question_method("x.ai/ask_user_question"));
        assert!(is_ask_user_question_method("_x.ai/ask_user_question"));
        assert!(!is_ask_user_question_method("x.ai/announcements/update"));
    }

    #[test]
    fn parses_camel_case_request() {
        let request = parse_request(
            r#"{
                "sessionId": "sess-1",
                "toolCallId": "call-1",
                "mode": "default",
                "questions": [{
                    "question": "Which database?",
                    "multiSelect": false,
                    "options": [
                        {"label": "Postgres (Recommended)", "description": "Relational"},
                        {"label": "Redis", "description": "Cache"}
                    ]
                }]
            }"#,
        )
        .expect("request");
        assert_eq!(request.session_id, "sess-1");
        assert_eq!(request.tool_call_id, "call-1");
        assert_eq!(request.questions[0].question, "Which database?");
        assert_eq!(
            request.questions[0].options[0].label,
            "Postgres (Recommended)"
        );
        assert_eq!(request.questions[0].multi_select, Some(false));
    }

    #[test]
    fn unwraps_nested_params_envelope() {
        let request = parse_request(
            r#"{
                "method": "x.ai/ask_user_question",
                "params": {
                    "sessionId": "sess-2",
                    "questions": [{"question": "Ready?", "options": []}]
                }
            }"#,
        )
        .expect("nested request");
        assert_eq!(request.session_id, "sess-2");
        assert_eq!(request.questions[0].question, "Ready?");
    }

    #[test]
    fn maps_accept_content_to_grok_answers() {
        let questions = vec![AskUserQuestion {
            question: "Which database?".into(),
            options: vec![AskUserQuestionOption {
                label: "Postgres (Recommended)".into(),
                description: "Relational".into(),
            }],
            multi_select: Some(false),
            id: None,
        }];
        let response = ext_response_from_elicitation(
            AgentElicitationResponse::Accept {
                content: json!({
                    "answers": [{
                        "questionId": "Which database?",
                        "labels": ["Postgres (Recommended)"]
                    }]
                }),
            },
            &questions,
        );
        assert_eq!(response["outcome"], "accepted");
        assert_eq!(
            response["answers"]["Which database?"],
            json!(["Postgres (Recommended)"])
        );
    }

    #[test]
    fn maps_cancel_and_decline_to_cancelled_outcome() {
        let questions = [];
        assert_eq!(
            ext_response_from_elicitation(AgentElicitationResponse::Cancel, &questions)["outcome"],
            "cancelled"
        );
        assert_eq!(
            ext_response_from_elicitation(AgentElicitationResponse::Decline, &questions)["outcome"],
            "cancelled"
        );
    }
}
