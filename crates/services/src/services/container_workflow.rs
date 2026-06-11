use db::models::{
    execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus},
    task::TaskStatus,
};
use executors::{
    actions::{ExecutorAction, ExecutorActionType},
    logs::{NormalizedEntry, NormalizedEntryError, NormalizedEntryType},
};
use git::WorktreeResetOptions;

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
        ExecutionProcessRunReason::SetupScript | ExecutionProcessRunReason::CleanupScript
    )
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

pub(super) fn completion_notification(
    status: &ExecutionProcessStatus,
    task_title: &str,
    workspace_branch: &str,
    session_executor: Option<&str>,
) -> Option<(String, String)> {
    let title = format!("Task Complete: {task_title}");
    let message = match status {
        ExecutionProcessStatus::Completed => format!(
            "'{}' completed successfully\nBranch: {:?}\nExecutor: {:?}",
            task_title, workspace_branch, session_executor
        ),
        ExecutionProcessStatus::Failed => format!(
            "'{}' execution failed\nBranch: {:?}\nExecutor: {:?}",
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
    use db::models::{
        execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus},
        task::TaskStatus,
    };
    use executors::actions::{
        ExecutorAction, ExecutorActionType,
        script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
    };
    use git::WorktreeResetOptions;

    use super::{
        completion_notification, missing_executable_start_error_entry, next_action_run_reason,
        reset_options, reset_target_oid, should_finalize_execution,
        should_mark_session_in_progress_on_start, should_mark_session_in_review_after_orphan_cleanup,
        should_mark_task_in_progress_on_start, should_stop_execution,
        should_unarchive_workspace_on_start,
    };

    fn script_action(context: ScriptContext, next_action: Option<ExecutorAction>) -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: "echo ok".to_string(),
                language: ScriptRequestLanguage::Bash,
                context,
                working_dir: None,
            }),
            next_action.map(Box::new),
        )
    }

    #[test]
    fn dev_server_never_finalizes() {
        let action = script_action(ScriptContext::DevServer, None);

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
        let action = script_action(ScriptContext::SetupScript, None);

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
        let action = script_action(
            ScriptContext::CleanupScript,
            Some(script_action(ScriptContext::CleanupScript, None)),
        );

        assert!(should_finalize_execution(
            &ExecutionProcessStatus::Failed,
            &ExecutionProcessRunReason::CleanupScript,
            &action,
        ));
        assert!(should_finalize_execution(
            &ExecutionProcessStatus::Killed,
            &ExecutionProcessRunReason::CleanupScript,
            &action,
        ));
    }

    #[test]
    fn completed_processes_finalize_only_without_next_action() {
        let action_without_next = script_action(ScriptContext::CleanupScript, None);
        let action_with_next = script_action(
            ScriptContext::CleanupScript,
            Some(script_action(ScriptContext::CleanupScript, None)),
        );

        assert!(should_finalize_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CleanupScript,
            &action_without_next,
        ));
        assert!(!should_finalize_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CleanupScript,
            &action_with_next,
        ));
    }

    #[test]
    fn script_to_script_next_action_runs_as_setup_script() {
        assert_eq!(
            next_action_run_reason(
                &script_action(ScriptContext::SetupScript, None),
                &script_action(ScriptContext::SetupScript, None),
            ),
            ExecutionProcessRunReason::SetupScript,
        );
    }

    #[test]
    fn only_running_processes_are_stop_candidates() {
        assert!(should_stop_execution(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::SetupScript,
            false,
        ));
        assert!(!should_stop_execution(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::SetupScript,
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
            &ExecutionProcessRunReason::SetupScript,
            &TaskStatus::Todo,
        ));
        assert!(!should_mark_task_in_progress_on_start(
            &ExecutionProcessRunReason::SetupScript,
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
            &ExecutionProcessRunReason::SetupScript,
        ));
    }

    #[test]
    fn orphan_cleanup_in_review_eligibility_is_script_only() {
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
    fn missing_executable_start_error_entry_requests_setup() {
        let entry = missing_executable_start_error_entry("codex");

        assert_eq!(entry.timestamp, None);
        assert_eq!(
            entry.content,
            "The required executable `codex` is not installed."
        );
        assert_eq!(entry.metadata, None);
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
                "'Ship feature' completed successfully\nBranch: \"feature/test\"\nExecutor: Some(\"codex\")"
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
    }

    #[test]
    fn reset_target_prefers_process_before_head() {
        assert_eq!(
            reset_target_oid(Some("before"), Some("previous-after")),
            Some("before".to_string())
        );
    }

    #[test]
    fn reset_options_preserve_dirty_skip_logging_policy() {
        let reset: WorktreeResetOptions = reset_options(true, false, true);
        assert!(reset.perform_reset);
        assert!(!reset.force_when_dirty);
        assert!(reset.is_dirty);
        assert!(reset.log_skip_when_dirty);
    }
}
