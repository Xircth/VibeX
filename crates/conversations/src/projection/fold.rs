use std::collections::BTreeMap;

use agents::conversation::{
    ContentBlock, ConversationError, ConversationErrorView, ConversationEvent, ConversationRowOp,
    ConversationTimelineRow, MessageTurn, PlanEntry, TurnRole, cap_json_value, cap_preview_bytes,
};
use db::models::conversation_event::ConversationEventRecord;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    ParsedEvent, ProjectionFold,
    cache::{AssistantEmit, TouchedTurnRows, clear_session_connect_notices},
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
            ParsedEvent::Unknown { kind, .. } => {
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
                    turn.revision = record.sequence;
                    turn.user.blocks = blocks
                        .into_iter()
                        .filter_map(|block| match block {
                            agents::conversation::ConversationInputBlock::Text { text } => {
                                Some(ContentBlock::Text { text })
                            }
                            agents::conversation::ConversationInputBlock::Image {
                                uri,
                                mime_type,
                                ..
                            } => Some(ContentBlock::Image {
                                data: String::new(),
                                mime_type,
                                uri: Some(uri),
                                width: None,
                                height: None,
                            }),
                            agents::conversation::ConversationInputBlock::Resource { .. } => None,
                            agents::conversation::ConversationInputBlock::Protocol { content } => {
                                Some(ContentBlock::Protocol { content })
                            }
                        })
                        .collect();
                    touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
                }
            }
            ConversationEvent::UserTurnStarted => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.revision = record.sequence;
                    turn.assistant.timestamp = record.created_at;
                    touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
                }
            }
            ConversationEvent::AssistantContentAppended { block, .. } => {
                if let Some(turn_id) = record.turn_id.or_else(|| turn_order.last().copied()) {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    let row_existed = !turn.assistant.blocks.is_empty();
                    turn.revision = record.sequence;
                    turn.trailing_raw_text.clear();
                    turn.emitted_internal_count = 0;
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
                                *meta = Some(cap_json_value(metadata));
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
                    let output_preview = if settle_read {
                        None
                    } else {
                        tool_call.raw_output.map(|output| {
                            cap_preview_bytes(match output {
                                serde_json::Value::String(text) => text,
                                other => other.to_string(),
                            })
                        })
                    };
                    if output_preview.is_some() || terminal {
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
                                } else {
                                    if output_preview.is_some() {
                                        *existing_output = output_preview;
                                    }
                                    *existing_error = is_error;
                                }
                            }
                            None => {
                                turn.assistant.blocks.push(ContentBlock::ToolResult {
                                    tool_use_id: Some(call_id),
                                    output_preview,
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
                        // Occupancy often arrives before the first text block, and a
                        // repeated sample is dropped upstream. The live row has to
                        // carry this update now; AppendText never includes usage.
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
            // ACP session metadata is preserved in the durable event log. It is
            // intentionally not folded into VibeX conversation identity/title.
            ConversationEvent::AgentSessionInfoUpdated { .. } => {}
            ConversationEvent::TurnCompleted { .. } => {
                let turn_id = settle_turn(turns, turn_order, record, "settled");
                touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
            }
            ConversationEvent::TurnCancelled { .. } => {
                let turn_id = settle_turn(turns, turn_order, record, "cancelled");
                touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
            }
            ConversationEvent::TurnInterrupted { .. } => {
                clear_session_connect_notices(side_rows, &mut deleted_rows, record.sequence);
                // Mark the turn's phase so the timeline renders the "因重启中断" state
                // with a one-click resend affordance (the user prompt lives on the
                // turn's user row). Never auto-retried — ADR-0001.
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.phase = "interrupted".into();
                    turn.revision = record.sequence;
                    touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
                }
            }
            ConversationEvent::TurnFailed { error } => {
                let turn_id = settle_turn(turns, turn_order, record, "failed");
                touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
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
                    turn.pending_steering = Some((steering_id, content_blocks_from_input(&blocks)));
                    turn.revision = record.sequence;
                    touched_turn_rows = Some(TouchedTurnRows::All(expected_turn_id));
                }
                agents::ConversationSteeringEvent::Accepted {
                    steering_id,
                    expected_turn_id,
                } => {
                    ensure_turn(turns, turn_order, expected_turn_id, record);
                    let turn = turns.get_mut(&expected_turn_id).expect("turn exists");
                    apply_accepted_steering(turn, steering_id, record);
                    touched_turn_rows = Some(TouchedTurnRows::All(expected_turn_id));
                }
                agents::ConversationSteeringEvent::Rejected {
                    expected_turn_id, ..
                }
                | agents::ConversationSteeringEvent::Unknown {
                    expected_turn_id, ..
                } => {
                    if let Some(turn) = turns.get_mut(&expected_turn_id) {
                        turn.pending_steering = None;
                        turn.revision = record.sequence;
                        touched_turn_rows = Some(TouchedTurnRows::All(expected_turn_id));
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
                    touched_turn_rows = Some(TouchedTurnRows::All(turn_id));
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
pub(super) struct ProjectedTurn {
    pub(super) turn_id: Uuid,
    pub(super) user: MessageTurn,
    pub(super) assistant: MessageTurn,
    /// Closed assistant/user slices that preceded the current assistant bubble
    /// after in-turn steering.
    #[serde(default)]
    pub(super) prefix_segments: Vec<MessageTurn>,
    #[serde(default)]
    pub(super) pending_steering: Option<(Uuid, Vec<ContentBlock>)>,
    pub(super) phase: String,
    /// Sequence of the latest event that touched this turn; the revision both message
    /// rows carry. `#[serde(default)]` lets pre-v2 snapshots load (they are discarded
    /// by the projection-version check, but be defensive).
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
            user: MessageTurn {
                id: format!("{turn_id}:user"),
                role: TurnRole::User,
                blocks: Vec::new(),
                timestamp: record.created_at,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
                agent_message_id: None,
            },
            assistant: MessageTurn {
                id: format!("{turn_id}:assistant"),
                role: TurnRole::Assistant,
                blocks: Vec::new(),
                timestamp: record.created_at,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
                agent_message_id: None,
            },
            prefix_segments: Vec::new(),
            pending_steering: None,
            phase: "streaming".into(),
            revision: record.sequence,
            usage_announced: false,
            trailing_raw_text: String::new(),
            emitted_internal_count: 0,
        },
    );
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
    if !turn.trailing_raw_text.is_empty() {
        let extracted = agents::extract_and_strip_internal_messages(
            &turn.trailing_raw_text,
            Some(record.conversation_id),
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
                    turn.trailing_raw_text = extracted.visible_text;
                }
            }
            _ if !extracted.visible_text.is_empty() => {
                turn.trailing_raw_text = extracted.visible_text.clone();
                turn.assistant.blocks.push(ContentBlock::Text {
                    text: extracted.visible_text,
                });
            }
            _ => {
                turn.trailing_raw_text.clear();
            }
        }
        turn.emitted_internal_count = 0;
    }
    turn.revision = record.sequence;
    if !(turn.phase == "failed" && phase == "settled") {
        turn.phase = phase.into();
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
        closed.completed_at = Some(record.created_at);
        turn.prefix_segments.push(closed);
        let next = turn.prefix_segments.len() + 1;
        turn.assistant = MessageTurn {
            id: format!("{}:assistant:{next}", turn.turn_id),
            role: TurnRole::Assistant,
            blocks: Vec::new(),
            timestamp: record.created_at,
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        };
        turn.trailing_raw_text.clear();
        turn.emitted_internal_count = 0;
    }
    if !blocks.is_empty() {
        turn.prefix_segments.push(MessageTurn {
            id: format!("{}:steer:{slice_id}", turn.turn_id),
            role: TurnRole::User,
            blocks,
            timestamp: record.created_at,
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: Some(record.created_at),
            agent_message_id: None,
        });
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
                .is_some_and(|message| message.contains("更新 VibeX"))
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
            assert!(
                value["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
            );
            assert!(
                value["expectedTimeline"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            );
        }
    }

    #[test]
    fn occupancy_update_keeps_reported_protocol_buckets() {
        let existing = TurnUsage {
            input_tokens: 20,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 70,
            context_used: None,
            context_window_max: None,
            cost_amount: None,
            cost_currency: None,
        };
        let merged = merge_reported_turn_usage(
            Some(existing),
            &ConversationUsage {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                context_used: Some(12_000),
                context_window_max: Some(200_000),
                cost_amount: None,
                cost_currency: None,
                model: None,
            },
        );
        assert_eq!(merged.input_tokens, 20);
        assert_eq!(merged.output_tokens, 10);
        assert_eq!(merged.cache_read_input_tokens, 70);
        assert_eq!(merged.context_used, Some(12_000));
        assert_eq!(merged.context_window_max, Some(200_000));
    }
}
