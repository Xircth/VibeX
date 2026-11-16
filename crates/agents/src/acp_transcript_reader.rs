use std::path::Path;

use super::{
    EntryKind, TRANSCRIPT_SCHEMA_VERSION, Transcript, TranscriptEntry, TranscriptHeader,
    safe_component, transcript_path_in, dimo_acp_transcripts_root,
};

/// Read one session's transcript. Missing file → empty transcript. Malformed
/// lines are skipped so a single truncated write (e.g. a hard kill mid-append)
/// cannot poison the rest of the history.
pub fn read_transcript(agent_dir: &str, session_id: &str) -> Transcript {
    read_transcript_in(&dimo_acp_transcripts_root(), agent_dir, session_id)
}

/// Root-injectable core of [`read_transcript`].
pub fn read_transcript_in(root: &Path, agent_dir: &str, session_id: &str) -> Transcript {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return Transcript::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Transcript::default();
    };
    parse_transcript(&String::from_utf8_lossy(&bytes))
}

/// Parse transcript file content. Split out so tests (and the reader) share one
/// definition of "what a valid line is".
pub fn parse_transcript(content: &str) -> Transcript {
    let mut out = Transcript::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        };
        if out.header.is_none()
            && let Some(header) = parse_header_line(line)
        {
            out.header = Some(header);
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(line) {
            out.entries.push(entry);
        }
    }
    out
}

pub(super) fn parse_header_line(line: &str) -> Option<TranscriptHeader> {
    let header = serde_json::from_str::<TranscriptHeader>(line).ok()?;
    (header.kind == "header" && header.v == TRANSCRIPT_SCHEMA_VERSION).then_some(header)
}

pub(super) fn scan_lines(path: &Path, mut visit: impl FnMut(&str) -> bool) {
    use std::io::BufRead as _;
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let decoded = String::from_utf8_lossy(&buf);
        let line = decoded.trim();
        if line.is_empty() {
            continue;
        }
        if !visit(line) {
            return;
        }
    }
}

/// A transcript's header WITHOUT parsing its entries.
pub fn read_header_in(root: &Path, agent_dir: &str, session_id: &str) -> Option<TranscriptHeader> {
    let path = transcript_path_in(root, agent_dir, session_id)?;
    let mut found = None;
    scan_lines(&path, |line| {
        found = parse_header_line(line);
        found.is_none()
    });
    found
}

fn read_transcript_with_fallback_in(
    root: &Path,
    preferred_agent_dir: &str,
    session_id: &str,
) -> Transcript {
    let preferred = read_transcript_in(root, preferred_agent_dir, session_id);
    if !preferred.entries.is_empty() {
        return preferred;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return preferred;
    };
    let mut fallback: Option<Transcript> = None;
    for dir_entry in entries.flatten() {
        if !dir_entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        let Some(other_dir) = dir_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if other_dir == preferred_agent_dir {
            continue;
        }
        let mut candidate = read_transcript_in(root, &other_dir, session_id);
        if candidate.entries.is_empty() {
            continue;
        }
        if candidate
            .header
            .as_ref()
            .and_then(|h| h.continues_from.as_ref())
            .is_none()
            && let Some(prev) = preferred
                .header
                .as_ref()
                .and_then(|h| h.continues_from.clone())
            && let Some(header) = candidate.header.as_mut()
        {
            header.continues_from = Some(prev);
        }
        if candidate
            .entries
            .iter()
            .any(|e| matches!(e.k, EntryKind::Update | EntryKind::TurnEnd))
        {
            return candidate;
        }
        if fallback.is_none() {
            fallback = Some(candidate);
        }
    }
    fallback.unwrap_or(preferred)
}

fn read_header_with_fallback_in(
    root: &Path,
    preferred_agent_dir: &str,
    session_id: &str,
) -> Option<TranscriptHeader> {
    let preferred = read_header_in(root, preferred_agent_dir, session_id);
    if preferred
        .as_ref()
        .and_then(|h| h.continues_from.as_ref())
        .is_some()
        && has_entries_in(root, preferred_agent_dir, session_id)
    {
        return preferred;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return preferred;
    };
    let mut fallback_header: Option<TranscriptHeader> = None;
    for dir_entry in entries.flatten() {
        if !dir_entry.file_type().is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        let Some(other_dir) = dir_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if other_dir == preferred_agent_dir {
            continue;
        }
        let Some(mut header) = read_header_in(root, &other_dir, session_id) else {
            continue;
        };
        if header.continues_from.is_none()
            && let Some(prev) = preferred.as_ref().and_then(|h| h.continues_from.clone())
        {
            header.continues_from = Some(prev);
        }
        if header.continues_from.is_some() {
            return Some(header);
        }
        if fallback_header.is_none() {
            fallback_header = Some(header);
        }
    }
    preferred.or(fallback_header)
}

