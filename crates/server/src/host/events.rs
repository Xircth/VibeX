use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicI64, Ordering},
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

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
            "local-history-scan-progress",
            "agent-events",
            "terminal-output",
        ];
        PREFIXES
            .iter()
            .any(|prefix| channel == *prefix || channel.starts_with(&format!("{prefix}:")))
    }
}

pub fn terminal_output_channel(session_id: Uuid) -> String {
    format!("terminal-output:{session_id}")
}

/// Forward PTY (or Agent terminal) bytes onto the Host Event Bus as base64,
/// matching the desktop `terminal-output:{id}` listener contract.
pub fn spawn_terminal_output_bridge(
    session_id: Uuid,
    mut output_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let channel = terminal_output_channel(session_id);
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            global_host_events().emit(&channel, BASE64.encode(&data));
        }
    });
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
    use super::{HostEventBus, patch_stream_channel, patch_stream_subscribe_command};

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

    #[tokio::test]
    async fn terminal_output_bridge_emits_base64_on_the_host_bus() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let session_id = uuid::Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888);
        let mut events = super::global_host_events().subscribe();
        super::spawn_terminal_output_bridge(session_id, rx);
        tx.send(b"prompt>\n".to_vec()).unwrap();
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
