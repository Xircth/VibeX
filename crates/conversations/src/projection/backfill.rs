//! Two-phase lazy + background legacy JSONL transcript backfill into SQLite.
//!
//! Ensures `ReadPool` (`query_only = ON`) never executes writes while legacy `.jsonl`
//! transcripts are migrated at most once on `WritePool` inside a single `BEGIN IMMEDIATE`
//! transaction and indexed into row-level `conversation_fts`.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use agents::{
    AgentKind,
    acp_transcript::vibex_acp_transcripts_root,
    conversation::{
        ContentBlock, ConversationEvent, ConversationInputBlock, ConversationPlanEntry,
        ConversationSteeringEvent, ConversationToolCallPatch, ConversationUsage, MessageTurn,
        TurnRole,
    },
    parsers::loader::load_import_conversation_detail,
};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_event::{
        AppendConversationEvent, find_conversation_event_by_idempotency, insert_conversation_event,
    },
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::Session,
};
use sqlx::{Row, SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::ConversationProjector;

const DEFAULT_BACKGROUND_BATCH_SIZE: i64 = 8;
const BACKGROUND_YIELD_INTERVAL: Duration = Duration::from_millis(250);

/// Register the SQLite-authoritative `session/load` replay gate probe on `ReadPool`.
///
/// Once registered, `agents::acp_transcript` consults `conversation_turns` and
/// `conversation_events` (plus in-process memory claims) instead of `.jsonl` files
/// to block duplicate `session/load` history replays across restarts.
pub fn register_acp_replay_history_probe(read_pool: db::ReadPool) {
    agents::acp_transcript::register_recorded_history_probe(Arc::new(
        move |conversation_id, _agent_dir, acp_session_id| {
            let pool = read_pool.as_pool().clone();
            Box::pin(async move {
                has_sqlite_recorded_history(&pool, conversation_id, &acp_session_id).await
            })
        },
    ));
}

async fn has_sqlite_recorded_history(
    read_pool: &SqlitePool,
    conversation_id: Option<Uuid>,
    acp_session_id: &str,
) -> bool {
    let resolved_id = match conversation_id {
        Some(id) => Some(id),
        None if !acp_session_id.trim().is_empty() => sqlx::query_scalar::<_, Uuid>(
            "SELECT conversation_id FROM conversation_agent_bindings
              WHERE acp_session_id = ?
              ORDER BY created_at DESC
              LIMIT 1",
        )
        .bind(acp_session_id.trim())
        .fetch_optional(read_pool)
        .await
        .ok()
        .flatten()
        .or(
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM sessions WHERE external_session_id = ? LIMIT 1",
            )
            .bind(acp_session_id.trim())
            .fetch_optional(read_pool)
            .await
            .ok()
            .flatten(),
        ),
        None => None,
    };

    let Some(cid) = resolved_id else {
        return false;
    };

    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(
             SELECT 1 FROM conversation_turns
              WHERE conversation_id = ?1
                AND NOT (status = 'pending' AND prompt_id IS NULL)
         ) OR EXISTS(
             SELECT 1 FROM conversation_events
              WHERE conversation_id = ?1
                AND event_kind IN (
                    'assistant_text_delta',
                    'assistant_reasoning_delta',
                    'assistant_content_appended',
                    'tool_call_upsert',
                    'plan_updated',
                    'turn_completed'
                )
         )",
    )
    .bind(cid)
    .fetch_one(read_pool)
    .await
    .map(|v| v != 0)
    .unwrap_or(false)
}

/// Two-phase lazy migration of a legacy `.jsonl` conversation into SQLite:
///
/// 1. **Phase 1 (`ReadPool` — strictly read-only, outside any transaction)**:
///    Checks `sessions.legacy_jsonl_migrated`; if `1` or missing, returns `Ok(false)`.
///    Otherwise reads `Session` metadata and flushes/parses any on-disk `.jsonl` transcript
///    outside of SQLite transactions.
/// 2. **Phase 2 (`WritePool` — single `BEGIN IMMEDIATE` write transaction)**:
///    Re-checks `legacy_jsonl_migrated` inside the write lock (race-safe idempotency),
///    synthesizes canonical `ConversationEvent`s with deterministic idempotency keys when
///    content events are absent, rebuilds `conversation_timeline_rows` +
///    `conversation_projection_snapshots` + row-level `conversation_fts`, and flips
///    `sessions.legacy_jsonl_migrated = 1`.
pub async fn ensure_legacy_jsonl_migrated(
    read_pool: &db::ReadPool,
    write_pool: &db::WritePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    ensure_legacy_jsonl_migrated_with_pools(
        read_pool.as_pool(),
        write_pool.as_pool(),
        conversation_id,
    )
    .await
}

