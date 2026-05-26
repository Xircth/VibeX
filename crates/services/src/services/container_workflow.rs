use std::path::{Path, PathBuf};

use db::models::{
    execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus},
    task::TaskStatus,
};
use executors::{
    actions::{ExecutorAction, ExecutorActionType},
    logs::{NormalizedEntry, NormalizedEntryError, NormalizedEntryType},
    profile::ExecutorProfileId,
};
use git::WorktreeResetOptions;

#[derive(Debug, PartialEq)]
pub(super) struct LogNormalizationTarget {
    pub executor_profile_id: ExecutorProfileId,
    pub working_dir: PathBuf,
}

pub(super) fn should_finalize_execution(
    status: &ExecutionProcessStatus,
    run_reason: &ExecutionProcessRunReason,
    action: &ExecutorAction,
) -> bool {
    if matches!(run_reason, ExecutionProcessRunReason::DevServer) {
        return false;
    }

    if matches!(run_reason, ExecutionProcessRunReason::SetupScript) && action.next_action.is_none()
    {
        return false;
    }

    if matches!(
        status,
        ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed
    ) {
        return true;
    }

    action.next_action.is_none()
}

pub(super) fn next_action_run_reason(
    current_action: &ExecutorAction,
    next_action: &ExecutorAction,
) -> ExecutionProcessRunReason {
    match (current_action.typ(), next_action.typ()) {
        (ExecutorActionType::ScriptRequest(_), ExecutorActionType::ScriptRequest(_)) => {
            ExecutionProcessRunReason::SetupScript
        }
        (
            ExecutorActionType::CodingAgentInitialRequest(_)
            | ExecutorActionType::CodingAgentFollowUpRequest(_)
            | ExecutorActionType::ReviewRequest(_),
            ExecutorActionType::ScriptRequest(_),
        ) => ExecutionProcessRunReason::CleanupScript,
        (
            _,
            ExecutorActionType::CodingAgentFollowUpRequest(_)
            | ExecutorActionType::CodingAgentInitialRequest(_)
            | ExecutorActionType::ReviewRequest(_),
        ) => ExecutionProcessRunReason::CodingAgent,
    }
}

pub(super) fn should_stop_execution(
    status: &ExecutionProcessStatus,
    run_reason: &ExecutionProcessRunReason,
    include_dev_server: bool,
) -> bool {
    matches!(status, ExecutionProcessStatus::Running)
        && (include_dev_server || !matches!(run_reason, ExecutionProcessRunReason::DevServer))
}

pub(super) fn should_mark_session_in_progress_on_start(
    run_reason: &ExecutionProcessRunReason,
) -> bool {
    !matches!(run_reason, ExecutionProcessRunReason::DevServer)
}

pub(super) fn should_mark_task_in_progress_on_start(
    run_reason: &ExecutionProcessRunReason,
    current_status: &TaskStatus,
) -> bool {
    should_mark_session_in_progress_on_start(run_reason)
        && !matches!(current_status, TaskStatus::InProgress)
}

pub(super) fn should_unarchive_workspace_on_start(run_reason: &ExecutionProcessRunReason) -> bool {
    !matches!(run_reason, ExecutionProcessRunReason::ArchiveScript)
}

pub(super) fn should_mark_session_in_review_after_orphan_cleanup(
    run_reason: &ExecutionProcessRunReason,
) -> bool {
    matches!(
        run_reason,
        ExecutionProcessRunReason::CodingAgent
            | ExecutionProcessRunReason::SetupScript
            | ExecutionProcessRunReason::CleanupScript
    )
}

pub(super) fn coding_agent_turn_prompt(action: &ExecutorAction) -> Option<&str> {
    match action.typ() {
        ExecutorActionType::CodingAgentInitialRequest(request) => Some(request.prompt.as_str()),
        ExecutorActionType::CodingAgentFollowUpRequest(request) => Some(request.prompt.as_str()),
        ExecutorActionType::ReviewRequest(request) => Some(request.prompt.as_str()),
        ExecutorActionType::ScriptRequest(_) => None,
    }
}

