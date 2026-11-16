//! Realtime `ConversationRowOpBatch` coalescer (`<= 60 FPS`).
//!
//! Coalesces high-frequency streaming `Upsert` / `AppendText` / `PatchBlocks` updates
//! in-place per `(conversation_id, row_id)` over a `16ms` window (`MAX_PENDING_UPDATES = 512`,
//! `MAX_PENDING_BYTES = 64 KiB`), while flushing immediately on terminal turn events,
//! `Delete` tombstones, `reset: true` barriers, or explicit `flush_conversation` calls.

use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

use agents::conversation::{
    ContentBlock, ConversationRowOp, ConversationRowOpBatch, ConversationTimelineRow,
    TimelineTextStream, TurnUsage,
};
use tokio::{task::AbortHandle, time::Instant};
use uuid::Uuid;

use crate::live_pipeline::ConversationEventSink;

pub const COALESCE_WINDOW: Duration = Duration::from_millis(16);
pub const MAX_PENDING_UPDATES: usize = 512;
pub const MAX_PENDING_BYTES: usize = 64 * 1024;

struct PendingBatch {
    batch: ConversationRowOpBatch,
    emit_global: bool,
    pending_updates: usize,
    pending_bytes: usize,
    timer_abort: Option<AbortHandle>,
}

#[derive(Default)]
struct ConversationCoalesceSlot {
    next_allowed_at: Option<Instant>,
    pending: Option<PendingBatch>,
}

impl ConversationCoalesceSlot {
    fn take_pending_for_flush(&mut self) -> Option<(ConversationRowOpBatch, bool)> {
        let mut pending = self.pending.take()?;
        pending.pending_updates = 0;
        pending.pending_bytes = 0;
        if let Some(abort) = pending.timer_abort.take() {
            abort.abort();
        }
        Some((pending.batch, pending.emit_global))
    }
}

pub struct LiveRowOpCoalescer {
    sink: Arc<dyn ConversationEventSink>,
    window: Duration,
    max_pending_updates: usize,
    max_pending_bytes: usize,
    slots: Arc<Mutex<HashMap<Uuid, ConversationCoalesceSlot>>>,
}

impl LiveRowOpCoalescer {
    pub fn new(sink: Arc<dyn ConversationEventSink>) -> Self {
        Self::with_limits(sink, COALESCE_WINDOW, MAX_PENDING_UPDATES, MAX_PENDING_BYTES)
    }

    pub fn with_config(
        sink: Arc<dyn ConversationEventSink>,
        window: Duration,
        max_pending_updates: usize,
    ) -> Self {
        Self::with_limits(sink, window, max_pending_updates, MAX_PENDING_BYTES)
    }