/// Single-pool convenience wrapper for callers/tests holding a unified writable `SqlitePool`.
pub async fn ensure_legacy_jsonl_migrated_on_pool(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    ensure_legacy_jsonl_migrated_with_pools(pool, pool, conversation_id).await
}

async fn load_legacy_turns_outside_tx(
    read_pool: &SqlitePool,
    conversation_id: Uuid,
    session: &Session,
) -> Option<Vec<MessageTurn>> {
    if let Ok(Some(segment_turns)) = crate::transcript_segments::read_in(
        read_pool,
        &vibex_acp_transcripts_root(),
        conversation_id,
    )
    .await
        && !segment_turns.is_empty()
    {
        return Some(segment_turns);
    }

    if let Some(turns) = crate::jsonl_history::flush_and_read_existing_transcript_turns(
        conversation_id,
        session.external_session_id.as_deref(),
    )
    .await
        && !turns.is_empty()
    {
        return Some(turns);
    }

    if let Ok(bindings) =
        ConversationAgentBindingRecord::list_for_conversation(read_pool, conversation_id).await
    {
        for binding in bindings.iter().rev() {
            if let Some(acp_sid) = binding.acp_session_id.as_deref()
                && let Some(turns) =
                    crate::jsonl_history::flush_and_read_existing_transcript_turns(
                        conversation_id,
                        Some(acp_sid),
                    )
                    .await
                && !turns.is_empty()
            {
                return Some(turns);
            }
        }
    }

    let kind = session
        .agent_id
        .as_ref()
        .and_then(|id| AgentKind::from_lenient(id.as_str()))
        .or_else(|| session.executor.as_deref().and_then(AgentKind::from_lenient));
    if let (Some(kind), Some(external)) = (kind, session.external_session_id.as_deref())
        && let Ok(Some(detail)) = load_import_conversation_detail(kind, external, None)
        && !detail.turns.is_empty()
    {
        return Some(detail.turns);
    }

    None
}

async fn ensure_legacy_jsonl_migrated_with_pools(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    // Phase 1: Pure ReadPool queries + disk transcript read outside any SQLite transaction.
    match ConversationRecord::is_legacy_jsonl_migrated(read_pool, conversation_id).await? {
        None | Some(true) => return Ok(false),
        Some(false) => {}
    }

    let Some(session) = Session::find_by_id(read_pool, conversation_id).await? else {
        return Ok(false);
    };

    let jsonl_turns = load_legacy_turns_outside_tx(read_pool, conversation_id, &session).await;

    // Phase 2: Single `BEGIN IMMEDIATE` write transaction on WritePool.
    let mut conn = write_pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    match backfill_on_connection(&mut conn, conversation_id, jsonl_turns.as_deref()).await {
        Ok(migrated) => {
            if let Err(commit_err) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                super::cache::evict_write_projector(conversation_id);
                return Err(commit_err);
            }
            Ok(migrated)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            super::cache::evict_write_projector(conversation_id);
            Err(error)
        }
    }
}

/// Migrate up to `batch_size` unmigrated conversations (`legacy_jsonl_migrated = 0`).
/// Returns the number of conversations flipped to `legacy_jsonl_migrated = 1` in this batch.
pub async fn backfill_next_legacy_batch(
    read_pool: &db::ReadPool,
    write_pool: &db::WritePool,
    batch_size: i64,
) -> Result<usize, sqlx::Error> {
    if batch_size <= 0 {
        return Ok(0);
    }
    let candidate_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM sessions
          WHERE legacy_jsonl_migrated = 0 AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT ?",
    )
    .bind(batch_size)
    .fetch_all(read_pool.as_pool())
    .await?;

    let mut migrated_count = 0usize;
    for conversation_id in candidate_ids {
        if ensure_legacy_jsonl_migrated(read_pool, write_pool, conversation_id).await? {
            migrated_count += 1;
        }
    }
    Ok(migrated_count)
}

