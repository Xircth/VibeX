use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicI64, Ordering},
    },
};

use agents::TerminalOutputRx;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use remote_protocol::{
    EventDurability, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
};
use serde::Serialize;
use tokio::{sync::broadcast, task::JoinHandle};
use uuid::Uuid;

const BUS_CAPACITY: usize = 4096;

tokio::task_local! {
    static CURRENT_BUS: Arc<HostEventBus>;
}

pub fn bind_host_events<F: Future>(
    bus: Arc<HostEventBus>,
    fut: F,
) -> impl Future<Output = F::Output> {
    CURRENT_BUS.scope(bus, fut)
}

pub fn current_host_events() -> Arc<HostEventBus> {
    CURRENT_BUS
        .try_with(Arc::clone)
        .expect("Host Event Bus is not bound to this task")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostEventChannel {
    pub prefix: &'static str,
    pub durability: EventDurability,
    pub required_scope: &'static str,
}

/// Catalog of Host push channels. Prefix match is longest-first.
pub const HOST_EVENT_CHANNELS: &[HostEventChannel] = &[
    HostEventChannel {
        prefix: "conversation-events",
        durability: EventDurability::Invalidation,
        required_scope: "conversation.read",
    },
    HostEventChannel {
        prefix: "workspace-sessions-changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-management-event",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-management-snapshot-invalidated",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-management-discovery-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-terminal-events",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "desktop-session-attention",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "file-tree-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "projects-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "project-workspaces-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "execution-processes-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "diff-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "conversation-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "scratch-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "slash-commands-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "log-stream",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "vibex://settings-file-changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "theme-changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "log-settings://changed",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "logs://appended",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "local-history-import-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "local-history-scan-progress",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "agent-events",
        durability: EventDurability::Invalidation,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "terminal-output",
        durability: EventDurability::BestEffort,
        required_scope: "application.call",
    },
    HostEventChannel {
        prefix: "plugin-contributions-changed",
        durability: EventDurability::Invalidation,
        required_scope: "plugin.read",
    },
    HostEventChannel {
        prefix: "provider-bind-confirm",
        durability: EventDurability::BestEffort,
        required_scope: "plugin.write",
    },
];

#[derive(Clone, Debug)]
pub struct HostEvent {
    pub channel: String,
    pub payload: serde_json::Value,
    pub sequence: i64,
    pub durability: EventDurability,
}

/// Per-Host push surface. Desktop forwards matching channels to Tauri; Server WS
/// attaches as `host_event`. Instances are isolated — never process-global.
#[derive(Clone)]
pub struct HostEventBus {
    tx: broadcast::Sender<HostEvent>,
    sequence: Arc<AtomicI64>,
    last_invalidation: Arc<RwLock<HashMap<String, HostEvent>>>,
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
            last_invalidation: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn current_sequence(&self) -> i64 {
        self.sequence.load(Ordering::SeqCst)
    }

    pub fn emit(&self, channel: impl Into<String>, payload: impl Serialize) {
        let Ok(payload) = serde_json::to_value(payload) else {
            return;
        };
        let channel = channel.into();
        let durability = Self::descriptor(&channel)
            .map(|descriptor| descriptor.durability)
            .unwrap_or(EventDurability::BestEffort);
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let event = HostEvent {
            channel: channel.clone(),
            payload,
            sequence,
            durability,
        };
        if durability == EventDurability::Invalidation
            && let Ok(mut last) = self.last_invalidation.write()
        {
            last.insert(channel, event.clone());
        }
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HostEvent> {
        self.tx.subscribe()
    }

    pub fn descriptor(channel: &str) -> Option<&'static HostEventChannel> {
        HOST_EVENT_CHANNELS
            .iter()
            .filter(|candidate| {
                channel == candidate.prefix
                    || channel.starts_with(&format!("{}:", candidate.prefix))
            })
            .max_by_key(|candidate| candidate.prefix.len())
    }

    pub fn channel_allowed(channel: &str) -> bool {
        Self::descriptor(channel).is_some()
    }

    pub fn required_scope(channel: &str) -> Option<&'static str> {
        Self::descriptor(channel).map(|descriptor| descriptor.required_scope)
    }

    pub fn durability(channel: &str) -> Option<EventDurability> {
        Self::descriptor(channel).map(|descriptor| descriptor.durability)
    }

    /// Attach a Host Event channel. Non-durable channels never replay missed
    /// broadcasts from `after_sequence`. Invalidation attach returns the latest
    /// snapshot so the client can refetch; best-effort is live-only.
    pub fn attach_bootstrap(
        &self,
        subscription_id: SubscriptionId,
        channel: &str,
        _after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, String> {
        let descriptor = Self::descriptor(channel)
            .ok_or_else(|| format!("host event channel `{channel}` is not registered"))?;
        let high_water_mark = self.current_sequence();
        let snapshot = match descriptor.durability {
            EventDurability::Invalidation => self
                .last_invalidation
                .read()
                .ok()
                .and_then(|last| last.get(channel).cloned())
                .map(|event| SubscriptionSnapshot {
                    through_sequence: event.sequence,
                    payload: event.payload,
                }),
            EventDurability::BestEffort | EventDurability::Durable => None,
        };
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: true,
            snapshot,
            replay: Vec::new(),
            high_water_mark,
            durability: descriptor.durability,
        })
    }
}

