use std::collections::HashMap;

use agents::conversation::{ConversationEvent, ConversationToolCallPatch, ConversationUsage};
use tokio::time::{Duration, Instant};
use uuid::Uuid;

use super::mapping::{
    MappedConversationEventRecord, conversation_event_kind, is_terminal_conversation_event,
    is_terminal_tool_status,
};

pub(crate) const MIN_BOUNDARY_FLUSH: Duration = Duration::from_millis(400);
pub(crate) const IDLE_FLUSH_CEILING: Duration = Duration::from_millis(800);
pub(crate) const MAX_COALESCED_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub(super) enum CoalescedPayload {
    AssistantText {
        text: String,
        message_id: Option<String>,
    },
    AssistantReasoning {
        text: String,
        message_id: Option<String>,
    },
    ToolCallUpsert {
        tool_call: Box<ConversationToolCallPatch>,
    },
}

impl CoalescedPayload {
    fn approx_bytes(&self) -> usize {
        match self {
            Self::AssistantText { text, message_id }
            | Self::AssistantReasoning { text, message_id } => {
                text.len() + message_id.as_ref().map_or(0, String::len)
            }
            Self::ToolCallUpsert { tool_call } => {
                tool_call.tool_call_id.len()
                    + tool_call.title.as_ref().map_or(0, String::len)
                    + tool_call.raw_output_append.as_ref().map_or(0, String::len)
                    + tool_call
                        .raw_output
                        .as_ref()
                        .map_or(0, |v| v.to_string().len())
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct PendingEvent {
    pub(super) slot: u64,
    pub(super) buffered_at: Instant,
    pub(super) base: MappedConversationEventRecord,
    pub(super) payload: CoalescedPayload,
    pub(super) chunk_count: usize,
    pub(super) approx_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum LineKind {
    #[default]
    Empty,
    Indented,
    FenceOpenCandidate {
        ch: u8,
        count: u8,
        info_started: bool,
    },
    FenceCloseCandidate {
        ch: u8,
        count: u8,
        trailing_ws_only: bool,
    },
    HeadingCandidate {
        hashes: u8,
        has_space: bool,
    },
    BulletCandidate {
        has_space: bool,
    },
    OrderedCandidate {
        digits: u8,
        has_delim: bool,
        has_space: bool,
    },
    Other,
}

#[derive(Debug, Clone, Default)]
struct StreamMarkdownScanner {
    in_fence: Option<(u8, u8)>,
    leading_spaces: u8,
    line_kind: LineKind,
    at_safe_boundary: bool,
}

impl StreamMarkdownScanner {
    #[cfg(test)]
    fn is_in_fence(&self) -> bool {
        self.in_fence.is_some()
    }

    fn is_at_safe_boundary(&self) -> bool {
        self.in_fence.is_none() && self.at_safe_boundary
    }

    fn feed(&mut self, text: &str) {
        for &b in text.as_bytes() {
            if b == b'\r' {
                continue;
            }
            if b == b'\n' {
                self.finish_line();
            } else {
                self.at_safe_boundary = false;
                self.feed_line_byte(b);
            }
        }
    }

    fn finish_line(&mut self) {
        if let Some((fch, flen)) = self.in_fence {
            if let LineKind::FenceCloseCandidate {
                ch,
                count,
                trailing_ws_only: true,
            } = self.line_kind
                && ch == fch
                && count >= flen
            {
                self.in_fence = None;
                self.at_safe_boundary = true;
            } else {
                self.at_safe_boundary = false;
            }
        } else {
            match self.line_kind {
                LineKind::FenceOpenCandidate { ch, count, .. } if count >= 3 => {
                    self.in_fence = Some((ch, count));
                    self.at_safe_boundary = false;
                }
                LineKind::Empty
                | LineKind::HeadingCandidate {
                    hashes: 1..=6,
                    has_space: true,
                }
                | LineKind::BulletCandidate { has_space: true }
                | LineKind::OrderedCandidate {
                    has_delim: true,
                    has_space: true,
                    ..
                } => {
                    self.at_safe_boundary = true;
                }
                _ => {
                    self.at_safe_boundary = false;
                }
            }
        }
        self.leading_spaces = 0;
        self.line_kind = LineKind::Empty;
    }

    fn feed_line_byte(&mut self, b: u8) {
        if let Some((fch, flen)) = self.in_fence {
            match self.line_kind {
                LineKind::Empty => {
                    if b == b' ' {
                        self.leading_spaces += 1;
                        if self.leading_spaces >= 4 {
                            self.line_kind = LineKind::Indented;
                        }
                    } else if b == fch {
                        self.line_kind = LineKind::FenceCloseCandidate {
                            ch: b,
                            count: 1,
                            trailing_ws_only: true,
                        };
                    } else {
                        self.line_kind = LineKind::Other;
                    }
                }
                LineKind::FenceCloseCandidate {
                    ch,
                    mut count,
                    mut trailing_ws_only,
                } => {
                    if b == ch && trailing_ws_only && count < 255 {
                        // Still part of closing fence run only if no spaces intervened;
                        // track via whether trailing_ws_only already saw ws.
                        count = count.saturating_add(1);
                        self.line_kind = LineKind::FenceCloseCandidate {
                            ch,
                            count,
                            trailing_ws_only,
                        };
                    } else if (b == b' ' || b == b'\t') && count >= flen {
                        trailing_ws_only = true;
                        // Transition count to locked by setting ch to a sentinel? No: if another
                        // `ch` appears after whitespace, e.g. "``` ```", CommonMark forbids non-ws
                        // after closing fence. Use `Other` if non-ws appears later:
                        self.line_kind = LineKind::FenceCloseCandidate {
                            ch: 0,
                            count,
                            trailing_ws_only,
                        };
                    } else {
                        self.line_kind = LineKind::Other;
                    }
                }
                _ => {}
            }
            return;
        }

        match self.line_kind {
            LineKind::Empty => {
                if b == b' ' {
                    self.leading_spaces += 1;
                    if self.leading_spaces >= 4 {
                        self.line_kind = LineKind::Indented;
                    }
                } else if b == b'\t' {
                    self.line_kind = LineKind::Indented;
                } else if b == b'`' || b == b'~' {
                    self.line_kind = LineKind::FenceOpenCandidate {
                        ch: b,
                        count: 1,
                        info_started: false,
                    };
                } else if b == b'#' {
                    self.line_kind = LineKind::HeadingCandidate {
                        hashes: 1,
                        has_space: false,
                    };
                } else if b == b'-' || b == b'*' || b == b'+' {
                    self.line_kind = LineKind::BulletCandidate { has_space: false };
                } else if b.is_ascii_digit() {
                    self.line_kind = LineKind::OrderedCandidate {
                        digits: 1,
                        has_delim: false,
                        has_space: false,
                    };
                } else {
                    self.line_kind = LineKind::Other;
                }
            }
            LineKind::FenceOpenCandidate {
                ch,
                count,
                info_started,
            } => {
                if !info_started && b == ch {
                    self.line_kind = LineKind::FenceOpenCandidate {
                        ch,
                        count: count.saturating_add(1),
                        info_started: false,
                    };
                } else if count >= 3 {
                    // CommonMark: backtick fence info strings cannot contain backticks
                    // (e.g. "```inline```" on one line is an inline code span, not a fence).
                    if ch == b'`' && b == b'`' {
                        self.line_kind = LineKind::Other;
                    } else {
                        self.line_kind = LineKind::FenceOpenCandidate {
                            ch,
                            count,
                            info_started: true,
                        };
                    }
                } else {
                    self.line_kind = LineKind::Other;
                }
            }
            LineKind::HeadingCandidate { hashes, has_space } => {
                if !has_space && b == b'#' && hashes < 6 {
                    self.line_kind = LineKind::HeadingCandidate {
                        hashes: hashes + 1,
                        has_space: false,
                    };
                } else if !has_space && (b == b' ' || b == b'\t') {
                    self.line_kind = LineKind::HeadingCandidate {
                        hashes,
                        has_space: true,
                    };
                } else if !has_space {
                    self.line_kind = LineKind::Other;
                }
            }
            LineKind::BulletCandidate { has_space } => {
                if !has_space && (b == b' ' || b == b'\t') {
                    self.line_kind = LineKind::BulletCandidate { has_space: true };
                } else if !has_space {
                    self.line_kind = LineKind::Other;
                }
            }
            LineKind::OrderedCandidate {
                digits,
                has_delim,
                has_space,
            } => {
                if !has_delim && b.is_ascii_digit() && digits < 9 {
                    self.line_kind = LineKind::OrderedCandidate {
                        digits: digits + 1,
                        has_delim: false,
                        has_space: false,
                    };
                } else if !has_delim && (b == b'.' || b == b')') {
                    self.line_kind = LineKind::OrderedCandidate {
                        digits,
                        has_delim: true,
                        has_space: false,
                    };
                } else if has_delim && !has_space && (b == b' ' || b == b'\t') {
                    self.line_kind = LineKind::OrderedCandidate {
                        digits,
                        has_delim: true,
                        has_space: true,
                    };
                } else if !has_space {
                    self.line_kind = LineKind::Other;
                }
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MarkdownScanState {
    by_conversation: HashMap<Uuid, StreamMarkdownScanner>,
}

impl MarkdownScanState {
    pub(crate) fn feed(&mut self, conversation_id: Uuid, text: &str) {
        self.by_conversation
            .entry(conversation_id)
            .or_default()
            .feed(text);
    }

    pub(crate) fn mark_non_text(&mut self, conversation_id: Uuid) {
        if let Some(scanner) = self.by_conversation.get_mut(&conversation_id) {
            scanner.at_safe_boundary = false;
        }
    }

    #[cfg(test)]
    pub(crate) fn is_in_fence(&self, conversation_id: Uuid) -> bool {
        self.by_conversation
            .get(&conversation_id)
            .is_some_and(StreamMarkdownScanner::is_in_fence)
    }

    pub(crate) fn is_at_safe_boundary(&self, conversation_id: Uuid) -> bool {
        self.by_conversation
            .get(&conversation_id)
            .is_some_and(StreamMarkdownScanner::is_at_safe_boundary)
    }

    pub(crate) fn clear(&mut self, conversation_id: Uuid) {
        self.by_conversation.remove(&conversation_id);
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TurnSlotTracker {
    next_slot_by_turn: HashMap<(Uuid, Option<Uuid>), u64>,
}

impl TurnSlotTracker {
    fn reserve(&mut self, conversation_id: Uuid, turn_id: Option<Uuid>) -> u64 {
        let entry = self
            .next_slot_by_turn
            .entry((conversation_id, turn_id))
            .or_insert(0);
        let slot = *entry;
        *entry = entry.saturating_add(1);
        slot
    }

    fn clear_conversation(&mut self, conversation_id: Uuid) {
        self.next_slot_by_turn
            .retain(|(cid, _), _| *cid != conversation_id);
    }
}

#[derive(Debug, Clone)]
pub(super) struct PendingUsage {
    buffered_at: Instant,
    base: MappedConversationEventRecord,
    usage: ConversationUsage,
    update_count: usize,
}

impl PendingUsage {
    fn from_record(
        now: Instant,
        base: MappedConversationEventRecord,
        usage: ConversationUsage,
    ) -> Self {
        Self {
            buffered_at: now,
            base,
            usage,
            update_count: 1,
        }
    }

    fn same_context(&self, record: &MappedConversationEventRecord) -> bool {
        self.base.conversation_id == record.conversation_id
            && self.base.turn_id == record.turn_id
            && self.base.binding_id == record.binding_id
            && self.base.connection_id == record.connection_id
            && self.base.source == record.source
    }

    fn merge(&mut self, record: &MappedConversationEventRecord, incoming: &ConversationUsage) {
        if incoming.context_used.is_some() {
            self.usage.context_used = incoming.context_used;
        }
        if incoming.context_window_max.is_some() {
            self.usage.context_window_max = incoming.context_window_max;
        }
        if incoming.input_tokens > 0
            || incoming.output_tokens > 0
            || incoming.cache_creation_input_tokens > 0
            || incoming.cache_read_input_tokens > 0
        {
            self.usage.input_tokens = incoming.input_tokens;
            self.usage.output_tokens = incoming.output_tokens;
            self.usage.cache_creation_input_tokens = incoming.cache_creation_input_tokens;
            self.usage.cache_read_input_tokens = incoming.cache_read_input_tokens;
        }
        if incoming.cost_amount.is_some() {
            self.usage.cost_amount = incoming.cost_amount;
        }
        if incoming.cost_currency.is_some() {
            self.usage.cost_currency = incoming.cost_currency.clone();
        }
        if incoming.model.is_some() {
            self.usage.model = incoming.model.clone();
        }
        self.base.last_agent_sequence = record.last_agent_sequence;
        self.update_count += 1;
    }

    fn into_record(mut self) -> MappedConversationEventRecord {
        self.base.event = ConversationEvent::UsageUpdated { usage: self.usage };
        if self.update_count > 1 {
            self.base.idempotency_key = format!(
                "agent:{}:{}-{}:{}",
                self.base.connection_id,
                self.base.first_agent_sequence,
                self.base.last_agent_sequence,
                self.base.event_kind
            );
            self.base.raw_json = Some(
                serde_json::json!({
                    "coalesced": true,
                    "first_sequence": self.base.first_agent_sequence,
                    "last_sequence": self.base.last_agent_sequence,
                    "chunk_count": self.update_count,
                    "kind": self.base.event_kind,
                })
                .to_string(),
            );
        }
        self.base
    }
}

#[derive(Debug)]
pub(crate) struct StreamingThrottleCoalescer {
    pub(super) buffer: Vec<PendingEvent>,
    pub(super) pending_usage: HashMap<Uuid, PendingUsage>,
    pub(super) buffer_bytes: usize,
    pub(super) last_flush: Instant,
    pub(super) scan_state: MarkdownScanState,
    pub(super) reserved_slots: TurnSlotTracker,
}

impl Default for StreamingThrottleCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingThrottleCoalescer {
    pub(crate) fn new() -> Self {
        Self {
            buffer: Vec::new(),
            pending_usage: HashMap::new(),
            buffer_bytes: 0,
            last_flush: Instant::now(),
            scan_state: MarkdownScanState::default(),
            reserved_slots: TurnSlotTracker::default(),
        }
    }

    pub(crate) fn next_idle_deadline(&self) -> Option<Instant> {
        self.buffer
            .iter()
            .map(|item| item.buffered_at)
            .chain(self.pending_usage.values().map(|item| item.buffered_at))
            .min()
            .map(|oldest| oldest + IDLE_FLUSH_CEILING)
    }

    pub(super) fn push(
        &mut self,
        record: MappedConversationEventRecord,
    ) -> Vec<MappedConversationEventRecord> {
        self.push_at(record, Instant::now())
    }

    pub(super) fn push_at(
        &mut self,
        record: MappedConversationEventRecord,
        now: Instant,
    ) -> Vec<MappedConversationEventRecord> {
        let conversation_id = record.conversation_id;

        if let ConversationEvent::UsageUpdated { usage } = &record.event {
            let incoming_usage = usage.clone();
            if let Some(existing) = self.pending_usage.get_mut(&conversation_id) {
                if existing.same_context(&record) {
                    existing.merge(&record, &incoming_usage);
                } else {
                    let prev = self
                        .pending_usage
                        .insert(
                            conversation_id,
                            PendingUsage::from_record(now, record, incoming_usage),
                        )
                        .expect("just checked entry");
                    return vec![prev.into_record()];
                }
            } else {
                self.pending_usage.insert(
                    conversation_id,
                    PendingUsage::from_record(now, record, incoming_usage),
                );
            }
            if let Some(pending) = self.pending_usage.get(&conversation_id)
                && now.saturating_duration_since(pending.buffered_at) >= IDLE_FLUSH_CEILING
            {
                return self.flush_conversation_at(conversation_id, now);
            }
            return Vec::new();
        }

        // Terminal ToolCallUpsert: merge into matching running ToolCallUpsert if it is the
        // tail item for this conversation, then IMMEDIATELY flush this conversation.
        if let ConversationEvent::ToolCallUpsert { tool_call } = &record.event
            && is_terminal_tool_status(tool_call.status.as_deref())
        {
            let incoming_payload = CoalescedPayload::ToolCallUpsert {
                tool_call: Box::new(tool_call.clone()),
            };
            if let Some(tail) = self
                .buffer
                .iter_mut()
                .rev()
                .find(|p| p.base.conversation_id == conversation_id)
                && tail.try_merge(&record, &incoming_payload)
            {
                return self.flush_conversation_at(conversation_id, now);
            }
            let mut ready = self.flush_conversation_at(conversation_id, now);
            ready.push(record);
            return ready;
        }

        let Some(payload) = coalesced_payload_from_event(&record.event) else {
            // Iron Law 1: ANY non-coalesceable event flushes all buffered deltas for this
            // conversation BEFORE emitting the barrier event in the same batch slice.
            let mut ready = self.flush_conversation_at(conversation_id, now);
            if is_terminal_conversation_event(&record.event) {
                self.scan_state.clear(conversation_id);
                self.reserved_slots.clear_conversation(conversation_id);
            }
            ready.push(record);
            return ready;
        };

        match &payload {
            CoalescedPayload::AssistantText { text, .. }
            | CoalescedPayload::AssistantReasoning { text, .. } => {
                self.scan_state.feed(conversation_id, text);
            }
            CoalescedPayload::ToolCallUpsert { .. } => {
                self.scan_state.mark_non_text(conversation_id);
            }
        }

        let added_bytes = payload.approx_bytes();
        let merged = if let Some(tail) = self
            .buffer
            .iter_mut()
            .rev()
            .find(|p| p.base.conversation_id == conversation_id)
        {
            if tail.try_merge(&record, &payload) {
                self.buffer_bytes = self.buffer_bytes.saturating_add(added_bytes);
                tail.approx_bytes = tail.approx_bytes.saturating_add(added_bytes);
                true
            } else {
                false
            }
        } else {
            false
        };

        if !merged {
            if self.buffer.is_empty() {
                self.last_flush = now;
            }
            let slot = self.reserved_slots.reserve(conversation_id, record.turn_id);
            self.buffer_bytes = self.buffer_bytes.saturating_add(added_bytes);
            self.buffer.push(PendingEvent {
                slot,
                buffered_at: now,
                base: record,
                payload,
                chunk_count: 1,
                approx_bytes: added_bytes,
            });
        }

        let conv_oldest = self
            .buffer
            .iter()
            .filter(|p| p.base.conversation_id == conversation_id)
            .map(|p| p.buffered_at)
            .min()
            .unwrap_or(now);
        let conv_bytes: usize = self
            .buffer
            .iter()
            .filter(|p| p.base.conversation_id == conversation_id)
            .map(|p| p.approx_bytes)
            .sum();
        let elapsed = now.saturating_duration_since(conv_oldest);

        if self.buffer_bytes >= MAX_COALESCED_BYTES
            || conv_bytes >= MAX_COALESCED_BYTES
            || elapsed >= IDLE_FLUSH_CEILING
            || (elapsed >= MIN_BOUNDARY_FLUSH
                && self.scan_state.is_at_safe_boundary(conversation_id))
        {
            return self.flush_conversation_at(conversation_id, now);
        }

        Vec::new()
    }

    pub(super) fn flush_due(&mut self, now: Instant) -> Vec<MappedConversationEventRecord> {
        let mut due_conversations = Vec::new();
        for item in &self.buffer {
            let cid = item.base.conversation_id;
            if due_conversations.contains(&cid) {
                continue;
            }
            let elapsed = now.saturating_duration_since(item.buffered_at);
            if elapsed >= IDLE_FLUSH_CEILING
                || (elapsed >= MIN_BOUNDARY_FLUSH && self.scan_state.is_at_safe_boundary(cid))
            {
                due_conversations.push(cid);
            }
        }
        for (&cid, usage) in &self.pending_usage {
            if !due_conversations.contains(&cid)
                && now.saturating_duration_since(usage.buffered_at) >= IDLE_FLUSH_CEILING
            {
                due_conversations.push(cid);
            }
        }
        let mut out = Vec::new();
        for cid in due_conversations {
            out.extend(self.flush_conversation_at(cid, now));
        }
        out
    }

    pub(super) fn flush_conversation(
        &mut self,
        conversation_id: Uuid,
    ) -> Vec<MappedConversationEventRecord> {
        self.flush_conversation_at(conversation_id, Instant::now())
    }

    pub(super) fn flush_conversation_at(
        &mut self,
        conversation_id: Uuid,
        now: Instant,
    ) -> Vec<MappedConversationEventRecord> {
        let mut drained = Vec::new();
        let mut remaining = Vec::with_capacity(self.buffer.len());
        for item in self.buffer.drain(..) {
            if item.base.conversation_id == conversation_id {
                self.buffer_bytes = self.buffer_bytes.saturating_sub(item.approx_bytes);
                drained.push(item);
            } else {
                remaining.push(item);
            }
        }
        self.buffer = remaining;
        drained.sort_by_key(|item| (item.slot, item.base.first_agent_sequence));
        let mut out: Vec<MappedConversationEventRecord> =
            drained.into_iter().map(PendingEvent::into_record).collect();
        if let Some(usage) = self.pending_usage.remove(&conversation_id) {
            out.push(usage.into_record());
        }
        if !out.is_empty() {
            self.last_flush = now;
        }
        out
    }

    pub(super) fn flush_all(&mut self) -> Vec<MappedConversationEventRecord> {
        self.last_flush = Instant::now();
        self.buffer_bytes = 0;
        let mut out: Vec<MappedConversationEventRecord> = self
            .buffer
            .drain(..)
            .map(PendingEvent::into_record)
            .collect();
        let mut usages: Vec<PendingUsage> =
            self.pending_usage.drain().map(|(_, usage)| usage).collect();
        usages.sort_by_key(|u| u.base.first_agent_sequence);
        out.extend(usages.into_iter().map(PendingUsage::into_record));
        out
    }
}

impl PendingEvent {
    fn has_same_context(&self, record: &MappedConversationEventRecord) -> bool {
        self.base.conversation_id == record.conversation_id
            && self.base.turn_id == record.turn_id
            && self.base.binding_id == record.binding_id
            && self.base.connection_id == record.connection_id
            && self.base.source == record.source
    }

    fn try_merge(
        &mut self,
        record: &MappedConversationEventRecord,
        incoming: &CoalescedPayload,
    ) -> bool {
        if !self.has_same_context(record) {
            return false;
        }
        match (&mut self.payload, incoming) {
            (
                CoalescedPayload::AssistantText {
                    text: pending_text,
                    message_id: pending_id,
                },
                CoalescedPayload::AssistantText {
                    text: next_text,
                    message_id: next_id,
                },
            )
            | (
                CoalescedPayload::AssistantReasoning {
                    text: pending_text,
                    message_id: pending_id,
                },
                CoalescedPayload::AssistantReasoning {
                    text: next_text,
                    message_id: next_id,
                },
            ) if pending_id == next_id => {
                pending_text.push_str(next_text);
                self.base.last_agent_sequence = record.last_agent_sequence;
                self.chunk_count += 1;
                true
            }
            (
                CoalescedPayload::ToolCallUpsert {
                    tool_call: pending_tool,
                },
                CoalescedPayload::ToolCallUpsert {
                    tool_call: next_tool,
                },
            ) if pending_tool.tool_call_id == next_tool.tool_call_id => {
                merge_tool_call_patch(pending_tool, next_tool);
                self.base.last_agent_sequence = record.last_agent_sequence;
                self.chunk_count += 1;
                true
            }
            _ => false,
        }
    }

    fn into_record(mut self) -> MappedConversationEventRecord {
        self.base.event = match self.payload {
            CoalescedPayload::AssistantText { text, message_id } => {
                ConversationEvent::AssistantTextDelta { text, message_id }
            }
            CoalescedPayload::AssistantReasoning { text, message_id } => {
                ConversationEvent::AssistantReasoningDelta { text, message_id }
            }
            CoalescedPayload::ToolCallUpsert { tool_call } => ConversationEvent::ToolCallUpsert {
                tool_call: *tool_call,
            },
        };
        self.base.event_kind = conversation_event_kind(&self.base.event);
        self.base.idempotency_key = format!(
            "agent:{}:{}-{}:{}",
            self.base.connection_id,
            self.base.first_agent_sequence,
            self.base.last_agent_sequence,
            self.base.event_kind
        );
        self.base.raw_json = Some(
            serde_json::json!({
                "coalesced": true,
                "first_sequence": self.base.first_agent_sequence,
                "last_sequence": self.base.last_agent_sequence,
                "chunk_count": self.chunk_count,
                "kind": self.base.event_kind,
            })
            .to_string(),
        );
        self.base.complete_reply = false;
        self.base
    }
}

pub(super) fn merge_tool_call_patch(
    target: &mut ConversationToolCallPatch,
    incoming: &ConversationToolCallPatch,
) {
    if let Some(title) = &incoming.title {
        target.title = Some(title.clone());
    }
    if let Some(kind) = &incoming.kind {
        target.kind = Some(kind.clone());
    }
    if let Some(status) = &incoming.status {
        target.status = Some(status.clone());
    }
    if let Some(raw_input) = &incoming.raw_input
        && (!raw_input.as_object().is_some_and(|map| map.is_empty()) || target.raw_input.is_none())
    {
        target.raw_input = Some(raw_input.clone());
    }
    if let Some(raw_output) = &incoming.raw_output {
        target.raw_output = Some(raw_output.clone());
    }
    if let Some(raw_output_append) = &incoming.raw_output_append {
        match &mut target.raw_output_append {
            Some(existing) => existing.push_str(raw_output_append),
            None => target.raw_output_append = Some(raw_output_append.clone()),
        }
    }
    if let Some(content) = &incoming.content {
        target.content = Some(content.clone());
    }
    if let Some(locations) = &incoming.locations
        && (!locations.is_empty() || target.locations.is_none())
    {
        target.locations = Some(locations.clone());
    }
    if let Some(metadata) = &incoming.metadata {
        target.metadata = Some(metadata.clone());
    }
    if !incoming.images.is_empty() {
        target.images = incoming.images.clone();
    }
}

pub(super) fn is_coalesceable_conversation_event(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::AssistantTextDelta { .. }
            | ConversationEvent::AssistantReasoningDelta { .. }
    ) || matches!(
        event,
        ConversationEvent::ToolCallUpsert { tool_call }
            if !is_terminal_tool_status(tool_call.status.as_deref())
    )
}

fn coalesced_payload_from_event(event: &ConversationEvent) -> Option<CoalescedPayload> {
    match event {
        ConversationEvent::AssistantTextDelta { text, message_id } => {
            Some(CoalescedPayload::AssistantText {
                text: text.clone(),
                message_id: message_id.clone(),
            })
        }
        ConversationEvent::AssistantReasoningDelta { text, message_id } => {
            Some(CoalescedPayload::AssistantReasoning {
                text: text.clone(),
                message_id: message_id.clone(),
            })
        }
        ConversationEvent::ToolCallUpsert { tool_call }
            if !is_terminal_tool_status(tool_call.status.as_deref()) =>
        {
            Some(CoalescedPayload::ToolCallUpsert {
                tool_call: Box::new(tool_call.clone()),
            })
        }
        _ => None,
    }
}
