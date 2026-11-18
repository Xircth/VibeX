use db::models::{
    execution_process::ExecutionProcess,
    project::Project,
    scratch::Scratch,
    workspace::{Workspace, WorkspaceWithStatus},
};
use futures::StreamExt;
use serde_json::json;
use tokio_stream::wrappers::{BroadcastStream, errors::BroadcastStreamRecvError};
use utils::log_msg::LogMsg;
use uuid::Uuid;

use super::{
    EventService,
    patches::execution_process_patch,
    types::{EventError, EventPatch, RecordTypes},
};

impl EventService {
    /// Stream raw workspace-with-status messages for a specific project with initial snapshot
    pub async fn stream_project_workspaces_raw(
        &self,
        project_id: Uuid,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, EventError>
    {
        fn build_snapshot(workspaces: Vec<WorkspaceWithStatus>) -> LogMsg {
            let workspaces_map: serde_json::Map<String, serde_json::Value> = workspaces
                .into_iter()
                .map(|workspace| {
                    (
                        workspace.id.to_string(),
                        serde_json::to_value(workspace).unwrap(),
                    )
                })
                .collect();

            let patch = json!([
                {
                    "op": "replace",
                    "path": "/workspaces",
                    "value": workspaces_map
                }
            ]);

            LogMsg::JsonPatch(serde_json::from_value(patch).unwrap())
        }

        let receiver = self.msg_store.get_receiver();
        let read_pool = self.db.reader().as_pool().clone();
        let initial_workspaces =
            Workspace::find_by_project_id_with_status(&read_pool, project_id).await?;
        let initial_msg = build_snapshot(initial_workspaces);

        let filtered_stream = BroadcastStream::new(receiver).filter_map(move |msg_result| {
            let read_pool = read_pool.clone();
            async move {
                match msg_result {
                    Ok(LogMsg::JsonPatch(patch)) => {
                        if let Some(patch_op) = patch.0.first()
                            && patch_op.path().starts_with("/workspaces/")
                        {
                            match patch_op {
                                json_patch::PatchOperation::Add(op) => {
                                    if let Ok(workspace) =
                                        serde_json::from_value::<WorkspaceWithStatus>(
                                            op.value.clone(),
                                        )
                                        && workspace.project_id == project_id
                                    {
                                        return Some(Ok(LogMsg::JsonPatch(patch)));
                                    }
                                }
                                json_patch::PatchOperation::Replace(op) => {
                                    if let Ok(workspace) =
                                        serde_json::from_value::<WorkspaceWithStatus>(
                                            op.value.clone(),
                                        )
                                        && workspace.project_id == project_id
                                    {
                                        return Some(Ok(LogMsg::JsonPatch(patch)));
                                    }
                                }
                                json_patch::PatchOperation::Remove(_) => {
                                    return Some(Ok(LogMsg::JsonPatch(patch)));
                                }
                                _ => {}
                            }
                        }
                        None
                    }
                    Ok(other) => Some(Ok(other)),
                    Err(BroadcastStreamRecvError::Lagged(_)) => {
                        match Workspace::find_by_project_id_with_status(&read_pool, project_id)
                            .await
                        {
                            Ok(workspaces) => Some(Ok(build_snapshot(workspaces))),
                            Err(err) => Some(Err(std::io::Error::other(format!(
                                "failed to resync project workspaces after lag: {err}"
                            )))),
                        }
                    }
                }
            }
        });

        let initial_stream = futures::stream::iter(vec![Ok(initial_msg), Ok(LogMsg::Ready)]);
        Ok(initial_stream.chain(filtered_stream).boxed())
    }

    /// Stream raw project messages with initial snapshot
    pub async fn stream_projects_raw(
        &self,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, EventError>
    {
        fn build_projects_snapshot(projects: Vec<Project>) -> LogMsg {
            // Convert projects array to object keyed by project ID
            let projects_map: serde_json::Map<String, serde_json::Value> = projects
                .into_iter()
                .map(|project| {
                    (
                        project.id.to_string(),
                        serde_json::to_value(project).unwrap(),
                    )
                })
                .collect();

            let patch = json!([
                {
                    "op": "replace",
                    "path": "/projects",
                    "value": projects_map
                }
            ]);

            LogMsg::JsonPatch(serde_json::from_value(patch).unwrap())
        }

        let receiver = self.msg_store.get_receiver();
        let read_pool = self.db.reader().as_pool().clone();
        let mut projects = Project::find_all(&read_pool).await?;

        if !projects.iter().any(|project| project.is_home) {
            let writer_pool = self.db.pool.clone();
            let mut ensure_task = tokio::spawn(async move {
                crate::services::project::ProjectService::new()
                    .ensure_home_project(
                        &writer_pool,
                        &crate::services::repo::RepoService::new(),
                    )
                    .await
            });
            match tokio::time::timeout(
                std::time::Duration::from_millis(500),
                &mut ensure_task,
            )
            .await
            {
                Ok(Ok(Ok(_))) => {
                    projects = Project::find_all(&read_pool).await?;
                }
                Ok(Ok(Err(error))) => {
                    tracing::warn!(%error, "failed to ensure home project before projects snapshot");
                }
                Ok(Err(join_error)) => {
                    tracing::warn!(%join_error, "ensure_home_project task panicked");
                }
                Err(_) => {
                    tracing::debug!(
                        "writer pool busy during projects snapshot; continuing ensure_home_project in background"
                    );
                }
            }
        }

        let initial_msg = build_projects_snapshot(projects);

        // Get filtered event stream (projects only)
        let filtered_stream = BroadcastStream::new(receiver).filter_map(move |msg_result| {
            let read_pool = read_pool.clone();
            async move {
                match msg_result {
                    Ok(LogMsg::JsonPatch(patch)) => {
                        if let Some(patch_op) = patch.0.first()
                            && patch_op.path().starts_with("/projects")
                        {
                            return Some(Ok(LogMsg::JsonPatch(patch)));
                        }
                        None
                    }
                    Ok(other) => Some(Ok(other)), // Pass through non-patch messages
                    Err(BroadcastStreamRecvError::Lagged(skipped)) => {
                        tracing::warn!(
                            skipped = skipped,
                            "projects stream lagged; resyncing snapshot"
                        );

                        match Project::find_all(&read_pool).await {
                            Ok(projects) => Some(Ok(build_projects_snapshot(projects))),
                            Err(err) => {
                                tracing::error!(
                                    error = %err,
                                    "failed to resync projects after lag"
                                );
                                Some(Err(std::io::Error::other(format!(
                                    "failed to resync projects after lag: {err}"
                                ))))
                            }
                        }
                    }
                }
            }
        });

        // Start with initial snapshot, Ready signal, then live updates
        let initial_stream = futures::stream::iter(vec![Ok(initial_msg), Ok(LogMsg::Ready)]);
        let combined_stream = initial_stream.chain(filtered_stream).boxed();

        Ok(combined_stream)
    }

    /// Stream execution processes for a specific session with initial snapshot (raw LogMsg format for WebSocket)
    pub async fn stream_execution_processes_for_session_raw(
        &self,
        session_id: Uuid,
        show_soft_deleted: bool,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, EventError>
    {
        let receiver = self.msg_store.get_receiver();
        // Get execution processes for this session via concurrent ReadPool
        let processes = ExecutionProcess::find_by_session_id(
            self.db.reader().as_pool(),
            session_id,
            show_soft_deleted,
        )
        .await?;

        // Convert processes array to object keyed by process ID
        let processes_map: serde_json::Map<String, serde_json::Value> = processes
            .into_iter()
            .map(|process| {
                (
                    process.id.to_string(),
                    serde_json::to_value(process).unwrap(),
                )
            })
            .collect();

        let initial_patch = json!([{
            "op": "replace",
            "path": "/execution_processes",
            "value": processes_map
        }]);
        let initial_msg = LogMsg::JsonPatch(serde_json::from_value(initial_patch).unwrap());

        // Get filtered event stream
        let filtered_stream = BroadcastStream::new(receiver).filter_map(move |msg_result| {
            async move {
                match msg_result {
                    Ok(LogMsg::JsonPatch(patch)) => {
                        // Filter events based on session_id
                        if let Some(patch_op) = patch.0.first() {
                            // Check if this is a modern execution process patch
                            if patch_op.path().starts_with("/execution_processes/") {
                                match patch_op {
                                    json_patch::PatchOperation::Add(op) => {
                                        // Parse execution process data directly from value
                                        if let Ok(process) =
                                            serde_json::from_value::<ExecutionProcess>(
                                                op.value.clone(),
                                            )
                                            && process.session_id == session_id
                                        {
                                            if !show_soft_deleted && process.dropped {
                                                let remove_patch =
                                                    execution_process_patch::remove(process.id);
                                                return Some(Ok(LogMsg::JsonPatch(remove_patch)));
                                            }
                                            return Some(Ok(LogMsg::JsonPatch(patch)));
                                        }
                                    }
                                    json_patch::PatchOperation::Replace(op) => {
                                        // Parse execution process data directly from value
                                        if let Ok(process) =
                                            serde_json::from_value::<ExecutionProcess>(
                                                op.value.clone(),
                                            )
                                            && process.session_id == session_id
                                        {
                                            if !show_soft_deleted && process.dropped {
                                                let remove_patch =
                                                    execution_process_patch::remove(process.id);
                                                return Some(Ok(LogMsg::JsonPatch(remove_patch)));
                                            }
                                            return Some(Ok(LogMsg::JsonPatch(patch)));
                                        }
                                    }
                                    json_patch::PatchOperation::Remove(_) => {
                                        // For remove operations, we can't verify session_id
                                        // so we allow all removals and let the client handle filtering
                                        return Some(Ok(LogMsg::JsonPatch(patch)));
                                    }
                                    _ => {}
                                }
                            }
                            // Fallback to legacy EventPatch format for backward compatibility
                            else if let Ok(event_patch_value) = serde_json::to_value(patch_op)
                                && let Ok(event_patch) =
                                    serde_json::from_value::<EventPatch>(event_patch_value)
                            {
                                match &event_patch.value.record {
                                    RecordTypes::ExecutionProcess(process) => {
                                        if process.session_id == session_id {
                                            if !show_soft_deleted && process.dropped {
                                                let remove_patch =
                                                    execution_process_patch::remove(process.id);
                                                return Some(Ok(LogMsg::JsonPatch(remove_patch)));
                                            }
                                            return Some(Ok(LogMsg::JsonPatch(patch)));
                                        }
                                    }
                                    RecordTypes::DeletedExecutionProcess {
                                        session_id: Some(deleted_session_id),
                                        ..
                                    } => {
                                        if *deleted_session_id == session_id {
                                            return Some(Ok(LogMsg::JsonPatch(patch)));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        None
                    }
                    Ok(other) => Some(Ok(other)), // Pass through non-patch messages
                    Err(_) => None,               // Filter out broadcast errors
                }
            }
        });

        // Start with initial snapshot, Ready signal, then live updates
        let initial_stream = futures::stream::iter(vec![Ok(initial_msg), Ok(LogMsg::Ready)]);
        let combined_stream = initial_stream.chain(filtered_stream).boxed();

        Ok(combined_stream)
    }

    /// Stream a single scratch item with initial snapshot (raw LogMsg format for WebSocket)
    pub async fn stream_scratch_raw(
        &self,
        scratch_id: Uuid,
        scratch_type: &db::models::scratch::ScratchType,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, EventError>
    {
        let receiver = self.msg_store.get_receiver();
        // Propagate transient database lock/pool errors so subscribers retry, while
        // treating corrupted/malformed scratch payloads the same as "scratch not found".
        let scratch = match Scratch::find_by_id(
            self.db.reader().as_pool(),
            scratch_id,
            scratch_type,
        )
        .await
        {
            Ok(scratch) => scratch,
            Err(db::models::scratch::ScratchError::Database(sqlx_err)) => {
                return Err(EventError::Sqlx(sqlx_err));
            }
            Err(e) => {
                tracing::warn!(
                    scratch_id = %scratch_id,
                    scratch_type = %scratch_type,
                    error = %e,
                    "Failed to load scratch, treating as empty"
                );
                None
            }
        };

        let initial_patch = json!([{
            "op": "replace",
            "path": "/scratch",
            "value": scratch
        }]);
        let initial_msg = LogMsg::JsonPatch(serde_json::from_value(initial_patch).unwrap());

        let type_str = scratch_type.to_string();

        // Filter to only this scratch's events by matching id and payload.type in the patch value
        let filtered_stream = BroadcastStream::new(receiver).filter_map(move |msg_result| {
            let id_str = scratch_id.to_string();
            let type_str = type_str.clone();
            async move {
                match msg_result {
                    Ok(LogMsg::JsonPatch(patch)) => {
                        if let Some(op) = patch.0.first()
                            && op.path() == "/scratch"
                        {
                            // Extract id and payload.type from the patch value
                            let value = match op {
                                json_patch::PatchOperation::Add(a) => Some(&a.value),
                                json_patch::PatchOperation::Replace(r) => Some(&r.value),
                                json_patch::PatchOperation::Remove(_) => None,
                                _ => None,
                            };

                            let matches = value.is_some_and(|v| {
                                let id_matches =
                                    v.get("id").and_then(|v| v.as_str()) == Some(&id_str);
                                let type_matches = v
                                    .get("payload")
                                    .and_then(|p| p.get("type"))
                                    .and_then(|t| t.as_str())
                                    == Some(&type_str);
                                id_matches && type_matches
                            });

                            if matches {
                                return Some(Ok(LogMsg::JsonPatch(patch)));
                            }
                        }
                        None
                    }
                    Ok(other) => Some(Ok(other)),
                    Err(_) => None,
                }
            }
        });

        let initial_stream = futures::stream::iter(vec![Ok(initial_msg), Ok(LogMsg::Ready)]);
        let combined_stream = initial_stream.chain(filtered_stream).boxed();
        Ok(combined_stream)
    }

    pub async fn stream_workspaces_raw(
        &self,
        archived: Option<bool>,
        limit: Option<i64>,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, EventError>
    {
        let receiver = self.msg_store.get_receiver();
        let workspaces =
            Workspace::find_all_with_status(self.db.reader().as_pool(), archived, limit).await?;
        let workspaces_map: serde_json::Map<String, serde_json::Value> = workspaces
            .into_iter()
            .map(|ws| (ws.id.to_string(), serde_json::to_value(ws).unwrap()))
            .collect();

        let initial_patch = json!([{
            "op": "replace",
            "path": "/workspaces",
            "value": workspaces_map
        }]);
        let initial_msg = LogMsg::JsonPatch(serde_json::from_value(initial_patch).unwrap());

        let filtered_stream =
            BroadcastStream::new(receiver).filter_map(move |msg_result| async move {
                match msg_result {
                    Ok(LogMsg::JsonPatch(patch)) => {
                        if let Some(op) = patch.0.first()
                            && op.path().starts_with("/workspaces")
                        {
                            // If archived filter is set, handle state transitions
                            if let Some(archived_filter) = archived {
                                // Extract workspace data from Add/Replace operations
                                let value = match op {
                                    json_patch::PatchOperation::Add(a) => Some(&a.value),
                                    json_patch::PatchOperation::Replace(r) => Some(&r.value),
                                    json_patch::PatchOperation::Remove(_) => {
                                        // Allow remove operations through - client will handle
                                        return Some(Ok(LogMsg::JsonPatch(patch)));
                                    }
                                    _ => None,
                                };

                                if let Some(v) = value
                                    && let Some(ws_archived) =
                                        v.get("archived").and_then(|a| a.as_bool())
                                {
                                    if ws_archived == archived_filter {
                                        // Workspace matches this filter
                                        // Convert Replace to Add since workspace may be new to this filtered stream
                                        if let json_patch::PatchOperation::Replace(r) = op {
                                            let add_patch = json_patch::Patch(vec![
                                                json_patch::PatchOperation::Add(
                                                    json_patch::AddOperation {
                                                        path: r.path.clone(),
                                                        value: r.value.clone(),
                                                    },
                                                ),
                                            ]);
                                            return Some(Ok(LogMsg::JsonPatch(add_patch)));
                                        }
                                        return Some(Ok(LogMsg::JsonPatch(patch)));
                                    } else {
                                        // Workspace no longer matches this filter - send remove
                                        let remove_patch = json_patch::Patch(vec![
                                            json_patch::PatchOperation::Remove(
                                                json_patch::RemoveOperation {
                                                    path: op
                                                        .path()
                                                        .to_string()
                                                        .try_into()
                                                        .expect("Workspace path should be valid"),
                                                },
                                            ),
                                        ]);
                                        return Some(Ok(LogMsg::JsonPatch(remove_patch)));
                                    }
                                }
                            }
                            return Some(Ok(LogMsg::JsonPatch(patch)));
                        }
                        None
                    }
                    Ok(other) => Some(Ok(other)),
                    Err(_) => None,
                }
            });

        let initial_stream = futures::stream::iter(vec![Ok(initial_msg), Ok(LogMsg::Ready)]);
        Ok(initial_stream.chain(filtered_stream).boxed())
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use db::{DBService, models::project::CreateProject};
    use futures::StreamExt;
    use utils::{log_msg::LogMsg, msg_store::MsgStore};
    use uuid::Uuid;

    use super::EventService;

    #[tokio::test]
    async fn stream_projects_raw_reads_snapshot_via_reader_pool_while_writer_is_locked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = DBService::new_at(dir.path()).await.expect("db service");
        let msg_store = Arc::new(MsgStore::new());
        let events = EventService::new(db.clone(), msg_store);

        let home = crate::services::project::ProjectService::new()
            .ensure_home_project(&db.pool, &crate::services::repo::RepoService::new())
            .await
            .expect("ensure home project");
        let extra_id = Uuid::new_v4();
        db::models::project::Project::create(
            &db.pool,
            &CreateProject {
                name: "Existing User Project".to_string(),
                ..Default::default()
            },
            extra_id,
        )
        .await
        .expect("create user project");

        // Hold the sole writer connection inside an active IMMEDIATE write transaction
        // simulating heavy post-update startup reconciliation.
        let mut writer_conn = db.pool.acquire().await.expect("acquire writer");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *writer_conn)
            .await
            .expect("begin immediate");

        let mut stream = tokio::time::timeout(Duration::from_secs(1), events.stream_projects_raw())
            .await
            .expect("stream_projects_raw must not block on writer_pool")
            .expect("stream_projects_raw succeeds via ReadPool");

        let first = stream
            .next()
            .await
            .expect("initial patch")
            .expect("ok patch");
        let LogMsg::JsonPatch(patch) = first else {
            panic!("expected initial JsonPatch, got {first:?}");
        };
        let patch_json = serde_json::to_value(&patch).expect("serialize patch");
        let projects_obj = patch_json[0]["value"]
            .as_object()
            .expect("/projects replace object");
        assert!(projects_obj.contains_key(&home.id.to_string()));
        assert!(projects_obj.contains_key(&extra_id.to_string()));

        let second = stream.next().await.expect("ready msg").expect("ok ready");
        assert!(matches!(second, LogMsg::Ready));

        sqlx::query("ROLLBACK")
            .execute(&mut *writer_conn)
            .await
            .expect("rollback");
    }

    #[tokio::test]
    async fn stream_projects_raw_does_not_stall_when_home_project_is_missing_and_writer_is_busy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = DBService::new_at(dir.path()).await.expect("db service");
        let msg_store = Arc::new(MsgStore::new());
        let events = EventService::new(db.clone(), msg_store);

        let mut writer_conn = db.pool.acquire().await.expect("acquire writer");
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *writer_conn)
            .await
            .expect("begin immediate");

        let mut stream = tokio::time::timeout(Duration::from_secs(2), events.stream_projects_raw())
            .await
            .expect("stream_projects_raw must time out ensure_home_project quickly")
            .expect("stream_projects_raw still returns snapshot");

        let first = stream
            .next()
            .await
            .expect("initial patch")
            .expect("ok patch");
        assert!(matches!(first, LogMsg::JsonPatch(_)));
        let second = stream.next().await.expect("ready msg").expect("ok ready");
        assert!(matches!(second, LogMsg::Ready));

        sqlx::query("ROLLBACK")
            .execute(&mut *writer_conn)
            .await
            .expect("rollback");
        drop(writer_conn);
    }
}
