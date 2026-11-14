use super::*;

impl ServerApplicationDomains {
    pub(super) async fn create_worktree_workspace_for_project_session(
        &self,
        project_id: Uuid,
        name: Option<&str>,
        initial_prompt: Option<&str>,
        repos: &[ProjectSessionRepoInput],
        include_uncommitted: bool,
    ) -> Result<Workspace, ApplicationError> {
        if repos.is_empty() {
            return Err(ApplicationError::bad_request(
                "At least one repository is required",
            ));
        }
        let mut validated_repos = Vec::new();
        let mut validation_errors = Vec::new();
        let mut seen = HashSet::new();
        for input in repos {
            if !seen.insert(input.repo_id) {
                validation_errors.push(format!("Duplicate repository {}", input.repo_id));
                continue;
            }
            match Repo::find_by_id(&self.pool, input.repo_id)
                .await
                .map_err(internal_error)?
            {
                Some(repo) => match self
                    .deployment
                    .git()
                    .resolve_workspace_branch(&repo.path, Some(&input.target_branch))
                {
                    Ok(target_branch) => validated_repos.push(CreateWorkspaceRepo {
                        repo_id: repo.id,
                        target_branch,
                    }),
                    Err(error) => validation_errors.push(format!("{}: {error}", repo.name)),
                },
                None => validation_errors.push(format!("Repository {} not found", input.repo_id)),
            }
        }
        if !validation_errors.is_empty() {
            return Err(ApplicationError::bad_request(validation_errors.join("; ")));
        }
        let workspace_title = derive_workspace_seed_title(name, initial_prompt);
        let task = Task::create(
            &self.pool,
            &CreateTask {
                project_id,
                title: workspace_title.clone(),
                description: initial_prompt.map(ToOwned::to_owned),
                status: Some(TaskStatus::Todo),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(internal_error)?;
        let workspace_id = Uuid::new_v4();
        let result = async {
            let agent_working_dir = if repos.len() == 1 {
                let repo = Repo::find_by_id(&self.pool, repos[0].repo_id)
                    .await
                    .map_err(internal_error)?
                    .ok_or_else(|| ApplicationError::not_found("repository not found"))?;
                Some(match repo.default_working_dir {
                    Some(subdir) => PathBuf::from(&repo.name)
                        .join(subdir)
                        .to_string_lossy()
                        .into_owned(),
                    None => repo.name,
                })
            } else {
                None
            };
            let branch = self
                .deployment
                .container()
                .git_branch_from_workspace(&workspace_id, &workspace_title)
                .await;
            let workspace = Workspace::create(
                &self.pool,
                &CreateWorkspace {
                    project_id,
                    parent_workspace_id: None,
                    branch,
                    container_ref: None,
                    use_worktree: true,
                    agent_working_dir,
                },
                workspace_id,
                task.id,
            )
            .await
            .map_err(internal_error)?;
            Workspace::update(
                &self.pool,
                workspace.id,
                None,
                None,
                Some(workspace_title.as_str()),
            )
            .await
            .map_err(internal_error)?;
            WorkspaceRepo::create_many(&self.pool, workspace.id, &validated_repos)
                .await
                .map_err(internal_error)?;
            let workspace = Workspace::find_by_id(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!("workspace {}", workspace.id))
                })?;
            self.deployment
                .container()
                .provision(&workspace, include_uncommitted)
                .await
                .map_err(map_workspace_git_error)?;
            Workspace::find_by_id(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found(format!("workspace {}", workspace.id)))
        }
        .await;
        if let Err(error) = result {
            let persisted = Workspace::find_by_id(&self.pool, workspace_id)
                .await
                .map_err(internal_error)?;
            if persisted
                .as_ref()
                .is_none_or(|workspace| workspace.container_ref.is_none())
            {
                Workspace::delete(&self.pool, workspace_id)
                    .await
                    .map_err(internal_error)?;
                Task::delete(&self.pool, task.id)
                    .await
                    .map_err(internal_error)?;
            }
            return Err(ApplicationError::internal(format!(
                "Workspace {workspace_id}: {error}"
            )));
        }
        result
    }
}
