use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::Arc,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast, mpsc};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager,
    AgentConnectionManagerEvent, AgentContentBlock, AgentError, AgentEvent, AgentEventEnvelope,
    AgentPermissionId, AgentPermissionResponse, AgentPromptId, AgentPromptQueue,
    AgentPromptSnapshot, AgentPromptStatus, AgentRegistryEntry, AgentResult, AgentSessionId,
    AgentSessionSnapshot, AgentSessionStatus, AgentType, QueueTransition, registry_entry,
    state::{AgentConnectionSnapshot, AgentConnectionStatus},
};

pub trait RuntimeEventSink: Send + Sync + 'static {
    fn emit(&self, envelope: AgentEventEnvelope);
}

#[derive(Default)]
pub struct NoopEventSink;

impl RuntimeEventSink for NoopEventSink {
    fn emit(&self, _envelope: AgentEventEnvelope) {}
}

#[derive(Debug, Clone)]
pub struct ConnectAgentInput {
    pub agent_type: AgentType,
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SendAgentPromptInput {
    pub connection_id: AgentConnectionId,
    pub session_id: AgentSessionId,
    pub blocks: Vec<AgentContentBlock>,
}

#[derive(Debug, Clone)]
pub struct CancelAgentPromptInput {
    pub connection_id: AgentConnectionId,
    pub session_id: AgentSessionId,
    pub prompt_id: AgentPromptId,
}

#[derive(Debug, Clone)]
pub struct RespondAgentPermissionInput {
    pub connection_id: AgentConnectionId,
    pub permission_id: AgentPermissionId,
    pub response: AgentPermissionResponse,
}

#[derive(Debug, Clone)]
pub struct EnsureAgentSessionInput {
    pub agent_type: AgentType,
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
    pub session_id: AgentSessionId,
    pub acp_session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RuntimeSnapshot {
    pub sequence: i64,
    pub registry: Vec<AgentRegistryEntry>,
    pub connections: Vec<AgentConnectionSnapshot>,
    pub sessions: Vec<AgentSessionSnapshot>,
    pub prompts: Vec<AgentPromptSnapshot>,
    pub events: Vec<AgentEventEnvelope>,
}

#[derive(Debug)]
struct RuntimeConnection {
    snapshot: AgentConnectionSnapshot,
}

#[derive(Debug)]
struct RuntimeSession {
    snapshot: AgentSessionSnapshot,
    queue: AgentPromptQueue,
}

#[derive(Debug, Default)]
struct RuntimeState {
    sequence: i64,
    connections: HashMap<AgentConnectionId, RuntimeConnection>,
    sessions: HashMap<AgentSessionId, RuntimeSession>,
    prompts: HashMap<AgentPromptId, AgentPromptSnapshot>,
    prompt_blocks: HashMap<AgentPromptId, Vec<AgentContentBlock>>,
    recent_events: VecDeque<AgentEventEnvelope>,
}

const MAX_RECENT_EVENTS: usize = 2_000;

pub struct AgentRuntime {
    state: Arc<RwLock<RuntimeState>>,
    connection_manager: Arc<AgentConnectionManager>,
    event_sink: Arc<dyn RuntimeEventSink>,
    event_tx: broadcast::Sender<AgentEventEnvelope>,
}

impl Default for AgentRuntime {
    fn default() -> Self {
        Self::new(Arc::new(NoopEventSink))
    }
}

impl AgentRuntime {
    pub fn new(event_sink: Arc<dyn RuntimeEventSink>) -> Self {
        Self::new_with_driver(event_sink, true)
    }

    fn new_with_driver(event_sink: Arc<dyn RuntimeEventSink>, driver_enabled: bool) -> Self {
        let (event_tx, _) = broadcast::channel(512);
        let (manager_event_tx, manager_event_rx) = mpsc::unbounded_channel();
        let state = Arc::new(RwLock::new(RuntimeState::default()));
        let connection_manager = Arc::new(AgentConnectionManager::new_with_driver(
            manager_event_tx,
            driver_enabled,
        ));
        let runtime = Self {
            state: Arc::clone(&state),
            connection_manager: Arc::clone(&connection_manager),
            event_sink: Arc::clone(&event_sink),
            event_tx: event_tx.clone(),
        };
        Self::spawn_manager_event_pump(
            state,
            connection_manager,
            event_sink,
            event_tx,
            manager_event_rx,
        );
        runtime
    }