pub(super) fn missing_executable_start_error_entry(program: &str) -> NormalizedEntry {
    NormalizedEntry {
        timestamp: None,
        entry_type: NormalizedEntryType::ErrorMessage {
            error_type: NormalizedEntryError::SetupRequired,
        },
        content: format!("The required executable `{program}` is not installed."),
        metadata: None,
    }
}

pub(super) fn log_normalization_target(
    action: &ExecutorAction,
    workspace_root: &Path,
) -> Option<LogNormalizationTarget> {
    match action.typ() {
        ExecutorActionType::CodingAgentInitialRequest(request) => Some(LogNormalizationTarget {
            executor_profile_id: request.executor_config.profile_id(),
            working_dir: request.effective_dir(workspace_root),
        }),
        ExecutorActionType::CodingAgentFollowUpRequest(request) => Some(LogNormalizationTarget {
            executor_profile_id: request.executor_config.profile_id(),
            working_dir: request.effective_dir(workspace_root),
        }),
        ExecutorActionType::ReviewRequest(request) => Some(LogNormalizationTarget {
            executor_profile_id: request.executor_config.profile_id(),
            working_dir: request.effective_dir(workspace_root),
        }),
        ExecutorActionType::ScriptRequest(_) => None,
    }
}

pub(super) fn completion_notification(
    status: &ExecutionProcessStatus,
    task_title: &str,
    workspace_branch: &str,
    session_executor: Option<&str>,
) -> Option<(String, String)> {
    let title = format!("Task Complete: {task_title}");
    let message = match status {
        ExecutionProcessStatus::Completed => format!(
            "✅ '{}' completed successfully\nBranch: {:?}\nExecutor: {:?}",
            task_title, workspace_branch, session_executor
        ),
        ExecutionProcessStatus::Failed => format!(
            "❌ '{}' execution failed\nBranch: {:?}\nExecutor: {:?}",
            task_title, workspace_branch, session_executor
        ),
        _ => return None,
    };

    Some((title, message))
}

pub(super) fn reset_target_oid(
    before_head_commit: Option<&str>,
    previous_after_head_commit: Option<&str>,
) -> Option<String> {
    before_head_commit
        .or(previous_after_head_commit)
        .map(ToOwned::to_owned)
}

