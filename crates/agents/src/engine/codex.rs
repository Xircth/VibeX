//! Native Rust JSON-RPC 2.0 client (`CodexAppServer`) and `CodexNativeDriver` for `codex app-server`.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use command_group::AsyncGroupChild;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader},
    sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock, broadcast, oneshot},
    time::timeout,
};
use uuid::Uuid;
use workspace_utils::process::{
    ProcessTreeJob, group_spawn_no_window_with_job, new_hidden_tokio_command,
};

pub use crate::engine::codex_protocol::{
    PendingCodexServerRequest, build_codex_question_result, build_codex_server_request_result,
    codex_approval_options, default_codex_models, parse_codex_rate_limits_payload,
    parse_codex_server_request,
};
use crate::{
    conversation::ContentBlock,
    engine::{
        EngineAuth, EngineCacheStatus, EngineCapabilities, EngineCheckpoint, EngineError,
        EngineEvent, EngineEventStream, EngineForkReceipt, EngineForkRequest, EngineHandle,
        EngineModelInfo, EnginePermissionDecision, EnginePromptRequest, EngineRateLimits,
        EngineStartSpec, EngineSteerReceipt, EngineSteerRequest, NativeEngineDriver,
        NativeEngineKind, PromptMode, TurnEventRouter, TurnRouteFilter,
        codex_protocol::{
            build_codex_turn_policy, codex_accepts_model_id, codex_capabilities,
            codex_normalize_mode, nested_or_str, normalize_codex_notification,
            parse_codex_models_response, prepare_codex_launch_env, resolve_codex_auth,
            resolve_codex_default_model, serialize_codex_input_items, str_any,
        },
        descriptor::normalize_agent_token,
        format_bounded_diagnostic, is_placeholder_engine_session_id,
        prepare_instance_isolation_env_for_keys,
        stream_router::spawn_stderr_tail_reader,
    },
    stderr_tail::StderrTail,
};

const CODEX_RPC_TIMEOUT_MS: u64 = 30_000;
const EVENT_CHANNEL_CAPACITY: usize = 512;

/// Multi-instance cache key isolating `CodexAppServer` instances across workspace,
/// `ProviderInstanceConfig`, credential/base_url fingerprint, and native `CODEX_HOME`
/// configuration/catalog files (§5.1).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CodexServerCacheKey {
    pub workspace_id: Uuid,
    pub provider_instance_id: Option<String>,
    pub auth_fingerprint: String,
    pub native_config_fingerprint: String,
}

impl CodexServerCacheKey {
    pub fn from_spec(spec: &EngineStartSpec) -> Self {
        Self {
            workspace_id: spec.workspace_id,
            provider_instance_id: spec
                .provider_instance_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            auth_fingerprint: spec.auth_fingerprint(),
            native_config_fingerprint: spec.native_codex_config_fingerprint(),
        }
    }
}

/// Evicts all pooled `CodexAppServer` instances from the global cache so subsequent
/// session starts/reloads pick up modified `config.toml`, `auth.json`, or model catalogs,
/// shutting down any idle instances that no active driver handle references.
pub async fn invalidate_codex_servers() -> usize {
    let drained: Vec<Arc<CodexAppServer>> = {
        let mut guard = global_codex_servers().write().await;
        guard.drain().map(|(_, server)| server).collect()
    };
    let count = drained.len();
    for server in drained {
        if Arc::strong_count(&server) <= 1 {
            let _ = server.shutdown().await;
        }
    }
    count
}

/// Tracks auto-compaction progress per Codex thread so turn dispatchers and UI
/// indicators know whether context compaction is currently running.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAutoCompactionThreadState {
    pub thread_id: String,
    pub in_progress: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnRecord {
    pub turn_id: String,
    pub status: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnsPage {
    pub turns: Vec<CodexTurnRecord>,
    pub next_before_turn_id: Option<String>,
    pub has_more: bool,
}

type PendingRpcEntry = (oneshot::Sender<Result<Value, EngineError>>, u64);
type PendingRpcMap = HashMap<u64, PendingRpcEntry>;
type PendingServerRequestMap = HashMap<String, PendingCodexServerRequest>;

const MAX_LOADED_THREADS: usize = 512;

#[derive(Default)]
struct LoadedThreadCache {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl LoadedThreadCache {
    fn insert(&mut self, thread_id: &str) {
        if self.set.insert(thread_id.to_string()) {
            self.order.push_back(thread_id.to_string());
            while self.order.len() > MAX_LOADED_THREADS {
                if let Some(oldest) = self.order.pop_front() {
                    self.set.remove(&oldest);
                }
            }
        }
    }

    fn contains(&self, thread_id: &str) -> bool {
        self.set.contains(thread_id)
    }
}

/// Long-lived per-`(workspace_id, provider_instance_id, auth_fingerprint)` JSON-RPC 2.0
/// client connected to `codex app-server`.
pub struct CodexAppServer {
    workspace_id: Uuid,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    child: AsyncMutex<Option<AsyncGroupChild>>,
    process_job: Mutex<Option<ProcessTreeJob>>,
    stderr_tail: Arc<StderrTail>,
    next_request_id: AtomicU64,
    pending: Arc<Mutex<PendingRpcMap>>,
    server_requests: Arc<Mutex<PendingServerRequestMap>>,
    loaded_threads: Mutex<LoadedThreadCache>,
    turn_router: TurnEventRouter,
    event_tx: broadcast::Sender<EngineEvent>,
    latest_rate_limits: Arc<RwLock<Option<EngineRateLimits>>>,
    compaction_states: Arc<RwLock<HashMap<String, CodexAutoCompactionThreadState>>>,
    alive: Arc<AtomicBool>,
}

impl std::fmt::Debug for CodexAppServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexAppServer")
            .field("workspace_id", &self.workspace_id)
            .field("alive", &self.is_alive())
            .finish()
    }
}

