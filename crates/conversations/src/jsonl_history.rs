//! UI transcript reads. The file under `acp-transcripts/` is the history the
//! window protocol slices. `conversation_events` is still appended so the live
//! row-op publisher can fold the in-flight turn; open and older-page reads do
//! not fold those events.

use agents::acp_transcript::{
    self, EntryKind, TranscriptEntry, TranscriptHeader, record_entry, safe_component,
    vibex_acp_transcripts_root,
};
use agents::conversation::{
    ContentBlock, ConversationEvent, ConversationInputBlock, ConversationTimeline,
    ConversationTimelineRow, MessageTurn, SessionStats, TimelineRow, TurnRole, TurnUsage,
};
use agents::parsers::acp_native::project_turns;
use agents::parsers::loader::load_import_conversation_detail;
use agents::AgentKind;
use chrono::{DateTime, Utc};
use db::models::conversation::DbConversationSummary;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::projection::{CONVERSATION_PROJECTION_VERSION, ConversationProjector};
use crate::turn_window::{self, TurnWindowReq, WindowMeta};

const TAIL_TURNS_DEFAULT: usize = 120;

/// Agents whose CLI session file is the history, matching Codeg's
/// `uses_acp_transcript == false` for the kinds VibeX can already parse.
/// Every other identity records ACP JSONL.
pub fn uses_acp_transcript(kind: Option<AgentKind>) -> bool {
    !matches!(
        kind,
        Some(AgentKind::ClaudeCode | AgentKind::Codex | AgentKind::Cline | AgentKind::Openclaw)
    )
}

#[derive(Debug, Clone)]
pub struct WindowedHistory {
    pub turns: Vec<MessageTurn>,
    pub offset: usize,
    pub total: usize,
    pub meta: WindowMeta,
    pub session_stats: Option<SessionStats>,
    pub last_sequence: i64,
}

pub fn rows_from_turns(turns: &[MessageTurn]) -> Vec<TimelineRow> {
    turns
        .iter()
        .map(|turn| TimelineRow {
            row_id: turn.id.clone(),
            revision: turn.timestamp.timestamp_millis().max(0),
            row: ConversationTimelineRow::MessageTurn {
                turn: turn.clone(),
                phase: "settled".to_string(),
                fork_point_status: None,
            },
        })
        .collect()
}

pub fn timeline_from_window(
    conversation_id: Uuid,
    history: &WindowedHistory,
) -> ConversationTimeline {
    ConversationTimeline {
        conversation_id,
        projection_version: CONVERSATION_PROJECTION_VERSION,
        last_sequence: history.last_sequence,
        rows: rows_from_turns(&history.turns),
        truncated_from_start: history.offset > 0,
        older_cursor: (history.offset > 0).then(|| history.offset.to_string()),
    }
}

/// Cargo test binaries live in `target/.../deps`. Redirect their transcript
/// files so a migration cannot write into the user data directory.
fn isolate_test_transcripts() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var_os("VIBEX_TRANSCRIPTS_ROOT").is_some() {
            return;
        }
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let in_deps = exe
            .components()
            .any(|component| component.as_os_str() == "deps");
        if !in_deps {
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "vibex-acp-transcripts-{}",
            std::process::id()
        ));
        unsafe {
            std::env::set_var("VIBEX_TRANSCRIPTS_ROOT", dir);
        }
    });
}

pub async fn load_window(
    pool: &SqlitePool,
    conversation_id: Uuid,
    request: TurnWindowReq,
) -> Result<Option<WindowedHistory>, sqlx::Error> {
    isolate_test_transcripts();
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Ok(None);
    };
    let all = load_turns(pool, &summary).await?;
    let offset = turn_window::resolve_window_offset(&all, request);
    let slice = all.get(offset..).unwrap_or(&[]).to_vec();
    let meta = turn_window::window_meta(&all, offset);
    let session_stats = session_stats_of(&all);
    let last_sequence = max_sequence(pool, conversation_id).await?;
    Ok(Some(WindowedHistory {
        turns: slice,
        offset,
        total: all.len(),
        meta,
        session_stats,
        last_sequence,
    }))
}

#[derive(Debug, Clone)]
pub struct LoadedTurnPage {
    pub turns: Vec<MessageTurn>,
    pub start: usize,
    pub next_cursor: Option<usize>,
}

