//! Concrete `DelegationInjector`: mints a per-launch token, registers it, and
//! returns the official product MCP entries plus global remote MCP entries to
//! splice into a capable ACP parent's `session/new`.

use std::{path::PathBuf, sync::Arc};

use agents::{
    CompanionInjection, CompanionInjectionContext, CompanionInjectionList, DelegationInjector,
    InjectedMcpServer, InjectedRemoteMcpServer, InjectedRemoteMcpTransport,
};
use delegation::{TokenEntry, TokenPermissions, TokenRegistry};
use plugins::{
    SESSION_FEAT_ASK, SESSION_FEAT_FEEDBACK, SESSION_FEAT_SESSION_CONTROL, SESSION_FEAT_SESSIONS,
};
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct VibexDelegationInjector {
    pub tokens: Arc<TokenRegistry>,
    pub socket_path: PathBuf,
    pub official_mcp: Arc<plugins::OfficialMcpRuntime>,
}

impl DelegationInjector for VibexDelegationInjector {
    fn companion(&self, context: CompanionInjectionContext<'_>) -> CompanionInjection {
        match self.injected_stdio_servers(context) {
            CompanionInjectionList::Injected(mut servers) if !servers.is_empty() => {
                CompanionInjection::Injected(servers.remove(0))
            }
            CompanionInjectionList::Injected(_) => CompanionInjection::Unsupported {
                code: "companion_features_disabled",
            },
            CompanionInjectionList::Unsupported { code } => {
                CompanionInjection::Unsupported { code }
            }
        }
    }

    fn injected_stdio_servers(
        &self,
        context: CompanionInjectionContext<'_>,
    ) -> CompanionInjectionList {
        if !context.capabilities.accepts_session_mcp_servers {
            return CompanionInjectionList::Unsupported {
                code: "delegation_parent_unsupported",
            };
        }

        let mut servers = Vec::new();
        for binding in self.official_mcp.bindings() {
            match binding.product.as_str() {
                "delegation" => servers.push(self.product_server(
                    context,
                    "vibex-delegation-mcp",
                    "delegation",
                    TokenPermissions {
                        delegation: true,
                        ..TokenPermissions::default()
                    },
                )),
                "session" => {
                    let bits = binding.features;
                    let features = plugins::session_feature_arg(bits);
                    if !features.is_empty() {
                        servers.push(self.product_server(
                            context,
                            "vibex-session-mcp",
                            &features,
                            TokenPermissions {
                                feedback: bits & SESSION_FEAT_FEEDBACK != 0,
                                ask: bits & SESSION_FEAT_ASK != 0,
                                session_info: bits & SESSION_FEAT_SESSIONS != 0,
                                session_control: bits & SESSION_FEAT_SESSION_CONTROL != 0,
                                ..TokenPermissions::default()
                            },
                        ));
                    }
                }
                "workflow" => servers.push(InjectedMcpServer {
                    name: "vibex-workflow-mcp".to_string(),
                    command: locate_named_sibling("vibex-workflow-mcp"),
                    args: Vec::new(),
                }),
                _ => {}
            }
        }

        if servers.is_empty() {
            return CompanionInjectionList::Unsupported {
                code: "official_product_mcp_disabled",
            };
        }
        CompanionInjectionList::Injected(servers)
    }

    fn remote_servers(&self) -> Vec<InjectedRemoteMcpServer> {
        services::services::mcp::scan_local_sync()
            .unwrap_or_default()
            .into_iter()
            .filter(|server| server.global)
            .filter_map(|server| {
                let object = server.spec.as_object()?;
                let transport = match object.get("type")?.as_str()? {
                    "http" => InjectedRemoteMcpTransport::Http,
                    "sse" => InjectedRemoteMcpTransport::Sse,
                    _ => return None,
                };
                let url = object.get("url")?.as_str()?.trim();
                if url.is_empty() {
                    return None;
                }
                let headers = object
                    .get("headers")
                    .and_then(serde_json::Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter_map(|(name, value)| {
                        value
                            .as_str()
                            .map(|value| (name.clone(), value.to_string()))
                    })
                    .collect();
                Some(InjectedRemoteMcpServer {
                    name: server.id,
                    transport,
                    url: url.to_string(),
                    headers,
                })
            })
            .collect()
    }
}

impl VibexDelegationInjector {
    fn product_server(
        &self,
        context: CompanionInjectionContext<'_>,
        name: &str,
        features: &str,
        permissions: TokenPermissions,
    ) -> InjectedMcpServer {
        let token = Uuid::new_v4().to_string();
        self.tokens.register_with_permissions(
            token.clone(),
            TokenEntry {
                parent_connection_id: context.parent_connection_id.to_string(),
                parent_conversation_id: context.parent_conversation_id,
                working_root: context.working_root.to_path_buf(),
            },
            permissions,
        );
        InjectedMcpServer {
            name: name.to_string(),
            command: locate_vibex_mcp_binary(),
            args: {
                let mut args = vec![
                    "--parent-connection-id".to_string(),
                    context.parent_connection_id.to_string(),
                    "--socket-path".to_string(),
                    self.socket_path.to_string_lossy().to_string(),
                    "--token".to_string(),
                    token,
                    "--features".to_string(),
                    features.to_string(),
                    "--conversation-id".to_string(),
                    context.parent_conversation_id.to_string(),
                ];
                if let Some(url) = self.official_mcp.http_base() {
                    args.push("--server-url".to_string());
                    args.push(url);
                    if name == "vibex-delegation-mcp" {
                        args.push("--product".to_string());
                        args.push("delegation".to_string());
                        if let Some(plugin_token) = self.official_mcp.delegation_token() {
                            args.push("--server-token".to_string());
                            args.push(plugin_token);
                        }
                    } else {
                        args.push("--product".to_string());
                        args.push("session".to_string());
                        if let Some(plugin_token) = self.official_mcp.session_token() {
                            args.push("--server-token".to_string());
                            args.push(plugin_token);
                        }
                    }
                }
                args
            },
        }
    }
}

pub(crate) fn locate_vibex_mcp_binary() -> PathBuf {
    utils::host_bin::locate_host_family_binary("vibex-mcp")
}

fn locate_named_sibling(base: &str) -> PathBuf {
    utils::host_bin::locate_host_family_binary(base)
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
                .any(|window| window == ["--features", "delegation"])
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
        };
        let agent = AgentId::parse("claude_code").unwrap();
        assert_eq!(
            injector.injected_stdio_servers(context(&agent, false)),
            CompanionInjectionList::Unsupported {
                code: "delegation_parent_unsupported"
            }
        );
    }
}
