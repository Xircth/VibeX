//! Native Claude Code driver communicating over stdio JSON-RPC 2.0 with
//! `scripts/claude-native-driver.mjs` on VibeX's managed or system Node.js runtime.
//!
//! Surfaces `canUseTool` permission hooks, `AskUserQuestion` elicitation, `session/fork`,
//! `session/revert` (`resumeSessionAt`), `SDKRateLimitInfo`, live subagent telemetry,
//! `TodoWrite` plan updates, token usage, and official-session-only `promptCacheExpiresAt`.

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use command_group::AsyncGroupChild;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader},
    sync::{Mutex as AsyncMutex, broadcast, oneshot},
    time::timeout,
};
use uuid::Uuid;
use workspace_utils::process::{
    ProcessTreeJob, group_spawn_no_window_with_job, new_hidden_tokio_command,
};

pub use super::claude_events::{
    default_claude_models, resolve_claude_driver_script, resolve_node_executable,
};
use super::claude_events::{
    classify_claude_tool_call, claude_capabilities, claude_normalize_mode,
    default_claude_permission_options, encode_claude_question_answers, normalize_sidecar_event,
    parse_sidecar_models, prepare_claude_launch_env, resolve_claude_auth,
    resolve_claude_default_model, serialize_sidecar_blocks, str_opt, str_or,
};
use crate::{
    engine::{
        EngineAuth, EngineCacheStatus, EngineCapabilities, EngineCheckpoint, EngineError,
        EngineEvent, EngineEventStream, EngineForkReceipt, EngineForkRequest, EngineHandle,
        EngineModelInfo, EnginePermissionDecision, EnginePromptRequest, EngineRateLimits,
        EngineStartSpec, EngineSteerReceipt, EngineSteerRequest, EngineToolClassification,
        NativeEngineDriver, NativeEngineKind, PromptMode, TurnEventRouter, TurnRouteFilter,
        descriptor::normalize_agent_token, format_bounded_diagnostic,
        is_placeholder_engine_session_id, prepare_instance_isolation_env_for_keys,
        stream_router::spawn_stderr_tail_reader,
    },
    stderr_tail::StderrTail,
};

const CLAUDE_SIDECAR_RPC_TIMEOUT_MS: u64 = 30_000;
const EVENT_CHANNEL_CAPACITY: usize = 512;

type PendingRpcEntry = (oneshot::Sender<Result<Value, EngineError>>, u64);
type PendingRpcMap = HashMap<u64, PendingRpcEntry>;

#[derive(Debug, Clone)]
struct PendingSidecarServerRequest {
    raw_rpc_id: Value,
    prompt_id: Option<String>,
    session_id: Option<String>,
}

/// Live JSON-RPC 2.0 connection to a `claude-native-driver.mjs` Node sidecar process.
pub struct ClaudeSidecarClient {
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    child: AsyncMutex<Option<AsyncGroupChild>>,
    process_job: Mutex<Option<ProcessTreeJob>>,
    stderr_tail: Arc<StderrTail>,
    next_request_id: AtomicU64,
    pending: Arc<Mutex<PendingRpcMap>>,
    server_requests: Arc<Mutex<HashMap<String, PendingSidecarServerRequest>>>,
    turn_router: TurnEventRouter,
    event_tx: broadcast::Sender<EngineEvent>,
    latest_rate_limits: Arc<RwLock<Option<EngineRateLimits>>>,
    latest_cache_status: Arc<RwLock<Option<EngineCacheStatus>>>,
    discovered_models: Arc<RwLock<Vec<EngineModelInfo>>>,
    official_session: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

impl std::fmt::Debug for ClaudeSidecarClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeSidecarClient")
            .field("alive", &self.is_alive())
            .field(
                "official_session",
                &self.official_session.load(Ordering::Relaxed),
            )
            .finish()
    }
}

impl Drop for ClaudeSidecarClient {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.process_job.lock()
            && let Some(job) = guard.take()
        {
            let _ = job.terminate();
        }
    }
}

