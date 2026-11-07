use super::*;
use crate::stderr_tail::{StderrTail, sanitize_diagnostic};

pub(in crate::manager) mod acp_session;
pub(in crate::manager) mod acp_spawn;
pub(in crate::manager) mod controls_apply;
pub(in crate::manager) mod controls_emit;
pub(in crate::manager) mod env;
pub(in crate::manager) mod fixture;
pub(in crate::manager) mod goal;
pub(in crate::manager) mod in_memory;
pub(in crate::manager) mod interactions;
pub(in crate::manager) mod jsonl;
pub(in crate::manager) mod probe;
pub(in crate::manager) mod process;
pub(in crate::manager) mod prompt;
pub(in crate::manager) mod replay;
pub(in crate::manager) mod session;
pub mod throttle;

pub(in crate::manager) use env::*;
pub(in crate::manager) use jsonl::*;
pub(in crate::manager) use probe::*;
pub(in crate::manager) use process::*;
pub use throttle::LeadingEdgeThrottle;
pub(in crate::manager) use throttle::{
    EMPTY_TURN_STDERR_MAX_BYTES, EMPTY_TURN_STDERR_MAX_LINES, SessionRestoreSupport,
};

pub(in crate::manager) use crate::host_capabilities::build_client_capabilities;

pub(in crate::manager) type ActiveTurnProbeSlot =
    Arc<std::sync::Mutex<Option<(AgentSessionId, Arc<TurnOutputProbe>)>>>;

#[derive(Debug, Clone)]
pub(in crate::manager) struct AgentConnectionRunner {
    pub(in crate::manager) snapshot: ManagedAgentConnectionSnapshot,
    pub(in crate::manager) event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
    pub(in crate::manager) session_map: Arc<RwLock<HashMap<AgentSessionId, String>>>,
    pub(in crate::manager) session_controls:
        Arc<RwLock<HashMap<AgentSessionId, SessionControlState>>>,
    pub(in crate::manager) capabilities: Arc<RwLock<AcpCapabilitySnapshot>>,
    pub(in crate::manager) pending_permissions: Arc<Mutex<HashMap<String, PendingPermission>>>,
    pub(in crate::manager) pending_elicitations: Arc<Mutex<HashMap<String, PendingElicitation>>>,
    pub(in crate::manager) child_pid: Arc<std::sync::Mutex<Option<u32>>>,
    pub(in crate::manager) auto_approve_mode: Arc<Mutex<AgentAutoApproveMode>>,
    pub(in crate::manager) delegation_injector: Option<Arc<dyn DelegationInjector>>,
    // Per-session streaming-text accumulator shared with the ACP client bridge so
    // redundant full-message snapshots can be dropped (see `dedup_stream_text`).
    pub(in crate::manager) stream_dedup: Arc<Mutex<HashMap<String, StreamDedupState>>>,
    // The (session, prompt) currently in flight on this connection, if any. Lets
    // the connection-death fallback in `run()` emit a turn-terminal event carrying
    // the real prompt_id so the conversation fails cleanly instead of hanging.
    pub(in crate::manager) active_prompt: Arc<Mutex<Option<(AgentSessionId, AgentPromptId)>>>,
    // Last inbound ACP traffic for the in-flight prompt; shared with the
    // bridge so an opt-in idle watchdog can fail a silently-hung agent.
    pub(in crate::manager) last_activity: Arc<Mutex<Instant>>,
    pub(in crate::manager) grok_subagent: Arc<Mutex<GrokSubagentTracker>>,
    pub(in crate::manager) grok_mcp: Arc<Mutex<GrokMcpTracker>>,
    pub(in crate::manager) pending_session_id: Arc<Mutex<Option<AgentSessionId>>>,
    /// ACP session id whose `session/load` replay may be written. Set only
    /// after `claim_replay_transcript` creates the file, cleared when the
    /// load request returns. Absent means the replay is drained, not stored.
    pub(in crate::manager) replay_hydrate: Arc<Mutex<Option<String>>>,
    /// CodeG-style connect preferences: applied after the agent advertises
    /// controls and before the first `SessionModes` / `SessionConfigOptions` event.
    pub(in crate::manager) preferred_controls:
        Arc<RwLock<HashMap<AgentSessionId, crate::SessionControlPreferences>>>,
    pub(in crate::manager) status: Arc<Mutex<AgentConnectionStatus>>,
    pub(in crate::manager) handshake_started: Instant,
    pub(in crate::manager) live_conn: Arc<Mutex<Option<ConnectionTo<Agent>>>>,
    pub(in crate::manager) grok_catalog: Arc<Mutex<Option<GrokModelCatalog>>>,
    pub(in crate::manager) stderr_tail: Arc<StderrTail>,
    pub(in crate::manager) active_turn_probe: ActiveTurnProbeSlot,
    pub(in crate::manager) update_log_throttle: Arc<LeadingEdgeThrottle>,
    pub(in crate::manager) air_tool_call_meta: Arc<Mutex<crate::air_contract::ToolCallMetaLedger>>,
    pub(in crate::manager) hosted_terminal_output: Arc<Mutex<HashMap<String, String>>>,
    pub(in crate::manager) neutral_goal_channel: Arc<AtomicBool>,
    #[allow(clippy::type_complexity)]
    pub(in crate::manager) goal_advertised_control:
        Arc<RwLock<Option<(Option<String>, Vec<String>)>>>,
    pub(in crate::manager) handshake_completed: Arc<AtomicBool>,
    pub(in crate::manager) connection_wants_prompt_suggestions: Arc<AtomicBool>,
    pub(in crate::manager) session_wants_prompt_suggestions:
        Arc<RwLock<HashMap<AgentSessionId, bool>>>,
}