/// Spawn a low-priority background worker that drains unmigrated legacy `.jsonl` sessions
/// in small batches while yielding between batches so live turns never starve on `WritePool(1)`.
pub fn spawn_legacy_jsonl_backfill_worker(
    read_pool: db::ReadPool,
    write_pool: db::WritePool,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let remaining: i64 = match sqlx::query_scalar(
                "SELECT COUNT(*) FROM sessions
                  WHERE legacy_jsonl_migrated = 0 AND deleted_at IS NULL",
            )
            .fetch_one(read_pool.as_pool())
            .await
            {
                Ok(count) => count,
                Err(error) => {
                    tracing::warn!(%error, "legacy jsonl backfill worker count query failed");
                    return;
                }
            };
            if remaining <= 0 {
                return;
            }
            match backfill_next_legacy_batch(
                &read_pool,
                &write_pool,
                DEFAULT_BACKGROUND_BATCH_SIZE,
            )
            .await
            {
                Ok(0) => return,
                Ok(_) => tokio::time::sleep(BACKGROUND_YIELD_INTERVAL).await,
                Err(error) => {
                    tracing::warn!(%error, "legacy jsonl backfill batch failed");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    })
}

#[derive(Default)]
struct LegacyRound<'a> {
    user_turn: Option<&'a MessageTurn>,
    steers: Vec<&'a MessageTurn>,
    assistant_turns: Vec<&'a MessageTurn>,
}

fn group_legacy_rounds(turns: &[MessageTurn]) -> Vec<LegacyRound<'_>> {
    let mut rounds: Vec<LegacyRound<'_>> = Vec::new();
    for turn in turns {
        match turn.role {
            TurnRole::User => {
                if turn.id.contains(":steer:") {
                    if let Some(last) = rounds.last_mut() {
                        last.steers.push(turn);
                    } else {
                        rounds.push(LegacyRound {
                            user_turn: None,
                            steers: vec![turn],
                            assistant_turns: Vec::new(),
                        });
                    }
                } else {
                    rounds.push(LegacyRound {
                        user_turn: Some(turn),
                        steers: Vec::new(),
                        assistant_turns: Vec::new(),
                    });
                }
            }
            TurnRole::Assistant => {
                if let Some(last) = rounds.last_mut() {
                    last.assistant_turns.push(turn);
                } else {
                    rounds.push(LegacyRound {
                        user_turn: None,
                        steers: Vec::new(),
                        assistant_turns: vec![turn],
                    });
                }
            }
            TurnRole::System => {}
        }
    }
    rounds
}

async fn backfill_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    jsonl_turns: Option<&[MessageTurn]>,
) -> Result<bool, sqlx::Error> {
    // Race-safe idempotency re-check inside `BEGIN IMMEDIATE`.
    match ConversationRecord::is_legacy_jsonl_migrated(&mut *conn, conversation_id).await? {
        None | Some(true) => return Ok(false),
        Some(false) => {}
    }

    let has_content_events: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM conversation_events
             WHERE conversation_id = ?
               AND event_kind IN (
                   'assistant_text_delta',
                   'assistant_reasoning_delta',
                   'assistant_content_appended',
                   'tool_call_upsert',
                   'plan_updated'
               )
        )",
    )
    .bind(conversation_id)
    .fetch_one(&mut *conn)
    .await?;

    if has_content_events == 0
        && let Some(turns) = jsonl_turns.filter(|t| !t.is_empty())
    {
        synthesize_legacy_events_on_connection(&mut *conn, conversation_id, turns).await?;
    }

    ConversationProjector::rebuild_on_connection(&mut *conn, conversation_id).await?;
    let flipped =
        ConversationRecord::mark_legacy_jsonl_migrated_on_connection(&mut *conn, conversation_id)
            .await?;
    Ok(flipped)
}

