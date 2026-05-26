use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use db::models::{
    project_repo::ProjectRepo,
    repo::Repo,
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use git::GitCli;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

pub(super) async fn recover_workspace_container_ref(
    state: &tauri::State<'_, AppState>,
    workspace: &mut Workspace,
) -> Result<(), AppError> {
    if !workspace.use_worktree {
        return Ok(());
    }

    let pool = &state.deployment.db().pool;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    if let Some(container_ref) = workspace.container_ref.clone() {
        let container_path = PathBuf::from(&container_ref);
        if let Some(overlapping_repo) = repos
            .iter()
            .find(|repo| path_overlaps_repo(&container_path, repo))
        {
            tracing::error!(
                "Workspace {} has unsafe worktree container_ref {} overlapping repo {}; repairing before returning it",
                workspace.id,
                container_path.display(),
                overlapping_repo.path.display()
            );

            let current_branch = state
                .deployment
                .git()
                .get_current_branch(&overlapping_repo.path)
                .ok();
            if current_branch
                .as_deref()
                .is_some_and(|branch| branch.eq_ignore_ascii_case(&workspace.branch))
            {
                Workspace::update_storage_mode(
                    pool,
                    workspace.id,
                    false,
                    Some(overlapping_repo.path.to_string_lossy().as_ref()),
                    overlapping_repo.default_working_dir.as_deref(),
                )
                .await?;
                workspace.use_worktree = false;
                workspace.container_ref = Some(overlapping_repo.path.to_string_lossy().to_string());
                workspace.agent_working_dir = overlapping_repo.default_working_dir.clone();
            } else {
                Workspace::clear_container_ref(pool, workspace.id).await?;
                workspace.container_ref = None;
            }

            return Ok(());
        }
    }

    if let Some(container_ref) = workspace.container_ref.as_ref()
        && Path::new(container_ref).exists()
    {
        return Ok(());
    }

    if repos.is_empty() {
        return Ok(());
    }

    for repo in repos {
        let found_worktree = match state
            .deployment
            .git()
            .find_worktree_path_for_branch(&repo.path, &workspace.branch)
        {
            Ok(path) => path,
            Err(err) => {
                tracing::debug!(
                    "Failed to discover worktree for workspace {} branch '{}' in repo '{}': {}",
                    workspace.id,
                    workspace.branch,
                    repo.name,
                    err
                );
                continue;
            }
        };

        let Some(found_worktree_path) = found_worktree else {
            continue;
        };

        let workspace_root = derive_workspace_root_from_worktree_path(&repo, &found_worktree_path);
        let desired_agent_working_dir =
            imported_single_repo_agent_working_dir(&repo, &found_worktree_path);

        if !workspace_root.exists() {
            continue;
        }

        let recovered_container_ref = workspace_root.to_string_lossy().to_string();
        if workspace.container_ref.as_deref() != Some(recovered_container_ref.as_str())
            || workspace.agent_working_dir != desired_agent_working_dir
        {
            Workspace::update_storage_mode(
                pool,
                workspace.id,
                true,
                Some(&recovered_container_ref),
                desired_agent_working_dir.as_deref(),
            )
            .await?;
            tracing::info!(
                "Recovered workspace {} container_ref to {}",
                workspace.id,
                recovered_container_ref
            );
        }
        workspace.container_ref = Some(recovered_container_ref);
        workspace.agent_working_dir = desired_agent_working_dir;
        return Ok(());
    }

    Ok(())
}

fn canonicalize_for_workspace_safety(path: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(path) {
        return path;
    }

    let mut missing_segments = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            break;
        };
        missing_segments.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }

    let mut resolved = std::fs::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }
    resolved
}

fn path_overlaps_repo(path: &Path, repo: &Repo) -> bool {
    let path = canonicalize_for_workspace_safety(path);
    let repo_path = canonicalize_for_workspace_safety(&repo.path);
    path == repo_path || path.starts_with(&repo_path) || repo_path.starts_with(&path)
}

fn normalize_branch_name(branch: &str) -> String {
    branch.trim().to_lowercase()
}

#[derive(Debug, Clone)]
struct WorkspaceRepoBranchRef {
    workspace_id: Uuid,
    archived: bool,
    use_worktree: bool,
    container_ref: Option<String>,
    agent_working_dir: Option<String>,
}

