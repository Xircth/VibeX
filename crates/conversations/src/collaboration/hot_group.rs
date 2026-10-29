//! Hot collaboration groups keep their member ACP sessions alive longer.
//!
//! A group is hot when a user posted in the last N minutes, a delivery is
//! still processing, or the composer just warmed the group. Direct threads
//! never qualify. Once those conditions lapse, the next idle sweep uses the
//! ordinary 180s timeout.

use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Instant,
};

use agents::{AgentSessionId, hot_group_window_from_env};
use chrono::{Duration as ChronoDuration, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{CollaborationError, db, stamp};

#[derive(Default)]
pub struct HotGroupTracker {
    warmup_until: Mutex<HashMap<String, Instant>>,
}

impl HotGroupTracker {
    pub fn mark_hot(&self, space_id: &str) {
        if !is_group_space_id(space_id) {
            return;
        }
        let Some(window) = hot_group_window_from_env() else {
            return;
        };
        self.warmup_until
            .lock()
            .expect("hot group tracker")
            .insert(space_id.to_string(), Instant::now() + window);
    }

    #[cfg(test)]
    pub(crate) fn mark_hot_until(&self, space_id: &str, until: Instant) {
        if !is_group_space_id(space_id) {
            return;
        }
        self.warmup_until
            .lock()
            .expect("hot group tracker")
            .insert(space_id.to_string(), until);
    }

    fn live_warmup_spaces(&self) -> Vec<String> {
        let now = Instant::now();
        let mut guard = self.warmup_until.lock().expect("hot group tracker");
        guard.retain(|_, until| *until > now);
        guard.keys().cloned().collect()
    }

    pub async fn hot_member_sessions(&self, pool: &SqlitePool) -> HashSet<AgentSessionId> {
        match hot_member_conversation_ids(pool, &self.live_warmup_spaces()).await {
            Ok(ids) => ids.into_iter().map(AgentSessionId).collect(),
            Err(error) => {
                tracing::warn!(%error, "hot group session lookup failed");
                HashSet::new()
            }
        }
    }
}

fn is_group_space_id(space_id: &str) -> bool {
    !space_id.is_empty() && !space_id.starts_with("direct:")
}

async fn hot_member_conversation_ids(
    pool: &SqlitePool,
    warmup_spaces: &[String],
) -> Result<Vec<Uuid>, CollaborationError> {
    let mut space_ids: HashSet<String> = warmup_spaces
        .iter()
        .filter(|id| is_group_space_id(id))
        .cloned()
        .collect();

    if let Some(window) = hot_group_window_from_env() {
        let cutoff = stamp(Utc::now() - ChronoDuration::seconds(window.as_secs() as i64));
        let recent: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT space_id
               FROM collaboration_space_messages
               WHERE origin = 'user'
                 AND created_at >= ?
                 AND space_id NOT LIKE 'direct:%'"#,
        )
        .bind(&cutoff)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        space_ids.extend(recent);
    }

    let in_flight: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT m.space_id
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.receipt_state = 'processing'
             AND m.space_id NOT LIKE 'direct:%'"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    space_ids.extend(in_flight);

    let mut conversation_ids = Vec::new();
    for space_id in space_ids {
        let rows: Vec<String> = sqlx::query_scalar(
            r#"SELECT conversation_id
               FROM collaboration_thread_members
               WHERE thread_id = ? AND status = 'active'"#,
        )
        .bind(&space_id)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        for raw in rows {
            if let Ok(id) = Uuid::parse_str(raw.trim()) {
                conversation_ids.push(id);
            }
        }
    }
    Ok(conversation_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::{add_space_member, now_stamp, test_support::*};

    #[tokio::test]
    async fn recent_user_message_keeps_group_member_sessions_hot() {
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
        let tracker = HotGroupTracker::default();
        let before = tracker.hot_member_sessions(&pool).await;
        assert!(!before.contains(&AgentSessionId(a)));
        assert!(!before.contains(&AgentSessionId(b)));

        post_as(&pool, None, &space, "开工", &[]).await;
        let hot = tracker.hot_member_sessions(&pool).await;
        assert!(hot.contains(&AgentSessionId(a)));
        assert!(hot.contains(&AgentSessionId(b)));
    }

    #[tokio::test]
    async fn group_goes_cold_when_user_messages_age_out_and_nothing_is_in_flight() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        post_as(&pool, None, &space, "开工", &[]).await;
        sqlx::query("UPDATE collaboration_space_messages SET created_at = '2000-01-01T00:00:00Z'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE collaboration_space_deliveries SET receipt_state = 'replied'")
            .execute(&pool)
            .await
            .unwrap();
        let tracker = HotGroupTracker::default();
        let hot = tracker.hot_member_sessions(&pool).await;
        assert!(!hot.contains(&AgentSessionId(a)));
    }

    #[tokio::test]
    async fn in_flight_delivery_keeps_group_hot_even_when_messages_are_old() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        post_as(&pool, None, &space, "开工", &[]).await;
        sqlx::query("UPDATE collaboration_space_messages SET created_at = '2000-01-01T00:00:00Z'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE collaboration_space_deliveries SET receipt_state = 'processing'")
            .execute(&pool)
            .await
            .unwrap();
        let tracker = HotGroupTracker::default();
        let hot = tracker.hot_member_sessions(&pool).await;
        assert!(hot.contains(&AgentSessionId(a)));
    }

    #[tokio::test]
    async fn warmup_marks_group_hot_until_the_window_elapses() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let tracker = HotGroupTracker::default();
        tracker.mark_hot(&space);
        assert!(
            tracker
                .hot_member_sessions(&pool)
                .await
                .contains(&AgentSessionId(a))
        );
        tracker.mark_hot_until(&space, Instant::now() - std::time::Duration::from_secs(1));
        assert!(
            !tracker
                .hot_member_sessions(&pool)
                .await
                .contains(&AgentSessionId(a))
        );
    }

    #[tokio::test]
    async fn direct_threads_are_never_hot() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let group_conv = Uuid::new_v4();
        let dm_conv = Uuid::new_v4();
        create_session(&pool, group_conv, workspace, Some("小A")).await;
        create_session(&pool, dm_conv, workspace, Some("小A私聊")).await;
        let space = space_of(&pool, group_conv).await;
        post_as(&pool, None, &space, "群里说话", &[]).await;

        let dm = format!("direct:{dm_conv}");
        sqlx::query(
            r#"INSERT INTO collaboration_threads (id, kind, title, workspace_id, created_at)
               VALUES (?, 'direct', 'dm', ?, ?)"#,
        )
        .bind(&dm)
        .bind(workspace.to_string())
        .bind(now_stamp())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO collaboration_thread_members
               (thread_id, member_id, conversation_id, status, joined_at)
               VALUES (?, ?, ?, 'active', ?)"#,
        )
        .bind(&dm)
        .bind(dm_conv.to_string())
        .bind(dm_conv.to_string())
        .bind(now_stamp())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO collaboration_space_messages
               (id, space_id, seq, envelope_json, created_at, origin)
               VALUES (?, ?, 1, '{}', ?, 'user')"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&dm)
        .bind(now_stamp())
        .execute(&pool)
        .await
        .unwrap();
        let tracker = HotGroupTracker::default();
        tracker.mark_hot(&dm);
        let hot = tracker.hot_member_sessions(&pool).await;
        assert!(hot.contains(&AgentSessionId(group_conv)));
        assert!(!hot.contains(&AgentSessionId(dm_conv)));
    }
}