async fn synthesize_legacy_events_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    turns: &[MessageTurn],
) -> Result<(), sqlx::Error> {
    let rounds = group_legacy_rounds(turns);
    if rounds.is_empty() {
        return Ok(());
    }

    let db_turn_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM conversation_turns
          WHERE conversation_id = ?
          ORDER BY ordinal ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut *conn)
    .await?;

    let existing_rows = sqlx::query(
        "SELECT turn_id, event_kind FROM conversation_events WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut turn_event_kinds: HashMap<Uuid, HashSet<String>> = HashMap::new();
    for row in existing_rows {
        let maybe_turn_id: Option<Uuid> = row.try_get("turn_id")?;
        let event_kind: String = row.try_get("event_kind")?;
        if let Some(tid) = maybe_turn_id {
            turn_event_kinds.entry(tid).or_default().insert(event_kind);
        }
    }

    for (round_idx, round) in rounds.iter().enumerate() {
        let turn_id = match db_turn_ids.get(round_idx).copied() {
            Some(existing_id) => existing_id,
            None => {
                let preview = round
                    .user_turn
                    .and_then(|u| first_text_preview(&u.blocks))
                    .unwrap_or_default();
                let deterministic_turn_id = Uuid::new_v5(
                    &Uuid::NAMESPACE_OID,
                    format!("legacy-turn:{conversation_id}:{round_idx}").as_bytes(),
                );
                let created = ConversationTurnRecord::create_pending_on_connection(
                    &mut *conn,
                    deterministic_turn_id,
                    CreateConversationTurn {
                        conversation_id,
                        prompt_id: None,
                        text_preview: (!preview.is_empty()).then_some(preview.as_str()),
                        input_blocks_json: "[]",
                    },
                )
                .await?;
                created.id
            }
        };

        let existing_kinds = turn_event_kinds.get(&turn_id);
        let has_user_created = existing_kinds.is_some_and(|s| s.contains("user_turn_created"));
        let has_steering = existing_kinds.is_some_and(|s| s.contains("conversation_steering"));

        let mut synthesized: Vec<(&'static str, ConversationEvent)> = Vec::new();

        if !has_user_created
            && let Some(user_turn) = round.user_turn
        {
            let blocks = input_blocks_from_content_blocks(&user_turn.blocks);
            if !blocks.is_empty() {
                synthesized.push((
                    "user",
                    ConversationEvent::UserTurnCreated {
                        blocks,
                        workflow_refs: Vec::new(),
                    },
                ));
            }
        }

        // Pair assistant segments with mid-turn steering slices in order when present.
        if !has_steering && !round.steers.is_empty() {
            if let Some(first_assistant) = round.assistant_turns.first() {
                append_assistant_turn_events(first_assistant, &mut synthesized);
            }
            for (steer_idx, steer_turn) in round.steers.iter().enumerate() {
                let blocks = input_blocks_from_content_blocks(&steer_turn.blocks);
                if !blocks.is_empty() {
                    let steering_id = Uuid::new_v5(
                        &Uuid::NAMESPACE_OID,
                        format!("legacy-steer:{conversation_id}:{round_idx}:{steer_idx}")
                            .as_bytes(),
                    );
                    let operation_id = Uuid::new_v5(
                        &Uuid::NAMESPACE_OID,
                        format!("legacy-steer-op:{conversation_id}:{round_idx}:{steer_idx}")
                            .as_bytes(),
                    );
                    synthesized.push((
                        "user",
                        ConversationEvent::ConversationSteering {
                            event: ConversationSteeringEvent::Requested {
                                steering_id,
                                operation_id,
                                expected_turn_id: turn_id,
                                payload_digest: format!("legacy-{round_idx}-{steer_idx}"),
                                blocks,
                                principal: serde_json::json!({ "kind": "user" }),
                            },
                        },
                    ));
                    synthesized.push((
                        "acp",
                        ConversationEvent::ConversationSteering {
                            event: ConversationSteeringEvent::Accepted {
                                steering_id,
                                expected_turn_id: turn_id,
                                delivery_mode: Some(
                                    agents::conversation::ConversationSteeringDeliveryMode::Native,
                                ),
                                restarted_turn_id: None,
                            },
                        },
                    ));
                }
                if let Some(next_assistant) = round.assistant_turns.get(steer_idx + 1) {
                    append_assistant_turn_events(next_assistant, &mut synthesized);
                }
            }
            for extra_assistant in round.assistant_turns.iter().skip(round.steers.len() + 1) {
                append_assistant_turn_events(extra_assistant, &mut synthesized);
            }
        } else {
            for assistant_turn in &round.assistant_turns {
                append_assistant_turn_events(assistant_turn, &mut synthesized);
            }
        }

        let round_settled = round
            .assistant_turns
            .last()
            .is_some_and(|a| a.completed_at.is_some())
            || existing_kinds.is_some_and(|s| {
                s.contains("turn_completed")
                    || s.contains("turn_failed")
                    || s.contains("turn_cancelled")
                    || s.contains("turn_interrupted")
            });
        if round_settled && !round.assistant_turns.is_empty() {
            synthesized.push((
                "acp",
                ConversationEvent::TurnCompleted {
                    stop_reason: Some("end_turn".to_string()),
                },
            ));
        }

        for (ev_idx, (source, event)) in synthesized.into_iter().enumerate() {
            let idempotency_key = format!("legacy-jsonl:{conversation_id}:{round_idx}:{ev_idx}");
            if find_conversation_event_by_idempotency(
                &mut *conn,
                conversation_id,
                Some(idempotency_key.as_str()),
            )
            .await?
            .is_some()
            {
                continue;
            }
            let event_value =
                serde_json::to_value(&event).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
            let event_kind = event_value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let normalized_json =
                serde_json::to_string(&event).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
            let event_id = Uuid::new_v5(&Uuid::NAMESPACE_OID, idempotency_key.as_bytes());
            insert_conversation_event(
                &mut *conn,
                AppendConversationEvent {
                    id: event_id,
                    conversation_id,
                    turn_id: Some(turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source,
                    event_kind: &event_kind,
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(idempotency_key.as_str()),
                },
            )
            .await?;
        }
    }

    Ok(())
}

fn first_text_preview(blocks: &[ContentBlock]) -> Option<String> {
    blocks.iter().find_map(|block| match block {
        ContentBlock::Text { text } if !text.trim().is_empty() => {
            Some(text.chars().take(160).collect())
        }
        _ => None,
    })
}

fn input_blocks_from_content_blocks(blocks: &[ContentBlock]) -> Vec<ConversationInputBlock> {
    let mut out = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text { text } if !text.is_empty() => {
                out.push(ConversationInputBlock::Text { text: text.clone() });
            }
            ContentBlock::Image {
                data,
                mime_type,
                uri,
                ..
            } => {
                let resolved_uri = uri
                    .clone()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| format!("data:{mime_type};base64,{data}"));
                out.push(ConversationInputBlock::Image {
                    uri: resolved_uri,
                    mime_type: mime_type.clone(),
                    title: None,
                });
            }
            ContentBlock::Resource { uri, title } => {
                out.push(ConversationInputBlock::Resource {
                    uri: uri.clone(),
                    title: title.clone(),
                    mime_type: None,
                });
            }
            ContentBlock::Protocol { content } => {
                out.push(ConversationInputBlock::Protocol {
                    content: content.clone(),
                });
            }
            _ => {}
        }
    }
    out
}

