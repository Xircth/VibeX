use super::*;

pub(in crate::manager) mod codec;
pub(in crate::manager) mod content;
pub(in crate::manager) mod errors;
pub(in crate::manager) mod ext;
pub(in crate::manager) mod session_update;
pub(in crate::manager) mod config;
pub(in crate::manager) mod vendor;
pub(in crate::manager) mod mapping;

pub(in crate::manager) use codec::*;
pub(in crate::manager) use content::*;
pub(in crate::manager) use errors::*;
pub(in crate::manager) use config::*;
pub(in crate::manager) use vendor::*;
pub(in crate::manager) use mapping::*;


/// Grok applies model changes through the non-standard `session/set_model`
/// method (`{sessionId, modelId}`) — its `session/set_config_option` handler
/// rejects the standard param shape. Typed as a custom ACP request so the
/// apply path stays on the typed JSON-RPC transport.
#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcRequest)]
#[request(
    method = "session/set_model",
    response = SetSessionModelResponse,
    crate = acp
)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct SetSessionModelRequest {
    session_id: SessionId,
    model_id: String,
}

impl SetSessionModelRequest {
    pub(in crate::manager) fn new(session_id: SessionId, model_id: String) -> Self {
        Self {
            session_id,
            model_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcResponse)]
#[response(crate = acp)]
pub(in crate::manager) struct SetSessionModelResponse {
    #[serde(default)]
    _meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcRequest)]
#[request(method = "session/new", response = serde_json::Value, crate = acp)]
#[serde(transparent)]
pub(in crate::manager) struct RawNewSessionRequest(pub(in crate::manager) NewSessionRequest);

#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcRequest)]
#[request(method = "session/load", response = serde_json::Value, crate = acp)]
#[serde(transparent)]
pub(in crate::manager) struct RawLoadSessionRequest(pub(in crate::manager) LoadSessionRequest);

#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcRequest)]
#[request(method = "session/resume", response = serde_json::Value, crate = acp)]
#[serde(transparent)]
pub(in crate::manager) struct RawResumeSessionRequest(pub(in crate::manager) ResumeSessionRequest);

pub(in crate::manager) fn deserialize_raw_session_response<T: serde::de::DeserializeOwned>(
    raw: serde_json::Value,
) -> Result<(T, Option<serde_json::Value>), acp::Error> {
    let raw_models = raw.get("models").cloned();
    let response = serde_json::from_value(raw).map_err(acp::Error::into_internal_error)?;
    Ok((response, raw_models))
}

pub(in crate::manager) const KIRO_METADATA_METHOD: &str = "_kiro.dev/metadata";
pub(in crate::manager) const KIRO_COMMANDS_AVAILABLE_METHOD: &str = "_kiro.dev/commands/available";
pub(in crate::manager) const KIRO_AGENT_SWITCHED_METHOD: &str = "_kiro.dev/agent/switched";
pub(in crate::manager) const KIRO_MODEL_OPTION_ID: &str = "model";
pub(in crate::manager) const KIRO_EFFORT_OPTION_ID: &str = "effort";
pub(in crate::manager) const KIRO_THINKING_OPTION_ID: &str = "thinking";
pub(in crate::manager) const KIRO_DEFAULT_VALUE: &str = "default";

/// Kiro CLI applies reasoning effort and thinking toggle through the
/// `_kiro.dev/commands/execute` extension method.
#[derive(Debug, Clone, Serialize, Deserialize, acp::JsonRpcRequest)]
#[request(
    method = "_kiro.dev/commands/execute",
    response = serde_json::Value,
    crate = acp
)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct KiroExecuteCommandRequest {
    session_id: SessionId,
    command: serde_json::Value,
}

impl KiroExecuteCommandRequest {
    pub(in crate::manager) fn effort(session_id: SessionId, level: &str) -> Self {
        Self {
            session_id,
            command: serde_json::json!({
                "command": "effort",
                "args": { "level": level }
            }),
        }
    }

