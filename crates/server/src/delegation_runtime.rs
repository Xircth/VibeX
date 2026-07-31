use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::{
    AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentId, AgentRuntime,
    CompanionInjection, CompanionInjectionContext, DelegationInjector, InjectedMcpServer,
    events::DelegationResultSummary,
    ids::{AgentConnectionId, AgentSessionId},
    runtime::{CancelAgentPromptInput, ConnectAgentInput, SendAgentPromptInput},
};
use async_trait::async_trait;
use conversations::{CreateDelegatedConversation, create_delegated_conversation};
use db::models::session::Session;
use delegation::{
    ChildStatusLookup, ChildStatusRecord, ConnectionSpawner, DelegationBroker,
    DelegationCompletedEvent, DelegationConfig, DelegationError, DelegationEventEmitter,
    DelegationLink, DelegationListener, DelegationMetaWriter, DelegationOutcome,
    DelegationStartedEvent, DepthLookup, ParentSessionLookup, SpawnerError, TaskStatus, TokenEntry,
    TokenPermissions, TokenRegistry, outcome_from_turn,
};
use sqlx::SqlitePool;
use tokio::{
    sync::{Mutex, broadcast::error::RecvError},
    task::JoinHandle,
};
use uuid::Uuid;

type ResolverMap = Arc<Mutex<HashMap<Uuid, (String, AgentId)>>>;

pub(crate) struct HeadlessDelegationRuntime {
    tasks: Vec<JoinHandle<()>>,
}

impl HeadlessDelegationRuntime {
    pub(crate) fn start(runtime: Arc<AgentRuntime>, pool: SqlitePool) -> Self {
        let map = Arc::new(Mutex::new(HashMap::new()));
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(RuntimeSpawner {
                runtime: runtime.clone(),
                pool: pool.clone(),
                map: map.clone(),
            }),
            Arc::new(DbDepthLookup { pool: pool.clone() }),
            Arc::new(DbChildStatusLookup { pool }),
            Arc::new(NoopMetaWriter),
            Arc::new(RuntimeEventEmitter {
                runtime: runtime.clone(),
            }),
            DelegationConfig::default(),
        ));
        let tokens = Arc::new(TokenRegistry::new());
        let socket_path = process_socket_path();
        runtime.install_delegation_injector(Arc::new(HeadlessDelegationInjector {
            tokens: tokens.clone(),
            socket_path: socket_path.clone(),
        }));
        let listener = Arc::new(DelegationListener::new(
            broker.clone(),
            tokens.clone(),
            Arc::new(RuntimeParentLookup {
                runtime: runtime.clone(),
            }),
        ));
        let listen_path = socket_path.clone();
        let listener_task = tokio::spawn(async move {
            if let Err(error) = listener.run(listen_path).await {
                tracing::warn!(%error, "headless delegation listener stopped");
            }
        });
        let resolver_task = spawn_resolver(broker.clone(), runtime.clone(), map);
        let teardown_task = spawn_parent_teardown(broker.clone(), tokens.clone(), runtime);

        Self {
            tasks: vec![listener_task, resolver_task, teardown_task],
        }
    }
}

impl Drop for HeadlessDelegationRuntime {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

struct RuntimeSpawner {
    runtime: Arc<AgentRuntime>,
    pool: SqlitePool,
    map: ResolverMap,
}

#[async_trait]
impl ConnectionSpawner for RuntimeSpawner {
    async fn spawn(
        &self,
        parent_connection_id: &str,
        agent_type: AgentId,
        working_dir: Option<String>,
    ) -> Result<String, SpawnerError> {
        let parent_id = parse_connection(parent_connection_id)
            .ok_or_else(|| SpawnerError::Spawn("invalid parent connection".to_string()))?;
        let snapshot = self.runtime.snapshot().await;
        let parent = snapshot
            .connections
            .iter()
            .find(|connection| connection.id == parent_id)
            .ok_or_else(|| SpawnerError::Spawn("parent connection not found".to_string()))?;
        let launch = conversations::resolve_agent_runtime_launch_settings(&self.pool, &agent_type)
            .await
            .map_err(|error| SpawnerError::Spawn(error.to_string()))?;
        let child = self
            .runtime
            .connect(ConnectAgentInput {
                agent_id: agent_type,
                launch_lock: launch.launch_lock,
                workspace_id: parent.workspace_id,
                working_dir: working_dir
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(&parent.working_dir)),
                additional_directories: Vec::new(),
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env,
            })
            .await
            .map_err(|error| SpawnerError::Spawn(error.to_string()))?;
        Ok(child.id.to_string())
    }

