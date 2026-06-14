//! Persists live delegation state onto the parent's `delegate_to_agent` tool
//! call so the UI can re-render the delegation card after a reload.

use async_trait::async_trait;
use serde_json::Value;

/// Writes `meta` onto the parent tool call identified by
/// `(parent_connection_id, parent_tool_use_id)`. Implementations no-op for
/// synthetic parent tool-use ids (those that start with `delegation-`), which
/// have no matching ACP tool call to attach to.
#[async_trait]
pub trait DelegationMetaWriter: Send + Sync {
    async fn write_meta(&self, parent_connection_id: &str, parent_tool_use_id: &str, meta: Value);
}
