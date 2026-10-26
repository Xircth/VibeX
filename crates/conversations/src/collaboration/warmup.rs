//! Start or resume a group member's ACP process without opening a turn.

use async_trait::async_trait;
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    hot_group::HotGroupTracker, load_space_or_unassigned, resolve_targets, CollaborationError,
};

/// Start/resume the ACP process for a member conversation. Must not send a
/// prompt, open a turn, or write a space message.
#[async_trait]
pub trait SessionProcessWarmup: Send + Sync {
    /// `Ok(true)` when the process was already running.
    async fn ensure_process(&self, conversation_id: Uuid) -> Result<bool, String>;
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceWarmupResult {
    pub nicknames: Vec<String>,
    pub started: usize,
    pub already_running: usize,
}

pub async fn warmup_space_members(
    pool: &SqlitePool,
    space_id: &str,
    content: &str,
    to: &[String],
    warmer: Option<&dyn SessionProcessWarmup>,
    hot_groups: Option<&HotGroupTracker>,
) -> Result<SpaceWarmupResult, CollaborationError> {
    if space_id.starts_with("direct:") {
        return Ok(SpaceWarmupResult::default());
    }
    load_space_or_unassigned(pool, space_id).await?;
    if let Some(tracker) = hot_groups {
        tracker.mark_hot(space_id);
    }
    let targets = resolve_targets(pool, space_id, None, to, content).await?;
    let mut result = SpaceWarmupResult::default();
    for target in targets {
        let Some(conversation_id) = target.conversation_id else {
            continue;
        };
        result.nicknames.push(target.nickname);
        let Some(warmer) = warmer else {
            continue;
        };
        match warmer.ensure_process(conversation_id).await {
            Ok(true) => result.already_running += 1,
            Ok(false) => result.started += 1,
            Err(error) => {
                tracing::warn!(
                    %error,
                    %conversation_id,
                    space_id,
                    "space warmup failed for member session"
                );
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::collaboration::test_support::*;
    use crate::collaboration::{
        add_space_member, preview_space_wake, set_space_lead, HotGroupTracker,
    };
    use agents::AgentSessionId;

    struct RecordingWarmer {
        calls: Mutex<Vec<Uuid>>,
        running: Mutex<std::collections::HashSet<Uuid>>,
    }

    impl RecordingWarmer {
        fn new() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                running: Mutex::new(std::collections::HashSet::new()),
            }
        }
    }

    #[async_trait]
    impl SessionProcessWarmup for RecordingWarmer {
        async fn ensure_process(&self, conversation_id: Uuid) -> Result<bool, String> {
            self.calls.lock().expect("calls").push(conversation_id);
            let mut running = self.running.lock().expect("running");
            if !running.insert(conversation_id) {
                return Ok(true);
            }
            Ok(false)
        }
    }

    #[tokio::test]
    async fn warmup_uses_the_same_targets_as_send_and_writes_no_turn_or_message() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let lead_id: Option<String> = sqlx::query_scalar(
            "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND nickname = ?",
        )
        .bind(&space)
        .bind("小B")
        .fetch_optional(&pool)
        .await
        .unwrap();
        if let Some(member_id) = lead_id {
            set_space_lead(&pool, &space, Some(&member_id))
                .await
                .unwrap();
        }

        let messages_before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&space)
        .fetch_one(&pool)
        .await
        .unwrap();
        let turns_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversation_turns")
                .fetch_one(&pool)
                .await
                .unwrap();
        let inputs_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversation_inputs")
                .fetch_one(&pool)
                .await
                .unwrap();

        let warmer = RecordingWarmer::new();
        let tracker = HotGroupTracker::default();
        let default_preview = preview_space_wake(&pool, &space, None, "开工", &[])
            .await
            .unwrap();
        let warmed = warmup_space_members(
            &pool,
            &space,
            "开工",
            &[],
            Some(&warmer),
            Some(&tracker),
        )
        .await
        .unwrap();
        assert_eq!(warmed.nicknames, default_preview.nicknames);
        assert_eq!(warmed.started, 1);
        assert_eq!(warmed.already_running, 0);

        let mentioned_preview = preview_space_wake(&pool, &space, None, "@小A 看看", &[])
            .await
            .unwrap();
        let mentioned = warmup_space_members(
            &pool,
            &space,
            "@小A 看看",
            &["小A".to_string()],
            Some(&warmer),
            Some(&tracker),
        )
        .await
        .unwrap();
        assert_eq!(mentioned.nicknames, mentioned_preview.nicknames);

        let messages_after: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&space)
        .fetch_one(&pool)
        .await
        .unwrap();
        let turns_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversation_turns")
                .fetch_one(&pool)
                .await
                .unwrap();
        let inputs_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversation_inputs")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(messages_after, messages_before);
        assert_eq!(turns_after, turns_before);
        assert_eq!(inputs_after, inputs_before);
        assert!(
            tracker
                .hot_member_sessions(&pool)
                .await
                .contains(&AgentSessionId(a))
                || tracker
                    .hot_member_sessions(&pool)
                    .await
                    .contains(&AgentSessionId(b))
        );
    }

    #[tokio::test]
    async fn warmup_does_not_restart_an_already_running_process() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let warmer = RecordingWarmer::new();
        let first = warmup_space_members(&pool, &space, "hi", &[], Some(&warmer), None)
            .await
            .unwrap();
        let second = warmup_space_members(&pool, &space, "hi", &[], Some(&warmer), None)
            .await
            .unwrap();
        assert_eq!(first.started, 1);
        assert_eq!(first.already_running, 0);
        assert_eq!(second.started, 0);
        assert_eq!(second.already_running, 1);
        assert_eq!(warmer.calls.lock().expect("calls").len(), 2);
        assert_eq!(warmer.running.lock().expect("running").len(), 1);
    }

    #[tokio::test]
    async fn warmup_skips_direct_threads() {
        let pool = setup_pool().await;
        let warmer = RecordingWarmer::new();
        let result = warmup_space_members(
            &pool,
            "direct:mem-a",
            "hi",
            &[],
            Some(&warmer),
            None,
        )
        .await
        .unwrap();
        assert!(result.nicknames.is_empty());
        assert!(warmer.calls.lock().expect("calls").is_empty());
    }
}
