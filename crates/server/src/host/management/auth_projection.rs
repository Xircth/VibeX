use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::{
    AgentId, NativeConfigProvider, NativeConfigSnapshot, TokioNativeFileSystem,
    auth_mode_credential_env, auth_mode_kind, built_in_auth_mode_policy, headless_account_env,
    native_uses_custom_endpoint, official_api_url, project_codex_auth_mode, resolve_account_label,
    resolve_built_in_auth_mode,
};
use api_types::{
    AgentAuthModeOptionView, AgentAuthModeView, AgentAuthenticationStatus, AgentPreflightItemView,
};
use application::ApplicationError;
use serde_json::{Value, json};

use crate::{
    domains::internal_error,
    host::native::{
        dsh_configuration, model_providers, opencode_document_paths, opencode_providers,
        provider_store_path,
    },
};

/// Restores the Agent's own configuration from the projection backup taken when
/// the Provider was bound, then drops the binding.
pub(super) async fn release_provider_projection(
    home: &Path,
    store_path: &Path,
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> Result<(), ApplicationError> {
    let native_home = model_providers::provider_native_home(home, env, agent_id);
    let providers =
        match model_providers::list_with_native(store_path, agent_id.clone(), Some(&native_home))
            .await
        {
            Ok(view) => view,
            Err(error) if error.contains("不支持可复用 Model Provider") => return Ok(()),
            Err(error) => return Err(ApplicationError::internal(error.to_string())),
        };
    if providers.bound_provider_id.is_none() {
        return Ok(());
    }
    model_providers::bind(store_path, home, env, agent_id.clone(), None)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    Ok(())
}

pub(super) async fn project_auth_mode_view_at(
    home: &Path,
    store_path: &Path,
    agent_id: AgentId,
    env: &HashMap<String, String>,
) -> Result<AgentAuthModeView, ApplicationError> {
    let native_home = model_providers::provider_native_home(home, env, &agent_id);
    let providers =
        match model_providers::list_with_native(store_path, agent_id.clone(), Some(&native_home))
            .await
        {
            Ok(view) => view,
            Err(error) if error.contains("不支持可复用 Model Provider") => {
                api_types::AgentModelProvidersView {
                    agent_id: agent_id.clone(),
                    providers: Vec::new(),
                    bound_provider_id: None,
                }
            }
            Err(error) => return Err(ApplicationError::internal(error.to_string())),
        };
    let bound = providers.bound_provider_id.is_some();
    if agent_id.as_str() == "codex" {
        return read_codex_auth_mode(home, env, bound, &providers).await;
    }
    if agent_id.as_str() == "deepseek_harness" {
        return read_dsh_auth_mode(home, env).await;
    }
    if agent_id.as_str() == "opencode" {
        return read_opencode_auth_mode(home, env, bound, &providers).await;
    }
    let policy = built_in_auth_mode_policy(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("此 Agent 没有独立鉴权模式"))?;
    let snapshot = read_native_auth_snapshot(home, env, &agent_id).await;
    let native_custom = snapshot
        .as_ref()
        .is_some_and(|snapshot| native_uses_custom_endpoint(&agent_id, snapshot));
    let mode = resolve_built_in_auth_mode(
        &agent_id,
        policy,
        env,
        bound,
        native_custom,
        snapshot.as_ref(),
    );
    let credential_env =
        auth_mode_credential_env(&agent_id, &mode).unwrap_or(policy.credential_env);
    let credential_present = credential_present_for_mode(
        &agent_id,
        &mode,
        env,
        credential_env,
        &providers,
        snapshot.as_ref(),
    );
    let headless_account_env = headless_account_env(&agent_id).map(str::to_string);
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, policy.modes),
        agent_id,
        mode,
        modes: policy
            .modes
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: credential_env.to_string(),
        credential_present,
        account_label: None,
        headless_account_env,
    })
}

