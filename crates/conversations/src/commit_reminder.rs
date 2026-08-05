use std::{collections::BTreeSet, path::PathBuf};

use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_turn::ConversationTurnRecord,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use services::services::config::DEFAULT_COMMIT_REMINDER_PROMPT;
use uuid::Uuid;

use crate::{
    ConversationContext, ConversationServiceError, ConversationSessionService,
    ConversationStartTurnInput,
};

pub const COMMIT_REMINDER_ORIGIN: &str = "commit_reminder";
pub const LOCAL_USER_ORIGIN: &str = "local_user";
pub const USER_ORIGIN: &str = "user";
pub const AUTOMATION_ORIGIN: &str = "automation";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitReminderDecision {
    Skip,
    Start { prompt: String },
}

pub fn decide_commit_reminder(
    enabled: bool,
    completed_turn_origin: &str,
    custom_prompt: Option<&str>,
    uncommitted_changes: &str,
) -> CommitReminderDecision {
    if !enabled
        || !matches!(completed_turn_origin, LOCAL_USER_ORIGIN | USER_ORIGIN)
        || uncommitted_changes.trim().is_empty()
    {
        return CommitReminderDecision::Skip;
    }

    let prompt = custom_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .unwrap_or(DEFAULT_COMMIT_REMINDER_PROMPT);
    CommitReminderDecision::Start {
        prompt: format!(
            "{prompt}\n\nUncommitted changes detected:\n```text\n{}\n```",
            uncommitted_changes.trim()
        ),
    }
}

pub fn is_complete_ai_reply(stop_reason: Option<&str>) -> bool {
    stop_reason.is_some_and(|reason| {
        reason
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .map(|character| character.to_ascii_lowercase())
            .eq("endturn".chars())
    })
}

/// Start the single automatic follow-up owned by the commit-reminder setting.
/// Returns `true` only when a follow-up turn was successfully started.
pub async fn start_commit_reminder_if_needed(
    context: ConversationContext,
    conversation_id: Uuid,
    completed_turn_id: Uuid,
) -> Result<bool, ConversationServiceError> {
    let pool = &context.deployment.db().pool;
    let completed_turn = ConversationTurnRecord::find_by_id(pool, completed_turn_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Completed turn {completed_turn_id} not found"
            ))
        })?;
    let (enabled, custom_prompt) = {
        let config = context.deployment.config().read().await;
        (
            config.commit_reminder_enabled,
            config.commit_reminder_prompt.clone(),
        )
    };
    if !enabled
        || !matches!(
            completed_turn.origin.as_str(),
            LOCAL_USER_ORIGIN | USER_ORIGIN
        )
    {
        return Ok(false);
    }

    let conversation = ConversationRecord::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!("Conversation {conversation_id} not found"))
        })?;
    let workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Workspace {} not found",
                conversation.workspace_id
            ))
        })?;
    let uncommitted_changes = collect_uncommitted_changes(&context, workspace.clone()).await?;
    let CommitReminderDecision::Start { prompt } = decide_commit_reminder(
        enabled,
        &completed_turn.origin,
        custom_prompt.as_deref(),
        &uncommitted_changes,
    ) else {
        return Ok(false);
    };

    let binding = ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Conversation {conversation_id} has no Agent binding"
            ))
        })?;
    ConversationSessionService::new(context)
        .start_turn_with_origin(
            ConversationStartTurnInput {
                agent_id: binding.agent_id,
                workspace_id: workspace.id,
                conversation_id,
                executor_profile_id: None,
                text: prompt,
                images: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
            },
            COMMIT_REMINDER_ORIGIN,
        )
        .await?;
    Ok(true)
}

async fn collect_uncommitted_changes(
    context: &ConversationContext,
    mut workspace: Workspace,
) -> Result<String, ConversationServiceError> {
    let pool = &context.deployment.db().pool;
    let container_ref = context
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let mut repo_paths = BTreeSet::new();
    for repo in repos {
        repo_paths.insert(
            workspace
                .repo_path(&repo)
                .unwrap_or_else(|| PathBuf::from(&container_ref)),
        );
    }
    if repo_paths.is_empty() {
        repo_paths.insert(PathBuf::from(&container_ref));
    }
    let git = context.deployment.git().clone();
    tokio::task::spawn_blocking(move || {
        let mut all_status = String::new();
        for repo_path in repo_paths {
            let Ok(status) = git.get_worktree_status(&repo_path) else {
                continue;
            };
            if status.entries.is_empty() {
                continue;
            }
            all_status.push_str(&format!("\n{}:\n", repo_path.display()));
            for entry in status.entries {
                all_status.push(entry.staged);
                all_status.push(entry.unstaged);
                all_status.push(' ');
                all_status.push_str(&String::from_utf8_lossy(&entry.path));
                all_status.push('\n');
            }
        }
        all_status
    })
    .await
    .map_err(|error| {
        ConversationServiceError::Internal(format!(
            "Failed to inspect uncommitted changes: {error}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        AUTOMATION_ORIGIN, CommitReminderDecision, LOCAL_USER_ORIGIN, USER_ORIGIN,
        decide_commit_reminder, is_complete_ai_reply,
    };

    #[test]
    fn starts_one_follow_up_for_a_dirty_user_turn() {
        let decision =
            decide_commit_reminder(true, USER_ORIGIN, None, "/workspace/repo:\n M src/main.rs");

        let CommitReminderDecision::Start { prompt } = decision else {
            panic!("dirty user turn should start a reminder");
        };
        assert!(prompt.contains("git diff --staged"));
        assert!(prompt.contains("/workspace/repo"));
    }

    #[test]
    fn local_desktop_user_turns_also_start_commit_reminders() {
        assert!(matches!(
            decide_commit_reminder(true, LOCAL_USER_ORIGIN, None, " M src/main.rs"),
            CommitReminderDecision::Start { .. }
        ));
    }

    #[test]
    fn never_recurses_after_the_commit_reminder_turn() {
        assert_eq!(
            decide_commit_reminder(
                true,
                "commit_reminder",
                Some("Commit the changes"),
                "/workspace/repo:\n M src/main.rs",
            ),
            CommitReminderDecision::Skip,
        );
    }

    #[test]
    fn only_successful_end_turn_is_a_complete_ai_reply() {
        assert!(is_complete_ai_reply(Some("end_turn")));
        assert!(is_complete_ai_reply(Some("EndTurn")));
        assert!(!is_complete_ai_reply(Some("cancelled")));
        assert!(!is_complete_ai_reply(Some("canceled_by_user")));
        assert!(!is_complete_ai_reply(Some("max_tokens")));
        assert!(!is_complete_ai_reply(Some("MaxTurnRequests")));
        assert!(!is_complete_ai_reply(Some("refusal")));
        assert!(!is_complete_ai_reply(None));
    }

    #[test]
    fn skips_disabled_or_clean_workspaces() {
        assert_eq!(
            decide_commit_reminder(false, "user", None, " M src/main.rs"),
            CommitReminderDecision::Skip,
        );
        assert_eq!(
            decide_commit_reminder(true, AUTOMATION_ORIGIN, None, " M src/main.rs"),
            CommitReminderDecision::Skip,
        );
        assert_eq!(
            decide_commit_reminder(true, "user", None, "  \n"),
            CommitReminderDecision::Skip,
        );
    }
}
