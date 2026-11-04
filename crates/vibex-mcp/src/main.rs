//! `vibex-mcp` — the per-launch companion MCP server.
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

use std::{
    collections::HashMap,
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
                }
            }
        }
    }

    fn allows_tool(&self, name: &str) -> bool {
        match name {
            "delegate_to_agent" | "get_delegation_status" | "cancel_delegation" => self.delegation,
            "check_user_feedback" => self.feedback,
            "ask_user_question" => self.ask || self.collaboration,
            "get_session_info" => self.session_info || self.collaboration,
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
            arguments.get("action").and_then(Value::as_str).map(str::trim),
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
            "--product" => product = Some(take()?),
            // Accepted for forward-compat; parent death is detected via stdin EOF.
            "--parent-pid" => {
                let _ = take()?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        parent_connection_id: parent_connection_id.unwrap_or_default(),
        socket_path: socket_path.unwrap_or_default(),
        token: token
            .or_else(|| server_token.clone())
            .ok_or("missing --token or --server-token")?,
        features: CompanionFeatures::parse(features.as_deref()),
        server_url,
        server_token,
        conversation_id: resolve_conversation_id(conversation_id),
        product: product.unwrap_or_else(|| "delegation".to_string()),
    })
}

/// Tool schemas this companion advertises, filtered by enabled features.
fn enabled_tools(features: &CompanionFeatures) -> Vec<Value> {
    let all: Vec<Value> = serde_json::from_str(TOOL_SCHEMA).expect("embedded tool schema is valid");
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
    product: String,
}