impl ClaudeSidecarClient {
    pub async fn spawn(spec: &EngineStartSpec) -> Result<Arc<Self>, EngineError> {
        let node_binary = resolve_node_executable(spec).await?;
        let script_path = resolve_claude_driver_script(spec)?;
        let isolation_env = prepare_instance_isolation_env_for_keys(
            spec,
            Some(("CLAUDE_CONFIG_DIR", "claude-config")),
        )?;

        let mut cmd = new_hidden_tokio_command(&node_binary, [&script_path]);
        cmd.current_dir(&spec.working_dir)
            .envs(&isolation_env)
            .envs(&spec.env);
        for key in &spec.scrubbed_env_keys {
            cmd.env_remove(key);
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let (mut child, job) = group_spawn_no_window_with_job(&mut cmd).map_err(|err| {
            EngineError::Transport(format_bounded_diagnostic(
                &format!(
                    "failed to spawn Claude native sidecar ({} {}): {err}",
                    node_binary.display(),
                    script_path.display()
                ),
                None,
                None,
            ))
        })?;

        let stdin = child.inner().stdin.take().ok_or_else(|| {
            EngineError::Transport("Claude native sidecar stdin unavailable".into())
        })?;
        let stdout = child.inner().stdout.take().ok_or_else(|| {
            EngineError::Transport("Claude native sidecar stdout unavailable".into())
        })?;

        let stderr_tail = Arc::new(StderrTail::new());
        if let Some(stderr) = child.inner().stderr.take() {
            spawn_stderr_tail_reader(stderr, Arc::clone(&stderr_tail), "claude");
        }

        let initial_official = spec
            .auth
            .is_official_anthropic_session(&spec.env, &spec.config_overrides);
        let client = Self::connect_over_io_with_stderr(
            stdout,
            stdin,
            Some(child),
            Some(job),
            stderr_tail,
            initial_official,
        );

        let mut merged_spec = spec.clone();
        for (k, v) in isolation_env {
            merged_spec.env.entry(k).or_insert(v);
        }
        if let Err(err) = client.initialize(&merged_spec).await {
            let _ = client.shutdown().await;
            return Err(err);
        }
        Ok(client)
    }

    pub fn connect_over_io<R, W>(
        reader: R,
        writer: W,
        child: Option<AsyncGroupChild>,
        official_session: bool,
    ) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::connect_over_io_with_stderr(
            reader,
            writer,
            child,
            None,
            Arc::new(StderrTail::new()),
            official_session,
        )
    }

    pub fn connect_over_io_with_stderr<R, W>(
        reader: R,
        writer: W,
        child: Option<AsyncGroupChild>,
        process_job: Option<ProcessTreeJob>,
        stderr_tail: Arc<StderrTail>,
        official_session: bool,
    ) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let writer_arc: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>> =
            Arc::new(AsyncMutex::new(Box::new(writer)));
        let pending: Arc<Mutex<PendingRpcMap>> = Arc::new(Mutex::new(HashMap::new()));
        let server_requests = Arc::new(Mutex::new(HashMap::new()));
        let turn_router = TurnEventRouter::new();
        let latest_rate_limits = Arc::new(RwLock::new(None));
        let latest_cache_status = Arc::new(RwLock::new(None));
        let discovered_models = Arc::new(RwLock::new(Vec::new()));
        let official_flag = Arc::new(AtomicBool::new(official_session));
        let alive = Arc::new(AtomicBool::new(true));

        let client = Arc::new(Self {
            writer: Arc::clone(&writer_arc),
            child: AsyncMutex::new(child),
            process_job: Mutex::new(process_job),
            stderr_tail: Arc::clone(&stderr_tail),
            next_request_id: AtomicU64::new(1),
            pending: Arc::clone(&pending),
            server_requests: Arc::clone(&server_requests),
            turn_router: turn_router.clone(),
            event_tx: event_tx.clone(),
            latest_rate_limits: Arc::clone(&latest_rate_limits),
            latest_cache_status: Arc::clone(&latest_cache_status),
            discovered_models,
            official_session: Arc::clone(&official_flag),
            alive: Arc::clone(&alive),
        });

