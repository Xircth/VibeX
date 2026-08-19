use std::{collections::BTreeSet, path::PathBuf};

use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_turn::ConversationTurnRecord,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use services::services::config::{
    COMMIT_CHANGES_INSTRUCTION_COMMAND, COMMIT_CHANGES_INSTRUCTION_CONTENT, CommitReminderMode,
};
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
    Start {
        display_text: String,
        agent_prompt: String,
    },
    Defer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UncommittedChanges {
    pub line_count: u64,
}

pub fn decide_commit_reminder(
    enabled: bool,
    mode: CommitReminderMode,
    line_threshold: u32,
    completed_turn_origin: &str,
    changes: &UncommittedChanges,
) -> CommitReminderDecision {
    if !enabled
        || !matches!(completed_turn_origin, LOCAL_USER_ORIGIN | USER_ORIGIN)
        || changes.line_count <= u64::from(line_threshold)
    {
        return CommitReminderDecision::Skip;
    }

    match mode {
        CommitReminderMode::SeparateTurn => CommitReminderDecision::Start {
            display_text: COMMIT_CHANGES_INSTRUCTION_COMMAND.to_string(),
            agent_prompt: commit_changes_prompt(changes),
        },
        CommitReminderMode::Smart => CommitReminderDecision::Defer,
    }
}

fn commit_changes_prompt(changes: &UncommittedChanges) -> String {
    format!(
        "{COMMIT_CHANGES_INSTRUCTION_CONTENT}\n\nCurrent uncommitted change size: {} added/deleted lines.",
        changes.line_count
    )
}

pub fn is_complete_ai_reply(stop_reason: Option<&str>) -> bool {
    normalized_stop_reason(stop_reason).as_deref() == Some("endturn")
}

pub fn is_cancelled_stop_reason(stop_reason: Option<&str>) -> bool {
    matches!(
        normalized_stop_reason(stop_reason).as_deref(),
        Some("cancelled" | "canceled")
    )
}

