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
};

use delegation_proto::{
    BrokerAskRequest, BrokerCancelRequest, BrokerCancelTaskRequest, BrokerCommitFeedbackRequest,
    BrokerFeedbackRequest, BrokerMessage, BrokerRequest, BrokerSessionCancelRequest,
    BrokerSessionRequest, BrokerSessionSendRequest, BrokerSessionWaitRequest, BrokerStatusRequest,
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, oneshot},
};

const TOOL_SCHEMA: &str = include_str!("../tool_schema.json");
static HANDLE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Parsed launch arguments.
struct Args {
    parent_connection_id: String,
    socket_path: String,
    token: String,
    features: CompanionFeatures,
}

/// Which tool groups this companion exposes (from `--features`).
struct CompanionFeatures {
    delegation: bool,
    feedback: bool,
    ask: bool,
    session_info: bool,
    session_control: bool,
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
            },
            Some(value) => {
                let has = |name: &str| value.split(',').any(|f| f.trim() == name);
                Self {
                    delegation: has("delegation"),
                    feedback: has("feedback"),
                    ask: has("ask"),
                    session_info: has("sessions"),
                    session_control: has("session-control"),
                }
            }
        }
    }

    fn allows_tool(&self, name: &str) -> bool {
        match name {
            "delegate_to_agent" | "get_delegation_status" | "cancel_delegation" => self.delegation,
            "check_user_feedback" => self.feedback,
            "ask_user_question" => self.ask,
            "get_session_info" => self.session_info,
            "send_session_input" | "cancel_session_turn" | "wait_for_session" => {
                self.session_control
            }
            _ => false,
        }
    }
}

fn parse_args() -> Result<Args, String> {
    let mut parent_connection_id = None;
    let mut socket_path = None;
    let mut token = None;
    let mut features = None;

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
            // Accepted for forward-compat; parent death is detected via stdin EOF.
            "--parent-pid" => {
                let _ = take()?;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Args {
        parent_connection_id: parent_connection_id.ok_or("missing --parent-connection-id")?,
        socket_path: socket_path.ok_or("missing --socket-path")?,
        token: token.ok_or("missing --token")?,
        features: CompanionFeatures::parse(features.as_deref()),
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
            "initialize" => respond(id, initialize_result())
                .map(LineAction::Respond)
                .unwrap_or(LineAction::Ignore),
            "tools/list" => respond(id, json!({ "tools": self.tools }))
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
            result = client::call_broker(&self.socket_path, &message) => Some(result),
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
                let relayed = write_opt(&stdout, respond(id, render_result(&outcome))).await;
                if relayed && !feedback_ids.is_empty() {
                    let _ = client::call_broker(
                        &self.socket_path,
                        &BrokerMessage::CommitFeedback(BrokerCommitFeedbackRequest {
                            token: self.token.clone(),
                            ids: feedback_ids,
                        }),
                    )
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
                parent_tool_use_id: meta
                    .and_then(|m| m.get("tool_use_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
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
            "ask_user_question" => Ok(BrokerMessage::Ask(BrokerAskRequest {
                token,
                questions: arguments
                    .get("questions")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            })),
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
                let conversation_id = required_string(arguments, "conversation_id")?;
                let operation_id = required_string(arguments, "operation_id")?;
                let text = required_string(arguments, "text")?;
                if text.trim().is_empty() {
                    return Err("text must not be empty".to_string());
                }
                Ok(BrokerMessage::SessionSend(BrokerSessionSendRequest {
                    token,
                    conversation_id,
                    operation_id,
                    text,
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
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            client::call_broker(&self.socket_path, &message),
        )
        .await;
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

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "vibex-mcp", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// Render a broker outcome as an MCP `CallToolResult`: a human/LLM-readable text
/// summary plus the full structured outcome.
fn render_result(outcome: &Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": summarize(outcome) }],
        "structuredContent": outcome,
        "isError": false,
    })
}

fn summarize(outcome: &Value) -> String {
    if let Some(text) = outcome.get("text").and_then(Value::as_str) {
        return text.to_string();
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
    use super::*;

    fn companion(features: &str) -> Arc<Companion> {
        Arc::new(Companion::new(Args {
            parent_connection_id: "conn-1".to_string(),
            socket_path: "/tmp/does-not-matter.sock".to_string(),
            token: "tok".to_string(),
            features: CompanionFeatures::parse(Some(features)),
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
        assert_eq!(value["id"], 1);
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
