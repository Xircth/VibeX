use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub struct WorkspacePathRepo<'a> {
    pub name: &'a str,
    pub path: &'a Path,
}

fn path_points_at_repo_root(path: &Path, repo_name: &str) -> bool {
    path.file_name()
        .and_then(|segment| segment.to_str())
        .is_some_and(|segment| segment == repo_name)
}

fn trimmed_agent_working_dir(agent_working_dir: Option<&str>) -> Option<&str> {
    agent_working_dir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
}

fn agent_working_dir_targets_repo_folder(agent_working_dir: Option<&str>, repo_name: &str) -> bool {
    trimmed_agent_working_dir(agent_working_dir)
        .and_then(|dir| dir.split(['/', '\\']).find(|segment| !segment.is_empty()))
        .is_some_and(|segment| segment == repo_name)
}

fn segments_to_path_string(segments: impl IntoIterator<Item = String>) -> String {
    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    path.to_string_lossy().to_string()
}

pub fn workspace_base_dir(
    container_ref: &Path,
    use_worktree: bool,
    repo: Option<WorkspacePathRepo<'_>>,
) -> PathBuf {
    let Some(repo) = repo else {
        return container_ref.to_path_buf();
    };

    if !use_worktree {
        return repo.path.to_path_buf();
    }

    if path_points_at_repo_root(container_ref, repo.name) {
        return container_ref
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| container_ref.to_path_buf());
    }

    container_ref.to_path_buf()
}

pub fn normalize_agent_working_dir(
    agent_working_dir: Option<&str>,
    use_worktree: bool,
    container_ref: &Path,
    repo_name: Option<&str>,
) -> Option<String> {
    let raw = trimmed_agent_working_dir(agent_working_dir)?;
    let Some(repo_name) = repo_name else {
        return Some(raw.to_string());
    };

    let base_is_repo_root = !use_worktree || path_points_at_repo_root(container_ref, repo_name);
    let mut segments = raw
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if base_is_repo_root && segments.first().is_some_and(|segment| segment == repo_name) {
        segments.remove(0);
        return if segments.is_empty() {
            None
        } else {
            Some(segments_to_path_string(segments))
        };
    }

    if use_worktree
        && !base_is_repo_root
        && segments.first().is_none_or(|segment| segment != repo_name)
    {
        segments.insert(0, repo_name.to_string());
        return Some(segments_to_path_string(segments));
    }

    Some(raw.to_string())
}

pub fn workspace_repo_path(
    workspace_root: &Path,
    use_worktree: bool,
    agent_working_dir: Option<&str>,
    repo_name: &str,
    workspace_root_is_git_checkout: bool,
) -> PathBuf {
    if !use_worktree {
        return workspace_root.to_path_buf();
    }

    if workspace_root_is_git_checkout {
        return workspace_root.to_path_buf();
    }

    if agent_working_dir_targets_repo_folder(agent_working_dir, repo_name) {
        return workspace_root.join(repo_name);
    }

    if trimmed_agent_working_dir(agent_working_dir).is_some() {
        return workspace_root.to_path_buf();
    }

    workspace_root.join(repo_name)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        WorkspacePathRepo, normalize_agent_working_dir, workspace_base_dir, workspace_repo_path,
    };

    fn repo<'a>(name: &'a str, path: &'a Path) -> WorkspacePathRepo<'a> {
        WorkspacePathRepo { name, path }
    }

    fn path_string(segments: &[&str]) -> String {
        let mut path = PathBuf::new();
        for segment in segments {
            path.push(segment);
        }
        path.to_string_lossy().to_string()
    }

    #[test]
    fn workspace_base_dir_uses_repo_path_without_worktree() {
        let repo_path = PathBuf::from("C:/repo");

        assert_eq!(
            workspace_base_dir(
                Path::new("C:/workspace"),
                false,
                Some(repo("repo", &repo_path))
            ),
            repo_path
        );
    }

    #[test]
    fn workspace_base_dir_returns_parent_when_container_points_at_repo_root() {
        assert_eq!(
            workspace_base_dir(
                Path::new("C:/workspace/repo"),
                true,
                Some(repo("repo", Path::new("C:/source/repo")))
            ),
            PathBuf::from("C:/workspace")
        );
    }

    #[test]
    fn normalize_agent_working_dir_strips_repo_prefix_for_repo_root_base() {
        assert_eq!(
            normalize_agent_working_dir(
                Some("repo/crates/services"),
                true,
                Path::new("C:/workspace/repo"),
                Some("repo")
            ),
            Some(path_string(&["crates", "services"]))
        );
    }

    #[test]
    fn normalize_agent_working_dir_adds_repo_prefix_for_workspace_base() {
        assert_eq!(
            normalize_agent_working_dir(
                Some("crates/services"),
                true,
                Path::new("C:/workspace"),
                Some("repo")
            ),
            Some(path_string(&["repo", "crates", "services"]))
        );
    }

    #[test]
    fn workspace_repo_path_preserves_direct_checkout_root() {
        assert_eq!(
            workspace_repo_path(Path::new("C:/workspace/repo"), true, None, "repo", true),
            PathBuf::from("C:/workspace/repo")
        );
    }

    #[test]
    fn workspace_repo_path_uses_repo_folder_when_agent_dir_targets_repo() {
        assert_eq!(
            workspace_repo_path(
                Path::new("C:/workspace"),
                true,
                Some("repo/crates/services"),
                "repo",
                false
            ),
            PathBuf::from("C:/workspace/repo")
        );
    }

    #[test]
    fn workspace_repo_path_uses_workspace_root_when_agent_dir_is_subdir() {
        assert_eq!(
            workspace_repo_path(
                Path::new("C:/workspace"),
                true,
                Some("crates/services"),
                "repo",
                false
            ),
            PathBuf::from("C:/workspace")
        );
    }
}
