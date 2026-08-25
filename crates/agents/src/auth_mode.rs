use std::collections::HashMap;

use api_types::{AgentId, AgentKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltInAuthModePolicy {
    pub mode_env: &'static str,
    pub credential_env: &'static str,
    pub modes: &'static [&'static str],
    pub credential_modes: &'static [&'static str],
    pub subscription_scrub_env: &'static [&'static str],
    pub default_mode: &'static str,
}

const CLAUDE_MODES: &[&str] = &["official_subscription", "custom", "model_provider"];
const CLAUDE_CREDENTIAL_MODES: &[&str] = &["custom"];
const CLAUDE_SCRUB_ENV: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "API_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
];
const ANTIGRAVITY_MODES: &[&str] = &[
    "oauth-personal",
    "oauth-business",
    "gemini-api-key",
    "agent-platform",
    "model_provider",
];
const ANTIGRAVITY_CREDENTIAL_MODES: &[&str] = &["gemini-api-key", "agent-platform"];
const ANTIGRAVITY_ALL_AUTH_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
];
const GROK_MODES: &[&str] = &["subscription", "api_key", "custom"];
const GROK_CREDENTIAL_MODES: &[&str] = &["api_key"];
const GROK_SCRUB_ENV: &[&str] = &["XAI_API_KEY"];
const CURSOR_MODES: &[&str] = &["subscription", "custom"];
const CURSOR_CREDENTIAL_MODES: &[&str] = &["custom"];
const CURSOR_SCRUB_ENV: &[&str] = &["CURSOR_API_KEY", "CURSOR_API_BASE_URL"];
const DSH_MODES: &[&str] = &["deepseek", "custom"];
const DSH_CREDENTIAL_MODES: &[&str] = &["deepseek", "custom"];
const DSH_OFFICIAL_SCRUB_ENV: &[&str] = &["DEEPSEEK_BASE_URL"];

pub fn built_in_auth_mode_policy(agent_id: &AgentId) -> Option<BuiltInAuthModePolicy> {
    match agent_id.as_str() {
        "claude_code" => Some(BuiltInAuthModePolicy {
            mode_env: "CLAUDE_AUTH_MODE",
            credential_env: "ANTHROPIC_API_KEY",
            modes: CLAUDE_MODES,
            credential_modes: CLAUDE_CREDENTIAL_MODES,
            subscription_scrub_env: CLAUDE_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        id if AgentKind::Antigravity.matches_id(id) => Some(BuiltInAuthModePolicy {
            mode_env: "AGY_AUTH_METHOD",
            credential_env: "GEMINI_API_KEY",
            modes: ANTIGRAVITY_MODES,
            credential_modes: ANTIGRAVITY_CREDENTIAL_MODES,
            subscription_scrub_env: ANTIGRAVITY_ALL_AUTH_ENV,
            default_mode: "oauth-personal",
        }),
        "grok" => Some(BuiltInAuthModePolicy {
            mode_env: "GROK_AUTH_MODE",
            credential_env: "XAI_API_KEY",
            modes: GROK_MODES,
            credential_modes: GROK_CREDENTIAL_MODES,
            subscription_scrub_env: GROK_SCRUB_ENV,
            default_mode: "subscription",
        }),
        "cursor" => Some(BuiltInAuthModePolicy {
            mode_env: "CURSOR_AUTH_MODE",
            credential_env: "CURSOR_API_KEY",
            modes: CURSOR_MODES,
            credential_modes: CURSOR_CREDENTIAL_MODES,
            subscription_scrub_env: CURSOR_SCRUB_ENV,
            default_mode: "subscription",
        }),
        "deepseek_harness" => Some(BuiltInAuthModePolicy {
            mode_env: "DSH_AUTH_MODE",
            credential_env: "DEEPSEEK_API_KEY",
            modes: DSH_MODES,
            credential_modes: DSH_CREDENTIAL_MODES,
            subscription_scrub_env: DSH_OFFICIAL_SCRUB_ENV,
            default_mode: "deepseek",
        }),
        _ => None,
    }
}

fn resolved_auth_mode<'a>(
    agent_id: &AgentId,
    policy: BuiltInAuthModePolicy,
    env: &'a HashMap<String, String>,
) -> &'a str {
    env.get(policy.mode_env)
        .map(String::as_str)
        .filter(|mode| policy.modes.contains(mode))
        .unwrap_or_else(|| {
            if agent_id.as_str() == "deepseek_harness"
                && env
                    .get("DEEPSEEK_BASE_URL")
                    .is_some_and(|value| !value.trim().is_empty())
            {
                "custom"
            } else {
                policy.default_mode
            }
        })
}

pub fn apply_built_in_auth_mode_policy(agent_id: &AgentId, env: &mut HashMap<String, String>) {
    let Some(policy) = built_in_auth_mode_policy(agent_id) else {
        return;
    };
    migrate_legacy_antigravity_auth_mode(agent_id, env);
    let mode = resolved_auth_mode(agent_id, policy, env);
    for key in auth_mode_scrubbed_env_keys(agent_id, mode) {
        env.remove(*key);
    }
    if agent_id.as_str() == "cursor" {
        env.remove("CURSOR_API_BASE_URL");
    }
}