fn credential_present_for_mode(
    agent_id: &AgentId,
    mode: &str,
    env: &HashMap<String, String>,
    credential_env: &str,
    providers: &api_types::AgentModelProvidersView,
    snapshot: Option<&NativeConfigSnapshot>,
) -> bool {
    match (agent_id.as_str(), mode) {
        (_, "model_provider") => model_provider_credential_present(providers, snapshot),
        ("claude_code", "official_api" | "custom") => {
            snapshot.is_some_and(|snapshot| snapshot.field_present("anthropic_api_key"))
        }
        ("grok", "api_key" | "custom") => {
            snapshot.is_some_and(|snapshot| snapshot.field_present("grok_api_key"))
        }
        ("antigravity" | "gemini", "gemini-api-key") => {
            snapshot.is_some_and(|snapshot| snapshot.field_present("antigravity_api_key"))
        }
        ("antigravity" | "gemini", "agent-platform") => snapshot.is_some_and(|snapshot| {
            snapshot.field_present("antigravity_google_api_key")
                || (snapshot.field_text("antigravity_cloud_project").is_some()
                    && snapshot.field_text("antigravity_cloud_location").is_some())
        }),
        (_, "official_subscription" | "subscription") => {
            headless_account_env(agent_id)
                .and_then(|key| env.get(key))
                .is_some_and(|value| !value.trim().is_empty())
                || env
                    .get(credential_env)
                    .is_some_and(|value| !value.trim().is_empty())
                || native_secret_present(snapshot)
        }
        _ => {
            env.get(credential_env)
                .is_some_and(|value| !value.trim().is_empty())
                || native_secret_present(snapshot)
        }
    }
}

fn model_provider_credential_present(
    providers: &api_types::AgentModelProvidersView,
    snapshot: Option<&NativeConfigSnapshot>,
) -> bool {
    providers
        .providers
        .iter()
        .any(|provider| provider.credential_present)
        || native_secret_present(snapshot)
}

fn native_secret_present(snapshot: Option<&NativeConfigSnapshot>) -> bool {
    snapshot.is_some_and(|snapshot| {
        matches!(
            snapshot.authentication,
            AgentAuthenticationStatus::ApiKey | AgentAuthenticationStatus::Account
        ) || snapshot
            .fields
            .iter()
            .any(|field| field.secret && field.present)
    })
}

async fn read_native_auth_snapshot(
    home: &Path,
    env: &HashMap<String, String>,
    agent_id: &AgentId,
) -> Option<NativeConfigSnapshot> {
    NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home.to_path_buf(),
        env.clone().into_iter().collect(),
    )
    .read(agent_id, false)
    .await
    .ok()
}

async fn read_codex_auth_mode(
    home: &Path,
    env: &HashMap<String, String>,
    bound: bool,
    providers: &api_types::AgentModelProvidersView,
) -> Result<AgentAuthModeView, ApplicationError> {
    let agent_id = AgentId::parse("codex").map_err(internal_error)?;
    let codex_home = resolve_agent_home(home, env, "CODEX_HOME", ".codex");
    let auth = read_json_object_or_empty(&codex_home.join("auth.json")).await?;
    let projection = project_codex_auth_mode(&auth, bound);
    let mut credential_present = projection.credential_present;
    credential_present = credential_present
        || providers
            .providers
            .iter()
            .any(|provider| provider.credential_present);
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, agents::CODEX_AUTH_MODES),
        agent_id,
        mode: projection.mode.to_string(),
        modes: agents::CODEX_AUTH_MODES
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: "OPENAI_API_KEY".to_string(),
        credential_present,
        account_label: None,
        headless_account_env: None,
    })
}

