//! Per-launch auth tokens for the companion ↔ broker socket. A fresh UUID token
//! is minted when a parent agent connection is created (and the companion is
//! injected with it), looked up on every framed message, and revoked when the
//! parent disconnects.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, RwLock},
};

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
    pub session_control: bool,
    /// Same-workspace send, including siblings. Session-enhance tokens stay false.
    pub workspace_write: bool,
    /// Roles, teams, durable create, and collaboration spaces.
    pub collaboration: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenFeature {
    Delegation,
    Feedback,
    Ask,
    SessionInfo,
    SessionControl,
    WorkspaceWrite,
    Collaboration,
}

impl TokenPermissions {
    pub fn allows(self, feature: TokenFeature) -> bool {
        match feature {
            TokenFeature::Delegation => self.delegation,
            TokenFeature::Feedback => self.feedback,
            TokenFeature::Ask => self.ask,
            TokenFeature::SessionInfo => self.session_info,
            TokenFeature::SessionControl => self.session_control,
            TokenFeature::WorkspaceWrite => self.workspace_write,
            TokenFeature::Collaboration => self.collaboration,
        }
    }

    #[cfg(test)]
    fn all() -> Self {
        Self {
            delegation: true,
            feedback: true,
            ask: true,
            session_info: true,
            session_control: true,
            workspace_write: true,
            collaboration: true,
        }
    }
}

#[derive(Debug, Clone)]
struct RegisteredToken {
    entry: TokenEntry,
    permissions: TokenPermissions,
    product: Option<String>,
}

#[derive(Default)]
pub struct TokenRegistry {
    inner: RwLock<HashMap<String, RegisteredToken>>,
    product_gate: RwLock<Option<Arc<dyn Fn(&str) -> bool + Send + Sync>>>,
}

impl std::fmt::Debug for TokenRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TokenRegistry")
            .field("tokens", &self.inner.read().unwrap().len())
            .finish_non_exhaustive()
    }
}

impl TokenRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Product tokens fail closed when this returns false. Untagged tokens,
    /// including HTTP ephemerals, are not checked here.
    pub fn set_product_gate(&self, gate: impl Fn(&str) -> bool + Send + Sync + 'static) {
        *self.product_gate.write().unwrap() = Some(Arc::new(gate));
    }

    pub fn register_with_permissions(
        &self,
        token: String,
        entry: TokenEntry,
        permissions: TokenPermissions,
    ) {
        self.insert(token, entry, permissions, None);
    }

    pub fn register_product_token(
        &self,
        token: String,
        entry: TokenEntry,
        permissions: TokenPermissions,
        product: &str,
    ) {
        self.insert(token, entry, permissions, Some(product.to_string()));
    }

    fn insert(
        &self,
        token: String,
        entry: TokenEntry,
        permissions: TokenPermissions,
        product: Option<String>,
    ) {
        self.inner.write().unwrap().insert(
            token,
            RegisteredToken {
                entry,
                permissions,
                product,
            },
        );
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

    pub fn permissions(&self, token: &str) -> Option<TokenPermissions> {
        self.inner
            .read()
            .unwrap()
            .get(token)
            .map(|registered| registered.permissions)
    }

    pub fn authorize(&self, token: &str, feature: TokenFeature) -> Option<TokenEntry> {
        let registered = {
            let guard = self.inner.read().unwrap();
            let registered = guard.get(token)?;
            if !registered.permissions.allows(feature) {
                return None;
            }
            registered.clone()
        };
        if let Some(product) = registered.product.as_deref() {
            let gate = self.product_gate.read().unwrap().clone();
            if let Some(gate) = gate {
                if !gate(product) {
                    return None;
                }
            }
        }
        Some(registered.entry)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> TokenEntry {
        TokenEntry {
            parent_connection_id: "parent".to_string(),
            parent_conversation_id: Uuid::nil(),
            working_root: PathBuf::from("."),
        }
    }

    #[test]
    fn disabled_product_rejects_a_tagged_token_and_keeps_untagged() {
        let registry = TokenRegistry::new();
        registry.set_product_gate(|product| product != "delegation");
        let permissions = TokenPermissions {
            delegation: true,
            ..TokenPermissions::default()
        };
        registry.register_product_token("pipe".to_string(), entry(), permissions, "delegation");
        registry.register_with_permissions("http".to_string(), entry(), permissions);
        assert!(
            registry
                .authorize("pipe", TokenFeature::Delegation)
                .is_none()
        );
        assert!(
            registry
                .authorize("http", TokenFeature::Delegation)
                .is_some()
        );
        registry.set_product_gate(|product| product == "delegation");
        assert!(
            registry
                .authorize("pipe", TokenFeature::Delegation)
                .is_some()
        );
    }
}
