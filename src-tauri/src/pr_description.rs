//! ACP-native pull request description generation.
//!
//! Uses the Agent and session config chosen in Settings → Version Control.
//! Git context is collected by the host; the Agent only writes Title/Body JSON.

use std::{path::Path, time::Duration};

use agents::events::AgentSessionConfigOverride;
use git::GitCli;
use services::services::pr_description::{
    PR_DESCRIPTION_TIMEOUT_SECS, PrDescriptionContext, PrDescriptionDraft,
    build_pr_description_payload, extract_pr_description, selected_pr_description_agent,
    validate_pr_description_request,
};

use crate::{
    error::AppError,
    oneshot_agent::{OneshotAgentTurn, run_oneshot_agent_turn, validated_enabled_agent},
    state::AppState,
};

pub async fn generate_pr_description(
    state: &AppState,
    task_title: Option<String>,
    task_description: Option<String>,
    worktree_path: &Path,
    base_branch: &str,
    head_branch: &str,
    base_ref_candidates: &[String],
) -> Result<PrDescriptionDraft, AppError> {
    let config = state.deployment.config().read().await.clone();
    validate_pr_description_request(&config)?;

    let agent_id = validated_enabled_agent(
        selected_pr_description_agent(&config),
        &state.deployment.db().pool,
        "Version Control",
        "PR description generation",
    )
    .await?;
    let config_overrides = config
        .pr_auto_description_session_config
        .iter()
        .map(|(key, value)| AgentSessionConfigOverride {
            key: key.clone(),
            value: value.clone(),
        })
        .collect();

    let git_context = collect_git_context(worktree_path, base_ref_candidates);
    let prompt_text = build_pr_description_payload(
        &config,
        &PrDescriptionContext {
            task_title,
            task_description,
            base_branch: base_branch.to_string(),
            head_branch: head_branch.to_string(),
            commit_log: git_context.commit_log,
            diff_stat: git_context.diff_stat,
            diff: git_context.diff,
        },
    )?;

    let response_text = run_oneshot_agent_turn(
        state,
        OneshotAgentTurn {
            agent_id,
            prompt: prompt_text,
            mode_override: config.pr_auto_description_mode.clone(),
            config_overrides,
            timeout: Duration::from_secs(PR_DESCRIPTION_TIMEOUT_SECS),
            failure_prefix: "PR description",
        },
    )
    .await?;

    extract_pr_description(&response_text).ok_or_else(|| {
        let detail = response_text.trim();
        let message = if detail.is_empty() {
            "Agent response did not contain valid Title and Body fields".to_string()
        } else {
            format!(
                "Agent response did not contain valid Title and Body fields. Raw output: {detail}"
            )
        };
        AppError::Internal(message)
    })
}

struct CollectedGitContext {
    commit_log: String,
    diff_stat: String,
    diff: String,
}

fn collect_git_context(
    worktree_path: &Path,
    base_ref_candidates: &[String],
) -> CollectedGitContext {
    let git = GitCli::new();
    let base_ref = base_ref_candidates.iter().find(|candidate| {
        git.git(worktree_path, ["rev-parse", "--verify", candidate])
            .is_ok()
    });

    let Some(base_ref) = base_ref else {
        return CollectedGitContext {
            commit_log: String::new(),
            diff_stat: String::new(),
            diff: String::new(),
        };
    };

    let range = format!("{base_ref}..HEAD");
    let triple_dot = format!("{base_ref}...HEAD");
    CollectedGitContext {
        commit_log: git
            .git(worktree_path, ["log", "--format=%h %s", &range])
            .unwrap_or_default(),
        diff_stat: git
            .git(worktree_path, ["diff", "--stat", &triple_dot])
            .unwrap_or_default(),
        diff: git
            .git(worktree_path, ["diff", &triple_dot])
            .unwrap_or_default(),
    }
}