async fn read_dsh_auth_mode(
    home: &Path,
    env: &HashMap<String, String>,
) -> Result<AgentAuthModeView, ApplicationError> {
    let agent_id = AgentId::parse("deepseek_harness").map_err(internal_error)?;
    let policy = built_in_auth_mode_policy(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("此 Agent 没有独立鉴权模式"))?;
    let paths = dsh_configuration::resolve_paths(home, env);
    let snapshot = read_native_auth_snapshot(home, env, &agent_id).await;
    let mode =
        dsh_configuration::inferred_auth_mode(&paths, env.get(policy.mode_env).map(String::as_str))
            .to_string();
    let credential_present = dsh_configuration::any_credential_present(&paths)
        || env
            .get(policy.credential_env)
            .is_some_and(|value| !value.trim().is_empty())
        || native_secret_present(snapshot.as_ref());
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, policy.modes),
        agent_id,
        mode,
        modes: policy
            .modes
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: policy.credential_env.to_string(),
        credential_present,
        account_label: None,
        headless_account_env: None,
    })
}

async fn read_opencode_auth_mode(
    home: &Path,
    env: &HashMap<String, String>,
    bound: bool,
    providers: &api_types::AgentModelProvidersView,
) -> Result<AgentAuthModeView, ApplicationError> {
    let agent_id = AgentId::parse("opencode").map_err(internal_error)?;
    let policy = built_in_auth_mode_policy(&agent_id)
        .ok_or_else(|| ApplicationError::bad_request("此 Agent 没有独立鉴权模式"))?;
    let (auth_path, config_path) = opencode_document_paths(home, env);
    let auth = read_json_object_or_empty(&auth_path)
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let config = read_json_object_or_empty(&config_path)
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let provider_ready = opencode_providers::opencode_enabled_api_provider_ready(&auth, &config);
    let snapshot = read_native_auth_snapshot(home, env, &agent_id).await;
    let mode = resolve_built_in_auth_mode(
        &agent_id,
        policy,
        env,
        bound || provider_ready,
        false,
        snapshot.as_ref(),
    );
    let credential_present = provider_ready
        || model_provider_credential_present(providers, snapshot.as_ref())
        || native_secret_present(snapshot.as_ref());
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, policy.modes),
        agent_id,
        mode,
        modes: policy
            .modes
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: policy.credential_env.to_string(),
        credential_present,
        account_label: None,
        headless_account_env: None,
    })
}

pub(super) async fn with_account_label(
    view: AgentAuthModeView,
) -> Result<AgentAuthModeView, ApplicationError> {
    Ok(AgentAuthModeView {
        account_label: resolve_account_label(&view.agent_id).await,
        ..view
    })
}

pub(super) fn project_auth_mode_options(
    agent_id: &AgentId,
    modes: &[&str],
) -> Vec<AgentAuthModeOptionView> {
    modes
        .iter()
        .filter(|mode| !(**mode == "custom" && matches!(agent_id.as_str(), "claude_code" | "grok")))
        .map(|mode| {
            let (label_key, description_key) = auth_mode_translation_keys(agent_id, mode);
            let credential_env = auth_mode_credential_env(agent_id, mode)
                .map(str::to_string)
                .or_else(|| {
                    (agent_id.as_str() == "codex" && *mode == "api_key")
                        .then(|| "OPENAI_API_KEY".to_string())
                });
            AgentAuthModeOptionView {
                value: (*mode).to_string(),
                kind: auth_mode_kind(agent_id, mode),
                label_key: label_key.to_string(),
                description_key: description_key.to_string(),
                credential_required: credential_env.is_some(),
                credential_env,
                native_config_field_id: native_auth_config_field_id(agent_id, mode)
                    .map(str::to_string),
                official_api_url: official_api_url(agent_id, mode).map(str::to_string),
            }
        })
        .collect()
}

