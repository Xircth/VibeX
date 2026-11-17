//! `dimo-mcp` — the per-launch companion MCP server.
//!
//! A capable parent ACP agent launches this as a stdio MCP server,
//! injected via the ACP `session/new` `mcp_servers` parameter with
//! `--parent-connection-id`, `--socket-path`, `--token`, and `--features`. It
//! exposes the delegation + steering tools and bridges each `tools/call` to the
//! in-app `delegation` broker over the socket.
//!
//! `tools/call` requests run concurrently so a blocking `get_delegation_status`
//! wait can't stall cancellation. An MCP `notifications/cancelled` aborts the
//! in-flight call (suppressing its response, per spec) and best-effort tells the
//! broker to cancel the delegation. Parent death is detected by stdin EOF, which
//! drains every in-flight call before exit.

mod client;
mod pulse;
mod pulse_bridge;
mod pulse_eval;
mod render;
mod workflow;
mod workflow_patch;
mod workflow_presets;

pub(crate) use render::render_result;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use delegation_proto::{
    BrokerAskRequest, BrokerCancelRequest, BrokerCancelTaskRequest, BrokerCollaborateRequest,
    BrokerCommitFeedbackRequest, BrokerFeedbackRequest, BrokerMessage, BrokerRequest,
    BrokerSessionCancelRequest, BrokerSessionRequest, BrokerSessionSendRequest,
    BrokerSessionWaitRequest, BrokerStatusRequest,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, oneshot},
};
use uuid::Uuid;

const TOOL_SCHEMA: &str = include_str!("../tool_schema.json");
const CALL_ROUNDTRIP_TIMEOUT: Duration = Duration::from_secs(8);
static HANDLE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Parsed launch arguments.
struct Args {
    parent_connection_id: String,
    socket_path: String,
    token: String,
    features: CompanionFeatures,
    server_url: Option<String>,
    server_token: Option<String>,
    conversation_id: Option<String>,
    workspace_root: Option<PathBuf>,
    product: String,
}

/// Which tool groups this companion exposes (from `--features`).
struct CompanionFeatures {
    delegation: bool,
    feedback: bool,
    ask: bool,
    session_info: bool,
    session_control: bool,
    collaboration: bool,
    space: bool,
    pulse: bool,
    workflow: bool,
}

impl CompanionFeatures {
    /// Parse a comma-joined feature list. Absent → delegation only (backward
    /// compatible with parents that don't pass `--features`).
    fn parse(raw: Option<&str>) -> Self {
        match raw {
            None => Self {
                delegation: true,
                feedback: false,
                ask: false,
                session_info: false,
                session_control: false,
                collaboration: false,
                space: false,
                pulse: false,
                workflow: false,
            },
            Some(value) => {
                let has = |name: &str| value.split(',').any(|f| f.trim() == name);
                Self {
                    delegation: has("delegation"),
                    feedback: has("feedback"),
                    ask: has("ask"),
                    session_info: has("sessions"),
                    session_control: has("session-control"),
                    collaboration: has("collaboration"),
                    space: has("space"),
                    pulse: has("pulse") || has("automation"),
                    workflow: has("workflow"),
                }
            }
        }
    }

    fn allows_tool(&self, name: &str) -> bool {
        match name {
            "delegate_to_agent" | "get_delegation_status" | "cancel_delegation" => self.delegation,
            "check_user_feedback" => self.feedback,
            "ask_user_question" => self.ask || self.collaboration,
            "get_session_info" | "thread_read_history" => {
                self.session_info || self.collaboration
            }
            "send_session_input" => self.session_control || self.collaboration,
            "cancel_session_turn" | "wait_for_session" => self.session_control,
            "list_conversations" | "create_conversation" | "list_spaces" | "manage_bot" => {
                self.collaboration
            }
            "read_space_messages"
            | "post_space_message"
            | "manage_group"
            | "request_approval"
            | "memory_search"
            | "memory_write" => self.collaboration && self.space,
            other if pulse::is_pulse_tool(other) => self.pulse,
            other if workflow::is_workflow_tool(other) => self.workflow,
            _ => false,
        }
    }
}

