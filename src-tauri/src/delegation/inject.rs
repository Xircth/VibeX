//! Concrete `DelegationInjector`: mints a per-launch token, registers it, and
//! returns the `vibex-mcp` companion entry to splice into a ClaudeCode parent's
//! `session/new`. Lives here (not in `agents`) so it can touch the token
//! registry + locate the companion binary.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::{DelegationInjector, InjectedMcpServer, registry::AgentType};
use delegation::{TokenEntry, TokenRegistry};
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct VibexDelegationInjector {
    pub tokens: Arc<TokenRegistry>,
    pub socket_path: PathBuf,
}

impl DelegationInjector for VibexDelegationInjector {
    fn companion(
        &self,
        parent_connection_id: &str,
        agent_type: AgentType,
        working_dir: &Path,
    ) -> Option<InjectedMcpServer> {
        // v1: only ClaudeCode parents get the companion (other agents' MCP
        // injection mechanisms differ — deferred).
        if agent_type != AgentType::ClaudeCode {
            return None;
        }
        let token = Uuid::new_v4().to_string();
        self.tokens.register(
            token.clone(),
            TokenEntry {
                parent_connection_id: parent_connection_id.to_string(),
                working_dir: working_dir.to_path_buf(),
            },
        );
        Some(InjectedMcpServer {
            name: "vibex-mcp".to_string(),
            command: locate_vibex_mcp_binary(),
            // v1 exposes delegation only; steering (feedback/ask) lands in M6.
            args: vec![
                "--parent-connection-id".to_string(),
                parent_connection_id.to_string(),
                "--socket-path".to_string(),
                self.socket_path.to_string_lossy().to_string(),
                "--token".to_string(),
                token,
                "--features".to_string(),
                "delegation".to_string(),
            ],
        })
    }
}

fn bin_name() -> &'static str {
    if cfg!(windows) {
        "vibex-mcp.exe"
    } else {
        "vibex-mcp"
    }
}

/// Locate the companion: `VIBEX_MCP_BIN` env → sibling of the running exe →
/// bare name (resolved via PATH by the agent when it spawns the server). In dev
/// the companion and the app exe both sit in `target/debug`, so the sibling
/// lookup finds it.
fn locate_vibex_mcp_binary() -> PathBuf {
    if let Ok(path) = std::env::var("VIBEX_MCP_BIN") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let candidate = dir.join(bin_name());
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(bin_name())
}
