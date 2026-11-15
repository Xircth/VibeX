//! UI transcript. The file under `acp-transcripts/` is the history the window
//! protocol slices, and content deltas are appended there instead of
//! `conversation_events`. Open and older-page reads do not fold the event log.

use std::collections::HashMap;

use agents::{
    AgentKind,
    acp_transcript::{
        self, EntryKind, TranscriptHeader, safe_component, vibex_acp_transcripts_root,
    },
    conversation::{
        ContentBlock, ConversationEvent, ConversationTimeline, ConversationTimelineRow,
        MessageTurn, SessionStats, TimelineRow, TurnRole, TurnUsage,
    },
    parsers::{acp_native::project_turns_for, loader::load_import_conversation_detail},
};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    projection::{CONVERSATION_PROJECTION_VERSION, ConversationProjector},
    turn_window::{self, TurnWindowReq, WindowMeta},
};

#[path = "jsonl_history_codec.rs"]
mod codec;
pub use self::codec::encode_turns;

const TAIL_TURNS_DEFAULT: usize = 120;

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
    let mut fallback_turns: Option<Vec<MessageTurn>> = None;
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
        let kind = AgentKind::from_lenient(&agent_dir);
        for sid in &candidates {
            let chain = acp_transcript::read_chain_in(&root, &agent_dir, sid);
            if chain.entries.is_empty() {
                continue;
            }
            let turns = project_turns_for(&chain.entries, kind);
            if turns.is_empty() {
                continue;
            }
            if chain
                .entries
                .iter()
                .any(|entry| matches!(entry.k, EntryKind::Update | EntryKind::TurnEnd))
            {
                return Some(turns);
            }
            if fallback_turns.is_none() {
                fallback_turns = Some(turns);
            }
        }
    }
    fallback_turns
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
            };
            let Some(agent_dir) = dir_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            for sid in &candidates {
                let _ = acp_transcript::flush_in(&root, &agent_dir, sid).await;
                for ancestor in acp_transcript::continuation_ancestors_in(&root, &agent_dir, sid) {
                    let _ = acp_transcript::flush_in(&root, &agent_dir, &ancestor).await;
                }
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
        let dir = utils::path::get_vibex_temp_dir()
            .join(format!("acp-transcripts-{}", std::process::id()));
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
    if all.is_empty()
        && ConversationTurnRecord::list_for_conversation(pool, conversation_id)
            .await
            .map(|turns| turns.is_empty())
            .unwrap_or(false)
    {
        side_rows.retain(|row| row.row_id != "notice:agent-binding-load-failed");
    }
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
    let user_texts_by_turn_id = load_db_turn_user_texts(pool, conversation_id).await;
    let by_turn_uuid = pair_db_turns_with_acp_rounds(&db_turns, &user_texts_by_turn_id, all_turns);
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

async fn load_db_turn_user_texts(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> HashMap<Uuid, String> {
    let rows: Vec<(Option<Uuid>, String)> = sqlx::query_as(
        r#"SELECT turn_id, normalized_json
           FROM conversation_events
           WHERE conversation_id = ? AND event_kind = 'user_turn_created'
           ORDER BY sequence ASC"#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let mut map = HashMap::new();
    for (turn_id, json) in rows {
        let Some(turn_id) = turn_id else {
            continue;
        };
        if let Ok(ConversationEvent::UserTurnCreated { blocks, .. }) =
            serde_json::from_str::<ConversationEvent>(&json)
        {
            let text = blocks
                .into_iter()
                .filter_map(|block| match block {
                    agents::conversation::ConversationInputBlock::Text { text } => {
                        let trimmed = text.trim();
                        (!trimmed.is_empty()).then(|| trimmed.to_string())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            map.insert(turn_id, text);
        }
    }
    map
}

fn turn_visible_user_text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => {
                let trimmed = text.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn pair_db_turns_with_acp_rounds(
    db_turns: &[ConversationTurnRecord],
    user_texts_by_turn_id: &HashMap<Uuid, String>,
    all_turns: &[MessageTurn],
) -> HashMap<Uuid, (String, Option<String>)> {
    let rounds = non_steer_rounds_acp_ids_with_text(all_turns);
    let mut by_turn_uuid: HashMap<Uuid, (String, Option<String>)> = HashMap::new();
    if db_turns.len() == rounds.len() {
        for (db_turn, (user_id, assistant_id, _)) in db_turns.iter().zip(rounds) {
            by_turn_uuid.insert(db_turn.id, (user_id, assistant_id));
        }
        return by_turn_uuid;
    }

    let mut db_index = 0usize;
    for (round_index, (user_id, assistant_id, round_text)) in rounds.into_iter().enumerate() {
        let remaining_rounds = all_turns
            .iter()
            .filter(|turn| matches!(turn.role, TurnRole::User) && !turn.id.contains(":steer:"))
            .count()
            .saturating_sub(round_index);
        while db_index < db_turns.len() {
            let remaining_db = db_turns.len() - db_index;
            let candidate = &db_turns[db_index];
            if remaining_db <= remaining_rounds {
                break;
            }
            let candidate_text = user_texts_by_turn_id
                .get(&candidate.id)
                .map(String::as_str)
                .unwrap_or("");
            let candidate_aborted = matches!(
                candidate.status.as_str(),
                "failed" | "cancelled" | "interrupted"
            );
            let next_matches_better = db_turns[db_index + 1..].iter().any(|later| {
                let later_text = user_texts_by_turn_id
                    .get(&later.id)
                    .map(String::as_str)
                    .unwrap_or("");
                (!round_text.is_empty() && later_text == round_text && candidate_text != round_text)
                    || (later_text == round_text
                        && candidate_aborted
                        && assistant_id.is_some()
                        && later.status == "completed")
            });
            if next_matches_better
                || (candidate_aborted && candidate_text != round_text && !round_text.is_empty())
            {
                db_index += 1;
                continue;
            }
            break;
        }
        if let Some(matched) = db_turns.get(db_index) {
            by_turn_uuid.insert(matched.id, (user_id, assistant_id));
            db_index += 1;
        }
    }
    by_turn_uuid
}

fn non_steer_rounds_acp_ids_with_text(
    all_turns: &[MessageTurn],
) -> Vec<(String, Option<String>, String)> {
    let mut rounds: Vec<(String, Option<String>, String)> = Vec::new();
    for turn in all_turns {
        if matches!(turn.role, TurnRole::User) && !turn.id.contains(":steer:") {
            rounds.push((turn.id.clone(), None, turn_visible_user_text(turn)));
        } else if matches!(turn.role, TurnRole::Assistant)
            && let Some(last_round) = rounds.last_mut()
        {
            last_round.1 = Some(turn.id.clone());
        }
    }
    rounds
}

pub fn non_steer_rounds_acp_ids(all_turns: &[MessageTurn]) -> Vec<(String, Option<String>)> {
    non_steer_rounds_acp_ids_with_text(all_turns)
        .into_iter()
        .map(|(user_id, assistant_id, _)| (user_id, assistant_id))
        .collect()
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
        ConversationAgentBindingRecord::active_for_conversation(pool, conversation_id).await?
    else {
        return Ok(statuses);
    };
    let segments = db::models::conversation_transcript::ConversationTranscriptSegment::list(
        pool,
        conversation_id,
    )
    .await?;
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
        if let Some(segment_id) = turn
            .id
            .strip_prefix("segment:")
            .and_then(|id| id.split(':').next())
            .and_then(|id| Uuid::parse_str(id).ok())
            && !segments
                .iter()
                .any(|segment| segment.id == segment_id && segment.binding_id == Some(binding.id))
        {
            statuses.insert(turn.id.clone(), agents::ForkPointStatus::Unsupported);
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
    if let Some(turns) =
        crate::transcript_segments::read_in(pool, &vibex_acp_transcripts_root(), summary.id).await?
    {
        return Ok(turns);
    }
    let bindings = ConversationAgentBindingRecord::list_for_conversation(pool, summary.id)
        .await
        .unwrap_or_default();
    let effective_agent_id = summary
        .agent_id
        .as_ref()
        .or_else(|| bindings.last().map(|binding| &binding.agent_id));
    let kind = effective_agent_id.and_then(|id| AgentKind::from_lenient(id.as_ref()));
    let (agent_dir, session_id) = transcript_identity_with_agent(summary, effective_agent_id, kind);
    let root = vibex_acp_transcripts_root();

    let recovered_ancestors: Vec<String> = sqlx::query_scalar::<_, String>(
        r#"SELECT normalized_json
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind = 'agent_binding_recovered'
           ORDER BY sequence DESC"#,
    )
    .bind(summary.id)
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .filter_map(|json| {
        serde_json::from_str::<serde_json::Value>(&json)
            .ok()?
            .get("continues_from")?
            .as_str()
            .map(str::trim)
            .filter(|sid| !sid.is_empty() && safe_component(sid))
            .map(str::to_string)
    })
    .collect();

    let mut candidates: Vec<String> = Vec::new();
    let mut push_candidate = |sid: &str| {
        let trimmed = sid.trim();
        if !trimmed.is_empty()
            && safe_component(trimmed)
            && !candidates.iter().any(|existing| existing == trimmed)
        {
            candidates.push(trimmed.to_string());
        }
    };
    if let Some(legacy_sid) = legacy_external_session_id(summary) {
        push_candidate(&legacy_sid);
    }
    for binding in bindings.iter().rev() {
        if let Some(acp_sid) = binding.acp_session_id.as_deref() {
            push_candidate(acp_sid);
        }
    }
    for ancestor in &recovered_ancestors {
        push_candidate(ancestor);
    }
    push_candidate(&session_id);
    push_candidate(&summary.id.to_string());

    for sid in &candidates {
        let _ = acp_transcript::flush_in(&root, &agent_dir, sid).await;
        for ancestor in acp_transcript::continuation_ancestors_in(&root, &agent_dir, sid) {
            let _ = acp_transcript::flush_in(&root, &agent_dir, &ancestor).await;
        }
    }

    let stitch_recovered_ancestors =
        |head_sid: &str, mut entries: Vec<acp_transcript::TranscriptEntry>| {
            if recovered_ancestors.is_empty() && bindings.len() <= 1 {
                return entries;
            }
            let mut visited: std::collections::HashSet<String> =
                acp_transcript::continuation_ancestors_in(&root, &agent_dir, head_sid)
                    .into_iter()
                    .collect();
            visited.insert(head_sid.to_string());
            if visited.contains(&session_id) {
                return entries;
            }
            let mut chronological_ancestors: Vec<String> = Vec::new();
            for binding in &bindings {
                let Some(acp_sid) = binding.acp_session_id.as_deref().map(str::trim) else {
                    continue;
                };
                if acp_sid == head_sid {
                    break;
                }
                if !acp_sid.is_empty()
                    && safe_component(acp_sid)
                    && !chronological_ancestors
                        .iter()
                        .any(|existing| existing == acp_sid)
                {
                    chronological_ancestors.push(acp_sid.to_string());
                }
            }
            // `recovered_ancestors` is newest -> oldest; iterate in reverse for chronological order.
            for ancestor_sid in recovered_ancestors.iter().rev() {
                if !chronological_ancestors
                    .iter()
                    .any(|existing| existing == ancestor_sid)
                {
                    chronological_ancestors.push(ancestor_sid.clone());
                }
            }
            let mut prefix_entries = Vec::new();
            for ancestor_sid in &chronological_ancestors {
                if !visited.insert(ancestor_sid.clone()) {
                    continue;
                }
                for chained in
                    acp_transcript::continuation_ancestors_in(&root, &agent_dir, ancestor_sid)
                {
                    visited.insert(chained);
                }
                let mut ancestor_chain =
                    acp_transcript::read_chain_in(&root, &agent_dir, ancestor_sid);
                if ancestor_chain
                    .entries
                    .iter()
                    .any(|entry| matches!(entry.k, EntryKind::Update | EntryKind::TurnEnd))
                {
                    prefix_entries.append(&mut ancestor_chain.entries);
                }
            }
            if prefix_entries.is_empty()
                && head_sid != session_id
                && visited.insert(session_id.clone())
            {
                let mut preserved_chain =
                    acp_transcript::read_chain_in(&root, &agent_dir, &session_id);
                if preserved_chain
                    .entries
                    .iter()
                    .any(|entry| matches!(entry.k, EntryKind::Update | EntryKind::TurnEnd))
                {
                    prefix_entries.append(&mut preserved_chain.entries);
                }
            }
            if !prefix_entries.is_empty() {
                prefix_entries.append(&mut entries);
                prefix_entries
            } else {
                entries
            }
        };

    for sid in &candidates {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, sid);
        if existing
            .entries
            .iter()
            .any(|entry| matches!(entry.k, EntryKind::Update | EntryKind::TurnEnd))
        {
            let entries = stitch_recovered_ancestors(sid, existing.entries);
            return Ok(project_turns_for(&entries, kind));
        }
    }
    for sid in &candidates {
        let existing = acp_transcript::read_chain_in(&root, &agent_dir, sid);
        if !existing.entries.is_empty() {
            let entries = stitch_recovered_ancestors(sid, existing.entries);
            return Ok(project_turns_for(&entries, kind));
        }
    }

    let timeline = ConversationProjector::project(pool, summary.id).await?;
    let mut extracted = message_turns(&timeline);
    let imported_from_vendor = if !extracted
        .iter()
        .any(|turn| matches!(turn.role, TurnRole::Assistant))
        && let (Some(kind), Some(external)) = (kind, summary.external_session_id.as_deref())
        && let Ok(Some(detail)) = load_import_conversation_detail(kind, external, None)
        && detail.turns.len() > extracted.len()
    {
        extracted = detail.turns;
        true
    } else {
        false
    };
    let has_active_turn = ConversationRecord::find_by_id(pool, summary.id)
        .await?
        .is_some_and(|record| record.active_turn_id.is_some());
    let only_inflight_first_turn = !imported_from_vendor
        && has_active_turn
        && extracted
            .iter()
            .filter(|turn| matches!(turn.role, TurnRole::User))
            .count()
            <= 1
        && !extracted
            .iter()
            .any(|turn| matches!(turn.role, TurnRole::Assistant) && turn.completed_at.is_some());
    if only_inflight_first_turn {
        return Ok(extracted);
    }
    // A file that exists — even a header claimed by an in-flight session/load
    // replay or session bind — is the transcript. Overwriting it would duplicate history.
    if candidates.iter().any(|sid| {
        acp_transcript::transcript_path_in(&root, &agent_dir, sid)
            .is_some_and(|path| path.is_file())
    }) {
        return Ok(extracted);
    }
    if extracted.is_empty() {
        return Ok(Vec::new());
    }
    let has_migratable_assistant_history = imported_from_vendor
        || extracted
            .iter()
            .any(|turn| matches!(turn.role, TurnRole::Assistant) && !turn.blocks.is_empty());
    if !has_migratable_assistant_history {
        return Ok(extracted);
    }
    let mut checkpoint = extracted.clone();
    exclude_unprompted_pending(pool, summary.id, &mut checkpoint).await?;
    write_migrated_transcript(&root, &agent_dir, &session_id, summary, &checkpoint);
    let written = acp_transcript::read_chain_in(&root, &agent_dir, &session_id);
    Ok(project_turns_for(&written.entries, kind))
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
    transcript_identity_with_agent(summary, summary.agent_id.as_ref(), kind)
}

fn transcript_identity_with_agent(
    summary: &DbConversationSummary,
    agent_id: Option<&agents::AgentId>,
    kind: Option<AgentKind>,
) -> (String, String) {
    let raw_dir = kind
        .map(|kind| kind.as_str().to_string())
        .or_else(|| agent_id.map(|id| id.to_string()))
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

/// Checkpoint product history before releasing its native execution context.
/// Legacy history is imported once; manifest history is sealed in place.
pub async fn preserve_transcript_before_detach(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    isolate_test_transcripts();
    let root = vibex_acp_transcripts_root();
    if !db::models::conversation_transcript::ConversationTranscriptSegment::list(
        pool,
        conversation_id,
    )
    .await?
    .is_empty()
    {
        return crate::transcript_segments::seal_in(pool, &root, conversation_id).await;
    }
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Ok(());
    };
    let sources =
        crate::legacy_transcript_checkpoint::validate_sources(pool, &root, &summary).await?;
    let mut turns = load_turns(pool, &summary).await?;
    exclude_unprompted_pending(pool, conversation_id, &mut turns).await?;
    crate::legacy_transcript_checkpoint::validate_coverage(&sources, &turns)?;
    crate::transcript_segments::import_snapshot_in(
        pool,
        &root,
        conversation_id,
        summary
            .agent_id
            .as_ref()
            .map_or("session", |id| id.as_str()),
        &turns,
    )
    .await
}

async fn exclude_unprompted_pending(
    pool: &SqlitePool,
    conversation: Uuid,
    turns: &mut Vec<MessageTurn>,
) -> Result<(), sqlx::Error> {
    let pending: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM conversation_turns WHERE conversation_id = ? AND status = 'pending' AND prompt_id IS NULL")
        .bind(conversation).fetch_all(pool).await?;
    turns.retain(|item| {
        !pending.iter().any(|id| {
            item.id.ends_with(&format!("{id}:user"))
                || item.id.ends_with(&format!("{id}:assistant"))
        })
    });
    Ok(())
}

/// Bind a concrete runtime connection to the only product-history writer target.
pub async fn prepare_binding_transcript(
    pool: &SqlitePool,
    conversation_id: Uuid,
    binding: &ConversationAgentBindingRecord,
    connection_id: agents::AgentConnectionId,
) -> Result<(), sqlx::Error> {
    let root = vibex_acp_transcripts_root();
    let segments = db::models::conversation_transcript::ConversationTranscriptSegment::list(
        pool,
        conversation_id,
    )
    .await?;
    if segments.is_empty() {
        preserve_transcript_before_detach(pool, conversation_id).await?;
    }
    let destination = crate::transcript_segments::open_in(
        pool,
        &root,
        conversation_id,
        binding.id,
        &binding.agent_id,
        &binding.working_dir,
    )
    .await?;
    agents::transcript_target::bind(connection_id, destination);
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
    let root = vibex_acp_transcripts_root();
    if !db::models::conversation_transcript::ConversationTranscriptSegment::list(
        pool,
        conversation_id,
    )
    .await?
    .is_empty()
    {
        return crate::transcript_segments::replace_snapshot_in(
            pool,
            &root,
            conversation_id,
            summary
                .agent_id
                .as_ref()
                .map_or("session", |id| id.as_str()),
            &kept,
        )
        .await;
    }
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
    let source_has_manifest =
        !db::models::conversation_transcript::ConversationTranscriptSegment::list(pool, source_id)
            .await?
            .is_empty();
    let projected = message_turns(&ConversationProjector::project(pool, source_id).await?);
    let turns = if source_has_manifest || transcript_turns.len() >= projected.len() {
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
    if source_has_manifest {
        crate::transcript_segments::replace_snapshot_in(
            pool,
            &vibex_acp_transcripts_root(),
            destination_id,
            destination
                .agent_id
                .as_ref()
                .map_or("session", |id| id.as_str()),
            &sliced,
        )
        .await?;
        return Ok(sliced.len());
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
#[path = "jsonl_history_tests.rs"]
mod tests;