        tokio::spawn(run_sidecar_reader_loop(
            reader,
            writer_arc,
            pending,
            server_requests,
            turn_router,
            event_tx,
            stderr_tail,
            latest_rate_limits,
            latest_cache_status,
            official_flag,
            alive,
        ));
        client
    }

    pub async fn initialize(&self, spec: &EngineStartSpec) -> Result<Value, EngineError> {
        let auth_json = match &spec.auth {
            EngineAuth::Ambient => json!({}),
            EngineAuth::ApiKey { api_key, base_url } => {
                json!({ "apiKey": api_key, "baseUrl": base_url })
            }
            EngineAuth::OAuth {
                oauth_token,
                account_email,
            } => json!({ "oauthToken": oauth_token, "accountEmail": account_email }),
        };

        let local_official = spec
            .auth
            .is_official_anthropic_session(&spec.env, &spec.config_overrides);

        let additional_dirs: Vec<String> = spec
            .additional_directories
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let mcp_servers = spec.mcp_servers.is_object().then(|| spec.mcp_servers.clone());

        let params = json!({
            "workspaceId": spec.workspace_id.to_string(),
            "workingDir": spec.working_dir.to_string_lossy(),
            "model": spec.model,
            "auth": auth_json,
            "env": spec.env,
            "configOverrides": spec.config_overrides,
            "mcpServers": mcp_servers,
            "additionalDirectories": additional_dirs,
        });
        let result = self.request("initialize", params).await?;

        let parsed_models = parse_sidecar_models(result.get("models"));
        if !parsed_models.is_empty()
            && let Ok(mut guard) = self.discovered_models.write()
        {
            *guard = parsed_models;
        }

        let sidecar_official = result
            .get("officialAnthropicSession")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let effective_official = local_official && sidecar_official;
        self.official_session
            .store(effective_official, Ordering::Release);
        if !effective_official
            && let Ok(mut guard) = self.latest_cache_status.write()
        {
            *guard = None;
        }
        Ok(result)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn is_official_session(&self) -> bool {
        self.official_session.load(Ordering::Acquire)
    }

    pub fn stderr_tail(&self) -> &Arc<StderrTail> {
        &self.stderr_tail
    }

    pub fn turn_router(&self) -> &TurnEventRouter {
        &self.turn_router
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<EngineEvent> {
        self.event_tx.subscribe()
    }

    pub fn discovered_models(&self) -> Vec<EngineModelInfo> {
        let models = self
            .discovered_models
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        if models.is_empty() {
            default_claude_models()
        } else {
            models
        }
    }

    pub fn latest_rate_limits(&self) -> Option<EngineRateLimits> {
        self.latest_rate_limits
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn latest_cache_status(&self) -> Option<EngineCacheStatus> {
        if !self.is_official_session() {
            return None;
        }
        self.latest_cache_status
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, EngineError> {
        let mark = self.stderr_tail.mark();
        if !self.is_alive() {
            return Err(EngineError::Transport(format_bounded_diagnostic(
                "Claude native sidecar connection is closed",
                Some(&self.stderr_tail),
                Some(mark),
            )));
        }

        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(id, (tx, mark));
        }

        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(err) = super::write_jsonrpc_frame(&self.writer, &payload).await {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&id);
            }
            return Err(err);
        }

        match timeout(Duration::from_millis(CLAUDE_SIDECAR_RPC_TIMEOUT_MS), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(EngineError::Transport(format_bounded_diagnostic(
                &format!("Claude sidecar closed while awaiting `{method}`"),
                Some(&self.stderr_tail),
                Some(mark),
            ))),
            Err(_) => {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                Err(EngineError::Timeout {
                    method: method.to_string(),
                    timeout_ms: CLAUDE_SIDECAR_RPC_TIMEOUT_MS,
                })
            }
        }
    }

    pub async fn respond_permission_or_server_request(
        &self,
        decision: &EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        let server_req = self
            .server_requests
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&decision.permission_id));

        if let Some(pending) = server_req {
            let behavior = if decision.approved && !decision.interrupt {
                "allow"
            } else {
                "deny"
            };
            let response = json!({
                "jsonrpc": "2.0",
                "id": pending.raw_rpc_id,
                "result": {
                    "behavior": behavior,
                    "approved": decision.approved,
                    "optionId": decision.option_id,
                    "updatedInput": decision.updated_input,
                    "message": decision.message,
                    "interrupt": decision.interrupt,
                }
            });
            super::write_jsonrpc_frame(&self.writer, &response).await?;
            let resolved = EngineEvent::PermissionResolved {
                permission_id: decision.permission_id.clone(),
                prompt_id: pending.prompt_id,
                session_id: pending.session_id,
                behavior: behavior.to_string(),
            };
            self.turn_router.publish(&resolved);
            let _ = self.event_tx.send(resolved);
            return Ok(());
        }

        let params = json!({
            "permissionId": decision.permission_id,
            "approved": decision.approved && !decision.interrupt,
            "decision": decision.option_id,
            "optionId": decision.option_id,
            "updatedInput": decision.updated_input,
            "message": decision.message,
            "interrupt": decision.interrupt,
        });
        let _ = self.request("permission/respond", params).await?;
        Ok(())
    }

    pub async fn respond_question(
        &self,
        request_id: &str,
        answers: Value,
        cancelled: bool,
    ) -> Result<(), EngineError> {
        let params = json!({
            "requestId": request_id,
            "answers": answers,
            "cancelled": cancelled,
        });
        let _ = self.request("question/respond", params).await?;
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), EngineError> {
        if self.is_alive() {
            let _ = timeout(Duration::from_secs(3), self.request("shutdown", json!({}))).await;
        }
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.process_job.lock()
            && let Some(job) = guard.take()
        {
            let _ = job.terminate();
        }
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_sidecar_reader_loop<R>(
    reader: R,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Arc<Mutex<PendingRpcMap>>,
    server_requests: Arc<Mutex<HashMap<String, PendingSidecarServerRequest>>>,
    turn_router: TurnEventRouter,
    event_tx: broadcast::Sender<EngineEvent>,
    stderr_tail: Arc<StderrTail>,
    latest_rate_limits: Arc<RwLock<Option<EngineRateLimits>>>,
    latest_cache_status: Arc<RwLock<Option<EngineCacheStatus>>>,
    official_session: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let raw_id = msg.get("id").filter(|v| !v.is_null()).cloned();
        let method = msg.get("method").and_then(Value::as_str);

        if let Some(ref id_val) = raw_id
            && method.is_none()
        {
            let numeric_id = id_val
                .as_u64()
                .or_else(|| id_val.as_str().and_then(|s| s.parse::<u64>().ok()));
            if let Some(id) = numeric_id
                && let Some((tx, mark)) = pending.lock().ok().and_then(|mut map| map.remove(&id))
            {
                if let Some(err_val) = msg.get("error").filter(|v| !v.is_null()) {
                    let code = err_val
                        .get("code")
                        .and_then(Value::as_i64)
                        .unwrap_or(-32000);
                    let raw_msg = err_val
                        .get("message")
                        .and_then(Value::as_str)
                        .or_else(|| err_val.as_str())
                        .unwrap_or("Claude native sidecar error");
                    let message =
                        format_bounded_diagnostic(raw_msg, Some(&stderr_tail), Some(mark));
                    let _ = tx.send(Err(EngineError::Rpc { code, message }));
                } else {
                    let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
            continue;
        }

        if let (Some(id_val), Some(method_name)) = (raw_id, method) {
            let params = msg.get("params").unwrap_or(&Value::Null);
            if matches!(method_name, "permission/request" | "canUseTool") {
                let permission_id = str_opt(params, "permissionId").unwrap_or_else(|| {
                    match &id_val {
                        Value::Number(n) => format!("claude-perm-{n}"),
                        Value::String(s) => s.clone(),
                        other => format!("claude-perm-{other}"),
                    }
                });
                let prompt_id = str_opt(params, "promptId");
                let session_id = str_opt(params, "sessionId");
                if let Ok(mut map) = server_requests.lock() {
                    map.insert(
                        permission_id.clone(),
                        PendingSidecarServerRequest {
                            raw_rpc_id: id_val,
                            prompt_id: prompt_id.clone(),
                            session_id: session_id.clone(),
                        },
                    );
                }
                let event = EngineEvent::PermissionRequested {
                    permission_id,
                    prompt_id,
                    session_id,
                    tool_name: str_or(params, "toolName", "unknown"),
                    input: params.get("input").cloned().unwrap_or_else(|| json!({})),
                    decision_reason: str_opt(params, "decisionReason"),
                    options: default_claude_permission_options(),
                };
                turn_router.publish(&event);
                let _ = event_tx.send(event);
            } else {
                let unsupported = json!({
                    "jsonrpc": "2.0",
                    "id": id_val,
                    "error": {
                        "code": -32601,
                        "message": format!("Unsupported server request method `{method_name}`"),
                    }
                });
                let _ = super::write_jsonrpc_frame(&writer, &unsupported).await;
            }
            continue;
        }

        if method == Some("engine/event")
            && let Some(params) = msg.get("params")
            && let Some(normalized) = normalize_sidecar_event(
                params,
                &latest_rate_limits,
                &latest_cache_status,
                official_session.load(Ordering::Acquire),
            )
        {
            turn_router.publish(&normalized);
            let _ = event_tx.send(normalized);
        }
    }

    alive.store(false, Ordering::Release);
    if let Ok(mut map) = pending.lock() {
        for (_, (tx, mark)) in map.drain() {
            let _ = tx.send(Err(EngineError::Transport(format_bounded_diagnostic(
                "Claude native sidecar exited unexpectedly",
                Some(&stderr_tail),
                Some(mark),
            ))));
        }
    }
    if let Ok(mut map) = server_requests.lock() {
        map.clear();
    }
    turn_router.fail_active_turns("Claude native sidecar exited unexpectedly", &stderr_tail);
}

struct ClaudeHandleEntry {
    spec: EngineStartSpec,
    sidecar: Arc<ClaudeSidecarClient>,
}

/// `NativeEngineDriver` backed by `scripts/claude-native-driver.mjs`.
pub struct ClaudeNativeDriver {
    handles: RwLock<HashMap<Uuid, Arc<ClaudeHandleEntry>>>,
}

impl Default for ClaudeNativeDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeNativeDriver {
    pub fn new() -> Self {
        Self {
            handles: RwLock::new(HashMap::new()),
        }
    }

    pub async fn connect_duplex<R, W>(
        spec: EngineStartSpec,
        reader: R,
        writer: W,
        stderr_tail: Option<Arc<StderrTail>>,
    ) -> Result<(Self, EngineHandle), EngineError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let initial_official = spec
            .auth
            .is_official_anthropic_session(&spec.env, &spec.config_overrides);
        let tail = stderr_tail.unwrap_or_else(|| Arc::new(StderrTail::new()));
        let sidecar = ClaudeSidecarClient::connect_over_io_with_stderr(
            reader,
            writer,
            None,
            None,
            tail,
            initial_official,
        );
        sidecar.initialize(&spec).await?;
        let driver = Self::new();
        let handle = driver.bind_existing_sidecar(spec, sidecar, None);
        Ok((driver, handle))
    }

    pub fn bind_existing_sidecar(
        &self,
        spec: EngineStartSpec,
        sidecar: Arc<ClaudeSidecarClient>,
        initial_session_id: Option<String>,
    ) -> EngineHandle {
        let connection_id = Uuid::new_v4();
        let official = sidecar.is_official_session();
        let clean_initial =
            initial_session_id.filter(|s| !is_placeholder_engine_session_id(s));
        let handle = EngineHandle::new(
            connection_id,
            NativeEngineKind::ClaudeNative,
            spec.workspace_id,
            spec.working_dir.clone(),
            official,
            clean_initial,
        );
        let entry = Arc::new(ClaudeHandleEntry { spec, sidecar });
        if let Ok(mut map) = self.handles.write() {
            map.insert(connection_id, entry);
        }
        handle
    }

    async fn ensure_sidecar(
        &self,
        handle: &EngineHandle,
    ) -> Result<Arc<ClaudeSidecarClient>, EngineError> {
        let entry = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())
            .ok_or(EngineError::UnknownHandle(handle.connection_id))?;

        if entry.sidecar.is_alive() {
            return Ok(Arc::clone(&entry.sidecar));
        }

        let respawned = ClaudeSidecarClient::spawn(&entry.spec).await?;
        let replaced = Arc::new(ClaudeHandleEntry {
            spec: entry.spec.clone(),
            sidecar: Arc::clone(&respawned),
        });
        if let Ok(mut map) = self.handles.write() {
            map.insert(handle.connection_id, replaced);
        }
        Ok(respawned)
    }
}