    pub(in crate::manager) fn thinking(session_id: SessionId, enabled: bool) -> Self {
        Self {
            session_id,
            command: serde_json::json!({
                "command": "reasoning",
                "args": { "thinkingEnabled": enabled }
            }),
        }
    }
}


/// Which streaming text channel a chunk belongs to. Tracked so a thought→message
/// transition (or vice versa) restarts the snapshot accumulator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) enum StreamKind {
    Message,
    Thought,
}

/// Per-session accumulator for the current contiguous streaming text run, used to
/// drop redundant full-message snapshots (see [`dedup_stream_text`]).
#[derive(Debug, Default)]
pub(in crate::manager) struct StreamDedupState {
    pub(in crate::manager) active: Option<StreamKind>,
    pub(in crate::manager) text: String,
    pub(in crate::manager) chunks: usize,
}

/// Normalize a streaming text chunk: returns `true` to emit it, `false` to drop it
/// as a redundant full-snapshot replay.
///
/// `codex-acp` streams a message/thought as
/// `agentMessageChunk` / `agentThoughtChunk` deltas AND then replays the *complete*
/// text as one final chunk — the live-stream analogue of the `event_msg` +
/// `response_item` duplication documented in [`crate::parsers::codex`]. ACP does
/// not tag these chunks with a `message_id`, so the only available signal is
/// content: a chunk whose text equals everything accumulated for the current run
/// is that trailing snapshot. Dropping it stops the answer from rendering (and
/// persisting) twice in one bubble. Agents that never replay (Claude, Gemini, …)
/// only ever append, so this is a no-op for them.
pub(in crate::manager) fn dedup_stream_text(state: &mut StreamDedupState, kind: StreamKind, text: &str) -> bool {
    if state.active != Some(kind) {
        state.active = Some(kind);
        state.text.clear();
        state.chunks = 0;
    }
    if state.chunks >= 2 && state.text == text {
        // Trailing full snapshot: the run is complete, so reset — the next chunk
        // of the same kind starts a new message instead of appending to this one.
        state.active = None;
        return false;
    }
    state.text.push_str(text);
    state.chunks += 1;
    true
}

#[derive(Clone)]
pub(in crate::manager) struct AcpClientBridge {
    pub(in crate::manager) connection_id: AgentConnectionId,
    pub(in crate::manager) agent_id: crate::AgentId,
    pub(in crate::manager) event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    pub(in crate::manager) session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    // Shared with the owning runner: session-notification pushes (mode / config
    // updates) must keep the stored controls authoritative for later
    // set_mode/set_config_option matching.
    pub(in crate::manager) session_controls: Arc<RwLock<HashMap<AgentSessionId, SessionControlState>>>,
    pub(in crate::manager) pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pub(in crate::manager) pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    pub(in crate::manager) auto_approve_mode: Arc<Mutex<AgentAutoApproveMode>>,
    // Shared with the owning `AgentConnectionRunner` so a turn boundary can reset
    // it; keyed by ACP session id.
    pub(in crate::manager) stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
    // Shared idle-watchdog clock: every inbound ACP request/notification
    // refreshes it so an opt-in prompt watchdog only fires on true silence.
    pub(in crate::manager) last_activity: Arc<Mutex<Instant>>,
    pub(in crate::manager) grok_subagent: Arc<Mutex<GrokSubagentTracker>>,
    pub(in crate::manager) grok_mcp: Arc<Mutex<GrokMcpTracker>>,
    pub(in crate::manager) pending_session_id: Arc<Mutex<Option<AgentSessionId>>>,
    pub(in crate::manager) working_dir: PathBuf,
    pub(in crate::manager) env: HashMap<String, String>,
    pub(in crate::manager) apply: AgentConnectionRunner,
}

