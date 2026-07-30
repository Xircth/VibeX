//! Main-process socket server bridging the `vibex-mcp` companion to the
//! in-process [`DelegationBroker`]. Accepts framed [`BrokerMessage`]s over a
//! UDS (unix) / named pipe (windows), authenticates the per-launch token,
//! resolves the parent's current session, and routes to the broker.

use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use agents::AgentId;
use delegation_proto::{
    BrokerMessage, BrokerRequest, BrokerResponse, BrokerStatusRequest, read_frame, write_frame,
};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    broker::{DelegationBroker, StatusWait, failed_setup_report, unknown_report},
    lookups::ParentSessionLookup,
    steering::{NoopCompanionFeatures, SharedCompanionFeatures},
    token_registry::TokenRegistry,
    types::{DelegationRequest, DelegationScope, DelegationTaskReport},
};

/// Bridges companion connections to the broker.
#[derive(Clone)]
pub struct DelegationListener {
    broker: Arc<DelegationBroker>,
    tokens: Arc<TokenRegistry>,
    parent_lookup: Arc<dyn ParentSessionLookup>,
    features: SharedCompanionFeatures,
}

impl DelegationListener {
    pub fn new(
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        parent_lookup: Arc<dyn ParentSessionLookup>,
    ) -> Self {
        Self::new_with_features(
            broker,
            tokens,
            parent_lookup,
            Arc::new(NoopCompanionFeatures),
        )
    }

