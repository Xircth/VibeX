use std::collections::{BTreeSet, HashMap};

use agents::{
    HistoryPathDestination, ImportedAgentSession, LocalHistoryDestination,
    LocalHistoryImportResult, LocalHistoryImportSelection, LocalHistoryScanPage,
    build_local_history_scan_page, scan_configured_history,
};
use api_types::{AgentId, AgentKind};
use db::models::{
    conversation::DbConversationSummary, project::Project, project_repo::ProjectRepo,
    workspace::Workspace,
};
use serde::Deserialize;
use sqlx::SqlitePool;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Deserialize)]
pub struct AgentImportLocalHistoryBatchRequest {
    pub selections: Vec<LocalHistoryImportSelection>,
}

#[tauri::command]
pub async fn agent_scan_local_history(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<LocalHistoryScanPage, AppError> {
    let pool = &state.deployment.db().pool;
    let sessions = scan_local_history_for_agent(pool, &agent_id).await?;
    assemble_local_history_scan_page(pool, sessions).await
}

#[tauri::command]
pub async fn agent_import_local_history_batch(
    state: tauri::State<'_, AppState>,
    request: AgentImportLocalHistoryBatchRequest,
) -> Result<LocalHistoryImportResult, AppError> {
    let pool = &state.deployment.db().pool;
    let mut sessions = Vec::new();
    let mut seen = BTreeSet::new();
    for selection in &request.selections {
        if !seen.insert(selection.agent_id.clone()) {
            continue;
        }
        sessions.extend(scan_local_history_for_agent(pool, &selection.agent_id).await?);
    }
    import_selected_local_history(pool, &sessions, &request.selections).await
}

pub(crate) async fn assemble_local_history_scan_page(
    pool: &SqlitePool,
    sessions: Vec<ImportedAgentSession>,
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

pub(crate) async fn scan_local_history_for_agent(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> Result<Vec<ImportedAgentSession>, AppError> {
    let agent_kind = AgentKind::from_lenient(agent_id.as_str()).ok_or_else(|| {
        AppError::BadRequest(format!("Agent {agent_id} has no local history parser"))
    })?;
    let configured_env = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .flatten()
    .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
    .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        scan_configured_history(agent_kind, &configured_env)
            .map_err(|error| AppError::Internal(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Internal(format!("local history scan failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentKind, ImportedAgentMessage, ImportedAgentMessageRole, ImportedAgentSession,
        LocalHistoryImportSelection,
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
        let sessions = vec![imported_session("codex-1"), imported_session("codex-2")];
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

        let page = assemble_local_history_scan_page(&pool, vec![imported_session("codex-1")])
            .await
            .expect("scan page");
        assert_eq!(page.total_sessions, 1);
        assert_eq!(page.importable_count, 0);
        assert_eq!(
            page.folders[0].sessions[0].status,
            agents::LocalHistorySessionStatus::Imported
        );
    }
}
