use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicI64, Ordering},
};

use serde::Serialize;
use tokio::sync::broadcast;

const BUS_CAPACITY: usize = 4096;
static GLOBAL_BUS: OnceLock<HostEventBus> = OnceLock::new();

pub fn global_host_events() -> &'static HostEventBus {
    GLOBAL_BUS.get_or_init(HostEventBus::new)
}

#[derive(Clone, Debug)]
pub struct HostEvent {
    pub channel: String,
    pub payload: serde_json::Value,
    pub sequence: i64,
}

/// Process-wide push surface for Host-originated UI events.
/// Desktop forwards matching channels to Tauri; Server WS attaches as `host_event`.
#[derive(Clone)]
pub struct HostEventBus {
    tx: broadcast::Sender<HostEvent>,
    sequence: Arc<AtomicI64>,
}

impl Default for HostEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl HostEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BUS_CAPACITY);
        Self {
            tx,
            sequence: Arc::new(AtomicI64::new(0)),
        }
    }

    pub fn emit(&self, channel: impl Into<String>, payload: impl Serialize) {
        let Ok(payload) = serde_json::to_value(payload) else {
            return;
        };
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.tx.send(HostEvent {
            channel: channel.into(),
            payload,
            sequence,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostEvent> {
        self.tx.subscribe()
    }

    pub fn channel_allowed(channel: &str) -> bool {
        const PREFIXES: &[&str] = &[
            "conversation-events",
            "workspace-sessions-changed",
            "agent-management-event",
            "agent-management-snapshot-invalidated",
            "agent-management-discovery-progress",
            "agent-terminal-events",
            "desktop-session-attention",
            "file-tree-stream",
            "projects-stream",
            "project-workspaces-stream",
            "execution-processes-stream",
            "diff-stream",
            "conversation-stream",
            "scratch-stream",
            "slash-commands-stream",
            "log-stream",
            "vibex://settings-file-changed",
            "theme-changed",
            "log-settings://changed",
            "logs://appended",
            "local-history-import-progress",
        ];
        PREFIXES
            .iter()
            .any(|prefix| channel == *prefix || channel.starts_with(&format!("{prefix}:")))
    }
}

#[cfg(test)]
mod tests {
    use super::HostEventBus;

    #[test]
    fn conversation_channel_is_allowed() {
        assert!(HostEventBus::channel_allowed("conversation-events"));
        assert!(HostEventBus::channel_allowed(
            "conversation-events:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        ));
        assert!(!HostEventBus::channel_allowed("desktop-toast"));
    }
}
