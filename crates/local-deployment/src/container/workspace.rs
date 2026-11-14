use services::services::{
    settings_store::{read_section, write_section},
    workspace_lifecycle::{
        InitializationRun, WorkspaceInitialization as Initialization, workspace_operation,
    },
    workspace_manager::RepoWorkspaceInput,
    worktree_settings::run_project_workspace_create_command,
};

use super::*;
impl LocalContainerService {
    pub(super) async fn prepare_workspace(
        &self,
        workspace: &Workspace,
        include_uncommitted: bool,
        retry: bool,
    ) -> Result<ContainerRef, ContainerError> {
        let operation = workspace_operation(workspace.id);
        let _guard = operation.write().await;
        let _run = InitializationRun::begin(workspace.id);
        let workspace = Workspace::find_by_id(&self.db.pool, workspace.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        Workspace::touch(&self.db.pool, workspace.id).await?;
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        if repositories.is_empty() {
            if !workspace.use_worktree
                && let Some(container_ref) = workspace.container_ref.clone()
            {
                let workspace_dir = PathBuf::from(&container_ref);
                if !workspace_dir.exists() {
                    return Err(ContainerError::Other(anyhow!(
                        "Folder path does not exist: {}",
                        workspace_dir.display()
                    )));
                }
                return Ok(container_ref);
            }
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let mut workspace = workspace;
        self.repair_workspace_storage_mode(&mut workspace, &repositories)
            .await?;

        if !workspace.use_worktree {
            let repo = repositories.first().ok_or_else(|| {
                ContainerError::Other(anyhow!(
                    "Opening without a worktree requires one repository"
                ))
            })?;
            let workspace_dir = workspace
                .container_ref
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| repo.path.clone());
            if !workspace_dir.exists() {
                return Err(ContainerError::Other(anyhow!(
                    "Repository path does not exist: {}",
                    workspace_dir.display()
                )));
            }
            if workspace.container_ref.is_none() {
                Workspace::update_container_ref(
                    &self.db.pool,
                    workspace.id,
                    &workspace_dir.to_string_lossy(),
                )
                .await?;
            }

            self.copy_files_and_images(&workspace_dir, &workspace)
                .await?;
            return Ok(workspace_dir.to_string_lossy().to_string());
        }

        let workspace_dir = if let Some(container_ref) = &workspace.container_ref {
            PathBuf::from(container_ref)
        } else if let Some(discovered_workspace_dir) =
            self.discover_workspace_dir_from_existing_worktree(&repositories, &workspace.branch)
        {
            discovered_workspace_dir
        } else {
            let task = workspace
                .parent_task(&self.db.pool)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;
            let workspace_dir_name =
                LocalContainerService::dir_name_from_workspace(&workspace.id, &task.title);
            WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name)
        };

        if Self::is_direct_external_worktree(&workspace, &workspace_dir, &repositories) {
            if !workspace_dir.exists() {
                return Err(ContainerError::Other(anyhow!(
                    "External worktree path does not exist: {}",
                    workspace_dir.display()
                )));
            }

            let workspace_dir_ref = workspace_dir.to_string_lossy().to_string();
            if workspace.container_ref.as_deref() != Some(workspace_dir_ref.as_str()) {
                Workspace::update_container_ref(&self.db.pool, workspace.id, &workspace_dir_ref)
                    .await?;
            }

            self.copy_files_and_images(&workspace_dir, &workspace)
                .await?;
            return Ok(workspace_dir.to_string_lossy().to_string());
        }

        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let workspace_inputs: Vec<RepoWorkspaceInput> = repositories
            .iter()
            .map(|repo| {
                let target_branch = target_branches.get(&repo.id).cloned().unwrap_or_default();
                RepoWorkspaceInput::new(repo.clone(), target_branch)
            })
            .collect();

        WorkspaceManager::validate_workspace_container_path(&workspace_dir)?;
        let mut available_repos = std::collections::HashSet::new();
        for repo in &repositories {
            if services::services::worktree_manager::WorktreeManager::is_worktree_available(
                &repo.path,
                &workspace_dir.join(&repo.name),
            )
            .await?
            {
                available_repos.insert(repo.id);
            }
        }
        let previously_complete = available_repos.len() == repositories.len();
        let journal_path = workspace_dir.join(".vibex-initialization.json");
        let mut initialization: Initialization = read_section(&journal_path, "initialization")
            .await
            .map_err(|e| ContainerError::Other(anyhow!(e)))?
            .unwrap_or_default();
        if !retry && matches!(initialization.phase.as_str(), "running" | "failed") {
            return Err(ContainerError::Other(anyhow!(
                "Workspace initialization requires an explicit retry after reviewing its effects: {}",
                initialization
                    .error
                    .as_deref()
                    .unwrap_or("previous initialization was interrupted")
            )));
        }
        let initialize = initialization.phase != "ready"
            && (workspace.container_ref.is_none()
                || !previously_complete
                || !initialization.phase.is_empty())
            || !previously_complete;
        // Claim the path before any filesystem side effects, including Git and hooks.
        Workspace::update_container_ref(
            &self.db.pool,
            workspace.id,
            &workspace_dir.to_string_lossy(),
        )
        .await?;
        tokio::fs::create_dir_all(&workspace_dir).await?;
        initialization.include_uncommitted |= include_uncommitted;
        if initialize {
            initialization.phase = "preparing".into();
            initialization.error = None;
            initialization
                .completed_repos
                .retain(|id| available_repos.contains(id));
            initialization
                .copied_repos
                .retain(|id| available_repos.contains(id));
            write_section(&journal_path, "initialization", &initialization)
                .await
                .map_err(|e| ContainerError::Other(anyhow!(e)))?;
        }
        let result: Result<(), ContainerError> = async {
            WorkspaceManager::ensure_workspace_exists(
                &workspace_dir,
                &workspace_inputs,
                &workspace.branch,
            )
            .await?;
            if initialize {
                if initialization.include_uncommitted {
                    for repo in &repositories {
                        if initialization.copied_repos.contains(&repo.id) {
                            continue;
                        }
                        WorkspaceManager::copy_uncommitted_changes(
                            &workspace_dir,
                            std::slice::from_ref(repo),
                        )
                        .await?;
                        initialization.copied_repos.push(repo.id);
                        write_section(&journal_path, "initialization", &initialization)
                            .await
                            .map_err(|e| ContainerError::Other(anyhow!(e)))?;
                    }
                }
                self.copy_files_and_images(&workspace_dir, &workspace)
                    .await?;
                Self::create_workspace_config_files(
                    &workspace_dir,
                    &repositories,
                    workspace.use_worktree,
                )
                .await?;
                for repo in &repositories {
                    if initialization.completed_repos.contains(&repo.id) {
                        continue;
                    }
                    initialization.phase = "running".into();
                    write_section(&journal_path, "initialization", &initialization)
                        .await
                        .map_err(|e| ContainerError::Other(anyhow!(e)))?;
                    run_project_workspace_create_command(
                        &self.settings_path,
                        workspace.project_id,
                        workspace.id,
                        &workspace_dir,
                        std::slice::from_ref(repo),
                    )
                    .await
                    .map_err(|e| ContainerError::Other(anyhow!(e)))?;
                    initialization.completed_repos.push(repo.id);
                    initialization.phase = "preparing".into();
                    write_section(&journal_path, "initialization", &initialization)
                        .await
                        .map_err(|e| ContainerError::Other(anyhow!(e)))?;
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            initialization.phase = "failed".into();
            initialization.error = Some(error.to_string());
            write_section(&journal_path, "initialization", &initialization)
                .await
                .map_err(|e| {
                    ContainerError::Other(anyhow!(
                        "{error}; failed to record initialization failure: {e}"
                    ))
                })?;
            return Err(error);
        }
        initialization.phase = "ready".into();
        initialization.error = None;
        write_section(&journal_path, "initialization", &initialization)
            .await
            .map_err(|e| ContainerError::Other(anyhow!(e)))?;
        Workspace::mark_setup_completed(&self.db.pool, workspace.id).await?;

        Ok(workspace_dir.to_string_lossy().to_string())
    }
}
