use chrono::{Duration, Utc};
use db::models::collaboration_identity::{self as identity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CollaborationSpaceChangedEvent {
    pub workspace_id: Uuid,
    pub space_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub generation: Option<i64>,
}

pub fn space_tracks_events(space_id: &str) -> bool {
    let trimmed = space_id.trim();
    !trimmed.is_empty()
        && parse_unassigned_space_id(trimmed).is_none()
        && !trimmed.starts_with("session:")
}

pub(crate) async fn append_space_event_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    kind: &str,
    message_id: Option<&str>,
    payload: &Value,
    created_at: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let trimmed = space_id.trim();
    if !space_tracks_events(trimmed) {
        return Ok(None);
    }
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_events WHERE space_id = ?",
    )
    .bind(trimmed)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        r#"INSERT INTO collaboration_space_events
           (space_id, seq, kind, message_id, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)"#,
    )
    .bind(trimmed)
    .bind(seq)
    .bind(kind)
    .bind(message_id)
    .bind(payload.to_string())
    .bind(created_at)
    .execute(&mut *conn)
    .await?;
    Ok(Some(seq))
}

pub(crate) async fn append_space_event(
    pool: &SqlitePool,
    space_id: &str,
    kind: &str,
    message_id: Option<&str>,
    payload: &Value,
) -> Result<Option<i64>, CollaborationError> {
    if !space_tracks_events(space_id) {
        return Ok(None);
    }
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = append_space_event_tx(&mut conn, space_id, kind, message_id, payload, &stamp)
        .await
        .map_err(db);
    finish_tx(&mut conn, outcome).await
}

pub(crate) use append_space_event as append_space_event_pool;

pub(crate) async fn load_space_generation_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
) -> Result<i64, sqlx::Error> {
    let trimmed = space_id.trim();
    if trimmed.starts_with(identity::DIRECT_PREFIX) {
        let generation: Option<i64> =
            sqlx::query_scalar("SELECT generation FROM collaboration_threads WHERE id = ?")
                .bind(trimmed)
                .fetch_optional(&mut *conn)
                .await?;
        Ok(generation.unwrap_or(1).max(1))
    } else {
        let generation: Option<i64> =
            sqlx::query_scalar("SELECT generation FROM collaboration_spaces WHERE id = ?")
                .bind(trimmed)
                .fetch_optional(&mut *conn)
                .await?;
        Ok(generation.unwrap_or(1).max(1))
    }
}

pub async fn load_space_generation(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db)?;
    load_space_generation_tx(&mut conn, space_id)
        .await
        .map_err(db)
}

pub(crate) async fn bump_space_generation_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
) -> Result<i64, sqlx::Error> {
    let trimmed = space_id.trim();
    if trimmed.starts_with(identity::DIRECT_PREFIX) {
        sqlx::query(
            "UPDATE collaboration_threads SET generation = COALESCE(generation, 1) + 1 WHERE id = ?",
        )
        .bind(trimmed)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE collaboration_spaces SET generation = COALESCE(generation, 1) + 1 WHERE id = ?",
        )
        .bind(trimmed)
        .execute(&mut *conn)
        .await?;
    }
    load_space_generation_tx(conn, trimmed).await
}

pub async fn bump_space_generation(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = bump_space_generation_tx(&mut conn, space_id)
        .await
        .map_err(db);
    finish_tx(&mut conn, outcome).await
}

pub async fn restore_space_from_archive(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    let stamp = now_stamp();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let generation = bump_space_generation_tx(&mut conn, space_id).await?;
        append_space_event_tx(
            &mut conn,
            space_id,
            "space",
            None,
            &json!({ "action": "restored", "generation": generation }),
            &stamp,
        )
        .await?;
        Ok(generation)
    }
    .await;
    finish_tx(&mut conn, outcome).await
}

