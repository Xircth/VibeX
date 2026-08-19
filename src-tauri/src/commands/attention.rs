//! Attention inbox: one cross-project list answering "what needs me right
//! now", ordered by how hard each item blocks an agent. Three sources:
//! pending permission/question requests (in-memory runtime state), sessions
//! whose latest turn failed or was interrupted, and sessions waiting in
//! review (both from the DB).

use std::collections::{HashMap, HashSet};

use db::models::attention::{self, AttentionSessionRow};
use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
pub enum AttentionItemKind {
    /// Agent is blocked on a permission decision — highest priority.
    PendingPermission,
    /// Agent is blocked on a question to the user.
    PendingQuestion,
    /// Session surfaced a notice, warning, or error.
    SessionNotice,
    /// Latest turn completed and may still need a look.
    TurnCompleted,
    /// Latest turn failed; needs a retry or a follow-up.
    TurnFailed,
    /// Latest turn was interrupted by a host crash/restart; never auto-resent.
    TurnInterrupted,
    /// Agent finished; the change is waiting for human review.
    InReview,
}

impl AttentionItemKind {
    fn priority(self) -> u8 {
        match self {
            Self::PendingPermission => 0,
            Self::PendingQuestion => 1,
            Self::SessionNotice => 2,
            Self::TurnFailed => 3,
            Self::TurnInterrupted => 4,
            Self::TurnCompleted => 5,
            Self::InReview => 6,
        }
    }

