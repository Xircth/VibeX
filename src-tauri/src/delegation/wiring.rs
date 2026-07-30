//! Constructs the broker over the runtime + DB, starts the resolver + listener,
//! and returns the handles `AppState` holds.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

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
}

/// Build the broker (trait impls over runtime + DB), spawn the resolver and the
/// companion socket listener, and return the handles. Call once at startup.
pub(crate) fn build_delegation(runtime: Arc<AgentRuntime>, pool: SqlitePool) -> DelegationState {
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
    });
    let socket_path = default_socket_path(&std::env::temp_dir());

    spawn_resolver(broker.clone(), runtime.clone(), map);
    spawn_parent_teardown(broker.clone(), tokens.clone(), runtime.clone());

    // Install the companion injector so capable ACP parents auto-launch
    // vibex-mcp with a session-scoped token.
    runtime.install_delegation_injector(Arc::new(
        crate::delegation::inject::VibexDelegationInjector {
            tokens: tokens.clone(),
            socket_path: socket_path.clone(),
            features: crate::delegation::inject::CompanionFeatureFlags {
                delegation: true,
                feedback: true,
                ask: true,
                session_info: true,
            },
        },
    ));

    let listener = Arc::new(DelegationListener::new_with_features(
        broker.clone(),
        tokens.clone(),
        Arc::new(RuntimeParentLookup { runtime }),
        runtime_features,
    ));
    let listen_path = socket_path.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = listener.run(listen_path).await {
            tracing::warn!("delegation listener stopped: {err}");
        }
    });

    DelegationState {
        broker,
        tokens,
        socket_path,
        features,
    }
}

fn spawn_parent_teardown(
    broker: Arc<DelegationBroker>,
    tokens: Arc<TokenRegistry>,
    runtime: Arc<AgentRuntime>,
) {
    tauri::async_runtime::spawn(async move {
        let mut events = runtime.subscribe_events();
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(RecvError::Lagged(_)) => continue,
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
            tokens.revoke_by_parent(&parent_connection_id);
            broker.parent_closed(&parent_connection_id).await;
        }
    });
}
