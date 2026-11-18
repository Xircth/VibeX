use std::collections::HashMap;

use agents::conversation::{
    ContentBlock, ConversationRowOp, ConversationRowsSincePage, ConversationTimeline,
    ConversationTimelinePage, ConversationTimelineRow, MessageTurn, TimelineRow, TurnRole,
    cap_timeline_row_preview_fields, shrink_timeline_row_for_window,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use db::models::{
    conversation_timeline_row::{ConversationTimelineRowRecord, SORT_INDEX_SLOT_SPAN},
    session::Session,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    CONVERSATION_PROJECTION_VERSION, ConversationProjector, OpenConversationProjection,
    ProjectionFold,
    cache::{decode_session_stats, decode_timeline_row_records, latest_event_sequence},
    fork_capability,
    rows::annotate_fork_point_rows,
};

/// Maximum cumulative `row_json` UTF-8 byte budget per window/page (1 MiB).
/// Always returns at least 1 row so a single oversized row never causes an empty-page loop.
pub const MAX_WINDOW_BYTES: usize = 1_048_576;
pub const DEFAULT_ROWS_SINCE_LIMIT: usize = 500;

/// Opaque Base64URL-encoded keyset cursor (`{ "v": 1, "sort_index": i64, "row_id": String }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineKeysetCursor {
    pub v: u8,
    pub sort_index: i64,
    pub row_id: String,
}

pub fn encode_timeline_cursor(sort_index: i64, row_id: &str) -> String {
    let payload = TimelineKeysetCursor {
        v: 1,
        sort_index,
        row_id: row_id.to_string(),
    };
    let json = serde_json::to_vec(&payload).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json)
}

pub fn decode_timeline_cursor(raw: &str) -> Option<TimelineKeysetCursor> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(trimmed))
        .ok()?;
    let cursor: TimelineKeysetCursor = serde_json::from_slice(&bytes).ok()?;
    (cursor.v == 1 && !cursor.row_id.is_empty()).then_some(cursor)
}

/// Trim a chronologically ordered (`oldest .. newest`) slice of `(sort_index, byte_len, row)`
/// from the oldest side so the retained newest suffix fits within `max_bytes`, while always
/// keeping at least 1 row when `items` is non-empty.
///
/// Returns `(retained_items, dropped_oldest_count)`.
#[cfg(test)]
pub(super) fn trim_newest_within_byte_budget<T>(
    mut items: Vec<(i64, usize, T)>,
    max_bytes: usize,
) -> (Vec<(i64, T)>, usize) {
    if items.is_empty() {
        return (Vec::new(), 0);
    }
    let mut cumulative_bytes = 0usize;
    let mut keep_from = items.len();
    for idx in (0..items.len()).rev() {
        let row_bytes = items[idx].1;
        if keep_from < items.len() && cumulative_bytes.saturating_add(row_bytes) > max_bytes {
            break;
        }
        cumulative_bytes = cumulative_bytes.saturating_add(row_bytes);
        keep_from = idx;
    }
    // Guarantee >= 1 row (the newest row) even if its own JSON exceeds `max_bytes`.
    if keep_from >= items.len() {
        keep_from = items.len() - 1;
    }
    let dropped = keep_from;
    if dropped > 0 {
        items.drain(0..dropped);
    }
    let retained = items
        .into_iter()
        .map(|(sort, _, val)| (sort, val))
        .collect();
    (retained, dropped)
}

/// Pick an oldest-first open window. Each row is shrunk and measured after that
/// shrink, so a stored multi-megabyte tool preview does not count at its raw
/// `row_json` length. Side rows that do not fit are skipped. A message that
/// does not fit ends the walk, unless no message has been kept yet — then that
/// newest message stays so the page still makes progress. When the newest kept
/// message is an assistant, the closest older user row of the same turn is kept
/// with it.
///
/// The returned count is the number of rows older than the oldest kept row.
/// Callers use a non-zero count as "an older page exists".
fn select_open_timeline_window(items: Vec<(i64, TimelineRow)>) -> (Vec<(i64, TimelineRow)>, usize) {
    if items.is_empty() {
        return (Vec::new(), 0);
    }
    let sized: Vec<(i64, usize, TimelineRow)> = items
        .into_iter()
        .map(|(sort, mut row)| {
            let bytes = shrink_timeline_row_for_window(&mut row);
            (sort, bytes, row)
        })
        .collect();
    let mut keep = vec![false; sized.len()];
    let mut cumulative = 0usize;
    let mut kept_message = false;
    for idx in (0..sized.len()).rev() {
        let bytes = sized[idx].1;
        let is_message = row_is_message(&sized[idx].2);
        let next = cumulative.saturating_add(bytes);
        if next <= MAX_WINDOW_BYTES || (is_message && !kept_message) {
            cumulative = next;
            keep[idx] = true;
            if is_message {
                kept_message = true;
            }
            continue;
        }
        if is_message {
            break;
        }
    }
    if !keep.iter().any(|kept| *kept) {
        keep[sized.len() - 1] = true;
    }
    keep_paired_user(&sized, &mut keep);
    let dropped_older = keep.iter().position(|kept| *kept).unwrap_or(0);
    let retained = sized
        .into_iter()
        .enumerate()
        .filter_map(|(idx, (sort, _, row))| keep[idx].then_some((sort, row)))
        .collect();
    (retained, dropped_older)
}