pub async fn load_page(
    pool: &SqlitePool,
    conversation_id: Uuid,
    start: usize,
    limit: usize,
) -> Result<Option<LoadedTurnPage>, sqlx::Error> {
    isolate_test_transcripts();
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Ok(None);
    };
    let all = load_turns(pool, &summary).await?;
    let before = start.saturating_add(limit);
    let (page_start, page_end) = turn_window::resolve_page_bounds(&all, before, limit);
    let next_cursor = (page_end < all.len()).then_some(page_end);
    Ok(Some(LoadedTurnPage {
        turns: all[page_start..page_end].to_vec(),
        start: page_start,
        next_cursor,
    }))
}

async fn load_turns(
    pool: &SqlitePool,
    summary: &DbConversationSummary,
) -> Result<Vec<MessageTurn>, sqlx::Error> {
    let kind = summary
        .agent_id
        .as_ref()
        .and_then(|id| AgentKind::from_lenient(id.as_ref()));
    let (agent_dir, session_id) = transcript_identity(summary, kind);
    if let Some(kind) = kind.filter(|kind| !uses_acp_transcript(Some(*kind))) {
        if let Some(external) = summary.external_session_id.as_deref() {
            if let Ok(Some(detail)) =
                load_import_conversation_detail(kind, external, None)
            {
                if !detail.turns.is_empty() {
                    return Ok(detail.turns);
                }
            }
        }
    }
    let root = vibex_acp_transcripts_root();
    // A file that exists — even a header claimed by an in-flight session/load
    // replay — is the transcript. Overwriting it would duplicate history.
    if acp_transcript::transcript_path_in(&root, &agent_dir, &session_id)
        .is_some_and(|path| path.is_file())
    {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, &session_id);
        return Ok(project_turns(&existing.entries));
    }
    let timeline = ConversationProjector::project(pool, summary.id).await?;
    let extracted = message_turns(&timeline);
    if extracted.is_empty() {
        return Ok(Vec::new());
    }
    write_migrated_transcript(&root, &agent_dir, &session_id, summary, &extracted);
    let written = acp_transcript::read_transcript_in(&root, &agent_dir, &session_id);
    Ok(project_turns(&written.entries))
}

fn message_turns(timeline: &ConversationTimeline) -> Vec<MessageTurn> {
    timeline
        .rows
        .iter()
        .filter_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn.clone()),
            _ => None,
        })
        .collect()
}

fn transcript_identity(
    summary: &DbConversationSummary,
    kind: Option<AgentKind>,
) -> (String, String) {
    let raw_dir = kind
        .map(|kind| kind.as_str().to_string())
        .or_else(|| summary.agent_id.as_ref().map(|id| id.to_string()))
        .unwrap_or_else(|| "session".to_string());
    let agent_dir = if safe_component(&raw_dir) {
        raw_dir
    } else {
        "session".to_string()
    };
    let raw_sid = summary
        .external_session_id
        .clone()
        .filter(|id| safe_component(id))
        .unwrap_or_else(|| summary.id.simple().to_string());
    (agent_dir, raw_sid)
}

fn write_migrated_transcript(
    root: &std::path::Path,
    agent_dir: &str,
    session_id: &str,
    summary: &DbConversationSummary,
    turns: &[MessageTurn],
) {
    let Some(path) = acp_transcript::transcript_path_in(root, agent_dir, session_id) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(_) => return,
    };
    let header = TranscriptHeader::new(
        agent_dir,
        session_id,
        "",
        summary
            .created_at
            .timestamp_millis()
            .max(0) as u64,
    );
    let mut lines = String::new();
    if let Ok(json) = serde_json::to_string(&header) {
        lines.push_str(&json);
        lines.push('\n');
    }
    for entry in encode_turns(turns) {
        if let Ok(json) = serde_json::to_string(&entry) {
            lines.push_str(&json);
            lines.push('\n');
        }
    }
    use std::io::Write;
    if file.write_all(lines.as_bytes()).is_err() {
        tracing::debug!(?path, "transcript migration write failed");
    }
}

