//! Conversation-owned transcript files, ordered explicitly in SQLite metadata.
use std::{io::Write, path::Path, time::Duration};

use agents::{
    AgentId, AgentKind,
    acp_transcript::{self, TranscriptEntry, TranscriptHeader},
    conversation::MessageTurn,
    transcript_target::TranscriptTarget,
};
use db::models::conversation_transcript::ConversationTranscriptSegment as Segment;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

fn io_error(error: impl std::fmt::Display) -> sqlx::Error {
    sqlx::Error::Protocol(format!("conversation transcript: {error}"))
}

pub fn target(root: &Path, conversation_id: Uuid, segment_id: Uuid) -> TranscriptTarget {
    TranscriptTarget {
        root: root.join("conversations"),
        directory: conversation_id.simple().to_string(),
        session_id: segment_id.simple().to_string(),
    }
}

fn path(target: &TranscriptTarget) -> std::path::PathBuf {
    acp_transcript::transcript_path_in(&target.root, &target.directory, &target.session_id)
        .expect("UUID transcript components")
}

async fn flush(target: &TranscriptTarget) -> Result<(), sqlx::Error> {
    tokio::time::timeout(
        Duration::from_secs(5),
        acp_transcript::flush_in(&target.root, &target.directory, &target.session_id),
    )
    .await
    .map_err(io_error)?
    .map_err(io_error)
}

// An interrupted append may end inside UTF-8 or JSON. Only complete lines
// belong to an active checkpoint; sealed files must match every byte.
fn complete_prefix(bytes: &[u8]) -> &[u8] {
    if bytes.ends_with(b"\n") {
        bytes
    } else {
        &bytes[..bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1)]
    }
}

fn repair_active_tail(destination: &TranscriptTarget) -> Result<(), sqlx::Error> {
    let file_path = path(destination);
    let bytes = std::fs::read(&file_path).map_err(io_error)?;
    let length = complete_prefix(&bytes).len();
    if length != bytes.len() {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(file_path)
            .map_err(io_error)?;
        file.set_len(length as u64).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
    }
    Ok(())
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Create and sync an unreferenced immutable snapshot before publishing its metadata.
fn snapshot_file(
    target: &TranscriptTarget,
    agent: &str,
    turns: &[MessageTurn],
) -> Result<(i64, String), sqlx::Error> {
    let file_path = path(target);
    std::fs::create_dir_all(file_path.parent().expect("transcript parent")).map_err(io_error)?;
    let header = TranscriptHeader::new(
        agent,
        &target.session_id,
        "",
        acp_transcript::now_epoch_ms(),
    );
    let mut content = serde_json::to_vec(&header).map_err(io_error)?;
    content.push(b'\n');
    for turn in turns {
        serde_json::to_writer(
            &mut content,
            &serde_json::json!({"v": 1, "kind": "message_turn", "turn": turn}),
        )
        .map_err(io_error)?;
        content.push(b'\n');
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file_path)
        .map_err(io_error)?;
    file.write_all(&content).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    Ok((content.len() as i64, fingerprint(&content)))
}

pub async fn import_snapshot_in(
    pool: &SqlitePool,
    root: &Path,
    conversation_id: Uuid,
    agent: &str,
    turns: &[MessageTurn],
) -> Result<(), sqlx::Error> {
    if turns.is_empty() {
        return Ok(());
    }
    let id = Uuid::new_v4();
    let (length, digest) = snapshot_file(&target(root, conversation_id, id), agent, turns)?;
    Segment::publish(pool, conversation_id, id, None, Some((length, &digest))).await?;
    Ok(())
}

pub async fn open_in(
    pool: &SqlitePool,
    root: &Path,
    conversation_id: Uuid,
    binding_id: Uuid,
    agent: &AgentId,
    working_dir: &str,
) -> Result<TranscriptTarget, sqlx::Error> {
    let segments = Segment::list(pool, conversation_id).await?;
    if let Some(active) = segments.iter().find(|s| s.state == "active") {
        if active.binding_id == Some(binding_id) {
            let destination = target(root, conversation_id, active.id);
            flush(&destination).await?;
            repair_active_tail(&destination)?;
            return Ok(destination);
        }
        seal_in(pool, root, conversation_id).await?;
    }
    let id = Uuid::new_v4();
    let destination = target(root, conversation_id, id);
    let header = TranscriptHeader::new(
        agent.as_str(),
        &destination.session_id,
        working_dir,
        acp_transcript::now_epoch_ms(),
    );
    tokio::time::timeout(
        Duration::from_secs(5),
        acp_transcript::record_header_in(&destination.root, &destination.directory, &header),
    )
    .await
    .map_err(io_error)?
    .map_err(io_error)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(path(&destination))
        .map_err(io_error)?
        .sync_all()
        .map_err(io_error)?;
    Segment::publish(pool, conversation_id, id, Some(binding_id), None).await?;
    Ok(destination)
}

pub async fn seal_in(
    pool: &SqlitePool,
    root: &Path,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    for segment in Segment::list(pool, conversation_id)
        .await?
        .iter()
        .filter(|s| s.state == "active")
    {
        let destination = target(root, conversation_id, segment.id);
        agents::transcript_target::retire_target(&destination);
        flush(&destination).await?;
        repair_active_tail(&destination)?;
        let file_path = path(&destination);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&file_path)
            .map_err(io_error)?
            .sync_all()
            .map_err(io_error)?;
        let bytes = std::fs::read(file_path).map_err(io_error)?;
        Segment::seal(pool, segment.id, bytes.len() as i64, &fingerprint(&bytes)).await?;
    }
    Ok(())
}

