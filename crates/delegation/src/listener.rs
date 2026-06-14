//! Main-process socket server bridging the `vibex-mcp` companion to the
//! in-process [`DelegationBroker`]. Accepts framed [`BrokerMessage`]s over a
//! UDS (unix) / named pipe (windows), authenticates the per-launch token,
//! resolves the parent's current session, and routes to the broker.

use std::{path::PathBuf, sync::Arc};

use agents::registry::agent_type_from_executor_key;
use delegation_proto::{
    BrokerMessage, BrokerRequest, BrokerResponse, BrokerStatusRequest, read_frame, write_frame,
};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    broker::{DelegationBroker, StatusWait, failed_setup_report, unknown_report},
    lookups::ParentSessionLookup,
    token_registry::TokenRegistry,
    types::{DelegationRequest, DelegationTaskReport},
};

/// Bridges companion connections to the broker.
#[derive(Clone)]
pub struct DelegationListener {
    broker: Arc<DelegationBroker>,
    tokens: Arc<TokenRegistry>,
    parent_lookup: Arc<dyn ParentSessionLookup>,
}

impl DelegationListener {
    pub fn new(
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        parent_lookup: Arc<dyn ParentSessionLookup>,
    ) -> Self {
        Self {
            broker,
            tokens,
            parent_lookup,
        }
    }

    /// Read one framed message, handle it, and write the framed reply.
    pub async fn serve_one<C>(&self, conn: &mut C) -> std::io::Result<()>
    where
        C: AsyncRead + AsyncWrite + Unpin,
    {
        let message: BrokerMessage = read_frame(conn).await?;
        let response = match message {
            BrokerMessage::Call(req) => {
                let report = self.process_call(req).await;
                BrokerResponse {
                    outcome: to_value(&report),
                }
            }
            BrokerMessage::Status(req) => self.process_status(req).await,
            BrokerMessage::CancelTask(req) => {
                let report = if self.tokens.lookup(&req.token).is_some() {
                    self.broker.cancel_delegation(&req.task_id).await
                } else {
                    unknown_report(&req.task_id)
                };
                BrokerResponse {
                    outcome: to_value(&report),
                }
            }
            // External-handle cancel (MCP notifications/cancelled). The
            // handle→task mapping rides on the deferred ACP correlation work
            // (M5); ack with null for now.
            BrokerMessage::Cancel(_) => BrokerResponse {
                outcome: Value::Null,
            },
            // Steering tools are implemented in M6; return empty/declined so the
            // companion can render a benign result meanwhile.
            BrokerMessage::Feedback(_) | BrokerMessage::CommitFeedback(_) => BrokerResponse {
                outcome: json!({ "count": 0, "feedback": [] }),
            },
            BrokerMessage::Ask(_) => BrokerResponse {
                outcome: json!({ "declined": true, "answers": [] }),
            },
        };
        write_frame(conn, &response).await
    }