pub fn terminal_output_channel(session_id: Uuid) -> String {
    format!("terminal-output:{session_id}")
}

struct TerminalBridge {
    subscribers: usize,
    task: JoinHandle<()>,
}

/// One output pump per Host terminal session, refcounted by attach/close.
#[derive(Default)]
pub struct TerminalBridgeRegistry {
    inner: Mutex<HashMap<Uuid, TerminalBridge>>,
}

impl TerminalBridgeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscriber_count(&self, session_id: Uuid) -> usize {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .get(&session_id)
                    .map(|bridge| bridge.subscribers)
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    pub fn ensure(&self, bus: Arc<HostEventBus>, session_id: Uuid, output_rx: TerminalOutputRx) {
        let mut inner = self
            .inner
            .lock()
            .expect("terminal bridge registry poisoned");
        if let Some(existing) = inner.get_mut(&session_id) {
            existing.subscribers = existing.subscribers.saturating_add(1);
            drop(output_rx);
            return;
        }
        let channel = terminal_output_channel(session_id);
        let task = tokio::spawn(async move {
            let mut output_rx = output_rx;
            while let Some(data) = output_rx.recv().await {
                bus.emit(&channel, BASE64.encode(&data));
            }
        });
        inner.insert(
            session_id,
            TerminalBridge {
                subscribers: 1,
                task,
            },
        );
    }

    pub fn release(&self, session_id: Uuid) {
        let mut inner = self
            .inner
            .lock()
            .expect("terminal bridge registry poisoned");
        let Some(existing) = inner.get_mut(&session_id) else {
            return;
        };
        existing.subscribers = existing.subscribers.saturating_sub(1);
        if existing.subscribers == 0 {
            existing.task.abort();
            inner.remove(&session_id);
        }
    }

    pub fn abort_all(&self) {
        let mut inner = self
            .inner
            .lock()
            .expect("terminal bridge registry poisoned");
        for (_, bridge) in inner.drain() {
            bridge.task.abort();
        }
    }
}

/// Forward PTY (or Agent terminal) bytes onto the Host Event Bus as base64.
pub fn spawn_terminal_output_bridge(
    bus: Arc<HostEventBus>,
    bridges: &TerminalBridgeRegistry,
    session_id: Uuid,
    output_rx: TerminalOutputRx,
) {
    bridges.ensure(bus, session_id, output_rx);
}

