use std::{collections::HashMap, path::PathBuf, sync::Arc};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast};
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    AgentConnectionId, AgentError, AgentEvent, AgentEventEnvelope, AgentPromptId,
    AgentPromptQueue, AgentPromptSnapshot, AgentPromptStatus, AgentRegistryEntry, AgentResult,
    AgentSessionId, AgentSessionSnapshot, AgentSessionStatus, AgentType, QueueTransition,
    registry_entry,
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
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct CancelAgentPromptInput {
    pub connection_id: AgentConnectionId,
    pub session_id: AgentSessionId,
    pub prompt_id: AgentPromptId,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RuntimeSnapshot {
    pub sequence: i64,
    pub registry: Vec<AgentRegistryEntry>,
    pub connections: Vec<AgentConnectionSnapshot>,
    pub sessions: Vec<AgentSessionSnapshot>,
    pub prompts: Vec<AgentPromptSnapshot>,
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
}

pub struct AgentRuntime {
    state: RwLock<RuntimeState>,
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
        let (event_tx, _) = broadcast::channel(512);
        Self {
            state: RwLock::new(RuntimeState::default()),
            event_sink,
            event_tx,
        }
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
        Ok(snapshot)
    }

    pub async fn new_session(
        &self,
        connection_id: AgentConnectionId,
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
            id: AgentSessionId::new(),
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

    pub async fn send_prompt(
        &self,
        input: SendAgentPromptInput,
    ) -> AgentResult<AgentPromptSnapshot> {
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

        let prompt = AgentPromptSnapshot {
            id: prompt_id,
            session_id: input.session_id,
            status,
            text_preview: preview_text(&input.text),
            created_at: now,
            updated_at: now,
        };
        state.prompts.insert(prompt.id, prompt.clone());
        self.emit_locked(
            &mut state,
            workspace_id,
            input.connection_id,
            Some(input.session_id),
            AgentEvent::PromptStarted {
                snapshot: prompt.clone(),
            },
        );
        Ok(prompt)
    }

    pub async fn cancel_prompt(&self, input: CancelAgentPromptInput) -> AgentResult<()> {
        let now = Utc::now();
        let mut state = self.state.write().await;
        let workspace_id = state
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
            let transition = session.queue.cancel(input.prompt_id);
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

        match transition {
            QueueTransition::Cancelled { .. } => {
                if let Some(prompt) = state.prompts.get_mut(&input.prompt_id) {
                    prompt.status = AgentPromptStatus::Cancelling;
                    prompt.updated_at = now;
                }
                self.emit_locked(
                    &mut state,
                    workspace_id,
                    input.connection_id,
                    Some(input.session_id),
                    AgentEvent::PromptFinished {
                        finished: crate::AgentPromptFinished {
                            prompt_id: input.prompt_id,
                            stop_reason: Some("cancelled".to_string()),
                        },
                    },
                );
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

    fn emit_locked(
        &self,
        state: &mut RuntimeState,
        workspace_id: Uuid,
        connection_id: AgentConnectionId,
        session_id: Option<AgentSessionId>,
        event: AgentEvent,
    ) {
        state.sequence += 1;
        let envelope = AgentEventEnvelope {
            sequence: state.sequence,
            workspace_id,
            connection_id,
            session_id,
            event,
            created_at: Utc::now(),
        };
        self.event_sink.emit(envelope.clone());
        let _ = self.event_tx.send(envelope);
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
        let runtime = AgentRuntime::new(sink.clone());

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
                text: "hello".to_string(),
            })
            .await
            .unwrap();

        assert!(matches!(prompt.status, AgentPromptStatus::Running));
        let snapshot = runtime.snapshot().await;
        assert_eq!(snapshot.connections.len(), 1);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.prompts.len(), 1);
        assert_eq!(sink.events.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn runtime_cancels_active_prompt_and_advances_queue() {
        let runtime = AgentRuntime::default();
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
                text: "first".to_string(),
            })
            .await
            .unwrap();
        let second = runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: connection.id,
                session_id: session.id,
                text: "second".to_string(),
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