fn row_is_message(row: &TimelineRow) -> bool {
    matches!(row.row, ConversationTimelineRow::MessageTurn { .. })
}

fn message_role(row: &TimelineRow) -> Option<TurnRole> {
    match &row.row {
        ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn.role),
        _ => None,
    }
}

fn turn_id_prefix(row_id: &str) -> Option<&str> {
    let (prefix, rest) = row_id.split_once(':')?;
    if prefix.is_empty() || rest.is_empty() {
        return None;
    }
    Uuid::parse_str(prefix).ok()?;
    Some(prefix)
}

fn keep_paired_user(sized: &[(i64, usize, TimelineRow)], keep: &mut [bool]) {
    let Some(assistant_idx) = (0..sized.len())
        .rev()
        .find(|idx| keep[*idx] && message_role(&sized[*idx].2) == Some(TurnRole::Assistant))
    else {
        return;
    };
    let newest_message = (0..sized.len())
        .rev()
        .find(|idx| keep[*idx] && row_is_message(&sized[*idx].2));
    if newest_message != Some(assistant_idx) {
        return;
    }
    let Some(prefix) = turn_id_prefix(&sized[assistant_idx].2.row_id) else {
        return;
    };
    let Some(user_idx) = (0..assistant_idx).rev().find(|idx| {
        message_role(&sized[*idx].2) == Some(TurnRole::User)
            && turn_id_prefix(&sized[*idx].2.row_id) == Some(prefix)
    }) else {
        return;
    };
    keep[user_idx] = true;
}

impl ProjectionFold {
    /// Deterministic synthetic `(sort_index, TimelineRow)` list matching SQLite's
    /// `turn_ordinal * 1_000_000 + offset` layout so cold-fold fallbacks produce valid
    /// keyset cursors identical in semantics to materialized `conversation_timeline_rows`.
    pub(crate) fn timeline_rows_with_sort_index(&self) -> Vec<(i64, TimelineRow)> {
        let mut turn_ordinals = HashMap::with_capacity(self.turn_order.len());
        for (idx, turn_id) in self.turn_order.iter().enumerate() {
            turn_ordinals.insert(*turn_id, (idx as i64) + 1);
        }

        let mut side_turn_by_id = HashMap::with_capacity(self.side_rows.len());
        for side in &self.side_rows {
            side_turn_by_id.insert(side.row_id.as_str(), self.side_row_turn_id(side));
        }

        let mut next_slot_by_ord = HashMap::<i64, i64>::new();
        let mut out = Vec::new();
        // A turn that is not registered yet must not share the global
        // `[0, 999_999]` band. That band sorts above every real turn, so the
        // next snapshot that learns the ordinal would move the row back down.
        let unplaced_ord = turn_ordinals.values().copied().max().unwrap_or(0) + 1;
        for row in self.timeline_rows() {
            let ord = if let Some(turn_id_opt) = side_turn_by_id.get(row.row_id.as_str()) {
                match turn_id_opt {
                    Some(tid) => turn_ordinals.get(tid).copied().unwrap_or(unplaced_ord),
                    None => 0,
                }
            } else if let Some((prefix, _)) = row.row_id.split_once(':')
                && let Ok(tid) = Uuid::parse_str(prefix)
            {
                turn_ordinals.get(&tid).copied().unwrap_or(unplaced_ord)
            } else {
                0
            };
            let base = ord * SORT_INDEX_SLOT_SPAN;
            let slot = next_slot_by_ord.entry(ord).or_insert(base);
            *slot += 1;
            out.push((*slot, row));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.row_id.cmp(&b.1.row_id)));
        out
    }

    pub(super) fn into_open_timeline_with_budget(
        self,
        conversation_id: Uuid,
        limit: usize,
    ) -> ConversationTimeline {
        let last_sequence = self.last_sequence;
        let all = self.timeline_rows_with_sort_index();
        let total = all.len();
        let count_truncated = limit > 0 && total > limit;
        let start = if count_truncated { total - limit } else { 0 };
        let tail: Vec<(i64, TimelineRow)> = all.into_iter().skip(start).collect();
        let (retained, dropped_for_bytes) = select_open_timeline_window(tail);
        let truncated = count_truncated || dropped_for_bytes > 0;
        let older_cursor = if truncated {
            retained
                .first()
                .map(|(sort, row)| encode_timeline_cursor(*sort, &row.row_id))
        } else {
            None
        };
        let rows: Vec<TimelineRow> = retained.into_iter().map(|(_, row)| row).collect();
        ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence,
            rows,
            truncated_from_start: truncated,
            older_cursor,
        }
    }
}

