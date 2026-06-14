//! Per-launch auth tokens for the companion ↔ broker socket. A fresh UUID token
//! is minted when a parent agent connection is created (and the companion is
//! injected with it), looked up on every framed message, and revoked when the
//! parent disconnects.

use std::{collections::HashMap, path::PathBuf, sync::RwLock};

/// What a valid token authorizes: the parent connection it belongs to and that
/// connection's launch working directory (used to default a delegation's cwd).
#[derive(Debug, Clone)]
pub struct TokenEntry {
    pub parent_connection_id: String,
    pub working_dir: PathBuf,
}

#[derive(Default, Debug)]
pub struct TokenRegistry {
    inner: RwLock<HashMap<String, TokenEntry>>,
}

impl TokenRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, token: String, entry: TokenEntry) {
        self.inner.write().unwrap().insert(token, entry);
    }

    pub fn lookup(&self, token: &str) -> Option<TokenEntry> {
        self.inner.read().unwrap().get(token).cloned()
    }

    pub fn revoke(&self, token: &str) {
        self.inner.write().unwrap().remove(token);
    }

    /// Drop every token belonging to a parent connection (on disconnect).
    pub fn revoke_by_parent(&self, parent_connection_id: &str) {
        self.inner
            .write()
            .unwrap()
            .retain(|_, entry| entry.parent_connection_id != parent_connection_id);
    }
}