fn native_auth_config_field_id(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_api" | "custom") => Some("anthropic_api_key"),
        ("codex", "api_key") => Some("openai_api_key"),
        ("grok", "api_key") => Some("grok_api_key"),
        ("antigravity" | "gemini", "gemini-api-key") => Some("antigravity_api_key"),
        ("antigravity" | "gemini", "agent-platform") => Some("antigravity_google_api_key"),
        ("deepseek_harness", "deepseek" | "custom") => Some("deepseek_harness_api_key"),
        ("mimo_code", "official_api") => Some("mimo_api_key"),
        _ => None,
    }
}

fn auth_mode_translation_keys(agent_id: &AgentId, mode: &str) -> (&'static str, &'static str) {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescClaudeSubscription",
        ),
        ("claude_code", "official_api" | "custom") => (
            "agents.authModeOfficialApi",
            "agents.authDescClaudeOfficialApi",
        ),
        ("claude_code", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescClaudeProvider")
        }
        ("antigravity" | "gemini", "oauth-personal") => (
            "agents.authModeGoogleLogin",
            "agents.authDescAntigravityOauthPersonal",
        ),
        ("antigravity" | "gemini", "oauth-business") => (
            "agents.authModeAntigravityEnterprise",
            "agents.authDescAntigravityOauthBusiness",
        ),
        ("antigravity" | "gemini", "gemini-api-key") => (
            "agents.authModeGeminiKey",
            "agents.authDescAntigravityApiKey",
        ),
        ("antigravity" | "gemini", "agent-platform") => (
            "agents.authModeAntigravityPlatform",
            "agents.authDescAntigravityPlatform",
        ),
        ("antigravity" | "gemini", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGeminiProvider")
        }
        ("codex", "chatgpt_subscription") => {
            ("agents.authModeChatGpt", "agents.authDescCodexSubscription")
        }
        ("codex", "api_key") => (
            "agents.authModeOfficialApi",
            "agents.authDescCodexOfficialApi",
        ),
        ("codex", "model_provider") => ("agents.authModeProvider", "agents.authDescCodexProvider"),
        ("grok", "subscription") => (
            "agents.authModeSubscription",
            "agents.authDescGrokSubscription",
        ),
        ("grok", "api_key") => (
            "agents.authModeOfficialApi",
            "agents.authDescGrokOfficialApi",
        ),
        ("grok", "custom" | "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGrokProvider")
        }
        ("cursor", "subscription") => (
            "agents.authModeSubscription",
            "agents.authDescCursorSubscription",
        ),
        ("cursor", "custom") => (
            "agents.authModeOfficialApi",
            "agents.authDescCursorOfficialApi",
        ),
        ("deepseek_harness", "deepseek") => {
            ("agents.authModeOfficialApi", "agents.authDescDeepseekApi")
        }
        ("deepseek_harness", "custom") => {
            ("agents.authModeProvider", "agents.authDescDeepseekCustom")
        }
        ("opencode", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescOpencodeGo",
        ),
        ("opencode", "official_api") => {
            ("agents.authModeOfficialApi", "agents.authDescOpencodeZen")
        }
        ("opencode", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescOpencodeProvider")
        }
        ("hermes", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescHermesSubscription",
        ),
        ("hermes", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescHermesOfficialApi",
        ),
        ("hermes", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescHermesProvider")
        }
        ("kimi_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescKimiSubscription",
        ),
        ("kimi_code", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescKimiOfficialApi",
        ),
        ("kimi_code", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescKimiProvider")
        }
        ("cline", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescClineSubscription",
        ),
        ("cline", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescClineOfficialApi",
        ),
        ("cline", "model_provider") => ("agents.authModeProvider", "agents.authDescClineProvider"),
        ("codebuddy", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescCodebuddySubscription",
        ),
        ("codebuddy", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescCodebuddyOfficialApi",
        ),
        ("codebuddy", "model_provider") => (
            "agents.authModeProvider",
            "agents.authDescCodebuddyProvider",
        ),
        ("qoder", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescQoderSubscription",
        ),
        ("qoder", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescQoderOfficialApi",
        ),
        ("qoder", "model_provider") => ("agents.authModeProvider", "agents.authDescQoderProvider"),
        ("kiro", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescKiroSubscription",
        ),
        ("kiro", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescKiroOfficialApi",
        ),
        ("auggie", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescAuggieSubscription",
        ),
        ("auggie", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescAuggieOfficialApi",
        ),
        ("auggie", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescAuggieProvider")
        }
        ("trae", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescTraeSubscription",
        ),
        ("trae", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescTraeOfficialApi",
        ),
        ("trae", "model_provider") => ("agents.authModeProvider", "agents.authDescTraeProvider"),
        ("command_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescCommandCodeSubscription",
        ),
        ("command_code", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescCommandCodeOfficialApi",
        ),
        ("command_code", "model_provider") => (
            "agents.authModeProvider",
            "agents.authDescCommandCodeProvider",
        ),
        ("zcode", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescZcodeSubscription",
        ),
        ("zcode", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescZcodeOfficialApi",
        ),
        ("zcode", "model_provider") => ("agents.authModeProvider", "agents.authDescZcodeProvider"),
        ("mimo_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescMimoSubscription",
        ),
        ("mimo_code", "official_api") => (
            "agents.authModeOfficialApi",
            "agents.authDescMimoOfficialApi",
        ),
        ("mimo_code", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescMimoProvider")
        }
        ("pi" | "openclaw", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGenericProvider")
        }
        ("omp", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescOmpSubscription",
        ),
        ("omp", "model_provider") => ("agents.authModeProvider", "agents.authDescOmpProvider"),
        _ => ("agents.authModeUnknown", "agents.authDescUnknown"),
    }
}