    async fn process_call(&self, req: BrokerRequest) -> DelegationTaskReport {
        let entry = match self.tokens.lookup(&req.token) {
            Some(entry) => entry,
            None => return failed_setup_report("canceled", "invalid token"),
        };
        if entry.parent_connection_id != req.parent_connection_id {
            return failed_setup_report("canceled", "token does not match parent connection");
        }
        let parent_session_id = match self
            .parent_lookup
            .current_session_id(&entry.parent_connection_id)
            .await
        {
            Some(id) => id,
            None => return failed_setup_report("canceled", "parent has no active session"),
        };

        let agent_type = match req.input.get("agent_type").and_then(Value::as_str) {
            // The registry helper accepts the snake_case wire form the tool
            // schema emits (plus other casings), keeping the accepted set in sync
            // with the canonical AgentType mapping.
            Some(raw) => match agent_type_from_executor_key(raw) {
                Some(agent_type) => agent_type,
                None => {
                    return failed_setup_report(
                        "invalid_agent_type",
                        &format!("unknown agent type: {raw}"),
                    );
                }
            },
            None => return failed_setup_report("invalid_agent_type", "missing agent_type"),
        };
        let task = match req.input.get("task").and_then(Value::as_str) {
            Some(task) if !task.trim().is_empty() => task.to_string(),
            _ => return failed_setup_report("invalid_task", "missing or empty task"),
        };
        // An explicit blank working_dir means "use the default" — trim and treat
        // empty as absent so it falls back to the parent's launch dir (and so it
        // doesn't form a distinct correlation key from an omitted value).
        let requested_working_dir = req
            .input
            .get("working_dir")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .map(str::to_string);
        let working_dir = requested_working_dir
            .clone()
            .or_else(|| Some(entry.working_dir.to_string_lossy().to_string()));

        self.broker
            .start_delegation(DelegationRequest {
                parent_connection_id: req.parent_connection_id,
                parent_session_id,
                parent_tool_use_id: req.parent_tool_use_id,
                agent_type,
                task,
                working_dir,
                requested_working_dir,
                external_handle: req.external_handle,
            })
            .await
    }

    async fn process_status(&self, req: BrokerStatusRequest) -> BrokerResponse {
        if self.tokens.lookup(&req.token).is_none() {
            return BrokerResponse {
                outcome: json!({ "tasks": [] }),
            };
        }
        let wait = match req.wait_ms {
            None => StatusWait::Immediate,
            Some(0) => StatusWait::Infinite,
            Some(ms) => StatusWait::Bounded(ms),
        };
        let reports = self.broker.get_tasks_status(&req.task_ids, wait).await;
        BrokerResponse {
            outcome: json!({ "tasks": reports }),
        }
    }

    /// Accept connections forever, serving each on its own task.
    #[cfg(unix)]
    pub async fn run(self: Arc<Self>, socket_path: PathBuf) -> std::io::Result<()> {
        let _ = tokio::fs::remove_file(&socket_path).await;
        if let Some(parent) = socket_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let listener = tokio::net::UnixListener::bind(&socket_path)?;
        loop {
            match listener.accept().await {
                Ok((mut conn, _)) => {
                    let me = Arc::clone(&self);
                    tokio::spawn(async move {
                        if let Err(err) = me.serve_one(&mut conn).await {
                            tracing::debug!("delegation listener connection error: {err}");
                        }
                    });
                }
                Err(err) => tracing::warn!("delegation listener accept error: {err}"),
            }
        }
    }

    /// Accept connections forever over a Windows named pipe. The next pipe
    /// instance is created BEFORE serving the current one so clients never see a
    /// `NotFound` gap between accepts.
    #[cfg(windows)]
    pub async fn run(self: Arc<Self>, socket_path: PathBuf) -> std::io::Result<()> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let path = socket_path.to_string_lossy().to_string();
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)?;
        loop {
            // A transient connect error must not kill the accept loop (mirrors the
            // unix path's log-and-continue); recreate the instance and retry.
            if let Err(err) = server.connect().await {
                tracing::warn!("delegation listener accept error: {err}");
                server = ServerOptions::new().create(&path)?;
                continue;
            }
            let connected = server;
            // Rebind the next instance BEFORE serving so clients never see a
            // `NotFound` gap. A create failure here is fatal (the pipe name is
            // unusable), matching a unix bind failure.
            server = ServerOptions::new().create(&path)?;
            let me = Arc::clone(&self);
            tokio::spawn(async move {
                let mut conn = connected;
                if let Err(err) = me.serve_one(&mut conn).await {
                    tracing::debug!("delegation listener connection error: {err}");
                }
            });
        }
    }
}

/// Default per-process socket path. Unix: a `.sock` under the temp dir; Windows:
/// a named pipe scoped by pid.
#[cfg(unix)]
pub fn default_socket_path(temp_dir: &std::path::Path) -> PathBuf {
    temp_dir.join(format!("vibex-delegation-{}.sock", std::process::id()))
}

