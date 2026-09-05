use std::{
    collections::{BTreeSet, HashMap},
    future::Future,
    time::{Duration, Instant},
};

use agents::{
    HistoryPathDestination, HistoryScanEntry, ImportedAgentSession, LocalHistoryDestination,
    LocalHistoryImportJobSnapshot, LocalHistoryImportPhase, LocalHistoryImportProgress,
    LocalHistoryImportResult, LocalHistoryImportSelection, LocalHistoryScanPage,
    LocalHistoryScanProgress, build_local_history_scan_page, load_configured_history_session,
    scan_configured_history_with_progress,
};
use api_types::{AgentId, AgentKind};
use db::models::{
    conversation::DbConversationSummary, project::Project, project_repo::ProjectRepo,
    workspace::Workspace,
};
use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{Emitter, ipc::Channel};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

pub const WORKSPACE_SESSIONS_CHANGED_EVENT: &str = "workspace-sessions-changed";
pub const LOCAL_HISTORY_IMPORT_PROGRESS_EVENT: &str = "local-history-import-progress";

#[derive(Default)]
pub struct LocalHistoryImportRuntime {
    pub running: bool,
    pub snapshot: LocalHistoryImportJobSnapshot,
}

#[derive(Clone, serde::Serialize)]
pub struct WorkspaceSessionsChanged {
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct AgentImportLocalHistoryBatchRequest {
    pub selections: Vec<LocalHistoryImportSelection>,
}

#[tauri::command]
pub async fn agent_scan_local_history(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    on_event: Channel<LocalHistoryScanProgress>,
) -> Result<LocalHistoryScanPage, AppError> {
    let pool = &state.deployment.db().pool;
    let sessions = scan_local_history_for_agent(pool, &agent_id, move |progress| {
        let _ = on_event.send(progress);
    })
    .await?;
    assemble_local_history_scan_page(pool, sessions).await
}

#[tauri::command]
pub async fn agent_import_local_history_batch(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: AgentImportLocalHistoryBatchRequest,
) -> Result<LocalHistoryImportJobSnapshot, AppError> {
    if request.selections.is_empty() {
        return Err(AppError::BadRequest(
            "Select at least one local conversation to import".to_string(),
        ));
    }
    let snapshot = {
        let mut job = state
            .local_history_import
            .lock()
            .expect("local history import lock");
        if job.running {
            return Err(AppError::Conflict(
                "A local conversation import is already running".to_string(),
            ));
        }
        job.running = true;
        job.snapshot = LocalHistoryImportJobSnapshot::begin_running();
        job.snapshot.clone()
    };
    let pool = state.deployment.db().pool.clone();
    let job = state.local_history_import.clone();
    let selections = request.selections;
    tauri::async_runtime::spawn(async move {
        let outcome = import_local_history_batch(
            &pool,
            &selections,
            |selection| {
                let pool = pool.clone();
                let selection = selection.clone();
                async move { load_selected_history_session(&pool, &selection).await }
            },
            |progress| {
                if progress.phase == LocalHistoryImportPhase::Imported
                    && let (Some(workspace_id), Some(conversation_id)) =
                        (progress.workspace_id, progress.conversation_id)
                {
                    let _ = app.emit(
                        WORKSPACE_SESSIONS_CHANGED_EVENT,
                        WorkspaceSessionsChanged {
                            workspace_id,
                            conversation_id,
                        },
                    );
                }
                let snapshot = {
                    let mut runtime = job.lock().expect("local history import lock");
                    runtime.snapshot.apply_progress(progress);
                    runtime.snapshot.clone()
                };
                let _ = app.emit(LOCAL_HISTORY_IMPORT_PROGRESS_EVENT, snapshot);
            },
        )
        .await;
        let snapshot = {
            let mut runtime = job.lock().expect("local history import lock");
            runtime.running = false;
            match outcome {
                Ok(result) => runtime.snapshot.finish(result),
                Err(error) => runtime.snapshot.fail_to_start(error.to_string()),
            }
            runtime.snapshot.clone()
        };
        let _ = app.emit(LOCAL_HISTORY_IMPORT_PROGRESS_EVENT, snapshot);
    });
    Ok(snapshot)
}

#[tauri::command]
pub async fn agent_local_history_import_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<LocalHistoryImportJobSnapshot, AppError> {
    Ok(state
        .local_history_import
        .lock()
        .expect("local history import lock")
        .snapshot
        .clone())
}

pub(crate) async fn import_local_history_batch<L, Fut, F>(
    pool: &SqlitePool,
    selections: &[LocalHistoryImportSelection],
    mut load_session: L,
    mut on_progress: F,
) -> Result<LocalHistoryImportResult, AppError>
where
    L: FnMut(&LocalHistoryImportSelection) -> Fut,
    Fut: Future<Output = Result<ImportedAgentSession, AppError>>,
    F: FnMut(LocalHistoryImportProgress),
{
    let total = selections.len() as u32;
    let mut result = LocalHistoryImportResult {
        imported: 0,
        skipped: 0,
        failed: 0,
        conversation_ids: Vec::new(),
        errors: Vec::new(),
    };

    for (index, selection) in selections.iter().enumerate() {
        let current = index as u32 + 1;
        on_progress(LocalHistoryImportProgress::for_selection(
            current,
            total,
            selection,
            None,
            LocalHistoryImportPhase::Loading,
            &result,
        ));

        let session = match load_session(selection).await {
            Ok(session) => session,
            Err(error) => {
                tracing::warn!(
                    agent_id = %selection.agent_id,
                    session = %selection.external_session_id,
                    %error,
                    "failed to load selected local history session"
                );
                result.failed += 1;
                result.errors.push(format!(
                    "Local session {} was not found",
                    selection.external_session_id
                ));
                on_progress(LocalHistoryImportProgress::for_selection(
                    current,
                    total,
                    selection,
                    None,
                    LocalHistoryImportPhase::Failed,
                    &result,
                ));
                continue;
            }
        };

        on_progress(LocalHistoryImportProgress::for_selection(
            current,
            total,
            selection,
            session.title.clone(),
            LocalHistoryImportPhase::Importing,
            &result,
        ));

        let one = import_selected_local_history(
            pool,
            std::slice::from_ref(&session),
            std::slice::from_ref(selection),
        )
        .await?;
        result.imported += one.imported;
        result.skipped += one.skipped;
        result.failed += one.failed;
        result.errors.extend(one.errors);
        let conversation_id = one.conversation_ids.last().copied();
        result.conversation_ids.extend(one.conversation_ids);
        let phase = if one.imported > 0 {
            LocalHistoryImportPhase::Imported
        } else if one.skipped > 0 {
            LocalHistoryImportPhase::Skipped
        } else {
            LocalHistoryImportPhase::Failed
        };
        let mut progress = LocalHistoryImportProgress::for_selection(
            current,
            total,
            selection,
            session.title,
            phase,
            &result,
        );
        if let Some(conversation_id) = conversation_id {
            progress = progress.with_conversation(conversation_id, selection.workspace_id);
        }
        on_progress(progress);
    }

    Ok(result)
}

pub(crate) async fn assemble_local_history_scan_page(
    pool: &SqlitePool,
    sessions: Vec<HistoryScanEntry>,
) -> Result<LocalHistoryScanPage, AppError> {
    let imported = load_imported_history_keys(pool).await?;
    let (destinations, project_destinations) = load_history_destinations(pool).await?;
    Ok(build_local_history_scan_page(
        sessions,
        &imported,
        &destinations,
        project_destinations,
    ))
}

pub(crate) async fn import_selected_local_history(
    pool: &SqlitePool,
    sessions: &[ImportedAgentSession],
    selections: &[LocalHistoryImportSelection],
) -> Result<LocalHistoryImportResult, AppError> {
    let mut result = LocalHistoryImportResult {
        imported: 0,
        skipped: 0,
        failed: 0,
        conversation_ids: Vec::new(),
        errors: Vec::new(),
    };

    for selection in selections {
        Workspace::find_by_id(pool, selection.workspace_id)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "Workspace {} was not found",
                    selection.workspace_id
                ))
            })?;
        if let Some(existing) = DbConversationSummary::find_by_external_id(
            pool,
            &selection.external_session_id,
            &selection.agent_id,
        )
        .await?
        {
            result.skipped += 1;
            result.conversation_ids.push(existing.id);
            continue;
        }

        let Some(session) = sessions.iter().find(|session| {
            session.external_session_id == selection.external_session_id
                && session.source_agent.as_str() == selection.agent_id.as_str()
        }) else {
            result.failed += 1;
            result.errors.push(format!(
                "Local session {} was not found",
                selection.external_session_id
            ));
            continue;
        };

        match crate::commands::conversations::import_agent_session_to_conversation_events(
            pool,
            selection.workspace_id,
            session,
        )
        .await
        {
            Ok(conversation_id) => {
                result.imported += 1;
                result.conversation_ids.push(conversation_id);
            }
            Err(error) => {
                result.failed += 1;
                result.errors.push(error.to_string());
            }
        }
    }

    Ok(result)
}

