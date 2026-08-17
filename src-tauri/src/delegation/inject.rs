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
    pub official_mcp: Arc<plugins::OfficialProductMcpGate>,
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
        if self.official_mcp.allow_delegation_mcp() {
            servers.push(self.product_server(
                context,
                "vibex-delegation-mcp",
                "delegation",
                TokenPermissions {
                    delegation: true,
                    ..TokenPermissions::default()
                },
            ));
        }
        if self.official_mcp.allow_session_mcp() {
            let bits = self.official_mcp.session_features();
            let features = session_feature_arg(bits);
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

        if servers.is_empty() {
            return CompanionInjectionList::Unsupported {
                code: "official_product_mcp_disabled",
            };
        }
        CompanionInjectionList::Injected(servers)
    }

    fn extra_stdio_servers(&self) -> Vec<InjectedMcpServer> {
        if !self.official_mcp.allow_workflow_mcp() {
            return Vec::new();
        }
        vec![InjectedMcpServer {
            name: "vibex-workflow-mcp".to_string(),
            command: locate_named_sibling("vibex-workflow-mcp"),
            args: Vec::new(),
        }]
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
            args: vec![
                "--parent-connection-id".to_string(),
                context.parent_connection_id.to_string(),
                "--socket-path".to_string(),
                self.socket_path.to_string_lossy().to_string(),
                "--token".to_string(),
                token,
                "--features".to_string(),
                features.to_string(),
            ],
        }
    }
}

fn session_feature_arg(bits: u8) -> String {
    [
        (bits & SESSION_FEAT_FEEDBACK != 0, "feedback"),
        (bits & SESSION_FEAT_ASK != 0, "ask"),
        (bits & SESSION_FEAT_SESSIONS != 0, "sessions"),
        (bits & SESSION_FEAT_SESSION_CONTROL != 0, "session-control"),
    ]
    .into_iter()
    .filter_map(|(enabled, name)| enabled.then_some(name))
    .collect::<Vec<_>>()
    .join(",")
}

fn locate_vibex_mcp_binary() -> PathBuf {
    if let Ok(path) = std::env::var("VIBEX_MCP_BIN") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    locate_named_sibling("vibex-mcp")
}

fn locate_named_sibling(base: &str) -> PathBuf {
    let name = if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    };
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let candidate = dir.join(&name);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use agents::{
        AgentId, CompanionCapabilities, CompanionInjectionContext, CompanionInjectionList,
        DelegationInjector,
    };
    use plugins::{
        MULTI_AGENT_PLUGIN_ID, OfficialProductMcpGate, PluginActivation, SESSION_ENHANCE_PLUGIN_ID,
        SESSION_FEAT_ASK,
    };

    use super::*;

    fn gate(ids: &[&str]) -> Arc<OfficialProductMcpGate> {
        let gate = Arc::new(OfficialProductMcpGate::default());
        for id in ids {
            gate.observe(id, PluginActivation::Enabled);
        }
        gate
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
            official_mcp: gate(&[MULTI_AGENT_PLUGIN_ID, SESSION_ENHANCE_PLUGIN_ID]),
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
        let official_mcp = gate(&[SESSION_ENHANCE_PLUGIN_ID]);
        official_mcp.set_session_features(SESSION_FEAT_ASK);
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
            official_mcp: Arc::new(OfficialProductMcpGate::default()),
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
    fn parent_without_session_mcp_is_unsupported() {
        let injector = VibexDelegationInjector {
            tokens: Arc::new(TokenRegistry::new()),
            socket_path: PathBuf::from("/tmp/vibex-delegation-test.sock"),
            official_mcp: gate(&[MULTI_AGENT_PLUGIN_ID]),
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