fn imported_single_repo_agent_working_dir(repo: &Repo, worktree_path: &Path) -> Option<String> {
    let default_working_dir = repo
        .default_working_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let worktree_points_at_repo_folder = worktree_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == repo.name);

    if worktree_points_at_repo_folder {
        return Some(match default_working_dir {
            Some(subdir) => PathBuf::from(&repo.name)
                .join(subdir)
                .to_string_lossy()
                .to_string(),
            None => repo.name.clone(),
        });
    }

    default_working_dir.map(ToOwned::to_owned)
}

fn derive_workspace_root_from_worktree_path(repo: &Repo, worktree_path: &Path) -> PathBuf {
    if worktree_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == repo.name)
    {
        worktree_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| worktree_path.to_path_buf())
    } else {
        worktree_path.to_path_buf()
    }
}

pub(super) async fn sync_project_workspaces_from_local_worktrees(
    state: &tauri::State<'_, AppState>,
    project_id: Uuid,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;
    let repos = ProjectRepo::find_repos_for_project(pool, project_id).await?;
    if repos.is_empty() {
        return Ok(());
    }

    let existing_workspaces = Workspace::fetch_by_project_id(pool, project_id).await?;
    let mut workspace_ref_by_repo_branch: HashMap<(Uuid, String), WorkspaceRepoBranchRef> =
        HashMap::new();
    let mut workspace_by_root_and_branch: HashMap<(String, String), Uuid> = HashMap::new();
    for workspace in &existing_workspaces {
        let normalized_branch = normalize_branch_name(&workspace.branch);
        if let Some(container_ref) = workspace.container_ref.as_ref() {
            workspace_by_root_and_branch.insert(
                (container_ref.clone(), normalized_branch.clone()),
                workspace.id,
            );
        }
        for workspace_repo in WorkspaceRepo::find_by_workspace_id(pool, workspace.id).await? {
            let repo_branch_key = (workspace_repo.repo_id, normalized_branch.clone());
            let candidate = WorkspaceRepoBranchRef {
                workspace_id: workspace.id,
                archived: workspace.archived,
                use_worktree: workspace.use_worktree,
                container_ref: workspace.container_ref.clone(),
                agent_working_dir: workspace.agent_working_dir.clone(),
            };
            match workspace_ref_by_repo_branch.get(&repo_branch_key) {
                Some(existing)
                    if (existing.archived && !workspace.archived)
                        || (!existing.use_worktree && workspace.use_worktree) =>
                {
                    workspace_ref_by_repo_branch.insert(repo_branch_key, candidate);
                }
                None => {
                    workspace_ref_by_repo_branch.insert(repo_branch_key, candidate);
                }
                _ => {}
            }
        }
    }

    let git_cli = GitCli::new();
    for repo in repos {
        let worktrees = match git_cli.list_worktrees(&repo.path) {
            Ok(entries) => entries,
            Err(err) => {
                tracing::debug!(
                    "Skipping worktree sync for repo '{}': list_worktrees failed: {}",
                    repo.name,
                    err
                );
                continue;
            }
        };

        for worktree in worktrees {
            let Some(branch) = worktree.branch else {
                continue;
            };

            let normalized_branch = normalize_branch_name(&branch);
            let repo_branch_key = (repo.id, normalized_branch.clone());

            let worktree_path = PathBuf::from(&worktree.path);
            if worktree_path == repo.path || !worktree_path.exists() {
                continue;
            }

            let workspace_root = derive_workspace_root_from_worktree_path(&repo, &worktree_path);
            let desired_agent_working_dir =
                imported_single_repo_agent_working_dir(&repo, &worktree_path);
            if !workspace_root.exists() {
                continue;
            }
            let workspace_root_ref = workspace_root.to_string_lossy().to_string();
            let root_branch_key = (workspace_root_ref.clone(), normalized_branch.clone());

            if let Some(existing_workspace_ref) = workspace_ref_by_repo_branch
                .get(&repo_branch_key)
                .cloned()
                .filter(|existing| existing.use_worktree)
            {
                if existing_workspace_ref.archived
                    && let Err(err) = Workspace::update(
                        pool,
                        existing_workspace_ref.workspace_id,
                        Some(false),
                        None,
                        None,
                    )
                    .await
                {
                    tracing::warn!(
                        "Failed to restore archived workspace {} for branch '{}': {}",
                        existing_workspace_ref.workspace_id,
                        branch,
                        err
                    );
                    continue;
                }

                if (existing_workspace_ref.container_ref.as_deref()
                    != Some(workspace_root_ref.as_str())
                    || existing_workspace_ref.agent_working_dir != desired_agent_working_dir)
                    && let Err(err) = Workspace::update_storage_mode(
                        pool,
                        existing_workspace_ref.workspace_id,
                        true,
                        Some(&workspace_root_ref),
                        desired_agent_working_dir.as_deref(),
                    )
                    .await
                {
                    tracing::warn!(
                        "Failed to update imported worktree workspace {} for branch '{}': {}",
                        existing_workspace_ref.workspace_id,
                        branch,
                        err
                    );
                    continue;
                }

                workspace_by_root_and_branch
                    .insert(root_branch_key, existing_workspace_ref.workspace_id);
                workspace_ref_by_repo_branch.insert(
                    repo_branch_key,
                    WorkspaceRepoBranchRef {
                        workspace_id: existing_workspace_ref.workspace_id,
                        archived: false,
                        use_worktree: true,
                        container_ref: Some(workspace_root_ref),
                        agent_working_dir: desired_agent_working_dir,
                    },
                );
                continue;
            }

            if let Some(existing_workspace_id) =
                workspace_by_root_and_branch.get(&root_branch_key).copied()
            {
                let target_branch = repo
                    .default_target_branch
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "main".to_string());

                if let Err(err) = WorkspaceRepo::create_many(
                    pool,
                    existing_workspace_id,
                    &[CreateWorkspaceRepo {
                        repo_id: repo.id,
                        target_branch,
                    }],
                )
                .await
                {
                    tracing::warn!(
                        "Failed to attach repo '{}' to imported workspace {}: {}",
                        repo.name,
                        existing_workspace_id,
                        err
                    );
                    continue;
                }

                workspace_ref_by_repo_branch.insert(
                    repo_branch_key,
                    WorkspaceRepoBranchRef {
                        workspace_id: existing_workspace_id,
                        archived: false,
                        use_worktree: true,
                        container_ref: Some(workspace_root_ref),
                        agent_working_dir: desired_agent_working_dir,
                    },
                );
                continue;
            }

            let task_title = format!("Workspace: {}", branch);
            let task = match Task::create(
                pool,
                &CreateTask {
                    project_id,
                    title: task_title.clone(),
                    description: Some("Imported from an existing local git worktree.".to_string()),
                    status: Some(TaskStatus::Todo),
                    parent_workspace_id: None,
                    image_ids: None,
                },
                Uuid::new_v4(),
            )
            .await
            {
                Ok(task) => task,
                Err(err) => {
                    tracing::warn!(
                        "Failed to create task for discovered worktree '{}' in repo '{}': {}",
                        branch,
                        repo.name,
                        err
                    );
                    continue;
                }
            };

            let workspace = match Workspace::create(
                pool,
                &CreateWorkspace {
                    project_id,
                    parent_workspace_id: task.parent_workspace_id,
                    branch: branch.clone(),
                    container_ref: Some(workspace_root_ref.clone()),
                    use_worktree: true,
                    agent_working_dir: desired_agent_working_dir.clone(),
                },
                Uuid::new_v4(),
                task.id,
            )
            .await
            {
                Ok(workspace) => workspace,
                Err(err) => {
                    tracing::warn!(
                        "Failed to create workspace for discovered worktree '{}' in repo '{}': {}",
                        branch,
                        repo.name,
                        err
                    );
                    let _ = Task::delete(pool, task.id).await;
                    continue;
                }
            };

            let target_branch = repo
                .default_target_branch
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "main".to_string());

            if let Err(err) = WorkspaceRepo::create_many(
                pool,
                workspace.id,
                &[CreateWorkspaceRepo {
                    repo_id: repo.id,
                    target_branch,
                }],
            )
            .await
            {
                tracing::warn!(
                    "Failed to create workspace_repo for imported workspace '{}' in repo '{}': {}",
                    branch,
                    repo.name,
                    err
                );
                let _ = Workspace::delete(pool, workspace.id).await;
                let _ = Task::delete(pool, task.id).await;
                continue;
            }

            let _ =
                Workspace::update(pool, workspace.id, None, None, Some(task_title.as_str())).await;

            workspace_by_root_and_branch.insert(root_branch_key, workspace.id);
            workspace_ref_by_repo_branch.insert(
                repo_branch_key,
                WorkspaceRepoBranchRef {
                    workspace_id: workspace.id,
                    archived: false,
                    use_worktree: true,
                    container_ref: Some(workspace_root_ref),
                    agent_working_dir: desired_agent_working_dir,
                },
            );
            tracing::info!(
                "Imported local worktree '{}' for project {} as workspace {}",
                branch,
                project_id,
                workspace.id
            );
        }
    }

    Ok(())
}

// --- Commands ---