fn normalized_stop_reason(stop_reason: Option<&str>) -> Option<String> {
    stop_reason.map(|reason| {
        reason
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
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
    let (enabled, mode, line_threshold) = {
        let config = context.deployment.config().read().await;
        (
            config.commit_reminder_enabled,
            config.commit_reminder_mode,
            config.commit_reminder_line_threshold,
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
    let changes = collect_uncommitted_changes(&context, workspace.clone()).await?;
    let decision = decide_commit_reminder(
        enabled,
        mode,
        line_threshold,
        &completed_turn.origin,
        &changes,
    );
    if decision == CommitReminderDecision::Defer {
        let mut states = context.runtime_states.lock().await;
        states
            .entry(conversation_id)
            .or_default()
            .commit_reminder_pending = true;
        return Ok(false);
    }
    let CommitReminderDecision::Start {
        display_text,
        agent_prompt,
    } = decision
    else {
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
                text: agent_prompt,
                display_text: Some(display_text),
                images: Vec::new(),
                workflow_refs: Vec::new(),
                file_refs: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
                queued_input_claim: None,
                operation_id: None,
            },
            COMMIT_REMINDER_ORIGIN,
        )
        .await?;
    Ok(true)
}

pub(crate) async fn collect_uncommitted_changes(
    context: &ConversationContext,
    mut workspace: Workspace,
) -> Result<UncommittedChanges, ConversationServiceError> {
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
        let mut line_count = 0_u64;
        for repo_path in repo_paths {
            let Ok(status) = git.get_detailed_status(&repo_path) else {
                continue;
            };
            if status.staged_files.is_empty() && status.unstaged_files.is_empty() {
                continue;
            }
            line_count = line_count.saturating_add(
                status.total_additions.max(0) as u64 + status.total_deletions.max(0) as u64,
            );
        }
        UncommittedChanges { line_count }
    })
    .await
    .map_err(|error| {
        ConversationServiceError::Internal(format!(
            "Failed to inspect uncommitted changes: {error}"
        ))
    })
}

pub(crate) async fn pending_smart_reminder_prompt(
    context: &ConversationContext,
    conversation_id: Uuid,
    workspace: Workspace,
    origin: &str,
) -> Result<Option<String>, ConversationServiceError> {
    if !matches!(origin, LOCAL_USER_ORIGIN | USER_ORIGIN) {
        return Ok(None);
    }
    let pending = context
        .runtime_states
        .lock()
        .await
        .get(&conversation_id)
        .is_some_and(|state| state.commit_reminder_pending);
    if !pending {
        return Ok(None);
    }

    let (enabled, mode, threshold) = {
        let config = context.deployment.config().read().await;
        (
            config.commit_reminder_enabled,
            config.commit_reminder_mode,
            config.commit_reminder_line_threshold,
        )
    };
    if !enabled || mode != CommitReminderMode::Smart {
        clear_pending_smart_reminder(context, conversation_id).await;
        return Ok(None);
    }

    let changes = collect_uncommitted_changes(context, workspace).await?;
    if changes.line_count <= u64::from(threshold) {
        clear_pending_smart_reminder(context, conversation_id).await;
        return Ok(None);
    }
    Ok(Some(commit_changes_prompt(&changes)))
}

pub(crate) async fn clear_pending_smart_reminder(
    context: &ConversationContext,
    conversation_id: Uuid,
) {
    if let Some(state) = context
        .runtime_states
        .lock()
        .await
        .get_mut(&conversation_id)
    {
        state.commit_reminder_pending = false;
    }
}

#[cfg(test)]
mod tests {
    use services::services::config::CommitReminderMode;

    use super::{
        AUTOMATION_ORIGIN, CommitReminderDecision, LOCAL_USER_ORIGIN, USER_ORIGIN,
        UncommittedChanges, decide_commit_reminder, is_complete_ai_reply,
    };

    fn changes(line_count: u64) -> UncommittedChanges {
        UncommittedChanges { line_count }
    }

    #[test]
    fn starts_one_follow_up_for_a_dirty_user_turn() {
        let decision = decide_commit_reminder(
            true,
            CommitReminderMode::SeparateTurn,
            10,
            USER_ORIGIN,
            &changes(11),
        );

        let CommitReminderDecision::Start {
            display_text,
            agent_prompt,
        } = decision
        else {
            panic!("dirty user turn should start a reminder");
        };
        assert_eq!(display_text, "#commit_changes");
        assert!(agent_prompt.contains("git diff --staged"));
        assert!(agent_prompt.contains("11 added/deleted lines"));
    }

    #[test]
    fn local_desktop_user_turns_also_start_commit_reminders() {
        assert!(matches!(
            decide_commit_reminder(
                true,
                CommitReminderMode::SeparateTurn,
                0,
                LOCAL_USER_ORIGIN,
                &changes(1),
            ),
            CommitReminderDecision::Start { .. }
        ));
    }

    #[test]
    fn smart_mode_defers_the_instruction_to_the_next_user_turn() {
        assert_eq!(
            decide_commit_reminder(
                true,
                CommitReminderMode::Smart,
                100,
                USER_ORIGIN,
                &changes(101),
            ),
            CommitReminderDecision::Defer,
        );
    }

    #[test]
    fn skips_until_changed_lines_exceed_the_configured_boundary() {
        assert_eq!(
            decide_commit_reminder(
                true,
                CommitReminderMode::SeparateTurn,
                100,
                USER_ORIGIN,
                &changes(100),
            ),
            CommitReminderDecision::Skip,
        );
    }

    #[test]
    fn never_recurses_after_the_commit_reminder_turn() {
        assert_eq!(
            decide_commit_reminder(
                true,
                CommitReminderMode::SeparateTurn,
                0,
                "commit_reminder",
                &changes(1),
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
            decide_commit_reminder(
                false,
                CommitReminderMode::SeparateTurn,
                0,
                "user",
                &changes(1),
            ),
            CommitReminderDecision::Skip,
        );
        assert_eq!(
            decide_commit_reminder(
                true,
                CommitReminderMode::SeparateTurn,
                0,
                AUTOMATION_ORIGIN,
                &changes(1),
            ),
            CommitReminderDecision::Skip,
        );
        assert_eq!(
            decide_commit_reminder(
                true,
                CommitReminderMode::SeparateTurn,
                0,
                "user",
                &changes(0),
            ),
            CommitReminderDecision::Skip,
        );
    }
}