impl AcpClientBridge {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::manager) fn new(
        connection_id: AgentConnectionId,
        agent_id: crate::AgentId,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
        session_controls: Arc<RwLock<HashMap<AgentSessionId, SessionControlState>>>,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
        pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
        auto_approve_mode: Arc<Mutex<AgentAutoApproveMode>>,
        stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
        last_activity: Arc<Mutex<Instant>>,
        grok_subagent: Arc<Mutex<GrokSubagentTracker>>,
        grok_mcp: Arc<Mutex<GrokMcpTracker>>,
        pending_session_id: Arc<Mutex<Option<AgentSessionId>>>,
        working_dir: PathBuf,
        env: HashMap<String, String>,
        apply: AgentConnectionRunner,
    ) -> Self {
        Self {
            connection_id,
            agent_id,
            event_tx,
            session_map,
            session_controls,
            pending_permissions,
            pending_elicitations,
            auto_approve_mode,
            stream_dedup,
            last_activity,
            grok_subagent,
            grok_mcp,
            pending_session_id,
            working_dir,
            env,
            apply,
        }
    }

    pub(in crate::manager) async fn record_hydrated_update(&self, acp_session_id: &str, update: &SessionUpdate) {
        let matches_target =
            self.apply.replay_hydrate.lock().await.as_deref() == Some(acp_session_id);
        if !matches_target {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.agent_id.as_str());
        let Ok(payload) = serde_json::to_value(update) else {
            return;
        };
        drop(crate::acp_transcript::record_entry(
            &agent_dir,
            acp_session_id,
            crate::acp_transcript::EntryKind::Update,
            payload,
        ));
    }

    pub(in crate::manager) fn record_live_update(&self, acp_session_id: &str, update: &SessionUpdate) {
        if !records_acp_jsonl(self.agent_id.as_str()) {
            return;
        }
        let agent_dir = jsonl_agent_dir(self.agent_id.as_str());
        if !crate::acp_transcript::safe_component(acp_session_id) {
            return;
        }
        let Ok(payload) = serde_json::to_value(update) else {
            return;
        };
        drop(crate::acp_transcript::record_entry(
            &agent_dir,
            acp_session_id,
            crate::acp_transcript::EntryKind::Update,
            payload,
        ));
    }

    /// Pass a streaming text chunk through snapshot de-duplication, returning the
    /// content to emit (or `None` to drop a redundant full-message replay).
    pub(in crate::manager) async fn gate_stream_chunk(
        &self,
        acp_session_id: &str,
        kind: StreamKind,
        content: AgentContentBlock,
    ) -> Option<AgentContentBlock> {
        // Only text chunks carry a comparable snapshot; pass images/resources
        // through untouched.
        let AgentContentBlock::Text { text } = &content else {
            return Some(content);
        };
        if text.is_empty() {
            return Some(content);
        }
        let mut map = self.stream_dedup.lock().await;
        let state = map.entry(acp_session_id.to_string()).or_default();
        if dedup_stream_text(state, kind, text) {
            Some(content)
        } else {
            None
        }
    }

    pub(in crate::manager) async fn note_activity(&self) {
        *self.last_activity.lock().await = Instant::now();
    }


    pub(in crate::manager) async fn handle_agent_notification(
        &self,
        notification: AgentNotification,
    ) -> Result<(), acp::Error> {
        self.note_activity().await;
        match notification {
            AgentNotification::SessionNotification(args) => self.session_notification(args).await,
            AgentNotification::ExtNotification(ext) => self.handle_ext_notification(ext).await,
            _ => Ok(()),
        }
    }


    pub(in crate::manager) async fn agent_session_for_acp(&self, acp_session_id: String) -> Option<AgentSessionId> {
        self.session_map
            .read()
            .await
            .iter()
            .find_map(|(agent_session_id, candidate)| {
                if candidate == &acp_session_id {
                    Some(*agent_session_id)
                } else {
                    None
                }
            })
    }

}
