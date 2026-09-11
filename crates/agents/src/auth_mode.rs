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
            subscription_scrub_env: &[],
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
            credential_modes: &[],
            subscription_scrub_env: &[],
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
            credential_env: "QODER_PERSONAL_ACCESS_TOKEN",
            modes: QODER_MODES,
            credential_modes: &[],
            subscription_scrub_env: &[],
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
        _ => None,
    }
}

const OPENCODE_MODES: &[&str] = &["official_subscription", "model_provider"];
const OPENCODE_CREDENTIAL_MODES: &[&str] = &[];
const HERMES_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const HERMES_CREDENTIAL_MODES: &[&str] = &["official_api"];
const KIMI_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const KIMI_CREDENTIAL_MODES: &[&str] = &["official_api"];
const CLINE_MODES: &[&str] = &["official_subscription", "official_api", "model_provider"];
const CLINE_CREDENTIAL_MODES: &[&str] = &["official_api"];
const CODEBUDDY_MODES: &[&str] = &["official_subscription"];
const QODER_MODES: &[&str] = &["official_subscription"];
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
    if policy.modes.contains(&"model_provider") && (bound_provider || native_custom_endpoint) {
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
            .is_some_and(|value| !value.trim().is_empty())
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

pub fn official_api_url(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_api" | "custom") => Some("https://api.anthropic.com"),
        ("codex", "api_key") => Some("https://api.openai.com/v1"),
        ("grok", "api_key") => Some("https://api.x.ai/v1"),
        ("deepseek_harness", "deepseek") => Some("https://api.deepseek.com"),
        (id, "gemini-api-key") if AgentKind::Antigravity.matches_id(id) => {
            Some("https://generativelanguage.googleapis.com")
        }
        ("kimi_code", "official_api") => Some("https://api.moonshot.ai/v1"),
        ("cline", "official_api") => Some("https://api.cline.bot"),
        ("hermes", "official_api") => Some("https://inference-api.nousresearch.com/v1"),
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
        ("claude_code", "official_api" | "custom") => Some("ANTHROPIC_API_KEY"),
        ("grok", "api_key") => Some("XAI_API_KEY"),
        ("cursor", "custom") => Some("CURSOR_API_KEY"),
        ("deepseek_harness", "deepseek" | "custom") => Some("DEEPSEEK_API_KEY"),
        ("opencode", "official_api") => Some("OPENCODE_API_KEY"),
        ("hermes", "official_api") => Some("NOUS_API_KEY"),
        ("kimi_code", "official_api") => Some("KIMI_API_KEY"),
        ("cline", "official_api") => Some("CLINE_API_KEY"),
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
        ("grok", "subscription" | "custom" | "model_provider") => GROK_SCRUB_ENV,
        ("cursor", "subscription") => built_in_auth_mode_policy(agent_id)
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
            let mode = env
                .get("GROK_PERMISSION_MODE")
                .map(|value| value.trim())
                .filter(|value| {
                    matches!(
                        *value,
                        "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan"
                    )
                });
            if let Some(mode) = mode {
                prefix.extend(["--permission-mode".to_string(), mode.to_string()]);
            }
            if grok_mode_skips_permission_prompts(mode) {
                if let Some(index) = args.iter().position(|argument| argument == "agent") {
                    args.insert(index + 1, "--always-approve".to_string());
                } else {
                    args.insert(0, "--always-approve".to_string());
                }
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
        _ => {}
    }
    apply_built_in_launch_argument_policy(agent_id, env, args);
}

/// Point `pi` at the same native files VibeX projected, and export the bound
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
        return vec![
            format!("{requested}.exe"),
            format!("{requested}.com"),
            format!("{requested}.cmd"),
            format!("{requested}.bat"),
            requested.to_string(),
        ];
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
    if agent_id.as_str() != "grok" {
        return AgentAutoApproveMode::Off;
    }
    let mode = env.get("GROK_PERMISSION_MODE").map(String::as_str);
    if grok_mode_skips_permission_prompts(mode.map(str::trim)) {
        AgentAutoApproveMode::Yolo
    } else {
        AgentAutoApproveMode::Off
    }
}