pub(super) fn preflight_auth_item(
    ready: bool,
    detail: String,
    version: &str,
) -> AgentPreflightItemView {
    AgentPreflightItemView {
        id: "authentication".to_string(),
        label: "鉴权".to_string(),
        status: if ready { "pass" } else { "fail" }.to_string(),
        detail,
        version: Some(version.to_string()),
        path: None,
        source: None,
        repairable: true,
        update_available: false,
        available_version: None,
        update_group: None,
    }
}

pub(super) async fn bound_provider_has_credentials(
    agent_id: &AgentId,
    env: &HashMap<String, String>,
) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    if agent_id.as_str() == "opencode" && opencode_native_api_provider_ready(&home, env).await {
        return true;
    }
    let native_home = model_providers::provider_native_home(&home, env, agent_id);
    let Ok(view) = model_providers::list_with_native(
        &provider_store_path(),
        agent_id.clone(),
        Some(&native_home),
    )
    .await
    else {
        return false;
    };
    view.providers
        .iter()
        .find(|provider| Some(&provider.id) == view.bound_provider_id.as_ref())
        .is_some_and(|provider| provider.credential_present)
}

async fn opencode_native_api_provider_ready(home: &Path, env: &HashMap<String, String>) -> bool {
    let (auth_path, config_path) = opencode_document_paths(home, env);
    let auth = read_json_object_or_empty(&auth_path)
        .await
        .unwrap_or_else(|_| json!({}));
    let config = read_json_object_or_empty(&config_path)
        .await
        .unwrap_or_else(|_| json!({}));
    opencode_providers::opencode_enabled_api_provider_ready(&auth, &config)
}

pub(super) fn resolve_agent_home(
    home: &Path,
    env: &HashMap<String, String>,
    override_env: &str,
    relative: &str,
) -> PathBuf {
    crate::host::native::resolve_agent_home(home, env, override_env, relative)
}

pub(super) async fn read_json_object_or_empty(path: &Path) -> Result<Value, ApplicationError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(internal_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(internal_error(error)),
    }
}

#[cfg(test)]
mod tests {
    use api_types::AgentAuthModeKind;
    use super::*;

