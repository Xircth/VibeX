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

fn path_points_at_repo_root(path: &Path, repo: &Repo) -> bool {
    path.file_name()
        .and_then(|segment| segment.to_str())
        .is_some_and(|segment| segment == repo.name)
}

fn single_repo_base_path_is_repo_root(
    workspace: &Workspace,
    container_ref: &str,
    repo: &Repo,
) -> bool {
    if !workspace.use_worktree {
        return true;
    }

    path_points_at_repo_root(Path::new(container_ref), repo)
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

    if path_points_at_repo_root(&container_path, repo) {
        return container_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(container_path);
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

    let base_path = resolve_workspace_base_path(workspace, container_ref, repos);
    base_path.join(&repo.name)
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