/// Fork copies the visible transcript into the child file. The parent event
/// log stays where it is; the child reads this file on open.
pub async fn copy_transcript_snapshot(
    pool: &SqlitePool,
    source_id: Uuid,
    destination_id: Uuid,
    until_turn_id: Option<Uuid>,
) -> Result<usize, sqlx::Error> {
    isolate_test_transcripts();
    let Some(source) = DbConversationSummary::find_by_id(pool, source_id).await? else {
        return Ok(0);
    };
    let Some(destination) = DbConversationSummary::find_by_id(pool, destination_id).await? else {
        return Ok(0);
    };
    // Event-projected turns keep `{turn_id}:user` ids, which is what
    // `until_turn_id` names. A JSONL reparse assigns its own ids, so it is
    // only the fallback once the event log has nothing left to show.
    let projected = message_turns(&ConversationProjector::project(pool, source_id).await?);
    let turns = if projected.is_empty() {
        load_turns(pool, &source).await?
    } else {
        projected
    };
    let sliced = turns_through(&turns, until_turn_id);
    if sliced.is_empty() {
        return Ok(0);
    }
    let kind = destination
        .agent_id
        .as_ref()
        .and_then(|id| AgentKind::from_lenient(id.as_ref()));
    let (agent_dir, session_id) = transcript_identity(&destination, kind);
    write_migrated_transcript(
        &vibex_acp_transcripts_root(),
        &agent_dir,
        &session_id,
        &destination,
        &sliced,
    );
    Ok(sliced.len())
}

fn turns_through(turns: &[MessageTurn], until_turn_id: Option<Uuid>) -> Vec<MessageTurn> {
    let Some(until_turn_id) = until_turn_id else {
        return turns.to_vec();
    };
    let hyphenated = until_turn_id.to_string();
    let simple = until_turn_id.simple().to_string();
    let mut out = Vec::new();
    let mut seen = false;
    for turn in turns {
        let belongs = turn.id == hyphenated
            || turn.id == simple
            || turn.id.starts_with(&format!("{hyphenated}:"))
            || turn.id.starts_with(&format!("{simple}:"));
        if belongs {
            seen = true;
            out.push(turn.clone());
            continue;
        }
        if seen {
            break;
        }
        out.push(turn.clone());
    }
    if seen { out } else { Vec::new() }
}

pub fn encode_turns(turns: &[MessageTurn]) -> Vec<TranscriptEntry> {
    let mut entries = Vec::new();
    for turn in turns {
        let t = millis(turn.timestamp);
        match turn.role {
            TurnRole::User => entries.push(TranscriptEntry {
                t,
                k: EntryKind::Prompt,
                steer: false,
                p: Value::Array(prompt_blocks(turn)),
            }),
            TurnRole::Assistant | TurnRole::System => {
                for block in &turn.blocks {
                    if let Some(payload) = update_payload(block) {
                        entries.push(TranscriptEntry {
                            t,
                            k: EntryKind::Update,
                            steer: false,
                            p: payload,
                        });
                    }
                }
                let mut end = serde_json::json!({ "stopReason": "end_turn" });
                if let Some(ms) = turn.duration_ms {
                    end["durationMs"] = serde_json::json!(ms);
                }
                if let Some(model) = &turn.model {
                    end["model"] = serde_json::json!(model);
                }
                if let Some(usage) = &turn.usage {
                    end["usage"] = serde_json::json!({
                        "inputTokens": usage.input_tokens,
                        "outputTokens": usage.output_tokens,
                        "cacheCreationInputTokens": usage.cache_creation_input_tokens,
                        "cacheReadInputTokens": usage.cache_read_input_tokens,
                    });
                }
                entries.push(TranscriptEntry {
                    t,
                    k: EntryKind::TurnEnd,
                    steer: false,
                    p: end,
                });
            }
        }
    }
    entries
}

fn prompt_blocks(turn: &MessageTurn) -> Vec<Value> {
    let mut blocks = Vec::new();
    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text } => {
                blocks.push(serde_json::json!({ "type": "text", "text": text }));
            }
            ContentBlock::Image { data, mime_type, uri, .. } => {
                blocks.push(serde_json::json!({
                    "type": "image",
                    "data": data,
                    "mimeType": mime_type,
                    "uri": uri,
                }));
            }
            _ => {}
        }
    }
    if blocks.is_empty() {
        blocks.push(serde_json::json!({ "type": "text", "text": "" }));
    }
    blocks
}

