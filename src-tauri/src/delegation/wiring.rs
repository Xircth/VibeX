//! Constructs the broker over the runtime + DB, starts the resolver + listener,
//! and returns the handles `AppState` holds.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

use agents::{AgentConnectionStatus, AgentEvent, runtime::AgentRuntime};
use delegation::{
    DelegationBroker, DelegationConfig, DelegationListener, InMemoryCompanionFeatures,
    TokenRegistry, default_socket_path,
};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, broadcast::error::RecvError};

use crate::delegation::{
    emitter::{NoopMetaWriter, RuntimeEventEmitter},
    features::RuntimeCompanionFeatures,
    lookups::{DbChildStatusLookup, DbDepthLookup, RuntimeParentLookup},
    resolver::spawn_resolver,
    spawner::RuntimeSpawner,
};

/// Delegation handles held by `AppState`. `broker`/`tokens`/`socket_path` are
/// consumed by the capability-driven MCP injection and delegation
/// commands; held here from startup so they outlive the listener/resolver.
#[allow(dead_code)]
pub struct DelegationState {
    pub broker: Arc<DelegationBroker>,
    pub tokens: Arc<TokenRegistry>,
    pub socket_path: PathBuf,
    pub features: Arc<InMemoryCompanionFeatures>,
    pub listener: Arc<DelegationListener>,
}

/// Build the broker (trait impls over runtime + DB), spawn the resolver and the
/// companion socket listener, and return the handles. Call once at startup.
pub(crate) fn build_delegation(
    runtime: Arc<AgentRuntime>,
    pool: SqlitePool,
    conversation_context: conversations::ConversationContext,
    official_mcp: Arc<plugins::OfficialMcpRuntime>,
) -> DelegationState {
    let map = Arc::new(Mutex::new(HashMap::new()));
    let spawner = Arc::new(RuntimeSpawner {
        runtime: runtime.clone(),
        pool: pool.clone(),
        map: map.clone(),
    });
    let feature_pool = pool.clone();
    let broker = Arc::new(DelegationBroker::new(
        spawner,
        Arc::new(DbDepthLookup { pool: pool.clone() }),
        Arc::new(DbChildStatusLookup { pool }),
        Arc::new(NoopMetaWriter),
        Arc::new(RuntimeEventEmitter {
            runtime: runtime.clone(),
        }),
        DelegationConfig::default(),
    ));
    let tokens = Arc::new(TokenRegistry::new());
    let features = Arc::new(InMemoryCompanionFeatures::new());
    let runtime_features = Arc::new(RuntimeCompanionFeatures {
        memory: features.clone(),
        pool: feature_pool,
        runtime: runtime.clone(),
        conversations: conversations::ScopedConversationControl::new(conversation_context),
    });
    let socket_path = default_socket_path(&std::env::temp_dir());

    spawn_resolver(broker.clone(), runtime.clone(), map);
    spawn_parent_teardown(
        broker.clone(),
        tokens.clone(),
        features.clone(),
        runtime.clone(),
    );

    // Install the companion injector so capable ACP parents auto-launch
    // vibex-mcp with a session-scoped token.
    runtime.install_delegation_injector(Arc::new(
        crate::delegation::inject::VibexDelegationInjector {
            tokens: tokens.clone(),
            socket_path: socket_path.clone(),
            official_mcp,
        },
    ));

    let listener = Arc::new(DelegationListener::new_with_features(
        broker.clone(),
        tokens.clone(),
        Arc::new(RuntimeParentLookup {
            runtime: runtime.clone(),
        }),
        runtime_features,
    ));
    let listen_path = socket_path.clone();
    let listen_listener = listener.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = listen_listener.run(listen_path).await {
            tracing::warn!("delegation listener stopped: {err}");
        }
    });

    DelegationState {
        broker,
        tokens,
        socket_path,
        features,
        listener,
    }
}

pub(crate) struct RuntimeConversationLookup {
    pub runtime: Arc<AgentRuntime>,
}

#[async_trait::async_trait]
impl server::ProductMcpSessionLookup for RuntimeConversationLookup {
    async fn resolve(&self, conversation_id: uuid::Uuid) -> Option<(String, PathBuf)> {
        let snapshot = self.runtime.snapshot().await;
        let session = snapshot
            .sessions
            .iter()
            .find(|session| session.id.0 == conversation_id)?;
        let connection = snapshot
            .connections
            .iter()
            .find(|connection| connection.id == session.connection_id)?;
        Some((
            connection.id.0.to_string(),
            PathBuf::from(&connection.working_dir),
        ))
    }
}

fn spawn_parent_teardown(
    broker: Arc<DelegationBroker>,
    tokens: Arc<TokenRegistry>,
    features: Arc<InMemoryCompanionFeatures>,
    runtime: Arc<AgentRuntime>,
) {
    tauri::async_runtime::spawn(async move {
        let mut events = runtime.subscribe_events();
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(RecvError::Lagged(_)) => {
                    reconcile_parent_teardown(&broker, &tokens, &features, &runtime).await;
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            let AgentEvent::ConnectionStatusChanged { snapshot } = envelope.event else {
                continue;
            };
            if !matches!(
                snapshot.status,
                AgentConnectionStatus::Disconnected | AgentConnectionStatus::Failed
            ) {
                continue;
            }
            let parent_connection_id = snapshot.id.to_string();
            teardown_parent(&broker, &tokens, &features, &parent_connection_id).await;
        }
    });
}

async fn teardown_parent(
    broker: &DelegationBroker,
    tokens: &TokenRegistry,
    features: &InMemoryCompanionFeatures,
    parent_connection_id: &str,
) {
    tokens.revoke_by_parent(parent_connection_id);
    features.close_parent_connection(parent_connection_id).await;
    broker.parent_closed(parent_connection_id).await;
}

async fn reconcile_parent_teardown(
    broker: &DelegationBroker,
    tokens: &TokenRegistry,
    features: &InMemoryCompanionFeatures,
    runtime: &AgentRuntime,
) {
    let snapshot = runtime.snapshot().await;
    let live = snapshot
        .connections
        .iter()
        .filter(|connection| {
            !matches!(
                connection.status,
                AgentConnectionStatus::Disconnected | AgentConnectionStatus::Failed
            )
        })
        .map(|connection| connection.id.to_string())
        .collect::<HashSet<_>>();
    for parent_connection_id in stale_parent_ids(tokens, &live) {
        teardown_parent(broker, tokens, features, &parent_connection_id).await;
    }
}

fn stale_parent_ids(tokens: &TokenRegistry, live: &HashSet<String>) -> Vec<String> {
    tokens
        .parent_connection_ids()
        .into_iter()
        .filter(|parent_connection_id| !live.contains(parent_connection_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use delegation::{TokenEntry, TokenPermissions};
    use uuid::Uuid;

    use super::*;

    #[test]
    fn lag_reconciliation_finds_token_parents_missing_from_runtime() {
        let tokens = TokenRegistry::new();
        for parent in ["live", "stale"] {
            tokens.register_with_permissions(
                format!("token-{parent}"),
                TokenEntry {
                    parent_connection_id: parent.to_string(),
                    parent_conversation_id: Uuid::new_v4(),
                    working_root: std::env::temp_dir(),
                },
                TokenPermissions {
                    delegation: true,
                    ..TokenPermissions::default()
                },
            );
        }
        let live = HashSet::from(["live".to_string()]);

        assert_eq!(stale_parent_ids(&tokens, &live), vec!["stale"]);
    }
}