impl ConversationProjector {
    pub(super) async fn try_materialized_open_with_budget(
        pool: &SqlitePool,
        conversation_id: Uuid,
        limit: usize,
    ) -> Result<Option<OpenConversationProjection>, sqlx::Error> {
        let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await? else {
            return Ok(None);
        };
        if snapshot.total_rows <= 0 {
            return Ok(None);
        }
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if latest > snapshot.last_sequence {
            return Ok(None);
        }
        let bounded = limit.max(1) as i64;
        let records =
            ConversationTimelineRowRecord::list_tail(pool, conversation_id, bounded).await?;
        let expected = snapshot.total_rows.min(bounded);
        if records.len() as i64 != expected {
            return Ok(None);
        }
        let decoded = decode_timeline_row_records(&records)?;
        let opened: Vec<(i64, TimelineRow)> = records
            .into_iter()
            .zip(decoded)
            .map(|(rec, row)| (rec.sort_index, row))
            .collect();
        let (retained, dropped_for_bytes) = select_open_timeline_window(opened);
        let truncated = snapshot.total_rows > retained.len() as i64 || dropped_for_bytes > 0;
        if !truncated
            && !retained
                .iter()
                .any(|(_, r)| matches!(r.row, ConversationTimelineRow::MessageTurn { .. }))
        {
            let has_initial_prompt = Session::find_by_id(pool, conversation_id)
                .await?
                .and_then(|s| s.initial_prompt)
                .is_some_and(|p| !p.trim().is_empty());
            if has_initial_prompt {
                return Ok(None);
            }
        }
        let older_cursor = if truncated {
            retained
                .first()
                .map(|(sort, row)| encode_timeline_cursor(*sort, &row.row_id))
        } else {
            None
        };
        let rows: Vec<TimelineRow> = retained.into_iter().map(|(_, row)| row).collect();
        let effective_last_seq = snapshot.last_sequence.max(snapshot.last_allocated_sequence);
        let timeline = ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence: effective_last_seq,
            rows,
            truncated_from_start: truncated,
            older_cursor,
        };
        let session_stats = decode_session_stats(snapshot.session_stats_json.as_deref())?;
        Ok(Some(OpenConversationProjection {
            timeline,
            session_stats,
        }))
    }

    /// Page older timeline rows strictly before an opaque Base64URL keyset cursor
    /// (with `MAX_WINDOW_BYTES = 1 MiB` byte budget and `>= 1` row progress guarantee).
    /// Also supports legacy integer `start` / `before_sort_index` callers transparently.
    pub async fn project_timeline_page(
        pool: &SqlitePool,
        conversation_id: Uuid,
        cursor: Option<&str>,
        before_sort_index: Option<i64>,
        legacy_start: Option<usize>,
        limit: usize,
    ) -> Result<ConversationTimelinePage, sqlx::Error> {
        let bounded_limit = limit.max(1);

        // 1. Keyset cursor path (`cursor` decodes as Base64URL `{ v: 1, sort_index, row_id }`
        //    or explicit `before_sort_index` without cursor).
        let keyset_target = cursor
            .and_then(decode_timeline_cursor)
            .map(|c| (c.sort_index, c.row_id))
            .or_else(|| before_sort_index.map(|sort| (sort, String::new())));

        if let Some((target_sort, target_row_id)) = keyset_target {
            if let Some(mut page) = Self::try_materialized_keyset_page(
                pool,
                conversation_id,
                cursor.map(str::to_owned),
                target_sort,
                &target_row_id,
                bounded_limit,
            )
            .await?
            {
                let (fork_session, agent_kind) = fork_capability(pool, conversation_id).await?;
                annotate_fork_point_rows(&mut page.rows, fork_session, agent_kind);
                return Ok(page);
            }

            // Cold-fold keyset fallback (pure read path).
            let fold = Self::fold(pool, conversation_id).await?;
            if fold.last_sequence > 0 {
                super::schedule_projection_repair(conversation_id);
            }
            let all = fold.timeline_rows_with_sort_index();
            let older_all: Vec<(i64, TimelineRow)> = all
                .into_iter()
                .filter(|(sort, row)| {
                    *sort < target_sort
                        || (*sort == target_sort && row.row_id.as_str() < target_row_id.as_str())
                })
                .collect();
            let total_older = older_all.len();
            let skip = total_older.saturating_sub(bounded_limit);
            let candidates: Vec<(i64, TimelineRow)> = older_all.into_iter().skip(skip).collect();
            let (retained, dropped_for_bytes) = select_open_timeline_window(candidates);
            let has_more_older = skip > 0 || dropped_for_bytes > 0;
            let next_cursor = if has_more_older {
                retained
                    .first()
                    .map(|(sort, row)| encode_timeline_cursor(*sort, &row.row_id))
            } else {
                None
            };
            let mut rows: Vec<TimelineRow> = retained.into_iter().map(|(_, row)| row).collect();
            let (fork_session, agent_kind) = fork_capability(pool, conversation_id).await?;
            annotate_fork_point_rows(&mut rows, fork_session, agent_kind);
            return Ok(ConversationTimelinePage {
                conversation_id,
                projection_version: CONVERSATION_PROJECTION_VERSION,
                cursor: cursor.map(str::to_owned),
                next_cursor,
                rows,
            });
        }

        // 2. If `cursor` was provided as a non-empty string that is NEITHER a valid Base64URL
        //    keyset cursor NOR a legacy integer offset, treat it as an invalid/empty cursor.
        let parsed_legacy_offset = match cursor.map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => match raw.parse::<usize>() {
                Ok(offset) => Some(offset),
                Err(_) => {
                    return Ok(ConversationTimelinePage {
                        conversation_id,
                        projection_version: CONVERSATION_PROJECTION_VERSION,
                        cursor: cursor.map(str::to_owned),
                        next_cursor: None,
                        rows: Vec::new(),
                    });
                }
            },
            None => legacy_start,
        };

        // 3. Legacy offset fallback (`start` or numeric string cursor).
        let start = parsed_legacy_offset.unwrap_or(0);
        let window = Self::project_row_window(pool, conversation_id, start, bounded_limit).await?;
        let end = start.saturating_add(window.rows.len());
        let next_cursor = (end < window.total_rows).then(|| end.to_string());
        Ok(ConversationTimelinePage {
            conversation_id,
            projection_version: window.projection_version,
            cursor: Some(start.to_string()),
            next_cursor,
            rows: window.rows,
        })
    }

    async fn try_materialized_keyset_page(
        pool: &SqlitePool,
        conversation_id: Uuid,
        echo_cursor: Option<String>,
        before_sort_index: i64,
        before_row_id: &str,
        limit: usize,
    ) -> Result<Option<ConversationTimelinePage>, sqlx::Error> {
        let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await? else {
            return Ok(None);
        };
        if snapshot.total_rows <= 0 {
            return Ok(Some(ConversationTimelinePage {
                conversation_id,
                projection_version: CONVERSATION_PROJECTION_VERSION,
                cursor: echo_cursor,
                next_cursor: None,
                rows: Vec::new(),
            }));
        }
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if latest > snapshot.last_sequence {
            return Ok(None);
        }
        let records = ConversationTimelineRowRecord::list_before_keyset(
            pool,
            conversation_id,
            before_sort_index,
            before_row_id,
            limit as i64,
        )
        .await?;
        if records.is_empty() {
            return Ok(Some(ConversationTimelinePage {
                conversation_id,
                projection_version: CONVERSATION_PROJECTION_VERSION,
                cursor: echo_cursor,
                next_cursor: None,
                rows: Vec::new(),
            }));
        }
        let decoded = decode_timeline_row_records(&records)?;
        let opened: Vec<(i64, TimelineRow)> = records
            .into_iter()
            .zip(decoded)
            .map(|(rec, row)| (rec.sort_index, row))
            .collect();
        let (retained, dropped_for_bytes) = select_open_timeline_window(opened);
        let has_more_older = if dropped_for_bytes > 0 {
            true
        } else if let Some((oldest_sort, oldest_row)) = retained.first() {
            ConversationTimelineRowRecord::has_older_before_keyset(
                pool,
                conversation_id,
                *oldest_sort,
                &oldest_row.row_id,
            )
            .await?
        } else {
            false
        };
        let next_cursor = if has_more_older {
            retained
                .first()
                .map(|(sort, row)| encode_timeline_cursor(*sort, &row.row_id))
        } else {
            None
        };
        let rows = retained.into_iter().map(|(_, row)| row).collect();
        Ok(Some(ConversationTimelinePage {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            cursor: echo_cursor,
            next_cursor,
            rows,
        }))
    }

    /// Tombstone- and reset-aware incremental catch-up query (`ReadPool`-safe), bounded by
    /// row limit (`DEFAULT_ROWS_SINCE_LIMIT = 500`) and cumulative payload budget (`MAX_WINDOW_BYTES`).
    pub async fn rows_since_with_tombstones(
        pool: &SqlitePool,
        conversation_id: Uuid,
        after_sequence: i64,
        limit: Option<usize>,
    ) -> Result<ConversationRowsSincePage, sqlx::Error> {
        let effective_limit = limit
            .unwrap_or(DEFAULT_ROWS_SINCE_LIMIT)
            .clamp(1, DEFAULT_ROWS_SINCE_LIMIT);
        let latest_event = latest_event_sequence(pool, conversation_id).await?;
        if let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await?
            && snapshot.last_sequence >= latest_event
        {
            let last_sequence = snapshot.last_sequence.max(snapshot.last_allocated_sequence);
            if after_sequence < 0 || after_sequence > last_sequence {
                return Ok(ConversationRowsSincePage {
                    conversation_id,
                    after_sequence,
                    last_sequence,
                    reset: true,
                    ops: Vec::new(),
                });
            }
            let (diff, truncated) = ConversationTimelineRowRecord::rows_since_limited_executor(
                pool,
                conversation_id,
                after_sequence,
                effective_limit,
            )
            .await?;
            if truncated {
                return Ok(ConversationRowsSincePage {
                    conversation_id,
                    after_sequence,
                    last_sequence,
                    reset: true,
                    ops: Vec::new(),
                });
            }
            let mut keyed_ops: Vec<(i64, ConversationRowOp)> =
                Vec::with_capacity(diff.upserts.len() + diff.tombstones.len());
            let mut cumulative_bytes = 0usize;
            for rec in &diff.upserts {
                cumulative_bytes = cumulative_bytes.saturating_add(rec.row_json.len());
                if cumulative_bytes > MAX_WINDOW_BYTES && !keyed_ops.is_empty() {
                    return Ok(ConversationRowsSincePage {
                        conversation_id,
                        after_sequence,
                        last_sequence,
                        reset: true,
                        ops: Vec::new(),
                    });
                }
                let mut row: TimelineRow =
                    serde_json::from_str(&rec.row_json).map_err(super::cache::json_decode_error)?;
                cap_timeline_row_preview_fields(&mut row);
                keyed_ops.push((rec.sort_index, ConversationRowOp::Upsert { row }));
            }
            for tomb in diff.tombstones {
                keyed_ops.push((
                    tomb.sort_index,
                    ConversationRowOp::Delete {
                        row_id: tomb.row_id,
                        revision: tomb.deleted_sequence,
                    },
                ));
            }
            keyed_ops.sort_by_key(|(sort_index, _)| *sort_index);
            return Ok(ConversationRowsSincePage {
                conversation_id,
                after_sequence,
                last_sequence,
                reset: false,
                ops: keyed_ops.into_iter().map(|(_, op)| op).collect(),
            });
        }

        // Cold-fold fallback when snapshot is missing or behind `conversation_events`.
        let fold = Self::fold(pool, conversation_id).await?;
        if fold.last_sequence > 0 {
            super::schedule_projection_repair(conversation_id);
        }
        let last_sequence = fold.last_sequence.max(latest_event);
        if after_sequence < 0 || after_sequence > last_sequence {
            return Ok(ConversationRowsSincePage {
                conversation_id,
                after_sequence,
                last_sequence,
                reset: true,
                ops: Vec::new(),
            });
        }
        let mut ops: Vec<ConversationRowOp> = Vec::new();
        let mut cumulative_bytes = 0usize;
        for row in fold.changed_rows_since(after_sequence) {
            if ops.len() >= effective_limit {
                return Ok(ConversationRowsSincePage {
                    conversation_id,
                    after_sequence,
                    last_sequence,
                    reset: true,
                    ops: Vec::new(),
                });
            }
            cumulative_bytes = cumulative_bytes
                .saturating_add(serde_json::to_string(&row).map(|s| s.len()).unwrap_or(0));
            if cumulative_bytes > MAX_WINDOW_BYTES && !ops.is_empty() {
                return Ok(ConversationRowsSincePage {
                    conversation_id,
                    after_sequence,
                    last_sequence,
                    reset: true,
                    ops: Vec::new(),
                });
            }
            ops.push(ConversationRowOp::Upsert { row });
        }
        let remaining_limit = effective_limit.saturating_sub(ops.len());
        let (diff, tomb_truncated) = ConversationTimelineRowRecord::rows_since_limited_executor(
            pool,
            conversation_id,
            after_sequence,
            remaining_limit,
        )
        .await?;
        if tomb_truncated || ops.len() + diff.tombstones.len() > effective_limit {
            return Ok(ConversationRowsSincePage {
                conversation_id,
                after_sequence,
                last_sequence,
                reset: true,
                ops: Vec::new(),
            });
        }
        for tomb in diff.tombstones {
            ops.push(ConversationRowOp::Delete {
                row_id: tomb.row_id,
                revision: tomb.deleted_sequence,
            });
        }
        Ok(ConversationRowsSincePage {
            conversation_id,
            after_sequence,
            last_sequence,
            reset: false,
            ops,
        })
    }

    /// Return all visible `MessageTurn`s in chronological order (`ReadPool`-safe).
    /// Uses materialized `conversation_timeline_rows` when fresh, falling back to `fold`.
    pub async fn project_turns_summary(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<MessageTurn>, sqlx::Error> {
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await?
            && snapshot.total_rows > 0
            && snapshot.last_sequence >= latest
        {
            let records =
                ConversationTimelineRowRecord::list_all_active(pool, conversation_id).await?;
            let rows = decode_timeline_row_records(&records)?;
            let turns: Vec<MessageTurn> = rows
                .into_iter()
                .filter_map(|row| match row.row {
                    ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn),
                    _ => None,
                })
                .collect();
            if !turns.is_empty() {
                return Ok(turns);
            }
        }
        let fold = Self::fold(pool, conversation_id).await?;
        Ok(fold
            .timeline_rows()
            .into_iter()
            .filter_map(|row| match row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn),
                _ => None,
            })
            .collect())
    }

    /// Count visible message turns without deserializing timeline row payloads (`ReadPool`-safe).
    pub async fn count_visible_turns(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<usize, sqlx::Error> {
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await?
            && snapshot.last_sequence >= latest
        {
            let count =
                ConversationTimelineRowRecord::count_visible_message_rows(pool, conversation_id)
                    .await?;
            return Ok(count.max(0) as usize);
        }
        let fold = Self::fold(pool, conversation_id).await?;
        Ok(fold
            .timeline_rows()
            .into_iter()
            .filter(|row| matches!(row.row, ConversationTimelineRow::MessageTurn { .. }))
            .count())
    }

    /// Fetch the newest suffix of visible `MessageTurn`s within `max_bytes` (preserving
    /// complete dialogue groups) together with earlier message `row_id`s without decoding
    /// ancient history payloads.
    pub async fn project_turns_summary_tail_within_bytes(
        pool: &SqlitePool,
        conversation_id: Uuid,
        max_bytes: usize,
    ) -> Result<(Vec<MessageTurn>, Vec<String>), sqlx::Error> {
        const BATCH_SIZE: i64 = 64;
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await?
            && snapshot.total_rows > 0
            && snapshot.last_sequence >= latest
        {
            let mut cursor_sort = i64::MAX;
            let mut cursor_row_id = String::new();
            let mut turns_rev: Vec<MessageTurn> = Vec::new();
            let mut accumulated_bytes = 0usize;

            loop {
                let batch = ConversationTimelineRowRecord::list_before_keyset(
                    pool,
                    conversation_id,
                    cursor_sort,
                    &cursor_row_id,
                    BATCH_SIZE,
                )
                .await?;
                if batch.is_empty() {
                    break;
                }
                let batch_len = batch.len();
                cursor_sort = batch[0].sort_index;
                cursor_row_id = batch[0].row_id.clone();

                for rec in batch.iter().rev() {
                    if let Ok(row) = serde_json::from_str::<TimelineRow>(&rec.row_json)
                        && let ConversationTimelineRow::MessageTurn { turn, .. } = row.row
                    {
                        let role = turn.role;
                        accumulated_bytes = accumulated_bytes.saturating_add(rec.row_json.len());
                        turns_rev.push(turn);
                        if accumulated_bytes > max_bytes && role == TurnRole::User {
                            let older_ids = ConversationTimelineRowRecord::list_older_message_row_ids_before_keyset(
                                pool,
                                conversation_id,
                                rec.sort_index,
                                &rec.row_id,
                            )
                            .await?;
                            turns_rev.reverse();
                            return Ok((turns_rev, older_ids));
                        }
                    }
                }
                if (batch_len as i64) < BATCH_SIZE {
                    break;
                }
            }

            turns_rev.reverse();
            if !turns_rev.is_empty() {
                return Ok((turns_rev, Vec::new()));
            }
        }

        let turns = Self::project_turns_summary(pool, conversation_id).await?;
        Ok((turns, Vec::new()))
    }

    /// Extract the latest non-empty assistant text reply for a conversation (`ReadPool`-safe)
    /// via backwards keyset scan over materialized rows.
    pub async fn latest_assistant_text(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        const BATCH_SIZE: i64 = 32;
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await?
            && snapshot.total_rows > 0
            && snapshot.last_sequence >= latest
        {
            let mut cursor_sort = i64::MAX;
            let mut cursor_row_id = String::new();
            loop {
                let batch = ConversationTimelineRowRecord::list_before_keyset(
                    pool,
                    conversation_id,
                    cursor_sort,
                    &cursor_row_id,
                    BATCH_SIZE,
                )
                .await?;
                if batch.is_empty() {
                    return Ok(None);
                }
                for rec in batch.iter().rev() {
                    if let Ok(row) = serde_json::from_str::<TimelineRow>(&rec.row_json)
                        && let ConversationTimelineRow::MessageTurn { turn, .. } = row.row
                        && turn.role == TurnRole::Assistant
                        && let Some(text) = extract_turn_text(&turn)
                    {
                        return Ok(Some(text));
                    }
                }
                if (batch.len() as i64) < BATCH_SIZE {
                    return Ok(None);
                }
                cursor_sort = batch[0].sort_index;
                cursor_row_id = batch[0].row_id.clone();
            }
        }

        let fold = Self::fold(pool, conversation_id).await?;
        for turn_id in fold.turn_order.iter().rev() {
            let Some(turn) = fold.turns.get(turn_id) else {
                continue;
            };
            if let Some(text) = extract_turn_text(&turn.assistant) {
                return Ok(Some(text));
            }
            for seg in turn.prefix_segments.iter().rev() {
                if seg.role == TurnRole::Assistant
                    && let Some(text) = extract_turn_text(seg)
                {
                    return Ok(Some(text));
                }
            }
        }
        Ok(None)
    }

    /// Extract the assistant text reply produced for a specific `turn_id` (`ReadPool`-safe).
    pub async fn assistant_text_for_turn(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await?
            && snapshot.total_rows > 0
            && snapshot.last_sequence >= latest
        {
            let records = ConversationTimelineRowRecord::fetch_turn_assistant_rows(
                pool,
                conversation_id,
                turn_id,
            )
            .await?;
            let rows = decode_timeline_row_records(&records)?;
            let mut segments = Vec::new();
            for row in rows {
                if let ConversationTimelineRow::MessageTurn { turn, .. } = row.row
                    && turn.role == TurnRole::Assistant
                    && let Some(text) = extract_turn_text(&turn)
                {
                    segments.push(text);
                }
            }
            if !segments.is_empty() {
                return Ok(Some(segments.join("\n\n")));
            }
            return Self::latest_assistant_text(pool, conversation_id).await;
        }

        let turns = Self::project_turns_summary(pool, conversation_id).await?;
        let prefix = format!("{turn_id}:assistant");
        let mut segments = Vec::new();
        for turn in &turns {
            if turn.role == TurnRole::Assistant
                && (turn.id == prefix || turn.id.starts_with(&format!("{prefix}:")))
                && let Some(text) = extract_turn_text(turn)
            {
                segments.push(text);
            }
        }
        if !segments.is_empty() {
            return Ok(Some(segments.join("\n\n")));
        }
        // Fallback: if single-turn conversation folded under `conversation_id`, return latest assistant text.
        Self::latest_assistant_text(pool, conversation_id).await
    }
}

