use std::{io, process::ExitStatus};

use db::models::execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus};
use executors::executors::{BaseCodingAgent, ExecutorExitResult};
use uuid::Uuid;

pub(crate) fn execution_result_from_exit(
    status_result: io::Result<ExitStatus>,
) -> (Option<i64>, ExecutionProcessStatus) {
    match status_result {
        Ok(exit_status) => {
            let code = exit_status.code().unwrap_or(-1) as i64;
            let status = if exit_status.success() {
                ExecutionProcessStatus::Completed
            } else {
                ExecutionProcessStatus::Failed
            };
            (Some(code), status)
        }
        Err(_) => (None, ExecutionProcessStatus::Failed),
    }
}

pub(crate) fn stop_exit_code_for_status(status: &ExecutionProcessStatus) -> Option<i64> {
    if matches!(status, ExecutionProcessStatus::Completed) {
        Some(0)
    } else {
        None
    }
}

pub(crate) fn executor_signal_exit_status(result: Option<ExecutorExitResult>) -> ExitStatus {
    match result {
        Some(ExecutorExitResult::Failure) => failure_exit_status(),
        Some(ExecutorExitResult::Success) | None => success_exit_status(),
    }
}

fn success_exit_status() -> ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
}

fn failure_exit_status() -> ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(256)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(1)
    }
}

pub(crate) fn should_commit_and_consider_next(
    status: &ExecutionProcessStatus,
    run_reason: &ExecutionProcessRunReason,
    exit_code: Option<i64>,
) -> bool {
    let success = matches!(status, ExecutionProcessStatus::Completed) && exit_code == Some(0);
    let cleanup_done = matches!(run_reason, ExecutionProcessRunReason::CleanupScript)
        && !matches!(status, ExecutionProcessStatus::Running);

    success || cleanup_done
}

pub(crate) fn should_try_commit_changes(run_reason: &ExecutionProcessRunReason) -> bool {
    matches!(
        run_reason,
        ExecutionProcessRunReason::CodingAgent | ExecutionProcessRunReason::CleanupScript
    )
}

pub(crate) fn should_mark_task_in_review_after_stop(
    run_reason: &ExecutionProcessRunReason,
) -> bool {
    !matches!(run_reason, ExecutionProcessRunReason::DevServer)
}

pub(crate) fn should_create_executor_approval_bridge(
    base_executor: Option<BaseCodingAgent>,
) -> bool {
    matches!(
        base_executor,
        Some(BaseCodingAgent::Codex | BaseCodingAgent::ClaudeCode | BaseCodingAgent::Opencode)
    )
}

pub(crate) fn should_start_next_after_commit(
    run_reason: &ExecutionProcessRunReason,
    changes_committed: bool,
    has_commits_from_execution: bool,
) -> bool {
    if matches!(run_reason, ExecutionProcessRunReason::CodingAgent) {
        changes_committed || has_commits_from_execution
    } else {
        true
    }
}

pub(crate) fn should_inspect_commits_from_execution(
    run_reason: &ExecutionProcessRunReason,
) -> bool {
    matches!(run_reason, ExecutionProcessRunReason::CodingAgent)
}

