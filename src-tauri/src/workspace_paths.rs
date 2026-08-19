use std::path::{Path, PathBuf};

use db::models::{repo::Repo, workspace::Workspace};

fn rebuild_relative_path(segments: &[String]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }

    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    Some(path.to_string_lossy().to_string())
}

fn normalized_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let raw = workspace
        .agent_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())?;

    let [repo] = repos else {
        return Some(raw.to_string());
    };

    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);
    let mut segments = raw
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if container_is_repo_root
        && segments
            .first()
            .is_some_and(|segment| segment == &repo.name)
    {
        segments.remove(0);
        return rebuild_relative_path(&segments);
    }

    let missing_repo_prefix = match segments.first() {
        Some(segment) => segment != &repo.name,
        None => true,
    };

    if workspace.use_worktree && !container_is_repo_root && missing_repo_prefix {
        segments.insert(0, repo.name.clone());
        return rebuild_relative_path(&segments);
    }

    Some(raw.to_string())
}

fn infer_single_repo_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let [repo] = repos else {
        return None;
    };

    let default_working_dir = repo
        .default_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty());

    if !workspace.use_worktree {
        return default_working_dir.map(ToOwned::to_owned);
    }

    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);

    match default_working_dir {
        Some(subdir) if container_is_repo_root => Some(subdir.to_string()),
        Some(subdir) => Some(
            PathBuf::from(&repo.name)
                .join(subdir)
                .to_string_lossy()
                .to_string(),
        ),
        None if container_is_repo_root => None,
        None => Some(repo.name.clone()),
    }
}

fn normalized_repo_default_working_dir(repo: &Repo) -> Option<String> {
    repo.default_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(ToOwned::to_owned)
}

fn workspace_with_container_ref(workspace: &Workspace, container_ref: &str) -> Workspace {
    let mut next = workspace.clone();
    next.container_ref = Some(container_ref.to_string());
    next
}

fn single_repo_base_path_is_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repo: &Repo,
) -> bool {
    if !workspace.use_worktree {
        return true;
    }

    workspace_with_container_ref(workspace, container_ref)
        .repo_path(repo)
        .is_some_and(|path| path == Path::new(container_ref))
}

fn resolve_workspace_base_path(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> PathBuf {
    let container_path = PathBuf::from(container_ref);
    let [repo] = repos else {
        return container_path;
    };

    if !workspace.use_worktree {
        return repo.path.clone();
    }

    container_path
}

pub fn resolve_workspace_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    normalized_agent_working_dir(workspace, container_ref, repos)
        .or_else(|| infer_single_repo_working_dir(workspace, container_ref, repos))
}

pub fn resolve_workspace_repo_script_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
    repo: &Repo,
) -> Option<String> {
    let default_working_dir = normalized_repo_default_working_dir(repo);

    if repos.len() != 1 {
        return Some(match default_working_dir {
            Some(subdir) => PathBuf::from(&repo.name)
                .join(subdir)
                .to_string_lossy()
                .to_string(),
            None => repo.name.clone(),
        });
    }

    let container_is_repo_root = single_repo_base_path_is_repo_root(workspace, container_ref, repo);

    match default_working_dir {
        Some(subdir) if !workspace.use_worktree || container_is_repo_root => Some(subdir),
        Some(subdir) => Some(
            PathBuf::from(&repo.name)
                .join(subdir)
                .to_string_lossy()
                .to_string(),
        ),
        None if !workspace.use_worktree || container_is_repo_root => None,
        None => Some(repo.name.clone()),
    }
}

pub fn resolve_workspace_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> PathBuf {
    let [repo] = repos else {
        return PathBuf::from(container_ref);
    };

    if !workspace.use_worktree {
        return repo.path.clone();
    }

    workspace_with_container_ref(workspace, container_ref)
        .repo_path(repo)
        .unwrap_or_else(|| PathBuf::from(container_ref))
}