fn update_payload(block: &ContentBlock) -> Option<Value> {
    match block {
        ContentBlock::Text { text } => Some(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text }
        })),
        ContentBlock::Thinking { text } => Some(serde_json::json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": text }
        })),
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            kind,
            ..
        } => Some(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": tool_use_id.clone().unwrap_or_else(|| "tool".to_string()),
            "title": tool_name,
            "kind": kind.clone().unwrap_or_else(|| "other".to_string()),
            "status": "completed",
            "rawInput": raw_input(input_preview),
        })),
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => Some(serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool_use_id.clone().unwrap_or_else(|| "tool".to_string()),
            "status": if *is_error { "failed" } else { "completed" },
            "content": [{
                "type": "content",
                "content": { "type": "text", "text": output_preview.clone().unwrap_or_default() }
            }]
        })),
        ContentBlock::Plan { entries } => Some(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "acp-plan",
            "title": "TodoWrite",
            "status": "completed",
            "rawInput": { "todos": entries },
        })),
        _ => None,
    }
}

fn raw_input(preview: &Option<String>) -> Value {
    match preview {
        Some(text) => serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({ "text": text })),
        None => Value::Null,
    }
}

fn millis(timestamp: DateTime<Utc>) -> u64 {
    timestamp.timestamp_millis().max(0) as u64
}

fn session_stats_of(turns: &[MessageTurn]) -> Option<SessionStats> {
    let mut total = TurnUsage {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        context_used: None,
        context_window_max: None,
        cost_amount: None,
        cost_currency: None,
    };
    let mut any = false;
    let mut duration = 0u64;
    for turn in turns {
        if let Some(usage) = &turn.usage {
            any = true;
            total.input_tokens += usage.input_tokens;
            total.output_tokens += usage.output_tokens;
            total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            total.cache_read_input_tokens += usage.cache_read_input_tokens;
        }
        if let Some(ms) = turn.duration_ms {
            duration += ms;
        }
    }
    if !any && duration == 0 {
        return None;
    }
    let total_tokens = any.then(|| {
        total.input_tokens
            + total.output_tokens
            + total.cache_creation_input_tokens
            + total.cache_read_input_tokens
    });
    Some(SessionStats {
        total_usage: any.then_some(total),
        total_tokens,
        total_duration_ms: duration,
        context_window_used_tokens: None,
        context_window_max_tokens: None,
        context_window_usage_percent: None,
    })
}

async fn max_sequence(pool: &SqlitePool, conversation_id: Uuid) -> Result<i64, sqlx::Error> {
    let value = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(sequence) FROM conversation_events WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    Ok(value.unwrap_or(0))
}

/// Append one content event to an existing JSONL transcript. No-op until
/// migration has created the file, so the first open still encodes the whole
/// event projection once.
pub async fn mirror_appended_event(
    pool: &SqlitePool,
    conversation_id: Uuid,
    event: &ConversationEvent,
) {
    isolate_test_transcripts();
    let Ok(Some(summary)) = DbConversationSummary::find_by_id(pool, conversation_id).await else {
        return;
    };
    let kind = summary
        .agent_id
        .as_ref()
        .and_then(|id| AgentKind::from_lenient(id.as_ref()));
    if !uses_acp_transcript(kind) {
        return;
    }
    let (agent_dir, session_id) = transcript_identity(&summary, kind);
    let root = vibex_acp_transcripts_root();
    let Some(path) = acp_transcript::transcript_path_in(&root, &agent_dir, &session_id) else {
        return;
    };
    if !path.is_file() {
        return;
    }
    let Some((entry_kind, payload)) = mirror_payload(event) else {
        return;
    };
    drop(record_entry(&agent_dir, &session_id, entry_kind, payload));
}

