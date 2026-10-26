use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use super::{CollaborationError, db, load_space_or_unassigned, now_stamp};

pub const SPACE_REACTION_USER_ACTOR: &str = "user";
const EMOJI_MAX_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpaceReaction {
    pub emoji: String,
    pub actor: String,
}

pub fn canonical_space_message_id(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("vibex://space-message/")
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

fn require_emoji(raw: &str) -> Result<String, CollaborationError> {
    let emoji = raw.trim().to_string();
    if emoji.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "emoji is required",
        ));
    }
    if emoji.len() > EMOJI_MAX_BYTES {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "emoji is too long",
        ));
    }
    Ok(emoji)
}

fn require_actor(raw: &str) -> Result<String, CollaborationError> {
    let actor = raw.trim().to_string();
    if actor.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "actor is required",
        ));
    }
    Ok(actor)
}

/// Toggle the actor's emoji on a message: same emoji removes it, a different
/// emoji replaces it. One emoji per actor.
pub async fn toggle_space_reaction(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    actor: &str,
    emoji: &str,
) -> Result<Vec<SpaceReaction>, CollaborationError> {
    load_space_or_unassigned(pool, space_id).await?;
    let message_id = canonical_space_message_id(message_id);
    if message_id.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "messageId is required",
        ));
    }
    let actor = require_actor(actor)?;
    let emoji = require_emoji(emoji)?;
    let existing: Option<String> = sqlx::query_scalar(
        r#"SELECT emoji FROM collaboration_message_reactions
           WHERE space_id = ? AND message_id = ? AND actor = ?"#,
    )
    .bind(space_id)
    .bind(&message_id)
    .bind(&actor)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    if existing.as_deref() == Some(emoji.as_str()) {
        sqlx::query(
            r#"DELETE FROM collaboration_message_reactions
               WHERE space_id = ? AND message_id = ? AND actor = ?"#,
        )
        .bind(space_id)
        .bind(&message_id)
        .bind(&actor)
        .execute(pool)
        .await
        .map_err(db)?;
    } else {
        sqlx::query(
            r#"INSERT INTO collaboration_message_reactions
               (space_id, message_id, actor, emoji, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(space_id, message_id, actor)
               DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at"#,
        )
        .bind(space_id)
        .bind(&message_id)
        .bind(&actor)
        .bind(&emoji)
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db)?;
    }
    list_space_reactions(pool, space_id, &message_id).await
}

pub async fn list_space_reactions(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
) -> Result<Vec<SpaceReaction>, CollaborationError> {
    let message_id = canonical_space_message_id(message_id);
    sqlx::query_as::<_, (String, String)>(
        r#"SELECT emoji, actor FROM collaboration_message_reactions
           WHERE space_id = ? AND message_id = ?
           ORDER BY created_at ASC, actor ASC"#,
    )
    .bind(space_id)
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)
    .map(|rows| {
        rows.into_iter()
            .map(|(emoji, actor)| SpaceReaction { emoji, actor })
            .collect()
    })
}

pub async fn list_space_reactions_batch(
    pool: &SqlitePool,
    space_id: &str,
    message_ids: &[String],
) -> Result<HashMap<String, Vec<SpaceReaction>>, CollaborationError> {
    let mut grouped: HashMap<String, Vec<SpaceReaction>> =
        HashMap::with_capacity(message_ids.len());
    for id in message_ids {
        grouped.entry(canonical_space_message_id(id)).or_default();
    }
    if grouped.is_empty() {
        return Ok(grouped);
    }
    let ids: Vec<String> = grouped.keys().cloned().collect();
    for chunk in ids.chunks(500) {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT message_id, emoji, actor FROM collaboration_message_reactions
               WHERE space_id = "#,
        );
        builder.push_bind(space_id);
        builder.push(" AND message_id IN (");
        let mut separated = builder.separated(", ");
        for id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(") ORDER BY created_at ASC, actor ASC");
        let rows = builder
            .build_query_as::<(String, String, String)>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        for (message_id, emoji, actor) in rows {
            grouped
                .entry(message_id)
                .or_default()
                .push(SpaceReaction { emoji, actor });
        }
    }
    Ok(grouped)
}

pub async fn attach_reactions_to_json_messages(
    pool: &SqlitePool,
    space_id: &str,
    messages: &mut [Value],
) -> Result<(), CollaborationError> {
    if messages.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = messages
        .iter()
        .filter_map(|message| {
            message
                .get("id")
                .and_then(Value::as_str)
                .map(canonical_space_message_id)
                .filter(|id| !id.is_empty())
        })
        .collect();
    let grouped = list_space_reactions_batch(pool, space_id, &ids).await?;
    for message in messages.iter_mut() {
        let Some(id) = message
            .get("id")
            .and_then(Value::as_str)
            .map(canonical_space_message_id)
        else {
            continue;
        };
        if let Some(reactions) = grouped.get(&id)
            && !reactions.is_empty()
            && let Some(envelope) = message.get_mut("envelope")
        {
            envelope["reactions"] = json!(reactions);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::collaboration::{
        MessageAudience, list_space_messages,
        test_support::{create_session, post_as, setup_pool, space_of},
    };

    #[tokio::test]
    async fn toggle_space_reaction_replaces_then_clears_the_actor_emoji() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), Some("小A")).await;
        let space = space_of(&pool, caller).await;
        let posted = post_as(&pool, None, &space, "你好", &["User"]).await;

        let first = toggle_space_reaction(&pool, &space, &posted.message_id, "user", "👍")
            .await
            .unwrap();
        assert_eq!(
            first,
            vec![SpaceReaction {
                emoji: "👍".into(),
                actor: "user".into(),
            }]
        );

        let replaced = toggle_space_reaction(
            &pool,
            &space,
            &format!("vibex://space-message/{}", posted.message_id),
            "user",
            "🎉",
        )
        .await
        .unwrap();
        assert_eq!(
            replaced,
            vec![SpaceReaction {
                emoji: "🎉".into(),
                actor: "user".into(),
            }]
        );

        let listed = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert_eq!(listed[0].envelope["reactions"][0]["emoji"], json!("🎉"));
        assert_eq!(listed[0].envelope["reactions"][0]["actor"], json!("user"));

        let cleared = toggle_space_reaction(&pool, &space, &posted.message_id, "user", "🎉")
            .await
            .unwrap();
        assert!(cleared.is_empty());
        let listed = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert!(listed[0].envelope.get("reactions").is_none());
    }

    #[tokio::test]
    async fn empty_emoji_is_rejected() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), Some("小A")).await;
        let space = space_of(&pool, caller).await;
        let posted = post_as(&pool, None, &space, "你好", &["User"]).await;
        let err = toggle_space_reaction(&pool, &space, &posted.message_id, "user", "   ")
            .await
            .unwrap_err();
        assert_eq!(err.code, "conversation_control_failed");
    }
}