fn migrate_legacy_antigravity_auth_mode(agent_id: &AgentId, env: &mut HashMap<String, String>) {
    if !AgentKind::Antigravity.matches_id(agent_id.as_str()) {
        return;
    }
    if env
        .get("AGY_AUTH_METHOD")
        .is_some_and(|value| ANTIGRAVITY_MODES.contains(&value.as_str()))
    {
        return;
    }
    let mapped = match env.get("GEMINI_AUTH_MODE").map(String::as_str) {
        Some("gemini_api_key" | "custom") => "gemini-api-key",
        Some("vertex_adc" | "vertex_service_account" | "vertex_api_key") => "agent-platform",
        Some("login_google") => "oauth-personal",
        _ => return,
    };
    env.insert("AGY_AUTH_METHOD".to_string(), mapped.to_string());
}

pub fn built_in_auth_mode_scrubbed_env_keys(
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> &'static [&'static str] {
    let Some(policy) = built_in_auth_mode_policy(agent_id) else {
        return &[];
    };
    let mode = resolved_auth_mode(agent_id, policy, env);
    auth_mode_scrubbed_env_keys(agent_id, mode)
}

pub fn auth_mode_credential_env(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        (id, "agent-platform") if AgentKind::Antigravity.matches_id(id) => Some("GOOGLE_API_KEY"),
        (id, "gemini-api-key") if AgentKind::Antigravity.matches_id(id) => Some("GEMINI_API_KEY"),
        ("claude_code", "custom") => Some("ANTHROPIC_API_KEY"),
        ("grok", "api_key") => Some("XAI_API_KEY"),
        ("cursor", "custom") => Some("CURSOR_API_KEY"),
        ("deepseek_harness", "deepseek" | "custom") => Some("DEEPSEEK_API_KEY"),
        _ => None,
    }
}

fn auth_mode_scrubbed_env_keys(agent_id: &AgentId, mode: &str) -> &'static [&'static str] {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_subscription" | "model_provider") => CLAUDE_SCRUB_ENV,
        (id, "oauth-personal" | "oauth-business") if AgentKind::Antigravity.matches_id(id) => {
            ANTIGRAVITY_ALL_AUTH_ENV
        }
        (id, "gemini-api-key" | "model_provider") if AgentKind::Antigravity.matches_id(id) => &[
            "GOOGLE_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
        ],
        (id, "agent-platform") if AgentKind::Antigravity.matches_id(id) => &["GEMINI_API_KEY"],
        ("grok" | "cursor", "subscription") => built_in_auth_mode_policy(agent_id)
            .map(|policy| policy.subscription_scrub_env)
            .unwrap_or_default(),
        ("deepseek_harness", "deepseek") => DSH_OFFICIAL_SCRUB_ENV,
        _ => &[],
    }
}

pub fn apply_built_in_launch_argument_policy(
    agent_id: &AgentId,
    env: &HashMap<String, String>,
    args: &mut Vec<String>,
) {
    let mut prefix = Vec::new();
    match agent_id.as_str() {
        "cursor" => {
            if env
                .get("CURSOR_FORCE")
                .map(|value| value.trim())
                .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            {
                prefix.push("--force".to_string());
            }
            if let Some(model) = env
                .get("CURSOR_MODEL")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                prefix.extend(["--model".to_string(), model.to_string()]);
            }
        }
        "grok" => {
            prefix.push("--no-auto-update".to_string());
            if let Some(mode) = env
                .get("GROK_PERMISSION_MODE")
                .map(|value| value.trim())
                .filter(|value| {
                    matches!(
                        *value,
                        "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan"
                    )
                })
            {
                prefix.extend(["--permission-mode".to_string(), mode.to_string()]);
            }
        }
        "openclaw" => {
            if let Some(url) = env
                .get("OPENCLAW_GATEWAY_URL")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                args.extend(["--url".to_string(), url.to_string()]);
            }
            if let Some(session) = env
                .get("OPENCLAW_SESSION_KEY")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                args.extend(["--session".to_string(), session.to_string()]);
            }
        }
        _ => {}
    }
    args.splice(0..0, prefix);
}