    async fn send_prompt_linked(
        &self,
        child_connection_id: &str,
        task: String,
        link: DelegationLink,
    ) -> Result<Uuid, SpawnerError> {
        let connection_id = parse_connection(child_connection_id)
            .ok_or_else(|| SpawnerError::Other("invalid child connection".to_string()))?;
        let child_id = Uuid::new_v4();
        create_delegated_conversation(
            &self.pool,
            CreateDelegatedConversation {
                id: child_id,
                parent_conversation_id: link.parent_session_id,
                parent_tool_call_id: link.parent_tool_use_id,
                delegation_id: link.delegation_call_id.clone(),
                agent_id: link.agent_type.clone(),
                prompt: task.clone(),
            },
        )
        .await
        .map_err(|error| SpawnerError::SendPrompt(error.to_string()))?;
        let session_id = AgentSessionId::from(child_id);
        self.runtime
            .new_session_with_id(connection_id, session_id, child_id.to_string())
            .await
            .map_err(|error| SpawnerError::SendPromptAfterLink {
                child_session_id: child_id,
                message: error.to_string(),
            })?;
        self.map
            .lock()
            .await
            .insert(child_id, (link.delegation_call_id.clone(), link.agent_type));
        if let Err(error) = self
            .runtime
            .send_prompt(SendAgentPromptInput {
                connection_id,
                session_id,
                blocks: vec![AgentContentBlock::Text { text: task }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
        {
            self.map.lock().await.remove(&child_id);
            return Err(SpawnerError::SendPromptAfterLink {
                child_session_id: child_id,
                message: error.to_string(),
            });
        }
        Ok(child_id)
    }

    async fn cancel(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        let connection_id = parse_connection(child_connection_id)
            .ok_or_else(|| SpawnerError::Other("invalid child connection".to_string()))?;
        let snapshot = self.runtime.snapshot().await;
        if let Some(session) = snapshot
            .sessions
            .iter()
            .find(|session| session.connection_id == connection_id)
            && let Some(prompt_id) = session.active_prompt_id
        {
            let _ = self
                .runtime
                .cancel_prompt(CancelAgentPromptInput {
                    connection_id,
                    session_id: session.id,
                    prompt_id,
                })
                .await;
        }
        Ok(())
    }

    async fn release_child(&self, child_session_id: Uuid) -> Result<(), SpawnerError> {
        self.map.lock().await.remove(&child_session_id);
        Ok(())
    }

    async fn disconnect(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        let connection_id = parse_connection(child_connection_id)
            .ok_or_else(|| SpawnerError::Other("invalid child connection".to_string()))?;
        let _ = self.runtime.disconnect(connection_id).await;
        Ok(())
    }
}

struct DbDepthLookup {
    pool: SqlitePool,
}

#[async_trait]
impl DepthLookup for DbDepthLookup {
    async fn parent_session_id(&self, id: Uuid) -> Result<Option<Uuid>, DelegationError> {
        Session::find_by_id(&self.pool, id)
            .await
            .map(|session| session.and_then(|session| session.parent_session_id))
            .map_err(|error| DelegationError::SubagentRuntimeError(error.to_string()))
    }
}

struct DbChildStatusLookup {
    pool: SqlitePool,
}

#[async_trait]
impl ChildStatusLookup for DbChildStatusLookup {
    async fn status_by_call_id(&self, call_id: &str) -> Option<ChildStatusRecord> {
        let session = Session::find_by_delegation_call_id(&self.pool, call_id)
            .await
            .ok()??;
        let status = sqlx::query_scalar::<_, String>(
            r#"SELECT event_kind FROM conversation_events
               WHERE conversation_id = ? AND event_kind IN
                 ('turn_completed','turn_failed','turn_cancelled','turn_interrupted')
               ORDER BY sequence DESC LIMIT 1"#,
        )
        .bind(session.id)
        .fetch_optional(&self.pool)
        .await
        .ok()
        .flatten()
        .map(|kind| match kind.as_str() {
            "turn_completed" => TaskStatus::Completed,
            "turn_cancelled" => TaskStatus::Canceled,
            "turn_failed" | "turn_interrupted" => TaskStatus::Failed,
            _ => TaskStatus::Running,
        })
        .unwrap_or(TaskStatus::Running);
        Some(ChildStatusRecord {
            child_session_id: session.id,
            parent_conversation_id: session.parent_session_id,
            status,
            agent_type: session.agent_id,
        })
    }
}

struct RuntimeParentLookup {
    runtime: Arc<AgentRuntime>,
}

#[async_trait]
impl ParentSessionLookup for RuntimeParentLookup {
    async fn contains_session(&self, parent_connection_id: &str, conversation_id: Uuid) -> bool {
        let Some(connection_id) = parse_connection(parent_connection_id) else {
            return false;
        };
        self.runtime
            .snapshot()
            .await
            .sessions
            .iter()
            .any(|session| {
                session.connection_id == connection_id && session.id.0 == conversation_id
            })
    }
}

struct RuntimeEventEmitter {
    runtime: Arc<AgentRuntime>,
}

#[async_trait]
impl DelegationEventEmitter for RuntimeEventEmitter {
    async fn emit_started(&self, event: DelegationStartedEvent) {
        let Some(connection_id) = parse_connection(&event.parent_connection_id) else {
            return;
        };
        self.runtime
            .emit_external(
                connection_id,
                Some(AgentSessionId::from(event.parent_conversation_id)),
                AgentEvent::DelegationStarted {
                    delegation_id: event.delegation_id,
                    parent_tool_use_id: event.parent_tool_use_id,
                    child_session_id: event.child_session_id,
                    agent_id: event.agent_type,
                    task_preview: event.task_preview,
                },
            )
            .await;
    }

    async fn emit_completed(&self, event: DelegationCompletedEvent) {
        let Some(connection_id) = parse_connection(&event.parent_connection_id) else {
            return;
        };
        let result = match event.outcome {
            DelegationOutcome::Ok(success) => DelegationResultSummary::Ok {
                duration_ms: Some(success.duration_ms),
                text_preview: Some(preview(&success.text)),
            },
            DelegationOutcome::Err { code, .. } => {
                DelegationResultSummary::Err { error_code: code }
            }
        };
        self.runtime
            .emit_external(
                connection_id,
                Some(AgentSessionId::from(event.parent_conversation_id)),
                AgentEvent::DelegationCompleted {
                    delegation_id: event.delegation_id,
                    parent_tool_use_id: event.parent_tool_use_id,
                    child_session_id: event.child_session_id,
                    agent_id: event.agent_type,
                    result,
                },
            )
            .await;
    }
}

struct NoopMetaWriter;

#[async_trait]
impl DelegationMetaWriter for NoopMetaWriter {
    async fn write_meta(
        &self,
        _parent_connection_id: &str,
        _parent_tool_use_id: &str,
        _meta: serde_json::Value,
    ) {
    }
}

#[derive(Debug)]
struct HeadlessDelegationInjector {
    tokens: Arc<TokenRegistry>,
    socket_path: PathBuf,
}

impl DelegationInjector for HeadlessDelegationInjector {
    fn companion(&self, context: CompanionInjectionContext<'_>) -> CompanionInjection {
        if !context.capabilities.accepts_session_mcp_servers {
            return CompanionInjection::Unsupported {
                code: "delegation_parent_unsupported",
            };
        }
        let token = Uuid::new_v4().to_string();
        self.tokens.register_with_permissions(
            token.clone(),
            TokenEntry {
                parent_connection_id: context.parent_connection_id.to_string(),
                parent_conversation_id: context.parent_conversation_id,
                working_root: context.working_root.to_path_buf(),
            },
            TokenPermissions {
                delegation: true,
                ..TokenPermissions::default()
            },
        );
        CompanionInjection::Injected(InjectedMcpServer {
            name: "vibex-mcp".to_string(),
            command: locate_companion(),
            args: vec![
                "--parent-connection-id".to_string(),
                context.parent_connection_id.to_string(),
                "--socket-path".to_string(),
                self.socket_path.to_string_lossy().into_owned(),
                "--token".to_string(),
                token,
                "--features".to_string(),
                "delegation".to_string(),
            ],
        })
    }
}

fn spawn_resolver(
    broker: Arc<DelegationBroker>,
    runtime: Arc<AgentRuntime>,
    map: ResolverMap,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut receiver = runtime.subscribe_events();
        let mut text = HashMap::<Uuid, String>::new();
        loop {
            let envelope = match receiver.recv().await {
                Ok(envelope) => envelope,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            };
            let Some(session_id) = envelope.session_id.map(|id| id.0) else {
                continue;
            };
            match envelope.event {
                AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text { text: chunk },
                } if map.lock().await.contains_key(&session_id) => {
                    text.entry(session_id).or_default().push_str(&chunk);
                }
                AgentEvent::PromptFinished { finished } => {
                    if let Some((call_id, agent_type)) = map.lock().await.remove(&session_id) {
                        broker
                            .complete_call(
                                &call_id,
                                outcome_from_turn(
                                    finished.stop_reason.as_deref(),
                                    text.remove(&session_id).unwrap_or_default(),
                                    session_id,
                                    agent_type,
                                    1,
                                    0,
                                ),
                            )
                            .await;
                    }
                }
                _ => {}
            }
        }
    })
}