impl Drop for CodexAppServer {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.process_job.lock()
            && let Some(job) = guard.take()
        {
            let _ = job.terminate();
        }
    }
}

fn global_codex_servers() -> &'static AsyncRwLock<HashMap<CodexServerCacheKey, Arc<CodexAppServer>>>
{
    static SERVERS: OnceLock<AsyncRwLock<HashMap<CodexServerCacheKey, Arc<CodexAppServer>>>> =
        OnceLock::new();
    SERVERS.get_or_init(|| AsyncRwLock::new(HashMap::new()))
}

impl CodexAppServer {
    pub async fn spawn_for_workspace(spec: &EngineStartSpec) -> Result<Arc<Self>, EngineError> {
        let codex_path = resolve_codex_binary(spec).await?;
        let isolation_env =
            prepare_instance_isolation_env_for_keys(spec, Some(("CODEX_HOME", "codex-home")))?;

        let mut cmd = new_hidden_tokio_command(&codex_path, ["app-server"]);
        cmd.current_dir(&spec.working_dir);
        crate::codex_shadow_home::apply_codex_instance_isolation_env(
            &mut cmd,
            spec.provider_instance_id.as_deref(),
            spec.isolate_profile,
            &isolation_env,
            &spec.env,
            &spec.scrubbed_env_keys,
        );

        match &spec.auth {
            EngineAuth::ApiKey { api_key, base_url } => {
                cmd.env("OPENAI_API_KEY", api_key);
                if let Some(url) = base_url {
                    cmd.env("OPENAI_BASE_URL", url);
                }
            }
            EngineAuth::OAuth {
                oauth_token: Some(token),
                ..
            } => {
                cmd.env("CODEX_ACCESS_TOKEN", token);
            }
            _ => {}
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let (mut child, job) = group_spawn_no_window_with_job(&mut cmd).map_err(|e| {
            EngineError::Transport(format_bounded_diagnostic(
                &format!("spawn {}: {e}", codex_path.display()),
                None,
                None,
            ))
        })?;

        let stdin = child
            .inner()
            .stdin
            .take()
            .ok_or_else(|| EngineError::Transport("codex stdin unavailable".into()))?;
        let stdout = child
            .inner()
            .stdout
            .take()
            .ok_or_else(|| EngineError::Transport("codex stdout unavailable".into()))?;

        let stderr_tail = Arc::new(StderrTail::new());
        if let Some(stderr) = child.inner().stderr.take() {
            spawn_stderr_tail_reader(stderr, Arc::clone(&stderr_tail), "codex");
        }

        let server = Self::connect_over_io_with_stderr(
            spec.workspace_id,
            stdout,
            stdin,
            Some(child),
            Some(job),
            stderr_tail,
        );
        if let Err(err) = server.handshake().await {
            let _ = server.shutdown().await;
            return Err(err);
        }
        let bg_server = Arc::clone(&server);
        tokio::spawn(async move {
            let _ = timeout(Duration::from_secs(3), bg_server.read_rate_limits()).await;
        });
        Ok(server)
    }

    pub fn connect_over_io<R, W>(
        workspace_id: Uuid,
        reader: R,
        writer: W,
        child: Option<AsyncGroupChild>,
    ) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::connect_over_io_with_stderr(
            workspace_id,
            reader,
            writer,
            child,
            None,
            Arc::new(StderrTail::new()),
        )
    }

    pub fn connect_over_io_with_stderr<R, W>(
        workspace_id: Uuid,
        reader: R,
        writer: W,
        child: Option<AsyncGroupChild>,
        process_job: Option<ProcessTreeJob>,
        stderr_tail: Arc<StderrTail>,
    ) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let writer_arc: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>> =
            Arc::new(AsyncMutex::new(Box::new(writer)));
        let turn_router = TurnEventRouter::new();
        let server = Arc::new(Self {
            workspace_id,
            writer: Arc::clone(&writer_arc),
            child: AsyncMutex::new(child),
            process_job: Mutex::new(process_job),
            stderr_tail: Arc::clone(&stderr_tail),
            next_request_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            server_requests: Arc::new(Mutex::new(HashMap::new())),
            loaded_threads: Mutex::new(LoadedThreadCache::default()),
            turn_router: turn_router.clone(),
            event_tx: event_tx.clone(),
            latest_rate_limits: Arc::new(RwLock::new(None)),
            compaction_states: Arc::new(RwLock::new(HashMap::new())),
            alive: Arc::new(AtomicBool::new(true)),
        });

