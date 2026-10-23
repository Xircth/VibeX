//! UI transcript. The file under `acp-transcripts/` is the history the window
//! protocol slices, and content deltas are appended there instead of
//! `conversation_events`. Open and older-page reads do not fold the event log.

use std::collections::HashMap;

use agents::{
    AgentKind,
    acp_transcript::{
        self, EntryKind, TranscriptEntry, TranscriptHeader, safe_component,
        vibex_acp_transcripts_root,
    },
    conversation::{
        ContentBlock, ConversationEvent, ConversationTimeline, ConversationTimelineRow,
        MessageTurn, SessionStats, TimelineRow, TurnRole, TurnUsage,
    },
    parsers::{acp_native::project_turns, loader::load_import_conversation_detail},
};
use chrono::{DateTime, Utc};
use db::models::{
    conversation::{ConversationAgentBindingRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    projection::{CONVERSATION_PROJECTION_VERSION, ConversationProjector},
    turn_window::{self, TurnWindowReq, WindowMeta},
};

const TAIL_TURNS_DEFAULT: usize = 120;

/// Every VibeX conversation streams its live turn deltas into its canonical
/// `acp-transcripts/<agent_dir>/<conversation_id>.jsonl` file.
pub fn uses_acp_transcript(_kind: Option<AgentKind>) -> bool {
    true
}

/// Content that lives in the transcript file. These events are not inserted
/// into `conversation_events`; the live projector folds them in memory.
pub fn is_transcript_delta(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::AssistantTextDelta { .. }
            | ConversationEvent::AssistantReasoningDelta { .. }
            | ConversationEvent::AssistantContentAppended { .. }
            | ConversationEvent::PlanUpdated { .. }
            | ConversationEvent::ToolCallUpsert { .. }
    )
}

#[derive(Debug, Clone)]
pub struct WindowedHistory {
    pub turns: Vec<MessageTurn>,
    pub side_rows: Vec<TimelineRow>,
    pub fork_point_statuses: HashMap<String, agents::ForkPointStatus>,
    pub offset: usize,
    pub total: usize,
    pub meta: WindowMeta,
    pub session_stats: Option<SessionStats>,
    pub last_sequence: i64,
}

impl WindowedHistory {
    pub fn empty() -> Self {
        Self {
            turns: Vec::new(),
            side_rows: Vec::new(),
            fork_point_statuses: HashMap::new(),
            offset: 0,
            total: 0,
            meta: turn_window::window_meta(&[], 0),
            session_stats: None,
            last_sequence: 0,
        }
    }
}

pub fn rows_from_turns(turns: &[MessageTurn]) -> Vec<TimelineRow> {
    let open_assistant = turns.len().checked_sub(1).filter(|index| {
        let turn = &turns[*index];
        matches!(turn.role, TurnRole::Assistant)
            && turn.completed_at.is_none()
            && !turn.blocks.is_empty()
    });
    let open_user = open_assistant.and_then(|index| {
        index
            .checked_sub(1)
            .filter(|user_index| matches!(turns[*user_index].role, TurnRole::User))
    });
    turns
        .iter()
        .enumerate()
        .map(|(index, turn)| {
            let phase = if Some(index) == open_assistant || Some(index) == open_user {
                "streaming"
            } else {
                "settled"
            };
            let revision = turn
                .id
                .strip_prefix("acp-")
                .and_then(|value| value.split(':').next())
                .and_then(|value| value.parse::<i64>().ok())
                .map(|n| n + 1)
                .unwrap_or((index + 1) as i64);
            TimelineRow {
                row_id: turn.id.clone(),
                revision,
                row: ConversationTimelineRow::MessageTurn {
                    turn: turn.clone(),
                    phase: phase.to_string(),
                    fork_point_status: None,
                },
            }
        })
        .collect()
}

pub fn timeline_from_window(
    conversation_id: Uuid,
    history: &WindowedHistory,
) -> ConversationTimeline {
    let mut rows = rows_from_turns(&history.turns);
    for row in &mut rows {
        if let ConversationTimelineRow::MessageTurn {
            turn,
            fork_point_status,
            ..
        } = &mut row.row
            && let Some(status) = history.fork_point_statuses.get(&turn.id)
        {
            *fork_point_status = Some(*status);
        }
    }
    rows.extend(history.side_rows.iter().cloned());
    ConversationTimeline {
        conversation_id,
        projection_version: CONVERSATION_PROJECTION_VERSION,
        last_sequence: history.last_sequence,
        rows,
        truncated_from_start: history.offset > 0,
        older_cursor: (history.offset > 0).then(|| history.offset.to_string()),
    }
}

pub async fn load_all_turns(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Vec<MessageTurn>>, sqlx::Error> {
    isolate_test_transcripts();
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Ok(None);
    };
    Ok(Some(load_turns(pool, &summary).await?))
}

/// Read any existing on-disk JSONL transcript turns for `conversation_id`
/// without mutating or migrating from SQLite.
pub fn read_existing_transcript_turns(conversation_id: Uuid) -> Option<Vec<MessageTurn>> {
    read_existing_transcript_turns_with_external(conversation_id, None)
}

pub fn read_existing_transcript_turns_with_external(
    conversation_id: Uuid,
    external_session_id: Option<&str>,
) -> Option<Vec<MessageTurn>> {
    isolate_test_transcripts();
    let root = vibex_acp_transcripts_root();
    let candidates = transcript_session_id_candidates(conversation_id, external_session_id);
    let entries = std::fs::read_dir(&root).ok()?;
    for dir_entry in entries.flatten() {
        let Ok(file_type) = dir_entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(agent_dir) = dir_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        for sid in &candidates {
            if acp_transcript::has_entries_in(&root, &agent_dir, sid) {
                let chain = acp_transcript::read_chain_in(&root, &agent_dir, sid);
                let turns = project_turns(&chain.entries);
                if !turns.is_empty() {
                    return Some(turns);
                }
            }
        }
    }
    None
}