    #[test]
    fn auth_mode_options_cover_policy_modes() {
        let agent_id = AgentId::parse("claude_code").unwrap();
        let policy = built_in_auth_mode_policy(&agent_id).unwrap();
        let options = project_auth_mode_options(&agent_id, policy.modes);
        assert!(
            options
                .iter()
                .any(|option| option.value == "official_subscription")
        );
        assert!(
            options
                .iter()
                .any(|option| option.value == "model_provider")
        );
        assert!(!options.iter().any(|option| option.value == "custom"));
    }

    #[test]
    fn qoder_auth_options_cover_subscription_api_and_provider() {
        let agent_id = AgentId::parse("qoder").unwrap();
        let policy = built_in_auth_mode_policy(&agent_id).unwrap();
        let options = project_auth_mode_options(&agent_id, policy.modes);
        assert_eq!(options.len(), 3);
        assert_eq!(options[0].value, "official_subscription");
        assert_eq!(options[0].kind, AgentAuthModeKind::Subscription);
        assert!(!options[0].credential_required);
        assert_eq!(options[1].value, "official_api");
        assert_eq!(options[1].kind, AgentAuthModeKind::OfficialApi);
        assert!(options[1].credential_required);
        assert_eq!(options[2].value, "model_provider");
        assert_eq!(options[2].kind, AgentAuthModeKind::Provider);
    }

    #[test]
    fn omp_auth_options_name_subscription_and_provider() {
        let agent_id = AgentId::parse("omp").unwrap();
        let policy = built_in_auth_mode_policy(&agent_id).unwrap();
        let options = project_auth_mode_options(&agent_id, policy.modes);
        assert_eq!(
            options
                .iter()
                .map(|option| option.description_key.as_str())
                .collect::<Vec<_>>(),
            [
                "agents.authDescOmpSubscription",
                "agents.authDescOmpProvider",
            ]
        );
    }

