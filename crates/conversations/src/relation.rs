use std::sync::Arc;

use agents::{ConversationEvent, ConversationRelationKind, ConversationRelationVisibility};
use db::models::{
    conversation::DbConversationSummary, conversation_event::AppendConversationEvent,
    conversation_relation::ConversationRelationRecord,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::{ConversationEventAppender, ConversationEventPublisher};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationRelationView {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub child_conversation_id: Uuid,
    pub kind: ConversationRelationKind,
    pub visibility: ConversationRelationVisibility,
    pub metadata: serde_json::Value,
    pub child: ConversationChildSummaryView,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationChildSummaryView {
    pub workspace_id: Uuid,
    pub title: Option<String>,
    pub status: String,
    pub active_turn_status: Option<String>,
    pub queued_input_count: i64,
    pub message_count: i64,
}

#[derive(Debug, Clone)]
pub struct CreateConversationRelation {
    pub parent_conversation_id: Uuid,
    pub child_conversation_id: Uuid,
    pub kind: ConversationRelationKind,
    pub visibility: ConversationRelationVisibility,
    pub metadata: serde_json::Value,
}

#[derive(Clone)]
pub struct ConversationRelationControl {
    pool: SqlitePool,
    publisher: Option<Arc<dyn ConversationEventPublisher>>,
}

impl ConversationRelationControl {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            publisher: None,
        }
    }

    pub fn with_publisher(
        pool: SqlitePool,
        publisher: Arc<dyn ConversationEventPublisher>,
    ) -> Self {
        Self {
            pool,
            publisher: Some(publisher),
        }
    }

    pub async fn create(
        &self,
        input: CreateConversationRelation,
    ) -> Result<ConversationRelationView, sqlx::Error> {
        let kind = relation_kind_str(input.kind);
        if let Some(existing) = ConversationRelationRecord::find(
            &self.pool,
            input.parent_conversation_id,
            input.child_conversation_id,
            kind,
        )
        .await?
        {
            return self.view(existing).await;
        }
        let relation_id = Uuid::new_v4();
        let event = ConversationEvent::ConversationRelationCreated {
            relation_id,
            parent_conversation_id: input.parent_conversation_id,
            child_conversation_id: input.child_conversation_id,
            relation_kind: input.kind,
            visibility: input.visibility,
            metadata: input.metadata,
        };
        let normalized_json = serde_json::to_string(&event).map_err(protocol_error)?;
        let key = format!(
            "conversation-relation:{}:{}:{kind}",
            input.parent_conversation_id, input.child_conversation_id
        );
        let event_id = Uuid::new_v4();
        let record = ConversationEventAppender::append(
            &self.pool,
            AppendConversationEvent {
                id: event_id,
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&key),
            },
        )
        .await?;
        if record.id == event_id
            && let Some(publisher) = &self.publisher
        {
            publisher.publish(&record).await;
        }
        let relation = ConversationRelationRecord::find(
            &self.pool,
            input.parent_conversation_id,
            input.child_conversation_id,
            kind,
        )
        .await?
        .ok_or_else(|| sqlx::Error::Protocol("relation projection is missing".to_string()))?;
        self.view(relation).await
    }

    pub async fn list_children(
        &self,
        parent_conversation_id: Uuid,
    ) -> Result<Vec<ConversationRelationView>, sqlx::Error> {
        let records =
            ConversationRelationRecord::list_children(&self.pool, parent_conversation_id).await?;
        let mut views = Vec::with_capacity(records.len());
        for record in records {
            views.push(self.view(record).await?);
        }
        Ok(views)
    }

    pub async fn is_descendant(
        &self,
        parent_conversation_id: Uuid,
        possible_descendant: Uuid,
    ) -> Result<bool, sqlx::Error> {
        ConversationRelationRecord::is_descendant(
            &self.pool,
            parent_conversation_id,
            possible_descendant,
        )
        .await
    }

    pub async fn is_in_companion_scope(
        &self,
        parent_conversation_id: Uuid,
        target_conversation_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        Ok(self
            .companion_scope_target(parent_conversation_id, target_conversation_id)
            .await?
            .is_some())
    }

    /// Resolve the target only when it is safe for a session-scoped companion
    /// to observe or control it. Keeping this check here makes all companion
    /// surfaces share the same workspace and ancestry boundary.
    pub async fn companion_scope_target(
        &self,
        parent_conversation_id: Uuid,
        target_conversation_id: Uuid,
    ) -> Result<Option<DbConversationSummary>, sqlx::Error> {
        let (Some(parent), Some(target)) = (
            DbConversationSummary::find_by_id(&self.pool, parent_conversation_id).await?,
            DbConversationSummary::find_by_id(&self.pool, target_conversation_id).await?,
        ) else {
            return Ok(None);
        };
        if parent.workspace_id != target.workspace_id {
            return Ok(None);
        }
        let in_scope = target_conversation_id == parent_conversation_id
            || self
                .is_descendant(parent_conversation_id, target_conversation_id)
                .await?;
        Ok(in_scope.then_some(target))
    }

    /// Add event-sourced relation facts for legacy delegated children without
    /// rewriting their historical Conversation events or legacy columns.
    pub async fn backfill_legacy_delegations(&self) -> Result<usize, sqlx::Error> {
        let rows = sqlx::query_as::<_, (Uuid, Uuid, Option<String>, Option<String>)>(
            r#"SELECT child.id, child.parent_session_id,
                      child.parent_tool_use_id, child.delegation_call_id
               FROM sessions child
               WHERE child.parent_session_id IS NOT NULL
                 AND child.delegation_call_id IS NOT NULL
                 AND child.deleted_at IS NULL
                 AND NOT EXISTS (
                     SELECT 1 FROM conversation_relations relation
                     WHERE relation.parent_conversation_id = child.parent_session_id
                       AND relation.child_conversation_id = child.id
                       AND relation.kind = 'delegation'
                 )
               ORDER BY child.created_at, child.id"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut created = 0;
        for (child, parent, parent_tool_call_id, delegation_id) in rows {
            self.create(CreateConversationRelation {
                parent_conversation_id: parent,
                child_conversation_id: child,
                kind: ConversationRelationKind::Delegation,
                visibility: ConversationRelationVisibility::Visible,
                metadata: serde_json::json!({
                    "parentToolCallId": parent_tool_call_id,
                    "delegationId": delegation_id,
                    "backfilled": true,
                }),
            })
            .await?;
            created += 1;
        }
        Ok(created)
    }

    async fn view(
        &self,
        record: ConversationRelationRecord,
    ) -> Result<ConversationRelationView, sqlx::Error> {
        let child = sqlx::query_as::<_, (Uuid, Option<String>, String, Option<String>, i64, i64)>(
            "SELECT child.workspace_id, child.name, child.status, active.status,
                    (SELECT COUNT(*) FROM conversation_inputs input
                     WHERE input.conversation_id = child.id AND input.status = 'queued'),
                    child.message_count
             FROM sessions child
             LEFT JOIN conversation_turns active ON active.id = child.active_turn_id
             WHERE child.id = ? AND child.deleted_at IS NULL",
        )
        .bind(record.child_conversation_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| sqlx::Error::Protocol("relation child is missing".to_string()))?;
        let mut view = ConversationRelationView::try_from(record)?;
        view.child = ConversationChildSummaryView {
            workspace_id: child.0,
            title: child.1,
            status: child.2,
            active_turn_status: child.3,
            queued_input_count: child.4,
            message_count: child.5,
        };
        Ok(view)
    }
}

