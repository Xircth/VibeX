use std::borrow::Cow;

use serde_json::{Value, json};

use crate::services::config::{Config, DEFAULT_PR_DESCRIPTION_PROMPT};

#[derive(Debug, thiserror::Error)]
pub enum PrDescriptionError {
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

pub const PR_DESCRIPTION_TIMEOUT_SECS: u64 = 60;
const PR_DESCRIPTION_CONTEXT_CHAR_LIMIT: usize = 32_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrDescriptionContext {
    pub task_title: Option<String>,
    pub task_description: Option<String>,
    pub base_branch: String,
    pub head_branch: String,
    pub commit_log: String,
    pub diff_stat: String,
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrDescriptionDraft {
    pub title: String,
    pub body: String,
}

pub fn selected_pr_description_agent(config: &Config) -> Option<&str> {
    let trimmed = config.pr_auto_description_agent_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn selected_pr_description_instruction(config: &Config) -> Cow<'_, str> {
    let trimmed = config
        .pr_auto_description_prompt
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();

    if trimmed.is_empty() {
        Cow::Borrowed(DEFAULT_PR_DESCRIPTION_PROMPT)
    } else {
        Cow::Owned(trimmed.to_string())
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    format!("{truncated}\n…")
}

pub fn build_pr_description_payload(
    config: &Config,
    context: &PrDescriptionContext,
) -> Result<String, PrDescriptionError> {
    let remaining = PR_DESCRIPTION_CONTEXT_CHAR_LIMIT;
    let commit_log = truncate_chars(&context.commit_log, remaining / 4);
    let diff_stat = truncate_chars(&context.diff_stat, remaining / 4);
    let used = commit_log.len() + diff_stat.len();
    let diff = truncate_chars(
        &context.diff,
        remaining.saturating_sub(used).max(remaining / 2),
    );

    let request_body = json!({
        "task": "Write a pull request title and description.",
        "requirements": {
            "returnJsonOnly": true,
            "outputFields": ["Title", "Body"]
        },
        "taskTitle": context.task_title.clone().unwrap_or_default(),
        "taskDescription": context.task_description.clone().unwrap_or_default(),
        "baseBranch": context.base_branch,
        "headBranch": context.head_branch,
        "commitLog": commit_log,
        "diffStat": diff_stat,
        "diff": diff,
    });

    serde_json::to_string_pretty(&request_body)
        .map(|body| {
            format!(
                "{}\n\nInput:\n{}",
                selected_pr_description_instruction(config),
                body
            )
        })
        .map_err(|error| {
            PrDescriptionError::Internal(format!("Failed to build PR description payload: {error}"))
        })
}

pub fn validate_pr_description_request(config: &Config) -> Result<(), PrDescriptionError> {
    if !config.pr_auto_description_enabled {
        return Err(PrDescriptionError::BadRequest(
            "Automatic PR description is disabled in system settings".to_string(),
        ));
    }

    if selected_pr_description_agent(config).is_none() {
        return Err(PrDescriptionError::BadRequest(
            "Choose an Agent in Settings → Version Control before generating a PR description."
                .to_string(),
        ));
    }

    Ok(())
}

fn extract_draft_from_json_value(value: &Value) -> Option<PrDescriptionDraft> {
    match value {
        Value::Object(map) => {
            let title = map
                .get("Title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty());
            let body = map
                .get("Body")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|body| !body.is_empty());
            if let (Some(title), Some(body)) = (title, body) {
                return Some(PrDescriptionDraft {
                    title: title.to_string(),
                    body: body.to_string(),
                });
            }

            map.values().find_map(extract_draft_from_json_value)
        }
        Value::Array(items) => items.iter().find_map(extract_draft_from_json_value),
        Value::String(text) => extract_pr_description(text),
        _ => None,
    }
}

pub fn extract_pr_description(raw: &str) -> Option<PrDescriptionDraft> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed)
        && let Some(draft) = extract_draft_from_json_value(&value)
    {
        return Some(draft);
    }

    for line in trimmed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<Value>(line)
            && let Some(draft) = extract_draft_from_json_value(&value)
        {
            return Some(draft);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        PrDescriptionContext, build_pr_description_payload, extract_pr_description,
        selected_pr_description_agent, validate_pr_description_request,
    };
    use crate::services::config::Config;

    fn config_with_pr_agent() -> Config {
        Config {
            pr_auto_description_enabled: true,
            pr_auto_description_agent_id: "codex".to_string(),
            ..Config::default()
        }
    }

    #[test]
    fn selected_agent_ignores_blank_ids() {
        let blank = Config {
            pr_auto_description_agent_id: "  ".to_string(),
            ..Config::default()
        };
        assert!(selected_pr_description_agent(&blank).is_none());
        let selected = Config {
            pr_auto_description_agent_id: "opencode".to_string(),
            ..Config::default()
        };
        assert_eq!(selected_pr_description_agent(&selected), Some("opencode"));
    }

    #[test]
    fn validation_requires_an_enabled_setting_and_agent() {
        let disabled = Config {
            pr_auto_description_enabled: false,
            pr_auto_description_agent_id: "codex".to_string(),
            ..Config::default()
        };
        assert!(validate_pr_description_request(&disabled).is_err());

        let missing_agent = Config {
            pr_auto_description_enabled: true,
            pr_auto_description_agent_id: String::new(),
            ..Config::default()
        };
        assert!(validate_pr_description_request(&missing_agent).is_err());

        assert!(validate_pr_description_request(&config_with_pr_agent()).is_ok());
    }

    #[test]
    fn payload_includes_git_and_task_context() {
        let payload = build_pr_description_payload(
            &config_with_pr_agent(),
            &PrDescriptionContext {
                task_title: Some("Fix login".to_string()),
                task_description: Some("Users cannot sign in".to_string()),
                base_branch: "main".to_string(),
                head_branch: "fix/login".to_string(),
                commit_log: "abc123 Fix login timeout".to_string(),
                diff_stat: " src/auth.rs | 12 ++++++++----".to_string(),
                diff: "diff --git a/src/auth.rs b/src/auth.rs".to_string(),
            },
        )
        .expect("payload");

        assert!(payload.contains("Fix login"));
        assert!(payload.contains("abc123 Fix login timeout"));
        assert!(payload.contains("src/auth.rs"));
        assert!(payload.contains("\"Title\""));
        assert!(payload.contains("\"Body\""));
    }

    #[test]
    fn extracts_title_and_body_from_plain_json() {
        let raw = r#"{"Title":"Fix login timeout (VibeX)","Body":"Users can sign in again."}"#;
        let draft = extract_pr_description(raw).expect("draft");
        assert_eq!(draft.title, "Fix login timeout (VibeX)");
        assert_eq!(draft.body, "Users can sign in again.");
    }

    #[test]
    fn extracts_title_and_body_from_nested_payload() {
        let raw = r#"{"type":"assistant","content":"{\"Title\":\"Add retries (VibeX)\",\"Body\":\"Retry failed requests.\"}"}"#;
        let draft = extract_pr_description(raw).expect("draft");
        assert_eq!(draft.title, "Add retries (VibeX)");
        assert_eq!(draft.body, "Retry failed requests.");
    }
}
