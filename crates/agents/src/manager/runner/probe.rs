use super::*;
use crate::stderr_tail::sanitize_diagnostic;

/// Tracks whether a single `session/prompt` turn produced any user-visible output
/// and whether any incoming updates were dropped as unreadable.
#[derive(Debug, Default)]
pub(in crate::manager) struct TurnOutputProbe {
    produced: AtomicBool,
    dropped_updates: std::sync::atomic::AtomicU64,
    first_dropped_tag: std::sync::Mutex<Option<String>>,
    first_dropped_error: std::sync::Mutex<Option<String>>,
}

impl TurnOutputProbe {
    pub(in crate::manager) fn note_rendered(&self) {
        self.produced.store(true, Ordering::Release);
    }

    pub(in crate::manager) fn record_agent_event(&self, event: &AgentEvent) {
        let visible = match event {
            AgentEvent::MessageChunk { content } | AgentEvent::ThoughtChunk { content } => {
                agent_content_has_output(content)
            }
            AgentEvent::ToolCall { .. }
            | AgentEvent::ToolCallUpdate { .. }
            | AgentEvent::Plan { .. }
            | AgentEvent::PermissionRequested { .. }
            | AgentEvent::PermissionResponded { auto: true, .. }
            | AgentEvent::ElicitationRequested { .. }
            | AgentEvent::GoalUpdated { .. }
            | AgentEvent::AsyncTasksUpdated { .. } => true,
            _ => false,
        };
        if visible {
            self.note_rendered();
        }
    }

    pub(in crate::manager) fn note_dropped(&self, tag: Option<&str>, error: &str) {
        let prev = self.dropped_updates.fetch_add(1, Ordering::AcqRel);
        if prev == 0 {
            if let Ok(mut guard) = self.first_dropped_tag.lock() {
                *guard = tag.map(str::to_string);
            }
            if let Ok(mut guard) = self.first_dropped_error.lock() {
                *guard = Some(sanitize_diagnostic(error));
            }
        }
    }

    pub(in crate::manager) fn has_output(&self) -> bool {
        self.produced.load(Ordering::Acquire)
    }

    pub(in crate::manager) fn dropped_summary(&self) -> (u64, Option<String>, Option<String>) {
        let count = self.dropped_updates.load(Ordering::Acquire);
        let tag = self
            .first_dropped_tag
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        let error = self
            .first_dropped_error
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        (count, tag, error)
    }
}

pub(in crate::manager) fn agent_content_has_output(content: &AgentContentBlock) -> bool {
    match content {
        AgentContentBlock::Text { text } => !text.is_empty(),
        AgentContentBlock::Image { .. }
        | AgentContentBlock::Resource { .. }
        | AgentContentBlock::Protocol { .. } => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) enum EmptyTurnCause {
    UnreadableUpdates,
    AgentStderr,
    SilentEndTurn,
}