    fn is_blocking(self) -> bool {
        matches!(self, Self::PendingPermission | Self::PendingQuestion)
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub kind: AttentionItemKind,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub project_id: Uuid,
    pub project_name: String,
    pub session_name: Option<String>,
    pub agent_type: Option<String>,
    pub detail: Option<String>,
    #[ts(type = "number | null")]
    pub happened_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttentionInbox {
    /// Sorted: blocking items first (permission, question), then failures,
    /// then review; newest first within each kind.
    pub items: Vec<AttentionItem>,
    /// Number of items actively blocking an agent right now.
    #[ts(type = "number")]
    pub blocking_count: u32,
}

fn item_from_row(kind: AttentionItemKind, row: AttentionSessionRow) -> AttentionItem {
    AttentionItem {
        kind,
        session_id: row.session_id,
        workspace_id: row.workspace_id,
        task_id: row.task_id,
        project_id: row.project_id,
        project_name: row.project_name,
        session_name: row.session_name,
        agent_type: row.agent_type,
        detail: row.detail,
        happened_at_ms: row.happened_at.map(|at| at.timestamp_millis()),
    }
}

fn merge_items(
    pending: Vec<(Uuid, AttentionItemKind)>,
    pending_contexts: Vec<AttentionSessionRow>,
    failed: Vec<AttentionSessionRow>,
    in_review: Vec<AttentionSessionRow>,
) -> Vec<AttentionItem> {
    let contexts: HashMap<Uuid, AttentionSessionRow> = pending_contexts
        .into_iter()
        .map(|row| (row.session_id, row))
        .collect();

    let mut items = Vec::new();
    let mut seen: HashSet<Uuid> = HashSet::new();

    // Runtime-blocked sessions first; a session blocked on a permission must
    // not also appear as failed/in-review below.
    for (session_id, kind) in pending {
        if let Some(row) = contexts.get(&session_id)
            && seen.insert(session_id)
        {
            items.push(item_from_row(kind, row.clone()));
        }
    }

    for row in failed {
        if !seen.insert(row.session_id) {
            continue;
        }
        let kind = if row.turn_status.as_deref() == Some("interrupted") {
            AttentionItemKind::TurnInterrupted
        } else {
            AttentionItemKind::TurnFailed
        };
        items.push(item_from_row(kind, row));
    }

    for row in in_review {
        if !seen.insert(row.session_id) {
            continue;
        }
        items.push(item_from_row(AttentionItemKind::InReview, row));
    }

    items.sort_by(|a, b| {
        a.kind
            .priority()
            .cmp(&b.kind.priority())
            .then(b.happened_at_ms.cmp(&a.happened_at_ms))
    });
    items
}

#[tauri::command]
pub async fn attention_inbox_list(
    state: tauri::State<'_, AppState>,
) -> Result<AttentionInbox, AppError> {
    // 1) Sessions blocked on a permission/question right now (in-memory).
    let pending: Vec<(Uuid, AttentionItemKind)> = {
        let runtime_states = state.conversation_runtime_states.lock().await;
        runtime_states
            .iter()
            .filter_map(|(session_id, runtime)| {
                if runtime.pending_permission_id.is_some() {
                    Some((*session_id, AttentionItemKind::PendingPermission))
                } else if runtime.pending_question_id.is_some() {
                    Some((*session_id, AttentionItemKind::PendingQuestion))
                } else {
                    None
                }
            })
            .collect()
    };

    let pool = &state.deployment.db().pool;
    let pending_ids: Vec<Uuid> = pending.iter().map(|(id, _)| *id).collect();
    let (pending_contexts, failed, in_review) = tokio::try_join!(
        attention::session_contexts(pool, &pending_ids),
        attention::failed_last_turns(pool),
        attention::sessions_in_review(pool),
    )
    .map_err(|error| AppError::Internal(error.to_string()))?;

    let items = merge_items(pending, pending_contexts, failed, in_review);
    let blocking_count = items.iter().filter(|item| item.kind.is_blocking()).count() as u32;

    Ok(AttentionInbox {
        items,
        blocking_count,
    })
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    fn row(session: u128, project: &str, at_ms: i64) -> AttentionSessionRow {
        AttentionSessionRow {
            session_id: Uuid::from_u128(session),
            session_name: Some(format!("s{session}")),
            agent_type: Some("claude_code".to_string()),
            workspace_id: Uuid::from_u128(session + 1000),
            task_id: Uuid::from_u128(session + 2000),
            project_id: Uuid::from_u128(session + 3000),
            project_name: project.to_string(),
            turn_status: None,
            detail: None,
            happened_at: Some(Utc.timestamp_millis_opt(at_ms).unwrap()),
        }
    }

    #[test]
    fn blocking_items_sort_first_and_dedupe_wins_by_priority() {
        let pending = vec![(Uuid::from_u128(1), AttentionItemKind::PendingPermission)];
        let pending_contexts = vec![row(1, "alpha", 100)];
        // Session 1 also shows up as failed AND in review — must appear once,
        // as the higher-priority pending-permission item.
        let failed = vec![
            {
                let mut r = row(1, "alpha", 200);
                r.turn_status = Some("failed".to_string());
                r
            },
            {
                let mut r = row(2, "beta", 300);
                r.turn_status = Some("interrupted".to_string());
                r
            },
        ];
        let in_review = vec![row(1, "alpha", 400), row(3, "gamma", 500)];

        let items = merge_items(pending, pending_contexts, failed, in_review);

        let kinds: Vec<AttentionItemKind> = items.iter().map(|item| item.kind).collect();
        assert_eq!(
            kinds,
            vec![
                AttentionItemKind::PendingPermission,
                AttentionItemKind::TurnInterrupted,
                AttentionItemKind::InReview,
            ]
        );
        assert_eq!(items.len(), 3, "session 1 deduplicated");
        assert_eq!(items[0].session_id, Uuid::from_u128(1));
        assert_eq!(items[1].session_id, Uuid::from_u128(2));
        assert_eq!(items[2].session_id, Uuid::from_u128(3));
    }

    #[test]
    fn pending_without_db_context_is_skipped() {
        // A runtime entry whose session vanished from the DB must not panic
        // or produce a dangling item.
        let pending = vec![(Uuid::from_u128(9), AttentionItemKind::PendingQuestion)];
        let items = merge_items(pending, Vec::new(), Vec::new(), Vec::new());
        assert!(items.is_empty());
    }

    #[test]
    fn newest_first_within_a_kind() {
        let failed = vec![
            {
                let mut r = row(1, "alpha", 100);
                r.turn_status = Some("failed".to_string());
                r
            },
            {
                let mut r = row(2, "beta", 900);
                r.turn_status = Some("failed".to_string());
                r
            },
        ];
        let items = merge_items(Vec::new(), Vec::new(), failed, Vec::new());
        assert_eq!(items[0].session_id, Uuid::from_u128(2));
        assert_eq!(items[1].session_id, Uuid::from_u128(1));
    }
}