impl TryFrom<ConversationRelationRecord> for ConversationRelationView {
    type Error = sqlx::Error;

    fn try_from(record: ConversationRelationRecord) -> Result<Self, Self::Error> {
        Ok(Self {
            id: record.id,
            parent_conversation_id: record.parent_conversation_id,
            child_conversation_id: record.child_conversation_id,
            kind: match record.kind.as_str() {
                "delegation" => ConversationRelationKind::Delegation,
                "fork" => ConversationRelationKind::Fork,
                "workflow_step" => ConversationRelationKind::WorkflowStep,
                value => {
                    return Err(sqlx::Error::Protocol(format!(
                        "invalid conversation relation kind `{value}`"
                    )));
                }
            },
            visibility: match record.visibility.as_str() {
                "visible" => ConversationRelationVisibility::Visible,
                "hidden" => ConversationRelationVisibility::Hidden,
                value => {
                    return Err(sqlx::Error::Protocol(format!(
                        "invalid conversation relation visibility `{value}`"
                    )));
                }
            },
            metadata: serde_json::from_str(&record.metadata_json).map_err(protocol_error)?,
            child: ConversationChildSummaryView {
                workspace_id: Uuid::nil(),
                title: None,
                status: "unknown".to_string(),
                active_turn_status: None,
                queued_input_count: 0,
                message_count: 0,
            },
        })
    }
}

fn relation_kind_str(kind: ConversationRelationKind) -> &'static str {
    match kind {
        ConversationRelationKind::Delegation => "delegation",
        ConversationRelationKind::Fork => "fork",
        ConversationRelationKind::WorkflowStep => "workflow_step",
    }
}