pub async fn flush_and_read_existing_transcript_turns(
    conversation_id: Uuid,
    external_session_id: Option<&str>,
) -> Option<Vec<MessageTurn>> {
    isolate_test_transcripts();
    let root = vibex_acp_transcripts_root();
    let candidates = transcript_session_id_candidates(conversation_id, external_session_id);
    if let Ok(entries) = std::fs::read_dir(&root) {
        for dir_entry in entries.flatten() {
            let Ok(file_type) = dir_entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Some(agent_dir) = dir_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            for sid in &candidates {
                let _ = acp_transcript::flush_in(&root, &agent_dir, sid).await;
            }
        }
    }
    read_existing_transcript_turns_with_external(conversation_id, external_session_id)
}

fn transcript_session_id_candidates(
    conversation_id: Uuid,
    external_session_id: Option<&str>,
) -> Vec<String> {
    let mut candidates = Vec::with_capacity(3);
    if let Some(ext) = external_session_id
        .map(str::trim)
        .filter(|ext| !ext.is_empty() && safe_component(ext))
    {
        candidates.push(ext.to_string());
    }
    let simple = conversation_id.simple().to_string();
    if !candidates.contains(&simple) {
        candidates.push(simple);
    }
    let hyphenated = conversation_id.to_string();
    if !candidates.contains(&hyphenated) {
        candidates.push(hyphenated);
    }
    candidates
}

pub fn timeline_from_turns(conversation_id: Uuid, turns: &[MessageTurn]) -> ConversationTimeline {
    ConversationTimeline {
        conversation_id,
        projection_version: CONVERSATION_PROJECTION_VERSION,
        last_sequence: 0,
        rows: rows_from_turns(turns),
        truncated_from_start: false,
        older_cursor: None,
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
        let dir =
            std::env::temp_dir().join(format!("vibex-acp-transcripts-{}", std::process::id()));
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
    let mut side_rows = ConversationProjector::persisted_side_rows(pool, conversation_id)
        .await
        .unwrap_or_default();
    attach_acp_turn_ids_to_side_rows(pool, conversation_id, &all, &mut side_rows).await;
    let fork_point_statuses = fork_point_statuses_for_turns(pool, conversation_id, &all, &slice)
        .await
        .unwrap_or_default();
    let session_stats = session_stats_of(&all);
    let last_sequence = ConversationEventRecord::max_sequence(pool, conversation_id).await?;
    Ok(Some(WindowedHistory {
        turns: slice,
        side_rows,
        fork_point_statuses,
        offset,
        total: all.len(),
        meta,
        session_stats,
        last_sequence,
    }))
}

/// Pair each non-steer user round in `all_turns` (`(user_acp_id, last_assistant_acp_id)`)
/// with the corresponding `ConversationTurnRecord` in SQLite so `FileChangeSummary`
/// and `TurnError` side rows carry `|user=acp-N|assistant=acp-M` metadata in `row_id`.
async fn attach_acp_turn_ids_to_side_rows(
    pool: &SqlitePool,
    conversation_id: Uuid,
    all_turns: &[MessageTurn],
    side_rows: &mut [TimelineRow],
) {
    if side_rows.is_empty() || all_turns.is_empty() {
        return;
    }
    let Ok(db_turns) = ConversationTurnRecord::list_for_conversation(pool, conversation_id).await
    else {
        return;
    };
    if db_turns.is_empty() {
        return;
    }
    let rounds = non_steer_rounds_acp_ids(all_turns);
    let mut by_turn_uuid: HashMap<Uuid, (String, Option<String>)> = HashMap::new();
    for (db_turn, acp_pair) in db_turns.iter().zip(rounds.into_iter()) {
        by_turn_uuid.insert(db_turn.id, acp_pair);
    }
    for side_row in side_rows.iter_mut() {
        let turn_uuid = match &side_row.row {
            ConversationTimelineRow::FileChangeSummary { turn_id, .. } => *turn_id,
            ConversationTimelineRow::TurnError { error } => error.turn_id,
            _ => None,
        };
        let Some(turn_uuid) = turn_uuid else {
            continue;
        };
        let Some((user_id, assistant_id)) = by_turn_uuid.get(&turn_uuid) else {
            continue;
        };
        let base_id = side_row
            .row_id
            .split('|')
            .next()
            .unwrap_or(side_row.row_id.as_str())
            .to_string();
        side_row.row_id = match assistant_id {
            Some(assistant_id) => format!("{base_id}|user={user_id}|assistant={assistant_id}"),
            None => format!("{base_id}|user={user_id}"),
        };
    }
}

pub fn non_steer_rounds_acp_ids(all_turns: &[MessageTurn]) -> Vec<(String, Option<String>)> {
    let mut rounds: Vec<(String, Option<String>)> = Vec::new();
    for turn in all_turns {
        if matches!(turn.role, TurnRole::User) && !turn.id.contains(":steer:") {
            rounds.push((turn.id.clone(), None));
        } else if matches!(turn.role, TurnRole::Assistant)
            && let Some(last_round) = rounds.last_mut()
        {
            last_round.1 = Some(turn.id.clone());
        }
    }
    rounds
}

async fn fork_point_statuses_for_turns(
    pool: &SqlitePool,
    conversation_id: Uuid,
    all_turns: &[MessageTurn],
    target_turns: &[MessageTurn],
) -> Result<HashMap<String, agents::ForkPointStatus>, sqlx::Error> {
    let mut statuses = HashMap::new();
    if target_turns.is_empty() {
        return Ok(statuses);
    }
    let Some(binding) =
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?
    else {
        return Ok(statuses);
    };
    let capabilities =
        serde_json::from_str::<agents::AcpCapabilitySnapshot>(&binding.session_capabilities_json)
            .unwrap_or_default();
    let agent_kind = AgentKind::from_lenient(binding.agent_id.as_str());
    let last_assistant_id = all_turns
        .iter()
        .rev()
        .find(|turn| matches!(turn.role, TurnRole::Assistant))
        .map(|turn| turn.id.as_str());
    for turn in target_turns {
        if !matches!(turn.role, TurnRole::Assistant) {
            continue;
        }
        let is_tail = last_assistant_id == Some(turn.id.as_str());
        let status = match agent_kind {
            Some(kind) => {
                agents::classify_fork_point_turn(turn, kind, capabilities.fork_session, is_tail)
            }
            None => agents::ForkPointStatus::Unsupported,
        };
        statuses.insert(turn.id.clone(), status);
    }
    Ok(statuses)
}

#[derive(Debug, Clone)]
pub struct LoadedTurnPage {
    pub turns: Vec<MessageTurn>,
    pub rows: Vec<TimelineRow>,
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
    let turns = all[page_start..page_end].to_vec();
    let mut rows = rows_from_turns(&turns);
    if let Ok(statuses) = fork_point_statuses_for_turns(pool, conversation_id, &all, &turns).await {
        for row in &mut rows {
            if let ConversationTimelineRow::MessageTurn {
                turn,
                fork_point_status,
                ..
            } = &mut row.row
                && let Some(status) = statuses.get(&turn.id)
            {
                *fork_point_status = Some(*status);
            }
        }
    }
    Ok(Some(LoadedTurnPage {
        turns,
        rows,
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
    let root = vibex_acp_transcripts_root();

    if acp_transcript::transcript_path_in(&root, &agent_dir, &session_id)
        .is_some_and(|path| path.is_file())
    {
        let _ = acp_transcript::flush_in(&root, &agent_dir, &session_id).await;
    }
    if let Some(legacy_sid) = legacy_external_session_id(summary).as_deref()
        && acp_transcript::transcript_path_in(&root, &agent_dir, legacy_sid)
            .is_some_and(|path| path.is_file())
    {
        let _ = acp_transcript::flush_in(&root, &agent_dir, legacy_sid).await;
    }

    if let Some(legacy_sid) = legacy_external_session_id(summary).as_deref()
        && acp_transcript::has_entries_in(&root, &agent_dir, legacy_sid)
    {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, legacy_sid);
        return Ok(project_turns(&existing.entries));
    }
    if acp_transcript::has_entries_in(&root, &agent_dir, &session_id) {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, &session_id);
        return Ok(project_turns(&existing.entries));
    }
    // A file that exists — even a header claimed by an in-flight session/load
    // replay or session bind — is the transcript. Overwriting it would duplicate history.
    if let Some(legacy_sid) = legacy_external_session_id(summary).as_deref()
        && acp_transcript::transcript_path_in(&root, &agent_dir, legacy_sid)
            .is_some_and(|path| path.is_file())
    {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, legacy_sid);
        return Ok(project_turns(&existing.entries));
    }
    if acp_transcript::transcript_path_in(&root, &agent_dir, &session_id)
        .is_some_and(|path| path.is_file())
    {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, &session_id);
        return Ok(project_turns(&existing.entries));
    }

    let timeline = ConversationProjector::project(pool, summary.id).await?;
    let mut extracted = message_turns(&timeline);
    if !extracted
        .iter()
        .any(|turn| matches!(turn.role, TurnRole::Assistant))
        && let (Some(kind), Some(external)) = (kind, summary.external_session_id.as_deref())
        && let Ok(Some(detail)) = load_import_conversation_detail(kind, external, None)
        && detail.turns.len() > extracted.len()
    {
        extracted = detail.turns;
    }
    if extracted.is_empty() {
        return Ok(Vec::new());
    }
    write_migrated_transcript(&root, &agent_dir, &session_id, summary, &extracted);
    let written = acp_transcript::read_chain_in(&root, &agent_dir, &session_id);
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
    let raw_sid = summary.id.simple().to_string();
    (agent_dir, raw_sid)
}