pub(crate) fn commit_message_for_execution(
    run_reason: &ExecutionProcessRunReason,
    coding_agent_summary: Option<&str>,
    execution_process_id: Uuid,
    workspace_id: Uuid,
) -> String {
    match run_reason {
        ExecutionProcessRunReason::CodingAgent => {
            coding_agent_summary.map(str::to_string).unwrap_or_else(|| {
                format!("Commit changes from coding agent for workspace {workspace_id}")
            })
        }
        ExecutionProcessRunReason::CleanupScript => {
            format!("Cleanup script changes for workspace {workspace_id}")
        }
        _ => format!("Changes from execution process {execution_process_id}"),
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use db::models::execution_process::{ExecutionProcessRunReason, ExecutionProcessStatus};
    use executors::executors::{BaseCodingAgent, ExecutorExitResult};
    use uuid::Uuid;

    use super::{
        commit_message_for_execution, execution_result_from_exit, executor_signal_exit_status,
        should_commit_and_consider_next, should_create_executor_approval_bridge,
        should_inspect_commits_from_execution, should_mark_task_in_review_after_stop,
        should_start_next_after_commit, should_try_commit_changes, stop_exit_code_for_status,
        success_exit_status,
    };

    #[test]
    fn successful_exit_maps_to_completed_with_exit_code() {
        assert_eq!(
            execution_result_from_exit(Ok(success_exit_status())),
            (Some(0), ExecutionProcessStatus::Completed),
        );
    }

    #[test]
    fn exit_watcher_error_maps_to_failed_without_exit_code() {
        assert_eq!(
            execution_result_from_exit(Err(io::Error::other("wait failed"))),
            (None, ExecutionProcessStatus::Failed),
        );
    }

    #[test]
    fn executor_success_signal_maps_to_completed_exit() {
        assert_eq!(
            execution_result_from_exit(Ok(executor_signal_exit_status(Some(
                ExecutorExitResult::Success,
            )))),
            (Some(0), ExecutionProcessStatus::Completed),
        );
    }

    #[test]
    fn executor_failure_signal_maps_to_failed_exit() {
        let (exit_code, status) = execution_result_from_exit(Ok(executor_signal_exit_status(
            Some(ExecutorExitResult::Failure),
        )));

        assert_eq!(status, ExecutionProcessStatus::Failed);
        assert_ne!(exit_code, Some(0));
    }

    #[test]
    fn closed_executor_signal_channel_assumes_success() {
        assert_eq!(
            execution_result_from_exit(Ok(executor_signal_exit_status(None))),
            (Some(0), ExecutionProcessStatus::Completed),
        );
    }

    #[test]
    fn successful_processes_commit_and_consider_next() {
        assert!(should_commit_and_consider_next(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CodingAgent,
            Some(0),
        ));
        assert!(!should_commit_and_consider_next(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CodingAgent,
            Some(2),
        ));
    }

    #[test]
    fn manual_completed_stop_persists_success_exit_code() {
        assert_eq!(
            stop_exit_code_for_status(&ExecutionProcessStatus::Completed),
            Some(0)
        );
    }

    #[test]
    fn manual_non_completed_stops_persist_no_exit_code() {
        assert_eq!(
            stop_exit_code_for_status(&ExecutionProcessStatus::Failed),
            None
        );
        assert_eq!(
            stop_exit_code_for_status(&ExecutionProcessStatus::Killed),
            None
        );
        assert_eq!(
            stop_exit_code_for_status(&ExecutionProcessStatus::Running),
            None
        );
    }

    #[test]
    fn only_coding_agent_and_cleanup_script_try_commits() {
        assert!(should_try_commit_changes(
            &ExecutionProcessRunReason::CodingAgent
        ));
        assert!(should_try_commit_changes(
            &ExecutionProcessRunReason::CleanupScript
        ));
        assert!(!should_try_commit_changes(
            &ExecutionProcessRunReason::SetupScript
        ));
        assert!(!should_try_commit_changes(
            &ExecutionProcessRunReason::DevServer
        ));
    }

    #[test]
    fn stopped_dev_servers_do_not_mark_task_in_review() {
        assert!(!should_mark_task_in_review_after_stop(
            &ExecutionProcessRunReason::DevServer
        ));
    }

    #[test]
    fn stopped_non_dev_server_processes_mark_task_in_review() {
        assert!(should_mark_task_in_review_after_stop(
            &ExecutionProcessRunReason::CodingAgent
        ));
        assert!(should_mark_task_in_review_after_stop(
            &ExecutionProcessRunReason::SetupScript
        ));
        assert!(should_mark_task_in_review_after_stop(
            &ExecutionProcessRunReason::CleanupScript
        ));
    }

    #[test]
    fn approval_bridge_is_used_for_interactive_coding_executors() {
        assert!(should_create_executor_approval_bridge(Some(
            BaseCodingAgent::Codex
        )));
        assert!(should_create_executor_approval_bridge(Some(
            BaseCodingAgent::ClaudeCode
        )));
        assert!(should_create_executor_approval_bridge(Some(
            BaseCodingAgent::Opencode
        )));
    }

    #[test]
    fn approval_bridge_is_skipped_for_non_interactive_actions() {
        assert!(!should_create_executor_approval_bridge(None));
    }

    #[test]
    fn finished_cleanup_scripts_commit_and_continue_even_when_failed() {
        assert!(should_commit_and_consider_next(
            &ExecutionProcessStatus::Completed,
            &ExecutionProcessRunReason::CleanupScript,
            Some(0),
        ));
        assert!(should_commit_and_consider_next(
            &ExecutionProcessStatus::Failed,
            &ExecutionProcessRunReason::CleanupScript,
            Some(1),
        ));
        assert!(!should_commit_and_consider_next(
            &ExecutionProcessStatus::Running,
            &ExecutionProcessRunReason::CleanupScript,
            None,
        ));
    }

    #[test]
    fn coding_agent_next_action_requires_changes_or_commits() {
        assert!(should_start_next_after_commit(
            &ExecutionProcessRunReason::CodingAgent,
            true,
            false,
        ));
        assert!(should_start_next_after_commit(
            &ExecutionProcessRunReason::CodingAgent,
            false,
            true,
        ));
        assert!(!should_start_next_after_commit(
            &ExecutionProcessRunReason::CodingAgent,
            false,
            false,
        ));
    }

    #[test]
    fn only_coding_agent_runs_inspect_execution_commit_deltas() {
        assert!(should_inspect_commits_from_execution(
            &ExecutionProcessRunReason::CodingAgent
        ));
        assert!(!should_inspect_commits_from_execution(
            &ExecutionProcessRunReason::SetupScript
        ));
        assert!(!should_inspect_commits_from_execution(
            &ExecutionProcessRunReason::CleanupScript
        ));
        assert!(!should_inspect_commits_from_execution(
            &ExecutionProcessRunReason::DevServer
        ));
        assert!(!should_inspect_commits_from_execution(
            &ExecutionProcessRunReason::ArchiveScript
        ));
    }

    #[test]
    fn non_coding_agent_next_action_is_not_commit_gated() {
        assert!(should_start_next_after_commit(
            &ExecutionProcessRunReason::SetupScript,
            false,
            false,
        ));
        assert!(should_start_next_after_commit(
            &ExecutionProcessRunReason::CleanupScript,
            false,
            false,
        ));
    }

    #[test]
    fn commit_message_uses_coding_agent_summary_verbatim_when_present() {
        let exec_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();

        assert_eq!(
            commit_message_for_execution(
                &ExecutionProcessRunReason::CodingAgent,
                Some("Reviewed widget flow"),
                exec_id,
                workspace_id,
            ),
            "Reviewed widget flow"
        );
        assert_eq!(
            commit_message_for_execution(
                &ExecutionProcessRunReason::CodingAgent,
                Some(""),
                exec_id,
                workspace_id,
            ),
            ""
        );
    }

    #[test]
    fn commit_message_falls_back_for_coding_agent_without_summary() {
        let exec_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();

        assert_eq!(
            commit_message_for_execution(
                &ExecutionProcessRunReason::CodingAgent,
                None,
                exec_id,
                workspace_id,
            ),
            format!("Commit changes from coding agent for workspace {workspace_id}")
        );
    }

    #[test]
    fn commit_message_uses_run_reason_specific_fallbacks() {
        let exec_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();

        assert_eq!(
            commit_message_for_execution(
                &ExecutionProcessRunReason::CleanupScript,
                None,
                exec_id,
                workspace_id,
            ),
            format!("Cleanup script changes for workspace {workspace_id}")
        );
        assert_eq!(
            commit_message_for_execution(
                &ExecutionProcessRunReason::SetupScript,
                None,
                exec_id,
                workspace_id,
            ),
            format!("Changes from execution process {exec_id}")
        );
    }

}