pub async fn latest_space_changed_event(
    pool: &SqlitePool,
    workspace_id: Uuid,
    space_id: &str,
    member_id: Option<String>,
) -> CollaborationSpaceChangedEvent {
    let trimmed = space_id.trim();
    if !space_tracks_events(trimmed) {
        return CollaborationSpaceChangedEvent {
            workspace_id,
            space_id: space_id.to_string(),
            seq: None,
            member_id,
            kind: None,
            generation: None,
        };
    }
    let latest: Option<(i64, String)> = sqlx::query_as(
        r#"SELECT seq, kind
           FROM collaboration_space_events
           WHERE space_id = ?
           ORDER BY seq DESC
           LIMIT 1"#,
    )
    .bind(trimmed)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let generation = load_space_generation(pool, trimmed).await.unwrap_or(1);
    let (seq, kind) = match latest {
        Some((seq, kind)) => (Some(seq), Some(kind)),
        None => (Some(0), None),
    };
    CollaborationSpaceChangedEvent {
        workspace_id,
        space_id: space_id.to_string(),
        seq,
        member_id,
        kind,
        generation: Some(generation),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceEventRecord {
    pub space_id: String,
    pub seq: i64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceEventList {
    pub space_id: String,
    pub generation: i64,
    pub events: Vec<SpaceEventRecord>,
    pub next_seq: i64,
    #[serde(default, skip_serializing_if = "super::is_false")]
    pub reset: bool,
}

pub async fn list_space_events(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    after_seq: Option<i64>,
    limit: Option<i64>,
) -> Result<SpaceEventList, CollaborationError> {
    let space_id = space_id.trim();
    if space_id.is_empty() || !space_tracks_events(space_id) {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    if space_id.starts_with(identity::DIRECT_PREFIX) {
        load_space_or_unassigned(pool, space_id).await?;
        if let Some(caller_id) = caller_id
            && direct_thread_caller_seat(pool, space_id, caller_id)
                .await?
                .is_none()
        {
            return Err(CollaborationError::new(
                "not_a_member",
                "caller is not a member of this space",
            ));
        }
    } else {
        load_space(pool, space_id).await?;
        if let Some(caller_id) = caller_id {
            let _ = caller_seat(pool, space_id, caller_id).await?;
        }
    }

    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let (min_seq, max_seq): (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT MIN(seq), MAX(seq) FROM collaboration_space_events WHERE space_id = ?",
    )
    .bind(space_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;

    if let Some(after) = after_seq {
        let pruned =
            min_seq.is_some_and(|min| min > 1 && after < min) || (max_seq.is_none() && after > 0);
        if pruned {
            let generation = bump_space_generation(pool, space_id).await?;
            return Ok(SpaceEventList {
                space_id: space_id.to_string(),
                generation,
                events: Vec::new(),
                next_seq: max_seq.unwrap_or(0),
                reset: true,
            });
        }
        let generation = load_space_generation(pool, space_id).await?;
        let rows = sqlx::query_as::<_, (i64, String, Option<String>, String, String)>(
            r#"SELECT seq, kind, message_id, payload_json, created_at
               FROM collaboration_space_events
               WHERE space_id = ? AND seq > ?
               ORDER BY seq ASC
               LIMIT ?"#,
        )
        .bind(space_id)
        .bind(after)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        let events: Vec<SpaceEventRecord> = rows
            .into_iter()
            .map(
                |(seq, kind, message_id, payload_json, created_at)| SpaceEventRecord {
                    space_id: space_id.to_string(),
                    seq,
                    kind,
                    message_id,
                    payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({})),
                    created_at,
                },
            )
            .collect();
        let next_seq = events.last().map(|e| e.seq).unwrap_or(after);
        return Ok(SpaceEventList {
            space_id: space_id.to_string(),
            generation,
            events,
            next_seq,
            reset: false,
        });
    }

    let generation = load_space_generation(pool, space_id).await?;
    let mut rows = sqlx::query_as::<_, (i64, String, Option<String>, String, String)>(
        r#"SELECT seq, kind, message_id, payload_json, created_at
           FROM collaboration_space_events
           WHERE space_id = ?
           ORDER BY seq DESC
           LIMIT ?"#,
    )
    .bind(space_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    rows.reverse();
    let events: Vec<SpaceEventRecord> = rows
        .into_iter()
        .map(
            |(seq, kind, message_id, payload_json, created_at)| SpaceEventRecord {
                space_id: space_id.to_string(),
                seq,
                kind,
                message_id,
                payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({})),
                created_at,
            },
        )
        .collect();
    let next_seq = events
        .last()
        .map(|e| e.seq)
        .unwrap_or_else(|| max_seq.unwrap_or(0));
    Ok(SpaceEventList {
        space_id: space_id.to_string(),
        generation,
        events,
        next_seq,
        reset: false,
    })
}

pub fn space_event_retention_days() -> i64 {
    env_i64("VIBEX_COLLAB_EVENT_RETENTION_DAYS", 7).max(1)
}

pub async fn sweep_expired_space_events(pool: &SqlitePool) -> Result<u32, CollaborationError> {
    let cutoff = stamp(Utc::now() - Duration::days(space_event_retention_days()));
    sweep_expired_space_events_before(pool, &cutoff).await
}

pub async fn sweep_expired_space_events_before(
    pool: &SqlitePool,
    cutoff: &str,
) -> Result<u32, CollaborationError> {
    let result = sqlx::query("DELETE FROM collaboration_space_events WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await
        .map_err(db)?;
    Ok(u32::try_from(result.rows_affected()).unwrap_or(u32::MAX))
}

pub async fn space_workspace_id(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Uuid, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    Uuid::parse_str(&space.workspace_id)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}