#[async_trait]
impl NativeEngineDriver for ClaudeNativeDriver {
    fn engine_id(&self) -> &str {
        NativeEngineKind::ClaudeNative.engine_id()
    }

    fn kind(&self) -> Option<NativeEngineKind> {
        Some(NativeEngineKind::ClaudeNative)
    }

    fn supports_agent(&self, agent_kind_or_id: &str) -> bool {
        matches!(
            normalize_agent_token(agent_kind_or_id).as_str(),
            "claude_code" | "claudecode" | "claude" | "claude_native"
        )
    }

    fn capabilities(&self) -> EngineCapabilities {
        claude_capabilities(self.engine_id())
    }

    fn normalize_mode(&self, raw: &str) -> Option<String> {
        claude_normalize_mode(raw)
    }

    fn resolve_auth(&self, env: &HashMap<String, String>) -> EngineAuth {
        resolve_claude_auth(env)
    }

    fn prepare_launch_env(
        &self,
        locked_program: &Path,
        _snapshot_env: &HashMap<String, String>,
        launch_env: &mut HashMap<String, String>,
        _scrubbed_keys: &mut Vec<String>,
    ) {
        prepare_claude_launch_env(locked_program, launch_env);
    }

    fn profile_isolation_dir(&self) -> Option<(&'static str, &'static str)> {
        Some(("CLAUDE_CONFIG_DIR", "claude-config"))
    }