fn extract_turn_text(turn: &MessageTurn) -> Option<String> {
    let joined = turn
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => {
                let trimmed = text.trim();
                (!trimmed.is_empty()).then_some(trimmed)
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use agents::conversation::{
        ConversationError, ConversationErrorView, ConversationSessionNotice,
    };

    use super::*;

    #[test]
    fn unplaced_turn_row_sorts_after_global_side_rows() {
        let mut fold = ProjectionFold::default();
        let global = TimelineRow {
            row_id: "notice:1".into(),
            revision: 1,
            row: ConversationTimelineRow::SessionNotice {
                notice: ConversationSessionNotice {
                    title: "notice".into(),
                    message: None,
                    severity: "info".into(),
                    ..Default::default()
                },
            },
        };
        let orphan = TimelineRow {
            row_id: "err:missing".into(),
            revision: 2,
            row: ConversationTimelineRow::TurnError {
                error: ConversationErrorView {
                    turn_id: Some(Uuid::new_v4()),
                    error: ConversationError::new("failed", None, None),
                },
            },
        };
        fold.side_rows.push(global.clone());
        fold.side_rows.push(orphan.clone());

        let indexed = fold.timeline_rows_with_sort_index();
        let global_sort = indexed
            .iter()
            .find(|(_, row)| row.row_id == global.row_id)
            .expect("global side row")
            .0;
        let orphan_sort = indexed
            .iter()
            .find(|(_, row)| row.row_id == orphan.row_id)
            .expect("unplaced turn row")
            .0;

        assert!(global_sort < SORT_INDEX_SLOT_SPAN);
        assert!(orphan_sort >= SORT_INDEX_SLOT_SPAN);
        assert!(orphan_sort > global_sort);
    }

    #[test]
    fn keyset_cursor_round_trips_and_rejects_garbage() {
        let cursor = encode_timeline_cursor(2_000_003, "turn-2:assistant");
        assert!(!cursor.contains('='), "URL_SAFE_NO_PAD must omit '='");
        assert!(
            cursor.parse::<usize>().is_err(),
            "cursor is opaque non-integer"
        );

        let decoded = decode_timeline_cursor(&cursor).expect("valid cursor");
        assert_eq!(
            decoded,
            TimelineKeysetCursor {
                v: 1,
                sort_index: 2_000_003,
                row_id: "turn-2:assistant".to_string(),
            }
        );
        assert!(decode_timeline_cursor("").is_none());
        assert!(decode_timeline_cursor("not-base64!@#").is_none());
        assert!(decode_timeline_cursor("12").is_none());
    }

    #[test]
    fn byte_budget_trim_keeps_newest_suffix_and_at_least_one_oversized_row() {
        let items = vec![
            (1, 600_000, "row-1"),
            (2, 600_000, "row-2"),
            (3, 300_000, "row-3"),
        ];
        let (retained, dropped) = trim_newest_within_byte_budget(items, MAX_WINDOW_BYTES);
        assert_eq!(dropped, 1);
        assert_eq!(retained, vec![(2, "row-2"), (3, "row-3")]);

        // Single row larger than 1 MiB still returns 1 row to guarantee forward progress.
        let huge = vec![(1, 500_000, "older"), (2, 2_000_000, "huge-newest")];
        let (retained_huge, dropped_huge) = trim_newest_within_byte_budget(huge, MAX_WINDOW_BYTES);
        assert_eq!(dropped_huge, 1);
        assert_eq!(retained_huge, vec![(2, "huge-newest")]);
    }

    fn message_row(
        sort: i64,
        row_id: &str,
        role: TurnRole,
        blocks: Vec<ContentBlock>,
    ) -> (i64, TimelineRow) {
        (
            sort,
            TimelineRow {
                row_id: row_id.into(),
                revision: 1,
                row: ConversationTimelineRow::MessageTurn {
                    turn: MessageTurn {
                        id: row_id.into(),
                        role,
                        blocks,
                        timestamp: chrono::Utc::now(),
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                        agent_message_id: None,
                    },
                    phase: "settled".into(),
                    fork_point_status: None,
                },
            },
        )
    }

    fn notice_row(sort: i64, row_id: &str, message: &str) -> (i64, TimelineRow) {
        (
            sort,
            TimelineRow {
                row_id: row_id.into(),
                revision: 1,
                row: ConversationTimelineRow::SessionNotice {
                    notice: ConversationSessionNotice {
                        title: "notice".into(),
                        message: Some(message.into()),
                        severity: "info".into(),
                        ..Default::default()
                    },
                },
            },
        )
    }

    fn file_change_row(sort: i64) -> (i64, TimelineRow) {
        (
            sort,
            TimelineRow {
                row_id: "fc:4309".into(),
                revision: 1,
                row: ConversationTimelineRow::FileChangeSummary {
                    summary: agents::conversation::ConversationFileChangeSummary {
                        source: "checkpoint".into(),
                        files: Vec::new(),
                        summary: Some("20 files".into()),
                    },
                    turn_id: None,
                },
            },
        )
    }

    fn row_text(row: &TimelineRow) -> String {
        let ConversationTimelineRow::MessageTurn { turn, .. } = &row.row else {
            return String::new();
        };
        turn.blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn open_window_keeps_user_and_assistant_text_when_tool_preview_exceeds_budget() {
        let turn = "655f4f3e-082e-4ffb-bec2-ef716d25719f";
        let reply = "无限画布上按住 Ctrl 再滚动，回复仍然在。";
        let rows = vec![
            notice_row(2, "notice:old", "old"),
            message_row(
                1_000_001,
                &format!("{turn}:user"),
                TurnRole::User,
                vec![ContentBlock::Text {
                    text: "请你修复以下BUG".into(),
                }],
            ),
            message_row(
                1_000_002,
                &format!("{turn}:assistant"),
                TurnRole::Assistant,
                vec![
                    ContentBlock::ToolResult {
                        tool_use_id: Some("tool-1".into()),
                        output_preview: Some("x".repeat(2_000_000)),
                        is_error: false,
                        agent_stats: None,
                    },
                    ContentBlock::Text { text: reply.into() },
                ],
            ),
            file_change_row(1_000_003),
            notice_row(
                1_000_004,
                "notice:agent-connection-recovering",
                "recovering",
            ),
        ];
        let (retained, dropped) = select_open_timeline_window(rows);
        assert_eq!(dropped, 0);
        let ids: Vec<_> = retained
            .iter()
            .map(|(_, row)| row.row_id.as_str())
            .collect();
        assert!(ids.contains(&format!("{turn}:user").as_str()));
        assert!(ids.contains(&format!("{turn}:assistant").as_str()));
        assert!(ids.contains(&"fc:4309"));
        let assistant = retained
            .iter()
            .find(|(_, row)| row.row_id.ends_with(":assistant"))
            .expect("assistant row");
        assert_eq!(row_text(&assistant.1), reply);
        let ConversationTimelineRow::MessageTurn { turn, .. } = &assistant.1.row else {
            panic!("assistant missing");
        };
        match &turn.blocks[0] {
            ContentBlock::ToolResult { output_preview, .. } => {
                let preview = output_preview.as_deref().unwrap_or("");
                assert!(preview.len() < 20_000, "preview is {} bytes", preview.len());
            }
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn open_window_keeps_the_user_paired_with_an_oversized_assistant() {
        let turn = "655f4f3e-082e-4ffb-bec2-ef716d25719f";
        let reply = "回".repeat(1_500_000);
        let rows = vec![
            notice_row(2, "notice:old", "old"),
            message_row(
                1_000_001,
                &format!("{turn}:user"),
                TurnRole::User,
                vec![ContentBlock::Text {
                    text: "请你修复以下BUG".into(),
                }],
            ),
            message_row(
                1_000_002,
                &format!("{turn}:assistant"),
                TurnRole::Assistant,
                vec![ContentBlock::Text {
                    text: reply.clone(),
                }],
            ),
            file_change_row(1_000_003),
            notice_row(1_000_004, "notice:tail", "tail"),
        ];
        let (retained, dropped) = select_open_timeline_window(rows);
        assert!(dropped > 0);
        let ids: Vec<_> = retained
            .iter()
            .map(|(_, row)| row.row_id.as_str())
            .collect();
        assert!(ids.contains(&format!("{turn}:user").as_str()));
        assert!(ids.contains(&format!("{turn}:assistant").as_str()));
        assert!(!ids.contains(&"notice:old"));
        let assistant = retained
            .iter()
            .find(|(_, row)| row.row_id.ends_with(":assistant"))
            .expect("assistant row");
        assert_eq!(row_text(&assistant.1), reply);
    }

    #[test]
    fn open_window_skips_an_oversized_newer_side_row_instead_of_dropping_the_turn() {
        let turn = "655f4f3e-082e-4ffb-bec2-ef716d25719f";
        let reply = "侧栏通知不能把这一轮挤掉。";
        let rows = vec![
            message_row(
                1_000_001,
                &format!("{turn}:user"),
                TurnRole::User,
                vec![ContentBlock::Text {
                    text: "请你修复以下BUG".into(),
                }],
            ),
            message_row(
                1_000_002,
                &format!("{turn}:assistant"),
                TurnRole::Assistant,
                vec![ContentBlock::Text { text: reply.into() }],
            ),
            notice_row(1_000_003, "notice:huge", &"n".repeat(2_000_000)),
        ];
        let (retained, dropped) = select_open_timeline_window(rows);
        assert_eq!(dropped, 0);
        let ids: Vec<_> = retained
            .iter()
            .map(|(_, row)| row.row_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, [format!("{turn}:user"), format!("{turn}:assistant")]);
        assert_eq!(row_text(&retained[1].1), reply);
    }
}
