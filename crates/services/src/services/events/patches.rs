use db::models::{
    execution_process::ExecutionProcess, project::Project, scratch::Scratch,
    workspace::WorkspaceWithStatus,
};
use json_patch::{AddOperation, Patch, PatchOperation, RemoveOperation, ReplaceOperation};
use uuid::Uuid;

// Shared helper to escape JSON Pointer segments
fn escape_pointer_segment(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// Helper functions for creating project-specific patches
pub mod project_patch {
    use super::*;

    fn project_path(project_id: Uuid) -> String {
        format!(
            "/projects/{}",
            escape_pointer_segment(&project_id.to_string())
        )
    }

    /// Create patch for adding a new project
    pub fn add(project: &Project) -> Patch {
        Patch(vec![PatchOperation::Add(AddOperation {
            path: project_path(project.id)
                .try_into()
                .expect("Project path should be valid"),
            value: serde_json::to_value(project).expect("Project serialization should not fail"),
        })])
    }

    /// Create patch for updating an existing project
    pub fn replace(project: &Project) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: project_path(project.id)
                .try_into()
                .expect("Project path should be valid"),
            value: serde_json::to_value(project).expect("Project serialization should not fail"),
        })])
    }

    /// Create patch for removing a project
    pub fn remove(project_id: Uuid) -> Patch {
        Patch(vec![PatchOperation::Remove(RemoveOperation {
            path: project_path(project_id)
                .try_into()
                .expect("Project path should be valid"),
        })])
    }

    /// Live project list only contains visible projects. Hiding unlists.
    pub fn sync_visible(project: &Project, inserted: bool) -> Patch {
        if project.hidden {
            remove(project.id)
        } else if inserted {
            add(project)
        } else {
            replace(project)
        }
    }
}

/// Helper functions for creating execution process-specific patches
pub mod execution_process_patch {
    use super::*;

    fn execution_process_path(process_id: Uuid) -> String {
        format!(
            "/execution_processes/{}",
            escape_pointer_segment(&process_id.to_string())
        )
    }

    /// Create patch for adding a new execution process
    pub fn add(process: &ExecutionProcess) -> Patch {
        Patch(vec![PatchOperation::Add(AddOperation {
            path: execution_process_path(process.id)
                .try_into()
                .expect("Execution process path should be valid"),
            value: serde_json::to_value(process)
                .expect("Execution process serialization should not fail"),
        })])
    }

    /// Create patch for updating an existing execution process
    pub fn replace(process: &ExecutionProcess) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: execution_process_path(process.id)
                .try_into()
                .expect("Execution process path should be valid"),
            value: serde_json::to_value(process)
                .expect("Execution process serialization should not fail"),
        })])
    }

    /// Create patch for removing an execution process
    pub fn remove(process_id: Uuid) -> Patch {
        Patch(vec![PatchOperation::Remove(RemoveOperation {
            path: execution_process_path(process_id)
                .try_into()
                .expect("Execution process path should be valid"),
        })])
    }
}

/// Helper functions for creating workspace-specific patches
pub mod workspace_patch {
    use super::*;

    fn workspace_path(workspace_id: Uuid) -> String {
        format!(
            "/workspaces/{}",
            escape_pointer_segment(&workspace_id.to_string())
        )
    }

    pub fn add(workspace: &WorkspaceWithStatus) -> Patch {
        Patch(vec![PatchOperation::Add(AddOperation {
            path: workspace_path(workspace.id)
                .try_into()
                .expect("Workspace path should be valid"),
            value: serde_json::to_value(workspace)
                .expect("Workspace serialization should not fail"),
        })])
    }

    pub fn replace(workspace: &WorkspaceWithStatus) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: workspace_path(workspace.id)
                .try_into()
                .expect("Workspace path should be valid"),
            value: serde_json::to_value(workspace)
                .expect("Workspace serialization should not fail"),
        })])
    }

    pub fn remove(workspace_id: Uuid) -> Patch {
        Patch(vec![PatchOperation::Remove(RemoveOperation {
            path: workspace_path(workspace_id)
                .try_into()
                .expect("Workspace path should be valid"),
        })])
    }
}

/// Helper functions for creating scratch-specific patches.
/// All patches use path "/scratch" - filtering is done by matching id and payload type in the value.
pub mod scratch_patch {
    use super::*;

    const SCRATCH_PATH: &str = "/scratch";

    /// Create patch for adding a new scratch
    pub fn add(scratch: &Scratch) -> Patch {
        Patch(vec![PatchOperation::Add(AddOperation {
            path: SCRATCH_PATH
                .try_into()
                .expect("Scratch path should be valid"),
            value: serde_json::to_value(scratch).expect("Scratch serialization should not fail"),
        })])
    }

    /// Create patch for updating an existing scratch
    pub fn replace(scratch: &Scratch) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: SCRATCH_PATH
                .try_into()
                .expect("Scratch path should be valid"),
            value: serde_json::to_value(scratch).expect("Scratch serialization should not fail"),
        })])
    }

    /// Create patch for removing a scratch.
    /// Uses Replace with deleted marker so clients can filter by id and payload type.
    pub fn remove(scratch_id: Uuid, scratch_type_str: &str) -> Patch {
        Patch(vec![PatchOperation::Replace(ReplaceOperation {
            path: SCRATCH_PATH
                .try_into()
                .expect("Scratch path should be valid"),
            value: serde_json::json!({
                "id": scratch_id,
                "payload": { "type": scratch_type_str },
                "deleted": true
            }),
        })])
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use json_patch::PatchOperation;
    use uuid::Uuid;

    use super::*;

    fn sample_project(hidden: bool) -> Project {
        Project {
            id: Uuid::new_v4(),
            name: "StallerLab".into(),
            root_path: r"C:\tmp\StallerLab".into(),
            parent_project_id: None,
            hidden,
            is_git: true,
            default_agent_working_dir: None,
            default_main_branch: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_home: false,
        }
    }

    #[test]
    fn hiding_a_project_emits_a_remove_patch() {
        let project = sample_project(true);
        let patch = project_patch::sync_visible(&project, false);
        assert_eq!(patch.0.len(), 1);
        match &patch.0[0] {
            PatchOperation::Remove(op) => {
                assert_eq!(op.path.as_str(), format!("/projects/{}", project.id));
            }
            other => panic!("expected remove, got {other:?}"),
        }
    }

    #[test]
    fn updating_a_visible_project_emits_replace() {
        let project = sample_project(false);
        let patch = project_patch::sync_visible(&project, false);
        assert!(matches!(patch.0[0], PatchOperation::Replace(_)));
    }

    #[test]
    fn inserting_a_visible_project_emits_add() {
        let project = sample_project(false);
        let patch = project_patch::sync_visible(&project, true);
        assert!(matches!(patch.0[0], PatchOperation::Add(_)));
    }
}