fn legacy_external_session_id(summary: &DbConversationSummary) -> Option<String> {
    let conv_sid = summary.id.simple().to_string();
    summary
        .external_session_id
        .clone()
        .filter(|ext| ext != &conv_sid && safe_component(ext))
}

fn serialize_transcript(
    agent_dir: &str,
    session_id: &str,
    summary: &DbConversationSummary,
    turns: &[MessageTurn],
) -> String {
    let header = TranscriptHeader::new(
        agent_dir,
        session_id,
        "",
        summary.created_at.timestamp_millis().max(0) as u64,
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
    lines
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
    let lines = serialize_transcript(agent_dir, session_id, summary, turns);
    use std::io::Write;
    if file.write_all(lines.as_bytes()).is_err() {
        tracing::debug!(?path, "transcript migration write failed");
    }
}

/// Ensure `<conversation_id.simple()>.jsonl` holds the conversation's current
/// transcript before `external_session_id` is cleared on session detach/rebind.
/// When the next ACP session binds with a new `external_session_id`,
/// `record_session_header` sets `continues_from = Some(conversation_id.simple())`
/// and chains the full prior history automatically.
pub async fn preserve_transcript_before_detach(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    isolate_test_transcripts();
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let turns = load_turns(pool, &summary).await?;
    if turns.is_empty() {
        return Ok(());
    }
    let kind = summary
        .agent_id
        .as_ref()
        .and_then(|id| AgentKind::from_lenient(id.as_ref()));
    let (agent_dir, session_id) = transcript_identity(&summary, kind);
    let root = vibex_acp_transcripts_root();
    let serialized = serialize_transcript(&agent_dir, &session_id, &summary, &turns);
    let _ = acp_transcript::replace_in(&root, &agent_dir, &session_id, serialized).await;
    Ok(())
}

/// Truncate the JSONL transcript so only the first `keep_user_turns` non-steer
/// user turns (and their replies) remain, matching `truncate_to_turn`.
pub async fn truncate_transcript_to_user_ordinal(
    pool: &SqlitePool,
    conversation_id: Uuid,
    keep_user_turns: usize,
) -> Result<(), sqlx::Error> {
    isolate_test_transcripts();
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let turns = load_turns(pool, &summary).await?;
    let kept = slice_turns_by_user_count(&turns, keep_user_turns);
    let kind = summary
        .agent_id
        .as_ref()
        .and_then(|id| AgentKind::from_lenient(id.as_ref()));
    let (agent_dir, session_id) = transcript_identity(&summary, kind);
    let root = vibex_acp_transcripts_root();
    let serialized = serialize_transcript(&agent_dir, &session_id, &summary, &kept);
    let _ = acp_transcript::replace_in(&root, &agent_dir, &session_id, serialized).await;
    if let Some(legacy_sid) = legacy_external_session_id(&summary).as_deref()
        && acp_transcript::transcript_path_in(&root, &agent_dir, legacy_sid)
            .is_some_and(|p| p.is_file())
    {
        let legacy_serialized = serialize_transcript(&agent_dir, legacy_sid, &summary, &kept);
        let _ = acp_transcript::replace_in(&root, &agent_dir, legacy_sid, legacy_serialized).await;
    }
    Ok(())
}

fn slice_turns_by_user_count(turns: &[MessageTurn], keep_user_turns: usize) -> Vec<MessageTurn> {
    if keep_user_turns == 0 {
        return Vec::new();
    }
    let mut seen_users = 0usize;
    let mut out = Vec::new();
    for turn in turns {
        let is_primary_user = matches!(turn.role, TurnRole::User) && !turn.id.contains(":steer:");
        if is_primary_user {
            if seen_users == keep_user_turns {
                break;
            }
            seen_users += 1;
        }
        out.push(turn.clone());
    }
    out
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
    let transcript_turns = load_turns(pool, &source).await?;
    let projected = message_turns(&ConversationProjector::project(pool, source_id).await?);
    let turns = if transcript_turns.len() >= projected.len() {
        transcript_turns
    } else {
        projected
    };
    let mut sliced = turns_through(&turns, until_turn_id);
    if sliced.is_empty()
        && let Some(target_id) = until_turn_id
    {
        let db_turns = ConversationTurnRecord::list_for_conversation(pool, source_id).await?;
        if let Some(pos) = db_turns.iter().position(|turn| turn.id == target_id) {
            sliced = slice_turns_by_user_count(&turns, pos + 1);
        }
    }
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
                steer: turn.id.contains(":steer:"),
                p: Value::Array(prompt_blocks(turn)),
            }),
            TurnRole::Assistant | TurnRole::System => {
                let mut pending_msg_id = turn
                    .agent_message_id
                    .as_deref()
                    .filter(|id| !id.trim().is_empty());
                for block in &turn.blocks {
                    if let Some(mut payload) = update_payload(block) {
                        if let Some(msg_id) = pending_msg_id
                            && payload.get("sessionUpdate").and_then(Value::as_str)
                                == Some("agent_message_chunk")
                        {
                            payload["messageId"] = serde_json::json!(msg_id);
                            pending_msg_id = None;
                        }
                        entries.push(TranscriptEntry {
                            t,
                            k: EntryKind::Update,
                            steer: false,
                            p: payload,
                        });
                    }
                }
                if let Some(msg_id) = pending_msg_id {
                    entries.push(TranscriptEntry {
                        t,
                        k: EntryKind::Update,
                        steer: false,
                        p: serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "messageId": msg_id,
                            "content": { "type": "text", "text": "" }
                        }),
                    });
                }
                if turn.completed_at.is_some()
                    || turn.usage.is_some()
                    || turn.duration_ms.is_some()
                    || turn.model.is_some()
                {
                    let mut end = serde_json::json!({ "stopReason": "end_turn" });
                    if let Some(ms) = turn.duration_ms {
                        end["durationMs"] = serde_json::json!(ms);
                    }
                    if let Some(model) = &turn.model {
                        end["model"] = serde_json::json!(model);
                    }
                    if let Some(usage) = &turn.usage {
                        let mut usage_json = serde_json::json!({
                            "inputTokens": usage.input_tokens,
                            "outputTokens": usage.output_tokens,
                            "cacheCreationInputTokens": usage.cache_creation_input_tokens,
                            "cacheReadInputTokens": usage.cache_read_input_tokens,
                        });
                        if let Some(used) = usage.context_used.filter(|v| *v > 0) {
                            usage_json["contextUsed"] = serde_json::json!(used);
                        }
                        if let Some(max) = usage.context_window_max.filter(|v| *v > 0) {
                            usage_json["contextWindowMax"] = serde_json::json!(max);
                        }
                        end["usage"] = usage_json;
                    }
                    entries.push(TranscriptEntry {
                        t: turn.completed_at.map(millis).unwrap_or(t),
                        k: EntryKind::TurnEnd,
                        steer: false,
                        p: end,
                    });
                }
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
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => {
                blocks.push(serde_json::json!({
                    "type": "image",
                    "data": data,
                    "mimeType": mime_type,
                    "uri": uri,
                }));
            }
            ContentBlock::Resource { uri, title } => {
                blocks.push(serde_json::json!({
                    "type": "resource_link",
                    "uri": uri,
                    "name": title.clone().unwrap_or_else(|| uri.clone()),
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
        ContentBlock::Image {
            data,
            mime_type,
            uri,
            ..
        } => Some(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {
                "type": "image",
                "data": data,
                "mimeType": mime_type,
                "uri": uri,
            }
        })),
        ContentBlock::Resource { uri, title } => Some(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {
                "type": "resource_link",
                "uri": uri,
                "name": title.clone().unwrap_or_else(|| uri.clone()),
            }
        })),
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            kind,
            status,
            images,
            ..
        } => {
            let mut obj = serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": tool_use_id.clone().unwrap_or_else(|| "tool".to_string()),
                "title": tool_name,
                "kind": normalize_acp_tool_kind(kind.as_deref()),
                "status": normalize_acp_tool_status(status.as_deref().unwrap_or("completed")),
                "rawInput": raw_input(input_preview),
            });
            if !images.is_empty() {
                obj["content"] = Value::Array(
                    images
                        .iter()
                        .map(|img| {
                            serde_json::json!({
                                "type": "content",
                                "content": {
                                    "type": "image",
                                    "data": img.data,
                                    "mimeType": img.mime_type,
                                    "uri": img.uri,
                                }
                            })
                        })
                        .collect(),
                );
            }
            Some(obj)
        }
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            let mut content = Vec::new();
            if let Some(text) = output_preview.as_ref().filter(|text| !text.is_empty()) {
                content.push(serde_json::json!({
                    "type": "content",
                    "content": { "type": "text", "text": text }
                }));
            }
            Some(serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": tool_use_id.clone().unwrap_or_else(|| "tool".to_string()),
                "status": if *is_error { "failed" } else { "completed" },
                "content": content,
            }))
        }
        ContentBlock::Plan { entries } => Some(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "acp-plan",
            "title": "TodoWrite",
            "kind": "think",
            "status": "completed",
            "rawInput": { "todos": entries },
        })),
        _ => None,
    }
}

