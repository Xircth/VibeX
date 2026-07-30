//! Concrete `DelegationInjector`: mints a per-launch token, registers it, and
//! returns the `vibex-mcp` companion entry to splice into a capable ACP parent's
//! `session/new`. Lives here (not in `agents`) so it can touch the token
//! registry + locate the companion binary.

use std::{path::PathBuf, sync::Arc};

use agents::{
    CompanionInjection, CompanionInjectionContext, DelegationInjector, InjectedMcpServer,
};
use delegation::{TokenEntry, TokenRegistry};
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct VibexDelegationInjector {
    pub tokens: Arc<TokenRegistry>,
    pub socket_path: PathBuf,
    pub features: CompanionFeatureFlags,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CompanionFeatureFlags {
    pub delegation: bool,
    pub feedback: bool,
    pub ask: bool,
    pub session_info: bool,
}

impl CompanionFeatureFlags {
    fn launch_arg(self) -> String {
        [
            (self.delegation, "delegation"),
            (self.feedback, "feedback"),
            (self.ask, "ask"),
            (self.session_info, "sessions"),
        ]
        .into_iter()
        .filter_map(|(enabled, name)| enabled.then_some(name))
        .collect::<Vec<_>>()
        .join(",")
    }
}

impl DelegationInjector for VibexDelegationInjector {
    fn companion(&self, context: CompanionInjectionContext<'_>) -> CompanionInjection {
        if !context.capabilities.accepts_session_mcp_servers {
            return CompanionInjection::Unsupported {
                code: "delegation_parent_unsupported",
            };
        }
        let token = Uuid::new_v4().to_string();
        self.tokens.register(
            token.clone(),
            TokenEntry {
                parent_connection_id: context.parent_connection_id.to_string(),
                parent_conversation_id: context.parent_conversation_id,
                working_root: context.working_root.to_path_buf(),
            },
        );
        CompanionInjection::Injected(InjectedMcpServer {
            name: "vibex-mcp".to_string(),
            command: locate_vibex_mcp_binary(),
            args: vec![
                "--parent-connection-id".to_string(),
                context.parent_connection_id.to_string(),
                "--socket-path".to_string(),
                self.socket_path.to_string_lossy().to_string(),
                "--token".to_string(),
                token,
                "--features".to_string(),
                self.features.launch_arg(),
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use agents::{
        AgentId, CompanionCapabilities, CompanionInjection, CompanionInjectionContext,
        DelegationInjector,
    };

    use super::*;

    #[test]
    fn companion_injection_follows_capability() {
        let tokens = Arc::new(TokenRegistry::new());
        let injector = VibexDelegationInjector {
            tokens: Arc::clone(&tokens),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            features: CompanionFeatureFlags {
                delegation: true,
                feedback: false,
                ask: false,
                session_info: false,
            },
        };
        let conversation_id = Uuid::new_v4();
        let supported_agent = AgentId::parse("vendor.capable-agent").unwrap();

        let supported = injector.companion(CompanionInjectionContext {
            parent_connection_id: "parent-1",
            parent_conversation_id: conversation_id,
            agent_id: &supported_agent,
            working_root: Path::new("/workspace"),
            capabilities: CompanionCapabilities {
                accepts_session_mcp_servers: true,
            },
        });
        assert!(matches!(supported, CompanionInjection::Injected(_)));

        let unsupported_agent = AgentId::parse("claude_code").unwrap();
        let unsupported = injector.companion(CompanionInjectionContext {
            parent_connection_id: "parent-2",
            parent_conversation_id: Uuid::new_v4(),
            agent_id: &unsupported_agent,
            working_root: Path::new("/workspace"),
            capabilities: CompanionCapabilities {
                accepts_session_mcp_servers: false,
            },
        });
        assert_eq!(
            unsupported,
            CompanionInjection::Unsupported {
                code: "delegation_parent_unsupported"
            }
        );
    }
}
