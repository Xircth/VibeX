//! Concrete `DelegationInjector`: re-exports the unified `VibexDelegationInjector`
//! from `server` so desktop and headless runtimes share a single implementation.

#[cfg(test)]
use std::{path::PathBuf, sync::Arc};

#[cfg(test)]
use delegation::TokenRegistry;
pub(crate) use server::VibexDelegationInjector;
#[cfg(test)]
use uuid::Uuid;

#[cfg(test)]
fn test_locate(_base: &str) -> Option<PathBuf> {
    Some(PathBuf::from("/opt/vibex-mcp"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use agents::{
        AgentId, CompanionCapabilities, CompanionInjectionContext, CompanionInjectionList,
        DelegationInjector,
    };
    use plugins::{OfficialMcpBinding, OfficialMcpRuntime, SESSION_FEAT_ALL, SESSION_FEAT_ASK};

    use super::*;

    fn gate(products: &[(&str, u8)]) -> Arc<OfficialMcpRuntime> {
        let runtime = Arc::new(OfficialMcpRuntime::default());
        for (product, features) in products {
            runtime.publish_binding(OfficialMcpBinding {
                plugin_id: format!("vibex.{product}"),
                binary_id: "vibex-mcp".into(),
                product: (*product).into(),
                features: *features,
                token: "test".into(),
            });
        }
        runtime
    }

    fn context<'a>(agent: &'a AgentId, accepts: bool) -> CompanionInjectionContext<'a> {
        CompanionInjectionContext {
            parent_connection_id: "parent-1",
            parent_conversation_id: Uuid::new_v4(),
            agent_id: agent,
            working_root: Path::new("/workspace"),
            capabilities: CompanionCapabilities {
                accepts_session_mcp_servers: accepts,
            },
        }
    }

    #[test]
    fn injects_two_named_servers_when_both_plugins_are_on() {
        let tokens = Arc::new(TokenRegistry::new());
        let injector = VibexDelegationInjector {
            tokens,
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: gate(&[
                ("delegation", SESSION_FEAT_ALL),
                ("session", SESSION_FEAT_ALL),
            ]),
            locate_binary: test_locate,
        };
        let agent = AgentId::parse("vendor.capable-agent").unwrap();
        let CompanionInjectionList::Injected(servers) =
            injector.injected_stdio_servers(context(&agent, true))
        else {
            panic!("expected injection");
        };
        let names: Vec<_> = servers.iter().map(|server| server.name.as_str()).collect();
        assert_eq!(names, ["vibex-delegation-mcp", "vibex-session-mcp"]);
        assert!(
            servers[0]
                .args
                .windows(2)
                .any(|window| window == ["--features", "delegation,sessions,collaboration"])
        );
    }

    #[test]
    fn session_plugin_can_inject_without_delegation() {
        let tokens = Arc::new(TokenRegistry::new());
        let official_mcp = gate(&[("session", SESSION_FEAT_ASK)]);
        let injector = VibexDelegationInjector {
            tokens,
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp,
            locate_binary: test_locate,
        };
        let agent = AgentId::parse("vendor.capable-agent").unwrap();
        let CompanionInjectionList::Injected(servers) =
            injector.injected_stdio_servers(context(&agent, true))
        else {
            panic!("expected session injection");
        };
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "vibex-session-mcp");
        assert!(
            servers[0]
                .args
                .windows(2)
                .any(|window| window == ["--features", "ask"])
        );
    }

    #[test]
    fn both_plugins_off_is_official_product_disabled() {
        let injector = VibexDelegationInjector {
            tokens: Arc::new(TokenRegistry::new()),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: Arc::new(OfficialMcpRuntime::default()),
            locate_binary: test_locate,
        };
        let agent = AgentId::parse("vendor.capable-agent").unwrap();
        assert_eq!(
            injector.injected_stdio_servers(context(&agent, true)),
            CompanionInjectionList::Unsupported {
                code: "official_product_mcp_disabled"
            }
        );
    }

    #[test]
    fn grok_still_receives_acp_session_injection() {
        let injector = VibexDelegationInjector {
            tokens: Arc::new(TokenRegistry::new()),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: gate(&[("delegation", SESSION_FEAT_ALL)]),
            locate_binary: test_locate,
        };
        let agent = AgentId::parse("grok").unwrap();
        let CompanionInjectionList::Injected(servers) =
            injector.injected_stdio_servers(context(&agent, true))
        else {
            panic!("expected ACP injection for Grok");
        };
        assert_eq!(servers[0].name, "vibex-delegation-mcp");
    }

    #[test]
    fn parent_without_session_mcp_is_unsupported() {
        let injector = VibexDelegationInjector {
            tokens: Arc::new(TokenRegistry::new()),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: gate(&[("delegation", SESSION_FEAT_ALL)]),
            locate_binary: test_locate,
        };
        let agent = AgentId::parse("claude_code").unwrap();
        assert_eq!(
            injector.injected_stdio_servers(context(&agent, false)),
            CompanionInjectionList::Unsupported {
                code: "delegation_parent_unsupported"
            }
        );
    }

    #[test]
    fn missing_sidecar_does_not_inject_a_basename() {
        let injector = VibexDelegationInjector {
            tokens: Arc::new(TokenRegistry::new()),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: gate(&[("delegation", SESSION_FEAT_ALL)]),
            locate_binary: |_| None,
        };
        let agent = AgentId::parse("vendor.capable-agent").unwrap();
        assert_eq!(
            injector.injected_stdio_servers(context(&agent, true)),
            CompanionInjectionList::Unsupported {
                code: "companion_binary_missing"
            }
        );
    }

    #[test]
    fn injected_stdio_passes_parent_pid() {
        let injector = VibexDelegationInjector {
            tokens: Arc::new(TokenRegistry::new()),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: gate(&[("delegation", SESSION_FEAT_ALL)]),
            locate_binary: test_locate,
        };
        let agent = AgentId::parse("vendor.capable-agent").unwrap();
        let CompanionInjectionList::Injected(servers) =
            injector.injected_stdio_servers(context(&agent, true))
        else {
            panic!("expected injection");
        };
        let pid = std::process::id().to_string();
        assert!(
            servers[0]
                .args
                .windows(2)
                .any(|window| window == ["--parent-pid", pid.as_str()])
        );
        assert!(servers[0].command.is_absolute() || servers[0].command.starts_with("/opt/"));
    }
}