fn raw_input(preview: &Option<String>) -> Value {
    match preview {
        Some(text) => {
            serde_json::from_str(text).unwrap_or_else(|_| serde_json::json!({ "text": text }))
        }
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
    let mut any_tokens = false;
    let mut any_usage = false;
    let mut duration = 0u64;
    let mut context_used: Option<u64> = None;
    let mut context_max: Option<u64> = None;
    for turn in turns {
        if let Some(usage) = &turn.usage {
            any_usage = true;
            let turn_tokens = usage.input_tokens
                + usage.output_tokens
                + usage.cache_creation_input_tokens
                + usage.cache_read_input_tokens;
            if turn_tokens > 0 {
                any_tokens = true;
            }
            total.input_tokens += usage.input_tokens;
            total.output_tokens += usage.output_tokens;
            total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            total.cache_read_input_tokens += usage.cache_read_input_tokens;
            if let Some(max) = usage.context_window_max.filter(|v| *v > 0) {
                context_max = Some(max);
                context_used = usage
                    .context_used
                    .filter(|v| *v > 0)
                    .or_else(|| (turn_tokens > 0).then_some(turn_tokens));
            } else if let Some(used) = usage.context_used.filter(|v| *v > 0) {
                context_used = Some(used);
            }
        }
        if let Some(ms) = turn.duration_ms {
            duration += ms;
        }
    }
    if !any_usage && duration == 0 {
        return None;
    }
    let total_tokens = any_tokens.then(|| {
        total.input_tokens
            + total.output_tokens
            + total.cache_creation_input_tokens
            + total.cache_read_input_tokens
    });
    let context_window_usage_percent = match (context_used, context_max.filter(|max| *max > 0)) {
        (Some(used), Some(max)) => Some((used as f64 / max as f64) * 100.0),
        _ => None,
    };
    Some(SessionStats {
        total_usage: any_tokens.then_some(total),
        total_tokens,
        total_duration_ms: duration,
        context_window_used_tokens: context_used,
        context_window_max_tokens: context_max,
        context_window_usage_percent,
    })
}

fn normalize_acp_tool_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "running" | "in_progress" | "inprogress" => "in_progress",
        "completed" | "done" | "success" | "succeeded" => "completed",
        "failed" | "error" | "cancelled" | "canceled" => "failed",
        _ => "pending",
    }
}

