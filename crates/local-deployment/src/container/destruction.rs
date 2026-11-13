use db::models::conversation_turn::ConversationTurnRecord;
use services::services::workspace_lifecycle::workspace_operation;

use super::*;

impl LocalContainerService {
    pub(super) async fn workspace_is_busy(
        db: &DBService,
        pty: &crate::pty::PtyService,
        workspace: &Workspace,
    ) -> Result<bool, ContainerError> {
        if !ConversationTurnRecord::in_flight_conversation_ids_for_workspace(&db.pool, workspace.id)
            .await?
            .is_empty()
            || ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
                &db.pool,
                workspace.id,
            )
            .await?
        {
            return Ok(true);
        }
        if let Some(root) = workspace.container_ref.as_deref() {
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            if pty
                .has_running_in_directory(&root)
                .map_err(|e| ContainerError::Other(anyhow!(e)))?
            {
                return Ok(true);
            }
            if agents::terminal::agent_terminal_registry()
                .list_live()
                .await
                .iter()
                .any(|terminal| {
                    terminal.cwd.as_ref().is_some_and(|cwd| {
                        std::fs::canonicalize(cwd)
                            .unwrap_or_else(|_| cwd.clone())
                            .starts_with(&root)
                    })
                })
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(super) async fn destroy_workspace(
        &self,
        workspace: &Workspace,
        remove_records: Option<bool>,
    ) -> Result<(), ContainerError> {
        let operation = workspace_operation(workspace.id);
        let _permit = operation.write().await;
        let Some(workspace) = Workspace::find_by_id(&self.db.pool, workspace.id).await? else {
            return Ok(());
        };
        if Self::workspace_is_busy(&self.db, &self.pty, &workspace).await? {
            return Err(ContainerError::Other(anyhow!(
                "Cannot delete workspace while turns, processes, or terminals are running. Stop them first."
            )));
        }
        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        for process in
            ExecutionProcess::find_running_dev_servers_by_workspace(&self.db.pool, workspace.id)
                .await?
        {
            self.stop_execution(&process, ExecutionProcessStatus::Killed)
                .await?;
        }
        Self::cleanup_workspace(&self.db, &workspace, &self.settings_path)
            .await
            .map_err(|e| ContainerError::Other(anyhow!(e)))?;
        if let Some(delete_branches) = remove_records {
            if delete_branches && workspace.use_worktree {
                let git = self.git.clone();
                let branch = workspace.branch.clone();
                tokio::task::spawn_blocking(move || {
                    let mut errors = Vec::new();
                    for repo in repositories {
                        match git.check_branch_exists(&repo.path, &branch) {
                            Ok(false) => continue,
                            Err(error) => {
                                errors.push(format!("{}: {error}", repo.name));
                                continue;
                            }
                            Ok(true) => {}
                        }
                        if let Err(error) = git.delete_branch(&repo.path, &branch) {
                            errors.push(format!("{}: {error}", repo.name));
                        }
                    }
                    if errors.is_empty() {
                        Ok(())
                    } else {
                        Err(ContainerError::Other(anyhow!(errors.join("; "))))
                    }
                })
                .await
                .map_err(|e| ContainerError::Other(anyhow!(e)))??;
            }
            let mut tx = self.db.pool.begin().await?;
            Task::nullify_children_by_workspace_id(&mut *tx, workspace.id).await?;
            Workspace::delete(&mut *tx, workspace.id).await?;
            tx.commit().await?;
        }
        Ok(())
    }
}