    fn uses_custom_base_url(&self, spec: &EngineStartSpec) -> bool {
        !spec
            .auth
            .is_official_anthropic_session(&spec.env, &spec.config_overrides)
    }

    fn resolve_default_model(&self, env: &HashMap<String, String>) -> Option<String> {
        resolve_claude_default_model(env)
    }

    fn model_aliases(&self, env: &HashMap<String, String>) -> HashMap<String, String> {
        crate::end_turn_usage::collect_claude_model_aliases(env)
    }

    fn classify_tool_call(
        &self,
        raw_name: &str,
        input: &Value,
        parent_tool_use_id: Option<&str>,
    ) -> EngineToolClassification {
        classify_claude_tool_call(raw_name, input, parent_tool_use_id)
    }

    fn encode_question_answers(
        &self,
        entries: &[(String, Vec<String>)],
        question_keys: &[(String, String)],
    ) -> Value {
        encode_claude_question_answers(entries, question_keys)
    }

    async fn start(&self, spec: EngineStartSpec) -> Result<EngineHandle, EngineError> {
        let sidecar = ClaudeSidecarClient::spawn(&spec).await?;
        Ok(self.bind_existing_sidecar(spec, sidecar, None))
    }

    async fn send_prompt(
        &self,
        handle: &EngineHandle,
        request: EnginePromptRequest,
    ) -> Result<EngineEventStream, EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;

