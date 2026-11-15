use std::collections::{HashMap, HashSet};

use agents::conversation::{
    ContentBlock, ConversationEvent, ConversationInputBlock, ConversationTimelineRow, TimelineRow,
    TurnRole,
};
use db::models::{
    conversation_event::ConversationEventRecord,
    conversation_timeline_row::ConversationTimelineRowRecord,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    ConversationEngineHandoffPackedItem, DeterministicHandoffService, PRIORITY_RECENT_TURNS,
};

/// Marker appended by preview-capping helpers when a timeline row's JSON preview was truncated.
pub(super) const TRUNCATION_SENTINEL: &str = "…[truncated]";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum CandidatePriority {
    UnresolvedError = 0,
    RecentTurn = 1,
    FileModification = 2,
    HistoricalTurn = 3,
}

#[derive(Debug, Clone)]
pub(super) struct CandidateItem {
    pub id: String,
    pub turn_id: Option<Uuid>,
    pub role: String,
    pub content: String,
    pub sort_index: i64,
    pub created_at: Option<String>,
    pub tokens: usize,
    pub priority: CandidatePriority,
}

pub(super) async fn load_candidates(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Vec<CandidateItem>, sqlx::Error> {
    let row_records =
        ConversationTimelineRowRecord::fetch_all_active(pool, conversation_id).await?;

    if row_records.is_empty() {
        let event_records =
            ConversationEventRecord::events_since(pool, conversation_id, 0, i64::MAX).await?;
        if event_records.is_empty() {
            return Ok(Vec::new());
        }
        let full_turn_texts = reconstruct_untruncated_texts_from_events(&event_records);
        let projected = crate::projection::ConversationProjector::project_records(
            conversation_id,
            &event_records,
        )?;
        let indexed: Vec<(i64, TimelineRow)> = projected
            .rows
            .into_iter()
            .enumerate()
            .map(|(i, r)| ((i as i64 + 1) * 1000, r))
            .collect();
        return Ok(candidates_from_timeline_rows(&indexed, &full_turn_texts));
    }

    let decoded = decode_timeline_records(row_records);
    let truncated_turns = collect_truncated_turn_ids(&decoded);
    let full_turn_texts = if truncated_turns.is_empty() {
        HashMap::new()
    } else {
        load_untruncated_texts_for_turns(pool, conversation_id, &truncated_turns).await?
    };

    Ok(candidates_from_timeline_rows(&decoded, &full_turn_texts))
}

pub(super) async fn load_history_items_by_ids(
    pool: &SqlitePool,
    conversation_id: Uuid,
    item_ids: &[String],
) -> Result<Vec<ConversationEngineHandoffPackedItem>, sqlx::Error> {
    let requested_owned: Vec<String> = item_ids
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if requested_owned.is_empty() {
        return Ok(Vec::new());
    }
    let requested: HashSet<&str> = requested_owned.iter().map(String::as_str).collect();

    let mut turn_ids = Vec::new();
    let mut seen_turn_ids = HashSet::new();
    for id in &requested_owned {
        if let Ok(tid) = Uuid::parse_str(id)
            && seen_turn_ids.insert(tid)
        {
            turn_ids.push(tid);
        }
    }

    let mut merged_records = Vec::new();
    let mut seen_row_ids = HashSet::new();

    for rec in
        ConversationTimelineRowRecord::fetch_by_row_ids(pool, conversation_id, &requested_owned)
            .await?
    {
        if seen_row_ids.insert(rec.row_id.clone()) {
            merged_records.push(rec);
        }
    }
    if !turn_ids.is_empty() {
        for rec in ConversationTimelineRowRecord::fetch_by_turn_id_prefixes(
            pool,
            conversation_id,
            &turn_ids,
        )
        .await?
        {
            if seen_row_ids.insert(rec.row_id.clone()) {
                merged_records.push(rec);
            }
        }
    }

    if merged_records.is_empty()
        && ConversationTimelineRowRecord::count(pool, conversation_id).await? == 0
    {
        let event_records =
            ConversationEventRecord::events_since(pool, conversation_id, 0, i64::MAX).await?;
        if !event_records.is_empty() {
            let full_turn_texts = reconstruct_untruncated_texts_from_events(&event_records);
            let projected = crate::projection::ConversationProjector::project_records(
                conversation_id,
                &event_records,
            )?;
            let indexed: Vec<(i64, TimelineRow)> = projected
                .rows
                .into_iter()
                .enumerate()
                .map(|(i, r)| ((i as i64 + 1) * 1000, r))
                .collect();
            return Ok(filter_packed_items(
                candidates_from_timeline_rows(&indexed, &full_turn_texts),
                &requested,
                &seen_turn_ids,
            ));
        }
    }

    merged_records.sort_by(|a, b| {
        a.sort_index
            .cmp(&b.sort_index)
            .then(a.row_id.cmp(&b.row_id))
    });
    let decoded = decode_timeline_records(merged_records);
    let truncated_turns = collect_truncated_turn_ids(&decoded);
    let full_turn_texts = if truncated_turns.is_empty() {
        HashMap::new()
    } else {
        load_untruncated_texts_for_turns(pool, conversation_id, &truncated_turns).await?
    };

    let candidates = candidates_from_timeline_rows(&decoded, &full_turn_texts);
    Ok(filter_packed_items(candidates, &requested, &seen_turn_ids))
}

fn filter_packed_items(
    candidates: Vec<CandidateItem>,
    requested: &HashSet<&str>,
    requested_turn_ids: &HashSet<Uuid>,
) -> Vec<ConversationEngineHandoffPackedItem> {
    candidates
        .into_iter()
        .filter(|item| {
            requested.contains(item.id.as_str())
                || item
                    .turn_id
                    .is_some_and(|tid| requested_turn_ids.contains(&tid))
        })
        .map(|item| ConversationEngineHandoffPackedItem {
            id: item.id,
            role: item.role,
            content: item.content,
            sort_index: Some(item.sort_index),
            created_at: item.created_at,
        })
        .collect()
}

fn decode_timeline_records(records: Vec<ConversationTimelineRowRecord>) -> Vec<(i64, TimelineRow)> {
    let mut decoded = Vec::with_capacity(records.len());
    for rec in records {
        if let Ok(timeline_row) = serde_json::from_str::<TimelineRow>(&rec.row_json) {
            decoded.push((rec.sort_index, timeline_row));
        }
    }
    decoded
}

fn collect_truncated_turn_ids(rows: &[(i64, TimelineRow)]) -> Vec<Uuid> {
    let mut needed = Vec::new();
    let mut seen = HashSet::new();
    for (_, row) in rows {
        let ConversationTimelineRow::MessageTurn { turn, .. } = &row.row else {
            continue;
        };
        let Some(tid) = parse_turn_id_from_row_id(&row.row_id) else {
            continue;
        };
        if seen.contains(&tid) {
            continue;
        }
        let preview = format_message_turn_blocks(&turn.blocks);
        if (preview.contains(TRUNCATION_SENTINEL) || preview.is_empty()) && seen.insert(tid) {
            needed.push(tid);
        }
    }
    needed
}

async fn load_untruncated_texts_for_turns(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_ids: &[Uuid],
) -> Result<HashMap<(Uuid, &'static str), String>, sqlx::Error> {
    let mut combined = HashMap::new();
    for &turn_id in turn_ids {
        let records =
            ConversationEventRecord::events_for_turn(pool, conversation_id, turn_id).await?;
        let partial = reconstruct_untruncated_texts_from_events(&records);
        combined.extend(partial);
    }
    Ok(combined)
}

pub(super) fn candidates_from_timeline_rows(
    rows: &[(i64, TimelineRow)],
    full_turn_texts: &HashMap<(Uuid, &'static str), String>,
) -> Vec<CandidateItem> {
    // Identify the newest `PRIORITY_RECENT_TURNS` distinct turns in chronological order.
    let mut distinct_turns: Vec<Uuid> = Vec::new();
    let mut seen_turns: HashSet<Uuid> = HashSet::new();
    for (_, row) in rows {
        if let Some(tid) = parse_turn_id_from_row_id(&row.row_id)
            && seen_turns.insert(tid)
        {
            distinct_turns.push(tid);
        }
    }
    let recent_cutoff = distinct_turns.len().saturating_sub(PRIORITY_RECENT_TURNS);
    let recent_turn_ids: HashSet<Uuid> = distinct_turns[recent_cutoff..].iter().copied().collect();
    let latest_turn_id = distinct_turns.last().copied();

    let mut out = Vec::new();
    for (sort_index, row) in rows {
        let turn_id = parse_turn_id_from_row_id(&row.row_id);
        match &row.row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. } => {
                let role_str = match turn.role {
                    TurnRole::User => "user",
                    TurnRole::Assistant => "assistant",
                    TurnRole::System => "system",
                };
                let mut content = format_message_turn_blocks(&turn.blocks);
                // Reconstruct full untruncated text from `conversation_events` if capped.
                if (content.contains(TRUNCATION_SENTINEL) || content.is_empty())
                    && let Some(tid) = turn_id
                    && let Some(full) = full_turn_texts.get(&(tid, role_str))
                    && !full.trim().is_empty()
                {
                    content = full.clone();
                }
                let trimmed = content.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let is_latest_failed = turn_id.is_some()
                    && turn_id == latest_turn_id
                    && matches!(phase.as_str(), "failed" | "interrupted");
                let priority = if is_latest_failed {
                    CandidatePriority::UnresolvedError
                } else if turn_id.is_some_and(|tid| recent_turn_ids.contains(&tid)) {
                    CandidatePriority::RecentTurn
                } else if turn_has_file_modification(&turn.blocks) {
                    CandidatePriority::FileModification
                } else {
                    CandidatePriority::HistoricalTurn
                };
                let tokens = DeterministicHandoffService::estimate_tokens(trimmed);
                out.push(CandidateItem {
                    id: row.row_id.clone(),
                    turn_id,
                    role: role_str.to_string(),
                    content: trimmed.to_string(),
                    sort_index: *sort_index,
                    created_at: Some(turn.timestamp.to_rfc3339()),
                    tokens,
                    priority,
                });
            }
            ConversationTimelineRow::TurnError { error } => {
                let is_latest = error.turn_id.is_none() || error.turn_id == latest_turn_id;
                let msg = format!(
                    "[Turn Error{}]: {}",
                    error
                        .error
                        .code
                        .as_deref()
                        .map(|c| format!(" ({c})"))
                        .unwrap_or_default(),
                    error.error.message.trim()
                );
                let tokens = DeterministicHandoffService::estimate_tokens(&msg);
                out.push(CandidateItem {
                    id: row.row_id.clone(),
                    turn_id: error.turn_id,
                    role: "error".to_string(),
                    content: msg,
                    sort_index: *sort_index,
                    created_at: None,
                    tokens,
                    priority: if is_latest {
                        CandidatePriority::UnresolvedError
                    } else {
                        CandidatePriority::HistoricalTurn
                    },
                });
            }
            ConversationTimelineRow::FileChangeSummary { summary, turn_id } => {
                if !summary.files.is_empty() {
                    let files_desc: Vec<String> = summary
                        .files
                        .iter()
                        .map(|f| format!("{} ({})", f.path, f.change_kind))
                        .collect();
                    let text = format!("[Modified Files]: {}", files_desc.join(", "));
                    let tokens = DeterministicHandoffService::estimate_tokens(&text);
                    out.push(CandidateItem {
                        id: row.row_id.clone(),
                        turn_id: *turn_id,
                        role: "file_changes".to_string(),
                        content: text,
                        sort_index: *sort_index,
                        created_at: None,
                        tokens,
                        priority: CandidatePriority::FileModification,
                    });
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_turn_id_from_row_id(row_id: &str) -> Option<Uuid> {
    let prefix = row_id.split(':').next()?;
    Uuid::parse_str(prefix).ok()
}

fn turn_has_file_modification(blocks: &[ContentBlock]) -> bool {
    blocks.iter().any(|block| match block {
        ContentBlock::ToolUse {
            kind, tool_name, ..
        } => {
            matches!(kind.as_deref(), Some("edit" | "write" | "delete"))
                || tool_name.contains("edit")
                || tool_name.contains("write")
        }
        _ => false,
    })
}

fn format_message_turn_blocks(blocks: &[ContentBlock]) -> String {
    let mut parts = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } => {
                let t = text.trim();
                if !t.is_empty() {
                    parts.push(t.to_string());
                }
            }
            ContentBlock::ToolUse {
                tool_name,
                status,
                input_preview,
                ..
            } => {
                let status_label = status.as_deref().unwrap_or("completed");
                if let Some(inp) = input_preview.as_deref().filter(|s| !s.trim().is_empty()) {
                    parts.push(format!("[Tool `{tool_name}` ({status_label})]: {inp}"));
                } else {
                    parts.push(format!("[Tool `{tool_name}` ({status_label})]"));
                }
            }
            ContentBlock::ToolResult {
                output_preview,
                is_error: true,
                ..
            } => {
                if let Some(out) = output_preview.as_deref().filter(|s| !s.trim().is_empty()) {
                    parts.push(format!("[Tool Error Output]: {out}"));
                }
            }
            ContentBlock::Plan { entries } if !entries.is_empty() => {
                let items: Vec<String> = entries
                    .iter()
                    .map(|e| format!("- [{}] {}", e.status, e.content))
                    .collect();
                parts.push(format!("[Plan]:\n{}", items.join("\n")));
            }
            _ => {}
        }
    }
    parts.join("\n\n")
}

fn reconstruct_untruncated_texts_from_events(
    records: &[ConversationEventRecord],
) -> HashMap<(Uuid, &'static str), String> {
    let mut map: HashMap<(Uuid, &'static str), String> = HashMap::new();
    let mut last_turn_id: Option<Uuid> = None;

    for record in records {
        if record.turn_id.is_some() {
            last_turn_id = record.turn_id;
        }
        let Some(turn_id) = record.turn_id.or(last_turn_id) else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) else {
            continue;
        };
        match event {
            ConversationEvent::UserTurnCreated { blocks, .. } => {
                let texts: Vec<String> = blocks
                    .into_iter()
                    .filter_map(|b| match b {
                        ConversationInputBlock::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect();
                if !texts.is_empty() {
                    map.insert((turn_id, "user"), texts.join("\n"));
                }
            }
            ConversationEvent::AssistantTextDelta { text, .. } => {
                map.entry((turn_id, "assistant"))
                    .or_default()
                    .push_str(&text);
            }
            ConversationEvent::AssistantContentAppended {
                block: ContentBlock::Text { text },
                ..
            } => {
                let entry = map.entry((turn_id, "assistant")).or_default();
                if !entry.is_empty() {
                    entry.push('\n');
                }
                entry.push_str(&text);
            }
            _ => {}
        }
    }
    map
}