        tokio::spawn(run_reader_loop(
            reader,
            writer_arc,
            Arc::clone(&server.pending),
            Arc::clone(&server.server_requests),
            turn_router,
            event_tx,
            stderr_tail,
            Arc::clone(&server.latest_rate_limits),
            Arc::clone(&server.compaction_states),
            Arc::clone(&server.alive),
        ));
        server
    }

    pub async fn handshake(&self) -> Result<Value, EngineError> {
        let info = json!({ "name": "dimo", "title": "Dimo", "version": env!("CARGO_PKG_VERSION") });
        let init_params =
            json!({ "clientInfo": info, "capabilities": { "experimentalApi": true } });
        let init_result = self.request("initialize", init_params).await?;
        self.notify("initialized", Value::Null).await?;
        Ok(init_result)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
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

    pub fn latest_rate_limits(&self) -> Option<EngineRateLimits> {
        self.latest_rate_limits.read().ok().and_then(|g| g.clone())
    }

    pub fn thread_compaction_state(
        &self,
        thread_id: &str,
    ) -> Option<CodexAutoCompactionThreadState> {
        self.compaction_states
            .read()
            .ok()
            .and_then(|m| m.get(thread_id).cloned())
    }

    pub fn mark_thread_loaded(&self, thread_id: &str) {
        if !is_placeholder_engine_session_id(thread_id)
            && let Ok(mut guard) = self.loaded_threads.lock()
        {
            guard.insert(thread_id);
        }
    }

    pub fn is_thread_loaded(&self, thread_id: &str) -> bool {
        self.loaded_threads
            .lock()
            .ok()
            .is_some_and(|guard| guard.contains(thread_id))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, EngineError> {
        let mark = self.stderr_tail.mark();
        if !self.is_alive() {
            return Err(EngineError::Transport(format_bounded_diagnostic(
                "codex app-server closed",
                Some(&self.stderr_tail),
                Some(mark),
            )));
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, (tx, mark));
        }

        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(err) = self.write_line(&payload).await {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(err);
        }

        match timeout(Duration::from_millis(CODEX_RPC_TIMEOUT_MS), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(EngineError::Transport(format_bounded_diagnostic(
                &format!("codex app-server closed before replying to `{method}`"),
                Some(&self.stderr_tail),
                Some(mark),
            ))),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(EngineError::Timeout {
                    method: method.to_string(),
                    timeout_ms: CODEX_RPC_TIMEOUT_MS,
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), EngineError> {
        let payload = if params.is_null() {
            json!({ "jsonrpc": "2.0", "method": method })
        } else {
            json!({ "jsonrpc": "2.0", "method": method, "params": params })
        };
        self.write_line(&payload).await
    }

    pub async fn respond_server_request(
        &self,
        decision: &EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        let pending_req = self
            .server_requests
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&decision.permission_id))
            .ok_or_else(|| {
                EngineError::InvalidRequest(format!(
                    "unknown or already-resolved Codex server request `{}`",
                    decision.permission_id
                ))
            })?;

        let (result_obj, behavior) = build_codex_server_request_result(&pending_req, decision);
        let response = json!({
            "jsonrpc": "2.0",
            "id": pending_req.raw_rpc_id,
            "result": result_obj,
        });
        self.write_line(&response).await?;

        let resolved = EngineEvent::PermissionResolved {
            permission_id: decision.permission_id.clone(),
            prompt_id: pending_req.prompt_id,
            session_id: (!pending_req.thread_id.is_empty()).then_some(pending_req.thread_id),
            behavior,
        };
        self.publish_event(resolved);
        Ok(())
    }

    pub async fn respond_question_request(
        &self,
        request_id: &str,
        answers: &Value,
        cancelled: bool,
    ) -> Result<(), EngineError> {
        let pending_req = self
            .server_requests
            .lock()
            .ok()
            .and_then(|mut map| map.remove(request_id))
            .ok_or_else(|| {
                EngineError::InvalidRequest(format!(
                    "unknown or already-resolved Codex question request `{request_id}`"
                ))
            })?;

        let result_obj = build_codex_question_result(&pending_req, answers, cancelled);
        let response = json!({
            "jsonrpc": "2.0",
            "id": pending_req.raw_rpc_id,
            "result": result_obj,
        });
        self.write_line(&response).await
    }

    pub(crate) fn publish_event(&self, event: EngineEvent) {
        self.turn_router.publish(&event);
        let _ = self.event_tx.send(event);
    }

    async fn write_line(&self, message: &Value) -> Result<(), EngineError> {
        super::write_jsonrpc_frame(&self.writer, message).await
    }

    pub async fn ensure_thread(
        &self,
        existing_thread_id: Option<&str>,
        model: Option<&str>,
        working_dir: &Path,
        mcp_servers: Option<&Value>,
        permission_mode: Option<&str>,
    ) -> Result<(String, Option<EngineEvent>), EngineError> {
        let (approval_policy, _) = build_codex_turn_policy(permission_mode, working_dir, &[]);
        let config_obj = mcp_servers
            .filter(|v| v.as_object().is_some_and(|m| !m.is_empty()))
            .map(|mcp| json!({ "mcp_servers": mcp }));

        if let Some(id) = existing_thread_id
            .map(str::trim)
            .filter(|s| !is_placeholder_engine_session_id(s))
        {
            if self.is_thread_loaded(id) {
                return Ok((id.to_string(), None));
            }

            let mut resume_params = json!({
                "threadId": id,
                "cwd": working_dir.to_string_lossy(),
                "model": model,
            });
            if let Some(ap) = approval_policy {
                resume_params["approvalPolicy"] = json!(ap);
            }
            if let Some(cfg) = config_obj {
                resume_params["config"] = cfg;
            }

            let resumed_model = match self.request("thread/resume", resume_params).await {
                Ok(res) => nested_or_str(&res, "thread", "model", "model")
                    .or_else(|| model.map(str::to_string)),
                Err(EngineError::Rpc { code: -32601, .. }) => model.map(str::to_string),
                Err(err) => return Err(err),
            };
            self.mark_thread_loaded(id);
            let init_ev = EngineEvent::SessionInitialized {
                session_id: Some(id.to_string()),
                model: resumed_model,
                slash_commands: vec!["compact".into(), "review".into(), "init".into()],
            };
            return Ok((id.to_string(), Some(init_ev)));
        }

        let mut params = json!({
            "cwd": working_dir.to_string_lossy(),
            "model": model,
        });
        if let Some(ap) = approval_policy {
            params["approvalPolicy"] = json!(ap);
        }
        if let Some(cfg) = config_obj {
            params["config"] = cfg;
        }
        let result = self.request("thread/start", params).await?;
        let thread_id = nested_or_str(&result, "thread", "id", "threadId").ok_or_else(|| {
            EngineError::Transport(format_bounded_diagnostic(
                "thread/start response did not include threadId",
                Some(&self.stderr_tail),
                None,
            ))
        })?;
        let started_model = nested_or_str(&result, "thread", "model", "model")
            .or_else(|| model.map(str::to_string));
        self.mark_thread_loaded(&thread_id);
        let init_ev = EngineEvent::SessionInitialized {
            session_id: Some(thread_id.clone()),
            model: started_model,
            slash_commands: vec!["compact".into(), "review".into(), "init".into()],
        };
        Ok((thread_id, Some(init_ev)))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_turn(
        &self,
        thread_id: &str,
        prompt_id: Uuid,
        blocks: &[ContentBlock],
        model: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
        working_dir: &Path,
        additional_directories: &[PathBuf],
        mode: PromptMode,
    ) -> Result<Value, EngineError> {
        let input = serialize_codex_input_items(blocks, mode);
        let pid = prompt_id.to_string();
        let (approval_policy, sandbox_policy) =
            build_codex_turn_policy(permission_mode, working_dir, additional_directories);

        let mut params = json!({
            "threadId": thread_id,
            "promptId": pid,
            "input": input,
            "model": model,
        });
        if let Some(eff) = effort.map(str::trim).filter(|s| !s.is_empty()) {
            params["effort"] = json!(eff);
        }
        if let Some(ap) = approval_policy {
            params["approvalPolicy"] = json!(ap);
        }
        if let Some(sp) = sandbox_policy {
            params["sandboxPolicy"] = sp;
        }
        self.request("turn/start", params).await
    }

    pub async fn steer_turn(
        &self,
        thread_id: &str,
        expected_turn_id: Option<&str>,
        blocks: &[ContentBlock],
    ) -> Result<EngineSteerReceipt, EngineError> {
        let input = serialize_codex_input_items(blocks, PromptMode::Steer);
        let params =
            json!({ "threadId": thread_id, "expectedTurnId": expected_turn_id, "input": input });
        match self.request("turn/steer", params).await {
            Ok(result) => Ok(EngineSteerReceipt::Accepted {
                prompt_id: str_any(&result, &["turnId"])
                    .or_else(|| expected_turn_id.map(str::to_string)),
                session_id: Some(thread_id.to_string()),
                delivery_mode: "native".to_string(),
            }),
            Err(EngineError::Rpc { code, message }) => Ok(EngineSteerReceipt::Rejected {
                code: format!("rpc_{code}"),
                message,
            }),
            Err(other) => Err(other),
        }
    }

    pub async fn interrupt_turn(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), EngineError> {
        let _ = self
            .request(
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
            )
            .await?;
        Ok(())
    }

    pub async fn fork_thread(
        &self,
        source_thread_id: &str,
        new_thread_id: Option<&str>,
        before_turn_id: Option<&str>,
    ) -> Result<EngineForkReceipt, EngineError> {
        if let Some(cp) = before_turn_id
            && cp.trim().is_empty()
        {
            return Err(EngineError::InvalidRequest(
                "fork_session checkpoint_point (`beforeTurnId`) cannot be empty".to_string(),
            ));
        }

        let params = json!({
            "threadId": source_thread_id,
            "newThreadId": new_thread_id,
            "beforeTurnId": before_turn_id,
        });
        let result = self.request("thread/fork", params).await?;
        let forked_id = nested_or_str(&result, "thread", "id", "threadId")
            .or_else(|| new_thread_id.map(str::to_string))
            .ok_or_else(|| EngineError::Transport("thread/fork missing threadId".into()))?;
        self.mark_thread_loaded(&forked_id);

        let checkpoint_point = before_turn_id.map(str::to_string);
        self.publish_event(EngineEvent::SessionForked {
            source_session_id: source_thread_id.to_string(),
            session_id: forked_id.clone(),
            checkpoint_point: checkpoint_point.clone(),
        });
        Ok(EngineForkReceipt {
            source_session_id: source_thread_id.to_string(),
            forked_session_id: forked_id,
            checkpoint_point,
        })
    }

    pub async fn revert_thread(
        &self,
        thread_id: &str,
        before_turn_id: Option<&str>,
        turn_ordinal: i32,
    ) -> Result<(), EngineError> {
        if let Some(cp) = before_turn_id
            && cp.trim().is_empty()
        {
            return Err(EngineError::InvalidRequest(
                "revert_to `beforeTurnId` cannot be empty".to_string(),
            ));
        }
        if before_turn_id.is_none() && turn_ordinal <= 0 {
            return Err(EngineError::InvalidRequest(
                "revert_to requires a non-empty `beforeTurnId` or positive `turn_ordinal`"
                    .to_string(),
            ));
        }

        let params = json!({
            "threadId": thread_id,
            "beforeTurnId": before_turn_id,
            "turnOrdinal": turn_ordinal,
        });
        let _ = self.request("thread/rollback", params).await?;
        self.publish_event(EngineEvent::SessionReverted {
            session_id: thread_id.to_string(),
            checkpoint_point: before_turn_id.map(str::to_string),
        });
        Ok(())
    }

    pub async fn list_turns(
        &self,
        thread_id: &str,
        paginated: bool,
        before_turn_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<CodexTurnsPage, EngineError> {
        let params = json!({
            "threadId": thread_id,
            "paginated": paginated,
            "beforeTurnId": before_turn_id,
            "limit": limit,
        });
        let result = self.request("thread/turns/list", params).await?;
        let turns = result
            .get("turns")
            .or_else(|| result.get("data"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                Some(CodexTurnRecord {
                    turn_id: str_any(item, &["id", "turnId"])?,
                    status: str_any(item, &["status"]),
                    created_at: str_any(item, &["createdAt"]),
                })
            })
            .collect();

        let next_before_turn_id = str_any(&result, &["nextBeforeTurnId", "nextCursor"]);
        let has_more = result
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| next_before_turn_id.is_some());
        Ok(CodexTurnsPage {
            turns,
            next_before_turn_id,
            has_more,
        })
    }

    pub async fn list_models(&self) -> Vec<EngineModelInfo> {
        if let Ok(Ok(result)) = timeout(
            Duration::from_secs(3),
            self.request("model/list", json!({})),
        )
        .await
        {
            let parsed = parse_codex_models_response(&result);
            if !parsed.is_empty() {
                return parsed;
            }
        }
        default_codex_models()
    }

    pub async fn read_rate_limits(&self) -> Result<Option<EngineRateLimits>, EngineError> {
        let result = self.request("account/rateLimits/read", Value::Null).await?;
        let parsed = parse_codex_rate_limits_payload(&result);
        if let Some(ref limits) = parsed
            && let Ok(mut guard) = self.latest_rate_limits.write()
        {
            *guard = Some(limits.clone());
        }
        Ok(parsed)
    }

    pub async fn shutdown(&self) -> Result<(), EngineError> {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.process_job.lock()
            && let Some(job) = guard.take()
        {
            let _ = job.terminate();
        }
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_reader_loop<R>(
    reader: R,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>>,
    pending: Arc<Mutex<PendingRpcMap>>,
    server_requests: Arc<Mutex<PendingServerRequestMap>>,
    turn_router: TurnEventRouter,
    event_tx: broadcast::Sender<EngineEvent>,
    stderr_tail: Arc<StderrTail>,
    latest_rate_limits: Arc<RwLock<Option<EngineRateLimits>>>,
    compaction_states: Arc<RwLock<HashMap<String, CodexAutoCompactionThreadState>>>,
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
                let outcome = if let Some(err_val) = msg.get("error").filter(|v| !v.is_null()) {
                    let code = err_val
                        .get("code")
                        .and_then(Value::as_i64)
                        .unwrap_or(-32000);
                    let raw_msg = str_any(err_val, &["message"])
                        .or_else(|| err_val.as_str().map(str::to_string))
                        .unwrap_or_else(|| "Codex JSON-RPC error".to_string());
                    Err(EngineError::Rpc {
                        code,
                        message: format_bounded_diagnostic(
                            &raw_msg,
                            Some(&stderr_tail),
                            Some(mark),
                        ),
                    })
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            }
            continue;
        }

        if let (Some(id_val), Some(method_name)) = (raw_id, method) {
            let params = msg.get("params").unwrap_or(&Value::Null);
            if let Some((request_key, record, event)) =
                parse_codex_server_request(method_name, &id_val, params)
            {
                if let Ok(mut map) = server_requests.lock() {
                    map.insert(request_key, record);
                }
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

        if let Some(method_name) = method {
            let params = msg.get("params").unwrap_or(&Value::Null);
            for ev in normalize_codex_notification(
                method_name,
                params,
                &latest_rate_limits,
                &compaction_states,
            ) {
                turn_router.publish(&ev);
                let _ = event_tx.send(ev);
            }
        }
    }

    alive.store(false, Ordering::Release);
    if let Ok(mut map) = pending.lock() {
        for (_, (tx, mark)) in map.drain() {
            let _ = tx.send(Err(EngineError::Transport(format_bounded_diagnostic(
                "codex app-server exited",
                Some(&stderr_tail),
                Some(mark),
            ))));
        }
    }
    if let Ok(mut map) = server_requests.lock() {
        map.clear();
    }
    turn_router.fail_active_turns("codex app-server exited", &stderr_tail);
}

pub async fn resolve_codex_binary(spec: &EngineStartSpec) -> Result<PathBuf, EngineError> {
    if let Some(val) = spec
        .env
        .get("DIMO_CODEX_PATH")
        .map(String::as_str)
        .map(str::trim)
        && !val.is_empty()
    {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
        return Err(EngineError::BinaryNotFound(format!(
            "DIMO_CODEX_PATH `{val}` not found"
        )));
    }
    if let Some(val) = std::env::var_os("DIMO_CODEX_PATH").filter(|s| !s.is_empty()) {
        let p = PathBuf::from(&val);
        if p.is_file() {
            return Ok(p);
        }
        return Err(EngineError::BinaryNotFound(format!(
            "DIMO_CODEX_PATH `{}` not found",
            val.to_string_lossy()
        )));
    }
    let key = "CODEX_PATH";
    if let Some(val) = spec.env.get(key).map(String::as_str).map(str::trim)
        && !val.is_empty()
    {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Some(val) = std::env::var_os(key).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
    }

    let bins: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd"]
    } else {
        &["codex"]
    };

    if let Some(spec_path) = spec.env.get("PATH").or_else(|| spec.env.get("Path")) {
        for dir in std::env::split_paths(spec_path) {
            for name in bins {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    for name in bins {
        if let Some(found) = workspace_utils::shell::resolve_executable_path(name).await {
            return Ok(found);
        }
    }

    let home = spec
        .env
        .get("USERPROFILE")
        .or_else(|| spec.env.get("HOME"))
        .cloned()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok());
    let mut fallback_dirs = Vec::new();
    if let Some(h) = home {
        fallback_dirs.push(PathBuf::from(h).join(".local/bin"));
    }
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            fallback_dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            fallback_dirs.push(PathBuf::from(local).join("Programs/OpenAI/Codex/bin"));
        }
    }
    for dir in fallback_dirs {
        for name in bins {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(EngineError::BinaryNotFound("codex CLI not found".into()))
}

struct CodexHandleContext {
    spec: EngineStartSpec,
    server: Arc<CodexAppServer>,
    active_prompt_id: RwLock<Option<Uuid>>,
    active_turn_id: RwLock<Option<String>>,
}

/// `NativeEngineDriver` implementation backed by `CodexAppServer`.
#[derive(Default)]
pub struct CodexNativeDriver {
    handles: RwLock<HashMap<Uuid, Arc<CodexHandleContext>>>,
}

impl CodexNativeDriver {
    pub fn new() -> Self {
        Self::default()
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
        let tail = stderr_tail.unwrap_or_else(|| Arc::new(StderrTail::new()));
        let server = CodexAppServer::connect_over_io_with_stderr(
            spec.workspace_id,
            reader,
            writer,
            None,
            None,
            tail,
        );
        server.handshake().await?;
        let driver = Self::new();
        let handle = driver.bind_existing_server(spec, server, None);
        Ok((driver, handle))
    }

    pub fn bind_existing_server(
        &self,
        spec: EngineStartSpec,
        server: Arc<CodexAppServer>,
        initial_thread_id: Option<String>,
    ) -> EngineHandle {
        let connection_id = Uuid::new_v4();
        let official = !spec.uses_custom_base_url(NativeEngineKind::CodexNative);
        let clean_initial = initial_thread_id.filter(|s| !is_placeholder_engine_session_id(s));
        let handle = EngineHandle::new(
            connection_id,
            NativeEngineKind::CodexNative,
            spec.workspace_id,
            spec.working_dir.clone(),
            official,
            clean_initial,
        );
        let ctx = Arc::new(CodexHandleContext {
            spec,
            server,
            active_prompt_id: RwLock::new(None),
            active_turn_id: RwLock::new(None),
        });
        if let Ok(mut map) = self.handles.write() {
            map.insert(connection_id, ctx);
        }
        handle
    }

    async fn ensure_server_for_handle(
        &self,
        handle: &EngineHandle,
    ) -> Result<(Arc<CodexHandleContext>, Arc<CodexAppServer>), EngineError> {
        let ctx = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())
            .ok_or(EngineError::UnknownHandle(handle.connection_id))?;

        if ctx.server.is_alive() {
            return Ok((Arc::clone(&ctx), Arc::clone(&ctx.server)));
        }

        let reconnected = get_or_spawn_workspace_server(&ctx.spec).await?;
        // Preserve in-flight turn identity across reconnection so that steer /
        // interrupt issued immediately after auto-reconnect can still find the
        // active prompt/turn IDs and reach the new server.
        let preserved_prompt_id = ctx.active_prompt_id.read().ok().and_then(|g| *g);
        let preserved_turn_id = ctx.active_turn_id.read().ok().and_then(|g| g.clone());
        let updated_ctx = Arc::new(CodexHandleContext {
            spec: ctx.spec.clone(),
            server: Arc::clone(&reconnected),
            active_prompt_id: RwLock::new(preserved_prompt_id),
            active_turn_id: RwLock::new(preserved_turn_id),
        });
        if let Ok(mut map) = self.handles.write() {
            map.insert(handle.connection_id, Arc::clone(&updated_ctx));
        }
        Ok((updated_ctx, reconnected))
    }

    pub async fn list_thread_turns(
        &self,
        handle: &EngineHandle,
        paginated: bool,
        before_turn_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<CodexTurnsPage, EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle).await?;
        let thread_id = handle
            .external_session_id()
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest("handle has no bound Codex threadId".to_string())
            })?;
        server
            .list_turns(&thread_id, paginated, before_turn_id, limit)
            .await
    }
}

async fn get_or_spawn_workspace_server(
    spec: &EngineStartSpec,
) -> Result<Arc<CodexAppServer>, EngineError> {
    let key = CodexServerCacheKey::from_spec(spec);
    if let Some(existing) = global_codex_servers().read().await.get(&key)
        && existing.is_alive()
    {
        return Ok(Arc::clone(existing));
    }
    let mut write_guard = global_codex_servers().write().await;
    if let Some(existing) = write_guard.get(&key)
        && existing.is_alive()
    {
        return Ok(Arc::clone(existing));
    }
    // Sweep any dead entries across keys before spawning so exited or rotated
    // workspace servers do not stay pinned in the global pool.
    write_guard.retain(|_, server| server.is_alive());
    let spawned = CodexAppServer::spawn_for_workspace(spec).await?;
    write_guard.insert(key, Arc::clone(&spawned));
    Ok(spawned)
}

#[async_trait]
impl NativeEngineDriver for CodexNativeDriver {
    fn engine_id(&self) -> &str {
        NativeEngineKind::CodexNative.engine_id()
    }

    fn kind(&self) -> Option<NativeEngineKind> {
        Some(NativeEngineKind::CodexNative)
    }

    fn supports_agent(&self, agent_kind_or_id: &str) -> bool {
        matches!(
            normalize_agent_token(agent_kind_or_id).as_str(),
            "codex" | "codex_native" | "openai_codex" | "codex_cli"
        )
    }

    fn capabilities(&self) -> EngineCapabilities {
        codex_capabilities(self.engine_id())
    }

    fn normalize_mode(&self, raw: &str) -> Option<String> {
        codex_normalize_mode(raw)
    }

    fn resolve_auth(&self, env: &HashMap<String, String>) -> EngineAuth {
        resolve_codex_auth(env)
    }

    fn prepare_launch_env(
        &self,
        locked_program: &Path,
        snapshot_env: &HashMap<String, String>,
        launch_env: &mut HashMap<String, String>,
        scrubbed_keys: &mut Vec<String>,
    ) {
        prepare_codex_launch_env(locked_program, snapshot_env, launch_env, scrubbed_keys);
    }

    fn profile_isolation_dir(&self) -> Option<(&'static str, &'static str)> {
        Some(("CODEX_HOME", "codex-home"))
    }

    fn uses_custom_base_url(&self, spec: &EngineStartSpec) -> bool {
        spec.uses_custom_base_url(NativeEngineKind::CodexNative)
    }

    fn resolve_default_model(&self, env: &HashMap<String, String>) -> Option<String> {
        resolve_codex_default_model(env)
    }

    fn accepts_model_id(&self, model_id: &str, env: &HashMap<String, String>) -> bool {
        codex_accepts_model_id(model_id, env)
    }

    async fn invalidate_caches(&self) -> usize {
        invalidate_codex_servers().await
    }

    async fn start(&self, spec: EngineStartSpec) -> Result<EngineHandle, EngineError> {
        let server = get_or_spawn_workspace_server(&spec).await?;
        Ok(self.bind_existing_server(spec, server, None))
    }

    async fn send_prompt(
        &self,
        handle: &EngineHandle,
        request: EnginePromptRequest,
    ) -> Result<EngineEventStream, EngineError> {
        let (ctx, server) = self.ensure_server_for_handle(handle).await?;

        let requested = request
            .session_id
            .clone()
            .or_else(|| handle.external_session_id());
        let effective_model = request.model.as_deref().or(ctx.spec.model.as_deref());
        let effective_mcp = request.mcp_servers.as_ref().or(Some(&ctx.spec.mcp_servers));
        let effective_dirs = if request.additional_directories.is_empty() {
            &ctx.spec.additional_directories
        } else {
            &request.additional_directories
        };

        let (thread_id, session_init_event) = server
            .ensure_thread(
                requested.as_deref(),
                effective_model,
                &ctx.spec.working_dir,
                effective_mcp,
                request.permission_mode.as_deref(),
            )
            .await?;
        handle.set_external_session_id(Some(thread_id.clone()));

        let turn_stream = server.turn_router().register_turn(
            TurnRouteFilter::CodexThread {
                thread_id: thread_id.clone(),
            },
            Arc::clone(server.stderr_tail()),
        );

        if let Some(init_ev) = session_init_event {
            server.publish_event(init_ev);
        }

        if let Ok(mut pid_guard) = ctx.active_prompt_id.write() {
            *pid_guard = Some(request.prompt_id);
        }
        let start_res = server
            .start_turn(
                &thread_id,
                request.prompt_id,
                &request.blocks,
                effective_model,
                request.effort.as_deref(),
                request.permission_mode.as_deref(),
                &ctx.spec.working_dir,
                effective_dirs,
                request.mode,
            )
            .await?;
        if let Ok(mut guard) = ctx.active_turn_id.write() {
            *guard = nested_or_str(&start_res, "turn", "id", "turnId");
        }

        Ok(Box::pin(turn_stream))
    }

    async fn steer(
        &self,
        handle: &EngineHandle,
        request: EngineSteerRequest,
    ) -> Result<EngineSteerReceipt, EngineError> {
        let (ctx, server) = self.ensure_server_for_handle(handle).await?;
        let thread_id = request
            .session_id
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest("cannot steer without active Codex threadId".into())
            })?;

        let active_pid = ctx.active_prompt_id.read().ok().and_then(|g| *g);
        if let (Some(expected_pid), Some(current_pid)) = (request.expected_prompt_id, active_pid)
            && expected_pid != current_pid
        {
            return Ok(EngineSteerReceipt::Rejected {
                code: "turn_mismatch".to_string(),
                message: format!(
                    "expected prompt `{expected_pid}` does not match active prompt `{current_pid}`"
                ),
            });
        }

        let actual_turn_id = ctx.active_turn_id.read().ok().and_then(|g| g.clone());
        let receipt = server
            .steer_turn(&thread_id, actual_turn_id.as_deref(), &request.blocks)
            .await?;
        if matches!(receipt, EngineSteerReceipt::Accepted { .. }) {
            server.publish_event(EngineEvent::PromptSteered {
                prompt_id: active_pid.map(|id| id.to_string()),
                session_id: Some(thread_id),
            });
        }
        Ok(receipt)
    }

    async fn interrupt(&self, handle: &EngineHandle) -> Result<(), EngineError> {
        let (ctx, server) = self.ensure_server_for_handle(handle).await?;
        let Some(thread_id) = handle
            .external_session_id()
            .filter(|s| !is_placeholder_engine_session_id(s))
        else {
            return Ok(());
        };
        let turn_id = ctx.active_turn_id.read().ok().and_then(|g| g.clone());
        server.interrupt_turn(&thread_id, turn_id.as_deref()).await
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
                "fork_session checkpoint_point cannot be empty".into(),
            ));
        }
        let (_, server) = self.ensure_server_for_handle(handle).await?;
        let source = request
            .source_session_id
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest("fork_session requires a source Codex threadId".into())
            })?;
        server
            .fork_thread(
                &source,
                request.new_session_id.as_deref(),
                request.checkpoint_point.as_deref(),
            )
            .await
    }

    async fn revert_to(
        &self,
        handle: &EngineHandle,
        checkpoint: EngineCheckpoint,
    ) -> Result<(), EngineError> {
        if let Some(ref cp) = checkpoint.external_session_point
            && cp.trim().is_empty()
        {
            return Err(EngineError::InvalidRequest(
                "revert_to external_session_point cannot be empty".into(),
            ));
        }
        let (_, server) = self.ensure_server_for_handle(handle).await?;
        let thread_id = checkpoint
            .session_id
            .or_else(|| handle.external_session_id())
            .filter(|s| !is_placeholder_engine_session_id(s))
            .ok_or_else(|| {
                EngineError::InvalidRequest("revert_to requires a bound Codex threadId".into())
            })?;
        let before = checkpoint.external_session_point.as_deref();
        server
            .revert_thread(&thread_id, before, checkpoint.turn_ordinal)
            .await
    }

    async fn respond_permission(
        &self,
        handle: &EngineHandle,
        decision: EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle).await?;
        server.respond_server_request(&decision).await
    }

    async fn respond_question(
        &self,
        handle: &EngineHandle,
        request_id: &str,
        answers: Value,
        cancelled: bool,
    ) -> Result<(), EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle).await?;
        server
            .respond_question_request(request_id, &answers, cancelled)
            .await
    }

    async fn list_models(
        &self,
        handle: &EngineHandle,
    ) -> Result<Vec<EngineModelInfo>, EngineError> {
        let (_, server) = self.ensure_server_for_handle(handle).await?;
        Ok(server.list_models().await)
    }

    fn rate_limits(&self, handle: &EngineHandle) -> Option<EngineRateLimits> {
        let ctx = self
            .handles
            .read()
            .ok()
            .and_then(|map| map.get(&handle.connection_id).cloned())?;
        ctx.server.latest_rate_limits()
    }

    fn cache_status(&self, _handle: &EngineHandle) -> Option<EngineCacheStatus> {
        None
    }

    async fn shutdown(&self, handle: EngineHandle) -> Result<(), EngineError> {
        let removed = self
            .handles
            .write()
            .ok()
            .and_then(|mut map| map.remove(&handle.connection_id));
        if let Some(ctx) = removed {
            let should_shutdown = {
                let mut guard = global_codex_servers().write().await;
                let matching_key = guard.iter().find_map(|(k, cached)| {
                    (Arc::ptr_eq(cached, &ctx.server) && Arc::strong_count(&ctx.server) <= 2)
                        .then(|| k.clone())
                });
                if let Some(key) = matching_key {
                    guard.remove(&key);
                    true
                } else {
                    !guard
                        .values()
                        .any(|cached| Arc::ptr_eq(cached, &ctx.server))
                        && Arc::strong_count(&ctx.server) <= 1
                }
            };
            if should_shutdown {
                let _ = ctx.server.shutdown().await;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