fn parent_tool_use_id(meta: Option<&Value>) -> String {
    let Some(meta) = meta else {
        return String::new();
    };
    for key in [
        "tool_use_id",
        "toolCallId",
        "tool_call_id",
        "progressToken",
        "progress_token",
    ] {
        if let Some(value) = meta.get(key) {
            if let Some(text) = value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return text.to_string();
            }
            if let Some(number) = value.as_i64() {
                return number.to_string();
            }
            if let Some(number) = value.as_u64() {
                return number.to_string();
            }
        }
    }
    String::new()
}

fn request_id_seed(request_id: Option<&Value>) -> String {
    let Some(value) = request_id else {
        return String::new();
    };
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_string();
    }
    if let Some(number) = value.as_i64() {
        return number.to_string();
    }
    if let Some(number) = value.as_u64() {
        return number.to_string();
    }
    String::new()
}

fn collaboration_needs_operation_id(name: &str, arguments: &Value) -> bool {
    if name == "manage_bot"
        && matches!(
            arguments
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim),
            Some("list_agents" | "list_options")
        )
    {
        return false;
    }
    matches!(
        name,
        "create_conversation"
            | "post_space_message"
            | "post_to_space"
            | "manage_bot"
            | "manage_group"
            | "request_approval"
            | "create_role"
            | "update_role"
            | "delete_role"
            | "create_team"
            | "update_team"
            | "delete_team"
            | "create_collaboration_space"
            | "add_space_member"
            | "create_space_member"
            | "set_space_identity"
            | "set_space_lead"
            | "leave_space"
            | "remove_space_member"
            | "delete_space_member"
            | "delete_collaboration_space"
            | "interrupt_space_turn"
            | "handoff"
            | "ask_person"
            | "resolve_card"
            | "add_to_space_collection"
            | "remove_space_collection_item"
            | "memory_write"
    )
}