fn grok_mode_skips_permission_prompts(mode: Option<&str>) -> bool {
    matches!(mode, Some("bypassPermissions" | "dontAsk"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use api_types::{AgentAuthModeKind, AgentId};

    use super::{
        PI_COMMAND_ENV, apply_built_in_auth_mode_policy, apply_built_in_launch_argument_policy,
        apply_built_in_launch_policy, auth_mode_kind, auto_approve_mode_for_launch,
        bind_pi_acp_pi_command, built_in_auth_mode_policy, is_non_official_api_url,
        official_api_url, resolve_built_in_auth_mode, resolve_pi_acp_command,
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

        let temp = tempfile::tempdir().unwrap();
        let mut pi = HashMap::from([(
            "HOME".to_string(),
            temp.path().to_string_lossy().into_owned(),
        )]);
        apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut pi, &mut Vec::new());
        assert_eq!(pi["PI_ACP_ENABLE_EMBEDDED_CONTEXT"], "true");
    }

    #[test]
    fn pi_launch_exports_the_bound_provider_key_and_config_dir() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let agent_dir = home.join(".pi/agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            br#"{"defaultProvider":"private-gateway","defaultModel":"private-model"}"#,
        )
        .unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            br#"{"private-gateway":{"type":"api_key","key":"sk-pi"}}"#,
        )
        .unwrap();

        let mut env = HashMap::from([("HOME".to_string(), home.to_string_lossy().into_owned())]);
        apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut env, &mut Vec::new());

        assert_eq!(
            env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(agent_dir.to_string_lossy().as_ref())
        );
        assert_eq!(env.get("PI_API_KEY").map(String::as_str), Some("sk-pi"));
        assert_eq!(env["PI_ACP_ENABLE_EMBEDDED_CONTEXT"], "true");
    }

    #[test]
    fn pi_launch_keeps_an_explicit_config_dir_and_does_not_clobber_an_existing_key() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let custom_dir = home.join("custom-pi");
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::write(
            custom_dir.join("settings.json"),
            br#"{"defaultProvider":"gateway"}"#,
        )
        .unwrap();
        std::fs::write(
            custom_dir.join("auth.json"),
            br#"{"gateway":{"type":"api_key","key":"sk-from-dir"}}"#,
        )
        .unwrap();

        let mut env = HashMap::from([
            ("HOME".to_string(), home.to_string_lossy().into_owned()),
            (
                "PI_CODING_AGENT_DIR".to_string(),
                custom_dir.to_string_lossy().into_owned(),
            ),
            ("PI_API_KEY".to_string(), "sk-explicit".to_string()),
        ]);
        apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut env, &mut Vec::new());

        assert_eq!(
            env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(custom_dir.to_string_lossy().as_ref())
        );
        assert_eq!(
            env.get("PI_API_KEY").map(String::as_str),
            Some("sk-explicit")
        );

        env.remove("PI_API_KEY");
        apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut env, &mut Vec::new());
        assert_eq!(
            env.get("PI_API_KEY").map(String::as_str),
            Some("sk-from-dir")
        );
    }

    #[test]
    fn pi_spawn_prefers_a_sibling_exe_over_a_cmd_shim() {
        let temp = tempfile::tempdir().unwrap();
        let cmd = temp.path().join("pi.cmd");
        let exe = temp.path().join("pi.exe");
        std::fs::write(&cmd, b"@echo off\r\n").unwrap();
        std::fs::write(&exe, b"exe").unwrap();

        let mut env = HashMap::from([(
            PI_COMMAND_ENV.to_string(),
            cmd.to_string_lossy().into_owned(),
        )]);
        bind_pi_acp_pi_command(&mut env, Some(cmd.to_str().unwrap()));

        assert_eq!(
            std::path::Path::new(&env[PI_COMMAND_ENV])
                .file_name()
                .unwrap(),
            exe.file_name().unwrap()
        );
    }

    #[test]
    fn pi_spawn_keeps_an_absolute_cmd_when_no_exe_exists() {
        let temp = tempfile::tempdir().unwrap();
        let cmd = temp.path().join("pi.cmd");
        std::fs::write(&cmd, b"@echo off\r\n").unwrap();

        let mut env = HashMap::new();
        bind_pi_acp_pi_command(&mut env, Some(cmd.to_str().unwrap()));

        assert_eq!(
            std::path::Path::new(&env[PI_COMMAND_ENV])
                .file_name()
                .unwrap(),
            cmd.file_name().unwrap()
        );
    }

    #[test]
    fn pi_spawn_discovers_pi_from_path_when_unset() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let pi = bin.join("pi");
        std::fs::write(&pi, b"#!/bin/sh\n").unwrap();

        let mut env = HashMap::from([("PATH".to_string(), bin.to_string_lossy().into_owned())]);
        bind_pi_acp_pi_command(&mut env, None);

        assert_eq!(
            std::path::Path::new(&env[PI_COMMAND_ENV])
                .file_name()
                .unwrap(),
            pi.file_name().unwrap()
        );
    }

    #[test]
    fn pi_spawn_falls_back_to_path_when_the_custom_command_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let pi = bin.join("pi");
        std::fs::write(&pi, b"#!/bin/sh\n").unwrap();
        let missing = temp.path().join("missing.cmd");

        let mut env = HashMap::from([("PATH".to_string(), bin.to_string_lossy().into_owned())]);
        bind_pi_acp_pi_command(&mut env, Some(missing.to_str().unwrap()));

        assert_eq!(
            std::path::Path::new(&env[PI_COMMAND_ENV])
                .file_name()
                .unwrap(),
            pi.file_name().unwrap()
        );
    }

    #[test]
    fn pi_spawn_skips_a_published_shim_when_a_user_runtime_exists() {
        let temp = tempfile::tempdir().unwrap();
        let shim_dir = temp.path().join("shim");
        let user_dir = temp.path().join("user");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::create_dir_all(&user_dir).unwrap();
        let target = temp.path().join("managed-pi");
        std::fs::write(&target, b"managed").unwrap();
        let shim = shim_dir.join("pi");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\n# VibeX Agent CLI: pi\nexec '{}' \"$@\"\n",
                target.display()
            ),
        )
        .unwrap();
        let user = user_dir.join("pi");
        std::fs::write(&user, b"user").unwrap();

        let path = std::env::join_paths([&shim_dir, &user_dir]).unwrap();
        let resolved = resolve_pi_acp_command(None, Some(path.to_str().unwrap())).unwrap();
        assert_eq!(resolved.file_name().unwrap(), user.file_name().unwrap());
    }

    #[test]
    fn pi_spawn_follows_a_published_shim_when_it_is_the_only_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let shim_dir = temp.path().join("shim");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let target = temp.path().join("managed-pi");
        std::fs::write(&target, b"managed").unwrap();
        let shim = shim_dir.join("pi");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\n# VibeX Agent CLI: pi\nexec '{}' \"$@\"\n",
                target.display()
            ),
        )
        .unwrap();

        let resolved = resolve_pi_acp_command(None, Some(shim_dir.to_str().unwrap())).unwrap();
        assert_eq!(resolved.file_name().unwrap(), target.file_name().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn pi_spawn_prefers_exe_before_cmd_on_windows_path() {
        let temp = tempfile::tempdir().unwrap();
        let cmd = temp.path().join("pi.cmd");
        let exe = temp.path().join("pi.exe");
        std::fs::write(&cmd, b"@echo off\r\n").unwrap();
        std::fs::write(&exe, b"exe").unwrap();

        let resolved = resolve_pi_acp_command(None, Some(temp.path().to_str().unwrap())).unwrap();
        assert_eq!(resolved.file_name().unwrap(), exe.file_name().unwrap());
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
    fn product_kinds_separate_subscription_official_api_and_provider() {
        let claude = AgentId::parse("claude_code").unwrap();
        let grok = AgentId::parse("grok").unwrap();
        let cursor = AgentId::parse("cursor").unwrap();
        let opencode = AgentId::parse("opencode").unwrap();
        let dsh = AgentId::parse("deepseek_harness").unwrap();

        assert_eq!(
            auth_mode_kind(&claude, "official_subscription"),
            AgentAuthModeKind::Subscription
        );
        assert_eq!(
            auth_mode_kind(&claude, "official_api"),
            AgentAuthModeKind::OfficialApi
        );
        assert_eq!(
            auth_mode_kind(&claude, "custom"),
            AgentAuthModeKind::OfficialApi
        );
        assert_eq!(
            auth_mode_kind(&claude, "model_provider"),
            AgentAuthModeKind::Provider
        );
        assert_eq!(auth_mode_kind(&grok, "custom"), AgentAuthModeKind::Provider);
        assert_eq!(
            auth_mode_kind(&cursor, "custom"),
            AgentAuthModeKind::OfficialApi
        );
        assert_eq!(
            auth_mode_kind(&opencode, "official_subscription"),
            AgentAuthModeKind::Subscription
        );
        assert_eq!(
            auth_mode_kind(&dsh, "deepseek"),
            AgentAuthModeKind::OfficialApi
        );
        assert_eq!(
            official_api_url(&claude, "official_api"),
            Some("https://api.anthropic.com")
        );
        assert_eq!(official_api_url(&cursor, "custom"), None);

        let qoder = AgentId::parse("qoder").unwrap();
        assert_eq!(
            auth_mode_kind(&qoder, "official_subscription"),
            AgentAuthModeKind::Subscription
        );
        assert_eq!(official_api_url(&qoder, "official_subscription"), None);

        let mimo = AgentId::parse("mimo_code").unwrap();
        assert_eq!(
            built_in_auth_mode_policy(&mimo).unwrap().modes,
            ["official_subscription", "official_api", "model_provider"]
        );
        assert_eq!(
            auth_mode_kind(&mimo, "official_subscription"),
            AgentAuthModeKind::Subscription
        );
        assert_eq!(
            auth_mode_kind(&mimo, "official_api"),
            AgentAuthModeKind::OfficialApi
        );
        assert_eq!(
            auth_mode_kind(&mimo, "model_provider"),
            AgentAuthModeKind::Provider
        );
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

        let mut grok_bypass = vec!["agent".to_string(), "stdio".to_string()];
        apply_built_in_launch_argument_policy(
            &AgentId::parse("grok").unwrap(),
            &HashMap::from([(
                "GROK_PERMISSION_MODE".to_string(),
                "bypassPermissions".to_string(),
            )]),
            &mut grok_bypass,
        );
        assert_eq!(
            grok_bypass,
            [
                "--no-auto-update",
                "--permission-mode",
                "bypassPermissions",
                "agent",
                "--always-approve",
                "stdio"
            ]
        );
        assert_eq!(
            auto_approve_mode_for_launch(
                &AgentId::parse("grok").unwrap(),
                &HashMap::from([(
                    "GROK_PERMISSION_MODE".to_string(),
                    "bypassPermissions".to_string(),
                )])
            ),
            crate::permissions::AgentAutoApproveMode::Yolo
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

    #[test]
    fn bound_provider_wins_over_official_api_env_and_credentials() {
        let claude = AgentId::parse("claude_code").unwrap();
        let grok = AgentId::parse("grok").unwrap();
        let kimi = AgentId::parse("kimi_code").unwrap();
        let claude_policy = built_in_auth_mode_policy(&claude).unwrap();
        let grok_policy = built_in_auth_mode_policy(&grok).unwrap();
        let kimi_policy = built_in_auth_mode_policy(&kimi).unwrap();

        assert_eq!(
            resolve_built_in_auth_mode(
                &claude,
                claude_policy,
                &HashMap::from([("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string())]),
                true,
                false,
                None,
            ),
            "model_provider"
        );
        assert_eq!(
            resolve_built_in_auth_mode(&claude, claude_policy, &HashMap::new(), false, true, None,),
            "model_provider"
        );
        assert_eq!(
            resolve_built_in_auth_mode(&grok, grok_policy, &HashMap::new(), false, false, None),
            "subscription"
        );
        assert_eq!(
            resolve_built_in_auth_mode(&grok, grok_policy, &HashMap::new(), true, false, None),
            "model_provider"
        );
        assert_eq!(
            resolve_built_in_auth_mode(
                &kimi,
                kimi_policy,
                &HashMap::from([("KIMI_API_KEY".to_string(), "sk-kimi".to_string())]),
                false,
                false,
                None,
            ),
            "official_api"
        );
        assert_eq!(
            resolve_built_in_auth_mode(
                &kimi,
                kimi_policy,
                &HashMap::from([("KIMI_API_KEY".to_string(), "sk-kimi".to_string())]),
                true,
                false,
                None,
            ),
            "model_provider"
        );
        assert!(is_non_official_api_url(&claude, "https://api.deepseek.com"));
        assert!(!is_non_official_api_url(
            &claude,
            "https://api.anthropic.com/v1"
        ));
    }
}