fn append_assistant_turn_events(
    turn: &MessageTurn,
    out: &mut Vec<(&'static str, ConversationEvent)>,
) {
    let mut tool_seq = 0usize;
    for block in &turn.blocks {
        match block {
            ContentBlock::Thinking { text } if !text.is_empty() => {
                out.push((
                    "acp",
                    ConversationEvent::AssistantReasoningDelta {
                        text: text.clone(),
                        message_id: turn.agent_message_id.clone(),
                    },
                ));
            }
            ContentBlock::Text { text } if !text.is_empty() => {
                out.push((
                    "acp",
                    ConversationEvent::AssistantTextDelta {
                        text: text.clone(),
                        message_id: turn.agent_message_id.clone(),
                    },
                ));
            }
            ContentBlock::Image { .. }
            | ContentBlock::ImageGeneration { .. }
            | ContentBlock::Resource { .. }
            | ContentBlock::Protocol { .. } => {
                out.push((
                    "acp",
                    ConversationEvent::AssistantContentAppended {
                        block: block.clone(),
                        message_id: turn.agent_message_id.clone(),
                    },
                ));
            }
            ContentBlock::Plan { entries } => {
                let mapped_entries = entries
                    .iter()
                    .enumerate()
                    .map(|(idx, entry)| ConversationPlanEntry {
                        id: format!("plan-{idx}"),
                        content: entry.content.clone(),
                        status: entry.status.clone(),
                        priority: entry.priority.clone(),
                    })
                    .collect();
                out.push((
                    "acp",
                    ConversationEvent::PlanUpdated {
                        entries: mapped_entries,
                    },
                ));
            }
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                status,
                kind,
                input_preview,
                meta,
                images,
                ..
            } => {
                tool_seq += 1;
                let call_id = tool_use_id
                    .clone()
                    .unwrap_or_else(|| format!("legacy-tool-{tool_seq}"));
                let raw_input = input_preview.as_deref().map(|raw| {
                    serde_json::from_str(raw)
                        .unwrap_or_else(|_| serde_json::Value::String(raw.to_string()))
                });
                out.push((
                    "acp",
                    ConversationEvent::ToolCallUpsert {
                        tool_call: ConversationToolCallPatch {
                            tool_call_id: call_id,
                            title: Some(tool_name.clone()),
                            kind: kind.clone().or_else(|| Some(tool_name.clone())),
                            status: status.clone().or_else(|| Some("in_progress".to_string())),
                            raw_input,
                            raw_output: None,
                            raw_output_append: None,
                            content: None,
                            locations: None,
                            metadata: meta.clone(),
                            images: images.clone(),
                        },
                    },
                ));
            }
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                let call_id = tool_use_id
                    .clone()
                    .unwrap_or_else(|| format!("legacy-tool-{}", tool_seq.max(1)));
                let raw_output = output_preview
                    .as_ref()
                    .map(|text| serde_json::Value::String(text.clone()));
                out.push((
                    "acp",
                    ConversationEvent::ToolCallUpsert {
                        tool_call: ConversationToolCallPatch {
                            tool_call_id: call_id,
                            title: None,
                            kind: None,
                            status: Some(
                                if *is_error { "failed" } else { "completed" }.to_string(),
                            ),
                            raw_input: None,
                            raw_output,
                            raw_output_append: None,
                            content: None,
                            locations: None,
                            metadata: None,
                            images: Vec::new(),
                        },
                    },
                ));
            }
            _ => {}
        }
    }

    if let Some(usage) = &turn.usage {
        out.push((
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens,
                    context_used: usage.context_used,
                    context_window_max: usage.context_window_max,
                    cost_amount: usage.cost_amount,
                    cost_currency: usage.cost_currency.clone(),
                    model: turn.model.clone(),
                },
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use agents::{
        AgentId,
        acp_transcript::{self, EntryKind, TranscriptHeader, vibex_acp_transcripts_root},
        conversation::ConversationTimelineRow,
    };
    use db::models::conversation::CreateConversationRecord;

    use super::*;

    async fn seed_legacy_session(
        db: &db::DBService,
        title: &str,
        prompt: &str,
        assistant_reply: &str,
    ) -> Uuid {
        let writer = db.writer().as_pool();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(writer)
            .await
            .expect("disable fk for test seed");

        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let external_sid = format!("acp-backfill-{}", Uuid::new_v4().simple());
        let agent_id = AgentId::parse("codex").expect("agent id");

        ConversationRecord::create(
            writer,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some(title),
                initial_prompt: Some(prompt),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        Session::update_agent_metadata(writer, conversation_id, Some(&external_sid), Some(&agent_id))
            .await
            .expect("bind external session id");

        ConversationTurnRecord::create_pending(
            writer,
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: None,
                text_preview: Some(prompt),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");

        // Mark session as legacy unmigrated (`0`), simulating a pre-cutover row.
        sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 0 WHERE id = ?")
            .bind(conversation_id)
            .execute(writer)
            .await
            .expect("set legacy_jsonl_migrated = 0");

        // Ensure test transcript isolation is active before writing JSONL entries.
        let _ = crate::jsonl_history::read_existing_transcript_turns(conversation_id);
        let root = vibex_acp_transcripts_root();
        let header = TranscriptHeader::new("codex", &external_sid, "/workspace", 1_700_000_000_000);
        let _ = acp_transcript::record_header_in(&root, "codex", &header).await;
        let _ = acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": prompt }]),
        )
        .await;
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": assistant_reply }
            }),
        ));
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-legacy-1",
                "title": "Run cargo test",
                "kind": "execute",
                "status": "in_progress",
                "rawInput": { "command": "cargo test" }
            }),
        ));
        drop(acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-legacy-1",
                "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "ok" } }]
            }),
        ));
        let _ = acp_transcript::record_entry_in(
            &root,
            "codex",
            &external_sid,
            EntryKind::TurnEnd,
            serde_json::json!({
                "stopReason": "end_turn",
                "durationMs": 250,
                "usage": {
                    "inputTokens": 120,
                    "outputTokens": 45,
                    "cacheCreationInputTokens": 0,
                    "cacheReadInputTokens": 0
                }
            }),
        )
        .await;

        conversation_id
    }

    #[tokio::test]
    async fn read_only_read_pool_plus_write_pool_backfills_legacy_jsonl_once_and_indexes_fts() {
        let db = db::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");
        let conversation_id = seed_legacy_session(
            &db,
            "Legacy Backfill Test",
            "Inspect legacy quantum circuit",
            "Backfilled answer token QuartzNebula99.",
        )
        .await;

        // First call: Phase 1 reads on `query_only = ON` ReadPool (no SQLITE_READONLY!),
        // Phase 2 writes on WritePool(1) and flips `legacy_jsonl_migrated = 1`.
        let migrated = ensure_legacy_jsonl_migrated(db.reader(), db.writer(), conversation_id)
            .await
            .expect("two-phase backfill succeeds without SQLITE_READONLY");
        assert!(migrated, "first backfill should migrate session");
        assert_eq!(
            ConversationRecord::is_legacy_jsonl_migrated(db.reader().as_pool(), conversation_id)
                .await
                .expect("read migration flag"),
            Some(true)
        );

        let event_count_after_first: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(db.reader().as_pool())
        .await
        .expect("count events");
        assert!(event_count_after_first >= 4);

        // Pure ReadPool `project_open` returns full user + assistant + tool blocks + stats!
        let open = ConversationProjector::project_open(db.reader().as_pool(), conversation_id, 16)
            .await
            .expect("project_open on ReadPool");
        let message_rows: Vec<_> = open
            .timeline
            .rows
            .iter()
            .filter(|r| matches!(r.row, ConversationTimelineRow::MessageTurn { .. }))
            .collect();
        assert_eq!(message_rows.len(), 2);
        match &message_rows[1].row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. } => {
                assert_eq!(phase, "settled");
                let text_blocks: Vec<_> = turn
                    .blocks
                    .iter()
                    .filter(|b| matches!(b, ContentBlock::Text { .. }))
                    .collect();
                assert_eq!(text_blocks.len(), 1, "assistant text must not duplicate after tool call");
                assert!(turn.blocks.iter().any(|b| {
                    matches!(b, ContentBlock::Text { text } if text.contains("QuartzNebula99"))
                }));
                assert!(turn.blocks.iter().any(|b| {
                    matches!(b, ContentBlock::ToolUse { tool_name, status, .. }
                        if tool_name == "Run cargo test" && status.as_deref() == Some("completed"))
                }));
            }
            other => panic!("expected assistant MessageTurn, got {other:?}"),
        }
        assert_eq!(
            open.session_stats.and_then(|s| s.total_tokens),
            Some(165)
        );

        // Row-level trigram FTS5 search on ReadPool finds the backfilled assistant reply!
        let mut read_conn = db.reader().acquire().await.expect("acquire read conn");
        let hits = crate::search::search_conversations(&mut read_conn, "QuartzNebula99", None, 10)
            .await
            .expect("FTS search on ReadPool");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, conversation_id);

        // Second call short-circuits in Phase 1 (`Ok(false)`) without duplicating events.
        let second = ensure_legacy_jsonl_migrated(db.reader(), db.writer(), conversation_id)
            .await
            .expect("second backfill call");
        assert!(!second, "already-migrated session must short-circuit");
        let event_count_after_second: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(db.reader().as_pool())
        .await
        .expect("count events after second call");
        assert_eq!(event_count_after_second, event_count_after_first);
    }

    #[tokio::test]
    async fn backfill_next_legacy_batch_drains_unmigrated_sessions() {
        let db = db::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");
        let c1 = seed_legacy_session(&db, "Batch 1", "Prompt 1", "Reply Alpha777").await;
        let c2 = seed_legacy_session(&db, "Batch 2", "Prompt 2", "Reply Bravo888").await;

        let count = backfill_next_legacy_batch(db.reader(), db.writer(), 10)
            .await
            .expect("drain batch");
        assert_eq!(count, 2);

        for cid in [c1, c2] {
            assert_eq!(
                ConversationRecord::is_legacy_jsonl_migrated(db.reader().as_pool(), cid)
                    .await
                    .expect("flag"),
                Some(true)
            );
        }

        let next_count = backfill_next_legacy_batch(db.reader(), db.writer(), 10)
            .await
            .expect("empty batch");
        assert_eq!(next_count, 0);
    }
}