pub fn resolve_workspace_default_open_path(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> PathBuf {
    let base_path = resolve_workspace_base_path(workspace, container_ref, repos);

    if let Some(working_dir) = resolve_workspace_agent_working_dir(workspace, container_ref, repos)
    {
        return base_path.join(working_dir);
    }

    resolve_workspace_repo_root(workspace, container_ref, repos)
}

/// Resolve only repository roots explicitly linked to the current Workspace.
/// No historical session paths or global repository inventory participate.
pub fn resolve_workspace_additional_directories(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
    working_dir: &str,
) -> Vec<PathBuf> {
    let workspace = workspace_with_container_ref(workspace, container_ref);
    let base = resolve_workspace_base_path(&workspace, container_ref, repos);
    let cwd = PathBuf::from(working_dir);
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        base.join(cwd)
    };

    let mut roots = repos
        .iter()
        .filter_map(|repo| {
            if workspace.use_worktree {
                workspace.repo_path(repo)
            } else {
                Some(repo.path.clone())
            }
        })
        .filter(|root| root != &cwd)
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    roots
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use chrono::Utc;
    use db::models::{repo::Repo, workspace::Workspace};
    use uuid::Uuid;

    use super::{
        resolve_workspace_additional_directories, resolve_workspace_default_open_path,
        resolve_workspace_repo_root, resolve_workspace_repo_script_working_dir,
    };

    fn sample_repo(name: &str, default_working_dir: Option<&str>) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path: PathBuf::from(format!("C:/repos/{name}")),
            name: name.to_string(),
            display_name: name.to_string(),
            setup_script: None,
            cleanup_script: None,
            archive_script: None,
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: Some("npm run dev".to_string()),
            default_target_branch: None,
            default_working_dir: default_working_dir.map(ToOwned::to_owned),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn sample_workspace(use_worktree: bool) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            parent_workspace_id: None,
            container_ref: None,
            branch: "main".to_string(),
            use_worktree,
            agent_working_dir: None,
            setup_completed_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived: false,
            pinned: false,
            name: None,
        }
    }

    #[test]
    fn single_repo_project_root_dev_script_runs_at_repo_root() {
        let workspace = sample_workspace(false);
        let repo = sample_repo("app", None);

        let working_dir = resolve_workspace_repo_script_working_dir(
            &workspace,
            "C:/repos/app",
            std::slice::from_ref(&repo),
            &repo,
        );

        assert_eq!(working_dir, None);
    }

    #[test]
    fn single_repo_project_root_dev_script_keeps_default_subdir() {
        let workspace = sample_workspace(false);
        let repo = sample_repo("app", Some("frontend"));

        let working_dir = resolve_workspace_repo_script_working_dir(
            &workspace,
            "C:/repos/app",
            std::slice::from_ref(&repo),
            &repo,
        );

        assert_eq!(working_dir.as_deref(), Some("frontend"));
    }

    #[test]
    fn single_repo_workspace_root_prefixes_repo_name_for_worktree() {
        let workspace = sample_workspace(true);
        let repo = sample_repo("app", Some("frontend"));

        let working_dir = resolve_workspace_repo_script_working_dir(
            &workspace,
            "C:/workspaces/vu-task-123",
            std::slice::from_ref(&repo),
            &repo,
        );

        let expected = PathBuf::from("app")
            .join("frontend")
            .to_string_lossy()
            .to_string();
        assert_eq!(working_dir.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn single_repo_repo_root_worktree_drops_repo_prefix() {
        let workspace = sample_workspace(true);
        let repo = sample_repo("app", None);

        let working_dir = resolve_workspace_repo_script_working_dir(
            &workspace,
            "C:/workspaces/vu-task-123/app",
            std::slice::from_ref(&repo),
            &repo,
        );

        assert_eq!(working_dir, None);
    }

    #[test]
    fn direct_single_repo_worktree_keeps_subdir_relative_to_worktree_root() {
        let mut workspace = sample_workspace(true);
        workspace.agent_working_dir = Some("frontend".to_string());
        let repo = sample_repo("app-main", Some("frontend"));

        let working_dir = resolve_workspace_repo_script_working_dir(
            &workspace,
            "C:/worktrees/app-feature-b",
            std::slice::from_ref(&repo),
            &repo,
        );

        assert_eq!(working_dir.as_deref(), Some("frontend"));
        assert_eq!(
            resolve_workspace_repo_root(
                &workspace,
                "C:/worktrees/app-feature-b",
                std::slice::from_ref(&repo),
            ),
            PathBuf::from("C:/worktrees/app-feature-b")
        );
        assert_eq!(
            resolve_workspace_default_open_path(
                &workspace,
                "C:/worktrees/app-feature-b",
                std::slice::from_ref(&repo),
            ),
            PathBuf::from("C:/worktrees/app-feature-b/frontend")
        );
    }

    #[test]
    fn managed_worktree_agent_cwd_joins_the_repo_folder_to_the_container() {
        let mut workspace = sample_workspace(true);
        workspace.agent_working_dir = Some("VibeX".to_string());
        let repo = sample_repo("VibeX", None);

        assert_eq!(
            resolve_workspace_default_open_path(
                &workspace,
                "/Users/mac/.vibex-workspaces/workflow-debug",
                std::slice::from_ref(&repo),
            ),
            PathBuf::from("/Users/mac/.vibex-workspaces/workflow-debug/VibeX")
        );
    }

    #[test]
    fn additional_directories_use_only_roots_linked_to_current_workspace() {
        let workspace = sample_workspace(true);
        let repos = vec![sample_repo("app", None), sample_repo("shared", None)];

        assert_eq!(
            resolve_workspace_additional_directories(
                &workspace,
                "/workspaces/current",
                &repos,
                "/workspaces/current/app",
            ),
            vec![PathBuf::from("/workspaces/current/shared")]
        );
    }

    #[test]
    fn multi_repo_workspace_always_scopes_to_repo_folder() {
        let workspace = sample_workspace(true);
        let repo = sample_repo("frontend", Some("packages/web"));
        let backend = sample_repo("backend", None);

        let working_dir = resolve_workspace_repo_script_working_dir(
            &workspace,
            "C:/workspaces/vu-task-123",
            &[repo.clone(), backend],
            &repo,
        );

        let expected = PathBuf::from("frontend")
            .join("packages/web")
            .to_string_lossy()
            .to_string();
        assert_eq!(working_dir.as_deref(), Some(expected.as_str()));
    }
}