    pub fn with_limits(
        sink: Arc<dyn ConversationEventSink>,
        window: Duration,
        max_pending_updates: usize,
        max_pending_bytes: usize,
    ) -> Self {
        Self {
            sink,
            window,
            max_pending_updates: max_pending_updates.max(1),
            max_pending_bytes: max_pending_bytes.max(1),
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Submit a batch to the coalescer.
    ///
    /// - `immediate_barrier`: `true` for `reset: true`, terminal turn transitions, `Delete` ops,
    ///   or user/queue lifecycle transitions; cancels any pending timer and flushes immediately.
    /// - `is_streaming`: `true` when the batch carries streaming deltas/patches subject to the
    ///   `16ms` (`<= 60 FPS`) throttle window.
    pub fn submit(
        &self,
        conversation_id: Uuid,
        batch: ConversationRowOpBatch,
        emit_global: bool,
        immediate_barrier: bool,
        is_streaming: bool,
    ) {
        if batch.reset {
            let reset_batch = {
                let mut slots = self
                    .slots
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(mut slot) = slots.remove(&conversation_id) {
                    let _ = slot.take_pending_for_flush();
                }
                batch
            };
            self.emit_now(conversation_id, &reset_batch, true);
            return;
        }

        let immediate_barrier = immediate_barrier || batch.ops.iter().any(is_barrier_op);
        if immediate_barrier || !is_streaming {
            let to_emit = {
                let mut slots = self
                    .slots
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let slot = slots.entry(conversation_id).or_default();
                if immediate_barrier {
                    slot.next_allowed_at = None;
                }
                let result = if let Some((mut pending_batch, pending_global)) =
                    slot.take_pending_for_flush()
                {
                    merge_into_batch(&mut pending_batch, batch);
                    (pending_batch, pending_global || emit_global)
                } else {
                    (batch, emit_global)
                };
                if immediate_barrier {
                    slots.remove(&conversation_id);
                }
                result
            };
            self.emit_now(conversation_id, &to_emit.0, to_emit.1);
            return;
        }

        let now = Instant::now();
        let incoming_weight = batch.ops.len().max(1);
        let incoming_bytes = estimate_batch_ops_bytes(&batch.ops);
        let immediate_emit = {
            let mut slots = self
                .slots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if slots.len() > 64 {
                slots.retain(|id, slot| {
                    *id == conversation_id
                        || slot.pending.is_some()
                        || slot.next_allowed_at.is_some_and(|deadline| deadline > now)
                });
            }
            let slot = slots.entry(conversation_id).or_default();

            // Leading-edge emission when outside the 16ms window and nothing is buffered.
            let window_open = slot.next_allowed_at.is_none_or(|deadline| now >= deadline);
            if window_open && slot.pending.is_none() {
                slot.next_allowed_at = Some(now + self.window);
                Some((batch, emit_global))
            } else {
                let deadline = slot.next_allowed_at.unwrap_or(now + self.window);
                if slot.next_allowed_at.is_none() {
                    slot.next_allowed_at = Some(deadline);
                }

                match slot.pending.as_mut() {
                    Some(pending) => {
                        merge_into_batch(&mut pending.batch, batch);
                        pending.emit_global |= emit_global;
                        pending.pending_updates =
                            pending.pending_updates.saturating_add(incoming_weight);
                        pending.pending_bytes =
                            pending.pending_bytes.saturating_add(incoming_bytes);
                    }
                    None => {
                        slot.pending = Some(PendingBatch {
                            batch,
                            emit_global,
                            pending_updates: incoming_weight,
                            pending_bytes: incoming_bytes,
                            timer_abort: None,
                        });
                    }
                }

                let over_cap = slot.pending.as_ref().is_some_and(|p| {
                    p.pending_updates >= self.max_pending_updates
                        || p.pending_bytes >= self.max_pending_bytes
                });
                if over_cap {
                    let flushed = slot.take_pending_for_flush().expect("pending exists");
                    slot.next_allowed_at = Some(now + self.window);
                    Some(flushed)
                } else {
                    if let Some(pending) = slot.pending.as_mut()
                        && pending.timer_abort.is_none()
                    {
                        let abort = self.spawn_flush_timer(conversation_id, deadline);
                        pending.timer_abort = Some(abort);
                    }
                    None
                }
            }
        };

        if let Some((out_batch, out_global)) = immediate_emit {
            self.emit_now(conversation_id, &out_batch, out_global);
        }
    }

    /// Flush any buffered ops for `conversation_id` immediately (used before session detach/close).
    pub fn flush_conversation(&self, conversation_id: Uuid) {
        let pending = {
            let mut slots = self
                .slots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slots
                .remove(&conversation_id)
                .and_then(|mut slot| slot.take_pending_for_flush())
        };
        if let Some((batch, emit_global)) = pending {
            self.emit_now(conversation_id, &batch, emit_global);
        }
    }

    fn spawn_flush_timer(&self, conversation_id: Uuid, deadline: Instant) -> AbortHandle {
        let slots = Arc::clone(&self.slots);
        let sink = Arc::clone(&self.sink);
        let window = self.window;
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let ready = {
                let mut guard = slots
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(slot) = guard.get_mut(&conversation_id) else {
                    return;
                };
                let Some(flushed) = slot.take_pending_for_flush() else {
                    return;
                };
                slot.next_allowed_at = Some(Instant::now() + window);
                flushed
            };
            sink.emit_conversation_batch(conversation_id, &ready.0);
            if ready.1 {
                sink.emit_global_batch(&ready.0);
            }
        })
        .abort_handle()
    }