pub(super) fn reset_options(
    perform_git_reset: bool,
    force_when_dirty: bool,
    is_dirty: bool,
) -> WorktreeResetOptions {
    WorktreeResetOptions::new(
        perform_git_reset,
        force_when_dirty,
        is_dirty,
        perform_git_reset,
    )
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use db::models::{
        execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus},
        task::TaskStatus,
    };
    use executors::{
        actions::{
            ExecutorAction, ExecutorActionType,
            coding_agent_follow_up::CodingAgentFollowUpRequest,
            coding_agent_initial::CodingAgentInitialRequest,
            review::ReviewRequest,
            script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
        },
        executors::BaseCodingAgent,
        logs::{NormalizedEntryError, NormalizedEntryType},
        profile::ExecutorConfig,
    };

    use super::{
        coding_agent_turn_prompt, completion_notification, log_normalization_target,
        missing_executable_start_error_entry, next_action_run_reason, reset_options,
        reset_target_oid, should_finalize_execution, should_mark_session_in_progress_on_start,
        should_mark_session_in_review_after_orphan_cleanup, should_mark_task_in_progress_on_start,
        should_stop_execution, should_unarchive_workspace_on_start,
    };

    fn script_action(next_action: Option<ExecutorAction>) -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "echo ok".to_string(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::SetupScript,
                working_dir: None,
            }),
            next_action.map(Box::new),
        )
    }

    fn initial_action(next_action: Option<ExecutorAction>) -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: "implement".to_string(),
                executor_config: ExecutorConfig::new(BaseCodingAgent::Codex),
                working_dir: None,
            }),
            next_action.map(Box::new),
        )
    }

    fn follow_up_action(next_action: Option<ExecutorAction>) -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
                prompt: "continue".to_string(),
                session_id: "session-1".to_string(),
                reset_to_message_id: None,
                executor_config: ExecutorConfig::new(BaseCodingAgent::Codex),
                working_dir: None,
            }),
            next_action.map(Box::new),
        )
    }

    fn review_action(next_action: Option<ExecutorAction>) -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::ReviewRequest(ReviewRequest {
                executor_config: ExecutorConfig::new(BaseCodingAgent::Codex),
                context: None,
                prompt: "review".to_string(),
                session_id: None,
                working_dir: None,
            }),
            next_action.map(Box::new),
        )
    }

    fn action_with_working_dir(action: ExecutorAction, working_dir: &str) -> ExecutorAction {
        match action.typ() {
            ExecutorActionType::CodingAgentInitialRequest(request) => ExecutorAction::new(
                ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                    working_dir: Some(working_dir.to_string()),
                    ..request.clone()
                }),
                action.next_action().cloned().map(Box::new),
            ),
            ExecutorActionType::CodingAgentFollowUpRequest(request) => ExecutorAction::new(
                ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
                    working_dir: Some(working_dir.to_string()),
                    ..request.clone()
                }),
                action.next_action().cloned().map(Box::new),
            ),
            ExecutorActionType::ReviewRequest(request) => ExecutorAction::new(
                ExecutorActionType::ReviewRequest(ReviewRequest {
                    working_dir: Some(working_dir.to_string()),
                    ..request.clone()
                }),
                action.next_action().cloned().map(Box::new),
            ),
            ExecutorActionType::ScriptRequest(_) => action,
        }
    }

    fn assert_normalization_target(action: &ExecutorAction, expected_dir: PathBuf) {
        let root = Path::new("workspace-root");
        let target = log_normalization_target(action, root).expect("normalization target");

        assert_eq!(
            target.executor_profile_id,
            ExecutorConfig::new(BaseCodingAgent::Codex).profile_id(),
        );
        assert_eq!(target.working_dir, expected_dir);
    }

    #[test]
    fn dev_server_never_finalizes() {
        let action = initial_action(None);

        assert!(!should_finalize_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::DevServer,
            &action,
        ));
        assert!(!should_finalize_execution(
            &ExecutionProcessStatus::Failed,
            &ExecutionProcessRunReason::DevServer,
            &action,
        ));
    }

    #[test]
    fn setup_script_without_next_action_never_finalizes() {
        let action = script_action(None);

        assert!(!should_finalize_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::SetupScript,
            &action,
        ));
        assert!(!should_finalize_execution(
            &ExecutionProcessStatus::Failed,
            &ExecutionProcessRunReason::SetupScript,
            &action,
        ));
    }

    #[test]
    fn failed_and_killed_processes_finalize_even_with_next_action() {
        let action = initial_action(Some(script_action(None)));

        assert!(should_finalize_execution(
            &ExecutionProcessStatus::Failed,
            &ExecutionProcessRunReason::CodingAgent,
            &action,
        ));
        assert!(should_finalize_execution(
            &ExecutionProcessStatus::Killed,
            &ExecutionProcessRunReason::CodingAgent,
            &action,
        ));
    }

    #[test]
    fn completed_processes_finalize_only_without_next_action() {
        let action_without_next = initial_action(None);
        let action_with_next = initial_action(Some(script_action(None)));

        assert!(should_finalize_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CodingAgent,
            &action_without_next,
        ));
        assert!(!should_finalize_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CodingAgent,
            &action_with_next,
        ));
    }

    #[test]
    fn script_to_script_next_action_runs_as_setup_script() {
        assert_eq!(
            next_action_run_reason(&script_action(None), &script_action(None)),
            ExecutionProcessRunReason::SetupScript,
        );
    }

    #[test]
    fn coding_or_review_to_script_next_action_runs_as_cleanup_script() {
        let next = script_action(None);

        assert_eq!(
            next_action_run_reason(&initial_action(None), &next),
            ExecutionProcessRunReason::CleanupScript,
        );
        assert_eq!(
            next_action_run_reason(&follow_up_action(None), &next),
            ExecutionProcessRunReason::CleanupScript,
        );
        assert_eq!(
            next_action_run_reason(&review_action(None), &next),
            ExecutionProcessRunReason::CleanupScript,
        );
    }

    #[test]
    fn coding_and_review_next_actions_run_as_coding_agent() {
        let initial = initial_action(None);
        let follow_up = follow_up_action(None);
        let review = review_action(None);

        assert_eq!(
            next_action_run_reason(&script_action(None), &initial),
            ExecutionProcessRunReason::CodingAgent,
        );
        assert_eq!(
            next_action_run_reason(&initial_action(None), &follow_up),
            ExecutionProcessRunReason::CodingAgent,
        );
        assert_eq!(
            next_action_run_reason(&review_action(None), &review),
            ExecutionProcessRunReason::CodingAgent,
        );
    }

    #[test]
    fn only_running_processes_are_stop_candidates() {
        assert!(should_stop_execution(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::CodingAgent,
            false,
        ));
        assert!(!should_stop_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CodingAgent,
            true,
        ));
        assert!(!should_stop_execution(
            &ExecutionProcessStatus::Failed,
            &ExecutionProcessRunReason::CodingAgent,
            true,
        ));
        assert!(!should_stop_execution(
            &ExecutionProcessStatus::Killed,
            &ExecutionProcessRunReason::CodingAgent,
            true,
        ));
    }

    #[test]
    fn dev_server_stop_candidates_respect_include_flag() {
        assert!(!should_stop_execution(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::DevServer,
            false,
        ));
        assert!(should_stop_execution(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::DevServer,
            true,
        ));
    }

    #[test]
    fn non_dev_starts_mark_session_in_progress() {
        assert!(should_mark_session_in_progress_on_start(
            &ExecutionProcessRunReason::CodingAgent,
        ));
        assert!(should_mark_session_in_progress_on_start(
            &ExecutionProcessRunReason::SetupScript,
        ));
        assert!(should_mark_session_in_progress_on_start(
            &ExecutionProcessRunReason::CleanupScript,
        ));
        assert!(should_mark_session_in_progress_on_start(
            &ExecutionProcessRunReason::ArchiveScript,
        ));
        assert!(!should_mark_session_in_progress_on_start(
            &ExecutionProcessRunReason::DevServer,
        ));
    }

    #[test]
    fn start_task_status_update_skips_dev_server_and_existing_in_progress() {
        assert!(should_mark_task_in_progress_on_start(
            &ExecutionProcessRunReason::CodingAgent,
            &TaskStatus::Todo,
        ));
        assert!(!should_mark_task_in_progress_on_start(
            &ExecutionProcessRunReason::CodingAgent,
            &TaskStatus::InProgress,
        ));
        assert!(!should_mark_task_in_progress_on_start(
            &ExecutionProcessRunReason::DevServer,
            &TaskStatus::Todo,
        ));
    }

    #[test]
    fn archive_script_start_preserves_workspace_archive_state() {
        assert!(!should_unarchive_workspace_on_start(
            &ExecutionProcessRunReason::ArchiveScript,
        ));
        assert!(should_unarchive_workspace_on_start(
            &ExecutionProcessRunReason::CodingAgent,
        ));
        assert!(should_unarchive_workspace_on_start(
            &ExecutionProcessRunReason::SetupScript,
        ));
        assert!(should_unarchive_workspace_on_start(
            &ExecutionProcessRunReason::CleanupScript,
        ));
        assert!(should_unarchive_workspace_on_start(
            &ExecutionProcessRunReason::DevServer,
        ));
    }

    #[test]
    fn orphan_cleanup_in_review_eligibility_is_limited_to_task_runs() {
        assert!(should_mark_session_in_review_after_orphan_cleanup(
            &ExecutionProcessRunReason::CodingAgent,
        ));
        assert!(should_mark_session_in_review_after_orphan_cleanup(
            &ExecutionProcessRunReason::SetupScript,
        ));
        assert!(should_mark_session_in_review_after_orphan_cleanup(
            &ExecutionProcessRunReason::CleanupScript,
        ));
        assert!(!should_mark_session_in_review_after_orphan_cleanup(
            &ExecutionProcessRunReason::DevServer,
        ));
        assert!(!should_mark_session_in_review_after_orphan_cleanup(
            &ExecutionProcessRunReason::ArchiveScript,
        ));
    }

    #[test]
    fn coding_agent_turn_prompt_comes_from_agent_and_review_actions() {
        assert_eq!(
            coding_agent_turn_prompt(&initial_action(None)),
            Some("implement"),
        );
        assert_eq!(
            coding_agent_turn_prompt(&follow_up_action(None)),
            Some("continue"),
        );
        assert_eq!(
            coding_agent_turn_prompt(&review_action(None)),
            Some("review")
        );
        assert_eq!(coding_agent_turn_prompt(&script_action(None)), None);
    }

    #[test]
    fn missing_executable_start_error_entry_requests_setup() {
        let entry = missing_executable_start_error_entry("codex");

        assert_eq!(entry.timestamp, None);
        assert_eq!(
            entry.content,
            "The required executable `codex` is not installed."
        );
        assert_eq!(entry.metadata, None);
        match entry.entry_type {
            NormalizedEntryType::ErrorMessage { error_type } => {
                assert_eq!(error_type, NormalizedEntryError::SetupRequired);
            }
            other => panic!("unexpected entry type: {other:?}"),
        }
    }

    #[test]
    fn log_normalization_target_uses_agent_and_review_profiles_and_dirs() {
        assert_normalization_target(&initial_action(None), PathBuf::from("workspace-root"));
        assert_normalization_target(
            &action_with_working_dir(follow_up_action(None), "repo-a"),
            PathBuf::from("workspace-root").join("repo-a"),
        );
        assert_normalization_target(
            &action_with_working_dir(review_action(None), "repo-b"),
            PathBuf::from("workspace-root").join("repo-b"),
        );
        assert_eq!(
            log_normalization_target(&script_action(None), Path::new("workspace-root")),
            None
        );
    }

    #[test]
    fn completion_notification_formats_completed_message() {
        assert_eq!(
            completion_notification(
                &ExecutionProcessStatus::Completed,
                "Ship feature",
                "feature/test",
                Some("codex")
            ),
            Some((
                "Task Complete: Ship feature".to_string(),
                "✅ 'Ship feature' completed successfully\nBranch: \"feature/test\"\nExecutor: Some(\"codex\")"
                    .to_string(),
            ))
        );
    }

    #[test]
    fn completion_notification_formats_failed_message() {
        assert_eq!(
            completion_notification(
                &ExecutionProcessStatus::Failed,
                "Ship feature",
                "feature/test",
                None
            ),
            Some((
                "Task Complete: Ship feature".to_string(),
                "❌ 'Ship feature' execution failed\nBranch: \"feature/test\"\nExecutor: None"
                    .to_string(),
            ))
        );
    }

    #[test]
    fn completion_notification_skips_killed_and_non_terminal_statuses() {
        assert_eq!(
            completion_notification(
                &ExecutionProcessStatus::Killed,
                "Ship feature",
                "feature/test",
                Some("codex")
            ),
            None
        );
        assert_eq!(
            completion_notification(
                &ExecutionProcessStatus::Running,
                "Ship feature",
                "feature/test",
                Some("codex")
            ),
            None
        );
    }

    #[test]
    fn reset_target_prefers_process_before_head() {
        assert_eq!(
            reset_target_oid(Some("before"), Some("previous-after")),
            Some("before".to_string())
        );
    }

    #[test]
    fn reset_target_falls_back_to_previous_after_head() {
        assert_eq!(
            reset_target_oid(None, Some("previous-after")),
            Some("previous-after".to_string())
        );
    }

    #[test]
    fn reset_target_is_absent_without_before_or_previous_after_head() {
        assert_eq!(reset_target_oid(None, None), None);
    }

    #[test]
    fn reset_options_preserve_dirty_skip_logging_policy() {
        let reset = reset_options(true, false, true);
        assert!(reset.perform_reset);
        assert!(!reset.force_when_dirty);
        assert!(reset.is_dirty);
        assert!(reset.log_skip_when_dirty);

        let no_reset = reset_options(false, true, true);
        assert!(!no_reset.perform_reset);
        assert!(no_reset.force_when_dirty);
        assert!(no_reset.is_dirty);
        assert!(!no_reset.log_skip_when_dirty);
    }
}