pub fn apply_built_in_launch_policy(
    agent_id: &AgentId,
    env: &mut HashMap<String, String>,
    args: &mut Vec<String>,
) {
    apply_built_in_auth_mode_policy(agent_id, env);
    if AgentKind::Antigravity.matches_id(agent_id.as_str()) {
        crate::apply_antigravity_env_policy(env);
        let home = env
            .get("HOME")
            .or_else(|| env.get("USERPROFILE"))
            .map(std::path::PathBuf::from)
            .or_else(dirs::home_dir);
        let _ = crate::sync_antigravity_settings(env, home.as_deref());
    }
    match agent_id.as_str() {
        // codex-acp otherwise removes an ACP-injected companion when a global
        // or project Codex config already defines a server with the same name.
        "codex" => {
            env.insert(
                "DISABLE_MCP_CONFIG_FILTERING".to_string(),
                "true".to_string(),
            );
        }
        // pi-acp only advertises embedded-context support behind this switch.
        "pi" => {
            env.insert(
                "PI_ACP_ENABLE_EMBEDDED_CONTEXT".to_string(),
                "true".to_string(),
            );
        }
        _ => {}
    }
    apply_built_in_launch_argument_policy(agent_id, env, args);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use api_types::AgentId;

    use super::{
        apply_built_in_auth_mode_policy, apply_built_in_launch_argument_policy,
        apply_built_in_launch_policy,
    };

    #[test]
    fn codex_and_pi_force_required_acp_capability_environment() {
        let mut codex = HashMap::from([(
            "DISABLE_MCP_CONFIG_FILTERING".to_string(),
            "false".to_string(),
        )]);
        apply_built_in_launch_policy(
            &AgentId::parse("codex").unwrap(),
            &mut codex,
            &mut Vec::new(),
        );
        assert_eq!(codex["DISABLE_MCP_CONFIG_FILTERING"], "true");

        let mut pi = HashMap::new();
        apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut pi, &mut Vec::new());
        assert_eq!(pi["PI_ACP_ENABLE_EMBEDDED_CONTEXT"], "true");
    }

    #[test]
    fn claude_and_antigravity_modes_remove_conflicting_launch_credentials() {
        let mut claude = HashMap::from([
            (
                "CLAUDE_AUTH_MODE".to_string(),
                "official_subscription".to_string(),
            ),
            ("ANTHROPIC_API_KEY".to_string(), "secret".to_string()),
            (
                "ANTHROPIC_BASE_URL".to_string(),
                "https://proxy.example".to_string(),
            ),
        ]);
        apply_built_in_auth_mode_policy(&AgentId::parse("claude_code").unwrap(), &mut claude);
        assert!(!claude.contains_key("ANTHROPIC_API_KEY"));
        assert!(!claude.contains_key("ANTHROPIC_BASE_URL"));

        let mut antigravity = HashMap::from([
            ("AGY_AUTH_METHOD".to_string(), "oauth-personal".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_CLOUD_PROJECT".to_string(), "project".to_string()),
        ]);
        apply_built_in_auth_mode_policy(&AgentId::parse("antigravity").unwrap(), &mut antigravity);
        assert!(!antigravity.contains_key("GEMINI_API_KEY"));
        assert!(!antigravity.contains_key("GOOGLE_CLOUD_PROJECT"));

        let mut legacy = HashMap::from([
            ("GEMINI_AUTH_MODE".to_string(), "gemini_api_key".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
        ]);
        apply_built_in_auth_mode_policy(&AgentId::parse("gemini").unwrap(), &mut legacy);
        assert_eq!(legacy.get("AGY_AUTH_METHOD").unwrap(), "gemini-api-key");
        assert_eq!(legacy.get("GEMINI_API_KEY").unwrap(), "secret");
        assert!(!legacy.contains_key("GOOGLE_API_KEY"));
    }

    #[test]
    fn cursor_and_grok_launch_knobs_become_root_arguments() {
        let mut cursor_args = vec!["acp".to_string()];
        apply_built_in_launch_argument_policy(
            &AgentId::parse("cursor").unwrap(),
            &HashMap::from([
                ("CURSOR_FORCE".to_string(), "1".to_string()),
                ("CURSOR_MODEL".to_string(), "composer-1".to_string()),
            ]),
            &mut cursor_args,
        );
        assert_eq!(cursor_args, ["--force", "--model", "composer-1", "acp"]);

        let mut grok_args = vec!["agent".to_string(), "stdio".to_string()];
        apply_built_in_launch_argument_policy(
            &AgentId::parse("grok").unwrap(),
            &HashMap::from([(
                "GROK_PERMISSION_MODE".to_string(),
                "acceptEdits".to_string(),
            )]),
            &mut grok_args,
        );
        assert_eq!(
            grok_args,
            [
                "--no-auto-update",
                "--permission-mode",
                "acceptEdits",
                "agent",
                "stdio"
            ]
        );

        let mut openclaw_args = vec!["acp".to_string()];
        apply_built_in_launch_argument_policy(
            &AgentId::parse("openclaw").unwrap(),
            &HashMap::from([
                (
                    "OPENCLAW_GATEWAY_URL".to_string(),
                    "wss://gateway.example".to_string(),
                ),
                ("OPENCLAW_SESSION_KEY".to_string(), "work".to_string()),
            ]),
            &mut openclaw_args,
        );
        assert_eq!(
            openclaw_args,
            ["acp", "--url", "wss://gateway.example", "--session", "work"]
        );
    }
}