    pub fn emit_workspaces_sessions_changed(
        &self,
        payload: crate::live_pipeline::WorkspaceSessionsChanged,
    ) {
        self.sink.emit_workspaces_sessions_changed(payload);
    }

    fn emit_now(
        &self,
        conversation_id: Uuid,
        batch: &ConversationRowOpBatch,
        emit_global: bool,
    ) {
        self.sink.emit_conversation_batch(conversation_id, batch);
        if emit_global {
            self.sink.emit_global_batch(batch);
        }
    }
}

#[derive(Default)]
struct ByteCountWriter(usize);

impl Write for ByteCountWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buf.len());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn is_barrier_op(op: &ConversationRowOp) -> bool {
    match op {
        ConversationRowOp::Delete { .. } => true,
        ConversationRowOp::Upsert { row } => matches!(
            &row.row,
            ConversationTimelineRow::MessageTurn { phase, .. } if phase == "settled"
        ),
        _ => false,
    }
}

fn estimate_row_op_bytes(op: &ConversationRowOp) -> usize {
    match op {
        ConversationRowOp::AppendText { row_id, delta, .. } => {
            48usize.saturating_add(row_id.len()).saturating_add(delta.len())
        }
        ConversationRowOp::Delete { row_id, .. } => 32usize.saturating_add(row_id.len()),
        ConversationRowOp::Upsert { .. } | ConversationRowOp::PatchBlocks { .. } => {
            let mut counter = ByteCountWriter::default();
            let _ = serde_json::to_writer(&mut counter, op);
            counter.0.max(64)
        }
    }
}

fn estimate_batch_ops_bytes(ops: &[ConversationRowOp]) -> usize {
    ops.iter()
        .fold(0usize, |acc, op| acc.saturating_add(estimate_row_op_bytes(op)))
        .max(1)
}

fn op_row_id(op: &ConversationRowOp) -> &str {
    match op {
        ConversationRowOp::Upsert { row } => &row.row_id,
        ConversationRowOp::Delete { row_id, .. } => row_id,
        ConversationRowOp::AppendText { row_id, .. } => row_id,
        ConversationRowOp::PatchBlocks { row_id, .. } => row_id,
    }
}

/// Merge `incoming` into `target` in-place, coalescing streaming `Upsert`, `AppendText`,
/// and `PatchBlocks` per `row_id`.
pub fn merge_into_batch(target: &mut ConversationRowOpBatch, incoming: ConversationRowOpBatch) {
    target.last_sequence = target.last_sequence.max(incoming.last_sequence);
    if target.previous_sequence.is_none() {
        target.previous_sequence = incoming.previous_sequence;
    }
    target.reset |= incoming.reset;
    if incoming.session_modes.is_some() {
        target.session_modes = incoming.session_modes;
    }
    if incoming.session_config_options.is_some() {
        target.session_config_options = incoming.session_config_options;
    }
    if incoming.available_commands.is_some() {
        target.available_commands = incoming.available_commands;
    }
    if incoming.session_goal.is_some() {
        target.session_goal = incoming.session_goal;
    }
    if incoming.async_tasks.is_some() {
        target.async_tasks = incoming.async_tasks;
    }
    if incoming.prompt_suggestion.is_some() {
        target.prompt_suggestion = incoming.prompt_suggestion;
    }
    coalesce_row_ops_in_place(&mut target.ops, incoming.ops);
}

