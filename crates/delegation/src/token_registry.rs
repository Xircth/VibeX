//! Per-launch auth tokens for the companion ↔ broker socket. A fresh UUID token
//! is minted when a parent agent connection is created (and the companion is
//! injected with it), looked up on every framed message, and revoked when the
//! parent disconnects.

use std::{collections::HashMap, path::PathBuf, sync::RwLock};

use uuid::Uuid;

/// What a valid token authorizes: the parent connection it belongs to and that
/// connection's launch working directory (used to default a delegation's cwd).
#[derive(Debug, Clone)]
pub struct TokenEntry {
    pub parent_connection_id: String,
    pub parent_conversation_id: Uuid,
    pub working_root: PathBuf,
}

/// Feature authority carried by one short-lived companion token. The listener
/// enforces this independently of the companion's advertised tool list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TokenPermissions {
    pub delegation: bool,
    pub feedback: bool,
    pub ask: bool,
    pub session_info: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenFeature {
    Delegation,
    Feedback,
    Ask,
    SessionInfo,
}

impl TokenPermissions {
    pub fn allows(self, feature: TokenFeature) -> bool {
        match feature {
            TokenFeature::Delegation => self.delegation,
            TokenFeature::Feedback => self.feedback,
            TokenFeature::Ask => self.ask,
            TokenFeature::SessionInfo => self.session_info,
        }
    }

    #[cfg(test)]
    fn all() -> Self {
        Self {
            delegation: true,
            feedback: true,
            ask: true,
            session_info: true,
        }
    }
}

#[derive(Debug, Clone)]
struct RegisteredToken {
    entry: TokenEntry,
    permissions: TokenPermissions,
}

#[derive(Default, Debug)]
pub struct TokenRegistry {
    inner: RwLock<HashMap<String, RegisteredToken>>,
}

impl TokenRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_with_permissions(
        &self,
        token: String,
        entry: TokenEntry,
        permissions: TokenPermissions,
    ) {
        self.inner
            .write()
            .unwrap()
            .insert(token, RegisteredToken { entry, permissions });
    }

    #[cfg(test)]
    pub fn register(&self, token: String, entry: TokenEntry) {
        self.register_with_permissions(token, entry, TokenPermissions::all());
    }

    pub fn lookup(&self, token: &str) -> Option<TokenEntry> {
        self.inner
            .read()
            .unwrap()
            .get(token)
            .map(|registered| registered.entry.clone())
    }

    pub fn authorize(&self, token: &str, feature: TokenFeature) -> Option<TokenEntry> {
        self.inner
            .read()
            .unwrap()
            .get(token)
            .filter(|registered| registered.permissions.allows(feature))
            .map(|registered| registered.entry.clone())
    }

    pub fn revoke(&self, token: &str) {
        self.inner.write().unwrap().remove(token);
    }

    /// Drop every token belonging to a parent connection (on disconnect).
    pub fn revoke_by_parent(&self, parent_connection_id: &str) {
        self.inner
            .write()
            .unwrap()
            .retain(|_, registered| registered.entry.parent_connection_id != parent_connection_id);
    }

    pub fn parent_connection_ids(&self) -> Vec<String> {
        let mut ids = self
            .inner
            .read()
            .unwrap()
            .values()
            .map(|registered| registered.entry.parent_connection_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        ids
    }
}