    fn spawn_manager_event_pump(
        state: Arc<RwLock<RuntimeState>>,
        connection_manager: Arc<AgentConnectionManager>,
        event_sink: Arc<dyn RuntimeEventSink>,
        event_tx: broadcast::Sender<AgentEventEnvelope>,
        mut manager_event_rx: mpsc::UnboundedReceiver<AgentConnectionManagerEvent>,
    ) {
        tokio::spawn(async move {
            while let Some(manager_event) = manager_event_rx.recv().await {
                let next_prompt = {
                    let mut state = state.write().await;
                    Self::apply_manager_event_locked(&mut state, &manager_event);
                    let next_prompt = manager_event.session_id.and_then(|session_id| {
                        let prompt_id = state
                            .sessions
                            .get(&session_id)
                            .and_then(|session| session.queue.active())?;
                        let blocks = state.prompt_blocks.get(&prompt_id).cloned()?;
                        Some((session_id, prompt_id, blocks))
                    });
                    Self::emit_with_parts_locked(
                        &mut state,
                        &*event_sink,
                        &event_tx,
                        manager_event.connection_id,
                        manager_event.session_id,
                        manager_event.event,
                    );
                    next_prompt
                };

                if let Some((session_id, prompt_id, blocks)) = next_prompt {
                    let _ = connection_manager
                        .send_prompt(manager_event.connection_id, session_id, prompt_id, blocks)
                        .await;
                }
            }
        });
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<AgentEventEnvelope> {
        self.event_tx.subscribe()
    }

    pub fn registry(&self) -> Vec<AgentRegistryEntry> {
        crate::registry::all_agent_types()
            .into_iter()
            .map(registry_entry)
            .collect()
    }

    pub async fn snapshot(&self) -> RuntimeSnapshot {
        let state = self.state.read().await;
        RuntimeSnapshot {
            sequence: state.sequence,
            registry: self.registry(),
            connections: state
                .connections
                .values()
                .map(|connection| connection.snapshot.clone())
                .collect(),
            sessions: state
                .sessions
                .values()
                .map(|session| session.snapshot.clone())
                .collect(),
            prompts: state.prompts.values().cloned().collect(),
            events: state.recent_events.iter().cloned().collect(),
        }
    }

    pub async fn connect(&self, input: ConnectAgentInput) -> AgentResult<AgentConnectionSnapshot> {
        let now = Utc::now();
        let snapshot = AgentConnectionSnapshot {
            id: AgentConnectionId::new(),
            agent_type: input.agent_type,
            workspace_id: input.workspace_id,
            status: AgentConnectionStatus::Connecting,
            working_dir: input.working_dir.display().to_string(),
            status_message: None,
            created_at: now,
            updated_at: now,
        };

        let mut state = self.state.write().await;
        state.connections.insert(
            snapshot.id,
            RuntimeConnection {
                snapshot: snapshot.clone(),
            },
        );
        self.emit_locked(
            &mut state,
            snapshot.workspace_id,
            snapshot.id,
            None,
            AgentEvent::ConnectionStatusChanged {
                snapshot: snapshot.clone(),
            },
        );
        drop(state);

        self.connection_manager
            .register_connection(AgentConnectionLaunch {
                connection_id: snapshot.id,
                agent_type: snapshot.agent_type,
                workspace_id: snapshot.workspace_id,
                working_dir: input.working_dir,
            })
            .await;

        let mut state = self.state.write().await;
        let ready_snapshot = if let Some(connection) = state.connections.get_mut(&snapshot.id) {
            connection.snapshot.status = AgentConnectionStatus::Ready;
            connection.snapshot.updated_at = Utc::now();
            Some(connection.snapshot.clone())
        } else {
            None
        };
        let returned_snapshot = ready_snapshot.clone().unwrap_or(snapshot);
        if let Some(ready_snapshot) = ready_snapshot {
            self.emit_locked(
                &mut state,
                ready_snapshot.workspace_id,
                ready_snapshot.id,
                None,
                AgentEvent::ConnectionStatusChanged {
                    snapshot: ready_snapshot,
                },
            );
        }

        Ok(returned_snapshot)
    }

    pub async fn new_session(
        &self,
        connection_id: AgentConnectionId,
        acp_session_id: impl Into<String>,
    ) -> AgentResult<AgentSessionSnapshot> {
        self.new_session_with_id(connection_id, AgentSessionId::new(), acp_session_id)
            .await
    }

    pub async fn new_session_with_id(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        acp_session_id: impl Into<String>,
    ) -> AgentResult<AgentSessionSnapshot> {
        let now = Utc::now();
        let mut state = self.state.write().await;
        let workspace_id = state
            .connections
            .get(&connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;
        let snapshot = AgentSessionSnapshot {
            id: session_id,
            connection_id,
            acp_session_id: acp_session_id.into(),
            status: AgentSessionStatus::Ready,
            active_prompt_id: None,
            queued_prompt_ids: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        state.sessions.insert(
            snapshot.id,
            RuntimeSession {
                snapshot: snapshot.clone(),
                queue: AgentPromptQueue::default(),
            },
        );
        self.emit_locked(
            &mut state,
            workspace_id,
            connection_id,
            Some(snapshot.id),
            AgentEvent::SessionCreated {
                snapshot: snapshot.clone(),
            },
        );
        Ok(snapshot)
    }

    pub async fn ensure_session(
        &self,
        input: EnsureAgentSessionInput,
    ) -> AgentResult<AgentSessionSnapshot> {
        if let Some(existing) = self.state.read().await.sessions.get(&input.session_id) {
            return Ok(existing.snapshot.clone());
        }

        let existing_connection = {
            let state = self.state.read().await;
            state
                .connections
                .values()
                .find(|connection| {
                    connection.snapshot.agent_type == input.agent_type
                        && connection.snapshot.workspace_id == input.workspace_id
                        && connection.snapshot.working_dir == input.working_dir.display().to_string()
                })
                .map(|connection| connection.snapshot.id)
        };

        let connection_id = match existing_connection {
            Some(connection_id) => connection_id,
            None => {
                self.connect(ConnectAgentInput {
                    agent_type: input.agent_type,
                    workspace_id: input.workspace_id,
                    working_dir: input.working_dir,
                })
                .await?
                .id
            }
        };

        self.new_session_with_id(connection_id, input.session_id, input.acp_session_id)
            .await
    }

    pub async fn send_prompt(
        &self,
        input: SendAgentPromptInput,
    ) -> AgentResult<AgentPromptSnapshot> {
        if input.blocks.is_empty() {
            return Err(AgentError::Runtime(
                "prompt must include at least one content block".to_string(),
            ));
        }

        let now = Utc::now();
        let mut state = self.state.write().await;
        let workspace_id = state
            .connections
            .get(&input.connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .ok_or_else(|| AgentError::ConnectionNotFound(input.connection_id.to_string()))?;
        let prompt_id = AgentPromptId::new();
        let transition = {
            let session = state
                .sessions
                .get_mut(&input.session_id)
                .ok_or_else(|| AgentError::SessionNotFound(input.session_id.to_string()))?;
            if session.snapshot.connection_id != input.connection_id {
                return Err(AgentError::SessionNotFound(input.session_id.to_string()));
            }
            let transition = session.queue.submit(prompt_id);
            session.snapshot.active_prompt_id = session.queue.active();
            session.snapshot.queued_prompt_ids = session.queue.queued();
            session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
                AgentSessionStatus::Running
            } else {
                AgentSessionStatus::Ready
            };
            session.snapshot.updated_at = now;
            transition
        };
        let status = match transition {
            QueueTransition::Started { .. } => AgentPromptStatus::Running,
            QueueTransition::Queued { .. } => AgentPromptStatus::Queued,
            _ => AgentPromptStatus::Failed {
                message: "invalid prompt queue transition".to_string(),
            },
        };

        let blocks = input.blocks;
        let prompt = AgentPromptSnapshot {
            id: prompt_id,
            session_id: input.session_id,
            status,
            text_preview: preview_text_from_blocks(&blocks),
            created_at: now,
            updated_at: now,
        };
        state.prompts.insert(prompt.id, prompt.clone());
        state.prompt_blocks.insert(prompt.id, blocks.clone());
        self.emit_locked(
            &mut state,
            workspace_id,
            input.connection_id,
            Some(input.session_id),
            AgentEvent::PromptStarted {
                snapshot: prompt.clone(),
            },
        );
        drop(state);

        if matches!(prompt.status, AgentPromptStatus::Running) {
            self.connection_manager
                .send_prompt(input.connection_id, input.session_id, prompt.id, blocks)
                .await?;
        }

        Ok(prompt)
    }

    pub async fn cancel_prompt(&self, input: CancelAgentPromptInput) -> AgentResult<()> {
        let now = Utc::now();
        let mut state = self.state.write().await;
        let _workspace_id = state
            .connections
            .get(&input.connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .ok_or_else(|| AgentError::ConnectionNotFound(input.connection_id.to_string()))?;
        let transition = {
            let session = state
                .sessions
                .get_mut(&input.session_id)
                .ok_or_else(|| AgentError::SessionNotFound(input.session_id.to_string()))?;
            if session.snapshot.connection_id != input.connection_id {
                return Err(AgentError::SessionNotFound(input.session_id.to_string()));
            }
            let was_active = session.queue.active() == Some(input.prompt_id);
            let transition = session.queue.cancel(input.prompt_id);
            session.snapshot.active_prompt_id = session.queue.active();
            session.snapshot.queued_prompt_ids = session.queue.queued();
            session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
                AgentSessionStatus::Running
            } else {
                AgentSessionStatus::Ready
            };
            session.snapshot.updated_at = now;
            (transition, was_active)
        };

        let (transition, was_active) = transition;

        match transition {
            QueueTransition::Cancelled { .. } => {
                if let Some(prompt) = state.prompts.get_mut(&input.prompt_id) {
                    prompt.status = if was_active {
                        AgentPromptStatus::Cancelling
                    } else {
                        AgentPromptStatus::Completed {
                            stop_reason: Some("cancelled".to_string()),
                        }
                    };
                    prompt.updated_at = now;
                }
                if !was_active {
                    state.prompt_blocks.remove(&input.prompt_id);
                }
                Self::emit_with_parts_locked(
                    &mut state,
                    &*self.event_sink,
                    &self.event_tx,
                    input.connection_id,
                    Some(input.session_id),
                    if was_active {
                        AgentEvent::RawAcpDiagnostic {
                            raw: serde_json::json!({
                                "kind": "prompt_cancel_requested",
                                "prompt_id": input.prompt_id,
                            }),
                        }
                    } else {
                        AgentEvent::PromptFinished {
                            finished: crate::AgentPromptFinished {
                                prompt_id: input.prompt_id,
                                stop_reason: Some("cancelled".to_string()),
                            },
                        }
                    },
                );
                drop(state);

                if was_active {
                    self.connection_manager
                        .cancel_prompt(input.connection_id, input.session_id, input.prompt_id)
                        .await?;
                }

                Ok(())
            }
            QueueTransition::Missing { .. } => {
                Err(AgentError::PromptNotFound(input.prompt_id.to_string()))
            }
            _ => Err(AgentError::Runtime(
                "invalid prompt cancel transition".to_string(),
            )),
        }
    }

    pub async fn respond_permission(&self, input: RespondAgentPermissionInput) -> AgentResult<()> {
        self.connection_manager
            .respond_permission(input.connection_id, input.permission_id, input.response)
            .await
    }

    fn emit_locked(
        &self,
        state: &mut RuntimeState,
        _workspace_id: Uuid,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        event: AgentEvent,
    ) {
        Self::emit_with_parts_locked(
            state,
            &*self.event_sink,
            &self.event_tx,
            connection_id,
            session_id,
            event,
        );
    }

    fn emit_with_parts_locked(
        state: &mut RuntimeState,
        event_sink: &dyn RuntimeEventSink,
        event_tx: &broadcast::Sender<AgentEventEnvelope>,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        event: AgentEvent,
    ) {
        let workspace_id = state
            .connections
            .get(&connection_id)
            .map(|connection| connection.snapshot.workspace_id)
            .unwrap_or_else(Uuid::nil);
        state.sequence += 1;
        let envelope = AgentEventEnvelope {
            sequence: state.sequence,
            workspace_id,
            connection_id,
            session_id,
            event,
            created_at: Utc::now(),
        };
        state.recent_events.push_back(envelope.clone());
        while state.recent_events.len() > MAX_RECENT_EVENTS {
            state.recent_events.pop_front();
        }
        event_sink.emit(envelope.clone());
        let _ = event_tx.send(envelope);
    }

    fn apply_manager_event_locked(
        state: &mut RuntimeState,
        manager_event: &AgentConnectionManagerEvent,
    ) {
        match &manager_event.event {
            AgentEvent::PromptFinished { finished } => {
                if let Some(prompt) = state.prompts.get_mut(&finished.prompt_id) {
                    prompt.status = AgentPromptStatus::Completed {
                        stop_reason: finished.stop_reason.clone(),
                    };
                    prompt.updated_at = Utc::now();
                }
                if let Some(session_id) = manager_event.session_id
                    && let Some(session) = state.sessions.get_mut(&session_id)
                {
                    let _ = session.queue.complete(finished.prompt_id);
                    session.snapshot.active_prompt_id = session.queue.active();
                    session.snapshot.queued_prompt_ids = session.queue.queued();
                    session.snapshot.status = if session.snapshot.active_prompt_id.is_some() {
                        AgentSessionStatus::Running
                    } else {
                        AgentSessionStatus::Ready
                    };
                    session.snapshot.updated_at = Utc::now();
                    if let Some(next_prompt_id) = session.snapshot.active_prompt_id
                        && let Some(next_prompt) = state.prompts.get_mut(&next_prompt_id)
                    {
                        next_prompt.status = AgentPromptStatus::Running;
                        next_prompt.updated_at = Utc::now();
                    }
                }
                state.prompt_blocks.remove(&finished.prompt_id);
            }
            AgentEvent::Error { error } => {
                if let Some(prompt_id) = manager_event.prompt_id
                    && let Some(prompt) = state.prompts.get_mut(&prompt_id)
                {
                    prompt.status = AgentPromptStatus::Failed {
                        message: error.message.clone(),
                    };
                    prompt.updated_at = Utc::now();
                }
            }
            _ => {}
        }
    }
}

fn preview_text(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 240;
    let trimmed = text.trim();
    let mut preview = trimmed.chars().take(MAX_PREVIEW_CHARS).collect::<String>();
    if trimmed.chars().count() > MAX_PREVIEW_CHARS {
        preview.push_str("...");
    }
    preview
}

fn preview_text_from_blocks(blocks: &[AgentContentBlock]) -> String {
    let text = blocks
        .iter()
        .find_map(|block| match block {
            AgentContentBlock::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_else(|| {
            if blocks.iter().any(|block| matches!(block, AgentContentBlock::Image { .. })) {
                "[image]"
            } else {
                ""
            }
        });

    preview_text(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct RecordingSink {
        events: Mutex<Vec<AgentEventEnvelope>>,
    }

    impl RuntimeEventSink for RecordingSink {
        fn emit(&self, envelope: AgentEventEnvelope) {
            self.events.lock().unwrap().push(envelope);
        }
    }

    #[tokio::test]
    async fn runtime_lists_registry_and_creates_connection_session_prompt() {
        let sink = Arc::new(RecordingSink {
            events: Mutex::new(Vec::new()),
        });
        let runtime = AgentRuntime::new_with_driver(sink.clone(), false);

        assert_eq!(runtime.registry().len(), 7);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_type: AgentType::Codex,
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let prompt = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "hello".to_string(),
                }],
            })
            .await
            .unwrap();

        assert!(matches!(prompt.status, AgentPromptStatus::Running));
        let snapshot = runtime.snapshot().await;
        assert_eq!(snapshot.connections.len(), 1);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.prompts.len(), 1);
        assert!(sink.events.lock().unwrap().len() >= 4);
    }

    #[tokio::test]
    async fn runtime_cancels_active_prompt_and_advances_queue() {
        let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
        let connection = runtime
            .connect(ConnectAgentInput {
                agent_type: AgentType::Codex,
                workspace_id: Uuid::new_v4(),
                working_dir: PathBuf::from("C:/work"),
            })
            .await
            .unwrap();
        let session = runtime
            .new_session(connection.id, "acp-session")
            .await
            .unwrap();
        let first = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "first".to_string(),
                }],
            })
            .await
            .unwrap();
        let second = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: "second".to_string(),
                }],
            })
            .await
            .unwrap();

        assert!(matches!(second.status, AgentPromptStatus::Queued));
        runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                prompt_id: first.id,
            })
            .await
            .unwrap();
        tokio::task::yield_now().await;

        let snapshot = runtime.snapshot().await;
        let session = snapshot
            .sessions
            .iter()
            .find(|candidate| candidate.id == session.id)
            .unwrap();
        assert_eq!(session.active_prompt_id, Some(second.id));
        assert!(session.queued_prompt_ids.is_empty());
    }

    #[test]
    fn preview_text_is_bounded() {
        let long = "x".repeat(400);
        let preview = super::preview_text(&long);
        assert_eq!(preview.chars().count(), 243);
        assert!(preview.ends_with("..."));
    }
}