#[cfg(test)]
fn ensure_operation_id(arguments: &mut Value, meta: Option<&Value>, request_id: Option<&Value>) {
    if arguments
        .get("operation_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    let seed = parent_tool_use_id(meta);
    let derived = if !seed.is_empty() {
        Uuid::new_v5(&Uuid::NAMESPACE_URL, seed.as_bytes())
    } else {
        let request_seed = request_id_seed(request_id);
        if !request_seed.is_empty() {
            Uuid::new_v5(&Uuid::NAMESPACE_URL, request_seed.as_bytes())
        } else {
            Uuid::new_v4()
        }
    };
    if let Some(object) = arguments.as_object_mut() {
        object.insert("operation_id".into(), json!(derived.to_string()));
    }
}

fn parse_args() -> Result<Args, String> {
    let mut parent_connection_id = None;
    let mut socket_path = None;
    let mut token = None;
    let mut features = None;
    let mut server_url = None;
    let mut server_token = None;
    let mut conversation_id = None;
    let mut workspace_root = None;
    let mut product = None;

    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        let mut take = || {
            argv.next()
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match flag.as_str() {
            "--parent-connection-id" => parent_connection_id = Some(take()?),
            "--socket-path" => socket_path = Some(take()?),
            "--token" => token = Some(take()?),
            "--features" => features = Some(take()?),
            "--server-url" => server_url = Some(take()?),
            "--server-token" => server_token = Some(take()?),
            "--conversation-id" => conversation_id = Some(take()?),
            "--workspace-root" => {
                let raw = take()?;
                if !raw.trim().is_empty() {
                    workspace_root = Some(PathBuf::from(raw));
                }
            }
            "--product" => product = Some(take()?),
            // Accepted for forward-compat; parent death is detected via stdin EOF.
            "--parent-pid" => {
                let _ = take()?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let resolved_product = product.unwrap_or_else(|| "delegation".to_string());
    let mut parsed_features = CompanionFeatures::parse(features.as_deref());
    match resolved_product.as_str() {
        "pulse" => parsed_features.pulse = true,
        "workflow" => parsed_features.workflow = true,
        "superagent" => {
            parsed_features.pulse = true;
            parsed_features.workflow = true;
        }
        _ => {}
    }

    Ok(Args {
        parent_connection_id: parent_connection_id.unwrap_or_default(),
        socket_path: socket_path.unwrap_or_default(),
        token: token
            .or_else(|| server_token.clone())
            .ok_or("missing --token or --server-token")?,
        features: parsed_features,
        server_url,
        server_token,
        conversation_id: resolve_conversation_id(conversation_id),
        workspace_root,
        product: resolved_product,
    })
}

/// Tool schemas this companion advertises, filtered by enabled features.
fn enabled_tools(features: &CompanionFeatures) -> Vec<Value> {
    let mut all: Vec<Value> =
        serde_json::from_str(TOOL_SCHEMA).expect("embedded tool schema is valid");
    all.extend(pulse::pulse_tool_schemas());
    all.extend(workflow::workflow_tool_schemas());
    all.into_iter()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(|name| features.allows_tool(name))
                .unwrap_or(false)
        })
        .collect()
}

/// What to do with one parsed input line.
enum LineAction {
    /// Write this serialized response and continue.
    Respond(String),
    /// Spawn a concurrent `tools/call`.
    Call {
        id: Option<Value>,
        name: String,
        arguments: Value,
        meta: Option<Value>,
    },
    /// MCP `notifications/cancelled` targeting an in-flight request.
    Cancel { request_id: Option<Value> },
    /// Notification / unparseable / nothing to do.
    Ignore,
}

/// A `tools/call` in flight: its broker cancel handle (for delegations) and a
/// signal to abort the in-flight broker round-trip.
struct InflightEntry {
    external_handle: Option<String>,
    cancel: oneshot::Sender<()>,
}

#[derive(Default)]
struct Inflight {
    entries: Mutex<HashMap<String, InflightEntry>>,
}

impl Inflight {
    async fn insert(&self, key: String, entry: InflightEntry) {
        self.entries.lock().await.insert(key, entry);
    }

    async fn take(&self, key: &str) -> Option<InflightEntry> {
        self.entries.lock().await.remove(key)
    }

    async fn drain(&self) -> Vec<InflightEntry> {
        self.entries.lock().await.drain().map(|(_, v)| v).collect()
    }
}

struct Companion {
    parent_connection_id: String,
    socket_path: String,
    token: String,
    features: CompanionFeatures,
    tools: Vec<Value>,
    server_url: Option<String>,
    server_token: Option<String>,
    conversation_id: Option<String>,
    workspace_root: Option<PathBuf>,
    product: String,
    instance_id: Uuid,
    operation_seq: AtomicU64,
    pulse_state: pulse::PulseState,
}

impl Companion {
    fn new(mut args: Args) -> Self {
        match args.product.as_str() {
            "pulse" => args.features.pulse = true,
            "workflow" => args.features.workflow = true,
            "superagent" => {
                args.features.pulse = true;
                args.features.workflow = true;
            }
            _ => {}
        }
        let tools = enabled_tools(&args.features);
        Self {
            parent_connection_id: args.parent_connection_id,
            socket_path: args.socket_path,
            token: args.token,
            features: args.features,
            tools,
            server_url: args.server_url,
            server_token: args.server_token,
            conversation_id: args.conversation_id,
            workspace_root: args.workspace_root,
            product: args.product,
            instance_id: Uuid::new_v4(),
            operation_seq: AtomicU64::new(0),
            pulse_state: pulse::PulseState::new(),
        }
    }

    fn ensure_call_operation_id(
        &self,
        name: &str,
        arguments: &mut Value,
        meta: Option<&Value>,
        request_id: Option<&Value>,
    ) {
        if arguments
            .get("operation_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return;
        }
        let seq = self.operation_seq.fetch_add(1, Ordering::Relaxed);
        let tool_seed = parent_tool_use_id(meta);
        let request_seed = request_id_seed(request_id);
        let scope = if !self.token.trim().is_empty() {
            self.token.as_str()
        } else if !self.parent_connection_id.trim().is_empty() {
            self.parent_connection_id.as_str()
        } else {
            self.conversation_id.as_deref().unwrap_or("")
        };
        let composite = format!(
            "{}:{}:{}:{}:{}:{}",
            self.instance_id, scope, name, seq, tool_seed, request_seed
        );
        let derived = Uuid::new_v5(&Uuid::NAMESPACE_URL, composite.as_bytes());
        if let Some(object) = arguments.as_object_mut() {
            object.insert("operation_id".into(), json!(derived.to_string()));
        }
    }

    pub(crate) fn uses_http(&self) -> bool {
        self.server_url
            .as_ref()
            .is_some_and(|url| !url.trim().is_empty())
    }

    pub(crate) fn uses_socket(&self) -> bool {
        !self.uses_http() && !self.socket_path.trim().is_empty()
    }

    pub(crate) fn uses_host(&self) -> bool {
        self.uses_http() || self.uses_socket()
    }

    fn effective_bearer_token(&self) -> Option<&str> {
        self.server_token
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| (!self.token.trim().is_empty()).then_some(self.token.as_str()))
    }

    async fn send(
        &self,
        message: &delegation_proto::BrokerMessage,
    ) -> std::io::Result<delegation_proto::BrokerResponse> {
        if self.uses_http() {
            client::call_http(
                self.server_url.as_deref().unwrap_or_default(),
                self.server_token.as_deref(),
                self.conversation_id.as_deref(),
                &self.product,
                message,
            )
            .await
        } else {
            client::call_broker(&self.socket_path, message).await
        }
    }

    /// Classify one JSON-RPC line into the action the main loop should take.
    fn classify(&self, value: &Value) -> LineAction {
        let id = value.get("id").cloned();
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return LineAction::Ignore;
        };
        let params = value.get("params");
        match method {
            "initialize" => respond(id, initialize_result(params, &self.product))
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "server/discover" => respond(id, discover_result(&self.product))
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "ping" => respond(id, modernize_result(params, json!({}), &self.product))
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "tools/list" => respond(
                id,
                modernize_result(params, json!({ "tools": self.tools }), &self.product),
            )
            .map(LineAction::Respond)
            .unwrap_or(LineAction::Ignore),
            "tools/call" => match (id, params) {
                (Some(id), Some(params)) => LineAction::Call {
                    id: Some(id),
                    name: params
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    arguments: params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                    meta: params.get("_meta").cloned(),
                },
                _ => LineAction::Ignore,
            },
            "notifications/cancelled" => LineAction::Cancel {
                request_id: params.and_then(|p| p.get("requestId")).cloned(),
            },
            _ if method.starts_with("notifications/") => LineAction::Ignore,
            other => respond_error(id, -32601, &format!("method not found: {other}"))
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
        }
    }

    pub(crate) async fn execute_pulse_call(
        &self,
        name: &str,
        mut arguments: Value,
        meta: Option<&Value>,
        id: Option<&Value>,
        env_mandate_override: Option<&str>,
    ) -> Result<Value, String> {
        self.ensure_call_operation_id(name, &mut arguments, meta, id);
        let mut outcome = if self.uses_host() {
            pulse_bridge::execute_host_pulse_tool(
                self,
                name,
                &arguments,
                meta,
                env_mandate_override,
            )
            .await?
        } else {
            self.pulse_state
                .execute_tool(name, &arguments, meta, env_mandate_override)?
        };
        pulse::redact_secrets(&mut outcome);
        Ok(outcome)
    }

    async fn run_pulse_call(
        &self,
        id: Option<Value>,
        name: &str,
        arguments: Value,
        meta: Option<Value>,
        stdout: &Arc<Mutex<tokio::io::Stdout>>,
    ) {
        let final_outcome = match self
            .execute_pulse_call(name, arguments, meta.as_ref(), id.as_ref(), None)
            .await
        {
            Ok(outcome) => outcome,
            Err(err) => {
                write_opt(stdout, respond_error(id, -32602, &err)).await;
                return;
            }
        };

        write_opt(
            stdout,
            respond(
                id,
                modernize_result(
                    meta.as_ref(),
                    render_result(&final_outcome),
                    &self.product,
                ),
            ),
        )
        .await;
    }

    pub(crate) async fn execute_workflow_call(
        &self,
        name: &str,
        mut arguments: Value,
        meta: Option<&Value>,
        id: Option<&Value>,
    ) -> Result<Value, String> {
        self.ensure_call_operation_id(name, &mut arguments, meta, id);
        workflow::execute_workflow_tool(self, name, &arguments, self.workspace_root.as_deref())
            .await
    }

    async fn run_workflow_call(
        &self,
        id: Option<Value>,
        name: &str,
        arguments: Value,
        meta: Option<Value>,
        stdout: &Arc<Mutex<tokio::io::Stdout>>,
    ) {
        let final_outcome = match self
            .execute_workflow_call(name, arguments, meta.as_ref(), id.as_ref())
            .await
        {
            Ok(outcome) => outcome,
            Err(err) => {
                write_opt(stdout, respond_error(id, -32602, &err)).await;
                return;
            }
        };

        write_opt(
            stdout,
            respond(
                id,
                modernize_result(
                    meta.as_ref(),
                    render_result(&final_outcome),
                    &self.product,
                ),
            ),
        )
        .await;
    }

    /// Run a `tools/call`, racing the broker round-trip against cancellation.
    /// Writes its own response (or suppresses it on cancel).
    async fn run_call(
        self: &Arc<Self>,
        id: Option<Value>,
        name: String,
        arguments: Value,
        meta: Option<Value>,
        inflight: Arc<Inflight>,
        stdout: Arc<Mutex<tokio::io::Stdout>>,
    ) {
        if !self.features.allows_tool(&name) {
            write_opt(
                &stdout,
                respond_error(id, -32601, &format!("tool not available: {name}")),
            )
            .await;
            return;
        }
        if pulse::is_pulse_tool(&name) {
            self.run_pulse_call(id, &name, arguments, meta, &stdout)
                .await;
            return;
        }
        if workflow::is_workflow_tool(&name) {
            self.run_workflow_call(id, &name, arguments, meta, &stdout)
                .await;
            return;
        }
        let mut arguments = arguments;
        if collaboration_needs_operation_id(&name, &arguments) {
            self.ensure_call_operation_id(&name, &mut arguments, meta.as_ref(), id.as_ref());
        }
        let message = match self.build_message(&name, &arguments, meta.as_ref()) {
            Ok(message) => message,
            Err(err) => {
                write_opt(&stdout, respond_error(id, -32602, &err)).await;
                return;
            }
        };

        let external_handle = match &message {
            BrokerMessage::Call(req) => req.external_handle.clone(),
            _ => None,
        };
        let Some(key) = id_key(&id) else {
            // No request id → nothing to answer or track. classify() never emits a
            // Call without an id, so this is defensive: do NOT fire an untracked
            // broker call (which would spawn an unobservable, uncancelable child).
            return;
        };

        let (cancel_tx, cancel_rx) = oneshot::channel();
        inflight
            .insert(
                key.clone(),
                InflightEntry {
                    external_handle,
                    cancel: cancel_tx,
                },
            )
            .await;

        let outcome = tokio::select! {
            biased;
            _ = cancel_rx => None, // canceled: suppress response per MCP spec
            result = self.send(&message) => Some(result),
            _ = tokio::time::sleep(CALL_ROUNDTRIP_TIMEOUT), if name == "delegate_to_agent" => {
                Some(Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "delegate_to_agent timed out waiting for the host; the child may still start",
                )))
            }
        };
        inflight.take(&key).await;

        match outcome {
            None => {}
            Some(Ok(response)) => {
                let outcome = response.into_outcome();
                let feedback_ids = if name == "check_user_feedback" {
                    outcome["feedback"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|note| note["id"].as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
                let relayed = write_opt(
                    &stdout,
                    respond(
                        id,
                        modernize_result(meta.as_ref(), render_result(&outcome), &self.product),
                    ),
                )
                .await;
                if relayed && !feedback_ids.is_empty() {
                    let _ = self
                        .send(&BrokerMessage::CommitFeedback(
                            BrokerCommitFeedbackRequest {
                                token: self.token.clone(),
                                ids: feedback_ids,
                            },
                        ))
                        .await;
                }
            }
            Some(Err(err)) => {
                write_opt(
                    &stdout,
                    respond_error(id, -32603, &format!("broker unavailable: {err}")),
                )
                .await;
            }
        }
    }

    fn build_message(
        &self,
        name: &str,
        arguments: &Value,
        meta: Option<&Value>,
    ) -> Result<BrokerMessage, String> {
        let token = self.token.clone();
        match name {
            "delegate_to_agent" => Ok(BrokerMessage::Call(BrokerRequest {
                token,
                parent_connection_id: self.parent_connection_id.clone(),
                parent_tool_use_id: parent_tool_use_id(meta),
                external_handle: Some(next_handle()),
                input: arguments.clone(),
            })),
            "get_delegation_status" => {
                let task_ids = arguments
                    .get("task_ids")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if task_ids.is_empty() {
                    return Err("task_ids must be a non-empty array".to_string());
                }
                Ok(BrokerMessage::Status(BrokerStatusRequest {
                    token,
                    task_ids,
                    wait_ms: arguments.get("wait_ms").and_then(Value::as_u64),
                }))
            }
            "cancel_delegation" => {
                let task_id = arguments
                    .get("task_id")
                    .and_then(Value::as_str)
                    .ok_or("task_id is required")?
                    .to_string();
                Ok(BrokerMessage::CancelTask(BrokerCancelTaskRequest {
                    token,
                    task_id,
                }))
            }
            "check_user_feedback" => Ok(BrokerMessage::Feedback(BrokerFeedbackRequest { token })),
            "ask_user_question" => {
                let questions = delegation_proto::parse_questions(arguments)?;
                Ok(BrokerMessage::Ask(BrokerAskRequest { token, questions }))
            }
            "get_session_info" => {
                let conversation_id = arguments
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let max_messages = arguments
                    .get("max_messages")
                    .and_then(Value::as_u64)
                    .unwrap_or(20)
                    .min(200) as u32;
                Ok(BrokerMessage::SessionInfo(BrokerSessionRequest {
                    token,
                    conversation_id,
                    max_messages,
                    history: serde_json::from_value(arguments.clone())
                        .map_err(|error| error.to_string())?,
                }))
            }
            "thread_read_history" => {
                let conversation_id = arguments
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let item_ids: Vec<String> = arguments
                    .get("item_ids")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if item_ids.is_empty() {
                    return Err("item_ids must contain at least one non-empty ID".to_string());
                }
                Ok(BrokerMessage::SessionInfo(BrokerSessionRequest {
                    token,
                    conversation_id,
                    max_messages: 0,
                    history: delegation_proto::SessionHistoryRequest {
                        item_ids,
                        ..Default::default()
                    },
                }))
            }
            "send_session_input" => {
                let optional = |key: &str| {
                    arguments
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                };
                let member_id = optional("member_id");
                let thread_id = optional("thread_id");
                let conversation_id = match (&member_id, &thread_id) {
                    (Some(_), Some(_)) => optional("conversation_id").unwrap_or_default(),
                    (Some(_), None) | (None, Some(_)) => {
                        return Err("member_id and thread_id must be passed together".to_string());
                    }
                    (None, None) => required_string(arguments, "conversation_id")?,
                };
                let operation_id = required_string(arguments, "operation_id")?;
                let text = required_string(arguments, "text")?;
                if text.trim().is_empty() {
                    return Err("text must not be empty".to_string());
                }
                let steer = arguments
                    .get("steer")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let expected_turn_id = arguments
                    .get("expected_turn_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if steer && expected_turn_id.as_deref().unwrap_or("").trim().is_empty() {
                    return Err("expected_turn_id is required when steer is true".to_string());
                }
                let delay_seconds = arguments.get("delay_seconds").and_then(Value::as_i64);
                let deliver_at = arguments
                    .get("deliver_at")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if delay_seconds.is_some() && deliver_at.is_some() {
                    return Err("pass delay_seconds or deliver_at, not both".to_string());
                }
                Ok(BrokerMessage::SessionSend(BrokerSessionSendRequest {
                    token,
                    conversation_id,
                    member_id,
                    thread_id,
                    operation_id,
                    text,
                    steer,
                    expected_turn_id,
                    delay_seconds,
                    deliver_at,
                }))
            }
            "list_conversations"
            | "create_conversation"
            | "list_spaces"
            | "read_space_messages"
            | "post_space_message"
            | "manage_bot"
            | "manage_group"
            | "request_approval"
            | "memory_search"
            | "memory_write"
            | "list_roles"
            | "create_role"
            | "update_role"
            | "delete_role"
            | "list_teams"
            | "create_team"
            | "update_team"
            | "delete_team"
            | "list_collaboration_spaces"
            | "list_space_members"
            | "create_collaboration_space"
            | "add_space_member"
            | "create_space_member"
            | "set_space_identity"
            | "set_space_lead"
            | "leave_space"
            | "remove_space_member"
            | "delete_space_member"
            | "delete_collaboration_space"
            | "interrupt_space_turn"
            | "post_to_space"
            | "handoff"
            | "ask_person"
            | "resolve_card"
            | "list_space_messages"
            | "list_space_collection"
            | "add_to_space_collection"
            | "read_space_collection_item"
            | "remove_space_collection_item" => {
                Ok(BrokerMessage::Collaborate(BrokerCollaborateRequest {
                    token,
                    name: name.to_string(),
                    arguments: arguments.clone(),
                }))
            }
            "cancel_session_turn" => {
                let conversation_id = required_string(arguments, "conversation_id")?;
                let reason = arguments
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Ok(BrokerMessage::SessionCancel(BrokerSessionCancelRequest {
                    token,
                    conversation_id,
                    reason,
                }))
            }
            "wait_for_session" => {
                let conversation_id = required_string(arguments, "conversation_id")?;
                let after_sequence = arguments.get("after_sequence").and_then(Value::as_i64);
                let wait_ms = arguments.get("wait_ms").and_then(Value::as_u64);
                Ok(BrokerMessage::SessionWait(BrokerSessionWaitRequest {
                    token,
                    conversation_id,
                    after_sequence,
                    wait_ms,
                }))
            }
            other => Err(format!("unknown tool: {other}")),
        }
    }

    /// Best-effort: tell the broker to cancel the delegation behind `handle`.
    async fn send_broker_cancel(&self, handle: String) {
        let message = BrokerMessage::Cancel(BrokerCancelRequest {
            token: self.token.clone(),
            external_handle: handle,
            reason: Some("client cancelled".to_string()),
        });
        let _ =
            tokio::time::timeout(std::time::Duration::from_millis(500), self.send(&message)).await;
    }
}