/// Map a `patch_stream` resource name to the Host Event Bus channel the
/// matching `subscribe_*_stream` producer emits on.
pub fn patch_stream_channel(stream: &str, args: &serde_json::Value) -> Result<String, String> {
    let field = |camel: &str, snake: &str| {
        args.get(camel)
            .or_else(|| args.get(snake))
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| value.as_u64().map(|id| id.to_string()))
            })
    };
    match stream {
        "projects" => Ok("projects-stream".to_string()),
        "file_tree" => Ok("file-tree-stream".to_string()),
        "project_workspaces" => field("projectId", "project_id")
            .map(|id| format!("project-workspaces-stream:{id}"))
            .ok_or_else(|| "projectId is required".to_string()),
        "execution_processes" => field("sessionId", "session_id")
            .map(|id| format!("execution-processes-stream:{id}"))
            .ok_or_else(|| "sessionId is required".to_string()),
        "diff" => field("workspaceId", "workspace_id")
            .map(|id| format!("diff-stream:{id}"))
            .ok_or_else(|| "workspaceId is required".to_string()),
        "scratch" => field("scratchId", "scratch_id")
            .map(|id| format!("scratch-stream:{id}"))
            .ok_or_else(|| "scratchId is required".to_string()),
        "log" => field("processId", "process_id")
            .map(|id| format!("log-stream:{id}"))
            .ok_or_else(|| "processId is required".to_string()),
        "conversation" => {
            let process = field("executionProcessId", "execution_process_id")
                .ok_or_else(|| "executionProcessId is required".to_string())?;
            match field("streamId", "stream_id") {
                Some(stream_id) if !stream_id.is_empty() => {
                    Ok(format!("conversation-stream:{process}:{stream_id}"))
                }
                _ => Ok(format!("conversation-stream:{process}")),
            }
        }
        "slash_commands" => {
            let executor = args
                .get("executorProfileId")
                .or_else(|| args.get("executor_profile_id"))
                .and_then(|value| value.get("executor"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("none");
            let variant = args
                .get("executorProfileId")
                .or_else(|| args.get("executor_profile_id"))
                .and_then(|value| value.get("variant"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("default");
            let workspace = field("workspaceId", "workspace_id").unwrap_or_else(|| "none".into());
            let repo = field("repoId", "repo_id").unwrap_or_else(|| "none".into());
            Ok(format!(
                "slash-commands-stream:{executor}:{variant}:{workspace}:{repo}"
            ))
        }
        other => Err(format!("unknown patch stream `{other}`")),
    }
}

pub fn patch_stream_subscribe_command(stream: &str) -> Option<&'static str> {
    match stream {
        "projects" => Some("subscribe_projects_stream"),
        "project_workspaces" => Some("subscribe_project_workspaces_stream"),
        "execution_processes" => Some("subscribe_execution_processes_stream"),
        "diff" => Some("subscribe_diff_stream"),
        "file_tree" => Some("subscribe_file_tree_stream"),
        "scratch" => Some("subscribe_scratch_stream"),
        "slash_commands" => Some("subscribe_slash_commands_stream"),
        "log" => Some("subscribe_log_stream"),
        "conversation" => Some("subscribe_conversation_stream"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use remote_protocol::EventDurability;

    use super::{
        HostEventBus, TerminalBridgeRegistry, patch_stream_channel, patch_stream_subscribe_command,
    };

    #[test]
    fn conversation_channel_is_allowed() {
        assert!(HostEventBus::channel_allowed("conversation-events"));
        assert!(HostEventBus::channel_allowed(
            "conversation-events:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        ));
        assert!(!HostEventBus::channel_allowed("desktop-toast"));
    }

    #[test]
    fn host_push_channels_are_allowed() {
        for channel in [
            "diff-stream:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "file-tree-stream",
            "projects-stream",
            "theme-changed",
            "agent-management-snapshot-invalidated",
            "agent-events",
            "slash-commands-stream:codex:default:none:none",
            "terminal-output:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        ] {
            assert!(
                HostEventBus::channel_allowed(channel),
                "{channel} must be forwarded"
            );
        }
    }

    #[test]
    fn durability_is_classified_from_the_catalog() {
        assert_eq!(
            HostEventBus::durability("conversation-events:abc"),
            Some(EventDurability::Invalidation)
        );
        assert_eq!(
            HostEventBus::durability("terminal-output:abc"),
            Some(EventDurability::BestEffort)
        );
        assert_eq!(
            HostEventBus::durability("agent-management-discovery-progress"),
            Some(EventDurability::BestEffort)
        );
        assert_eq!(
            HostEventBus::durability("theme-changed"),
            Some(EventDurability::Invalidation)
        );
    }

    #[test]
    fn buses_do_not_share_events_across_hosts() {
        let first = HostEventBus::new();
        let second = HostEventBus::new();
        let mut first_rx = first.subscribe();
        let mut second_rx = second.subscribe();
        first.emit("theme-changed", "host-a");
        second.emit("theme-changed", "host-b");
        let first_event = first_rx.try_recv().expect("host-a event");
        let second_event = second_rx.try_recv().expect("host-b event");
        assert_eq!(first_event.payload, serde_json::json!("host-a"));
        assert_eq!(second_event.payload, serde_json::json!("host-b"));
        assert!(first_rx.try_recv().is_err());
        assert!(second_rx.try_recv().is_err());
    }

    #[test]
    fn best_effort_attach_does_not_replay() {
        let bus = HostEventBus::new();
        bus.emit("logs://appended", "one");
        bus.emit("logs://appended", "two");
        let bootstrap = bus
            .attach_bootstrap(remote_protocol::SubscriptionId::new(), "logs://appended", 0)
            .expect("attach");
        assert_eq!(bootstrap.durability, EventDurability::BestEffort);
        assert!(bootstrap.replay.is_empty());
        assert!(bootstrap.snapshot.is_none());
        assert!(bootstrap.high_water_mark >= 2);
    }

    #[test]
    fn invalidation_attach_returns_latest_snapshot_not_replay() {
        let bus = HostEventBus::new();
        bus.emit("theme-changed", "light");
        bus.emit("theme-changed", "dark");
        let bootstrap = bus
            .attach_bootstrap(remote_protocol::SubscriptionId::new(), "theme-changed", 0)
            .expect("attach");
        assert_eq!(bootstrap.durability, EventDurability::Invalidation);
        assert!(bootstrap.replay.is_empty());
        assert_eq!(
            bootstrap.snapshot.expect("snapshot").payload,
            serde_json::json!("dark")
        );
    }

    #[tokio::test]
    async fn terminal_output_bridge_emits_base64_on_the_host_bus() {
        let bus = std::sync::Arc::new(HostEventBus::new());
        let bridges = TerminalBridgeRegistry::new();
        let (tx, rx) = agents::TerminalOutputTx::pair();
        let session_id = uuid::Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888);
        let mut events = bus.subscribe();
        super::spawn_terminal_output_bridge(bus.clone(), &bridges, session_id, rx);
        super::spawn_terminal_output_bridge(
            bus.clone(),
            &bridges,
            session_id,
            agents::TerminalOutputTx::pair().1,
        );
        assert_eq!(bridges.subscriber_count(session_id), 2);
        tx.push(b"prompt>\n".to_vec());
        let channel = super::terminal_output_channel(session_id);
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let event = events.recv().await.expect("bus open");
                if event.channel == channel {
                    return event;
                }
            }
        })
        .await
        .expect("terminal output reached the Host Event Bus");
        assert_eq!(
            event.payload.as_str(),
            Some(base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                b"prompt>\n"
            ))
            .as_deref()
        );
        bridges.release(session_id);
        assert_eq!(bridges.subscriber_count(session_id), 1);
        bridges.release(session_id);
        assert_eq!(bridges.subscriber_count(session_id), 0);
    }

    #[test]
    fn patch_stream_maps_to_the_producer_channel() {
        assert_eq!(
            patch_stream_channel("projects", &serde_json::json!({})).unwrap(),
            "projects-stream"
        );
        assert_eq!(
            patch_stream_channel("diff", &serde_json::json!({ "workspaceId": "ws-1" })).unwrap(),
            "diff-stream:ws-1"
        );
        assert_eq!(
            patch_stream_channel(
                "slash_commands",
                &serde_json::json!({
                    "executorProfileId": { "executor": "codex", "variant": "default" },
                    "workspaceId": "ws",
                    "repoId": "repo"
                })
            )
            .unwrap(),
            "slash-commands-stream:codex:default:ws:repo"
        );
        assert_eq!(
            patch_stream_subscribe_command("file_tree"),
            Some("subscribe_file_tree_stream")
        );
        assert!(patch_stream_channel("unknown", &serde_json::json!({})).is_err());
    }
}