pub async fn read_in(
    pool: &SqlitePool,
    root: &Path,
    conversation_id: Uuid,
) -> Result<Option<Vec<MessageTurn>>, sqlx::Error> {
    let segments = Segment::list(pool, conversation_id).await?;
    read_segments(root, conversation_id, segments).await
}

pub async fn read_on_connection(
    conn: &mut sqlx::SqliteConnection,
    root: &Path,
    conversation_id: Uuid,
) -> Result<Option<Vec<MessageTurn>>, sqlx::Error> {
    let segments = Segment::list_on_connection(conn, conversation_id).await?;
    read_segments(root, conversation_id, segments).await
}

async fn read_segments(
    root: &Path,
    conversation_id: Uuid,
    segments: Vec<Segment>,
) -> Result<Option<Vec<MessageTurn>>, sqlx::Error> {
    if segments.is_empty() {
        return Ok(None);
    }
    let mut result = Vec::new();
    for segment in segments {
        let destination = target(root, conversation_id, segment.id);
        if segment.state == "active" {
            flush(&destination).await?;
        }
        let bytes = std::fs::read(path(&destination)).map_err(io_error)?;
        if segment.state == "sealed"
            && (segment.sealed_length != Some(bytes.len() as i64)
                || segment.digest.as_deref() != Some(fingerprint(&bytes).as_str()))
        {
            return Err(io_error(format!("sealed segment {} changed", segment.id)));
        }
        let readable = if segment.state == "active" {
            complete_prefix(&bytes)
        } else {
            &bytes
        };
        let text = std::str::from_utf8(readable).map_err(io_error)?;
        let mut lines = text.lines();
        let header: TranscriptHeader =
            serde_json::from_str(lines.next().ok_or_else(|| io_error("missing header"))?)
                .map_err(io_error)?;
        if header.v != acp_transcript::TRANSCRIPT_SCHEMA_VERSION
            || header.kind != "header"
            || header.session_id != destination.session_id
        {
            return Err(io_error("unsupported or mismatched segment header"));
        }
        let mut entries = Vec::new();
        let mut snapshots = Vec::new();
        for line in lines.filter(|line| !line.is_empty()) {
            let record: serde_json::Value = serde_json::from_str(line).map_err(io_error)?;
            if record.get("kind").and_then(|kind| kind.as_str()) == Some("message_turn") {
                if segment.state != "sealed" || record.get("v").and_then(|v| v.as_u64()) != Some(1)
                {
                    return Err(io_error("unsupported snapshot record"));
                }
                snapshots.push(
                    serde_json::from_value::<MessageTurn>(record["turn"].clone())
                        .map_err(io_error)?,
                );
            } else {
                entries.push(serde_json::from_value::<TranscriptEntry>(record).map_err(io_error)?);
            }
        }
        if !snapshots.is_empty() && !entries.is_empty() {
            return Err(io_error("mixed snapshot and wire records"));
        }
        let mut turns = if snapshots.is_empty() {
            agents::parsers::acp_native::project_turns_for(
                &entries,
                AgentKind::from_lenient(&header.agent),
            )
        } else {
            snapshots
        };
        for turn in &mut turns {
            turn.id = format!("segment:{}:{}", segment.id.simple(), turn.id);
        }
        result.extend(turns);
    }
    Ok(Some(result))
}

