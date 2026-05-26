use db::models::repo::Repo;
use executors::actions::{
    ExecutorAction, ExecutorActionType,
    script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
};
pub fn cleanup_actions_for_repos(repos: &[Repo]) -> Option<ExecutorAction> {
    script_actions_for_repos(repos, ScriptContext::CleanupScript, |repo| {
        repo.cleanup_script.as_ref()
    })
}

pub fn archive_actions_for_repos(repos: &[Repo]) -> Option<ExecutorAction> {
    script_actions_for_repos(repos, ScriptContext::ArchiveScript, |repo| {
        repo.archive_script.as_ref()
    })
}

pub fn setup_actions_for_repos(repos: &[Repo]) -> Option<ExecutorAction> {
    script_actions_for_repos(repos, ScriptContext::SetupScript, |repo| {
        repo.setup_script.as_ref()
    })
}

pub fn setup_action_for_repo(repo: &Repo) -> Option<ExecutorAction> {
    repo.setup_script
        .as_ref()
        .map(|script| repo_script_action(repo, script, ScriptContext::SetupScript, None))
}

pub fn dev_server_action_for_repo(
    repo: &Repo,
    working_dir: Option<String>,
) -> Option<ExecutorAction> {
    repo.dev_server_script
        .as_ref()
        .filter(|script| !script.is_empty())
        .map(|script| script_action(script, ScriptContext::DevServer, working_dir, None))
}