    pub fn new_with_features(
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        parent_lookup: Arc<dyn ParentSessionLookup>,
        features: SharedCompanionFeatures,
    ) -> Self {
        Self {
            broker,
            tokens,
            parent_lookup,
            features,
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
                let report = if let Some(entry) = self.tokens.lookup(&req.token) {
                    self.broker
                        .cancel_delegation(&scope_for(&entry), &req.task_id)
                        .await
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
            BrokerMessage::Feedback(req) => BrokerResponse {
                outcome: match self.tokens.lookup(&req.token) {
                    Some(entry) => self.features.feedback(&scope_for(&entry)).await,
                    None => json!({ "count": 0, "feedback": [] }),
                },
            },
            BrokerMessage::CommitFeedback(req) => {
                if let Some(entry) = self.tokens.lookup(&req.token) {
                    self.features
                        .commit_feedback(&scope_for(&entry), &req.ids)
                        .await;
                }
                BrokerResponse {
                    outcome: Value::Null,
                }
            }
            BrokerMessage::Ask(req) => BrokerResponse {
                outcome: match self.tokens.lookup(&req.token) {
                    Some(entry) => self.features.ask(&scope_for(&entry), req.questions).await,
                    None => json!({ "declined": true, "answers": [] }),
                },
            },
            BrokerMessage::SessionInfo(req) => BrokerResponse {
                outcome: match self.tokens.lookup(&req.token) {
                    Some(entry) => {
                        self.features
                            .session_info(
                                &scope_for(&entry),
                                &req.conversation_id,
                                req.max_messages.min(200),
                            )
                            .await
                    }
                    None => json!({
                        "found": false,
                        "conversation_id": req.conversation_id,
                    }),
                },
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
        if parent_session_id != entry.parent_conversation_id {
            return failed_setup_report("canceled", "token does not match parent conversation");
        }

        let agent_type = match req.input.get("agent_type").and_then(Value::as_str) {
            Some(raw) => match AgentId::parse(raw) {
                Ok(agent_type) => agent_type,
                Err(err) => {
                    return failed_setup_report("invalid_agent_type", &err.to_string());
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
        let working_dir =
            match resolve_working_dir(&entry.working_root, requested_working_dir.as_deref()) {
                Ok(path) => Some(path.to_string_lossy().to_string()),
                Err(message) => return failed_setup_report("invalid_working_dir", &message),
            };

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
        let Some(entry) = self.tokens.lookup(&req.token) else {
            return BrokerResponse {
                outcome: json!({ "tasks": [] }),
            };
        };
        let wait = match req.wait_ms {
            None => StatusWait::Immediate,
            Some(0) => StatusWait::Infinite,
            Some(ms) => StatusWait::Bounded(ms),
        };
        let reports = self
            .broker
            .get_tasks_status(&scope_for(&entry), &req.task_ids, wait)
            .await;
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

fn scope_for(entry: &crate::token_registry::TokenEntry) -> DelegationScope {
    DelegationScope {
        parent_connection_id: entry.parent_connection_id.clone(),
        parent_conversation_id: entry.parent_conversation_id,
    }
}

fn resolve_working_dir(root: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let root = normalize_absolute(root)
        .ok_or_else(|| "token working root must be absolute".to_string())?;
    let requested = requested.map(Path::new);
    let candidate = match requested {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(path) => root.join(path),
        None => root.clone(),
    };
    let candidate = normalize_absolute(&candidate)
        .ok_or_else(|| "working directory escapes token root".to_string())?;
    if !candidate.starts_with(&root) {
        return Err("working directory escapes token root".to_string());
    }
    Ok(candidate)
}

fn normalize_absolute(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Some(normalized)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use async_trait::async_trait;
    use delegation_proto::{BrokerCommitFeedbackRequest, BrokerFeedbackRequest, BrokerMessage};
    use uuid::Uuid;

    use super::*;
    use crate::{
        InMemoryCompanionFeatures,
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
        listener_with_features(parent_session, Arc::new(InMemoryCompanionFeatures::new()))
    }

    fn listener_with_features(
        parent_session: Option<Uuid>,
        features: Arc<InMemoryCompanionFeatures>,
    ) -> (DelegationListener, Arc<TokenRegistry>) {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()),
            Arc::new(MockDepthLookup::default()),
            Arc::new(MockStatusLookup::default()),
            Arc::new(RecordingMetaWriter::default()),
            Arc::new(RecordingEventEmitter::default()),
            DelegationConfig::default(),
        ));
        let tokens = Arc::new(TokenRegistry::new());
        let listener = DelegationListener::new_with_features(
            broker,
            tokens.clone(),
            Arc::new(FixedParent(parent_session)),
            features,
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
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );

        let response = round_trip(&listener, call("tok", "conn-1")).await;
        assert_eq!(response.outcome["status"], "running");
        assert_eq!(response.outcome["agent_type"], "codex");
    }

    #[tokio::test]
    async fn valid_open_agent_id_starts_delegation() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        let request = BrokerMessage::Call(BrokerRequest {
            token: "tok".to_string(),
            parent_connection_id: "conn-1".to_string(),
            parent_tool_use_id: "toolu_generic".to_string(),
            external_handle: None,
            input: json!({ "agent_type": "vendor.agent-v2", "task": "do it" }),
        });

        let response = round_trip(&listener, request).await;

        assert_eq!(response.outcome["status"], "running");
        assert_eq!(response.outcome["agent_type"], "vendor.agent-v2");
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
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        // Token belongs to conn-1 but the request claims conn-2.
        let response = round_trip(&listener, call("tok", "conn-2")).await;
        assert_eq!(response.outcome["status"], "canceled");
    }

    #[tokio::test]
    async fn token_conversation_mismatch_is_rejected() {
        let token_conversation_id = Uuid::new_v4();
        let (listener, tokens) = listener(Some(Uuid::new_v4()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: token_conversation_id,
                working_root: PathBuf::from("/work"),
            },
        );

        let response = round_trip(&listener, call("tok", "conn-1")).await;

        assert_eq!(response.outcome["status"], "canceled");
        assert_eq!(response.outcome["error_code"], "canceled");
    }

    #[tokio::test]
    async fn requested_working_dir_cannot_escape_token_root() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        let request = BrokerMessage::Call(BrokerRequest {
            token: "tok".to_string(),
            parent_connection_id: "conn-1".to_string(),
            parent_tool_use_id: "toolu_escape".to_string(),
            external_handle: None,
            input: json!({
                "agent_type": "codex",
                "task": "do it",
                "working_dir": "/outside"
            }),
        });

        let response = round_trip(&listener, request).await;

        assert_eq!(response.outcome["status"], "failed");
        assert_eq!(response.outcome["error_code"], "invalid_working_dir");
    }

    #[tokio::test]
    async fn syntactically_invalid_agent_id_is_rejected() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        let bad = BrokerMessage::Call(BrokerRequest {
            token: "tok".to_string(),
            parent_connection_id: "conn-1".to_string(),
            parent_tool_use_id: String::new(),
            external_handle: None,
            input: json!({ "agent_type": "NOT A VALID ID", "task": "x" }),
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
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
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

    #[tokio::test]
    async fn token_cannot_read_another_parents_task() {
        let (listener, tokens) = listener(Some(Uuid::nil()));
        for (token, parent) in [("token-a", "conn-a"), ("token-b", "conn-b")] {
            tokens.register(
                token.to_string(),
                TokenEntry {
                    parent_connection_id: parent.to_string(),
                    parent_conversation_id: Uuid::nil(),
                    working_root: PathBuf::from("/work"),
                },
            );
        }
        let task_b = round_trip(&listener, call("token-b", "conn-b")).await;
        let task_b_id = task_b.outcome["task_id"].as_str().unwrap().to_string();

        let response = round_trip(
            &listener,
            BrokerMessage::Status(BrokerStatusRequest {
                token: "token-a".to_string(),
                task_ids: vec![task_b_id],
                wait_ms: None,
            }),
        )
        .await;

        assert_eq!(response.outcome["tasks"][0]["status"], "unknown");
    }

    #[tokio::test]
    async fn feedback_is_delivered_at_least_once_until_committed() {
        let features = Arc::new(InMemoryCompanionFeatures::new());
        let (listener, tokens) = listener_with_features(Some(Uuid::nil()), features.clone());
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        let scope = DelegationScope {
            parent_connection_id: "conn-1".to_string(),
            parent_conversation_id: Uuid::nil(),
        };
        let feedback_id = features.push_feedback(scope, "change direction").await;

        let message = BrokerMessage::Feedback(BrokerFeedbackRequest {
            token: "tok".to_string(),
        });
        let first = round_trip(&listener, message.clone()).await;
        let second = round_trip(&listener, message).await;
        assert_eq!(first.outcome, second.outcome);
        assert_eq!(first.outcome["feedback"][0]["text"], "change direction");

        round_trip(
            &listener,
            BrokerMessage::CommitFeedback(BrokerCommitFeedbackRequest {
                token: "tok".to_string(),
                ids: vec![feedback_id],
            }),
        )
        .await;
        let after_commit = round_trip(
            &listener,
            BrokerMessage::Feedback(BrokerFeedbackRequest {
                token: "tok".to_string(),
            }),
        )
        .await;
        assert_eq!(after_commit.outcome["feedback"], json!([]));
    }

    #[tokio::test]
    async fn ask_blocks_until_a_structured_answer_arrives() {
        let features = Arc::new(InMemoryCompanionFeatures::new());
        let (listener, tokens) = listener_with_features(Some(Uuid::nil()), features.clone());
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        let scope = DelegationScope {
            parent_connection_id: "conn-1".to_string(),
            parent_conversation_id: Uuid::nil(),
        };
        let request = BrokerMessage::Ask(delegation_proto::BrokerAskRequest {
            token: "tok".to_string(),
            questions: json!([{
                "question": "Pick one",
                "header": "Choice",
                "multiSelect": false,
                "options": [
                    { "label": "A", "description": "first" },
                    { "label": "B", "description": "second" }
                ]
            }]),
        });
        let call = tokio::spawn({
            let listener = listener.clone();
            async move { round_trip(&listener, request).await }
        });

        let pending = features.next_question(&scope).await;
        features
            .answer_question(&pending.id, json!([{ "selected": ["A"] }]))
            .await
            .unwrap();
        let response = call.await.unwrap();

        assert_eq!(response.outcome["declined"], false);
        assert_eq!(response.outcome["answers"][0]["selected"][0], "A");
    }

    #[tokio::test]
    async fn session_info_resolves_only_with_its_feature_service() {
        let features = Arc::new(InMemoryCompanionFeatures::new());
        let (listener, tokens) = listener_with_features(Some(Uuid::nil()), features.clone());
        tokens.register(
            "tok".to_string(),
            TokenEntry {
                parent_connection_id: "conn-1".to_string(),
                parent_conversation_id: Uuid::nil(),
                working_root: PathBuf::from("/work"),
            },
        );
        let scope = DelegationScope {
            parent_connection_id: "conn-1".to_string(),
            parent_conversation_id: Uuid::nil(),
        };
        let referenced = Uuid::new_v4().to_string();
        features
            .register_session_info(
                scope,
                referenced.clone(),
                json!({ "found": true, "title": "Prior work" }),
            )
            .await;

        let response = round_trip(
            &listener,
            BrokerMessage::SessionInfo(delegation_proto::BrokerSessionRequest {
                token: "tok".to_string(),
                conversation_id: referenced,
                max_messages: 20,
            }),
        )
        .await;

        assert_eq!(response.outcome["found"], true);
        assert_eq!(response.outcome["title"], "Prior work");
    }
}