        let prompt_id_str = request.prompt_id.to_string();
        let session_id = request
            .session_id
            .clone()
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s));
        let (text, blocks) = serialize_sidecar_blocks(&request.blocks, request.mode);

        let turn_stream = sidecar.turn_router().register_turn(
            TurnRouteFilter::ClaudePrompt {
                prompt_id: prompt_id_str.clone(),
                handle: handle.clone(),
            },
            Arc::clone(sidecar.stderr_tail()),
        );

        let additional_dirs: Vec<String> = request
            .additional_directories
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();

        let mut params = json!({
            "promptId": prompt_id_str,
            "sessionId": session_id,
            "resume": session_id.is_some(),
            "text": text,
            "blocks": blocks,
            "model": request.model,
            "effort": request.effort,
            "permissionMode": request.permission_mode,
        });
        if let Some(mcp) = request.mcp_servers.filter(|v| v.is_object()) {
            params["mcpServers"] = mcp;
        }
        if !additional_dirs.is_empty() {
            params["additionalDirectories"] = json!(additional_dirs);
        }

        let send_result = sidecar.request("prompt/send", params).await?;
        if let Some(returned_sid) = str_opt(&send_result, "sessionId")
            .filter(|s| !is_placeholder_engine_session_id(s))
        {
            handle.set_external_session_id(Some(returned_sid));
        }

        Ok(Box::pin(turn_stream))
    }

    async fn steer(
        &self,
        handle: &EngineHandle,
        request: EngineSteerRequest,
    ) -> Result<EngineSteerReceipt, EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;
        let (text, blocks) = serialize_sidecar_blocks(&request.blocks, PromptMode::Steer);
        let params = json!({
            "expectedPromptId": request.expected_prompt_id.map(|id| id.to_string()),
            "text": text,
            "blocks": blocks,
        });
        let result = sidecar.request("prompt/steer", params).await?;

        if result.get("status").and_then(Value::as_str) == Some("accepted") {
            Ok(EngineSteerReceipt::Accepted {
                prompt_id: str_opt(&result, "promptId"),
                session_id: str_opt(&result, "sessionId"),
                delivery_mode: str_or(&result, "deliveryMode", "native"),
            })
        } else {
            Ok(EngineSteerReceipt::Rejected {
                code: str_or(&result, "code", "rejected"),
                message: str_or(&result, "message", "Steering rejected by Claude sidecar"),
            })
        }
    }

    async fn interrupt(&self, handle: &EngineHandle) -> Result<(), EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;
        let _ = sidecar
            .request("prompt/interrupt", json!({ "reason": "user_interrupted" }))
            .await?;
        Ok(())
    }

    async fn fork_session(
        &self,
        handle: &EngineHandle,
        request: EngineForkRequest,
    ) -> Result<EngineForkReceipt, EngineError> {
        if let Some(ref cp) = request.checkpoint_point
            && cp.trim().is_empty()
        {
            return Err(EngineError::InvalidRequest(
                "fork_session checkpoint_point (`resumeSessionAt`) cannot be empty".into(),
            ));
        }
        let sidecar = self.ensure_sidecar(handle).await?;
        let source_session_id = request
            .source_session_id
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest(
                    "fork_session requires a source Claude sessionId".into(),
                )
            })?;

        let params = json!({
            "sessionId": source_session_id,
            "newSessionId": request.new_session_id,
            "resumeSessionAt": request.checkpoint_point,
        });
        let result = sidecar.request("session/fork", params).await?;
        let forked_id = str_opt(&result, "sessionId").ok_or_else(|| {
            EngineError::Transport("session/fork did not return sessionId".to_string())
        })?;

        Ok(EngineForkReceipt {
            source_session_id,
            forked_session_id: forked_id,
            checkpoint_point: str_opt(&result, "resumeSessionAt"),
        })
    }

    async fn revert_to(
        &self,
        handle: &EngineHandle,
        checkpoint: EngineCheckpoint,
    ) -> Result<(), EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;
        let session_id = checkpoint
            .session_id
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest("revert_to requires a Claude sessionId".into())
            })?;
        let resume_session_at = checkpoint
            .external_session_point
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                EngineError::InvalidRequest(
                    "Claude native revert_to requires non-empty external_session_point (`resumeSessionAt`)"
                        .into(),
                )
            })?;

        let params = json!({ "sessionId": session_id, "resumeSessionAt": resume_session_at });
        let _ = sidecar.request("session/revert", params).await?;
        Ok(())
    }

    async fn respond_permission(
        &self,
        handle: &EngineHandle,
        decision: EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;
        sidecar.respond_permission_or_server_request(&decision).await
    }

    async fn respond_question(
        &self,
        handle: &EngineHandle,
        request_id: &str,
        answers: Value,
        cancelled: bool,
    ) -> Result<(), EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;
        sidecar
            .respond_question(request_id, answers, cancelled)
            .await
    }

    async fn list_models(
        &self,
        handle: &EngineHandle,
    ) -> Result<Vec<EngineModelInfo>, EngineError> {
        let sidecar = self.ensure_sidecar(handle).await?;
        Ok(sidecar.discovered_models())
    }

    fn rate_limits(&self, handle: &EngineHandle) -> Option<EngineRateLimits> {
        let entry = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())?;
        entry.sidecar.latest_rate_limits()
    }

    fn cache_status(&self, handle: &EngineHandle) -> Option<EngineCacheStatus> {
        let entry = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())?;
        entry.sidecar.latest_cache_status()
    }

    async fn shutdown(&self, handle: EngineHandle) -> Result<(), EngineError> {
        let removed = self
            .handles
            .write()
            .ok()
            .and_then(|mut map| map.remove(&handle.connection_id));
        if let Some(entry) = removed {
            entry.sidecar.shutdown().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use futures::StreamExt;
    use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

    use super::*;
    use crate::conversation::ContentBlock;

    fn test_spec(base_url: Option<&str>) -> EngineStartSpec {
        let mut env = HashMap::new();
        if let Some(url) = base_url {
            env.insert("ANTHROPIC_BASE_URL".to_string(), url.to_string());
        }
        EngineStartSpec {
            workspace_id: Uuid::new_v4(),
            working_dir: PathBuf::from("."),
            provider_instance_id: None,
            auth: EngineAuth::Ambient,
            model: Some("claude-sonnet-4-5".to_string()),
            config_overrides: Value::Null,
            env,
            ..Default::default()
        }
    }

    async fn send_reply<W: AsyncWrite + Unpin>(writer: &mut W, id: &Option<Value>, result: Value) {
        let line = format!(
            "{}\n",
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        );
        writer.write_all(line.as_bytes()).await.unwrap();
    }

    async fn send_event<W: AsyncWrite + Unpin>(writer: &mut W, params: Value) {
        let line = format!(
            "{}\n",
            json!({ "jsonrpc": "2.0", "method": "engine/event", "params": params })
        );
        writer.write_all(line.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn claude_native_driver_handles_permissions_questions_subagents_cache_ttl_and_revert() {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (server_read, mut server_write) = tokio::io::split(server_io);

        let spec = test_spec(None);
        let sidecar = ClaudeSidecarClient::connect_over_io(client_read, client_write, None, true);

        let mock_sidecar = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                let id = req.get("id").cloned();

                match method {
                    "initialize" => {
                        let res = json!({
                            "protocolVersion": "1.0",
                            "engineId": "claude-native",
                            "officialAnthropicSession": true,
                            "models": [{ "value": "claude-opus-4-7", "displayName": "Claude Opus 4.7" }],
                        });
                        send_reply(&mut server_write, &id, res).await;
                    }
                    "prompt/send" => {
                        assert!(req["params"]["sessionId"].is_null());
                        assert_eq!(req["params"]["resume"], false);
                        let pid = req["params"]["promptId"].as_str().unwrap_or("").to_string();
                        let res = json!({ "accepted": true, "promptId": pid, "sessionId": "claude-sess-1" });
                        send_reply(&mut server_write, &id, res).await;

                        let mock_events = [
                            json!({ "kind": "session_initialized", "sessionId": "claude-sess-1", "model": "claude-opus-4-7", "slashCommands": ["compact", "review"] }),
                            json!({ "kind": "permission_requested", "permissionId": "perm-1", "promptId": pid, "sessionId": "claude-sess-1", "toolName": "Bash", "input": { "command": "ls" } }),
                            json!({ "kind": "question_requested", "requestId": "q-1", "promptId": pid, "sessionId": "claude-sess-1", "questions": [{ "question": "Target?", "options": [{ "label": "web" }] }] }),
                            json!({ "kind": "plan_updated", "promptId": pid, "sessionId": "claude-sess-1", "entries": [{ "content": "Audit engine", "status": "in_progress" }] }),
                            json!({ "kind": "usage_updated", "promptId": pid, "sessionId": "claude-sess-1", "usage": { "inputTokens": 200, "outputTokens": 50, "totalCostUsd": 0.01 } }),
                            json!({ "kind": "subagent/spawn", "promptId": pid, "sessionId": "claude-sess-1", "subagentId": "sub-1", "subagentType": "research", "description": "Inspect files" }),
                            json!({ "kind": "cache_status_updated", "promptId": pid, "sessionId": "claude-sess-1", "cacheStatus": { "promptCacheExpiresAt": "2026-11-14T12:05:00Z", "promptCacheTtlRemainingMs": 295_000, "cacheTtlTier": "5m" } }),
                            json!({ "kind": "rate_limits_updated", "promptId": pid, "sessionId": "claude-sess-1", "rateLimits": { "requestsRemaining": 12, "utilization": 0.75, "resetAt": "2026-11-14T13:00:00Z" } }),
                            json!({ "kind": "turn_completed", "promptId": pid, "sessionId": "claude-sess-1", "uuid": "msg-uuid-42", "stopReason": "end_turn", "served_model": "claude-opus-4-7" }),
                        ];
                        for ev in mock_events {
                            send_event(&mut server_write, ev).await;
                        }
                    }
                    "permission/respond" => {
                        assert_eq!(req["params"]["permissionId"], "perm-1");
                        assert_eq!(req["params"]["approved"], true);
                        let res = json!({ "resolved": true, "permissionId": "perm-1", "behavior": "allow" });
                        send_reply(&mut server_write, &id, res).await;
                    }
                    "question/respond" => {
                        assert_eq!(req["params"]["requestId"], "q-1");
                        assert_eq!(req["params"]["answers"]["Target?"], "web");
                        let res = json!({ "resolved": true, "requestId": "q-1" });
                        send_reply(&mut server_write, &id, res).await;
                    }
                    "session/revert" => {
                        assert_eq!(req["params"]["resumeSessionAt"], "msg-uuid-10");
                        let res = json!({ "reverted": true, "sessionId": "claude-sess-1", "resumeSessionAt": "msg-uuid-10" });
                        send_reply(&mut server_write, &id, res).await;
                        break;
                    }
                    _ => {}
                }
            }
        });

        sidecar.initialize(&spec).await.expect("init succeeds");
        let driver = ClaudeNativeDriver::new();
        let handle = driver.bind_existing_sidecar(
            spec,
            Arc::clone(&sidecar),
            Some("prepared-placeholder".into()),
        );
        assert!(handle.external_session_id().is_none());

        let models = driver.list_models(&handle).await.unwrap();
        assert_eq!(models[0].id, "claude-opus-4-7");

        let req = EnginePromptRequest {
            prompt_id: Uuid::new_v4(),
            blocks: vec![ContentBlock::Text {
                text: "Inspect project".into(),
            }],
            session_id: Some("prepared-placeholder".into()),
            mode: PromptMode::Normal,
            ..Default::default()
        };
        let events: Vec<EngineEvent> = driver
            .send_prompt(&handle, req)
            .await
            .unwrap()
            .collect()
            .await;
        assert!(events.iter().any(|ev| matches!(
            ev,
            EngineEvent::QuestionRequested { request_id, .. } if request_id == "q-1"
        )));
        assert!(events.iter().any(|ev| matches!(ev, EngineEvent::PlanUpdated { .. })));
        assert!(events.iter().any(|ev| matches!(ev, EngineEvent::UsageUpdated { .. })));

        let decision = EnginePermissionDecision {
            permission_id: "perm-1".into(),
            approved: true,
            option_id: Some("allow_always".into()),
            updated_input: None,
            message: None,
            interrupt: false,
        };
        driver.respond_permission(&handle, decision).await.unwrap();
        driver
            .respond_question(&handle, "q-1", json!({ "Target?": "web" }), false)
            .await
            .unwrap();

        let checkpoint = EngineCheckpoint {
            turn_ordinal: 1,
            external_session_point: Some("msg-uuid-10".into()),
            ..Default::default()
        };
        driver.revert_to(&handle, checkpoint).await.unwrap();
        mock_sidecar.await.expect("mock sidecar finished");
    }

    #[test]
    fn resolve_claude_driver_script_never_loads_from_untrusted_working_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake_scripts = tmp.path().join("scripts");
        std::fs::create_dir_all(&fake_scripts).unwrap();
        let untrusted = fake_scripts.join("claude-native-driver.mjs");
        std::fs::write(&untrusted, "console.log('hijack');").unwrap();

        let mut spec = test_spec(None);
        spec.working_dir = tmp.path().to_path_buf();

        let resolved = resolve_claude_driver_script(&spec).expect("resolves repo script");
        assert_ne!(
            resolved.canonicalize().unwrap(),
            untrusted.canonicalize().unwrap()
        );
    }

    #[test]
    fn non_official_proxy_sessions_never_expose_synthesized_cache_status() {
        let proxy_spec = test_spec(Some("https://my-proxy.example.com/v1"));
        assert!(
            !proxy_spec
                .auth
                .is_official_anthropic_session(&proxy_spec.env, &proxy_spec.config_overrides)
        );

        let latest_rate = Arc::new(RwLock::new(None));
        let latest_cache = Arc::new(RwLock::new(None));
        let dropped = normalize_sidecar_event(
            &json!({
                "kind": "cache_status_updated",
                "sessionId": "s1",
                "cacheStatus": {
                    "promptCacheExpiresAt": "2026-11-14T12:05:00Z",
                    "promptCacheTtlRemainingMs": 120_000,
                    "cacheTtlTier": "5m"
                }
            }),
            &latest_rate,
            &latest_cache,
            false,
        );
        assert!(dropped.is_none());
        assert!(latest_cache.read().unwrap().is_none());
    }
}