impl pulse_bridge::HostCommandCaller for Companion {
    fn call_host_command<'a>(
        &'a self,
        command: &'a str,
        operation_id: &'a str,
        args: &'a Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, client::HostCallError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            if self.uses_http() {
                let server_url = self.server_url.as_deref().unwrap_or_default();
                let bearer = self.effective_bearer_token();
                match client::call_host_v1_command(
                    server_url,
                    bearer,
                    self.conversation_id.as_deref(),
                    command,
                    operation_id,
                    args,
                )
                .await
                {
                    Ok(data) => Ok(data),
                    Err(v1_err) if v1_err.unmounted_v1_route => {
                        let message = BrokerMessage::Collaborate(BrokerCollaborateRequest {
                            token: self.token.clone(),
                            name: command.to_string(),
                            arguments: args.clone(),
                        });
                        let broker_resp = client::call_http(
                            server_url,
                            bearer,
                            self.conversation_id.as_deref(),
                            &self.product,
                            &message,
                        )
                        .await
                        .map_err(|io_err| client::HostCallError::transport(io_err.to_string()))?;
                        client::unwrap_broker_command_response(broker_resp)
                    }
                    Err(err) => Err(err),
                }
            } else if self.uses_socket() {
                let message = BrokerMessage::Collaborate(BrokerCollaborateRequest {
                    token: self.token.clone(),
                    name: command.to_string(),
                    arguments: args.clone(),
                });
                let broker_resp = client::call_broker(&self.socket_path, &message)
                    .await
                    .map_err(|io_err| client::HostCallError::transport(io_err.to_string()))?;
                client::unwrap_broker_command_response(broker_resp)
            } else {
                Err(client::HostCallError::transport(
                    "no Host HTTP or Socket IPC transport configured",
                ))
            }
        })
    }
}