pub fn build_sequential_setup_chain(
    repos: &[&Repo],
    next_action: ExecutorAction,
) -> ExecutorAction {
    let mut chained = next_action;
    for repo in repos.iter().rev() {
        if let Some(script) = &repo.setup_script {
            chained = repo_script_action(repo, script, ScriptContext::SetupScript, Some(chained));
        }
    }
    chained
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceSetupStartMode {
    DirectCoding,
    ParallelSetupsThenCoding,
    SequentialSetupChain,
}

pub fn workspace_setup_start_mode(repos_with_setup: &[&Repo]) -> WorkspaceSetupStartMode {
    if repos_with_setup.is_empty() {
        return WorkspaceSetupStartMode::DirectCoding;
    }

    if repos_with_setup
        .iter()
        .all(|repo| repo.parallel_setup_script)
    {
        WorkspaceSetupStartMode::ParallelSetupsThenCoding
    } else {
        WorkspaceSetupStartMode::SequentialSetupChain
    }
}

pub fn script_action(
    script: impl Into<String>,
    context: ScriptContext,
    working_dir: Option<String>,
    next_action: Option<ExecutorAction>,
) -> ExecutorAction {
    ExecutorAction::new(
        ExecutorActionType::ScriptRequest(ScriptRequest {
            script: script.into(),
            language: ScriptRequestLanguage::Bash,
            context,
            working_dir,
        }),
        next_action.map(Box::new),
    )
}

fn script_actions_for_repos(
    repos: &[Repo],
    context: ScriptContext,
    script_for_repo: impl Fn(&Repo) -> Option<&String>,
) -> Option<ExecutorAction> {
    let mut root_action: Option<ExecutorAction> = None;

    for repo in repos {
        let Some(script) = script_for_repo(repo) else {
            continue;
        };
        let action = repo_script_action(repo, script, context.clone(), None);
        root_action = Some(match root_action {
            Some(existing) => existing.append_action(action),
            None => action,
        });
    }

    root_action
}

fn repo_script_action(
    repo: &Repo,
    script: &str,
    context: ScriptContext,
    next_action: Option<ExecutorAction>,
) -> ExecutorAction {
    script_action(script, context, Some(repo.name.clone()), next_action)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use chrono::Utc;
    use db::models::repo::Repo;
    use executors::{
        actions::{
            ExecutorAction, ExecutorActionType,
            coding_agent_initial::CodingAgentInitialRequest,
            script::{ScriptContext, ScriptRequestLanguage},
        },
        executors::BaseCodingAgent,
        profile::ExecutorConfig,
    };
    use uuid::Uuid;

    use super::{
        WorkspaceSetupStartMode, archive_actions_for_repos, build_sequential_setup_chain,
        cleanup_actions_for_repos, dev_server_action_for_repo, script_action,
        setup_action_for_repo, setup_actions_for_repos, workspace_setup_start_mode,
    };

    fn repo(
        name: &str,
        setup_script: Option<&str>,
        cleanup_script: Option<&str>,
        archive_script: Option<&str>,
    ) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path: PathBuf::from(format!("/repos/{name}")),
            name: name.to_string(),
            display_name: name.to_string(),
            setup_script: setup_script.map(str::to_string),
            cleanup_script: cleanup_script.map(str::to_string),
            archive_script: archive_script.map(str::to_string),
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: None,
            default_target_branch: None,
            default_working_dir: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn repo_with_parallel_setup(name: &str, setup_script: Option<&str>, parallel: bool) -> Repo {
        let mut repo = repo(name, setup_script, None, None);
        repo.parallel_setup_script = parallel;
        repo
    }

    fn coding_action() -> ExecutorAction {
        ExecutorAction::new(
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: "implement".to_string(),
                executor_config: ExecutorConfig::new(BaseCodingAgent::Codex),
                working_dir: None,
            }),
            None,
        )
    }

    fn collect_script_chain(action: &ExecutorAction) -> Vec<(String, ScriptContext, String)> {
        let mut chain = Vec::new();
        let mut current = Some(action);
        while let Some(action) = current {
            match action.typ() {
                ExecutorActionType::ScriptRequest(request) => {
                    assert_eq!(request.language, ScriptRequestLanguage::Bash);
                    chain.push((
                        request.script.clone(),
                        request.context.clone(),
                        request.working_dir.clone().expect("script working dir"),
                    ));
                    current = action.next_action();
                }
                _ => break,
            }
        }
        chain
    }

    #[test]
    fn cleanup_actions_preserve_repo_order_and_skip_repos_without_scripts() {
        let repos = vec![
            repo("alpha", None, Some("cleanup alpha"), None),
            repo("beta", None, None, None),
            repo("gamma", None, Some("cleanup gamma"), None),
        ];

        let action = cleanup_actions_for_repos(&repos).expect("cleanup action");

        assert_eq!(
            collect_script_chain(&action),
            vec![
                (
                    "cleanup alpha".to_string(),
                    ScriptContext::CleanupScript,
                    "alpha".to_string(),
                ),
                (
                    "cleanup gamma".to_string(),
                    ScriptContext::CleanupScript,
                    "gamma".to_string(),
                ),
            ],
        );
    }

    #[test]
    fn archive_actions_preserve_context_and_skip_missing_scripts() {
        let repos = vec![
            repo("alpha", None, None, None),
            repo("beta", None, None, Some("archive beta")),
        ];

        let action = archive_actions_for_repos(&repos).expect("archive action");

        assert_eq!(
            collect_script_chain(&action),
            vec![(
                "archive beta".to_string(),
                ScriptContext::ArchiveScript,
                "beta".to_string(),
            )],
        );
    }

    #[test]
    fn setup_actions_preserve_repo_order_for_manual_script_runs() {
        let repos = vec![
            repo("alpha", Some("setup alpha"), None, None),
            repo("beta", None, None, None),
            repo("gamma", Some("setup gamma"), None, None),
        ];

        let action = setup_actions_for_repos(&repos).expect("setup action");

        assert_eq!(
            collect_script_chain(&action),
            vec![
                (
                    "setup alpha".to_string(),
                    ScriptContext::SetupScript,
                    "alpha".to_string(),
                ),
                (
                    "setup gamma".to_string(),
                    ScriptContext::SetupScript,
                    "gamma".to_string(),
                ),
            ],
        );
    }

    #[test]
    fn action_builders_return_none_when_no_matching_scripts_exist() {
        let repos = vec![repo("alpha", Some("setup alpha"), None, None)];

        assert!(cleanup_actions_for_repos(&repos).is_none());
        assert!(archive_actions_for_repos(&repos).is_none());
        assert!(setup_actions_for_repos(&[repo("beta", None, None, None)]).is_none());
        assert!(setup_action_for_repo(&repo("beta", None, None, None)).is_none());
    }

    #[test]
    fn standalone_setup_action_uses_repo_script_and_working_dir() {
        let action = setup_action_for_repo(&repo("alpha", Some("setup alpha"), None, None))
            .expect("setup action");

        assert_eq!(
            collect_script_chain(&action),
            vec![(
                "setup alpha".to_string(),
                ScriptContext::SetupScript,
                "alpha".to_string(),
            )],
        );
    }

    #[test]
    fn generic_script_action_preserves_context_working_dir_and_next_action() {
        let next = coding_action();
        let action = script_action(
            "npm run dev",
            ScriptContext::DevServer,
            Some("web".to_string()),
            Some(next),
        );

        assert_eq!(
            collect_script_chain(&action),
            vec![(
                "npm run dev".to_string(),
                ScriptContext::DevServer,
                "web".to_string(),
            )],
        );
        assert!(matches!(
            action.next_action().expect("next action").typ(),
            ExecutorActionType::CodingAgentInitialRequest(_)
        ));
    }

    #[test]
    fn dev_server_action_uses_repo_script_and_resolved_working_dir() {
        let mut repo = repo("web", None, None, None);
        repo.dev_server_script = Some("npm run dev".to_string());

        let action =
            dev_server_action_for_repo(&repo, Some("apps/web".to_string())).expect("dev action");

        assert_eq!(
            collect_script_chain(&action),
            vec![(
                "npm run dev".to_string(),
                ScriptContext::DevServer,
                "apps/web".to_string(),
            )],
        );
    }

    #[test]
    fn dev_server_action_is_absent_without_a_configured_script() {
        let mut repo = repo("web", None, None, None);
        assert!(dev_server_action_for_repo(&repo, Some("apps/web".to_string())).is_none());

        repo.dev_server_script = Some(String::new());
        assert!(dev_server_action_for_repo(&repo, Some("apps/web".to_string())).is_none());
    }

    #[test]
    fn sequential_setup_chain_runs_setups_in_repo_order_before_next_action() {
        let alpha = repo("alpha", Some("setup alpha"), None, None);
        let beta = repo("beta", None, None, None);
        let gamma = repo("gamma", Some("setup gamma"), None, None);
        let chain = build_sequential_setup_chain(&[&alpha, &beta, &gamma], coding_action());

        assert_eq!(
            collect_script_chain(&chain),
            vec![
                (
                    "setup alpha".to_string(),
                    ScriptContext::SetupScript,
                    "alpha".to_string(),
                ),
                (
                    "setup gamma".to_string(),
                    ScriptContext::SetupScript,
                    "gamma".to_string(),
                ),
            ],
        );

        let mut current = &chain;
        while let Some(next) = current.next_action() {
            current = next;
        }
        assert!(matches!(
            current.typ(),
            ExecutorActionType::CodingAgentInitialRequest(_)
        ));
    }

    #[test]
    fn workspace_start_mode_uses_direct_coding_without_setup_scripts() {
        let alpha = repo_with_parallel_setup("alpha", None, false);
        let repos_with_setup: Vec<&Repo> = [&alpha]
            .into_iter()
            .filter(|repo| repo.setup_script.is_some())
            .collect();

        assert_eq!(
            workspace_setup_start_mode(&repos_with_setup),
            WorkspaceSetupStartMode::DirectCoding
        );
    }

    #[test]
    fn workspace_start_mode_uses_parallel_when_all_setups_are_parallel() {
        let alpha = repo_with_parallel_setup("alpha", Some("setup alpha"), true);
        let beta = repo_with_parallel_setup("beta", Some("setup beta"), true);

        assert_eq!(
            workspace_setup_start_mode(&[&alpha, &beta]),
            WorkspaceSetupStartMode::ParallelSetupsThenCoding
        );
    }

    #[test]
    fn workspace_start_mode_uses_sequential_when_any_setup_is_not_parallel() {
        let alpha = repo_with_parallel_setup("alpha", Some("setup alpha"), true);
        let beta = repo_with_parallel_setup("beta", Some("setup beta"), false);

        assert_eq!(
            workspace_setup_start_mode(&[&alpha, &beta]),
            WorkspaceSetupStartMode::SequentialSetupChain
        );
    }
}