fn normalize_acp_tool_kind(kind: Option<&str>) -> &'static str {
    match kind.unwrap_or("other").trim().to_ascii_lowercase().as_str() {
        "read" => "read",
        "edit" | "write" | "patch" => "edit",
        "delete" => "delete",
        "move" => "move",
        "search" | "grep" | "glob" | "find" => "search",
        "execute" | "bash" | "command" | "terminal" => "execute",
        "think" => "think",
        "fetch" | "web" | "http" => "fetch",
        "switch_mode" | "switchmode" => "switch_mode",
        _ => "other",
    }
}

pub fn default_tail() -> TurnWindowReq {
    TurnWindowReq::Tail(TAIL_TURNS_DEFAULT)
}

pub fn parse_window(
    tail_turns: Option<u32>,
    from_index: Option<u32>,
) -> Result<TurnWindowReq, String> {
    match (tail_turns, from_index) {
        (Some(_), Some(_)) => Err("tailTurns and fromIndex are mutually exclusive".to_string()),
        (None, Some(index)) => Ok(TurnWindowReq::FromIndex(index as usize)),
        (Some(tail), None) => Ok(TurnWindowReq::Tail(tail as usize)),
        (None, None) => Ok(default_tail()),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

    use agents::{
        AgentAutoApproveMode, AgentContentBlock, AgentId, AgentRuntime, CancelAgentPromptInput,
        EnsureAgentSessionInput, NoopEventSink, SendAgentPromptInput, SessionLaunchLock,
    };
    use chrono::TimeZone;

    use super::*;

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

    fn row_phase(row: &TimelineRow) -> &str {
        match &row.row {
            ConversationTimelineRow::MessageTurn { phase, .. } => phase,
            other => panic!("expected a message turn, got {other:?}"),
        }
    }

    #[test]
    fn open_assistant_tail_streams_with_the_user_before_it() {
        let user = turn(TurnRole::User, "second", 1_700_000_010);
        let mut assistant = turn(TurnRole::Assistant, "working", 1_700_000_011);
        assistant.completed_at = None;
        let rows = rows_from_turns(&[user.clone(), assistant]);
        assert_eq!(row_phase(&rows[0]), "streaming");
        assert_eq!(row_phase(&rows[1]), "streaming");

        let mut closed = turn(TurnRole::Assistant, "done", 1_700_000_012);
        closed.completed_at = Some(Utc.timestamp_opt(1_700_000_012, 0).unwrap());
        let settled = rows_from_turns(&[user.clone(), closed]);
        assert_eq!(row_phase(&settled[0]), "settled");
        assert_eq!(row_phase(&settled[1]), "settled");

        let lone = rows_from_turns(&[user]);
        assert_eq!(row_phase(&lone[0]), "settled");
    }

    #[test]
    fn migrated_turns_round_trip_user_text() {
        let mut assistant = turn(TurnRole::Assistant, "hi there", 1_700_000_002);
        assistant.completed_at = Some(Utc.timestamp_opt(1_700_000_003, 0).unwrap());
        let turns = vec![turn(TurnRole::User, "hello", 1_700_000_001), assistant];
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
        assert!(read[1].completed_at.is_some());
    }

    #[test]
    fn encode_turns_round_trips_agent_message_id_and_assistant_images() {
        let mut user = turn(TurnRole::User, "check file", 1_700_000_001);
        user.blocks.push(ContentBlock::Resource {
            uri: "file:///workspace/README.md".into(),
            title: Some("README.md".into()),
        });
        let mut assistant = turn(TurnRole::Assistant, "here is the image", 1_700_000_002);
        assistant.agent_message_id = Some("msg_claude_42".into());
        assistant.blocks.push(ContentBlock::Image {
            data: "aGVsbG8=".into(),
            mime_type: "image/png".into(),
            uri: Some("file:///shot.png".into()),
            width: None,
            height: None,
        });
        assistant.completed_at = Some(Utc.timestamp_opt(1_700_000_003, 0).unwrap());

        let read = project_turns(&encode_turns(&[user, assistant]));
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].blocks.len(), 2);
        assert_eq!(read[1].agent_message_id.as_deref(), Some("msg_claude_42"));
        assert!(
            read[1]
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Image { .. }))
        );
    }

    #[test]
    fn migrated_tool_turns_round_trip_through_acp_native() {
        let mut assistant = turn(TurnRole::Assistant, "running command", 1_700_000_002);
        assistant.blocks.push(ContentBlock::ToolUse {
            tool_use_id: Some("call-1".into()),
            tool_name: "Run bash".into(),
            input_preview: Some(r#"{"command":"cargo test"}"#.into()),
            kind: Some("bash".into()),
            status: Some("running".into()),
            meta: None,
            started_at: None,
            ended_at: None,
            images: Vec::new(),
        });
        assistant.blocks.push(ContentBlock::ToolResult {
            tool_use_id: Some("call-1".into()),
            output_preview: Some("ok".into()),
            is_error: false,
            agent_stats: None,
        });
        assistant.completed_at = Some(Utc.timestamp_opt(1_700_000_003, 0).unwrap());

        let turns = vec![turn(TurnRole::User, "go", 1_700_000_001), assistant];
        let read = project_turns(&encode_turns(&turns));
        assert_eq!(read.len(), 2);
        assert_eq!(read[1].blocks.len(), 3);
        match &read[1].blocks[1] {
            ContentBlock::ToolUse {
                tool_name,
                kind,
                status,
                input_preview,
                ..
            } => {
                assert_eq!(tool_name, "Run bash");
                assert_eq!(kind.as_deref(), Some("execute"));
                assert_eq!(status.as_deref(), Some("completed"));
                assert_eq!(
                    input_preview.as_deref(),
                    Some(r#"{"command":"cargo test"}"#)
                );
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
        match &read[1].blocks[2] {
            ContentBlock::ToolResult {
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(output_preview.as_deref(), Some("ok"));
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    async fn wait_for_idle_session(runtime: &AgentRuntime, session_id: agents::AgentSessionId) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let snapshot = runtime.snapshot().await;
                let idle = snapshot
                    .sessions
                    .iter()
                    .find(|candidate| candidate.id == session_id)
                    .is_some_and(|session| session.active_prompt_id.is_none());
                if idle {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("session should settle to idle after cancel");
    }

    #[tokio::test]
    async fn runtime_records_three_turns_with_display_blocks_and_reloads_cleanly() {
        isolate_test_transcripts();
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let conversation_id = Uuid::new_v4();
        let session_id = agents::AgentSessionId::from(conversation_id);
        let launch_lock = SessionLaunchLock {
            agent_id: AgentId::parse("codex").unwrap(),
            absolute_acp_program: PathBuf::from("/tmp/vibex-test-acp"),
            args: Vec::new(),
            env: BTreeMap::new(),
            runtime_version: "test-runtime".to_string(),
            acp_version: "test-acp".to_string(),
        };
        let prepared = runtime
            .prepare_session(EnsureAgentSessionInput {
                agent_id: AgentId::parse("codex").unwrap(),
                launch_lock,
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
                additional_directories: Vec::new(),
                session_id,
                acp_session_id: String::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: Default::default(),
                preferences: Default::default(),
            })
            .await
            .expect("prepare in-memory session");
        let connection_id = prepared.session.connection_id;
        let acp_sid = prepared.session.acp_session_id;
        let root = vibex_acp_transcripts_root();

        // Turn 1
        let p1 = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id,
                session_id,
                blocks: vec![AgentContentBlock::Text {
                    text: "AI 1".into(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .expect("send turn 1");
        runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id,
                session_id,
                prompt_id: p1.id,
            })
            .await
            .expect("settle turn 1");
        wait_for_idle_session(&runtime, session_id).await;

        // Turn 2: wire blocks include a smart reminder, display_blocks has only user display_text + image
        let p2 = runtime
            .send_prompt_with_display_blocks(
                SendAgentPromptInput {
                    connection_id,
                    session_id,
                    blocks: vec![
                        AgentContentBlock::Text {
                            text: "AI 2\n\n<system-reminder>smart reminder</system-reminder>"
                                .into(),
                        },
                        AgentContentBlock::Image {
                            data: "aGVsbG8=".into(),
                            mime_type: "image/png".into(),
                            uri: Some("file:///screen.png".into()),
                        },
                    ],
                    mode_override: None,
                    config_overrides: Vec::new(),
                },
                Some(vec![
                    AgentContentBlock::Text {
                        text: "User 2".into(),
                    },
                    AgentContentBlock::Image {
                        data: "aGVsbG8=".into(),
                        mime_type: "image/png".into(),
                        uri: Some("file:///screen.png".into()),
                    },
                ]),
            )
            .await
            .expect("send turn 2");
        runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id,
                session_id,
                prompt_id: p2.id,
            })
            .await
            .expect("settle turn 2");
        wait_for_idle_session(&runtime, session_id).await;

        // Turn 3
        let p3 = runtime
            .send_prompt_with_display_blocks(
                SendAgentPromptInput {
                    connection_id,
                    session_id,
                    blocks: vec![AgentContentBlock::Text {
                        text: "AI 3".into(),
                    }],
                    mode_override: None,
                    config_overrides: Vec::new(),
                },
                Some(vec![AgentContentBlock::Text {
                    text: "User 3".into(),
                }]),
            )
            .await
            .expect("send turn 3");

        // Mid-stream check before Turn 3 settles:
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let _ = acp_transcript::flush_in(&root, "codex", &acp_sid).await;
                let chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
                let prompts = chain
                    .entries
                    .iter()
                    .filter(|e| e.k == EntryKind::Prompt)
                    .count();
                let updates = chain
                    .entries
                    .iter()
                    .filter(|e| e.k == EntryKind::Update)
                    .count();
                if prompts == 3 && updates >= 3 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("3 prompts and 3 updates recorded mid-stream");

        let mid_chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
        let mid_turns = project_turns(&mid_chain.entries);
        assert_eq!(mid_turns.len(), 6);
        let mid_rows = rows_from_turns(&mid_turns);
        assert_eq!(row_phase(&mid_rows[4]), "streaming");
        assert_eq!(row_phase(&mid_rows[5]), "streaming");

        // Settle Turn 3
        runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id,
                session_id,
                prompt_id: p3.id,
            })
            .await
            .expect("settle turn 3");
        wait_for_idle_session(&runtime, session_id).await;

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let _ = acp_transcript::flush_in(&root, "codex", &acp_sid).await;
                let chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
                let turn_ends = chain
                    .entries
                    .iter()
                    .filter(|e| e.k == EntryKind::TurnEnd)
                    .count();
                if turn_ends == 3 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("3 turn_ends recorded");

        let settled_chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
        let kinds: Vec<EntryKind> = settled_chain.entries.iter().map(|e| e.k).collect();
        assert_eq!(
            kinds,
            vec![
                EntryKind::Prompt,
                EntryKind::Update,
                EntryKind::TurnEnd,
                EntryKind::Prompt,
                EntryKind::Update,
                EntryKind::TurnEnd,
                EntryKind::Prompt,
                EntryKind::Update,
                EntryKind::TurnEnd,
            ]
        );

        let settled_turns = project_turns(&settled_chain.entries);
        assert_eq!(settled_turns.len(), 6);
        // Turn 2 user bubble must have "User 2" (display_text) + Image, NOT "<system-reminder>"
        match &settled_turns[2].blocks[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text, "User 2");
                assert!(!text.contains("system-reminder"));
            }
            other => panic!("expected text block, got {other:?}"),
        }
        assert!(matches!(
            settled_turns[2].blocks[1],
            ContentBlock::Image { .. }
        ));
    }

    #[tokio::test]
    async fn three_consecutive_wire_recorded_turns_preserve_order_display_text_and_tools() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();
        let agent_dir = "codex";
        let session_id = "conv-three-turns";

        let header = TranscriptHeader::new(agent_dir, session_id, "/workspace", 1_700_000_000_000);
        let _ = acp_transcript::record_header_in(root, agent_dir, &header).await;

        // Turn 1: User 1 -> AI 1 -> TurnEnd 1
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "User 1" }]),
        )
        .await;
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "AI 1" }
            }),
        );
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "end_turn", "durationMs": 120 }),
        )
        .await;

        // Turn 2: smart reminder separation — wire sent agent_text with reminder,
        // but display_blocks recorded user-visible display_text ("User 2") + image.
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Prompt,
            serde_json::json!([
                { "type": "text", "text": "User 2" },
                { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png", "uri": "file:///screen.png" }
            ]),
        )
        .await;
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "AI 2" }
            }),
        );
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "end_turn", "durationMs": 150 }),
        )
        .await;

        // Turn 3: User 3 -> AI 3 with ToolCall + ToolCallUpdate (check mid-stream first)
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "User 3" }]),
        )
        .await;
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "AI 3" }
            }),
        );
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-42",
                "title": "Run cargo test",
                "kind": "execute",
                "status": "in_progress",
                "rawInput": { "command": "cargo test" }
            }),
        );
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-42",
                "status": "completed",
                "content": [
                    {
                        "type": "content",
                        "content": { "type": "text", "text": "test result: ok." }
                    }
                ]
            }),
        );
        let _ = acp_transcript::flush_in(root, agent_dir, session_id).await;

        // Mid-stream check before Turn 3 TurnEnd:
        let mid_stream_chain = acp_transcript::read_chain_in(root, agent_dir, session_id);
        let mid_turns = project_turns(&mid_stream_chain.entries);
        let mid_rows = rows_from_turns(&mid_turns);
        let mid_labels: Vec<String> = mid_rows
            .iter()
            .map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => match &turn.blocks[0] {
                    ContentBlock::Text { text } => text.clone(),
                    other => panic!("expected text block, got {other:?}"),
                },
                other => panic!("expected message turn, got {other:?}"),
            })
            .collect();
        assert_eq!(
            mid_labels,
            vec!["User 1", "AI 1", "User 2", "AI 2", "User 3", "AI 3"]
        );
        assert_eq!(row_phase(&mid_rows[4]), "streaming");
        assert_eq!(row_phase(&mid_rows[5]), "streaming");

        // Settle Turn 3 with a single TurnEnd:
        let _ = acp_transcript::record_entry_in(
            root,
            agent_dir,
            session_id,
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "end_turn", "durationMs": 210 }),
        )
        .await;

        let settled_chain = acp_transcript::read_chain_in(root, agent_dir, session_id);
        let kinds: Vec<EntryKind> = settled_chain.entries.iter().map(|e| e.k).collect();
        assert_eq!(
            kinds,
            vec![
                EntryKind::Prompt,
                EntryKind::Update,
                EntryKind::TurnEnd,
                EntryKind::Prompt,
                EntryKind::Update,
                EntryKind::TurnEnd,
                EntryKind::Prompt,
                EntryKind::Update,
                EntryKind::Update,
                EntryKind::Update,
                EntryKind::TurnEnd,
            ]
        );
        assert_eq!(kinds.iter().filter(|&&k| k == EntryKind::Prompt).count(), 3);
        assert_eq!(
            kinds.iter().filter(|&&k| k == EntryKind::TurnEnd).count(),
            3
        );

        let settled_turns = project_turns(&settled_chain.entries);
        let settled_rows = rows_from_turns(&settled_turns);
        let settled_labels: Vec<String> = settled_rows
            .iter()
            .map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => match &turn.blocks[0] {
                    ContentBlock::Text { text } => text.clone(),
                    other => panic!("expected text block, got {other:?}"),
                },
                other => panic!("expected message turn, got {other:?}"),
            })
            .collect();
        assert_eq!(
            settled_labels,
            vec!["User 1", "AI 1", "User 2", "AI 2", "User 3", "AI 3"]
        );
        assert!(settled_rows.iter().all(|row| row_phase(row) == "settled"));

        // Verify Turn 2 user bubble has display_text ("User 2") + image, not the smart reminder:
        assert_eq!(settled_turns[2].blocks.len(), 2);
        match &settled_turns[2].blocks[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text, "User 2");
                assert!(!text.contains("system-reminder"));
            }
            other => panic!("expected text block, got {other:?}"),
        }
        assert!(matches!(
            settled_turns[2].blocks[1],
            ContentBlock::Image { .. }
        ));

        // Verify Turn 3 tool call title, input, output, and status survived reload:
        assert_eq!(settled_turns[5].blocks.len(), 3);
        match &settled_turns[5].blocks[1] {
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                kind,
                status,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-42"));
                assert_eq!(tool_name, "Run cargo test");
                assert_eq!(
                    input_preview.as_deref(),
                    Some(r#"{"command":"cargo test"}"#)
                );
                assert_eq!(kind.as_deref(), Some("execute"));
                assert_eq!(status.as_deref(), Some("completed"));
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
        match &settled_turns[5].blocks[2] {
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-42"));
                assert_eq!(output_preview.as_deref(), Some("test result: ok."));
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn transcript_deltas_skip_the_event_log() {
        assert!(is_transcript_delta(
            &ConversationEvent::AssistantTextDelta {
                text: "a".into(),
                message_id: None,
            }
        ));
        assert!(is_transcript_delta(&ConversationEvent::PlanUpdated {
            entries: Vec::new(),
        }));
        assert!(!is_transcript_delta(&ConversationEvent::TurnCompleted {
            stop_reason: None
        }));
        assert!(!is_transcript_delta(&ConversationEvent::UserTurnQueued));
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

    #[test]
    fn slice_turns_by_user_count_preserves_steer_turns_within_kept_turns() {
        let mut u1 = turn(TurnRole::User, "u1", 1);
        u1.id = "acp-0".into();
        let mut a1 = turn(TurnRole::Assistant, "a1", 2);
        a1.id = "acp-1".into();
        let mut s1 = turn(TurnRole::User, "s1", 3);
        s1.id = "acp-2:steer:1".into();
        let mut a2 = turn(TurnRole::Assistant, "a2", 4);
        a2.id = "acp-3".into();
        let mut u2 = turn(TurnRole::User, "u2", 5);
        u2.id = "acp-4".into();
        let mut a3 = turn(TurnRole::Assistant, "a3", 6);
        a3.id = "acp-5".into();

        let kept = slice_turns_by_user_count(&[u1, a1, s1, a2, u2, a3], 1);
        assert_eq!(kept.len(), 4);
        assert_eq!(kept.last().unwrap().id, "acp-3");
    }

    #[test]
    fn session_stats_of_includes_context_window_occupancy_and_percent() {
        let mut u1 = turn(TurnRole::User, "u1", 1);
        u1.id = "acp-0".into();
        let mut a1 = turn(TurnRole::Assistant, "a1", 2);
        a1.id = "acp-1".into();
        a1.duration_ms = Some(1500);
        a1.usage = Some(TurnUsage {
            input_tokens: 4_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            context_used: Some(25_000),
            context_window_max: Some(200_000),
            cost_amount: None,
            cost_currency: None,
        });

        let stats = session_stats_of(&[u1, a1]).expect("session stats present");
        assert_eq!(stats.total_tokens, Some(5_000));
        assert_eq!(stats.total_duration_ms, 1500);
        assert_eq!(stats.context_window_used_tokens, Some(25_000));
        assert_eq!(stats.context_window_max_tokens, Some(200_000));
        assert_eq!(stats.context_window_usage_percent, Some(12.5));
    }

    #[test]
    fn timeline_from_window_appends_persisted_side_rows_and_fork_status() {
        let conv_id = Uuid::new_v4();
        let mut u1 = turn(TurnRole::User, "u1", 1);
        u1.id = "acp-0".into();
        let mut a1 = turn(TurnRole::Assistant, "a1", 2);
        a1.id = "acp-1".into();
        let error_row = TimelineRow {
            row_id: format!("err:{}:7|user=acp-0|assistant=acp-1", Uuid::new_v4()),
            revision: 7,
            row: ConversationTimelineRow::TurnError {
                error: agents::conversation::ConversationErrorView {
                    turn_id: Some(Uuid::new_v4()),
                    error: agents::conversation::ConversationError {
                        message: "Rate limit exceeded".to_string(),
                        code: Some("rate_limit".to_string()),
                        raw: None,
                        kind: Default::default(),
                        plan_usage: None,
                    },
                },
            },
        };
        let turns = vec![u1, a1];
        let meta = turn_window::window_meta(&turns, 0);
        let mut fork_point_statuses = HashMap::new();
        fork_point_statuses.insert("acp-1".to_string(), agents::ForkPointStatus::Tail);
        let history = WindowedHistory {
            turns,
            side_rows: vec![error_row.clone()],
            fork_point_statuses,
            offset: 0,
            total: 2,
            meta,
            session_stats: None,
            last_sequence: 7,
        };
        let timeline = timeline_from_window(conv_id, &history);
        assert_eq!(timeline.rows.len(), 3);
        assert_eq!(timeline.rows[0].row_id, "acp-0");
        assert_eq!(timeline.rows[1].row_id, "acp-1");
        match &timeline.rows[1].row {
            ConversationTimelineRow::MessageTurn {
                fork_point_status, ..
            } => assert_eq!(*fork_point_status, Some(agents::ForkPointStatus::Tail)),
            other => panic!("expected message turn, got {other:?}"),
        }
        assert_eq!(timeline.rows[2].row_id, error_row.row_id);
        assert!(matches!(
            timeline.rows[2].row,
            ConversationTimelineRow::TurnError { .. }
        ));
    }
}