/// Non-standard wire surface an ACP agent requires for its vendor-advertised
/// session controls. Standard ACP agents keep `None` and use
/// `session/set_config_option` unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) enum VendorConfigWire {
    /// Grok (`grok agent stdio`) advertises config through
    /// `_meta["x.ai/sessionConfig"]` and applies model changes via the
    /// non-standard `session/set_model` method (`{sessionId, modelId}`).
    XaiSessionConfig,
    /// Kiro (`kiro-cli acp`) advertises models via top-level `models` on
    /// `session/new` / `session/load`, reasoning via `_kiro.dev/metadata`,
    /// and applies changes via `session/set_model` and `_kiro.dev/commands/execute`.
    KiroSessionConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::manager) struct KiroReasoning {
    pub(in crate::manager) levels: Vec<String>,
    pub(in crate::manager) current: Option<String>,
    pub(in crate::manager) thinking_toggleable: bool,
    pub(in crate::manager) thinking: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub(in crate::manager) struct SessionControlState {
    pub(in crate::manager) modes: Option<SessionModeState>,
    pub(in crate::manager) config_options: Vec<AcpSessionConfigOption>,
    /// Set when `config_options` were synthesized from a vendor `_meta`
    /// extension instead of the standard ACP response fields.
    pub(in crate::manager) vendor_config: Option<VendorConfigWire>,
    /// True when the category=`mode` option was adapted from V1 Session Modes
    /// and must be written back with `session/set_mode`.
    pub(in crate::manager) mode_uses_set_mode: bool,
    pub(in crate::manager) available_commands: Option<Vec<AgentAvailableCommand>>,
    /// Reasoning metadata reported by Kiro via `_kiro.dev/metadata`.
    pub(in crate::manager) kiro_reasoning: Option<KiroReasoning>,
    /// Concrete model ids from the establishing reply's top-level `models`
    /// (`availableModels[].modelId`). Antigravity 1.4+ keeps variant ids here
    /// after grouping the selector into family + `thinking_level`.
    pub(in crate::manager) session_model_ids: Vec<String>,
    /// `availableModels[]._meta.totalContextTokens` from session establishment.
    pub(in crate::manager) grok_model_windows: HashMap<String, u64>,
    /// Last occupancy pair emitted as `AgentEvent::Usage` for this session.
    pub(in crate::manager) last_grok_usage: Option<(u64, u64)>,
    /// Last model id observed on this session (`configOption` or `_meta.modelId`).
    pub(in crate::manager) last_model_id: Option<String>,
    /// pi-acp prelude captured from `session/new` `_meta.piAcp.startupInfo`.
    /// The matching first `agent_message_chunk` is dropped so skill paths
    /// are not rendered as the assistant's opening words.
    pub(in crate::manager) pi_startup_banner: Option<String>,
    /// Values this host asserted at establishment and the agent confirmed.
    /// Kept until the first prompt; a later push that contradicts them is
    /// re-asserted once (Codeg `asserted_config_values`).
    pub(in crate::manager) asserted_config_values: BTreeMap<String, String>,
    /// Merged token & context-window usage accumulated during the active turn.
    pub(in crate::manager) last_turn_usage: Option<AgentUsage>,
    /// Latest normalized goal snapshot (`_meta.goal` / AIR / legacy `_meta.codex.goal`).
    pub(in crate::manager) goal: Option<serde_json::Value>,
    /// Open active goal run tracked across `next_goal_marker` transitions.
    pub(in crate::manager) open_goal_run: Option<serde_json::Value>,
    /// Monotonic counter for synthetic `codex-goal-{seq}` tool calls.
    pub(in crate::manager) goal_marker_sequence: u64,
    /// Session-scoped background tasks (`asyncTasks` / Grok workflows).
    pub(in crate::manager) async_tasks: Vec<crate::AsyncTaskRecord>,
    /// Latest ephemeral Composer prompt suggestion (`promptSuggestions`).
    pub(in crate::manager) prompt_suggestion: Option<String>,
    /// Host-managed YOLO mode overlay for OMP (`omp acp` only natively supports
    /// `default` and `plan`; selecting `yolo` runs OMP in `default` while the
    /// host auto-approves all `session/request_permission` prompts).
    pub(in crate::manager) omp_yolo_mode: bool,
}

#[derive(Debug)]
pub(in crate::manager) struct PendingPermission {
    pub(in crate::manager) permission_id: AgentPermissionId,
    pub(in crate::manager) session_id: AgentSessionId,
    pub(in crate::manager) options: Vec<AgentPermissionOption>,
    pub(in crate::manager) tx: oneshot::Sender<AgentPermissionResponse>,
}

#[derive(Debug)]
pub(in crate::manager) struct PendingElicitation {
    pub(in crate::manager) elicitation_id: AgentElicitationId,
    pub(in crate::manager) session_id: AgentSessionId,
    pub(in crate::manager) tx: oneshot::Sender<AgentElicitationResponse>,
}

/// Owned inputs for [`AgentConnectionRunner::run_prompt`], bundled into one
/// struct so the method stays under clippy's argument-count threshold.
pub(in crate::manager) struct RunPromptRequest {
    pub(in crate::manager) acp_session_id: String,
    pub(in crate::manager) session_id: AgentSessionId,
    pub(in crate::manager) prompt_id: AgentPromptId,
    pub(in crate::manager) blocks: Vec<AgentContentBlock>,
    pub(in crate::manager) display_blocks: Option<Vec<AgentContentBlock>>,
    pub(in crate::manager) mode_override: Option<String>,
    pub(in crate::manager) config_overrides: Vec<AgentSessionConfigOverride>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) enum RunPromptOutcome {
    Settled,
    RetireConnection,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "session/fork", response = acp::schema::v1::ForkSessionResponse)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct AcpForkSessionRequest {
    pub(in crate::manager) session_id: String,
    pub(in crate::manager) cwd: PathBuf,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub(in crate::manager) meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/steering", response = AcpSteerResponse)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct AcpSteerRequest {
    pub(in crate::manager) session_id: String,
    pub(in crate::manager) prompt: Vec<ContentBlock>,
    #[serde(rename = "_meta")]
    pub(in crate::manager) meta: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/goal", response = serde_json::Value)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct AcpNeutralGoalControlRequest {
    pub(in crate::manager) session_id: String,
    pub(in crate::manager) action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_codex/session/goal_control", response = serde_json::Value)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct AcpLegacyGoalControlRequest {
    pub(in crate::manager) session_id: String,
    pub(in crate::manager) action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "_session/async_task/stop", response = serde_json::Value)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct AcpStopAsyncTaskRequest {
    pub(in crate::manager) session_id: String,
    pub(in crate::manager) async_task_id: String,
    pub(in crate::manager) task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub(in crate::manager) struct AcpSteerResponse {
    pub(in crate::manager) outcome: String,
    #[serde(default)]
    pub(in crate::manager) reason: Option<String>,
}

pub(in crate::manager) fn map_steer_response(
    response: AcpSteerResponse,
) -> AgentResult<AgentSteerReceipt> {
    let outcome = match response.outcome.as_str() {
        "injected" => AgentSteerOutcome::Injected,
        "promptRequired" => AgentSteerOutcome::PromptRequired,
        "startedNewTurn" => AgentSteerOutcome::StartedNewTurn,
        other => {
            return Err(AgentError::Runtime(format!(
                "agent returned unknown steering outcome `{other}`"
            )));
        }
    };
    Ok(AgentSteerReceipt {
        outcome,
        reason: response.reason,
    })
}

impl AgentConnectionRunner {
    pub(in crate::manager) fn new(
        snapshot: ManagedAgentConnectionSnapshot,
        event_tx: mpsc::UnboundedSender<AgentConnectionManagerEvent>,
        delegation_injector: Option<Arc<dyn DelegationInjector>>,
    ) -> Self {
        let auto_approve_mode = Arc::new(Mutex::new(snapshot.auto_approve_mode));
        Self {
            snapshot,
            event_tx,
            session_map: Arc::new(RwLock::new(HashMap::new())),
            session_controls: Arc::new(RwLock::new(HashMap::new())),
            capabilities: Arc::new(RwLock::new(AcpCapabilitySnapshot::default())),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_elicitations: Arc::new(Mutex::new(HashMap::new())),
            child_pid: Arc::new(std::sync::Mutex::new(None)),
            auto_approve_mode,
            delegation_injector,
            stream_dedup: Arc::new(Mutex::new(HashMap::new())),
            active_prompt: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(Mutex::new(Instant::now())),
            grok_subagent: Arc::new(Mutex::new(GrokSubagentTracker::default())),
            grok_mcp: Arc::new(Mutex::new(GrokMcpTracker::default())),
            pending_session_id: Arc::new(Mutex::new(None)),
            replay_hydrate: Arc::new(Mutex::new(None)),
            preferred_controls: Arc::new(RwLock::new(HashMap::new())),
            status: Arc::new(Mutex::new(AgentConnectionStatus::Connecting)),
            handshake_started: Instant::now(),
            live_conn: Arc::new(Mutex::new(None)),
            grok_catalog: Arc::new(Mutex::new(None)),
            stderr_tail: Arc::new(StderrTail::new()),
            active_turn_probe: Arc::new(std::sync::Mutex::new(None)),
            update_log_throttle: Arc::new(LeadingEdgeThrottle::default()),
            air_tool_call_meta: Arc::new(Mutex::new(
                crate::air_contract::ToolCallMetaLedger::default(),
            )),
            hosted_terminal_output: Arc::new(Mutex::new(HashMap::new())),
            neutral_goal_channel: Arc::new(AtomicBool::new(false)),
            goal_advertised_control: Arc::new(RwLock::new(None)),
            handshake_completed: Arc::new(AtomicBool::new(false)),
            connection_wants_prompt_suggestions: Arc::new(AtomicBool::new(false)),
            session_wants_prompt_suggestions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(in crate::manager) async fn record_wants_prompt_suggestions(
        &self,
        session_id: AgentSessionId,
        wants: bool,
    ) {
        self.connection_wants_prompt_suggestions
            .store(wants, Ordering::SeqCst);
        self.session_wants_prompt_suggestions
            .write()
            .await
            .insert(session_id, wants);
    }

    pub(in crate::manager) async fn wants_prompt_suggestions(
        &self,
        session_id: AgentSessionId,
    ) -> bool {
        if let Some(&wants) = self
            .session_wants_prompt_suggestions
            .read()
            .await
            .get(&session_id)
        {
            return wants;
        }
        self.connection_wants_prompt_suggestions
            .load(Ordering::SeqCst)
    }

    pub(in crate::manager) async fn resolve_session_goal_control(
        &self,
    ) -> Option<(String, Vec<String>)> {
        if !self.handshake_completed.load(Ordering::SeqCst) {
            return None;
        }
        let advertised = self.goal_advertised_control.read().await;
        crate::codex_goal::resolve_goal_control(self.agent_kind(), advertised.as_ref())
    }

    pub(in crate::manager) async fn resolved_goal_actions(&self) -> Option<Vec<String>> {
        self.resolve_session_goal_control()
            .await
            .map(|(_, actions)| actions)
    }

    pub(in crate::manager) fn agent_kind(&self) -> Option<crate::AgentKind> {
        crate::AgentKind::from_lenient(self.snapshot.agent_id.as_str())
    }

    pub(in crate::manager) async fn fold_air_tool_meta(
        &self,
        id: &str,
        frame: Option<serde_json::Map<String, serde_json::Value>>,
        open: bool,
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let Some(kind) = self.agent_kind() else {
            return frame;
        };
        let mut ledger = self.air_tool_call_meta.lock().await;
        if open {
            ledger.open(kind, id, frame)
        } else {
            ledger.update(kind, id, frame)
        }
    }

    pub(in crate::manager) async fn append_subagent_chunk(
        &self,
        parent_id: &str,
        field: &str,
        chunk_text: &str,
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let kind = self.agent_kind().unwrap_or(crate::AgentKind::ClaudeCode);
        let mut ledger = self.air_tool_call_meta.lock().await;
        ledger.append_subagent_chunk(kind, parent_id, field, chunk_text)
    }

    pub(in crate::manager) fn record_turn_probe_event(
        &self,
        session_id: Option<AgentSessionId>,
        event: &AgentEvent,
    ) {
        if let Some(session_id) = session_id
            && let Ok(guard) = self.active_turn_probe.lock()
            && let Some((active_session_id, probe)) = guard.as_ref()
            && *active_session_id == session_id
        {
            probe.record_agent_event(event);
        }
    }

    pub(in crate::manager) fn note_adapter_turn_error(
        &self,
        session_id: Option<AgentSessionId>,
        error: String,
    ) {
        if let Ok(guard) = self.active_turn_probe.lock()
            && let Some((active_session_id, probe)) = guard.as_ref()
            && session_id.is_none_or(|sid| sid == *active_session_id)
        {
            probe.note_adapter_turn_error(error);
        }
    }

    pub(in crate::manager) fn note_dropped_update(
        &self,
        session_id: Option<AgentSessionId>,
        tag: Option<&str>,
        error: &str,
    ) {
        let sanitized_error = sanitize_diagnostic(error);
        if let Ok(guard) = self.active_turn_probe.lock()
            && let Some((active_session_id, probe)) = guard.as_ref()
            && session_id.is_none_or(|sid| sid == *active_session_id)
        {
            probe.note_dropped(tag, &sanitized_error);
        }
        if let Some(suppressed) = self.update_log_throttle.check() {
            let line = dropped_update_log_line(
                &self.snapshot.connection_id,
                session_id,
                tag,
                &sanitized_error,
                suppressed,
            );
            tracing::warn!("{line}");
        }
    }

    pub(in crate::manager) async fn store_preferred_controls(
        &self,
        session_id: AgentSessionId,
        preferences: crate::SessionControlPreferences,
    ) {
        if preferences.is_empty() {
            return;
        }
        self.preferred_controls
            .write()
            .await
            .insert(session_id, preferences);
    }

    pub(in crate::manager) async fn run(
        self,
        cmd_rx: mpsc::Receiver<AgentConnectionCommand>,
        ready_tx: oneshot::Sender<AgentResult<()>>,
    ) {
        // Shared so run_acp signals Ok at handshake AND a pre-handshake failure
        // forwards the REAL error to `connect` (instead of a dropped-sender
        // generic). `take()` makes exactly one of the two fire.
        let ready = Arc::new(Mutex::new(Some(ready_tx)));
        if let Err(error) = self.run_acp(cmd_rx, Arc::clone(&ready)).await {
            let turn_error = turn_error_event_from_connection_failure(&error);
            let status_message = turn_error.message.clone();
            if let Some(tx) = ready.lock().await.take() {
                let _ = tx.send(Err(error));
            }
            self.emit_connection_status(AgentConnectionStatus::Failed, Some(status_message), None);
            // If a prompt was still in flight when the connection died (the agent
            // crashed, the transport dropped, or prompt setup like session/new
            // failed and propagated out of run_prompt), emit a turn-terminal Error
            // carrying its (session_id, prompt_id) so the conversation fails
            // cleanly. Without these ids the event is dropped before reaching the
            // turn (events.rs requires a session_id) and the turn spins forever.
            // `run_prompt` clears `active_prompt` whenever it emits its own
            // terminal event, so this fires only when nothing else closed the turn.
            // Warmup / idle process death has no prompt: fail the connection only.
            match self.active_prompt.lock().await.take() {
                Some((session_id, prompt_id)) => {
                    self.emit(
                        Some(session_id),
                        Some(prompt_id),
                        AgentEvent::Error { error: turn_error },
                    );
                }
                None => {
                    tracing::warn!(
                        agent_id = %self.snapshot.agent_id.as_str(),
                        "ACP connection ended without an in-flight turn"
                    );
                }
            }
        }
        self.cancel_all_pending_interactions().await;
    }

    pub(in crate::manager) fn emit(
        &self,
        session_id: Option<AgentSessionId>,
        prompt_id: Option<AgentPromptId>,
        event: AgentEvent,
    ) {
        if let AgentEvent::Error { error } = &event {
            let session = session_id.map(|id| id.to_string());
            let prompt = prompt_id.map(|id| id.to_string());
            let code = error.code.as_deref().unwrap_or("unknown");
            if !agent_error_is_in_flight_turn_failure(code, session_id, prompt_id) {
                tracing::debug!(
                    agent_id = %self.snapshot.agent_id.as_str(),
                    session_id = session.as_deref().unwrap_or("-"),
                    prompt_id = prompt.as_deref().unwrap_or("-"),
                    code,
                    "{}",
                    error.message
                );
            } else {
                tracing::error!(
                    agent_id = %self.snapshot.agent_id.as_str(),
                    session_id = session.as_deref().unwrap_or("-"),
                    prompt_id = prompt.as_deref().unwrap_or("-"),
                    code,
                    "{}",
                    error.message
                );
            }
        }
        self.record_turn_probe_event(session_id, &event);
        send_manager_event(
            &self.event_tx,
            AgentConnectionManagerEvent {
                connection_id: self.snapshot.connection_id,
                session_id,
                prompt_id,
                event,
            },
        );
    }

    pub(in crate::manager) async fn fail_active_turn(
        &self,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        error: AgentError,
    ) {
        self.emit(
            Some(session_id),
            Some(prompt_id),
            AgentEvent::Error {
                error: turn_error_event_from_connection_failure(&error),
            },
        );
        if let Ok(mut guard) = self.active_turn_probe.lock() {
            *guard = None;
        }
        *self.active_prompt.lock().await = None;
    }

    pub(in crate::manager) fn emit_connection_status(
        &self,
        status: AgentConnectionStatus,
        status_message: Option<String>,
        session_id: Option<AgentSessionId>,
    ) {
        if matches!(
            status,
            AgentConnectionStatus::Connecting | AgentConnectionStatus::Recovering
        ) {
            tracing::warn!(
                connection_id = %self.snapshot.connection_id,
                session_id = ?session_id,
                ?status,
                message = status_message.as_deref().unwrap_or(""),
                "ACP session reconnecting (UI notice: 正在连接 Agent…)"
            );
        }
        let now = Utc::now();
        if let Ok(mut current) = self.status.try_lock() {
            *current = status;
        }
        self.emit(
            session_id,
            None,
            AgentEvent::ConnectionStatusChanged {
                snapshot: AgentConnectionSnapshot {
                    id: self.snapshot.connection_id,
                    agent_id: self.snapshot.agent_id.clone(),
                    workspace_id: self.snapshot.workspace_id,
                    status,
                    working_dir: self.snapshot.working_dir.display().to_string(),
                    status_message,
                    created_at: now,
                    updated_at: now,
                },
            },
        );
    }
}
