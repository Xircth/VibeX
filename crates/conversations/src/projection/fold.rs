use std::collections::BTreeMap;

use agents::conversation::{
    ContentBlock, ConversationError, ConversationErrorView, ConversationEvent,
    ConversationQuestionResponse, ConversationRowOp, ConversationSessionNotice,
    ConversationTimelineRow, MessageTurn, PlanEntry, TimelineRow, TurnRole, cap_json_value,
    cap_preview_bytes,
};
use db::models::conversation_event::ConversationEventRecord;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    ParsedEvent, ProjectionFold,
    cache::{
        AssistantEmit, TouchedTurnRows, clear_session_connect_notices, remove_side_row,
        upsert_stable_notice,
    },
    conversation_event_from_record, emit_captured_internal_message, merge_reported_turn_usage,
    rows::side_row,
};

impl ProjectionFold {
    pub(super) fn fold_record(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Vec<ConversationRowOp> {
        self.last_sequence = self.last_sequence.max(record.sequence);
        let event = match conversation_event_from_record(record) {
            ParsedEvent::Known(event) => event,
            ParsedEvent::Unknown { kind } => {
                return self.apply_unknown_event_notice(record, &kind);
            }
        };

        self.apply_runtime_status(record, &event);

        if let ConversationEvent::AssistantTextDelta { ref text, .. }
        | ConversationEvent::AssistantReasoningDelta { ref text, .. } = event
        {
            return self.apply_streaming_delta(record, &event, text);
        }

        let turns = &mut self.turns;
        let turn_order = &mut self.turn_order;
        let side_rows = &mut self.side_rows;
        let mut deleted_rows = Vec::new();
        let mut touched_turn_rows: Option<TouchedTurnRows> = None;
        let mut assistant_emit: Option<AssistantEmit> = None;

        match event {
            ConversationEvent::UserTurnCreated { blocks, .. } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.user_revision = record.sequence;
                    turn.revision = record.sequence;
                    turn.user.blocks = content_blocks_from_input(&blocks, true);
                    touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                }
            }
            ConversationEvent::UserTurnStarted => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.revision = record.sequence;
                    turn.assistant.timestamp = record.created_at;
                    touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                }
            }
            ConversationEvent::AssistantContentAppended { block, .. } => {
                if let Some(turn_id) = record.turn_id.or_else(|| turn_order.last().copied()) {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    let row_existed = !turn.assistant.blocks.is_empty();
                    turn.revision = record.sequence;
                    turn.clear_trailing_raw_text();
                    let cleaned_block = match block {
                        ContentBlock::Text { text } => {
                            let extracted = agents::extract_and_strip_internal_messages(
                                &text,
                                Some(record.conversation_id),
                                Some(turn_id),
                                false,
                            );
                            for captured in extracted.captured {
                                emit_captured_internal_message(captured);
                            }
                            if extracted.visible_text.is_empty() {
                                None
                            } else {
                                Some(ContentBlock::Text {
                                    text: extracted.visible_text,
                                })
                            }
                        }
                        other => Some(other),
                    };
                    if let Some(cleaned_block) = cleaned_block {
                        turn.assistant.blocks.push(cleaned_block);
                        assistant_emit = Some(if row_existed {
                            let blocks =
                                turn.assistant.blocks.last().cloned().into_iter().collect();
                            AssistantEmit::Patch {
                                blocks,
                                usage: None,
                            }
                        } else {
                            AssistantEmit::Full
                        });
                        touched_turn_rows = Some(TouchedTurnRows::AssistantOnly(turn_id));
                    }
                }
            }
            ConversationEvent::PlanUpdated { entries } => {
                if let Some(turn_id) = record.turn_id.or_else(|| turn_order.last().copied()) {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    let row_existed = !turn.assistant.blocks.is_empty();
                    turn.revision = record.sequence;
                    let plan = ContentBlock::Plan {
                        entries: entries
                            .into_iter()
                            .map(|entry| PlanEntry {
                                content: entry.content,
                                status: entry.status,
                                priority: entry.priority,
                            })
                            .collect(),
                    };
                    if let Some(existing) = turn
                        .assistant
                        .blocks
                        .iter_mut()
                        .find(|block| matches!(block, ContentBlock::Plan { .. }))
                    {
                        *existing = plan;
                    } else {
                        flush_trailing_raw_text(turn, record.conversation_id, turn_id);
                        turn.assistant.blocks.push(plan);
                    }
                    assistant_emit = Some(if row_existed {
                        let blocks = turn
                            .assistant
                            .blocks
                            .iter()
                            .find(|block| matches!(block, ContentBlock::Plan { .. }))
                            .cloned()
                            .into_iter()
                            .collect();
                        AssistantEmit::Patch {
                            blocks,
                            usage: None,
                        }
                    } else {
                        AssistantEmit::Full
                    });
                    touched_turn_rows = Some(TouchedTurnRows::AssistantOnly(turn_id));
                }
            }
            ConversationEvent::ToolCallUpsert { tool_call } => {
                if let Some(turn_id) = record.turn_id.or_else(|| turn_order.last().copied()) {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    let assistant_row_existed = !turn.assistant.blocks.is_empty();
                    turn.revision = record.sequence;
                    touched_turn_rows = Some(TouchedTurnRows::AssistantOnly(turn_id));
                    let call_id = tool_call.tool_call_id.clone();
                    let patch_id = call_id.clone();
                    let observed_at = record.created_at;
                    let existing_kind =
                        turn.assistant.blocks.iter().find_map(|block| match block {
                            ContentBlock::ToolUse {
                                tool_use_id: Some(id),
                                kind,
                                ..
                            } if id == &call_id => kind.clone(),
                            _ => None,
                        });
                    let kind = tool_call.kind.clone().or(existing_kind);
                    // Antigravity stamps cascade and provider errors onto view_file.
                    // A successful view_file is `completed` with no output, so a
                    // failed read result is settled the same way.
                    let settle_read = self.complete_antigravity_reads
                        && kind.as_deref() == Some("read")
                        && tool_call.status.as_deref() == Some("failed");
                    let reported_status = if settle_read {
                        Some("completed".to_string())
                    } else {
                        tool_call.status.clone()
                    };
                    let terminal = matches!(
                        reported_status.as_deref(),
                        Some("completed") | Some("failed")
                    );

                    // Upsert semantics: a tool_call_update must fold into the
                    // existing card, not spawn a second titleless block.
                    let existing_use =
                        turn.assistant
                            .blocks
                            .iter_mut()
                            .find_map(|block| match block {
                                ContentBlock::ToolUse {
                                    tool_use_id: Some(id),
                                    tool_name,
                                    status,
                                    kind,
                                    input_preview,
                                    meta,
                                    images,
                                    started_at,
                                    ended_at,
                                } if *id == call_id => Some((
                                    tool_name,
                                    status,
                                    kind,
                                    input_preview,
                                    meta,
                                    images,
                                    started_at,
                                    ended_at,
                                )),
                                _ => None,
                            });
                    let append_delta = if settle_read {
                        None
                    } else {
                        extract_tool_output_append(&tool_call)
                    };
                    match existing_use {
                        Some((
                            tool_name,
                            status,
                            kind,
                            input_preview,
                            meta,
                            images,
                            started_at,
                            ended_at,
                        )) => {
                            if let Some(title) = tool_call.title {
                                *tool_name = title;
                            }
                            if tool_call.kind.is_some() {
                                *kind = tool_call.kind;
                            }
                            if reported_status.is_some() {
                                *status = reported_status.clone();
                            }
                            if let Some(raw) = tool_call.raw_input
                                && (!raw.as_object().is_some_and(|map| map.is_empty())
                                    || input_preview.is_none())
                            {
                                *input_preview = Some(cap_preview_bytes(raw.to_string()));
                            }
                            if let Some(metadata) = tool_call.metadata.clone() {
                                let merged = match (meta.take(), metadata) {
                                    (
                                        Some(serde_json::Value::Object(mut existing_map)),
                                        serde_json::Value::Object(incoming_map),
                                    ) => {
                                        for (k, v) in incoming_map {
                                            existing_map.insert(k, v);
                                        }
                                        serde_json::Value::Object(existing_map)
                                    }
                                    (_, incoming) => incoming,
                                };
                                *meta = Some(cap_json_value(merged));
                            }
                            if !tool_call.images.is_empty() {
                                *images = tool_call.images.iter().take(4).cloned().collect();
                            }
                            if started_at.is_none() {
                                *started_at = Some(observed_at);
                            }
                            if terminal {
                                *ended_at = Some(observed_at);
                            }
                        }
                        None => {
                            flush_trailing_raw_text(turn, record.conversation_id, turn_id);
                            turn.assistant.blocks.push(ContentBlock::ToolUse {
                                status: reported_status.clone(),
                                tool_use_id: Some(call_id.clone()),
                                tool_name: tool_call
                                    .title
                                    .clone()
                                    .or(tool_call.kind.clone())
                                    .unwrap_or_else(|| call_id.clone()),
                                kind: tool_call.kind.clone(),
                                input_preview: tool_call
                                    .raw_input
                                    .as_ref()
                                    .map(|value| cap_preview_bytes(value.to_string())),
                                meta: tool_call.metadata.clone().map(cap_json_value),
                                images: tool_call.images.iter().take(4).cloned().collect(),
                                started_at: Some(observed_at),
                                ended_at: terminal.then_some(observed_at),
                            });
                        }
                    }

                    // Attach/refresh the paired result so the card's status dot
                    // settles: on output, or on a terminal status without one.
                    let status = turn.assistant.blocks.iter().find_map(|block| match block {
                        ContentBlock::ToolUse {
                            tool_use_id: Some(id),
                            status,
                            ..
                        } if *id == call_id => status.as_deref(),
                        _ => None,
                    });
                    let is_error = matches!(status, Some("failed"));
                    let output_preview = if settle_read || append_delta.is_some() {
                        None
                    } else {
                        tool_call.raw_output.map(|output| {
                            cap_preview_bytes(match output {
                                serde_json::Value::String(text) => text,
                                other => other.to_string(),
                            })
                        })
                    };
                    if append_delta.is_some() || output_preview.is_some() || terminal {
                        let existing_result =
                            turn.assistant
                                .blocks
                                .iter_mut()
                                .find_map(|block| match block {
                                    ContentBlock::ToolResult {
                                        tool_use_id: Some(id),
                                        output_preview,
                                        is_error,
                                        ..
                                    } if *id == call_id => Some((output_preview, is_error)),
                                    _ => None,
                                });
                        match existing_result {
                            Some((existing_output, existing_error)) => {
                                if settle_read {
                                    *existing_output = None;
                                    *existing_error = false;
                                } else if let Some(delta) = append_delta {
                                    if !delta.is_empty() {
                                        let next = match existing_output.as_deref() {
                                            Some(prev) => format!("{prev}{delta}"),
                                            None => delta,
                                        };
                                        *existing_output = Some(cap_preview_bytes(next));
                                    }
                                    *existing_error = is_error;
                                } else {
                                    if output_preview.is_some() {
                                        *existing_output = output_preview;
                                    }
                                    *existing_error = is_error;
                                }
                            }
                            None => {
                                flush_trailing_raw_text(turn, record.conversation_id, turn_id);
                                let initial = append_delta
                                    .filter(|d| !d.is_empty())
                                    .map(cap_preview_bytes)
                                    .or(output_preview);
                                turn.assistant.blocks.push(ContentBlock::ToolResult {
                                    tool_use_id: Some(call_id),
                                    output_preview: initial,
                                    is_error,
                                    agent_stats: None,
                                });
                            }
                        }
                    }
                    assistant_emit = Some(if assistant_row_existed {
                        let blocks = turn
                            .assistant
                            .blocks
                            .iter()
                            .filter(|block| match block {
                                ContentBlock::ToolUse {
                                    tool_use_id: Some(id),
                                    ..
                                }
                                | ContentBlock::ToolResult {
                                    tool_use_id: Some(id),
                                    ..
                                } => id == &patch_id,
                                _ => false,
                            })
                            .cloned()
                            .collect();
                        AssistantEmit::Patch {
                            blocks,
                            usage: None,
                        }
                    } else {
                        AssistantEmit::Full
                    });
                }
            }
            ConversationEvent::UsageUpdated { usage } => {
                if let Some(turn_id) = record.turn_id.or_else(|| turn_order.last().copied()) {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    let next_usage = Some(merge_reported_turn_usage(
                        turn.assistant.usage.clone(),
                        &usage,
                    ));
                    if turn.assistant.usage != next_usage {
                        turn.assistant.usage = next_usage;
                        turn.revision = record.sequence;
                        turn.usage_announced = true;
                        assistant_emit = Some(AssistantEmit::Patch {
                            blocks: Vec::new(),
                            usage: turn.assistant.usage.clone(),
                        });
                        touched_turn_rows = Some(TouchedTurnRows::AssistantOnly(turn_id));
                    }
                }
            }
            ConversationEvent::AgentSessionInfoUpdated { patch } => {
                apply_session_info_patch(side_rows, &mut deleted_rows, record, &patch);
            }
            ConversationEvent::TurnCompleted { .. } => {
                let turn_id = settle_turn(turns, turn_order, record, "settled");
                touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
            }
            ConversationEvent::TurnCancelled { .. } => {
                let turn_id = settle_turn(turns, turn_order, record, "cancelled");
                settle_pending_questions_for_turn(
                    side_rows,
                    &self.side_row_turns,
                    turn_id,
                    record.sequence,
                );
                touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
            }
            ConversationEvent::TurnInterrupted { .. } => {
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.phase = "interrupted".into();
                    turn.bump_all_segment_revisions(record.sequence);
                    settle_pending_questions_for_turn(
                        side_rows,
                        &self.side_row_turns,
                        turn_id,
                        record.sequence,
                    );
                    touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                }
            }
            ConversationEvent::TurnFailed { error } => {
                let turn_id = settle_turn(turns, turn_order, record, "failed");
                settle_pending_questions_for_turn(
                    side_rows,
                    &self.side_row_turns,
                    turn_id,
                    record.sequence,
                );
                touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                if let Some(turn_id) = record.turn_id.or_else(|| turn_order.last().copied())
                    && let Some(turn) = turns.get_mut(&turn_id)
                    && assistant_content_is_turn_error_echo(&turn.assistant.blocks, &error)
                {
                    turn.assistant.blocks.clear();
                    deleted_rows.push(ConversationRowOp::Delete {
                        row_id: turn.assistant.id.clone(),
                        revision: record.sequence,
                    });
                }
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::TurnError {
                        error: ConversationErrorView {
                            turn_id: record.turn_id,
                            error,
                        },
                    },
                ));
            }
            ConversationEvent::ConversationSteering { event } => match event {
                agents::ConversationSteeringEvent::Requested {
                    steering_id,
                    expected_turn_id,
                    blocks,
                    ..
                } => {
                    ensure_turn(turns, turn_order, expected_turn_id, record);
                    let turn = turns.get_mut(&expected_turn_id).expect("turn exists");
                    turn.pending_steering =
                        Some((steering_id, content_blocks_from_input(&blocks, false)));
                }
                agents::ConversationSteeringEvent::Accepted {
                    steering_id,
                    expected_turn_id,
                    delivery_mode,
                    ..
                } => {
                    if matches!(
                        delivery_mode,
                        Some(agents::ConversationSteeringDeliveryMode::InterruptRestart)
                    ) {
                        if let Some(turn) = turns.get_mut(&expected_turn_id) {
                            turn.pending_steering = None;
                        }
                    } else {
                        ensure_turn(turns, turn_order, expected_turn_id, record);
                        let turn = turns.get_mut(&expected_turn_id).expect("turn exists");
                        apply_accepted_steering(turn, steering_id, record);
                        touched_turn_rows = Some(TouchedTurnRows::ChangedAt(
                            expected_turn_id,
                            record.sequence,
                        ));
                    }
                }
                agents::ConversationSteeringEvent::Rejected {
                    expected_turn_id, ..
                }
                | agents::ConversationSteeringEvent::Unknown {
                    expected_turn_id, ..
                } => {
                    if let Some(turn) = turns.get_mut(&expected_turn_id) {
                        turn.pending_steering = None;
                    }
                }
            },
            ConversationEvent::UserSubmittedFeedback {
                note_id,
                text,
                turn_id,
                ..
            } => {
                if let Some(turn_id) = turn_id.or(record.turn_id) {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    insert_mid_turn_user_slice(
                        turn,
                        note_id,
                        vec![ContentBlock::Text { text }],
                        record,
                    );
                    touched_turn_rows = Some(TouchedTurnRows::ChangedAt(turn_id, record.sequence));
                }
            }
            other => {
                self.apply_side_row_event(record, other, &mut deleted_rows);
            }
        }

        self.collect_step_row_ops(
            record.sequence,
            deleted_rows,
            touched_turn_rows,
            assistant_emit,
        )
    }

    pub(super) fn resolved_turn_id(&self, record: &ConversationEventRecord) -> Option<Uuid> {
        record.turn_id.or_else(|| self.turn_order.last().copied())
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ProjectedTurn {
    pub(super) turn_id: Uuid,
    pub(super) user: MessageTurn,
    pub(super) assistant: MessageTurn,
    /// Closed assistant/user slices that preceded the current assistant bubble
    /// after in-turn steering.
    #[serde(default)]
    pub(super) prefix_segments: Vec<MessageTurn>,
    #[serde(default)]
    pub(super) prefix_segment_revisions: Vec<i64>,
    #[serde(default)]
    pub(super) pending_steering: Option<(Uuid, Vec<ContentBlock>)>,
    pub(super) phase: String,
    /// Independent sequence of the latest event that touched `{turn_id}:user`.
    #[serde(default)]
    pub(super) user_revision: i64,
    /// Sequence of the latest event that touched the active assistant segment.
    #[serde(default)]
    pub(super) revision: i64,
    /// True once a live row op has carried `assistant.usage`. A sample that
    /// arrives before the first block must still be announced on the next delta.
    #[serde(default)]
    pub(super) usage_announced: bool,
    /// Raw unstripped text accumulated for the current trailing text block.
    #[serde(default)]
    pub(super) trailing_raw_text: String,
    /// Count of internal messages already emitted for `trailing_raw_text`.
    #[serde(default)]
    pub(super) emitted_internal_count: usize,
    #[serde(skip)]
    pub(super) internal_scan_cursor: agents::conversation::InternalMessageScanCursor,
}

impl ProjectedTurn {
    pub(super) fn effective_user_revision(&self) -> i64 {
        if self.user_revision > 0 {
            self.user_revision
        } else {
            self.revision
        }
    }

    pub(super) fn effective_user_phase(&self) -> String {
        match self.phase.as_str() {
            "streaming" | "interrupted" | "failed" | "cancelled" => self.phase.clone(),
            _ => "settled".into(),
        }
    }

    pub(super) fn closed_segment_phase(&self) -> String {
        match self.phase.as_str() {
            "interrupted" | "failed" | "cancelled" => self.phase.clone(),
            _ => "settled".into(),
        }
    }

    pub(super) fn prefix_segment_revision(&self, index: usize) -> i64 {
        self.prefix_segment_revisions
            .get(index)
            .copied()
            .filter(|rev| *rev > 0)
            .unwrap_or(self.revision)
    }

    pub(super) fn bump_all_segment_revisions(&mut self, sequence: i64) {
        self.user_revision = sequence;
        self.revision = sequence;
        for rev in &mut self.prefix_segment_revisions {
            *rev = sequence;
        }
    }
}

fn new_message_turn(
    id: String,
    role: TurnRole,
    blocks: Vec<ContentBlock>,
    timestamp: chrono::DateTime<chrono::Utc>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
) -> MessageTurn {
    MessageTurn {
        id,
        role,
        blocks,
        timestamp,
        usage: None,
        duration_ms: None,
        model: None,
        completed_at,
        agent_message_id: None,
    }
}

pub(super) fn ensure_turn(
    turns: &mut BTreeMap<Uuid, ProjectedTurn>,
    turn_order: &mut Vec<Uuid>,
    turn_id: Uuid,
    record: &ConversationEventRecord,
) {
    if turns.contains_key(&turn_id) {
        return;
    }
    turn_order.push(turn_id);
    turns.insert(
        turn_id,
        ProjectedTurn {
            turn_id,
            user: new_message_turn(
                format!("{turn_id}:user"),
                TurnRole::User,
                Vec::new(),
                record.created_at,
                None,
            ),
            assistant: new_message_turn(
                format!("{turn_id}:assistant"),
                TurnRole::Assistant,
                Vec::new(),
                record.created_at,
                None,
            ),
            prefix_segments: Vec::new(),
            prefix_segment_revisions: Vec::new(),
            pending_steering: None,
            phase: "streaming".into(),
            user_revision: record.sequence,
            revision: record.sequence,
            usage_announced: false,
            trailing_raw_text: String::new(),
            emitted_internal_count: 0,
            internal_scan_cursor: Default::default(),
        },
    );
}

fn flush_trailing_raw_text(turn: &mut ProjectedTurn, conversation_id: Uuid, turn_id: Uuid) {
    finalize_trailing_raw_text(turn, conversation_id, turn_id, true);
}

fn finalize_trailing_raw_text(
    turn: &mut ProjectedTurn,
    conversation_id: Uuid,
    turn_id: Uuid,
    clear_after: bool,
) {
    if turn.trailing_raw_text.is_empty() {
        return;
    }
    let extracted = agents::extract_and_strip_internal_messages(
        &turn.trailing_raw_text,
        Some(conversation_id),
        Some(turn_id),
        false,
    );
    for captured in extracted
        .captured
        .into_iter()
        .skip(turn.emitted_internal_count)
    {
        emit_captured_internal_message(captured);
    }
    match turn.assistant.blocks.last_mut() {
        Some(ContentBlock::Text { text }) => {
            if extracted.visible_text.is_empty() {
                turn.assistant.blocks.pop();
                turn.trailing_raw_text.clear();
            } else {
                *text = extracted.visible_text.clone();
                if clear_after {
                    turn.trailing_raw_text.clear();
                } else {
                    turn.trailing_raw_text = extracted.visible_text;
                }
            }
        }
        _ if !extracted.visible_text.is_empty() => {
            if clear_after {
                turn.trailing_raw_text.clear();
            } else {
                turn.trailing_raw_text = extracted.visible_text.clone();
            }
            turn.assistant.blocks.push(ContentBlock::Text {
                text: extracted.visible_text,
            });
        }
        _ => {
            turn.trailing_raw_text.clear();
        }
    }
    turn.emitted_internal_count = 0;
    turn.internal_scan_cursor = Default::default();
}

fn settle_pending_questions_for_turn(
    side_rows: &mut [TimelineRow],
    side_row_turns: &BTreeMap<String, Uuid>,
    turn_id: Uuid,
    sequence: i64,
) {
    for entry in side_rows.iter_mut() {
        let owned_by_turn = side_row_turns.get(&entry.row_id) == Some(&turn_id);
        if !owned_by_turn {
            continue;
        }
        if let ConversationTimelineRow::QuestionRequest {
            response: slot @ None,
            ..
        } = &mut entry.row
        {
            *slot = Some(ConversationQuestionResponse {
                answer: "cancelled".to_string(),
                content: None,
            });
            entry.revision = sequence;
        }
    }
}

fn settle_turn(
    turns: &mut BTreeMap<Uuid, ProjectedTurn>,
    turn_order: &mut Vec<Uuid>,
    record: &ConversationEventRecord,
    phase: &str,
) -> Uuid {
    let turn_id = record
        .turn_id
        .or_else(|| turn_order.last().copied())
        .unwrap_or(record.conversation_id);
    ensure_turn(turns, turn_order, turn_id, record);
    let turn = turns.get_mut(&turn_id).expect("turn exists");
    finalize_trailing_raw_text(turn, record.conversation_id, turn_id, false);
    let prev_user_phase = turn.effective_user_phase();
    let prev_closed_phase = turn.closed_segment_phase();
    if !(turn.phase == "failed" && phase == "settled") {
        turn.phase = phase.into();
    }
    if turn.closed_segment_phase() != prev_closed_phase {
        turn.bump_all_segment_revisions(record.sequence);
    } else if turn.effective_user_phase() != prev_user_phase {
        turn.user_revision = record.sequence;
        turn.revision = record.sequence;
    } else {
        turn.revision = record.sequence;
    }
    turn.assistant.completed_at = Some(record.created_at);
    turn.assistant.duration_ms = Some(
        record
            .created_at
            .signed_duration_since(turn.assistant.timestamp)
            .num_milliseconds()
            .max(0) as u64,
    );
    turn_id
}

fn assistant_content_is_turn_error_echo(
    blocks: &[ContentBlock],
    error: &ConversationError,
) -> bool {
    if blocks.is_empty() {
        return false;
    }
    if blocks.iter().any(|block| {
        !matches!(
            block,
            ContentBlock::Text { .. } | ContentBlock::Thinking { .. }
        )
    }) {
        return false;
    }
    let assistant_text = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if assistant_text.is_empty() {
        return false;
    }
    texts_are_error_echo(&assistant_text, &error.message)
}

fn texts_are_error_echo(assistant_text: &str, error_message: &str) -> bool {
    let assistant = collapse_ws(assistant_text);
    let error = collapse_ws(error_message);
    if assistant.is_empty() || error.is_empty() {
        return false;
    }
    error.contains(&assistant) || assistant.contains(&error)
}

fn collapse_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn content_blocks_from_input(
    blocks: &[agents::conversation::ConversationInputBlock],
    include_protocol: bool,
) -> Vec<ContentBlock> {
    blocks
        .iter()
        .filter_map(|block| match block {
            agents::conversation::ConversationInputBlock::Text { text } => {
                Some(ContentBlock::Text { text: text.clone() })
            }
            agents::conversation::ConversationInputBlock::Image { uri, mime_type, .. } => {
                Some(ContentBlock::Image {
                    data: String::new(),
                    mime_type: mime_type.clone(),
                    uri: Some(uri.clone()),
                    width: None,
                    height: None,
                })
            }
            agents::conversation::ConversationInputBlock::Protocol { content }
                if include_protocol =>
            {
                Some(ContentBlock::Protocol {
                    content: content.clone(),
                })
            }
            agents::conversation::ConversationInputBlock::Resource { .. }
            | agents::conversation::ConversationInputBlock::Protocol { .. } => None,
        })
        .collect()
}

fn apply_accepted_steering(
    turn: &mut ProjectedTurn,
    steering_id: Uuid,
    record: &ConversationEventRecord,
) {
    let blocks = turn
        .pending_steering
        .take()
        .filter(|(id, _)| *id == steering_id)
        .map(|(_, blocks)| blocks)
        .unwrap_or_default();
    insert_mid_turn_user_slice(turn, steering_id, blocks, record);
}

fn insert_mid_turn_user_slice(
    turn: &mut ProjectedTurn,
    slice_id: Uuid,
    blocks: Vec<ContentBlock>,
    record: &ConversationEventRecord,
) {
    if !turn.assistant.blocks.is_empty() {
        let mut closed = turn.assistant.clone();
        let carry_usage = closed.usage.take();
        closed.completed_at = Some(record.created_at);
        turn.prefix_segments.push(closed);
        turn.prefix_segment_revisions.push(record.sequence);
        let next = turn.prefix_segments.len() + 1;
        let mut next_assistant = new_message_turn(
            format!("{}:assistant:{next}", turn.turn_id),
            TurnRole::Assistant,
            Vec::new(),
            record.created_at,
            None,
        );
        next_assistant.usage = carry_usage;
        turn.assistant = next_assistant;
        turn.usage_announced = false;
        turn.clear_trailing_raw_text();
    }
    if !blocks.is_empty() {
        turn.prefix_segments.push(new_message_turn(
            format!("{}:steer:{slice_id}", turn.turn_id),
            TurnRole::User,
            blocks,
            record.created_at,
            Some(record.created_at),
        ));
        turn.prefix_segment_revisions.push(record.sequence);
    }
    turn.revision = record.sequence;
}

pub(super) fn append_thinking_block(blocks: &mut Vec<ContentBlock>, text: String) {
    if let Some(ContentBlock::Thinking { text: existing }) = blocks.last_mut() {
        existing.push_str(&text);
    } else {
        blocks.push(ContentBlock::Thinking { text });
    }
}

fn extract_tool_output_append(
    tool_call: &agents::conversation::ConversationToolCallPatch,
) -> Option<String> {
    let meta_append = tool_call
        .metadata
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .is_some_and(|m| {
            [
                "raw_output_append",
                "rawOutputAppend",
                "append",
                "delta",
                "terminalOutputDelta",
            ]
            .iter()
            .any(|k| m.get(*k).and_then(serde_json::Value::as_bool) == Some(true))
        });
    if tool_call.raw_output.is_none() || meta_append {
        tool_call.raw_output_append.clone().or_else(|| {
            meta_append
                .then(|| tool_call.raw_output.as_ref()?.as_str().map(str::to_owned))
                .flatten()
        })
    } else {
        None
    }
}

fn apply_session_info_patch(
    side_rows: &mut Vec<TimelineRow>,
    deleted_rows: &mut Vec<ConversationRowOp>,
    record: &ConversationEventRecord,
    patch: &serde_json::Value,
) {
    let Some(obj) = patch.as_object() else { return };
    let notice = |title: &str, message: Option<String>, severity: &str, id: String| {
        ConversationSessionNotice {
            title: title.into(),
            message,
            severity: severity.into(),
            announcement_id: Some(id),
            ..Default::default()
        }
    };
    match obj
        .get("autoCompactionInProgress")
        .and_then(|v| v.as_bool())
    {
        Some(true) => upsert_stable_notice(
            side_rows,
            "notice:context-compaction",
            record.sequence,
            notice(
                "Compacting conversation context…",
                obj.get("trigger")
                    .and_then(|v| v.as_str())
                    .map(|t| format!("Trigger: {t}")),
                "info",
                "context_compaction".into(),
            ),
        ),
        Some(false) => remove_side_row(
            side_rows,
            deleted_rows,
            "notice:context-compaction",
            record.sequence,
        ),
        None => {}
    }
    if let Some(warn) = obj.get("modelConsistencyWarning") {
        if warn.is_null() {
            remove_side_row(
                side_rows,
                deleted_rows,
                "notice:model-consistency-warning",
                record.sequence,
            );
        } else {
            let msg = warn.as_str().map(str::to_owned).or_else(|| {
                let w = warn.as_object()?;
                w.get("message")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .or_else(|| {
                        let req = w
                            .get("requestedModel")
                            .or_else(|| w.get("requested_model"))?
                            .as_str()?;
                        let srv = w
                            .get("servedModel")
                            .or_else(|| w.get("served_model"))?
                            .as_str()?;
                        Some(format!(
                            "Requested model `{req}`, but provider served `{srv}`."
                        ))
                    })
            });
            upsert_stable_notice(
                side_rows,
                "notice:model-consistency-warning",
                record.sequence,
                notice(
                    "Model consistency warning",
                    msg,
                    "warning",
                    "model_consistency_warning".into(),
                ),
            );
        }
    }
    if let Some(rl) = obj.get("rateLimits").and_then(|v| v.as_object()) {
        let win = rl.get("primary").and_then(|v| v.as_object()).unwrap_or(rl);
        let reset = rl
            .get("resetAt")
            .or_else(|| rl.get("resetsAt"))
            .or_else(|| win.get("resetsAt"))
            .or_else(|| win.get("resetAt"));
        let status = rl.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let zero_quota = rl.get("requestsRemaining").and_then(|v| v.as_i64()) == Some(0)
            || rl.get("tokensRemaining").and_then(|v| v.as_i64()) == Some(0);
        let full_util = rl
            .get("utilization")
            .and_then(|v| v.as_f64())
            .is_some_and(|u| (0.9999..=1.05).contains(&u) || u >= 100.0)
            || win
                .get("usedPercent")
                .and_then(|v| v.as_f64())
                .is_some_and(|u| u >= 100.0);
        let limited = rl
            .get("isRateLimited")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| {
                matches!(status, "rejected" | "rate_limited" | "exceeded" | "limited")
                    || ((zero_quota || full_util) && reset.is_some())
            });
        if limited {
            let meta = serde_json::json!({ "kind": "rate_limit", "isRateLimited": true, "limitedAt": record.created_at.to_rfc3339(), "resetAt": reset });
            upsert_stable_notice(
                side_rows,
                "notice:rate-limit",
                record.sequence,
                notice(
                    "Rate limit reached",
                    rl.get("message")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned),
                    "warning",
                    meta.to_string(),
                ),
            );
        } else {
            remove_side_row(
                side_rows,
                deleted_rows,
                "notice:rate-limit",
                record.sequence,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use agents::{
        AgentId,
        conversation::{
            ConversationAgentConnectionStatus, ConversationEvent, ConversationSessionNotice,
            ConversationTimelineRow, ConversationUsage, TurnUsage,
        },
    };
    use db::models::conversation_event::{CURRENT_EVENT_VERSION, ConversationEventRecord};
    use uuid::Uuid;

    use super::merge_reported_turn_usage;
    use crate::projection::{
        CONVERSATION_PROJECTION_VERSION, ConversationProjector, rows::tests::diagnostic_record,
    };
    #[test]
    fn newer_event_version_renders_upgrade_guidance() {
        let conversation_id = Uuid::new_v4();
        let timeline = ConversationProjector::project_records(
            conversation_id,
            &[ConversationEventRecord {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                sequence: 1,
                source: "test".into(),
                event_kind: "future_event".into(),
                event_version: CURRENT_EVENT_VERSION + 1,
                normalized_json: r#"{"kind":"future_event"}"#.into(),
                raw_json: None,
                idempotency_key: None,
                created_at: chrono::Utc::now(),
            }],
        )
        .expect("future event should degrade to a notice");

        let notice = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::SessionNotice { notice } => Some(notice),
            _ => None,
        });
        assert_eq!(
            notice.map(|notice| notice.title.as_str()),
            Some("此会话包含较新版本的记录")
        );
        assert!(
            notice
                .and_then(|notice| notice.message.as_deref())
                .is_some_and(|message| message.contains("更新 Dimo"))
        );
    }

    #[test]
    fn unrecognized_ext_notifications_are_not_timeline_notices() {
        let conversation_id = Uuid::new_v4();
        let ext = ConversationEvent::RawDiagnosticRecorded {
            label: "ext_notification".into(),
            payload: Some(serde_json::json!({
                "kind": "ext_notification",
                "method": "x.ai/announcements/update",
            })),
        };
        let skipped = ConversationEvent::RawDiagnosticRecorded {
            label: "session_config_override_skipped".into(),
            payload: Some(serde_json::json!({
                "kind": "session_config_override_skipped",
                "reason": "config_choice_not_found",
                "requested": "model=missing",
            })),
        };
        let user_ack = ConversationEvent::RawDiagnosticRecorded {
            label: "user_message_acknowledged".into(),
            payload: Some(serde_json::json!({
                "kind": "user_message_acknowledged",
                "preview": "hello",
            })),
        };
        let companion = ConversationEvent::RawDiagnosticRecorded {
            label: "companion_capability".into(),
            payload: Some(serde_json::json!({
                "kind": "companion_capability",
                "code": "official_product_mcp_disabled",
            })),
        };
        let timeline = ConversationProjector::project_records(
            conversation_id,
            &[
                diagnostic_record(conversation_id, 1, &ext),
                diagnostic_record(conversation_id, 2, &skipped),
                diagnostic_record(conversation_id, 3, &user_ack),
                diagnostic_record(conversation_id, 4, &companion),
            ],
        )
        .expect("diagnostics should fold");

        let notices: Vec<&ConversationSessionNotice> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice } => Some(notice),
                _ => None,
            })
            .collect();
        assert_eq!(
            notices.len(),
            1,
            "protocol and capability noise must stay hidden"
        );
        assert_eq!(notices[0].title, "会话配置未应用");
        assert!(notices.iter().all(|notice| {
            notice.title != "未识别的会话更新"
                && notice.title != "用户消息已确认"
                && notice.title != "未识别的代理通知"
        }));
    }

    #[test]
    fn prompt_cancel_requested_is_not_a_timeline_notice() {
        let conversation_id = Uuid::new_v4();
        let cancel = ConversationEvent::RawDiagnosticRecorded {
            label: "prompt_cancel_requested".into(),
            payload: Some(serde_json::json!({
                "kind": "prompt_cancel_requested",
                "prompt_id": Uuid::new_v4(),
            })),
        };
        let acp_update = ConversationEvent::RawDiagnosticRecorded {
            label: "prompt_cancel_requested".into(),
            payload: Some(serde_json::json!({
                "sessionUpdate": "prompt_cancel_requested",
            })),
        };
        let timeline = ConversationProjector::project_records(
            conversation_id,
            &[
                diagnostic_record(conversation_id, 1, &cancel),
                diagnostic_record(conversation_id, 2, &acp_update),
            ],
        )
        .expect("cancel handshake diagnostics should fold");

        assert!(
            timeline
                .rows
                .iter()
                .all(|row| { !matches!(row.row, ConversationTimelineRow::SessionNotice { .. }) }),
            "stopping a turn must not surface a session notice"
        );
    }

    #[test]
    fn agent_session_notices_project_as_warning_cards() {
        let conversation_id = Uuid::new_v4();
        let event = ConversationEvent::RawDiagnosticRecorded {
            label: agents::AGENT_SESSION_NOTICE_KIND.into(),
            payload: Some(serde_json::json!({
                "kind": agents::AGENT_SESSION_NOTICE_KIND,
                "title": "Skill descriptions were shortened to fit the skills context budget.",
                "message": "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter.",
                "severity": "warning",
            })),
        };
        let timeline = ConversationProjector::project_records(
            conversation_id,
            &[diagnostic_record(conversation_id, 1, &event)],
        )
        .expect("agent notice should fold");
        assert_eq!(timeline.rows.len(), 1);
        match &timeline.rows[0].row {
            ConversationTimelineRow::SessionNotice { notice } => {
                assert_eq!(
                    notice.title,
                    "Skill descriptions were shortened to fit the skills context budget."
                );
                assert_eq!(notice.severity, "warning");
                assert!(
                    notice
                        .message
                        .as_deref()
                        .is_some_and(|message| message.contains("Codex can still see every skill"))
                );
            }
            other => panic!("expected session notice, got {other:?}"),
        }
    }

    #[test]
    fn announcement_updates_replace_previous_banners() {
        let conversation_id = Uuid::new_v4();
        let first = ConversationEvent::AnnouncementsUpdated {
            generation: 1,
            notices: vec![ConversationSessionNotice {
                title: "Grok CLI".into(),
                message: Some("A new version is available.".into()),
                severity: "info".into(),
                announcement_id: Some("cli-update".into()),
                action: Some(
                    agents::conversation::ConversationNoticeAction::UpdateAgent {
                        agent_id: AgentId::parse("grok").expect("grok"),
                        fallback_url: Some("https://x.ai/cli/install".into()),
                    },
                ),
                ..Default::default()
            }],
        };
        let cleared = ConversationEvent::AnnouncementsUpdated {
            generation: 2,
            notices: Vec::new(),
        };
        let first_timeline = ConversationProjector::project_records(
            conversation_id,
            &[ConversationEventRecord {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                sequence: 1,
                source: "acp".into(),
                event_kind: "announcements_updated".into(),
                event_version: CURRENT_EVENT_VERSION,
                normalized_json: serde_json::to_string(&first).expect("first json"),
                raw_json: None,
                idempotency_key: None,
                created_at: chrono::Utc::now(),
            }],
        )
        .expect("first announcements");
        assert_eq!(first_timeline.rows.len(), 1);
        assert_eq!(
            first_timeline.rows[0].row_id,
            "notice:announcement:cli-update"
        );

        let cleared_timeline = ConversationProjector::project_records(
            conversation_id,
            &[
                ConversationEventRecord {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    sequence: 1,
                    source: "acp".into(),
                    event_kind: "announcements_updated".into(),
                    event_version: CURRENT_EVENT_VERSION,
                    normalized_json: serde_json::to_string(&first).expect("first json"),
                    raw_json: None,
                    idempotency_key: None,
                    created_at: chrono::Utc::now(),
                },
                ConversationEventRecord {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    sequence: 2,
                    source: "acp".into(),
                    event_kind: "announcements_updated".into(),
                    event_version: CURRENT_EVENT_VERSION,
                    normalized_json: serde_json::to_string(&cleared).expect("cleared json"),
                    raw_json: None,
                    idempotency_key: None,
                    created_at: chrono::Utc::now(),
                },
            ],
        )
        .expect("cleared announcements");
        assert!(cleared_timeline.rows.is_empty());
    }

    #[test]
    fn host_note_stays_when_announcements_clear() {
        let conversation_id = Uuid::new_v4();
        let note = ConversationEvent::RawDiagnosticRecorded {
            label: "host_note".into(),
            payload: Some(serde_json::json!({
                "kind": "host_note",
                "title": "人设",
                "message": "只评论 diff，不改文件",
                "announcementId": "host-note:persona",
            })),
        };
        let cleared = ConversationEvent::AnnouncementsUpdated {
            generation: 1,
            notices: Vec::new(),
        };
        let timeline = ConversationProjector::project_records(
            conversation_id,
            &[
                diagnostic_record(conversation_id, 1, &note),
                ConversationEventRecord {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    sequence: 2,
                    source: "acp".into(),
                    event_kind: "announcements_updated".into(),
                    event_version: CURRENT_EVENT_VERSION,
                    normalized_json: serde_json::to_string(&cleared).expect("cleared json"),
                    raw_json: None,
                    idempotency_key: None,
                    created_at: chrono::Utc::now(),
                },
            ],
        )
        .expect("host note survives");
        assert_eq!(timeline.rows.len(), 1);
        assert_eq!(timeline.rows[0].row_id, "host-note:persona");
        match &timeline.rows[0].row {
            ConversationTimelineRow::SessionNotice { notice } => {
                assert_eq!(notice.message.as_deref(), Some("只评论 diff，不改文件"));
            }
            other => panic!("expected host note, got {other:?}"),
        }
    }

    #[test]
    fn reconnect_progress_notice_replaces_itself_and_clears_on_ready() {
        let conversation_id = Uuid::new_v4();
        let progress = ConversationEvent::RawDiagnosticRecorded {
            label: agents::SESSION_RECONNECT_PROGRESS_KIND.into(),
            payload: Some(serde_json::json!({
                "kind": agents::SESSION_RECONNECT_PROGRESS_KIND,
                "attempt": 3,
                "max": 10,
            })),
        };
        let error = ConversationEvent::RawDiagnosticRecorded {
            label: agents::SESSION_CONNECT_ERROR_KIND.into(),
            payload: Some(serde_json::json!({
                "kind": agents::SESSION_CONNECT_ERROR_KIND,
                "message": "agent connection closed",
            })),
        };
        let ready = ConversationEvent::AgentConnectionStatusChanged {
            status: ConversationAgentConnectionStatus::Ready,
            message: None,
            bound: true,
        };
        let in_progress = ConversationProjector::project_records(
            conversation_id,
            &[diagnostic_record(conversation_id, 1, &progress)],
        )
        .expect("reconnect progress notice");
        let progress_notices: Vec<_> = in_progress
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.connection_status.is_none() && notice.request_status.is_none() =>
                {
                    Some(notice)
                }
                _ => None,
            })
            .collect();
        assert_eq!(progress_notices.len(), 1);
        assert!(progress_notices[0].title.contains("正在重连 3/10"));

        let retrying = ConversationProjector::project_records(
            conversation_id,
            &[
                diagnostic_record(conversation_id, 1, &progress),
                diagnostic_record(conversation_id, 2, &error),
            ],
        )
        .expect("reconnect notices");
        let notices: Vec<_> = retrying
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.connection_status.is_none() && notice.request_status.is_none() =>
                {
                    Some(notice)
                }
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().any(|notice| notice.severity == "error"));

        let recovered = ConversationProjector::project_records(
            conversation_id,
            &[
                diagnostic_record(conversation_id, 1, &progress),
                diagnostic_record(conversation_id, 2, &error),
                diagnostic_record(conversation_id, 3, &ready),
            ],
        )
        .expect("ready clears reconnect notices");
        assert!(recovered.rows.iter().all(|row| {
            row.row_id == "status:agent-connection"
                || !matches!(row.row, ConversationTimelineRow::SessionNotice { .. })
        }));
    }

    #[test]
    fn connecting_warning_is_visible_until_the_turn_settles() {
        let conversation_id = Uuid::new_v4();
        let connecting = ConversationEvent::AgentConnectionStatusChanged {
            status: ConversationAgentConnectionStatus::Connecting,
            message: None,
            bound: false,
        };
        let waiting = ConversationProjector::project_records(
            conversation_id,
            &[diagnostic_record(conversation_id, 1, &connecting)],
        )
        .expect("connecting notice");
        let notices: Vec<_> = waiting
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.connection_status.is_none() && notice.request_status.is_none() =>
                {
                    Some(notice)
                }
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].severity, "info");
        assert!(notices[0].title.contains("正在连接"));

        let cancelled = ConversationEvent::TurnCancelled { reason: None };
        let settled = ConversationProjector::project_records(
            conversation_id,
            &[
                diagnostic_record(conversation_id, 1, &connecting),
                diagnostic_record(conversation_id, 2, &cancelled),
            ],
        )
        .expect("cancel clears connecting notice");
        assert!(
            settled.rows.iter().all(|row| {
                row.row_id.starts_with("status:")
                    || !matches!(row.row, ConversationTimelineRow::SessionNotice { .. })
            }),
            "stopping a hang must remove the connecting warning so the user is not left waiting"
        );
    }

    #[test]
    fn conversation_projection_fixtures_are_present_and_parse() {
        let fixtures = [
            (
                "happy-path",
                include_str!("../../../db/fixtures/conversation-projection/happy-path.json"),
            ),
            (
                "no-assistant-output-error",
                include_str!(
                    "../../../db/fixtures/conversation-projection/no-assistant-output-error.json"
                ),
            ),
            (
                "permission-blocked",
                include_str!(
                    "../../../db/fixtures/conversation-projection/permission-blocked.json"
                ),
            ),
            (
                "tool-heavy",
                include_str!("../../../db/fixtures/conversation-projection/tool-heavy.json"),
            ),
            (
                "terminal",
                include_str!("../../../db/fixtures/conversation-projection/terminal.json"),
            ),
            (
                "file-change",
                include_str!("../../../db/fixtures/conversation-projection/file-change.json"),
            ),
        ];
        for (expected_name, raw) in fixtures {
            let value: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
            assert_eq!(value["name"], expected_name);
            assert_eq!(value["projectionVersion"], CONVERSATION_PROJECTION_VERSION);
            assert!(value["events"].as_array().is_some_and(|e| !e.is_empty()));
            assert!(
                value["expectedTimeline"]
                    .as_array()
                    .is_some_and(|r| !r.is_empty())
            );
        }
    }

    #[test]
    fn occupancy_update_keeps_reported_protocol_buckets() {
        let existing = TurnUsage {
            input_tokens: 20,
            output_tokens: 10,
            cache_read_input_tokens: 70,
            ..Default::default()
        };
        let merged = merge_reported_turn_usage(
            Some(existing),
            &ConversationUsage {
                context_used: Some(12_000),
                context_window_max: Some(200_000),
                ..Default::default()
            },
        );
        assert_eq!(
            (
                merged.input_tokens,
                merged.output_tokens,
                merged.cache_read_input_tokens
            ),
            (20, 10, 70)
        );
        assert_eq!(
            (merged.context_used, merged.context_window_max),
            (Some(12_000), Some(200_000))
        );
    }

    #[test]
    fn session_info_notices_and_tool_output_append_fold_cleanly() {
        use agents::conversation::{ContentBlock, ConversationToolCallPatch};
        let (cid, tid) = (Uuid::new_v4(), Uuid::new_v4());
        let with_turn = |seq, ev: &ConversationEvent| {
            let mut r = diagnostic_record(cid, seq, ev);
            r.turn_id = Some(tid);
            r
        };
        let patch = |raw_output_append: Option<&str>, raw_output: Option<serde_json::Value>| {
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "c1".into(),
                    title: Some("Bash".into()),
                    kind: Some("execute".into()),
                    status: Some("in_progress".into()),
                    raw_input: None,
                    raw_output,
                    raw_output_append: raw_output_append.map(str::to_owned),
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            }
        };
        let info_on = ConversationEvent::AgentSessionInfoUpdated {
            patch: serde_json::json!({
                "autoCompactionInProgress": true, "trigger": "auto",
                "modelConsistencyWarning": { "requestedModel": "claude-opus-4-6", "servedModel": "claude-sonnet-4-5" },
                "rateLimits": { "utilization": 1.0, "resetAt": "2026-11-15T12:00:00Z" }
            }),
        };
        let info_off = ConversationEvent::AgentSessionInfoUpdated {
            patch: serde_json::json!({ "autoCompactionInProgress": false, "rateLimits": { "isRateLimited": false } }),
        };
        let timeline = ConversationProjector::project_records(
            cid,
            &[
                with_turn(1, &patch(Some("chunk-1\n"), None)),
                with_turn(2, &patch(Some("chunk-2\n"), None)),
                diagnostic_record(cid, 3, &info_on),
            ],
        )
        .expect("projection succeeds");
        assert!(
            timeline
                .rows
                .iter()
                .any(|r| r.row_id == "notice:context-compaction")
        );
        assert!(
            timeline
                .rows
                .iter()
                .any(|r| r.row_id == "notice:model-consistency-warning")
        );
        assert!(
            timeline
                .rows
                .iter()
                .any(|r| r.row_id == "notice:rate-limit")
        );
        let output = timeline.rows.iter().find_map(|r| match &r.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => {
                turn.blocks.iter().find_map(|b| match b {
                    ContentBlock::ToolResult { output_preview, .. } => output_preview.clone(),
                    _ => None,
                })
            }
            _ => None,
        });
        assert_eq!(output.as_deref(), Some("chunk-1\nchunk-2\n"));
        let cleared = ConversationProjector::project_records(
            cid,
            &[
                diagnostic_record(cid, 1, &info_on),
                diagnostic_record(cid, 2, &info_off),
            ],
        )
        .expect("clears");
        assert!(!cleared.rows.iter().any(|r| r.row_id == "notice:context-compaction" || r.row_id == "notice:rate-limit"));
    }

    #[test]
    fn terminal_turn_events_settle_pending_question_requests() {
        use agents::conversation::{ConversationError, ConversationQuestionRequest};
        let cid = Uuid::new_v4();
        let make_question = |tid: Uuid, qid: &str, seq: i64| {
            let ev = ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: qid.to_string(),
                    prompt: "Proceed?".to_string(),
                    options: vec!["Yes".to_string(), "No".to_string()],
                    schema: None,
                    asked_at: None,
                },
            };
            let mut rec = diagnostic_record(cid, seq, &ev);
            rec.turn_id = Some(tid);
            rec.event_kind = "question_requested".to_string();
            rec
        };
        let make_terminal = |tid: Uuid, seq: i64, ev: ConversationEvent, kind: &str| {
            let mut rec = diagnostic_record(cid, seq, &ev);
            rec.turn_id = Some(tid);
            rec.event_kind = kind.to_string();
            rec
        };

        let t1 = Uuid::new_v4();
        let t2 = Uuid::new_v4();
        let t3 = Uuid::new_v4();
        let timeline = ConversationProjector::project_records(
            cid,
            &[
                make_question(t1, "q-cancel", 1),
                make_terminal(
                    t1,
                    2,
                    ConversationEvent::TurnCancelled { reason: None },
                    "turn_cancelled",
                ),
                make_question(t2, "q-interrupt", 3),
                make_terminal(
                    t2,
                    4,
                    ConversationEvent::TurnInterrupted { reason: None },
                    "turn_interrupted",
                ),
                make_question(t3, "q-fail", 5),
                make_terminal(
                    t3,
                    6,
                    ConversationEvent::TurnFailed {
                        error: ConversationError::new("boom", None, None),
                    },
                    "turn_failed",
                ),
            ],
        )
        .expect("projection succeeds");

        let answers: Vec<(String, Option<String>)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::QuestionRequest { request, response } => Some((
                    request.question_id.clone(),
                    response.as_ref().map(|r| r.answer.clone()),
                )),
                _ => None,
            })
            .collect();
        assert_eq!(
            answers,
            vec![
                ("q-cancel".to_string(), Some("cancelled".to_string())),
                ("q-interrupt".to_string(), Some("cancelled".to_string())),
                ("q-fail".to_string(), Some("cancelled".to_string())),
            ]
        );
    }
}