fn required_string(arguments: &Value, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{name} is required"))
}

fn resolve_conversation_id(flag: Option<String>) -> Option<String> {
    flag.or_else(|| std::env::var("DIMO_CONVERSATION_ID").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Handshake-era MCP revisions this companion can speak. `2026-07-28` is
/// modern/stateless: Claude Code 2.1.292+ stdio probes it via `server/discover`
/// and stays on that revision when the probe returns `supportedVersions`.
/// An `initialize` request still selects handshake semantics; an omitted or
/// unknown handshake version must not be answered as modern.
const SUPPORTED_MCP_PROTOCOLS: &[&str] = &[
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
];
const DEFAULT_MCP_PROTOCOL: &str = "2025-11-25";
const MODERN_MCP_PROTOCOL: &str = "2026-07-28";
const MCP_PROTOCOL_VERSION_META: &str = "io.modelcontextprotocol/protocolVersion";
const MCP_SERVER_INFO_META: &str = "io.modelcontextprotocol/serverInfo";

fn negotiate_protocol(params: Option<&Value>) -> &'static str {
    let requested = params
        .and_then(|value| value.get("protocolVersion"))
        .and_then(Value::as_str);
    SUPPORTED_MCP_PROTOCOLS
        .iter()
        .copied()
        .find(|version| Some(*version) == requested)
        .unwrap_or(DEFAULT_MCP_PROTOCOL)
}

fn server_info(product: &str) -> Value {
    let name = if product == "superagent" {
        "Dimo-superagent-mcp"
    } else {
        "dimo-mcp"
    };
    json!({
        "name": name,
        "version": env!("CARGO_PKG_VERSION")
    })
}

fn meta_protocol_version(params: Option<&Value>) -> Option<&str> {
    params.and_then(|value| {
        value
            .get(MCP_PROTOCOL_VERSION_META)
            .or_else(|| {
                value
                    .get("_meta")
                    .and_then(|meta| meta.get(MCP_PROTOCOL_VERSION_META))
            })
            .and_then(Value::as_str)
    })
}

fn discover_result(product: &str) -> Value {
    json!({
        "resultType": "complete",
        "supportedVersions": [MODERN_MCP_PROTOCOL],
        "capabilities": { "tools": {} },
        "_meta": { MCP_SERVER_INFO_META: server_info(product) }
    })
}

fn modernize_result(params: Option<&Value>, mut result: Value, product: &str) -> Value {
    if meta_protocol_version(params) != Some(MODERN_MCP_PROTOCOL) {
        return result;
    }
    if let Some(object) = result.as_object_mut() {
        object
            .entry("resultType")
            .or_insert_with(|| json!("complete"));
        object
            .entry("_meta")
            .or_insert_with(|| json!({ MCP_SERVER_INFO_META: server_info(product) }));
    }
    result
}

fn initialize_result(params: Option<&Value>, product: &str) -> Value {
    json!({
        "protocolVersion": negotiate_protocol(params),
        "capabilities": { "tools": {} },
        "serverInfo": server_info(product)
    })
}

fn next_handle() -> String {
    format!(
        "h-{}-{}",
        std::process::id(),
        HANDLE_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Stable string key for a JSON-RPC id (number or string).
fn id_key(id: &Option<Value>) -> Option<String> {
    id.as_ref().map(Value::to_string)
}

fn respond(id: Option<Value>, result: Value) -> Option<String> {
    let id = id?;
    serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).ok()
}

fn respond_error(id: Option<Value>, code: i64, message: &str) -> Option<String> {
    let id = id?;
    serde_json::to_string(
        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    )
    .ok()
}

async fn write_opt(stdout: &Arc<Mutex<tokio::io::Stdout>>, response: Option<String>) -> bool {
    let Some(response) = response else {
        return false;
    };
    let mut out = stdout.lock().await;
    out.write_all(response.as_bytes()).await.is_ok()
        && out.write_all(b"\n").await.is_ok()
        && out.flush().await.is_ok()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    client::install_rustls_crypto_provider();
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("dimo-mcp: {err}");
            std::process::exit(2);
        }
    };
    let companion = Arc::new(Companion::new(args));
    let inflight: Arc<Inflight> = Arc::new(Inflight::default());
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match companion.classify(&value) {
            LineAction::Respond(response) => {
                write_opt(&stdout, Some(response)).await;
            }
            LineAction::Ignore => {}
            LineAction::Call {
                id,
                name,
                arguments,
                meta,
            } => {
                let companion = companion.clone();
                let inflight = inflight.clone();
                let stdout = stdout.clone();
                tokio::spawn(async move {
                    companion
                        .run_call(id, name, arguments, meta, inflight, stdout)
                        .await;
                });
            }
            LineAction::Cancel { request_id } => {
                if let Some(key) = id_key(&request_id)
                    && let Some(entry) = inflight.take(&key).await
                {
                    let _ = entry.cancel.send(());
                    if let Some(handle) = entry.external_handle {
                        let companion = companion.clone();
                        tokio::spawn(async move {
                            companion.send_broker_cancel(handle).await;
                        });
                    }
                }
            }
        }
    }

    // Parent gone (stdin EOF): drain in-flight calls so no delegation is orphaned.
    for entry in inflight.drain().await {
        let _ = entry.cancel.send(());
        if let Some(handle) = entry.external_handle {
            companion.send_broker_cancel(handle).await;
        }
    }
}

#[cfg(test)]
mod pulse_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod workflow_tests;
