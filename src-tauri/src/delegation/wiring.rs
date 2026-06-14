//! Constructs the broker over the runtime + DB, starts the resolver + listener,
//! and returns the handles `AppState` holds.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agents::runtime::AgentRuntime;
use delegation::{
    DelegationBroker, DelegationConfig, DelegationListener, TokenRegistry, default_socket_path,
};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::delegation::{
    emitter::{NoopMetaWriter, RuntimeEventEmitter},
    lookups::{DbChildStatusLookup, DbDepthLookup, RuntimeParentLookup},
    resolver::spawn_resolver,
    spawner::RuntimeSpawner,
};

/// Delegation handles held by `AppState`. `broker`/`tokens`/`socket_path` are
/// consumed by the ClaudeCode MCP injection (T4.4) and future delegation
/// commands; held here from startup so they outlive the listener/resolver.
#[allow(dead_code)]
pub struct DelegationState {
    pub broker: Arc<DelegationBroker>,
    pub tokens: Arc<TokenRegistry>,
    pub socket_path: PathBuf,
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
    let socket_path = default_socket_path(&std::env::temp_dir());

    spawn_resolver(broker.clone(), runtime.clone(), map);

    // Install the companion injector so ClaudeCode parents auto-launch vibex-mcp
    // (the agent connects to our listener over the socket with the minted token).
    runtime.install_delegation_injector(Arc::new(
        crate::delegation::inject::VibexDelegationInjector {
            tokens: tokens.clone(),
            socket_path: socket_path.clone(),
        },
    ));

    let listener = Arc::new(DelegationListener::new(
        broker.clone(),
        tokens.clone(),
        Arc::new(RuntimeParentLookup { runtime }),
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
    }
}