/// True when a transcript FILE already holds at least one entry.
pub fn has_entries_in(root: &Path, agent_dir: &str, session_id: &str) -> bool {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return false;
    };
    let mut header_seen = false;
    let mut found = false;
    scan_lines(&path, |line| {
        if !header_seen && parse_header_line(line).is_some() {
            header_seen = true;
            return true;
        }
        found = serde_json::from_str::<TranscriptEntry>(line).is_ok();
        !found
    });
    found
}

/// Bound on how far [`read_chain_in`] follows `continues_from`.
pub const MAX_CONTINUATION_DEPTH: usize = 512;

/// Read a session's transcript together with everything it continues, oldest entry first.
pub fn read_chain_in(root: &Path, agent_dir: &str, session_id: &str) -> Transcript {
    let mut chain: Vec<Transcript> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cursor = Some(session_id.to_string());

    while let Some(id) = cursor.take() {
        if !visited.insert(id.clone()) {
            tracing::debug!("[acp-transcript] continuation cycle at {id}; stopping walk");
            break;
        }
        if chain.len() >= MAX_CONTINUATION_DEPTH {
            tracing::debug!(
                "[acp-transcript] continuation chain exceeded {MAX_CONTINUATION_DEPTH}; truncating"
            );
            break;
        }
        let transcript = read_transcript_with_fallback_in(root, agent_dir, &id);
        cursor = transcript
            .header
            .as_ref()
            .and_then(|h| h.continues_from.clone());
        chain.push(transcript);
    }

    let mut merged = Transcript::default();
    for transcript in chain.iter_mut().rev() {
        if merged.header.is_none() {
            merged.header = transcript.header.take();
        }
        merged.entries.append(&mut transcript.entries);
    }
    merged
}

/// The session ids `session_id` continues, transitively — newest first.
pub fn continuation_ancestors_in(root: &Path, agent_dir: &str, session_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    visited.insert(session_id.to_string());
    let mut cursor =
        read_header_with_fallback_in(root, agent_dir, session_id).and_then(|h| h.continues_from);

    while let Some(id) = cursor.take() {
        if !visited.insert(id.clone()) {
            tracing::debug!("[acp-transcript] continuation cycle at {id}; stopping walk");
            break;
        }
        if out.len() >= MAX_CONTINUATION_DEPTH {
            tracing::debug!(
                "[acp-transcript] continuation chain exceeded {MAX_CONTINUATION_DEPTH}; truncating"
            );
            break;
        }
        cursor = read_header_with_fallback_in(root, agent_dir, &id).and_then(|h| h.continues_from);
        out.push(id);
    }
    out
}

/// [`continuation_ancestors_in`] against the real transcripts root.
pub fn continuation_ancestors(agent_dir: &str, session_id: &str) -> Vec<String> {
    continuation_ancestors_in(&dimo_acp_transcripts_root(), agent_dir, session_id)
}

/// Session ids under `<root>/<agent_dir>/` that some other transcript continues.
pub fn superseded_session_ids_in(
    root: &Path,
    agent_dir: &str,
) -> std::collections::HashSet<String> {
    list_session_ids_in(root, agent_dir)
        .into_iter()
        .filter_map(|id| read_header_in(root, agent_dir, &id))
        .filter_map(|h| h.continues_from)
        .collect()
}

/// Every session id with a transcript under `<root>/<agent_dir>/`.
pub fn list_session_ids_in(root: &Path, agent_dir: &str) -> Vec<String> {
    if !safe_component(agent_dir) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root.join(agent_dir)) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".jsonl").map(str::to_string)
        })
        .collect();
    ids.sort();
    ids
}

/// Delete a custom agent's whole transcript directory.
pub fn remove_agent_transcripts_in(root: &Path, agent_dir: &str) -> std::io::Result<()> {
    if !safe_component(agent_dir) {
        return Ok(());
    }
    let dir = root.join(agent_dir);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
