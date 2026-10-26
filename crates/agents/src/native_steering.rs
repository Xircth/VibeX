//! Native `_session/steering` is not "whatever the adapter advertised".
//! Codeg requires advertisement + a per-agent `promptRequired` policy + a
//! runtime `agent_info.version` floor. Codex advertises the RPC with an empty
//! `promptRequired` set; an idle race can return `startedNewTurn` and detach
//! a host-unowned turn.

use agent_client_protocol::schema::v1::Implementation;
use api_types::{AgentId, AgentKind};

use crate::capability::AcpCapabilityNormalizer;

const CLAUDE_AGENT_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_STEERING_MIN_VERSION: &str = "0.65.0";

/// Registry policy: native steering only when this returns a floor the running
/// adapter version must meet. `None` means never native, even if advertised.
pub(crate) fn steering_prompt_required_min_version(agent_kind: AgentKind) -> Option<&'static str> {
    match agent_kind {
        AgentKind::ClaudeCode => Some(CLAUDE_STEERING_MIN_VERSION),
        _ => None,
    }
}

fn steering_policy_agent(
    agent_id: &AgentId,
    agent_info: Option<&Implementation>,
) -> Option<AgentKind> {
    if let Some(kind) = AgentKind::from_lenient(agent_id.as_str()) {
        return Some(kind);
    }
    if agent_info.is_some_and(|info| info.name == CLAUDE_AGENT_ACP_PACKAGE) {
        return Some(AgentKind::ClaudeCode);
    }
    None
}

fn version_at_least(version: &str, min: &str) -> bool {
    let parse = |value: &str| -> Option<(u64, u64, u64, bool)> {
        let trimmed = value.trim().trim_start_matches('v');
        let (core, prerelease) = match trimmed.split_once('-') {
            Some((core, rest)) => (core, !rest.is_empty()),
            None => (
                trimmed.split_once('+').map(|(c, _)| c).unwrap_or(trimmed),
                false,
            ),
        };
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        Some((major, minor, patch, prerelease))
    };
    let Some((a_maj, a_min, a_pat, a_pre)) = parse(version) else {
        return false;
    };
    let Some((b_maj, b_min, b_pat, _)) = parse(min) else {
        return false;
    };
    match (a_maj, a_min, a_pat).cmp(&(b_maj, b_min, b_pat)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Equal => !a_pre,
        std::cmp::Ordering::Less => false,
    }
}

fn steering_version_ok(agent_info: Option<&Implementation>, min: &str) -> bool {
    agent_info.is_some_and(|info| version_at_least(&info.version, min))
}

/// Native steering only when advertised, the agent has a `promptRequired`
/// policy, and the running adapter version meets the floor.
pub(crate) fn synthesize_native_steering(
    agent_id: &AgentId,
    initialize_meta: Option<&serde_json::Value>,
    agent_info: Option<&Implementation>,
) -> bool {
    if !AcpCapabilityNormalizer::steering_is_advertised(initialize_meta) {
        return false;
    }
    let Some(kind) = steering_policy_agent(agent_id, agent_info) else {
        return false;
    };
    steering_prompt_required_min_version(kind)
        .is_some_and(|min| steering_version_ok(agent_info, min))
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::Implementation;

    use super::*;

    fn advertised() -> serde_json::Value {
        serde_json::json!({ "steering": { "supported": true } })
    }

    #[test]
    fn synthesize_native_steering_requires_all_three_gates() {
        let proven = Implementation::new("claude-agent-acp", "0.65.0");
        let stale = Implementation::new("claude-agent-acp", "0.64.1");
        let claude = AgentId::parse("claude_code").unwrap();
        let codex = AgentId::parse("codex").unwrap();

        assert!(synthesize_native_steering(
            &claude,
            Some(&advertised()),
            Some(&proven)
        ));
        assert!(!synthesize_native_steering(
            &codex,
            Some(&advertised()),
            Some(&proven)
        ));
        assert!(!synthesize_native_steering(
            &claude,
            Some(&advertised()),
            Some(&stale)
        ));
        assert!(!synthesize_native_steering(
            &claude,
            Some(&advertised()),
            None
        ));
        assert!(!synthesize_native_steering(&claude, None, Some(&proven)));
    }

    #[test]
    fn a_custom_agent_running_claude_agent_acp_steers_natively() {
        let advertised = advertised();
        let claude = Implementation::new(CLAUDE_AGENT_ACP_PACKAGE, "0.85.1");
        let stale = Implementation::new(CLAUDE_AGENT_ACP_PACKAGE, "0.64.1");
        let custom = AgentId::parse("claude-code-2").unwrap();

        assert!(synthesize_native_steering(
            &custom,
            Some(&advertised),
            Some(&claude)
        ));
        assert!(!synthesize_native_steering(
            &custom,
            Some(&advertised),
            Some(&stale)
        ));
        assert!(!synthesize_native_steering(&custom, None, Some(&claude)));
        assert!(!synthesize_native_steering(
            &custom,
            Some(&advertised),
            None
        ));
        let other = Implementation::new("not-claude-agent-acp", "0.85.1");
        assert!(!synthesize_native_steering(
            &custom,
            Some(&advertised),
            Some(&other)
        ));
    }

    #[test]
    fn prerelease_at_the_floor_does_not_qualify() {
        assert!(!version_at_least("0.65.0-rc1", "0.65.0"));
        assert!(version_at_least("0.65.0", "0.65.0"));
        assert!(version_at_least("0.65.1-beta.2", "0.65.0"));
        assert!(!version_at_least("not-a-version", "0.65.0"));
    }
}
