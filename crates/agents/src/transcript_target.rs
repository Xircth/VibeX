//! Explicit product-history destinations. Native session IDs are never file identity.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, RwLock},
};

use crate::{
    AgentConnectionId,
    acp_transcript::{self, EntryKind},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptTarget {
    pub root: PathBuf,
    pub directory: String,
    pub session_id: String,
}

static TARGETS: LazyLock<RwLock<HashMap<AgentConnectionId, Option<TranscriptTarget>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

pub fn bind(connection: AgentConnectionId, target: TranscriptTarget) {
    TARGETS
        .write()
        .expect("transcript target lock")
        .insert(connection, Some(target));
}

pub fn release(connection: AgentConnectionId) {
    TARGETS
        .write()
        .expect("transcript target lock")
        .insert(connection, None);
}

/// Retire under the same lock as enqueueing so a subsequent flush is a barrier.
/// Keep the connection tombstone for delayed runtime envelopes from this host.
pub fn retire_target(target: &TranscriptTarget) {
    let mut targets = TARGETS.write().expect("transcript target lock");
    for destination in targets.values_mut() {
        if destination.as_ref() == Some(target) {
            *destination = None;
        }
    }
}

pub fn is_bound(connection: AgentConnectionId) -> bool {
    TARGETS
        .read()
        .expect("transcript target lock")
        .get(&connection)
        .is_some_and(Option::is_some)
}

pub fn is_retired(connection: AgentConnectionId) -> bool {
    TARGETS
        .read()
        .expect("transcript target lock")
        .get(&connection)
        .is_some_and(Option::is_none)
}

fn rejected_write() -> tokio::sync::oneshot::Receiver<()> {
    let (_, receiver) = tokio::sync::oneshot::channel();
    receiver
}

pub fn record_entry(
    connection: AgentConnectionId,
    native_directory: &str,
    native_session: &str,
    kind: EntryKind,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    let targets = TARGETS.read().expect("transcript target lock");
    match targets.get(&connection) {
        Some(Some(target)) => acp_transcript::record_entry_in(
            &target.root,
            &target.directory,
            &target.session_id,
            kind,
            payload,
        ),
        Some(None) => rejected_write(),
        None => acp_transcript::record_entry(native_directory, native_session, kind, payload),
    }
}

pub fn record_steer(
    connection: AgentConnectionId,
    native_directory: &str,
    native_session: &str,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    let targets = TARGETS.read().expect("transcript target lock");
    match targets.get(&connection) {
        Some(Some(target)) => acp_transcript::record_steer_in(
            &target.root,
            &target.directory,
            &target.session_id,
            payload,
        ),
        Some(None) => rejected_write(),
        None => acp_transcript::record_steer(native_directory, native_session, payload),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn retired_writer_cannot_change_the_checkpoint_or_fall_back_to_native() {
        let root = tempfile::tempdir().unwrap();
        let connection = AgentConnectionId::new();
        let target = TranscriptTarget {
            root: root.path().to_path_buf(),
            directory: "history".into(),
            session_id: "segment".into(),
        };
        let header = acp_transcript::TranscriptHeader::new("codex", "segment", "", 0);
        acp_transcript::record_header_in(&target.root, &target.directory, &header)
            .await
            .unwrap();
        bind(connection, target.clone());
        record_entry(
            connection,
            "codex",
            "native",
            EntryKind::Prompt,
            json!([{ "type": "text", "text": "question" }]),
        )
        .await
        .unwrap();
        record_steer(
            connection,
            "codex",
            "native",
            json!([{ "type": "text", "text": "steering" }]),
        )
        .await
        .unwrap();
        record_entry(
            connection,
            "codex",
            "native",
            EntryKind::TurnEnd,
            json!({ "stopReason": "end_turn" }),
        )
        .await
        .unwrap();
        release(connection);
        acp_transcript::flush_in(&target.root, &target.directory, &target.session_id)
            .await
            .unwrap();
        let path =
            acp_transcript::transcript_path_in(&target.root, &target.directory, &target.session_id)
                .unwrap();
        let checkpoint = std::fs::read(&path).unwrap();
        assert!(
            record_entry(connection, "codex", "native", EntryKind::Update, json!({}))
                .await
                .is_err()
        );
        assert!(
            record_steer(connection, "codex", "native", json!([]))
                .await
                .is_err()
        );
        acp_transcript::flush_in(&target.root, &target.directory, &target.session_id)
            .await
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), checkpoint);
    }
}
