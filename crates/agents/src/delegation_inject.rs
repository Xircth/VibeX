//! Host hook for injecting a per-connection companion MCP server into an agent's
//! ACP `session/new`.
//!
//! The delegation feature needs to launch a small companion MCP server alongside
//! a parent agent (so the parent's LLM gets the `delegate_to_agent` tools). The
//! companion must be minted a per-launch auth token, which lives in the app's
//! token registry — code this crate must not depend on. So `agents` only defines
//! the hook; the app installs a concrete [`DelegationInjector`] on the runtime.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::AgentId;

/// A stdio MCP server the host wants spliced into an agent's `session/new`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectedMcpServer {
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
}

/// Runtime-negotiated capabilities relevant to the VibeX companion.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CompanionCapabilities {
    pub accepts_session_mcp_servers: bool,
}

/// Public input seam for deciding whether and how to inject the companion.
#[derive(Debug, Clone, Copy)]
pub struct CompanionInjectionContext<'a> {
    pub parent_connection_id: &'a str,
    pub parent_conversation_id: Uuid,
    pub agent_id: &'a AgentId,
    pub working_root: &'a Path,
    pub capabilities: CompanionCapabilities,
}

/// Observable injection decision. Unsupported parents keep their normal ACP
/// session but expose a stable capability diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionInjection {
    Injected(InjectedMcpServer),
    Unsupported { code: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectedRemoteMcpTransport {
    Http,
    Sse,
}

#[derive(Debug, Clone)]
pub struct InjectedRemoteMcpServer {
    pub name: String,
    pub transport: InjectedRemoteMcpTransport,
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// Asked, per new ACP session, for a companion MCP server to inject (or `None`
/// to skip). Implementations may mint + register a per-launch token as a side
/// effect; they must be cheap and non-blocking (called on the connection runner).
pub trait DelegationInjector: std::fmt::Debug + Send + Sync {
    fn companion(&self, context: CompanionInjectionContext<'_>) -> CompanionInjection;

    fn remote_servers(&self) -> Vec<InjectedRemoteMcpServer> {
        Vec::new()
    }
}
