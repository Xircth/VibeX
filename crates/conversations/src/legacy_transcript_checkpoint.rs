//! Strict validation at the one-time legacy history authority boundary.
use std::{collections::BTreeSet, path::Path, time::Duration};

use agents::{
    AgentKind,
    acp_transcript::{self, TranscriptEntry, TranscriptHeader},
    conversation::MessageTurn,
};
use db::models::conversation::{ConversationAgentBindingRecord, DbConversationSummary};
use sqlx::SqlitePool;

fn error(error: impl std::fmt::Display) -> sqlx::Error {
    sqlx::Error::Protocol(format!("legacy transcript checkpoint: {error}"))
}

pub async fn validate_sources(
    pool: &SqlitePool,
    root: &Path,
    summary: &DbConversationSummary,
) -> Result<Vec<Vec<MessageTurn>>, sqlx::Error> {
    let bindings = ConversationAgentBindingRecord::list_for_conversation(pool, summary.id).await?;
    let mut identities = BTreeSet::new();
    let mut add = |agent: &str, native: Option<&str>| {
        let directory = if acp_transcript::safe_component(agent) {
            agent
        } else {
            "session"
        };
        for id in [
            Some(summary.id.simple().to_string()),
            Some(summary.id.to_string()),
            native.map(str::to_string),
        ]
        .into_iter()
        .flatten()
        {
            if acp_transcript::safe_component(&id) {
                identities.insert((directory.to_string(), id));
            }
        }
    };
    if let Some(agent) = &summary.agent_id {
        add(agent.as_str(), summary.external_session_id.as_deref());
    }
    for binding in &bindings {
        add(binding.agent_id.as_str(), binding.acp_session_id.as_deref());
    }
    if summary.agent_id.is_none() && bindings.is_empty() {
        add("session", summary.external_session_id.as_deref());
    }

    // The legacy reader can fall back across Agent directories. Validate the
    // same candidate set before allowing it to choose any product authority.
    let session_ids: BTreeSet<_> = identities.iter().map(|(_, id)| id.clone()).collect();
    match std::fs::read_dir(root) {
        Ok(directories) => {
            for entry in directories {
                let entry = entry.map_err(error)?;
                if !entry.file_type().map_err(error)?.is_dir() {
                    continue;
                }
                let Some(directory) = entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if !acp_transcript::safe_component(&directory) {
                    continue;
                }
                for id in &session_ids {
                    identities.insert((directory.clone(), id.clone()));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(error(e)),
    }

    let mut histories = Vec::new();
    let mut pending: Vec<_> = identities
        .iter()
        .cloned()
        .map(|(directory, id)| (directory, id, false))
        .collect();
    let mut visited = BTreeSet::new();
    let mut parents = std::collections::HashMap::new();
    while let Some((directory, id, required)) = pending.pop() {
        if visited.contains(&(directory.clone(), id.clone())) {
            continue;
        }
        tokio::time::timeout(
            Duration::from_secs(5),
            acp_transcript::flush_in(root, &directory, &id),
        )
        .await
        .map_err(error)?
        .map_err(error)?;
        let path = acp_transcript::transcript_path_in(root, &directory, &id)
            .ok_or_else(|| error("unsafe source identity"))?;
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !required => continue,
            Err(e) => return Err(error(e)),
        };
        visited.insert((directory.clone(), id.clone()));
        let text = std::str::from_utf8(&bytes).map_err(error)?;
        let mut lines = text.lines();
        let header: TranscriptHeader =
            serde_json::from_str(lines.next().ok_or_else(|| error("missing legacy header"))?)
                .map_err(error)?;
        if header.v != acp_transcript::TRANSCRIPT_SCHEMA_VERSION
            || header.kind != "header"
            || header.session_id != id
        {
            return Err(error("unsupported or mismatched legacy header"));
        }
        if let Some(parent) = header.continues_from {
            if !acp_transcript::safe_component(&parent) {
                return Err(error("unsafe ancestor"));
            }
            parents.insert(
                (directory.clone(), id.clone()),
                (directory.clone(), parent.clone()),
            );
            pending.push((directory.clone(), parent, true));
        }
        let entries = lines
            .filter(|line| !line.is_empty())
            .map(serde_json::from_str::<TranscriptEntry>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        let turns = agents::parsers::acp_native::project_turns_for(
            &entries,
            AgentKind::from_lenient(&header.agent),
        );
        if !turns.is_empty() {
            histories.push(turns);
        }
    }
    for identity in parents.keys() {
        let mut chain = BTreeSet::new();
        let mut current = identity;
        while let Some(parent) = parents.get(current) {
            if !chain.insert(current) {
                return Err(error("cyclic legacy ancestry"));
            }
            current = parent;
        }
    }
    Ok(histories)
}

pub fn validate_coverage(
    sources: &[Vec<MessageTurn>],
    selected: &[MessageTurn],
) -> Result<(), sqlx::Error> {
    for source in sources {
        let covered = selected.windows(source.len()).any(|window| {
            window
                .iter()
                .zip(source)
                .all(|(left, right)| left.role == right.role && left.blocks == right.blocks)
        });
        if !covered {
            return Err(error(
                "conflicting legacy histories; original files retained",
            ));
        }
    }
    Ok(())
}
