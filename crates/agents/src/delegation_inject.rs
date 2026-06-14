//! Host hook for injecting a per-connection companion MCP server into an agent's
//! ACP `session/new`.
//!
//! The delegation feature needs to launch a small companion MCP server alongside
//! a parent agent (so the parent's LLM gets the `delegate_to_agent` tools). The
//! companion must be minted a per-launch auth token, which lives in the app's
//! token registry — code this crate must not depend on. So `agents` only defines
//! the hook; the app installs a concrete [`DelegationInjector`] on the runtime.

use std::path::{Path, PathBuf};

use crate::registry::AgentType;

/// A stdio MCP server the host wants spliced into an agent's `session/new`.
#[derive(Debug, Clone)]
pub struct InjectedMcpServer {
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
}

/// Asked, per new ACP session, for a companion MCP server to inject (or `None`
/// to skip). Implementations may mint + register a per-launch token as a side
/// effect; they must be cheap and non-blocking (called on the connection runner).
pub trait DelegationInjector: std::fmt::Debug + Send + Sync {
    fn companion(
        &self,
        parent_connection_id: &str,
        agent_type: AgentType,
        working_dir: &Path,
    ) -> Option<InjectedMcpServer>;
}