#[cfg(windows)]
pub fn default_socket_path(_temp_dir: &std::path::Path) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\vibex-delegation-{}", std::process::id()))
}

fn to_value(report: &DelegationTaskReport) -> Value {
    serde_json::to_value(report).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use async_trait::async_trait;
    use delegation_proto::BrokerMessage;
    use uuid::Uuid;

    use super::*;
    use crate::{
        testing::{
            MockDepthLookup, MockSpawner, MockStatusLookup, RecordingEventEmitter,
            RecordingMetaWriter,
        },
        token_registry::TokenEntry,
        types::DelegationConfig,
    };

    struct FixedParent(Option<Uuid>);

    #[async_trait]
    impl ParentSessionLookup for FixedParent {
        async fn current_session_id(&self, _parent_connection_id: &str) -> Option<Uuid> {
            self.0
        }
    }

    fn listener(parent_session: Option<Uuid>) -> (DelegationListener, Arc<TokenRegistry>) {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()),
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        ));
        let tokens = Arc::new(TokenRegistry::new());
        let listener = DelegationListener::new(
            broker,
            tokens.clone(),
            Arc::new(FixedParent(parent_session)),
        );
        (listener, tokens)
    }

    async fn round_trip(listener: &DelegationListener, message: BrokerMessage) -> BrokerResponse {
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        write_frame(&mut client, &message).await.unwrap();
        listener.serve_one(&mut server).await.unwrap();
        read_frame(&mut client).await.unwrap()
    }

    fn call(token: &str, parent_conn: &str) -> BrokerMessage {
        BrokerMessage::Call(BrokerRequest {
            token: token.to_string(),
            parent_connection_id: parent_conn.to_string(),
            parent_tool_use_id: "toolu_1".to_string(),
            external_handle: None,
            input: json!({ "agent_type": "codex", "task": "do it" }),
        })
    }

    #[tokio::test]
    async fn valid_call_starts_delegation() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                working_dir: PathBuf::from("/work"),
            },
        );

        let response = round_trip(&listener, call("tok", "conn-1")).await;
        assert_eq!(response.outcome["status"], "running");
        assert_eq!(response.outcome["agent_type"], "codex");
    }

    #[tokio::test]
    async fn invalid_token_is_rejected() {
        let (listener, _tokens) = listener(Some(Uuid::nil()));
        let response = round_trip(&listener, call("bad", "conn-1")).await;
        assert_eq!(response.outcome["status"], "canceled");
        assert_eq!(response.outcome["error_code"], "canceled");
    }

    #[tokio::test]
    async fn token_parent_mismatch_is_rejected() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                working_dir: PathBuf::from("/work"),
            },
        );
        // Token belongs to conn-1 but the request claims conn-2.
        let response = round_trip(&listener, call("tok", "conn-2")).await;
        assert_eq!(response.outcome["status"], "canceled");
    }

    #[tokio::test]
    async fn unknown_agent_type_is_rejected() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                working_dir: PathBuf::from("/work"),
            },
        );
        let bad = BrokerMessage::Call(BrokerRequest {
            token: "tok".to_string(),
            parent_connection_id: "conn-1".to_string(),
            parent_tool_use_id: String::new(),
            external_handle: None,
            input: json!({ "agent_type": "not_a_real_agent", "task": "x" }),
        });
        let response = round_trip(&listener, bad).await;
        assert_eq!(response.outcome["error_code"], "invalid_agent_type");
    }

    #[tokio::test]
    async fn status_returns_tasks_envelope() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                working_dir: PathBuf::from("/work"),
            },
        );
        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".to_string(),
            task_ids: vec!["nope".to_string()],
            wait_ms: None,
        });
        let response = round_trip(&listener, status).await;
        let tasks = response.outcome["tasks"].as_array().expect("tasks array");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["status"], "unknown");
    }
}
