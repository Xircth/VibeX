use std::{
    collections::HashMap,
    env::split_paths,
    ffi::OsStr,
    path::{Path, PathBuf},
};

use api_types::{AgentAuthModeKind, AgentId, AgentKind};
use serde_json::Value;

use crate::{
    cli_exposure::{published_cli_shim_agent, published_cli_shim_target},
    native_config::NativeConfigSnapshot,
    permissions::AgentAutoApproveMode,
    pi_trust::PI_COMMAND_ENV,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltInAuthModePolicy {
    pub mode_env: &'static str,
    pub credential_env: &'static str,
    pub modes: &'static [&'static str],
    pub credential_modes: &'static [&'static str],
    pub subscription_scrub_env: &'static [&'static str],
    pub default_mode: &'static str,
}

const CLAUDE_MODES: &[&str] = &[
    "official_subscription",
    "official_api",
    "custom",
    "model_provider",
];
const CLAUDE_CREDENTIAL_MODES: &[&str] = &["official_api", "custom"];
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
const GROK_MODES: &[&str] = &["subscription", "api_key", "custom", "model_provider"];
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
        "opencode" => Some(BuiltInAuthModePolicy {
            mode_env: "OPENCODE_AUTH_MODE",
            credential_env: "OPENCODE_API_KEY",
            modes: OPENCODE_MODES,
            credential_modes: OPENCODE_CREDENTIAL_MODES,
            subscription_scrub_env: &[],
            default_mode: "official_subscription",
        }),
        "hermes" => Some(BuiltInAuthModePolicy {
            mode_env: "HERMES_AUTH_MODE",
            credential_env: "NOUS_API_KEY",
            modes: HERMES_MODES,
            credential_modes: HERMES_CREDENTIAL_MODES,
            subscription_scrub_env: &[],
            default_mode: "official_subscription",
        }),
        "kimi_code" => Some(BuiltInAuthModePolicy {
            mode_env: "KIMI_AUTH_MODE",
            credential_env: "KIMI_API_KEY",
            modes: KIMI_MODES,
            credential_modes: KIMI_CREDENTIAL_MODES,
            subscription_scrub_env: KIMI_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "cline" => Some(BuiltInAuthModePolicy {
            mode_env: "CLINE_AUTH_MODE",
            credential_env: "CLINE_API_KEY",
            modes: CLINE_MODES,
            credential_modes: CLINE_CREDENTIAL_MODES,
            subscription_scrub_env: &[],
            default_mode: "official_subscription",
        }),
        "codebuddy" => Some(BuiltInAuthModePolicy {
            mode_env: "CODEBUDDY_AUTH_MODE",
            credential_env: "CODEBUDDY_API_KEY",
            modes: CODEBUDDY_MODES,
            credential_modes: CODEBUDDY_CREDENTIAL_MODES,
            subscription_scrub_env: CODEBUDDY_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "pi" => Some(BuiltInAuthModePolicy {
            mode_env: "PI_AUTH_MODE",
            credential_env: "PI_API_KEY",
            modes: PI_MODES,
            credential_modes: &[],
            subscription_scrub_env: &[],
            default_mode: "model_provider",
        }),
        "openclaw" => Some(BuiltInAuthModePolicy {
            mode_env: "OPENCLAW_AUTH_MODE",
            credential_env: "OPENCLAW_API_KEY",
            modes: OPENCLAW_MODES,
            credential_modes: &[],
            subscription_scrub_env: &[],
            default_mode: "model_provider",
        }),
        "qoder" => Some(BuiltInAuthModePolicy {
            mode_env: "QODER_AUTH_MODE",
            credential_env: "QODER_API_KEY",
            modes: QODER_MODES,
            credential_modes: QODER_CREDENTIAL_MODES,
            subscription_scrub_env: QODER_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "kiro" => Some(BuiltInAuthModePolicy {
            mode_env: "KIRO_AUTH_MODE",
            credential_env: "KIRO_API_KEY",
            modes: KIRO_MODES,
            credential_modes: KIRO_CREDENTIAL_MODES,
            subscription_scrub_env: KIRO_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "auggie" => Some(BuiltInAuthModePolicy {
            mode_env: "AUGGIE_AUTH_MODE",
            credential_env: "AUGMENT_API_TOKEN",
            modes: STANDARD_THREE_MODES,
            credential_modes: STANDARD_CREDENTIAL_MODES,
            subscription_scrub_env: AUGGIE_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "trae" => Some(BuiltInAuthModePolicy {
            mode_env: "TRAE_AUTH_MODE",
            credential_env: "TRAE_API_KEY",
            modes: STANDARD_THREE_MODES,
            credential_modes: STANDARD_CREDENTIAL_MODES,
            subscription_scrub_env: TRAE_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "command_code" => Some(BuiltInAuthModePolicy {
            mode_env: "COMMAND_CODE_AUTH_MODE",
            credential_env: "COMMAND_CODE_API_KEY",
            modes: STANDARD_THREE_MODES,
            credential_modes: STANDARD_CREDENTIAL_MODES,
            subscription_scrub_env: COMMAND_CODE_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "zcode" => Some(BuiltInAuthModePolicy {
            mode_env: "ZCODE_AUTH_MODE",
            credential_env: "ZHIPU_API_KEY",
            modes: STANDARD_THREE_MODES,
            credential_modes: STANDARD_CREDENTIAL_MODES,
            subscription_scrub_env: ZCODE_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "mimo_code" => Some(BuiltInAuthModePolicy {
            mode_env: "MIMO_AUTH_MODE",
            credential_env: "MIMO_API_KEY",
            modes: MIMO_MODES,
            credential_modes: MIMO_CREDENTIAL_MODES,
            subscription_scrub_env: MIMO_SCRUB_ENV,
            default_mode: "official_subscription",
        }),
        "omp" => Some(BuiltInAuthModePolicy {
            mode_env: "OMP_AUTH_MODE",
            credential_env: "OMP_API_KEY",
            modes: OMP_MODES,
            credential_modes: &[],
            subscription_scrub_env: &[],
            default_mode: "official_subscription",
        }),
        _ => None,
    }
}

const OPENCODE_MODES: &[&str] = &["official_subscription", "model_provider"];
const OPENCODE_CREDENTIAL_MODES: &[&str] = &[];
const OMP_MODES: &[&str] = &["official_subscription", "model_provider"];
const HERMES_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const HERMES_CREDENTIAL_MODES: &[&str] = &["official_api"];
const KIMI_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const KIMI_CREDENTIAL_MODES: &[&str] = &["official_api"];
const KIMI_SCRUB_ENV: &[&str] = &[
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_MAX_CONTEXT_SIZE",
    "KIMI_MODEL_CAPABILITIES",
];
const CLINE_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const CLINE_CREDENTIAL_MODES: &[&str] = &["official_api"];
const CODEBUDDY_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const CODEBUDDY_CREDENTIAL_MODES: &[&str] = &["official_api"];
const CODEBUDDY_SCRUB_ENV: &[&str] = &["CODEBUDDY_API_KEY", "CODEBUDDY_BASE_URL"];
const QODER_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const QODER_CREDENTIAL_MODES: &[&str] = &["official_api"];
const QODER_SCRUB_ENV: &[&str] = &["QODER_API_KEY"];
const STANDARD_THREE_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const STANDARD_CREDENTIAL_MODES: &[&str] = &["official_api"];
const AUGGIE_SCRUB_ENV: &[&str] = &["AUGMENT_API_TOKEN", "AUGMENT_API_URL"];
const TRAE_SCRUB_ENV: &[&str] = &["TRAE_API_KEY"];
const COMMAND_CODE_SCRUB_ENV: &[&str] = &["COMMAND_CODE_API_KEY"];
const ZCODE_SCRUB_ENV: &[&str] = &["ZHIPU_API_KEY"];
const KIRO_MODES: &[&str] = &["official_subscription", "official_api"];
const KIRO_CREDENTIAL_MODES: &[&str] = &["official_api"];
const KIRO_SCRUB_ENV: &[&str] = &["KIRO_API_KEY"];
const MIMO_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const MIMO_CREDENTIAL_MODES: &[&str] = &["official_api"];
const MIMO_SCRUB_ENV: &[&str] = &["MIMO_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
const PI_MODES: &[&str] = &["model_provider"];
const OPENCLAW_MODES: &[&str] = &["model_provider"];

pub fn auth_mode_kind(agent_id: &AgentId, mode: &str) -> AgentAuthModeKind {
    match (agent_id.as_str(), mode) {
        (_, "model_provider") => AgentAuthModeKind::Provider,
        ("grok" | "deepseek_harness" | "kimi_code", "custom") => AgentAuthModeKind::Provider,
        ("claude_code", "official_api" | "custom") => AgentAuthModeKind::OfficialApi,
        ("codex", "api_key") => AgentAuthModeKind::OfficialApi,
        ("cursor", "custom") => AgentAuthModeKind::OfficialApi,
        ("deepseek_harness", "deepseek") => AgentAuthModeKind::OfficialApi,
        ("grok", "api_key") => AgentAuthModeKind::OfficialApi,
        (id, "gemini-api-key" | "agent-platform") if AgentKind::Antigravity.matches_id(id) => {
            AgentAuthModeKind::OfficialApi
        }
        (id, "oauth-personal" | "oauth-business" | "login_google")
            if AgentKind::Antigravity.matches_id(id) =>
        {
            AgentAuthModeKind::Subscription
        }
        (_, mode)
            if mode == "subscription"
                || mode == "official_subscription"
                || mode.ends_with("_subscription") =>
        {
            AgentAuthModeKind::Subscription
        }
        _ => AgentAuthModeKind::OfficialApi,
    }
}

pub fn resolve_built_in_auth_mode(
    agent_id: &AgentId,
    policy: BuiltInAuthModePolicy,
    env: &HashMap<String, String>,
    bound_provider: bool,
    native_custom_endpoint: bool,
    snapshot: Option<&NativeConfigSnapshot>,
) -> String {
    let uses_model_provider =
        policy.modes.contains(&"model_provider") && (bound_provider || native_custom_endpoint);
    // Agent native config is the source of truth. A stale Dimo mode overlay
    // must not hide a Provider the runtime is already using; switching away
    // from Provider routing writes the native files first, then this overlay.
    if uses_model_provider {
        return "model_provider".to_string();
    }
    if let Some(mode) = env
        .get(policy.mode_env)
        .filter(|mode| policy.modes.contains(&mode.as_str()))
        .filter(|mode| mode.as_str() != "model_provider")
    {
        return mode.clone();
    }
    if agent_id.as_str() == "claude_code" {
        if snapshot.is_some_and(|snapshot| snapshot.field_present("anthropic_api_key")) {
            return "official_api".to_string();
        }
        return "official_subscription".to_string();
    }
    if snapshot.is_some_and(|snapshot| snapshot.field_present("antigravity_api_key")) {
        return "gemini-api-key".to_string();
    }
    if snapshot.is_some_and(|snapshot| {
        snapshot.field_present("antigravity_google_api_key")
            || snapshot.field_text("antigravity_cloud_project").is_some()
    }) {
        return "agent-platform".to_string();
    }
    if policy.modes.contains(&"oauth-personal") {
        return "oauth-personal".to_string();
    }
    if agent_id.as_str() == "deepseek_harness"
        && env
            .get("DEEPSEEK_BASE_URL")
            .is_some_and(|value| !value.trim().is_empty() && !is_deepseek_official_base_url(value))
    {
        return "custom".to_string();
    }
    env.get(policy.credential_env)
        .filter(|value| !value.trim().is_empty())
        .and_then(|_| policy.credential_modes.first().copied())
        .map(str::to_string)
        .unwrap_or_else(|| policy.default_mode.to_string())
}

pub fn native_uses_custom_endpoint(agent_id: &AgentId, snapshot: &NativeConfigSnapshot) -> bool {
    let Some(url) = (match agent_id.as_str() {
        "claude_code" => snapshot.field_text("anthropic_base_url"),
        "grok" => snapshot.field_text("grok_base_url"),
        "kimi_code" => snapshot.field_text("kimi_base_url"),
        "cline" => snapshot.field_text("cline_base_url"),
        "hermes" => snapshot.field_text("hermes_base_url"),
        "codex" => snapshot.field_text("codex_openai_base_url"),
        "codebuddy" => snapshot.field_text("codebuddy_base_url"),
        _ => None,
    }) else {
        return false;
    };
    is_non_official_api_url(agent_id, url)
}

pub fn is_non_official_api_url(agent_id: &AgentId, url: &str) -> bool {
    let normalized = normalize_api_url(url);
    if normalized.is_empty() {
        return false;
    }
    if agent_id.as_str() == "deepseek_harness" && is_deepseek_official_base_url(url) {
        return false;
    }
    let official = official_api_url(agent_id, "official_api")
        .or_else(|| official_api_url(agent_id, "custom"))
        .or_else(|| official_api_url(agent_id, "api_key"))
        .or_else(|| official_api_url(agent_id, "gemini-api-key"))
        .or_else(|| official_api_url(agent_id, "deepseek"))
        .map(normalize_api_url)
        .unwrap_or_default();
    official.is_empty() || normalized != official
}

fn normalize_api_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').to_ascii_lowercase();
    trimmed
        .strip_suffix("/v1")
        .unwrap_or(trimmed.as_str())
        .trim_end_matches('/')
        .to_string()
}

pub const DEEPSEEK_OFFICIAL_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL: &str = "https://api.deepseek.com/anthropic";

pub fn is_deepseek_official_base_url(url: &str) -> bool {
    let normalized = url.trim().trim_end_matches('/');
    normalized.eq_ignore_ascii_case(DEEPSEEK_OFFICIAL_BASE_URL)
        || normalized.eq_ignore_ascii_case(DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL)
}

fn is_deepseek_official_anthropic_base_url(url: &str) -> bool {
    url.trim()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL)
}

pub fn official_api_url(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_api" | "custom") => Some("https://api.anthropic.com"),
        ("codex", "api_key") => Some("https://api.openai.com/v1"),
        ("grok", "api_key") => Some("https://api.x.ai/v1"),
        ("deepseek_harness", "deepseek") => Some(DEEPSEEK_OFFICIAL_BASE_URL),
        (id, "gemini-api-key") if AgentKind::Antigravity.matches_id(id) => {
            Some("https://generativelanguage.googleapis.com")
        }
        ("kimi_code", "official_api") => Some("https://api.moonshot.ai/v1"),
        ("cline", "official_api") => Some("https://api.cline.bot"),
        ("hermes", "official_api") => Some("https://inference-api.nousresearch.com/v1"),
        ("codebuddy", "official_api") => Some("https://www.codebuddy.ai"),
        ("qoder", "official_api") => Some("https://openapi.qoder.com"),
        ("auggie", "official_api") => Some("https://api.augmentcode.com"),
        ("trae", "official_api") => Some("https://api.trae.ai"),
        ("command_code", "official_api") => Some("https://api.commandcode.ai"),
        ("zcode", "official_api") => Some("https://open.bigmodel.cn/api/paas/v4"),
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
                && env.get("DEEPSEEK_BASE_URL").is_some_and(|value| {
                    !value.trim().is_empty() && !is_deepseek_official_base_url(value)
                })
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
    let mode = resolved_auth_mode(agent_id, policy, env).to_string();
    let preserve_deepseek_anthropic_url = agent_id.as_str() == "deepseek_harness"
        && mode == "deepseek"
        && env
            .get("DEEPSEEK_BASE_URL")
            .is_some_and(|value| is_deepseek_official_anthropic_base_url(value));
    if mode != "official_api" {
        match agent_id.as_str() {
            "qoder" => {
                if env.get("QODER_PERSONAL_ACCESS_TOKEN").map(|v| v.trim())
                    == env.get("QODER_API_KEY").map(|v| v.trim())
                {
                    env.remove("QODER_PERSONAL_ACCESS_TOKEN");
                }
            }
            "trae" => {
                if env.get("TRAECLI_PERSONAL_ACCESS_TOKEN").map(|v| v.trim())
                    == env.get("TRAE_API_KEY").map(|v| v.trim())
                {
                    env.remove("TRAECLI_PERSONAL_ACCESS_TOKEN");
                }
            }
            _ => {}
        }
    }
    for key in auth_mode_scrubbed_env_keys(agent_id, &mode) {
        if *key == "DEEPSEEK_BASE_URL" && preserve_deepseek_anthropic_url {
            env.insert(
                "DEEPSEEK_BASE_URL".to_string(),
                DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL.to_string(),
            );
            continue;
        }
        env.remove(*key);
    }
    if agent_id.as_str() == "cursor" {
        env.remove("CURSOR_API_BASE_URL");
    }
    if mode == "official_api" {
        match agent_id.as_str() {
            "qoder" => {
                if let Some(key) = env
                    .get("QODER_API_KEY")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                {
                    env.insert("QODER_PERSONAL_ACCESS_TOKEN".to_string(), key);
                }
            }
            "trae" => {
                if let Some(key) = env
                    .get("TRAE_API_KEY")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                {
                    env.insert("TRAECLI_PERSONAL_ACCESS_TOKEN".to_string(), key);
                }
            }
            _ => {}
        }
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
    if agent_id.as_str() == "deepseek_harness"
        && mode == "deepseek"
        && env
            .get("DEEPSEEK_BASE_URL")
            .is_some_and(|value| is_deepseek_official_anthropic_base_url(value))
    {
        return &[];
    }
    auth_mode_scrubbed_env_keys(agent_id, mode)
}

pub fn auth_mode_credential_env(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        (id, "agent-platform") if AgentKind::Antigravity.matches_id(id) => Some("GOOGLE_API_KEY"),
        (id, "gemini-api-key") if AgentKind::Antigravity.matches_id(id) => Some("GEMINI_API_KEY"),
        ("claude_code", "official_api" | "custom") => Some("ANTHROPIC_API_KEY"),
        ("grok", "api_key") => Some("XAI_API_KEY"),
        ("cursor", "custom") => Some("CURSOR_API_KEY"),
        ("deepseek_harness", "deepseek" | "custom") => Some("DEEPSEEK_API_KEY"),
        ("opencode", "official_api") => Some("OPENCODE_API_KEY"),
        ("hermes", "official_api") => Some("NOUS_API_KEY"),
        ("kimi_code", "official_api") => Some("KIMI_API_KEY"),
        ("cline", "official_api") => Some("CLINE_API_KEY"),
        ("codebuddy", "official_api") => Some("CODEBUDDY_API_KEY"),
        ("qoder", "official_api") => Some("QODER_API_KEY"),
        ("kiro", "official_api") => Some("KIRO_API_KEY"),
        ("auggie", "official_api") => Some("AUGMENT_API_TOKEN"),
        ("trae", "official_api") => Some("TRAE_API_KEY"),
        ("command_code", "official_api") => Some("COMMAND_CODE_API_KEY"),
        ("zcode", "official_api") => Some("ZHIPU_API_KEY"),
        _ => None,
    }
}

/// Same-account secret for a headless machine. This is not an official API
/// mode: the settings API-key field stays hidden, and subscription login keeps
/// the value.
pub fn headless_account_env(agent_id: &AgentId) -> Option<&'static str> {
    match agent_id.as_str() {
        "codebuddy" => Some("CODEBUDDY_AUTH_TOKEN"),
        "qoder" => Some("QODER_PERSONAL_ACCESS_TOKEN"),
        "auggie" => Some("AUGMENT_SESSION_AUTH"),
        "trae" => Some("TRAECLI_PERSONAL_ACCESS_TOKEN"),
        "command_code" => Some("COMMAND_CODE_AUTH_TOKEN"),
        "zcode" => Some("ZCODE_AUTH_TOKEN"),
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
        ("grok", "subscription" | "model_provider") => GROK_SCRUB_ENV,
        ("cursor", "subscription") => built_in_auth_mode_policy(agent_id)
            .map(|policy| policy.subscription_scrub_env)
            .unwrap_or_default(),
        ("deepseek_harness", "deepseek") => DSH_OFFICIAL_SCRUB_ENV,
        ("kimi_code", "official_subscription" | "model_provider") => KIMI_SCRUB_ENV,
        ("codebuddy", "official_subscription" | "model_provider") => CODEBUDDY_SCRUB_ENV,
        ("qoder", "official_subscription" | "model_provider") => QODER_SCRUB_ENV,
        ("kiro", "official_subscription") => KIRO_SCRUB_ENV,
        ("auggie", "official_subscription" | "model_provider") => AUGGIE_SCRUB_ENV,
        ("trae", "official_subscription" | "model_provider") => TRAE_SCRUB_ENV,
        ("command_code", "official_subscription" | "model_provider") => COMMAND_CODE_SCRUB_ENV,
        ("zcode", "official_subscription" | "model_provider") => ZCODE_SCRUB_ENV,
        ("mimo_code", "official_subscription" | "model_provider") => MIMO_SCRUB_ENV,
        _ => &[],
    }
}

pub fn apply_built_in_launch_argument_policy(
    agent_id: &AgentId,
    env: &HashMap<String, String>,
    args: &mut Vec<String>,
) {
    apply_built_in_launch_argument_policy_for_program(agent_id, None, env, args);
}

pub fn apply_built_in_launch_argument_policy_for_program(
    agent_id: &AgentId,
    program: Option<&Path>,
    env: &HashMap<String, String>,
    args: &mut Vec<String>,
) {
    if let Some(profile) = crate::profiles::BuiltInProfileCatalog::management().profile(agent_id)
        && profile.topology == crate::profiles::ProfileTopology::NativeAcp
    {
        crate::profiles::normalize_acp_launch_args_for_program(
            profile,
            crate::profiles::ProfileComponent::CombinedRuntime,
            program,
            args,
        );
    }
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
            let mode = env
                .get("GROK_PERMISSION_MODE")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty());
            if grok_mode_skips_permission_prompts(mode) {
                if let Some(index) = args.iter().position(|argument| argument == "agent") {
                    args.insert(index + 1, "--always-approve".to_string());
                } else {
                    args.insert(0, "--always-approve".to_string());
                }
            } else if let Some(cli_mode) = grok_cli_permission_mode(mode) {
                prefix.extend(["--permission-mode".to_string(), cli_mode.to_string()]);
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
    apply_built_in_launch_policy_for_program(agent_id, None, env, args);
}

pub fn apply_built_in_launch_policy_for_program(
    agent_id: &AgentId,
    program: Option<&Path>,
    env: &mut HashMap<String, String>,
    args: &mut Vec<String>,
) {
    apply_built_in_auth_mode_policy(agent_id, env);
    if AgentKind::Antigravity.matches_id(agent_id.as_str()) {
        let _ = crate::apply_antigravity_launch_env(env);
    }
    match agent_id.as_str() {
        // codex-acp otherwise removes an ACP-injected companion when a global
        // or project Codex config already defines a server with the same name.
        "codex" => {
            env.insert(
                "DISABLE_MCP_CONFIG_FILTERING".to_string(),
                "true".to_string(),
            );
            if codex_uses_chatgpt_subscription(env) {
                env.remove("OPENAI_API_KEY");
                env.remove("OPENAI_BASE_URL");
            }
            apply_codex_initial_agent_mode(env);
        }
        // pi-acp only advertises embedded-context support behind this switch.
        "pi" => {
            env.insert(
                "PI_ACP_ENABLE_EMBEDDED_CONTEXT".to_string(),
                "true".to_string(),
            );
            // pi-acp 0.0.33 hardcodes includeExtensionCommands=false. Newer
            // adapters honor this env; Dimo also merges discovered extension
            // commands into the ACP catalog so `/` can list them either way.
            env.insert(
                "PI_ACP_ENABLE_EXTENSION_COMMANDS".to_string(),
                "true".to_string(),
            );
            let home = env
                .get("HOME")
                .or_else(|| env.get("USERPROFILE"))
                .map(PathBuf::from)
                .or_else(dirs::home_dir);
            if let Some(home) = home {
                apply_pi_native_launch_env(&home, env);
            }
            let requested = env.get(PI_COMMAND_ENV).cloned();
            bind_pi_acp_pi_command(env, requested.as_deref());
        }
        "grok" => apply_grok_native_launch_env(env),
        "deepseek_harness" => apply_dsh_native_launch_env(env),
        "kimi_code" => apply_kimi_native_launch_env(env),
        // In-process Cline runtime so model switches apply, and no
        // `npm update -g cline` after stdin closes (Codeg pin 3.0.73).
        "cline" => {
            env.entry("CLINE_SESSION_BACKEND_MODE".to_string())
                .or_insert_with(|| "local".into());
            env.entry("CLINE_NO_AUTO_UPDATE".to_string())
                .or_insert_with(|| "1".into());
        }
        // OMP reads PI_CODING_AGENT_DIR. The parent process often has that
        // variable for Pi. Pin this child to the OMP directory Dimo writes,
        // and do not inherit Pi's ACP switches. MCP stays on session/new.
        "omp" => apply_omp_native_launch_env(env),
        _ => {}
    }
    apply_built_in_launch_argument_policy_for_program(agent_id, program, env, args);
}

/// Kimi Code CLI v2.x (`@moonshot-ai/kimi-code`) only triggers its env-var model
/// overlay (`__kimi_env__` / `__kimi_env_model__`) when both `KIMI_MODEL_NAME`
/// and `KIMI_MODEL_API_KEY` are non-empty; a bare `KIMI_API_KEY` is ignored.
/// Project `KIMI_API_KEY` (+ optional `KIMI_BASE_URL`) into `KIMI_MODEL_*`
/// without overwriting explicit user overrides.
fn apply_kimi_native_launch_env(env: &mut HashMap<String, String>) {
    let Ok(kimi_id) = AgentId::parse("kimi_code") else {
        return;
    };
    let Some(policy) = built_in_auth_mode_policy(&kimi_id) else {
        return;
    };
    if resolved_auth_mode(&kimi_id, policy, env) != "official_api" {
        return;
    }
    let Some(api_key) = env
        .get("KIMI_API_KEY")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if env
        .get("KIMI_MODEL_API_KEY")
        .is_none_or(|value| value.trim().is_empty())
    {
        env.insert("KIMI_MODEL_API_KEY".to_string(), api_key);
    }
    if env
        .get("KIMI_MODEL_PROVIDER_TYPE")
        .is_none_or(|value| value.trim().is_empty())
    {
        env.insert("KIMI_MODEL_PROVIDER_TYPE".to_string(), "kimi".to_string());
    }
    if env
        .get("KIMI_MODEL_BASE_URL")
        .is_none_or(|value| value.trim().is_empty())
        && let Some(base_url) = env
            .get("KIMI_BASE_URL")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    {
        env.insert("KIMI_MODEL_BASE_URL".to_string(), base_url);
    }
    if env
        .get("KIMI_MODEL_NAME")
        .is_none_or(|value| value.trim().is_empty())
    {
        let model_name = kimi_config_model_name(env).unwrap_or_else(|| {
            let base_url = env
                .get("KIMI_MODEL_BASE_URL")
                .or_else(|| env.get("KIMI_BASE_URL"))
                .map(String::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if base_url.contains("kimi.com/coding") || base_url.contains("kimi.ai/coding") {
                "kimi-for-coding".to_string()
            } else {
                "kimi-k2.5".to_string()
            }
        });
        env.insert("KIMI_MODEL_NAME".to_string(), model_name);
    }
}

fn kimi_config_model_name(env: &HashMap<String, String>) -> Option<String> {
    let mut dirs = Vec::new();
    if let Some(home) = env
        .get("KIMI_CODE_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        dirs.push(PathBuf::from(home));
    } else if let Some(home) = std::env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty())
    {
        dirs.push(PathBuf::from(home));
    }
    if let Some(home) = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
    {
        dirs.push(home.join(".kimi-code"));
        dirs.push(home.join(".kimi"));
    }
    for dir in dirs {
        let Ok(text) = std::fs::read_to_string(dir.join("config.toml")) else {
            continue;
        };
        let Ok(table) = text.parse::<toml::Table>() else {
            continue;
        };
        let Some(default_model) = table
            .get("default_model")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| {
                !value.is_empty() && *value != "dimo" && !value.starts_with("managed:")
            })
        else {
            continue;
        };
        if let Some(model) = table
            .get("models")
            .and_then(toml::Value::as_table)
            .and_then(|models| models.get(default_model))
            .and_then(toml::Value::as_table)
            .and_then(|entry| entry.get("model"))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(model.to_string());
        }
        return Some(default_model.to_string());
    }
    None
}

fn apply_omp_native_launch_env(env: &mut HashMap<String, String>) {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(dirs::home_dir);
    let Some(home) = home else {
        return;
    };
    let map = env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let agent_dir = crate::omp_auth::agent_dir(&home, &map);
    env.insert(
        "PI_CODING_AGENT_DIR".to_string(),
        agent_dir.to_string_lossy().into_owned(),
    );
    env.remove("PI_ACP_ENABLE_EMBEDDED_CONTEXT");
    env.remove("PI_ACP_ENABLE_EXTENSION_COMMANDS");
    env.remove("PI_ACP_PI_COMMAND");
    env.remove("PI_CODING_AGENT_SESSION_DIR");
}

fn dsh_config_dir(env: &HashMap<String, String>) -> PathBuf {
    if let Some(home) = env
        .get("DSH_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(home);
    }
    if let Some(home) = std::env::var_os("DSH_HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(home);
    }
    env.get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .map(|home| home.join(".dsh"))
        .unwrap_or_else(|| PathBuf::from(".dsh"))
}

fn sanitize_and_read_dsh_credentials(dsh_dir: &Path) -> Option<String> {
    let path = dsh_dir.join(".credentials.yaml");
    let text = std::fs::read_to_string(&path).ok()?;
    let mut doc: serde_json::Value = serde_yaml::from_str(&text).ok()?;
    let root = doc.as_object_mut()?;
    let mut mutated = false;
    let stray: Vec<(String, serde_json::Value)> = root
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "version" | "records" | "refs"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !stray.is_empty() {
        mutated = true;
        for (key, _) in &stray {
            root.remove(key);
        }
    }
    if root.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        root.insert(
            "version".to_string(),
            serde_json::Value::Number(serde_json::Number::from(1)),
        );
        mutated = true;
    }
    if !stray.is_empty() {
        let refs = root
            .entry("refs")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !refs.is_object() {
            *refs = serde_json::Value::Object(serde_json::Map::new());
        }
        if let Some(refs_obj) = refs.as_object_mut() {
            for (key, value) in stray {
                if value.is_string() {
                    refs_obj.entry(key).or_insert(value);
                }
            }
        }
    }
    let api_key = root
        .get("refs")
        .and_then(serde_json::Value::as_object)
        .and_then(|refs| {
            refs.get("DEEPSEEK_API_KEY")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    refs.values()
                        .find_map(|value| value.as_str().map(str::trim))
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                })
        });
    if mutated && let Ok(serialized) = serde_yaml::to_string(&doc) {
        let _ = std::fs::write(&path, serialized);
    }
    api_key
}

fn apply_dsh_native_launch_env(env: &mut HashMap<String, String>) {
    let dsh_dir = dsh_config_dir(env);
    let credential_key = sanitize_and_read_dsh_credentials(&dsh_dir);
    let has_env_key = env
        .get("DEEPSEEK_API_KEY")
        .map(|value| value.trim())
        .is_some_and(|value| !value.is_empty());
    if !has_env_key && let Some(api_key) = credential_key {
        env.insert("DEEPSEEK_API_KEY".to_string(), api_key);
    }
    if let Some(base_url) = env.get("DEEPSEEK_BASE_URL").cloned() {
        let normalized = base_url.trim().trim_end_matches('/').to_string();
        if normalized.is_empty() {
            env.remove("DEEPSEEK_BASE_URL");
        } else {
            env.insert("DEEPSEEK_BASE_URL".to_string(), normalized);
        }
    }
    if env.contains_key("DEEPSEEK_ACP_PROVIDER") {
        env.insert(
            "DEEPSEEK_ACP_PROVIDER".to_string(),
            "deepseek-official".to_string(),
        );
    }
}

/// Carry Grok's native `ui.permission_mode` into the launch env so new sessions
/// honor the settings UI after an auth-mode change (which rewrites env_json
/// without copying `GROK_PERMISSION_MODE`).
fn apply_grok_native_launch_env(env: &mut HashMap<String, String>) {
    if env
        .get("GROK_PERMISSION_MODE")
        .map(|value| value.trim())
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    if let Some(mode) = read_grok_permission_mode(env) {
        env.insert("GROK_PERMISSION_MODE".to_string(), mode);
    }
}

fn grok_config_dir(env: &HashMap<String, String>) -> PathBuf {
    if let Some(home) = env
        .get("GROK_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(home);
    }
    if let Some(home) = std::env::var_os("GROK_HOME") {
        return PathBuf::from(home);
    }
    env.get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .map(|home| home.join(".grok"))
        .unwrap_or_else(|| PathBuf::from(".grok"))
}

fn read_grok_permission_mode(env: &HashMap<String, String>) -> Option<String> {
    let path = grok_config_dir(env).join("config.toml");
    let text = std::fs::read_to_string(path).ok()?;
    let value: toml::Value = toml::from_str(&text).ok()?;
    let mode = value
        .get("ui")
        .and_then(|ui| ui.get("permission_mode"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(match mode {
        "bypassPermissions" => "always-approve".to_string(),
        "default" => "ask".to_string(),
        other => other.to_string(),
    })
}

const CODEX_APPROVAL_POLICIES: &[&str] = &["untrusted", "on-request", "never"];
const CODEX_SANDBOX_MODES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

/// Seed `INITIAL_AGENT_MODE` from `~/.codex/config.toml` before launch.
/// codex-acp re-sends its own approval/sandbox preset every turn; without this
/// the adapter default `agent` silently overrides the user's config (#442).
/// An explicit non-empty env value wins.
fn apply_codex_initial_agent_mode(env: &mut HashMap<String, String>) {
    if env
        .get("INITIAL_AGENT_MODE")
        .map(|value| value.trim())
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    if let Some(mode) = read_codex_initial_agent_mode(env) {
        env.insert("INITIAL_AGENT_MODE".to_string(), mode);
    }
}

fn codex_config_dir(env: &HashMap<String, String>) -> PathBuf {
    if let Some(home) = env
        .get("CODEX_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(home);
    }
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(home);
    }
    env.get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .map(|home| home.join(".codex"))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

pub fn codex_uses_chatgpt_subscription(env: &HashMap<String, String>) -> bool {
    let Some(auth) = read_json_object(&codex_config_dir(env).join("auth.json")) else {
        return false;
    };
    auth.get("auth_mode").and_then(Value::as_str) == Some("chatgpt")
}

fn read_codex_initial_agent_mode(env: &HashMap<String, String>) -> Option<String> {
    let text = std::fs::read_to_string(codex_config_dir(env).join("config.toml")).ok()?;
    codex_initial_agent_mode_from_toml(&text)
}

/// Map a `~/.codex/config.toml` sandbox/approval pair onto the preset id
/// codex-acp accepts. `None` leaves the adapter default in place.
pub(crate) fn codex_initial_agent_mode_from_toml(raw_toml: &str) -> Option<String> {
    let table = raw_toml.parse::<toml::Table>().ok()?;
    if table.contains_key("default_permissions") {
        return None;
    }
    let approval = table
        .get("approval_policy")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .map(|value| match value {
            "on-failure" => "on-request",
            other => other,
        })
        .filter(|value| CODEX_APPROVAL_POLICIES.contains(value));
    let never = approval == Some("never");
    let sandbox = table
        .get("sandbox_mode")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| CODEX_SANDBOX_MODES.contains(value))?;
    Some(
        match sandbox {
            "read-only" => "read-only",
            "workspace-write" if never => "agent",
            "workspace-write" => "workspace-write",
            "danger-full-access" if never => "agent-full-access",
            "danger-full-access" => "workspace-write",
            _ => return None,
        }
        .to_string(),
    )
}

/// Point `pi` at the same native files Dimo projected, and export the bound
/// provider key as `PI_API_KEY` so `models.json` `$PI_API_KEY` and ACP
/// `get_available_models` see a configured provider.
pub fn apply_pi_native_launch_env(home: &Path, env: &mut HashMap<String, String>) {
    let agent_dir = pi_agent_dir(home, env);
    if env
        .get("PI_CODING_AGENT_DIR")
        .map(|value| value.trim())
        .is_none_or(|value| value.is_empty())
    {
        env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir.to_string_lossy().into_owned(),
        );
    }
    if env
        .get("PI_API_KEY")
        .map(|value| value.trim())
        .is_some_and(|value| !value.is_empty())
    {
        return;
    }
    if let Some(key) = read_pi_default_provider_key(&agent_dir) {
        env.insert("PI_API_KEY".to_string(), key);
    }
}

/// Point `pi-acp` at a spawnable `pi` command.
///
/// pi-acp defaults to `pi.cmd` + `shell: true` on Windows. Prefer a same-stem
/// `.exe` when one exists so Node can spawn without a shell. If only a batch
/// shim is present, keep that absolute path so pi-acp can still start the
/// session. `requested` is the user-configured command, not a previously
/// resolved path.
pub fn bind_pi_acp_pi_command(env: &mut HashMap<String, String>, requested: Option<&str>) {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    if let Some(path) = resolve_pi_acp_command(requested, env.get("PATH").map(String::as_str)) {
        env.insert(
            PI_COMMAND_ENV.to_string(),
            path.as_os_str().to_string_lossy().into_owned(),
        );
        return;
    }
    match requested {
        Some(requested) => {
            env.insert(PI_COMMAND_ENV.to_string(), requested.to_string());
        }
        None => {
            env.remove(PI_COMMAND_ENV);
        }
    }
}

pub fn resolve_pi_acp_command(
    requested: Option<&str>,
    search_path: Option<&str>,
) -> Option<PathBuf> {
    let search_path = search_path
        .map(OsStr::new)
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"));
    let search_path = search_path.as_deref();
    if let Some(requested) = requested {
        if let Some(path) = resolve_explicit_pi_path(requested) {
            return Some(path);
        }
        if let Some(path) = lookup_pi_on_path(&pi_lookup_names(requested), search_path) {
            return Some(path);
        }
    }
    lookup_pi_on_path(&pi_lookup_names("pi"), search_path)
}

fn resolve_explicit_pi_path(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if !(path.is_absolute() || command.contains(['/', '\\'])) {
        return None;
    }
    if !path.is_file() {
        return None;
    }
    Some(prefer_pi_spawn_path(path.to_path_buf()))
}

fn pi_lookup_names(requested: &str) -> Vec<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Vec::new();
    }
    if Path::new(requested).extension().is_some() {
        return vec![requested.to_string()];
    }
    #[cfg(windows)]
    {
        vec![
            format!("{requested}.exe"),
            format!("{requested}.com"),
            format!("{requested}.cmd"),
            format!("{requested}.bat"),
            requested.to_string(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![requested.to_string()]
    }
}

fn lookup_pi_on_path(names: &[String], search_path: Option<&OsStr>) -> Option<PathBuf> {
    let search_path = search_path?;
    let mut shim_fallback = None;
    for dir in split_paths(search_path) {
        for name in names {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            if published_cli_shim_agent(&candidate).is_some() {
                if shim_fallback.is_none() {
                    shim_fallback = published_cli_shim_target(&candidate)
                        .map(prefer_pi_spawn_path)
                        .or_else(|| Some(prefer_pi_spawn_path(candidate)));
                }
                continue;
            }
            return Some(prefer_pi_spawn_path(candidate));
        }
    }
    shim_fallback
}

fn prefer_pi_spawn_path(path: PathBuf) -> PathBuf {
    let preferred = workspace_utils::process::prefer_direct_spawn_executable(&path);
    if published_cli_shim_agent(&preferred).is_some()
        && let Some(target) = published_cli_shim_target(&preferred)
    {
        return workspace_utils::process::prefer_direct_spawn_executable(target);
    }
    if published_cli_shim_agent(&path).is_some()
        && let Some(target) = published_cli_shim_target(&path)
    {
        return workspace_utils::process::prefer_direct_spawn_executable(target);
    }
    preferred
}

fn pi_agent_dir(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    env.get("PI_CODING_AGENT_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| expand_pi_home(value, home))
        .unwrap_or_else(|| home.join(".pi/agent"))
}

fn expand_pi_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(relative) = path.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(path)
    }
}

fn read_pi_default_provider_key(agent_dir: &Path) -> Option<String> {
    let settings = read_json_object(&agent_dir.join("settings.json")).unwrap_or(Value::Null);
    let auth = read_json_object(&agent_dir.join("auth.json")).unwrap_or(Value::Null);
    let models = read_json_object(&agent_dir.join("models.json")).unwrap_or(Value::Null);
    let default_provider = settings
        .get("defaultProvider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(provider) = default_provider {
        let key = pi_stored_api_key(&auth, provider);
        if !key.is_empty() {
            return Some(key);
        }
        let inline = pi_inline_literal_api_key(&models, provider);
        if !inline.is_empty() {
            return Some(inline);
        }
    }
    auth.as_object().and_then(|entries| {
        entries.iter().find_map(|(id, entry)| {
            let key = pi_auth_entry_key(entry);
            (!key.is_empty()).then_some(key).or_else(|| {
                let inline = pi_inline_literal_api_key(&models, id);
                (!inline.is_empty()).then_some(inline)
            })
        })
    })
}

fn pi_stored_api_key(auth: &Value, provider: &str) -> String {
    auth.get(provider)
        .map(pi_auth_entry_key)
        .unwrap_or_default()
}

fn pi_auth_entry_key(entry: &Value) -> String {
    ["key", "apiKey", "api_key"]
        .iter()
        .find_map(|name| {
            entry
                .get(*name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn pi_inline_literal_api_key(models: &Value, provider: &str) -> String {
    let Some(value) = models
        .get("providers")
        .and_then(|providers| providers.get(provider))
        .and_then(|node| node.get("apiKey").or_else(|| node.get("api_key")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return String::new();
    };
    if value.starts_with('$') || value.starts_with('!') {
        return String::new();
    }
    value.to_string()
}

fn read_json_object(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let value = serde_json::from_slice::<Value>(&bytes).ok()?;
    value.is_object().then_some(value)
}

pub fn auto_approve_mode_for_launch(
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> AgentAutoApproveMode {
    match agent_id.as_str() {
        "grok" => {
            let mode = env.get("GROK_PERMISSION_MODE").map(String::as_str);
            if grok_mode_skips_permission_prompts(mode.map(str::trim)) {
                AgentAutoApproveMode::Yolo
            } else {
                AgentAutoApproveMode::Off
            }
        }
        "omp" => {
            if read_omp_approval_mode(env).as_deref() == Some("yolo") {
                AgentAutoApproveMode::Yolo
            } else {
                AgentAutoApproveMode::Off
            }
        }
        _ => AgentAutoApproveMode::Off,
    }
}

fn read_omp_approval_mode(env: &HashMap<String, String>) -> Option<String> {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let btree_env: std::collections::BTreeMap<String, String> =
        env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let config_path = crate::omp_auth::agent_dir(&home, &btree_env).join("config.yml");
    let text = std::fs::read_to_string(config_path).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
    value
        .get("tools")
        .and_then(|tools| tools.get("approvalMode"))
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
        .map(str::to_string)
}

fn grok_mode_skips_permission_prompts(mode: Option<&str>) -> bool {
    matches!(mode, Some("always-approve" | "bypassPermissions"))
}

fn grok_cli_permission_mode(mode: Option<&str>) -> Option<&'static str> {
    match mode {
        Some("auto") => Some("auto"),
        Some("acceptEdits") => Some("acceptEdits"),
        Some("dontAsk") => Some("dontAsk"),
        Some("plan") => Some("plan"),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