    #[tokio::test]
    async fn native_codex_provider_selects_the_provider_auth_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"sk-native"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("codex").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
        assert_eq!(
            view.options
                .iter()
                .find(|option| option.value == "model_provider")
                .map(|option| option.kind),
            Some(AgentAuthModeKind::Provider)
        );
    }

    #[tokio::test]
    async fn claude_custom_endpoint_selects_the_provider_auth_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let claude_home = home.join(".claude");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-gateway","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
    }

    #[tokio::test]
    async fn claude_custom_endpoint_outranks_a_stale_dimo_mode() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let claude_home = home.join(".claude");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-gateway","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            &HashMap::from([("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string())]),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
    }

    #[tokio::test]
    async fn leaving_provider_routing_restores_the_agents_own_config() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let grok_home = home.join(".grok");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&grok_home).await.unwrap();
        let native_config = "[models]\ndefault = \"grok-4.6\"\n";
        tokio::fs::write(grok_home.join("config.toml"), native_config)
            .await
            .unwrap();

        let agent_id = AgentId::parse("grok").unwrap();
        let environment = HashMap::new();
        let saved = model_providers::save(
            &store_path,
            &home,
            &environment,
            api_types::AgentModelProviderSaveRequest {
                id: None,
                name: "Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("gateway-secret".to_string()),
                model: "grok-4.6".to_string(),
            },
        )
        .await
        .unwrap();
        model_providers::bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some(saved.providers[0].id.clone()),
        )
        .await
        .unwrap();
        let projected = tokio::fs::read_to_string(grok_home.join("config.toml"))
            .await
            .unwrap();
        assert!(projected.contains("[model.dimo]"));

        release_provider_projection(&home, &store_path, &agent_id, &environment)
            .await
            .unwrap();

        let restored = tokio::fs::read_to_string(grok_home.join("config.toml"))
            .await
            .unwrap();
        let restored: toml::Value = toml::from_str(&restored).unwrap();
        assert_eq!(restored["models"]["default"].as_str(), Some("grok-4.6"));
        assert!(
            restored
                .get("model")
                .and_then(|model| model.get("dimo"))
                .is_none()
        );
        let providers = model_providers::list_with_native(&store_path, agent_id, Some(&grok_home))
            .await
            .unwrap();
        assert!(providers.bound_provider_id.is_none());
        assert_eq!(providers.providers.len(), 1);
    }

    #[tokio::test]
    async fn saved_provider_credentials_ready_the_provider_tab_without_binding() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let claude_home = home.join(".claude");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::create_dir_all(store_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com"}}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            &store_path,
            br#"{
              "providers": [{
                "id": "user-relay",
                "name": "Relay",
                "agent_id": "claude_code",
                "api_url": "https://api.relay.example/v1",
                "api_key": "sk-user",
                "model": "deepseek-chat"
              }],
              "bindings": {}
            }"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(
            view.credential_present,
            "saved Model Provider credentials must satisfy preflight without a separate bind"
        );
    }

    #[tokio::test]
    async fn official_claude_api_key_stays_on_the_official_api_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let claude_home = home.join(".claude");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"sk-ant"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "official_api");
    }

    #[tokio::test]
    async fn pi_custom_native_key_readies_the_default_provider_mode() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let pi_home = home.join(".pi/agent");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&pi_home).await.unwrap();
        tokio::fs::write(
            pi_home.join("auth.json"),
            br#"{"cc-switch-open-code-go":{"type":"api_key","key":"sk-go"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("pi").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
    }

    #[tokio::test]
    async fn opencode_connected_provider_selects_the_provider_auth_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let auth_dir = home.join(".local/share/opencode");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&auth_dir).await.unwrap();
        tokio::fs::write(
            auth_dir.join("auth.json"),
            br#"{"deepseek":{"type":"api","key":"sk-ds"}}"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("opencode").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
    }

    #[tokio::test]
    async fn opencode_inline_api_key_selects_the_provider_auth_tab() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let auth_dir = home.join(".local/share/opencode");
        let config_dir = home.join(".config/opencode");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&auth_dir).await.unwrap();
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(auth_dir.join("auth.json"), b"{}")
            .await
            .unwrap();
        tokio::fs::write(
            config_dir.join("opencode.json"),
            br#"{
              "provider": {
                "opencodego": {
                  "name": "OpenCode Go",
                  "options": {
                    "baseURL": "https://opencode.ai/zen/go/v1",
                    "apiKey": "sk-go"
                  }
                }
              }
            }"#,
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("opencode").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "model_provider");
        assert!(view.credential_present);
    }

    #[tokio::test]
    async fn dsh_custom_yaml_credential_readies_provider_mode() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let dsh_home = home.join(".dsh");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&dsh_home).await.unwrap();
        tokio::fs::write(
            dsh_home.join(".credentials.yaml"),
            "MY_GATEWAY_API_KEY: sk-test\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            dsh_home.join("settings.yaml"),
            "llm-pi-ai:\n  providers:\n    my-gateway:\n      api: openai-completions\n      baseURL: https://gateway.example/v1\n      apiKeyEnv: MY_GATEWAY_API_KEY\n",
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("deepseek_harness").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(view.mode, "custom");
        assert!(view.credential_present);
    }

    #[tokio::test]
    async fn kimi_native_api_key_readies_official_api_without_env() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let kimi_home = home.join(".kimi-code");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&kimi_home).await.unwrap();
        tokio::fs::write(
            kimi_home.join("config.toml"),
            "[providers.dimo]\ntype = \"openai\"\nbase_url = \"https://api.moonshot.ai/v1\"\napi_key = \"sk-kimi\"\n",
        )
        .await
        .unwrap();

        let view = project_auth_mode_view_at(
            &home,
            &store_path,
            AgentId::parse("kimi_code").unwrap(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert!(view.credential_present);
        assert!(
            view.mode == "official_api" || view.mode == "official_subscription",
            "unexpected kimi mode {}",
            view.mode
        );
    }
}