fn protocol_error(error: impl std::fmt::Display) -> sqlx::Error {
    sqlx::Error::Protocol(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{AgentId, ConversationRelationKind, ConversationRelationVisibility};
    use db::models::session::{CreateSession, Session};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::{CreateWorkflowConversation, create_workflow_conversation};

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    fn session(agent: &str) -> CreateSession {
        CreateSession {
            executor: None,
            agent_id: Some(AgentId::parse(agent).expect("valid agent id")),
            task_id: None,
            name: None,
            initial_prompt: None,
            status: None,
        }
    }

    async fn create_session(pool: &SqlitePool, id: Uuid) {
        Session::create(pool, &session("codex"), id, Uuid::new_v4())
            .await
            .expect("create session");
    }

    async fn create_session_in(pool: &SqlitePool, id: Uuid, workspace_id: Uuid) {
        Session::create(pool, &session("codex"), id, workspace_id)
            .await
            .expect("create session");
    }

    #[tokio::test]
    async fn relation_creation_is_idempotent_and_rejects_cycles_atomically() {
        let pool = setup_pool().await;
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a).await;
        create_session(&pool, b).await;
        let control = ConversationRelationControl::new(pool.clone());
        let input = CreateConversationRelation {
            parent_conversation_id: a,
            child_conversation_id: b,
            kind: ConversationRelationKind::Fork,
            visibility: ConversationRelationVisibility::Visible,
            metadata: serde_json::json!({"source": "test"}),
        };

        let first = control
            .create(input.clone())
            .await
            .expect("create relation");
        let retry = control.create(input).await.expect("retry relation");
        assert_eq!(first, retry);
        assert_eq!(control.list_children(a).await.unwrap().len(), 1);
        assert_eq!(first.child.status, "todo");
        assert_eq!(first.child.queued_input_count, 0);
        assert!(control.is_descendant(a, b).await.unwrap());

        let error = control
            .create(CreateConversationRelation {
                parent_conversation_id: b,
                child_conversation_id: a,
                kind: ConversationRelationKind::Fork,
                visibility: ConversationRelationVisibility::Visible,
                metadata: serde_json::json!({}),
            })
            .await
            .expect_err("cycle must fail");
        assert!(error.to_string().contains("cycle"));
        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE event_kind = 'conversation_relation_created'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(event_count, 1, "failed projection must roll back its event");
    }

    #[tokio::test]
    async fn legacy_delegation_backfill_is_event_sourced_and_idempotent() {
        let pool = setup_pool().await;
        let parent = Uuid::new_v4();
        let child = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        Session::create(&pool, &session("claude_code"), parent, workspace)
            .await
            .unwrap();
        Session::create_with_delegation(
            &pool,
            &session("codex"),
            child,
            workspace,
            parent,
            "tool-1",
            "delegation-1",
        )
        .await
        .unwrap();
        let control = ConversationRelationControl::new(pool.clone());

        assert_eq!(control.backfill_legacy_delegations().await.unwrap(), 1);
        assert_eq!(control.backfill_legacy_delegations().await.unwrap(), 0);
        let relations = control.list_children(parent).await.unwrap();
        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].child_conversation_id, child);
        assert_eq!(relations[0].kind, ConversationRelationKind::Delegation);
        assert_eq!(relations[0].metadata["backfilled"], true);
    }

    #[tokio::test]
    async fn companion_scope_allows_self_and_descendants_but_not_siblings_or_other_workspaces() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let other_workspace = Uuid::new_v4();
        let root = Uuid::new_v4();
        let child = Uuid::new_v4();
        let grandchild = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        let cross_workspace = Uuid::new_v4();
        for id in [root, child, grandchild, sibling] {
            create_session_in(&pool, id, workspace).await;
        }
        create_session_in(&pool, cross_workspace, other_workspace).await;
        let control = ConversationRelationControl::new(pool.clone());
        for (parent, descendant) in [(root, child), (child, grandchild)] {
            control
                .create(CreateConversationRelation {
                    parent_conversation_id: parent,
                    child_conversation_id: descendant,
                    kind: ConversationRelationKind::Delegation,
                    visibility: ConversationRelationVisibility::Visible,
                    metadata: serde_json::json!({}),
                })
                .await
                .unwrap();
        }

        assert!(control.is_in_companion_scope(root, root).await.unwrap());
        assert!(control.is_in_companion_scope(root, child).await.unwrap());
        assert!(
            control
                .is_in_companion_scope(root, grandchild)
                .await
                .unwrap()
        );
        assert!(!control.is_in_companion_scope(child, root).await.unwrap());
        assert!(!control.is_in_companion_scope(root, sibling).await.unwrap());
        assert!(
            !control
                .is_in_companion_scope(root, cross_workspace)
                .await
                .unwrap()
        );
        assert!(
            !control
                .is_in_companion_scope(root, Uuid::new_v4())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn workflow_retries_keep_a_relation_for_every_child_attempt() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        create_session_in(&pool, run_id, workspace).await;
        for child_id in [Uuid::new_v4(), Uuid::new_v4()] {
            create_workflow_conversation(
                &pool,
                CreateWorkflowConversation {
                    id: child_id,
                    parent_conversation_id: run_id,
                    workspace_id: workspace,
                    workflow_run_id: run_id,
                    workflow_step_id: "build".to_string(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    prompt: "build".to_string(),
                    visible: false,
                },
            )
            .await
            .unwrap();
        }

        let relations = ConversationRelationControl::new(pool)
            .list_children(run_id)
            .await
            .unwrap();
        assert_eq!(relations.len(), 2);
        assert!(relations.iter().all(|relation| {
            relation.kind == ConversationRelationKind::WorkflowStep
                && relation.visibility == ConversationRelationVisibility::Hidden
        }));
    }
}