/// Rewrites publish a new file, never mutate a sealed source or a fork's files.
pub async fn replace_snapshot_in(
    pool: &SqlitePool,
    root: &Path,
    conversation_id: Uuid,
    agent: &str,
    turns: &[MessageTurn],
) -> Result<(), sqlx::Error> {
    seal_in(pool, root, conversation_id).await?;
    let id = Uuid::new_v4();
    let (length, digest) = snapshot_file(&target(root, conversation_id, id), agent, turns)?;
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM conversation_transcript_segments WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO conversation_transcript_segments (id, conversation_id, ordinal, state, sealed_length, digest) VALUES (?, ?, 1, 'sealed', ?, ?)")
        .bind(id).bind(conversation_id).bind(length).bind(digest).execute(&mut *tx).await?;
    sqlx::query("UPDATE sessions SET history_revision = history_revision + 1 WHERE id = ?")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use agents::{
        AgentId,
        acp_transcript::{self, EntryKind, TranscriptHeader},
    };
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_transcript::ConversationTranscriptSegment,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    #[tokio::test]
    async fn ordered_segments_ignore_native_directory_and_detect_sealed_corruption() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .in_memory(true)
                    .foreign_keys(false),
            )
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        let id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let agent = AgentId::parse("codex").unwrap();
        let first = super::open_in(&pool, root.path(), id, Uuid::new_v4(), &agent, "")
            .await
            .unwrap();
        acp_transcript::record_entry_in(
            &first.root,
            &first.directory,
            &first.session_id,
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"first question"}]),
        )
        .await
        .unwrap();
        acp_transcript::record_entry_in(
            &first.root,
            &first.directory,
            &first.session_id,
            EntryKind::TurnEnd,
            serde_json::json!({"stopReason":"end_turn"}),
        )
        .await
        .unwrap();
        super::seal_in(&pool, root.path(), id).await.unwrap();
        let second = super::open_in(&pool, root.path(), id, Uuid::new_v4(), &agent, "")
            .await
            .unwrap();
        acp_transcript::record_entry_in(
            &second.root,
            &second.directory,
            &second.session_id,
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"second question"}]),
        )
        .await
        .unwrap();
        // A conflicting native transcript must never replace the manifest history.
        let header = TranscriptHeader::new("codex", &id.simple().to_string(), "", 0);
        acp_transcript::record_header_in(root.path(), "codex", &header)
            .await
            .unwrap();
        let turns = super::read_in(&pool, root.path(), id)
            .await
            .unwrap()
            .unwrap();
        let text: Vec<_> = turns
            .iter()
            .flat_map(|t| &t.blocks)
            .filter_map(|b| match b {
                agents::conversation::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, ["first question", "second question"]);
        assert_ne!(
            turns[0].id, turns[1].id,
            "item IDs must be qualified by segment"
        );
        assert_eq!(
            ConversationTranscriptSegment::list(&pool, id)
                .await
                .unwrap()
                .len(),
            2
        );
        // A damaged sealed segment is an error, never silently replaced by vendor history.
        let path =
            acp_transcript::transcript_path_in(&first.root, &first.directory, &first.session_id)
                .unwrap();
        std::fs::write(path, "corrupt").unwrap();
        assert!(super::read_in(&pool, root.path(), id).await.is_err());
    }
}

#[cfg(test)]
#[path = "transcript_segments_tests.rs"]
mod lifecycle_tests;