impl Companion {
    fn new(args: Args) -> Self {
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
            product: args.product,
        }
    }

    fn uses_http(&self) -> bool {
        self.server_url
            .as_ref()
            .is_some_and(|url| !url.trim().is_empty())
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
            "initialize" => respond(id, initialize_result(params))
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "server/discover" => respond(id, discover_result())
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "ping" => respond(id, modernize_result(params, json!({})))
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "tools/list" => respond(id, modernize_result(params, json!({ "tools": self.tools })))
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
        let mut arguments = arguments;
        if collaboration_needs_operation_id(&name, &arguments) {
            ensure_operation_id(&mut arguments, meta.as_ref(), id.as_ref());
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
                    respond(id, modernize_result(meta.as_ref(), render_result(&outcome))),
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
                    .ok_or("conversation_id is required")?
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

fn required_string(arguments: &Value, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{name} is required"))
}

fn resolve_conversation_id(flag: Option<String>) -> Option<String> {
    flag.or_else(|| std::env::var("VIBEX_CONVERSATION_ID").ok())
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

fn server_info() -> Value {
    json!({
        "name": "vibex-mcp",
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

fn discover_result() -> Value {
    json!({
        "resultType": "complete",
        "supportedVersions": [MODERN_MCP_PROTOCOL],
        "capabilities": { "tools": {} },
        "_meta": { MCP_SERVER_INFO_META: server_info() }
    })
}

fn modernize_result(params: Option<&Value>, mut result: Value) -> Value {
    if meta_protocol_version(params) != Some(MODERN_MCP_PROTOCOL) {
        return result;
    }
    if let Some(object) = result.as_object_mut() {
        object
            .entry("resultType")
            .or_insert_with(|| json!("complete"));
        object
            .entry("_meta")
            .or_insert_with(|| json!({ MCP_SERVER_INFO_META: server_info() }));
    }
    result
}

fn initialize_result(params: Option<&Value>) -> Value {
    json!({
        "protocolVersion": negotiate_protocol(params),
        "capabilities": { "tools": {} },
        "serverInfo": server_info()
    })
}

/// Render a broker outcome as an MCP `CallToolResult`: a human/LLM-readable text
/// summary plus the full structured outcome.
fn render_result(outcome: &Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": summarize(outcome) }],
        "structuredContent": outcome,
        "isError": outcome.get("isError").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn summarize(outcome: &Value) -> String {
    if let Some(text) = outcome.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(count) = outcome.get("count") {
        let notes = outcome
            .get("feedback")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if notes.is_empty() || count.as_u64() == Some(0) {
            return "No new feedback from the user. Continue with your current plan.".to_string();
        }
        let mut text = format!(
            "The user sent {} message(s) while you were working. Treat this as high-priority steering: adjust your current approach to honor it now, and briefly acknowledge what you changed.\n",
            notes.len()
        );
        for (index, note) in notes.iter().enumerate() {
            let body = note.get("text").and_then(Value::as_str).unwrap_or("");
            text.push_str(&format!("{}. {body}\n", index + 1));
        }
        return text;
    }
    if outcome.get("answers").is_some() || outcome.get("declined").is_some() {
        if outcome
            .get("declined")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return "The user dismissed the question(s) without choosing an answer. Proceed using your best judgment and reasonable defaults.".to_string();
        }
        let answers = outcome
            .get("answers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if answers.is_empty() {
            return "The user dismissed the question(s) without choosing an answer. Proceed using your best judgment and reasonable defaults.".to_string();
        }
        let mut text = String::from("The user answered your question(s):\n");
        for (index, answer) in answers.iter().enumerate() {
            let header = answer.get("header").and_then(Value::as_str).unwrap_or("");
            let question = answer
                .get("question")
                .and_then(Value::as_str)
                .or_else(|| answer.get("questionId").and_then(Value::as_str))
                .unwrap_or("");
            let selected = answer
                .get("selected")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .or_else(|| {
                    answer.get("labels").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                })
                .unwrap_or_default();
            text.push_str(&format!(
                "{}. [{header}] {question}\n   → {}\n",
                index + 1,
                if selected.is_empty() {
                    "(no selection)"
                } else {
                    selected.as_str()
                }
            ));
        }
        return text;
    }
    if outcome.get("found") == Some(&json!(false)) {
        if let Some(note) = outcome.get("note").and_then(Value::as_str) {
            return note.to_string();
        }
        if let Some(id) = outcome
            .get("conversation_id")
            .and_then(Value::as_str)
            .or_else(|| outcome.get("session_id").and_then(Value::as_str))
        {
            return format!("No conversation matches id {id}.");
        }
    }
    if outcome.get("found") == Some(&json!(true)) {
        return render_session_summary(outcome);
    }
    if outcome.get("tasks").is_some() {
        return outcome.to_string();
    }
    if let Some(message) = outcome.get("message").and_then(Value::as_str) {
        if let Some(task_id) = outcome.get("task_id").and_then(Value::as_str) {
            return format!("{message} (task_id: {task_id})");
        }
        return message.to_string();
    }
    outcome.to_string()
}

fn render_session_summary(outcome: &Value) -> String {
    let id = outcome
        .get("conversation_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let agent = outcome
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut out = format!("Conversation {id} ({agent})\n");
    if let Some(title) = outcome.get("title").and_then(Value::as_str) {
        out.push_str(&format!("Title: {title}\n"));
    }
    let mut meta = Vec::new();
    if let Some(status) = outcome.get("status").and_then(Value::as_str) {
        meta.push(format!("status: {status}"));
    }
    if let Some(branch) = outcome.get("git_branch").and_then(Value::as_str) {
        meta.push(format!("branch: {branch}"));
    }
    if let Some(model) = outcome.get("model").and_then(Value::as_str) {
        meta.push(format!("model: {model}"));
    }
    if !meta.is_empty() {
        out.push_str(&meta.join(" | "));
        out.push('\n');
    }
    if let Some(path) = outcome.get("workspace_path").and_then(Value::as_str) {
        out.push_str(&format!("Workspace: {path}\n"));
    }
    if let Some(count) = outcome.get("message_count") {
        out.push_str(&format!("Messages: {count}\n"));
    }
    if outcome
        .get("is_delegation_child")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && let Some(parent) = outcome.get("parent_conversation_id").and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| Some(value.to_string()))
        })
    {
        out.push_str(&format!("Delegation child of {parent}\n"));
    }
    if let Some(tokens) = outcome
        .get("stats")
        .and_then(|stats| stats.get("total_tokens"))
    {
        out.push_str(&format!("Total tokens: {tokens}\n"));
    }
    if let Some(note) = outcome.get("note").and_then(Value::as_str) {
        out.push_str(&format!("Note: {note}\n"));
    }
    if let Some(messages) = outcome.get("messages") {
        let total = messages.get("total").and_then(Value::as_u64).unwrap_or(0);
        let included = messages
            .get("included")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let truncated = messages
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let suffix = if truncated {
            ", older turns omitted"
        } else {
            ""
        };
        out.push_str(&format!(
            "\nRecent messages ({included}/{total}{suffix}):\n"
        ));
        if let Some(items) = messages.get("items").and_then(Value::as_array) {
            for item in items {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("?");
                let body = item
                    .get("text")
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let tools: Vec<&str> = item
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|array| array.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                out.push_str(&format!("- [{role}] {body}"));
                if !tools.is_empty() {
                    out.push_str(&format!(" (tools: {})", tools.join(", ")));
                }
                out.push('\n');
            }
        }
    }
    out
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
            eprintln!("vibex-mcp: {err}");
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
mod tests {
    use delegation_proto::BrokerMessage;

    use super::*;

    fn companion(features: &str) -> Arc<Companion> {
        Arc::new(Companion::new(Args {
            parent_connection_id: "conn-1".to_string(),
            socket_path: "/tmp/does-not-matter.sock".to_string(),
            token: "tok".to_string(),
            features: CompanionFeatures::parse(Some(features)),
            server_url: None,
            server_token: None,
            conversation_id: None,
            product: "delegation".to_string(),
        }))
    }

    fn classify(features: &str, line: &str) -> LineAction {
        let value: Value = serde_json::from_str(line).unwrap();
        companion(features).classify(&value)
    }

    fn respond_text(action: LineAction) -> Value {
        match action {
            LineAction::Respond(text) => serde_json::from_str(&text).unwrap(),
            _ => panic!("expected Respond"),
        }
    }

    #[test]
    fn initialize_returns_server_info() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        ));
        assert_eq!(value["result"]["serverInfo"]["name"], "vibex-mcp");
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(value["id"], 1);
    }

    #[test]
    fn initialize_echoes_a_legacy_protocol_version_claude_code_requests() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(value["result"]["capabilities"]["tools"], json!({}));
    }

    #[test]
    fn initialize_echoes_2025_03_26_when_requested() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn initialize_echoes_2025_06_18_when_claude_code_requests_it() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        ));
        assert_eq!(
            value["result"]["protocolVersion"], "2025-06-18",
            "Claude Code's MCP client still requests 2025-06-18; answering 2026-07-28 makes it refuse the server as too new"
        );
    }

    #[test]
    fn initialize_keeps_modern_protocol_when_requested() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2026-07-28");
    }

    #[test]
    fn initialize_falls_back_when_the_client_asks_for_an_unknown_revision() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#,
        ));
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn discover_answers_claude_code_2026_stdio_probe() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.303"}}}}"#,
        ));
        assert!(
            value.get("error").is_none(),
            "Claude Code 2.1.292+ stdio probes server/discover first; method-not-found makes it fall back to the handshake"
        );
        assert_eq!(value["result"]["resultType"], "complete");
        assert_eq!(
            value["result"]["supportedVersions"],
            json!(["2026-07-28"]),
            "listing only the modern revision keeps Claude on 2026-07-28 after the probe"
        );
        assert_eq!(value["result"]["capabilities"]["tools"], json!({}));
        assert_eq!(
            value["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
            "vibex-mcp"
        );
    }

    #[test]
    fn tools_list_after_modern_discover_does_not_need_initialize() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#,
        ));
        assert!(value["result"]["tools"].is_array());
        assert_eq!(value["result"]["resultType"], "complete");
        assert_eq!(
            value["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
            "vibex-mcp"
        );
    }

    #[test]
    fn ping_returns_an_empty_result() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":10,"method":"ping"}"#,
        ));
        assert_eq!(value["id"], 10);
        assert_eq!(value["result"], json!({}));
        assert!(value.get("error").is_none());
    }

    #[test]
    fn tools_list_reflects_features() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        ));
        let names: Vec<&str> = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(names.contains(&"delegate_to_agent"));
        assert!(names.contains(&"cancel_delegation"));
        assert!(!names.contains(&"check_user_feedback"));
        assert!(!names.contains(&"ask_user_question"));
        assert!(!names.contains(&"plugin_dev_link_request"));
        assert!(!names.contains(&"ask_person"));
    }

    #[test]
    fn send_session_input_member_id_distinguishes_identity_and_seat() {
        let value = respond_text(classify(
            "collaboration",
            r#"{"jsonrpc":"2.0","id":24,"method":"tools/list"}"#,
        ));
        let tools = value["result"]["tools"].as_array().unwrap();
        let send = tools
            .iter()
            .find(|tool| tool["name"] == "send_session_input")
            .expect("send_session_input");
        let member_id = send["inputSchema"]["properties"]["member_id"]["description"]
            .as_str()
            .expect("member_id description");
        assert!(member_id.contains("identity_member_id"));
        assert!(member_id.contains("list_spaces"));
        assert!(member_id.contains("manage_group"));
        assert!(member_id.contains("different namespaces"));

        let list = tools
            .iter()
            .find(|tool| tool["name"] == "list_spaces")
            .expect("list_spaces");
        let list_desc = list["description"].as_str().expect("list description");
        assert!(list_desc.contains("identity_member_id"));
        assert!(list_desc.contains("lead_bot"));
    }

    #[test]
    fn post_to_space_schema_asks_for_progress_reports() {
        let value = respond_text(classify(
            "collaboration,space",
            r#"{"jsonrpc":"2.0","id":25,"method":"tools/list"}"#,
        ));
        let tools = value["result"]["tools"].as_array().unwrap();
        let post = tools
            .iter()
            .find(|tool| tool["name"] == "post_space_message")
            .expect("post_space_message");
        let desc = post["description"].as_str().expect("description");
        assert!(
            desc.contains("ordinary assistant text") && desc.contains("in-space progress"),
            "{desc}"
        );
        assert!(
            !desc.contains("report progress during a long task"),
            "{desc}"
        );
        assert!(!desc.contains("acknowledgment/plan"), "{desc}");
        assert!(
            desc.contains("restate")
                || desc.contains("already posted")
                || desc.contains("incremental"),
            "{desc}"
        );
        assert!(
            desc.contains("lead") || desc.contains("space lead") || desc.contains("lead_bot"),
            "{desc}"
        );
        assert!(
            desc.contains("ordinary assistant text") || desc.contains("ordinary"),
            "{desc}"
        );
        assert!(desc.contains("Person"), "{desc}");
        assert!(
            post["inputSchema"]["properties"]
                .get("operation_id")
                .is_none(),
            "operation_id must not be an LLM argument"
        );
    }

    #[test]
    fn list_space_member_schema_exposes_space_lead() {
        let value = respond_text(classify(
            "collaboration",
            r#"{"jsonrpc":"2.0","id":26,"method":"tools/list"}"#,
        ));
        let tools = value["result"]["tools"].as_array().unwrap();
        let list = tools
            .iter()
            .find(|tool| tool["name"] == "list_spaces")
            .expect("list_spaces");
        let list_desc = list["description"].as_str().expect("list description");
        assert!(
            list_desc.contains("lead_nickname") && list_desc.contains("lead_bot"),
            "{list_desc}"
        );
        assert!(
            list_desc.contains("activity")
                && list_desc.contains("waiting_for_bot")
                && list_desc.contains("working"),
            "{list_desc}"
        );
        assert!(
            list_desc.contains("BotSpace") && list_desc.contains("GroupSpace"),
            "{list_desc}"
        );
    }

    #[test]
    fn tool_schema_explains_agent_mentions() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":23,"method":"tools/list"}"#,
        ));
        let description = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "delegate_to_agent")
            .and_then(|tool| tool["description"].as_str())
            .expect("delegate_to_agent description");

        assert!(description.contains("every AgentMention"));
        assert!(description.contains("[&Codex](vibex://agent/codex)"));
        assert!(description.contains("does not itself start"));
        assert!(description.contains("ASYNCHRONOUS"));
        assert!(description.contains("do not call search_tool"));
        assert!(description.contains("MUST call get_delegation_status"));
    }

    #[test]
    fn all_features_expose_five_tools() {
        let value = respond_text(classify(
            "delegation,feedback,ask",
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#,
        ));
        assert_eq!(value["result"]["tools"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn session_info_feature_is_independent() {
        let value = respond_text(classify(
            "sessions",
            r#"{"jsonrpc":"2.0","id":31,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["get_session_info"]);
    }

    #[test]
    fn session_control_exposes_send_cancel_and_wait_only() {
        let value = respond_text(classify(
            "session-control",
            r#"{"jsonrpc":"2.0","id":32,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "send_session_input",
                "cancel_session_turn",
                "wait_for_session"
            ]
        );
    }

    #[test]
    fn collaboration_opens_same_workspace_tools_without_session_control() {
        let value = respond_text(classify(
            "collaboration",
            r#"{"jsonrpc":"2.0","id":33,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "ask_user_question",
                "get_session_info",
                "send_session_input",
                "list_conversations",
                "create_conversation",
                "list_spaces",
                "manage_bot",
            ]
        );
        assert!(!names.contains(&"read_space_messages"));
        assert!(!names.contains(&"post_space_message"));
        assert!(!names.contains(&"manage_group"));
        assert!(!names.contains(&"request_approval"));
        assert!(!names.contains(&"memory_search"));
        assert!(!names.contains(&"memory_write"));
        assert!(!names.contains(&"cancel_session_turn"));
        assert!(!names.contains(&"wait_for_session"));
        assert!(!names.contains(&"delegate_to_agent"));
        assert!(!names.contains(&"handoff"));
        assert!(!names.contains(&"ask_person"));
        assert!(!names.contains(&"resolve_card"));
        assert!(!names.contains(&"list_space_collection"));
        assert!(!names.contains(&"create_role"));
        assert!(!names.contains(&"list_collaboration_spaces"));
        assert!(!names.contains(&"post_to_space"));
    }

    #[test]
    fn space_session_opens_the_full_collaboration_toolset() {
        let value = respond_text(classify(
            "collaboration,space",
            r#"{"jsonrpc":"2.0","id":34,"method":"tools/list"}"#,
        ));
        let names = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "ask_user_question",
                "get_session_info",
                "send_session_input",
                "list_conversations",
                "create_conversation",
                "list_spaces",
                "read_space_messages",
                "post_space_message",
                "manage_bot",
                "manage_group",
                "request_approval",
                "memory_search",
                "memory_write",
            ]
        );
    }

    #[test]
    fn collaboration_write_injects_operation_id_from_tool_use_id() {
        let mut args = json!({"space_id": "space-1", "content": "hi"});
        ensure_operation_id(
            &mut args,
            Some(&json!({"tool_use_id": "call-abc"})),
            Some(&json!(7)),
        );
        let expected = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"call-abc");
        assert_eq!(args["operation_id"], expected.to_string());
    }

    #[test]
    fn collaboration_write_injects_operation_id_from_request_id() {
        let mut args = json!({"space_id": "space-1", "content": "hi"});
        ensure_operation_id(&mut args, None, Some(&json!(42)));
        let expected = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"42");
        assert_eq!(args["operation_id"], expected.to_string());
    }

    #[test]
    fn collaboration_write_keeps_explicit_operation_id() {
        let mut args = json!({"operation_id": "550e8400-e29b-41d4-a716-446655440000"});
        ensure_operation_id(
            &mut args,
            Some(&json!({"tool_use_id": "other"})),
            Some(&json!(1)),
        );
        assert_eq!(args["operation_id"], "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn manage_bot_list_agents_does_not_need_operation_id() {
        assert!(!collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "list_agents"})
        ));
        assert!(!collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "list_options"})
        ));
        assert!(collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "create", "nickname": "Bot"})
        ));
        assert!(collaboration_needs_operation_id(
            "manage_bot",
            &json!({"action": "update"})
        ));
    }

    #[test]
    fn session_send_requires_explicit_operation_id() {
        let companion = companion("session-control");
        let error = companion
            .build_message(
                "send_session_input",
                &json!({
                    "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
                    "text": "continue"
                }),
                None,
            )
            .unwrap_err();
        assert_eq!(error, "operation_id is required");
    }

    #[test]
    fn delegate_reads_progress_token_as_parent_tool_use_id() {
        let companion = companion("delegation");
        let message = companion
            .build_message(
                "delegate_to_agent",
                &json!({"agent_type":"codex","task":"x"}),
                Some(&json!({"progressToken": "call-1"})),
            )
            .unwrap();
        match message {
            BrokerMessage::Call(req) => assert_eq!(req.parent_tool_use_id, "call-1"),
            _ => panic!("expected Call"),
        }
    }

    #[test]
    fn tools_call_classifies_as_call() {
        let action = classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"delegate_to_agent","arguments":{"agent_type":"codex","task":"x"}}}"#,
        );
        match action {
            LineAction::Call { name, .. } => assert_eq!(name, "delegate_to_agent"),
            _ => panic!("expected Call"),
        }
    }

    #[test]
    fn cancelled_notification_classifies_as_cancel() {
        let action = classify(
            "delegation",
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}"#,
        );
        match action {
            LineAction::Cancel { request_id } => assert_eq!(request_id, Some(json!(7))),
            _ => panic!("expected Cancel"),
        }
    }

    #[test]
    fn other_notifications_are_ignored() {
        assert!(matches!(
            classify(
                "delegation",
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            ),
            LineAction::Ignore
        ));
    }

    #[test]
    fn unknown_method_errors() {
        let value = respond_text(classify(
            "delegation",
            r#"{"jsonrpc":"2.0","id":9,"method":"nope"}"#,
        ));
        assert_eq!(value["error"]["code"], -32601);
    }

    #[test]
    fn companion_prefers_http_when_a_server_url_is_present() {
        let injected = Companion::new(Args {
            parent_connection_id: "conn-1".to_string(),
            socket_path: "/tmp/vibex-delegation.sock".to_string(),
            token: "tok".to_string(),
            features: CompanionFeatures::parse(Some("delegation")),
            server_url: Some("http://127.0.0.1:9".to_string()),
            server_token: Some("plugin-token".to_string()),
            conversation_id: Some("conv".to_string()),
            product: "delegation".to_string(),
        });
        assert!(injected.uses_http());
        let native = Companion::new(Args {
            parent_connection_id: String::new(),
            socket_path: String::new(),
            token: "plugin-token".to_string(),
            features: CompanionFeatures::parse(Some("delegation")),
            server_url: Some("http://127.0.0.1:9".to_string()),
            server_token: Some("plugin-token".to_string()),
            conversation_id: None,
            product: "delegation".to_string(),
        });
        assert!(native.uses_http());
    }

    #[test]
    fn http_client_builds_after_crypto_provider_install() {
        client::install_rustls_crypto_provider();
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .expect("sidecar HTTP client requires an installed rustls provider");
    }

    #[test]
    fn conversation_id_falls_back_to_the_parent_process_env() {
        assert_eq!(
            resolve_conversation_id(Some("from-flag".to_string())).as_deref(),
            Some("from-flag")
        );
        // SAFETY: this process-local env key is only read by resolve_conversation_id
        // in this test and is restored afterwards.
        let previous = std::env::var("VIBEX_CONVERSATION_ID").ok();
        unsafe {
            std::env::set_var("VIBEX_CONVERSATION_ID", " from-env ");
        }
        assert_eq!(resolve_conversation_id(None).as_deref(), Some("from-env"));
        unsafe {
            match previous {
                Some(value) => std::env::set_var("VIBEX_CONVERSATION_ID", value),
                None => std::env::remove_var("VIBEX_CONVERSATION_ID"),
            }
        }
    }

    #[test]
    fn feature_gate_rejects_disabled_tool() {
        let c = companion("delegation");
        assert!(!c.features.allows_tool("check_user_feedback"));
        assert!(c.features.allows_tool("delegate_to_agent"));
    }

    #[test]
    fn build_message_validates_status_args() {
        let c = companion("delegation");
        let err = c
            .build_message("get_delegation_status", &json!({ "task_ids": [] }), None)
            .unwrap_err();
        assert!(err.contains("non-empty"));
    }

    // End-to-end transport round-trip over the real platform socket.
    #[cfg(windows)]
    #[tokio::test]
    async fn call_broker_round_trips_over_named_pipe() {
        use delegation_proto::{
            BrokerResponse, DelegationTaskReport, TaskStatus, read_frame, write_frame,
        };
        use tokio::net::windows::named_pipe::ServerOptions;

        let path = format!(r"\\.\pipe\vibex-mcp-test-{}", std::process::id());
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)
            .unwrap();
        let server_task = tokio::spawn(async move {
            let mut conn = server;
            conn.connect().await.unwrap();
            let received: BrokerMessage = read_frame(&mut conn).await.unwrap();
            let response = BrokerResponse::Task(DelegationTaskReport {
                task_id: Some("t1".to_string()),
                status: TaskStatus::Running,
                child_session_id: None,
                agent_type: None,
                text: None,
                error_code: None,
                message: None,
                duration_ms: None,
            });
            write_frame(&mut conn, &response).await.unwrap();
            received
        });

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let message = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".to_string(),
            task_ids: vec!["t1".to_string()],
            wait_ms: None,
        });
        let response = client::call_broker(&path, &message)
            .await
            .unwrap()
            .into_outcome();
        assert_eq!(response["status"], "running");
        assert!(matches!(
            server_task.await.unwrap(),
            BrokerMessage::Status(_)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn call_broker_round_trips_over_uds() {
        use delegation_proto::{
            BrokerResponse, DelegationTaskReport, TaskStatus, read_frame, write_frame,
        };

        let dir = std::env::temp_dir();
        let path = dir.join(format!("vibex-mcp-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let path_str = path.to_string_lossy().to_string();
        let server_task = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let received: BrokerMessage = read_frame(&mut conn).await.unwrap();
            let response = BrokerResponse::Task(DelegationTaskReport {
                task_id: Some("t1".to_string()),
                status: TaskStatus::Running,
                child_session_id: None,
                agent_type: None,
                text: None,
                error_code: None,
                message: None,
                duration_ms: None,
            });
            write_frame(&mut conn, &response).await.unwrap();
            received
        });

        let message = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".to_string(),
            task_ids: vec!["t1".to_string()],
            wait_ms: None,
        });
        let response = client::call_broker(&path_str, &message)
            .await
            .unwrap()
            .into_outcome();
        assert_eq!(response["status"], "running");
        assert!(matches!(
            server_task.await.unwrap(),
            BrokerMessage::Status(_)
        ));
    }
}