async fn load_imported_history_keys(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        r#"SELECT agent_id, external_session_id
           FROM sessions
           WHERE deleted_at IS NULL
             AND agent_id IS NOT NULL
             AND external_session_id IS NOT NULL"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(agent_id, external_id)| Some((agent_id?, external_id?)))
        .collect())
}

async fn load_history_destinations(
    pool: &SqlitePool,
) -> Result<(Vec<HistoryPathDestination>, Vec<LocalHistoryDestination>), AppError> {
    let projects = Project::find_all(pool).await?;
    let workspaces = Workspace::find_all_with_status(pool, Some(false), None).await?;
    let mut destinations = Vec::new();
    let mut project_destinations = Vec::new();

    for project in &projects {
        let repos = ProjectRepo::find_repos_for_project(pool, project.id).await?;
        let project_workspaces = workspaces
            .iter()
            .filter(|workspace| workspace.project_id == project.id)
            .collect::<Vec<_>>();
        let Some(default_workspace) = project_workspaces.first() else {
            continue;
        };
        project_destinations.push(LocalHistoryDestination {
            project_id: project.id,
            project_name: project.name.clone(),
            workspace_id: default_workspace.id,
            workspace_name: default_workspace
                .name
                .clone()
                .or_else(|| Some(default_workspace.branch.clone())),
        });

        for workspace in &project_workspaces {
            if let Some(path) = workspace
                .container_ref
                .as_deref()
                .filter(|path| !path.trim().is_empty())
            {
                destinations.push(HistoryPathDestination {
                    path: path.to_string(),
                    project_id: project.id,
                    project_name: project.name.clone(),
                    workspace_id: workspace.id,
                });
            }
        }
        for repo in repos {
            let path = repo.path.to_string_lossy().to_string();
            if path.trim().is_empty() {
                continue;
            }
            destinations.push(HistoryPathDestination {
                path,
                project_id: project.id,
                project_name: project.name.clone(),
                workspace_id: default_workspace.id,
            });
        }
    }

    Ok((destinations, project_destinations))
}