fn spawn_parent_teardown(
    broker: Arc<DelegationBroker>,
    tokens: Arc<TokenRegistry>,
    runtime: Arc<AgentRuntime>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut receiver = runtime.subscribe_events();
        loop {
            let envelope = match receiver.recv().await {
                Ok(envelope) => envelope,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            };
            let AgentEvent::ConnectionStatusChanged { snapshot } = envelope.event else {
                continue;
            };
            if matches!(
                snapshot.status,
                AgentConnectionStatus::Disconnected | AgentConnectionStatus::Failed
            ) {
                let parent = snapshot.id.to_string();
                tokens.revoke_by_parent(&parent);
                broker.parent_closed(&parent).await;
            }
        }
    })
}

fn parse_connection(id: &str) -> Option<AgentConnectionId> {
    Uuid::parse_str(id).ok().map(AgentConnectionId::from)
}

#[cfg(unix)]
fn process_socket_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "vibex-delegation-{}-{}.sock",
        std::process::id(),
        Uuid::new_v4()
    ))
}

#[cfg(windows)]
fn process_socket_path() -> PathBuf {
    PathBuf::from(format!(
        r"\\.\pipe\vibex-delegation-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ))
}

fn locate_companion() -> PathBuf {
    let name = if cfg!(windows) {
        "vibex-mcp.exe"
    } else {
        "vibex-mcp"
    };
    if let Ok(path) = std::env::var("VIBEX_MCP_BIN") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return path;
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| Path::new(name).to_path_buf())
}

fn preview(text: &str) -> String {
    const LIMIT: usize = 200;
    if text.len() <= LIMIT {
        return text.to_string();
    }
    let mut end = LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}