pub fn coalesce_row_ops_in_place(
    ops: &mut Vec<ConversationRowOp>,
    incoming: impl IntoIterator<Item = ConversationRowOp>,
) {
    for op in incoming {
        match op {
            ConversationRowOp::Upsert { row } => {
                ops.retain(|existing| op_row_id(existing) != row.row_id);
                ops.push(ConversationRowOp::Upsert { row });
            }
            ConversationRowOp::Delete { row_id, revision } => {
                ops.retain(|existing| op_row_id(existing) != row_id);
                ops.push(ConversationRowOp::Delete { row_id, revision });
            }
            ConversationRowOp::AppendText {
                row_id,
                revision,
                stream,
                delta,
            } => {
                if let Some(last_idx) = ops.iter().rposition(|o| op_row_id(o) == row_id) {
                    match &mut ops[last_idx] {
                        ConversationRowOp::AppendText {
                            revision: prev_rev,
                            stream: prev_stream,
                            delta: prev_delta,
                            ..
                        } if *prev_stream == stream => {
                            prev_delta.push_str(&delta);
                            *prev_rev = revision;
                            continue;
                        }
                        ConversationRowOp::Upsert { row } => {
                            if let ConversationTimelineRow::MessageTurn { turn, .. } = &mut row.row
                            {
                                append_delta_to_blocks(&mut turn.blocks, stream, &delta);
                                row.revision = revision;
                                continue;
                            }
                        }
                        _ => {}
                    }
                }
                ops.push(ConversationRowOp::AppendText {
                    row_id,
                    revision,
                    stream,
                    delta,
                });
            }
            ConversationRowOp::PatchBlocks {
                row_id,
                revision,
                phase,
                blocks,
                usage,
            } => {
                if let Some(last_idx) = ops.iter().rposition(|o| op_row_id(o) == row_id) {
                    match &mut ops[last_idx] {
                        ConversationRowOp::PatchBlocks {
                            revision: prev_rev,
                            phase: prev_phase,
                            blocks: prev_blocks,
                            usage: prev_usage,
                            ..
                        } => {
                            merge_patched_blocks(prev_blocks, blocks);
                            *prev_phase = phase;
                            *prev_rev = revision;
                            *prev_usage = merge_optional_usage(prev_usage.take(), usage);
                            continue;
                        }
                        ConversationRowOp::Upsert { row } => {
                            if let ConversationTimelineRow::MessageTurn {
                                turn,
                                phase: row_phase,
                                ..
                            } = &mut row.row
                            {
                                merge_patched_blocks(&mut turn.blocks, blocks);
                                *row_phase = phase;
                                turn.usage = merge_optional_usage(turn.usage.take(), usage);
                                row.revision = revision;
                                continue;
                            }
                        }
                        _ => {}
                    }
                }
                ops.push(ConversationRowOp::PatchBlocks {
                    row_id,
                    revision,
                    phase,
                    blocks,
                    usage,
                });
            }
        }
    }
}

fn append_delta_to_blocks(blocks: &mut Vec<ContentBlock>, stream: TimelineTextStream, delta: &str) {
    match stream {
        TimelineTextStream::Text => {
            if let Some(ContentBlock::Text { text }) = blocks.last_mut() {
                text.push_str(delta);
            } else {
                blocks.push(ContentBlock::Text {
                    text: delta.to_string(),
                });
            }
        }
        TimelineTextStream::Reasoning => {
            if let Some(ContentBlock::Thinking { text }) = blocks.last_mut() {
                text.push_str(delta);
            } else {
                blocks.push(ContentBlock::Thinking {
                    text: delta.to_string(),
                });
            }
        }
    }
}

fn merge_patched_blocks(existing: &mut Vec<ContentBlock>, incoming: Vec<ContentBlock>) {
    for block in incoming {
        match &block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                ..
            } => {
                if let Some(slot) = existing.iter_mut().find(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolUse {
                            tool_use_id: Some(existing_id),
                            ..
                        } if existing_id == id
                    )
                }) {
                    *slot = block;
                    continue;
                }
            }
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                ..
            } => {
                if let Some(slot) = existing.iter_mut().find(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolResult {
                            tool_use_id: Some(existing_id),
                            ..
                        } if existing_id == id
                    )
                }) {
                    *slot = block;
                    continue;
                }
            }
            ContentBlock::Plan { .. } => {
                if let Some(slot) = existing
                    .iter_mut()
                    .rev()
                    .find(|b| matches!(b, ContentBlock::Plan { .. }))
                {
                    *slot = block;
                    continue;
                }
            }
            _ => {}
        }
        existing.push(block);
    }
}