pub(crate) async fn load_selected_history_session(
    pool: &SqlitePool,
    selection: &LocalHistoryImportSelection,
) -> Result<ImportedAgentSession, AppError> {
    let agent_kind = AgentKind::from_lenient(selection.agent_id.as_str()).ok_or_else(|| {
        AppError::BadRequest(format!(
            "Agent {} has no local history parser",
            selection.agent_id
        ))
    })?;
    let configured_env = load_agent_history_env(pool, &selection.agent_id).await?;
    let external_session_id = selection.external_session_id.clone();
    tokio::task::spawn_blocking(move || {
        load_configured_history_session(agent_kind, &configured_env, &external_session_id)
            .map_err(|error| AppError::Internal(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Internal(format!("local history load failed: {error}")))?
}

async fn load_agent_history_env(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, AppError> {
    Ok(sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .flatten()
    .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
    .unwrap_or_default())
}

pub(crate) async fn scan_local_history_for_agent(
    pool: &SqlitePool,
    agent_id: &AgentId,
    mut on_progress: impl FnMut(LocalHistoryScanProgress) + Send + 'static,
) -> Result<Vec<HistoryScanEntry>, AppError> {
    let agent_kind = AgentKind::from_lenient(agent_id.as_str()).ok_or_else(|| {
        AppError::BadRequest(format!("Agent {agent_id} has no local history parser"))
    })?;
    let configured_env = load_agent_history_env(pool, agent_id).await?;
    tokio::task::spawn_blocking(move || {
        let mut last_sent: Option<Instant> = None;
        let mut latest = LocalHistoryScanProgress::default();
        let sessions =
            scan_configured_history_with_progress(agent_kind, &configured_env, |progress| {
                latest = progress;
                if last_sent.is_none_or(|sent| sent.elapsed() >= Duration::from_millis(50)) {
                    last_sent = Some(Instant::now());
                    on_progress(progress);
                }
            })
            .map_err(|error| AppError::Internal(error.to_string()))?;
        on_progress(latest);
        Ok(sessions)
    })
    .await
    .map_err(|error| AppError::Internal(format!("local history scan failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentKind, ImportedAgentMessage, ImportedAgentMessageRole, ImportedAgentSession,
        LocalHistoryImportPhase, LocalHistoryImportSelection,
    };
    use api_types::AgentId;
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
        session::SessionStatus,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::*;

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    fn imported_session(external_id: &str) -> ImportedAgentSession {
        ImportedAgentSession {
            source_agent: AgentKind::Codex,
            external_session_id: external_id.to_string(),
            title: Some("Imported Codex".to_string()),
            workspace_path: Some(std::path::PathBuf::from("/Users/mac/Projects/VibeX")),
            messages: vec![
                ImportedAgentMessage {
                    role: ImportedAgentMessageRole::User,
                    content: "continue this work".to_string(),
                    created_at: None,
                    metadata: Default::default(),
                },
                ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Assistant,
                    content: "imported reply".to_string(),
                    created_at: None,
                    metadata: Default::default(),
                },
            ],
            raw_source_path: None,
        }
    }

    async fn insert_workspace(pool: &SqlitePool, workspace_id: Uuid) {
        sqlx::query(
            r#"INSERT INTO workspaces (
                   id, project_id, task_id, parent_workspace_id, container_ref,
                   branch, use_worktree, agent_working_dir, setup_completed_at
               ) VALUES (?, ?, ?, NULL, NULL, 'main', 1, NULL, NULL)"#,
        )
        .bind(workspace_id)
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .expect("insert workspace");
    }

    #[tokio::test]
    async fn batch_import_writes_sessions_and_skips_duplicates() {
        let pool = migrated_pool().await;
        let workspace_id = Uuid::new_v4();
        insert_workspace(&pool, workspace_id).await;
        let sessions = [imported_session("codex-1"), imported_session("codex-2")];
        let agent_id = AgentId::parse("codex").expect("codex id");
        let first = import_selected_local_history(
            &pool,
            &sessions,
            &[
                LocalHistoryImportSelection {
                    agent_id: agent_id.clone(),
                    external_session_id: "codex-1".into(),
                    workspace_id,
                },
                LocalHistoryImportSelection {
                    agent_id: agent_id.clone(),
                    external_session_id: "codex-2".into(),
                    workspace_id,
                },
            ],
        )
        .await
        .expect("first import");

        assert_eq!(first.imported, 2);
        assert_eq!(first.skipped, 0);
        assert_eq!(first.failed, 0);

        let listed = DbConversationSummary::list_for_workspace(&pool, workspace_id)
            .await
            .expect("list workspace sessions");
        assert_eq!(listed.len(), 2);
        assert!(
            listed
                .iter()
                .all(|session| session.status == SessionStatus::Done)
        );

        let second = import_selected_local_history(
            &pool,
            &sessions,
            &[LocalHistoryImportSelection {
                agent_id,
                external_session_id: "codex-1".into(),
                workspace_id,
            }],
        )
        .await
        .expect("second import");
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(
            DbConversationSummary::list_for_workspace(&pool, workspace_id)
                .await
                .expect("list after skip")
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn scan_page_marks_existing_workspace_sessions_imported() {
        let pool = migrated_pool().await;
        let workspace_id = Uuid::new_v4();
        insert_workspace(&pool, workspace_id).await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id,
                task_id: None,
                title: Some("Existing"),
                initial_prompt: Some("hello"),
                status: Some(SessionStatus::Done),
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let agent_id = AgentId::parse("codex").expect("codex id");
        DbConversationSummary::bind_external_id(&pool, conversation_id, "codex-1", &agent_id)
            .await
            .expect("bind external id");

        let page = assemble_local_history_scan_page(
            &pool,
            vec![agents::HistoryScanEntry::from(&imported_session("codex-1"))],
        )
        .await
        .expect("scan page");
        assert_eq!(page.total_sessions, 1);
        assert_eq!(page.importable_count, 0);
        assert_eq!(
            page.folders[0].sessions[0].status,
            agents::LocalHistorySessionStatus::Imported
        );
    }

    #[tokio::test]
    async fn batch_import_reports_progress_for_each_session() {
        let pool = migrated_pool().await;
        let workspace_id = Uuid::new_v4();
        insert_workspace(&pool, workspace_id).await;
        let agent_id = AgentId::parse("codex").expect("codex id");
        let sessions = [imported_session("codex-1"), imported_session("codex-2")];
        let selections = [
            LocalHistoryImportSelection {
                agent_id: agent_id.clone(),
                external_session_id: "codex-1".into(),
                workspace_id,
            },
            LocalHistoryImportSelection {
                agent_id,
                external_session_id: "codex-2".into(),
                workspace_id,
            },
        ];
        let mut events = Vec::new();

        let result = import_local_history_batch(
            &pool,
            &selections,
            |selection| {
                let session = sessions
                    .iter()
                    .find(|session| session.external_session_id == selection.external_session_id)
                    .cloned()
                    .expect("session");
                async move { Ok(session) }
            },
            |progress| events.push(progress),
        )
        .await
        .expect("import with progress");

        assert_eq!(result.imported, 2);
        assert_eq!(result.failed, 0);
        assert_eq!(
            events
                .iter()
                .map(|event| (event.current, event.phase, event.title.clone()))
                .collect::<Vec<_>>(),
            vec![
                (1, LocalHistoryImportPhase::Loading, None),
                (
                    1,
                    LocalHistoryImportPhase::Importing,
                    Some("Imported Codex".into())
                ),
                (
                    1,
                    LocalHistoryImportPhase::Imported,
                    Some("Imported Codex".into())
                ),
                (2, LocalHistoryImportPhase::Loading, None),
                (
                    2,
                    LocalHistoryImportPhase::Importing,
                    Some("Imported Codex".into())
                ),
                (
                    2,
                    LocalHistoryImportPhase::Imported,
                    Some("Imported Codex".into())
                ),
            ]
        );
        assert_eq!(events.last().map(|event| event.total), Some(2));
        assert_eq!(events.last().map(|event| event.imported), Some(2));
        let imported = events
            .iter()
            .filter(|event| event.phase == LocalHistoryImportPhase::Imported)
            .collect::<Vec<_>>();
        assert_eq!(imported.len(), 2);
        assert_eq!(imported[0].workspace_id, Some(workspace_id));
        assert_eq!(imported[1].workspace_id, Some(workspace_id));
        assert_eq!(
            imported
                .iter()
                .filter_map(|event| event.conversation_id)
                .collect::<Vec<_>>(),
            result.conversation_ids
        );
    }

    #[tokio::test]
    async fn batch_import_counts_load_failures_and_keeps_going() {
        let pool = migrated_pool().await;
        let workspace_id = Uuid::new_v4();
        insert_workspace(&pool, workspace_id).await;
        let agent_id = AgentId::parse("codex").expect("codex id");
        let session = imported_session("codex-ok");
        let selections = [
            LocalHistoryImportSelection {
                agent_id: agent_id.clone(),
                external_session_id: "missing".into(),
                workspace_id,
            },
            LocalHistoryImportSelection {
                agent_id,
                external_session_id: "codex-ok".into(),
                workspace_id,
            },
        ];
        let mut events = Vec::new();

        let result = import_local_history_batch(
            &pool,
            &selections,
            |selection| {
                let missing = selection.external_session_id == "missing";
                let session = session.clone();
                async move {
                    if missing {
                        Err(AppError::Internal("missing session file".into()))
                    } else {
                        Ok(session)
                    }
                }
            },
            |progress| events.push(progress),
        )
        .await
        .expect("partial import");

        assert_eq!(result.imported, 1);
        assert_eq!(result.failed, 1);
        assert_eq!(
            events.iter().map(|event| event.phase).collect::<Vec<_>>(),
            vec![
                LocalHistoryImportPhase::Loading,
                LocalHistoryImportPhase::Failed,
                LocalHistoryImportPhase::Loading,
                LocalHistoryImportPhase::Importing,
                LocalHistoryImportPhase::Imported,
            ]
        );
    }
}