fn mirror_payload(event: &ConversationEvent) -> Option<(EntryKind, Value)> {
    match event {
        ConversationEvent::UserTurnCreated { blocks, .. } => {
            let payload = Value::Array(
                blocks
                    .iter()
                    .map(|block| match block {
                        ConversationInputBlock::Text { text } => {
                            serde_json::json!({ "type": "text", "text": text })
                        }
                        ConversationInputBlock::Image {
                            uri,
                            mime_type,
                            title,
                        } => serde_json::json!({
                            "type": "image",
                            "uri": uri,
                            "mimeType": mime_type,
                            "title": title,
                        }),
                        ConversationInputBlock::Resource { uri, title, mime_type } => {
                            serde_json::json!({
                                "type": "resource_link",
                                "uri": uri,
                                "name": title,
                                "mimeType": mime_type,
                            })
                        }
                        ConversationInputBlock::Protocol { content } => content.clone(),
                    })
                    .collect(),
            );
            Some((EntryKind::Prompt, payload))
        }
        ConversationEvent::AssistantTextDelta { text, .. } => Some((
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text }
            }),
        )),
        ConversationEvent::AssistantReasoningDelta { text, .. } => Some((
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": text }
            }),
        )),
        ConversationEvent::AssistantContentAppended { block, .. } => {
            update_payload(block).map(|payload| (EntryKind::Update, payload))
        }
        ConversationEvent::PlanUpdated { entries } => Some((
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "acp-plan",
                "title": "TodoWrite",
                "status": "completed",
                "rawInput": { "todos": entries },
            }),
        )),
        ConversationEvent::ToolCallUpsert { tool_call } => {
            let status = tool_call
                .status
                .clone()
                .unwrap_or_else(|| "pending".to_string());
            let updating = tool_call.raw_output.is_some()
                || tool_call.content.is_some()
                || tool_call.raw_output_append.is_some();
            let payload = if updating {
                serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": tool_call.tool_call_id,
                    "status": status,
                    "content": tool_call.content,
                    "rawOutput": tool_call.raw_output,
                })
            } else {
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": tool_call.tool_call_id,
                    "title": tool_call.title.clone().unwrap_or_else(|| "tool".to_string()),
                    "kind": tool_call.kind.clone().unwrap_or_else(|| "other".to_string()),
                    "status": status,
                    "rawInput": tool_call.raw_input,
                })
            };
            Some((EntryKind::Update, payload))
        }
        ConversationEvent::TurnCompleted { stop_reason } => Some((
            EntryKind::TurnEnd,
            serde_json::json!({
                "stopReason": stop_reason.clone().unwrap_or_else(|| "end_turn".to_string())
            }),
        )),
        ConversationEvent::TurnFailed { .. } => Some((
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "error" }),
        )),
        ConversationEvent::TurnCancelled { .. } => Some((
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "cancelled" }),
        )),
        _ => None,
    }
}

pub fn default_tail() -> TurnWindowReq {
    TurnWindowReq::Tail(TAIL_TURNS_DEFAULT)
}

pub fn parse_window(tail_turns: Option<u32>, from_index: Option<u32>) -> Result<TurnWindowReq, String> {
    match (tail_turns, from_index) {
        (Some(_), Some(_)) => Err("tailTurns and fromIndex are mutually exclusive".to_string()),
        (None, Some(index)) => Ok(TurnWindowReq::FromIndex(index as usize)),
        (Some(tail), None) => Ok(TurnWindowReq::Tail(tail as usize)),
        (None, None) => Ok(default_tail()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn turn(role: TurnRole, text: &str, secs: i64) -> MessageTurn {
        MessageTurn {
            id: format!("t-{secs}"),
            role,
            blocks: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: Utc.timestamp_opt(secs, 0).unwrap(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    #[test]
    fn migrated_turns_round_trip_user_text() {
        let turns = vec![
            turn(TurnRole::User, "hello", 1_700_000_001),
            turn(TurnRole::Assistant, "hi there", 1_700_000_002),
        ];
        let read = project_turns(&encode_turns(&turns));
        assert_eq!(read.len(), 2);
        match &read[0].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hello"),
            other => panic!("{other:?}"),
        }
        match &read[1].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hi there"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn tail_window_is_120_not_the_open_row_cap() {
        let mut turns = Vec::new();
        for index in 0..300 {
            let role = if index % 2 == 0 {
                TurnRole::User
            } else {
                TurnRole::Assistant
            };
            turns.push(turn(role, "x", 1_700_000_000 + index as i64));
        }
        let offset = turn_window::resolve_window_offset(&turns, TurnWindowReq::Tail(120));
        assert!(offset <= 300 - 120);
        assert!(matches!(turns[offset].role, TurnRole::User));
        assert!(300 - offset <= 120 + 1);
    }
}