fn merge_optional_usage(existing: Option<TurnUsage>, incoming: Option<TurnUsage>) -> Option<TurnUsage> {
    match (existing, incoming) {
        (None, None) => None,
        (Some(prev), None) => Some(prev),
        (None, Some(next)) => Some(next),
        (Some(prev), Some(next)) => {
            let keep_buckets = next.input_tokens == 0
                && next.output_tokens == 0
                && next.cache_creation_input_tokens == 0
                && next.cache_read_input_tokens == 0;
            Some(TurnUsage {
                input_tokens: if keep_buckets {
                    prev.input_tokens
                } else {
                    next.input_tokens
                },
                output_tokens: if keep_buckets {
                    prev.output_tokens
                } else {
                    next.output_tokens
                },
                cache_creation_input_tokens: if keep_buckets {
                    prev.cache_creation_input_tokens
                } else {
                    next.cache_creation_input_tokens
                },
                cache_read_input_tokens: if keep_buckets {
                    prev.cache_read_input_tokens
                } else {
                    next.cache_read_input_tokens
                },
                context_used: next.context_used.or(prev.context_used),
                context_window_max: next.context_window_max.or(prev.context_window_max),
                cost_amount: next.cost_amount.or(prev.cost_amount),
                cost_currency: next.cost_currency.or(prev.cost_currency),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use agents::conversation::{MessageTurn, TimelineRow, TurnRole};
    use chrono::Utc;

    use super::*;
    use crate::live_pipeline::WorkspaceSessionsChanged;

    struct TestSink {
        emitted: Arc<Mutex<Vec<ConversationRowOpBatch>>>,
    }

    impl ConversationEventSink for TestSink {
        fn emit_conversation_batch(&self, _conversation_id: Uuid, batch: &ConversationRowOpBatch) {
            self.emitted.lock().unwrap().push(batch.clone());
        }

        fn emit_global_batch(&self, _batch: &ConversationRowOpBatch) {}

        fn emit_workspaces_sessions_changed(&self, _payload: WorkspaceSessionsChanged) {}
    }

    fn empty_batch(cid: Uuid, prev: i64, last: i64, ops: Vec<ConversationRowOp>) -> ConversationRowOpBatch {
        ConversationRowOpBatch {
            conversation_id: cid,
            last_sequence: last,
            previous_sequence: Some(prev),
            reset: false,
            ops,
            session_modes: None,
            session_config_options: None,
            available_commands: None,
            session_goal: None,
            async_tasks: None,
            prompt_suggestion: None,
        }
    }

    #[tokio::test]
    async fn coalesces_burst_within_16ms_window_and_caps_rate_at_60_fps() {
        assert_eq!(COALESCE_WINDOW, Duration::from_millis(16));
        assert_eq!(MAX_PENDING_UPDATES, 512);
        assert_eq!(MAX_PENDING_BYTES, 64 * 1024);

        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        let coalescer = LiveRowOpCoalescer::new(sink);
        let cid = Uuid::new_v4();

        // Delta 1 emits on leading edge; deltas 2..=40 coalesce in-place inside the 16ms window.
        for seq in 1..=40 {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        stream: TimelineTextStream::Text,
                        delta: "x".into(),
                    }],
                ),
                false,
                false,
                true,
            );
        }

        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "only leading edge emitted before 16ms"
        );
        tokio::time::sleep(Duration::from_millis(45)).await;

        let batches = emitted.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            2,
            "trailing 16ms timer emits 1 merged batch (<= 60 FPS)"
        );
        assert_eq!(batches[1].previous_sequence, Some(1));
        assert_eq!(batches[1].last_sequence, 40);
        assert_eq!(batches[1].ops.len(), 1);
        match &batches[1].ops[0] {
            ConversationRowOp::AppendText {
                delta, revision, ..
            } => {
                assert_eq!(delta.len(), 39);
                assert_eq!(*revision, 40);
            }
            other => panic!("expected coalesced AppendText, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn terminal_barrier_delete_and_reset_flush_immediately_and_patch_blocks_merge_in_place() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        // Use a 10s window to prove zero-delay barrier passthrough without timer expiry.
        let coalescer =
            LiveRowOpCoalescer::with_config(sink, Duration::from_secs(10), MAX_PENDING_UPDATES);
        let cid = Uuid::new_v4();

        // Leading edge delta
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                0,
                1,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 1,
                    stream: TimelineTextStream::Text,
                    delta: "hel".into(),
                }],
            ),
            false,
            false,
            true,
        );

        // Buffered PatchBlocks #1 + PatchBlocks #2 for same tool_use_id
        for (seq, status) in [(2, "in_progress"), (3, "completed")] {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::PatchBlocks {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        phase: "streaming".into(),
                        blocks: vec![ContentBlock::ToolUse {
                            tool_use_id: Some("tool-1".into()),
                            tool_name: "bash".into(),
                            status: Some(status.into()),
                            kind: None,
                            input_preview: None,
                            meta: None,
                            images: Vec::new(),
                            started_at: None,
                            ended_at: None,
                        }],
                        usage: None,
                    }],
                ),
                false,
                false,
                true,
            );
        }
        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "patches stay buffered while inside throttle window"
        );

        // Terminal TurnCompleted / settled Upsert arrives -> flushes immediately with zero delay!
        let settled_row = TimelineRow {
            row_id: "t1:assistant".into(),
            revision: 4,
            row: ConversationTimelineRow::MessageTurn {
                turn: MessageTurn {
                    id: "t1:assistant".into(),
                    role: TurnRole::Assistant,
                    blocks: vec![ContentBlock::Text {
                        text: "hello".into(),
                    }],
                    timestamp: Utc::now(),
                    usage: None,
                    duration_ms: Some(12),
                    model: None,
                    completed_at: Some(Utc::now()),
                    agent_message_id: None,
                },
                phase: "settled".into(),
                fork_point_status: None,
            },
        };
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                3,
                4,
                vec![ConversationRowOp::Upsert { row: settled_row }],
            ),
            true,
            true,
            false,
        );

        let batches = emitted.lock().unwrap().clone();
        assert_eq!(batches.len(), 2, "terminal barrier flushed immediately");
        assert_eq!(batches[1].previous_sequence, Some(1));
        assert_eq!(batches[1].last_sequence, 4);
        assert_eq!(
            batches[1].ops.len(),
            1,
            "settled Upsert superseded buffered PatchBlocks"
        );

        // Next streaming delta emits on leading edge (because terminal barrier cleared cooldown),
        // then second delta buffers, then `Delete` tombstone flushes immediately with zero delay!
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                4,
                5,
                vec![ConversationRowOp::AppendText {
                    row_id: "t2:assistant".into(),
                    revision: 5,
                    stream: TimelineTextStream::Text,
                    delta: "temp".into(),
                }],
            ),
            false,
            false,
            true,
        );
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                5,
                6,
                vec![ConversationRowOp::AppendText {
                    row_id: "t2:assistant".into(),
                    revision: 6,
                    stream: TimelineTextStream::Text,
                    delta: " tail".into(),
                }],
            ),
            false,
            false,
            true,
        );
        assert_eq!(emitted.lock().unwrap().len(), 3, "t2 tail buffered");

        coalescer.submit(
            cid,
            empty_batch(
                cid,
                6,
                7,
                vec![ConversationRowOp::Delete {
                    row_id: "t2:assistant".into(),
                    revision: 7,
                }],
            ),
            true,
            false,
            true,
        );
        let batches = emitted.lock().unwrap().clone();
        assert_eq!(batches.len(), 4, "Delete tombstone flushed immediately");
        assert!(matches!(
            &batches[3].ops[..],
            [ConversationRowOp::Delete { row_id, revision: 7 }] if row_id == "t2:assistant"
        ));

        // Reset barrier cancels any buffered work and emits `reset: true` immediately.
        let mut reset_batch = empty_batch(cid, 7, 8, Vec::new());
        reset_batch.reset = true;
        coalescer.submit(cid, reset_batch, true, true, false);
        let batches = emitted.lock().unwrap().clone();
        assert_eq!(batches.len(), 5);
        assert!(batches[4].reset);
    }

    #[tokio::test]
    async fn max_pending_updates_forces_immediate_flush() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        let coalescer = LiveRowOpCoalescer::with_config(sink, Duration::from_secs(10), 4);
        let cid = Uuid::new_v4();

        for seq in 1..=5 {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        stream: TimelineTextStream::Text,
                        delta: "a".into(),
                    }],
                ),
                false,
                false,
                true,
            );
        }
        // seq 1 = leading edge, seq 2..=5 (4 updates == cap) = immediate cap flush!
        assert_eq!(emitted.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn max_pending_bytes_forces_immediate_flush_before_timer_expiry() {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(TestSink {
            emitted: Arc::clone(&emitted),
        });
        // 10s window guarantees any flush comes from MAX_PENDING_BYTES, not timer expiry.
        let coalescer =
            LiveRowOpCoalescer::with_config(sink, Duration::from_secs(10), MAX_PENDING_UPDATES);
        let cid = Uuid::new_v4();

        // seq 1: leading edge
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                0,
                1,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 1,
                    stream: TimelineTextStream::Text,
                    delta: "lead".into(),
                }],
            ),
            false,
            false,
            true,
        );
        assert_eq!(emitted.lock().unwrap().len(), 1);

        // seq 2..=4: 3 * 20 KiB = ~60 KiB (< MAX_PENDING_BYTES = 64 KiB) -> stays buffered
        let chunk_20k = "a".repeat(20 * 1024);
        for seq in 2..=4 {
            coalescer.submit(
                cid,
                empty_batch(
                    cid,
                    seq - 1,
                    seq,
                    vec![ConversationRowOp::AppendText {
                        row_id: "t1:assistant".into(),
                        revision: seq,
                        stream: TimelineTextStream::Text,
                        delta: chunk_20k.clone(),
                    }],
                ),
                false,
                false,
                true,
            );
        }
        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "60 KiB buffered below 64 KiB high-water mark"
        );

        // seq 5: +8 KiB -> ~68 KiB >= MAX_PENDING_BYTES -> flushes immediately before timer expiry!
        let chunk_8k = "b".repeat(8 * 1024);
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                4,
                5,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 5,
                    stream: TimelineTextStream::Text,
                    delta: chunk_8k,
                }],
            ),
            false,
            false,
            true,
        );
        let batches = emitted.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            2,
            "exceeding MAX_PENDING_BYTES flushes immediately before timer expiry"
        );
        match &batches[1].ops[0] {
            ConversationRowOp::AppendText {
                delta, revision, ..
            } => {
                assert_eq!(delta.len(), 3 * 20 * 1024 + 8 * 1024);
                assert_eq!(*revision, 5);
            }
            other => panic!("expected coalesced AppendText, got {other:?}"),
        }

        // Verify `pending_bytes` was reset to 0 on flush: a small follow-up delta stays buffered.
        coalescer.submit(
            cid,
            empty_batch(
                cid,
                5,
                6,
                vec![ConversationRowOp::AppendText {
                    row_id: "t1:assistant".into(),
                    revision: 6,
                    stream: TimelineTextStream::Text,
                    delta: "small".into(),
                }],
            ),
            false,
            false,
            true,
        );
        assert_eq!(
            emitted.lock().unwrap().len(),
            2,
            "pending_bytes reset to 0 after flush so small follow-up stays buffered"
        );
    }
}
