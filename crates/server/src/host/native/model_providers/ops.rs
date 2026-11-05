use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use api_types::{
    AgentId, AgentModelProviderImportPreviewView, AgentModelProviderImportSource,
    AgentModelProviderSaveRequest, AgentModelProvidersView,
};

use super::{
    ProviderNativeHomes, claude::*, codex::*, common::*, gemini::*, grok::*, kimi::*, list,
    list_with_native, load_store_with_natives, native_import_drafts, pi::*, save,
};
use crate::host::native::{
    model_provider_import::{cc_switch_app_type, drafts_to_preview, preview_cc_switch},
    read_json_object_or_empty,
};

pub async fn resolve_probe_api_key_from(
    store_path: &Path,
    agent_id: &AgentId,
    provider_id: Option<&str>,
    submitted_api_key: Option<&str>,
    home: Option<&Path>,
    environment: Option<&HashMap<String, String>>,
) -> Result<String, crate::host::native::NativeError> {
    if let Some(api_key) = submitted_api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(api_key.to_string());
    }
    let provider_id = provider_id.map(str::trim).filter(|value| !value.is_empty());
    let store = if validate_agent(agent_id).is_ok() {
        if let (Some(home), Some(environment)) = (home, environment) {
            let homes = ProviderNativeHomes::resolve(home, environment);
            load_store_with_natives(store_path, agent_id, &homes).await?
        } else {
            read_store(store_path).await?
        }
    } else {
        ProviderStore::default()
    };

    if let Some(provider_id) = provider_id {
        let matched = store
            .providers
            .iter()
            .find(|provider| provider.id == provider_id && &provider.agent_id == agent_id);
        if let Some(api_key) = matched
            .map(|provider| provider.api_key.as_str())
            .filter(|value| !value.is_empty())
        {
            return Ok(api_key.to_string());
        }
        if let (Some(home), Some(environment)) = (home, environment) {
            let url = matched
                .map(|provider| provider.api_url.as_str())
                .unwrap_or("");
            if let Some(api_key) =
                native_api_key(home, environment, agent_id, provider_id, url).await?
            {
                return Ok(api_key);
            }
        }
    } else if let Some(bound_id) = store.bindings.get(agent_id.as_str()) {
        if let Some(api_key) = store
            .providers
            .iter()
            .find(|provider| &provider.id == bound_id && &provider.agent_id == agent_id)
            .map(|provider| provider.api_key.as_str())
            .filter(|value| !value.is_empty())
        {
            return Ok(api_key.to_string());
        }
    }

    if let Some(environment) = environment
        && let Some(api_key) = resolve_environment_api_key(agent_id, environment)
    {
        return Ok(api_key);
    }

    if let Some(home) = home {
        let empty_env = HashMap::new();
        let env = environment.unwrap_or(&empty_env);
        if let Some(api_key) =
            resolve_native_fallback_api_key(home, env, agent_id, provider_id).await
        {
            return Ok(api_key);
        }
    }

    if provider_id.is_none() {
        return Err("读取 Provider 模型需要填写 API Key".into());
    }
    Err("找不到可用于模型探测的 Provider 凭据".into())
}

fn resolve_environment_api_key(
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<String> {
    let mut keys: Vec<&str> = Vec::new();
    if let Some(policy) = agents::built_in_auth_mode_policy(agent_id) {
        keys.push(policy.credential_env);
    }
    match agent_id.as_str() {
        "claude_code" => keys.extend([
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
        ]),
        "codex" => keys.push("OPENAI_API_KEY"),
        "grok" => keys.push("XAI_API_KEY"),
        "kimi_code" => keys.extend(["KIMI_API_KEY", "MOONSHOT_API_KEY"]),
        "deepseek_harness" => keys.push("DEEPSEEK_API_KEY"),
        "hermes" => keys.extend(["NOUS_API_KEY", "OPENAI_API_KEY"]),
        "cline" => keys.extend(["CLINE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]),
        "codebuddy" => keys.push("CODEBUDDY_API_KEY"),
        "qoder" => keys.extend(["QODER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
        "auggie" => keys.extend(["AUGMENT_API_TOKEN", "OPENAI_API_KEY"]),
        "trae" => keys.push("TRAE_API_KEY"),
        "command_code" => keys.push("COMMAND_CODE_API_KEY"),
        "zcode" => keys.extend(["ZHIPU_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
        "cursor" => keys.push("CURSOR_API_KEY"),
        "kiro" => keys.push("KIRO_API_KEY"),
        "mimo_code" => keys.extend(["MIMO_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
        id if api_types::AgentKind::Antigravity.matches_id(id) || id == "gemini" => {
            keys.extend(["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"]);
        }
        _ => {}
    }
    keys.into_iter().find_map(|key| {
        environment
            .get(key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

async fn resolve_native_fallback_api_key(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
    provider_id: Option<&str>,
) -> Option<String> {
    if agent_id.as_str() == "deepseek_harness" {
        let paths = crate::host::native::dsh_configuration::resolve_paths(home, environment);
        return crate::host::native::dsh_configuration::resolve_stored_api_key(
            &paths,
            provider_id,
            environment,
        );
    }
    let homes = ProviderNativeHomes::resolve(home, environment);
    match agent_id.as_str() {
        "claude_code" => native_claude_draft(&homes.claude)
            .await
            .ok()
            .flatten()
            .map(|draft| draft.api_key)
            .filter(|value| !value.is_empty()),
        "codex" => {
            let state = read_native_codex_state(&homes.codex).await.ok()?;
            if let Some(id) = provider_id.or(state.active_provider.as_deref())
                && let Some(provider) = state.providers.iter().find(|item| item.id == id)
                && !provider.api_key.is_empty()
            {
                return Some(provider.api_key.clone());
            }
            if !state.auth_api_key.is_empty() {
                return Some(state.auth_api_key);
            }
            state
                .providers
                .into_iter()
                .find_map(|item| (!item.api_key.is_empty()).then_some(item.api_key))
        }
        "grok" => {
            let settings = read_json_object_or_empty(&homes.grok.join("user-settings.json"))
                .await
                .unwrap_or_default();
            let user_key = json_text(&settings, &["apiKey"]);
            if !user_key.is_empty() {
                return Some(user_key);
            }
            let state = read_native_grok_state(&homes.grok).await.ok()?;
            if let Some(id) = provider_id.or(state.active_provider.as_deref())
                && let Some(provider) = state.providers.iter().find(|item| item.id == id)
                && !provider.api_key.is_empty()
            {
                return Some(provider.api_key.clone());
            }
            state
                .providers
                .into_iter()
                .find_map(|item| (!item.api_key.is_empty()).then_some(item.api_key))
        }
        "kimi_code" => {
            for candidate_home in [homes.kimi.clone(), home.join(".kimi")] {
                if let Ok(Some(draft)) = native_kimi_draft(&candidate_home).await
                    && !draft.api_key.is_empty()
                {
                    return Some(draft.api_key);
                }
                if let Ok(drafts) = super::kimi::native_kimi_provider_drafts(&candidate_home).await
                    && let Some(key) = drafts
                        .into_iter()
                        .find_map(|draft| (!draft.api_key.is_empty()).then_some(draft.api_key))
                {
                    return Some(key);
                }
            }
            None
        }
        "pi" => {
            let state = read_native_pi_state(&homes.pi).await.ok()?;
            if let Some(id) = provider_id.or(state.active_provider.as_deref())
                && let Some(provider) = state.providers.iter().find(|item| item.id == id)
                && !provider.api_key.is_empty()
            {
                return Some(provider.api_key.clone());
            }
            state
                .providers
                .into_iter()
                .find_map(|item| (!item.api_key.is_empty()).then_some(item.api_key))
        }
        "hermes" => super::hermes::native_hermes_draft(&homes.hermes)
            .await
            .ok()?
            .into_iter()
            .find_map(|draft| (!draft.api_key.is_empty()).then_some(draft.api_key)),
        "cline" => {
            let secrets = read_json_object_or_empty(&homes.cline.join("secrets.json"))
                .await
                .unwrap_or_default();
            let key = json_text(
                &secrets,
                &["openAiApiKey", "apiKey", "openRouterApiKey", "geminiApiKey"],
            );
            (!key.is_empty()).then_some(key)
        }
        "openclaw" => super::openclaw::native_openclaw_drafts(&homes.openclaw)
            .await
            .ok()?
            .into_iter()
            .find_map(|draft| (!draft.api_key.is_empty()).then_some(draft.api_key)),
        "codebuddy" => {
            let text = tokio::fs::read_to_string(homes.codebuddy.join(".env"))
                .await
                .ok()?;
            text.lines().find_map(|line| {
                let value = line.trim().strip_prefix("CODEBUDDY_API_KEY=")?;
                let trimmed = value.trim().trim_matches('"').trim_matches('\'');
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            })
        }
        "qoder" => {
            let doc = read_json_object_or_empty(&homes.qoder.join("settings.json"))
                .await
                .unwrap_or_default();
            let env = doc.get("env").unwrap_or(&doc);
            let key = json_text(env, &["QODER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
            (!key.is_empty()).then_some(key)
        }
        "auggie" => {
            let doc = read_json_object_or_empty(&homes.auggie.join("settings.json"))
                .await
                .unwrap_or_default();
            let env = doc.get("env").unwrap_or(&doc);
            let key = json_text(env, &["AUGMENT_API_TOKEN", "OPENAI_API_KEY"]);
            (!key.is_empty()).then_some(key)
        }
        "trae" => {
            let table = read_toml_table(&homes.trae.join("traecli.toml"))
                .await
                .ok()?;
            table
                .get("model_providers")
                .and_then(toml::Value::as_table)?
                .values()
                .find_map(|entry| {
                    entry
                        .as_table()?
                        .get("api_key")?
                        .as_str()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_string)
                })
        }
        "command_code" => {
            let doc = read_json_object_or_empty(&homes.command_code.join("providers.json"))
                .await
                .unwrap_or_default();
            doc.get("providers")
                .and_then(serde_json::Value::as_object)?
                .values()
                .find_map(|entry| {
                    let key = json_text(entry, &["apiKey", "api_key"]);
                    (!key.is_empty()).then_some(key)
                })
        }
        "zcode" => {
            let doc = read_json_object_or_empty(&homes.zcode.join("settings.json"))
                .await
                .unwrap_or_default();
            let env = doc.get("env").unwrap_or(&doc);
            let key = json_text(
                env,
                &["ZHIPU_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
            );
            (!key.is_empty()).then_some(key)
        }
        _ if is_antigravity(agent_id) => native_gemini_draft(&homes.gemini, agent_id)
            .await
            .ok()
            .flatten()
            .map(|draft| draft.api_key)
            .filter(|value| !value.is_empty()),
        _ => None,
    }
}

async fn native_api_key(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
    provider_id: &str,
    api_url: &str,
) -> Result<Option<String>, String> {
    let drafts = native_import_drafts(home, environment, agent_id, &[]).await?;
    let native_id = format!("native:{provider_id}");
    if let Some(key) = drafts.into_iter().find_map(|draft| {
        let matches_id = draft.source_id == provider_id
            || draft.source_id == native_id
            || draft.source_id == "__native_live__";
        let matches_url = !api_url.is_empty() && draft.api_url == api_url;
        (matches_id || matches_url)
            .then_some(draft.api_key)
            .filter(|value| !value.is_empty())
    }) {
        return Ok(Some(key));
    }
    Ok(resolve_native_fallback_api_key(home, environment, agent_id, Some(provider_id)).await)
}

pub(super) fn provider_is_in_use(
    store: &ProviderStore,
    agent_id: &AgentId,
    provider_id: &str,
    native_codex: Option<&NativeCodexState>,
    native_pi: Option<&NativePiState>,
    native_grok: Option<&NativeGrokState>,
) -> bool {
    if store.bindings.values().any(|value| value == provider_id) {
        return true;
    }
    let Some(provider) = store
        .providers
        .iter()
        .find(|item| item.id == provider_id && item.agent_id == *agent_id)
    else {
        return false;
    };
    if let Some(native) = native_codex
        && !native_uses_vibex_projection(Some(native))
        && native_active_matches_provider(
            native.active_provider.as_deref(),
            native
                .providers
                .iter()
                .map(|item| (item.id.as_str(), item.api_url.as_str())),
            native.base_url.as_deref(),
            provider,
        )
    {
        return true;
    }
    if let Some(native) = native_pi
        && native_active_matches_provider(
            native.active_provider.as_deref(),
            native
                .providers
                .iter()
                .map(|item| (item.id.as_str(), item.api_url.as_str())),
            None,
            provider,
        )
    {
        return true;
    }
    if let Some(native) = native_grok
        && !native_uses_vibex_grok_projection(Some(native))
        && native_active_matches_provider(
            native.active_provider.as_deref(),
            native
                .providers
                .iter()
                .map(|item| (item.id.as_str(), item.api_url.as_str())),
            None,
            provider,
        )
    {
        return true;
    }
    false
}

fn native_active_matches_provider<'a>(
    active_id: Option<&str>,
    native_providers: impl IntoIterator<Item = (&'a str, &'a str)>,
    fallback_url: Option<&str>,
    provider: &StoredProvider,
) -> bool {
    let native_providers: Vec<(&str, &str)> = native_providers.into_iter().collect();
    let match_id = active_id.filter(|id| *id != "vibex");
    if match_id == Some(provider.id.as_str()) {
        return true;
    }
    let active_url = match_id
        .and_then(|id| {
            native_providers
                .iter()
                .find(|(provider_id, _)| *provider_id == id)
                .map(|(_, url)| *url)
                .filter(|url| !url.is_empty())
        })
        .or_else(|| {
            if active_id.is_none() {
                fallback_url.filter(|url| !url.is_empty())
            } else {
                None
            }
        });
    active_url.is_some_and(|url| url == provider.api_url)
        || (match_id.is_none()
            && active_url.is_some()
            && provider.id == NATIVE_ENDPOINT_PROVIDER_ID)
}

pub async fn preview_import(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
) -> Result<AgentModelProviderImportPreviewView, crate::host::native::NativeError> {
    if source != AgentModelProviderImportSource::CcSwitch || cc_switch_app_type(&agent_id).is_none()
    {
        validate_agent(&agent_id)?;
    }
    let existing = if validate_agent(&agent_id).is_ok() {
        list(store_path, agent_id.clone()).await?
    } else {
        AgentModelProvidersView {
            agent_id: agent_id.clone(),
            providers: Vec::new(),
            bound_provider_id: None,
        }
    };
    let names: Vec<String> = existing
        .providers
        .iter()
        .filter(|provider| provider.managed)
        .map(|provider| provider.name.clone())
        .collect();
    match source {
        AgentModelProviderImportSource::Native => {
            let drafts = native_import_drafts(home, environment, &agent_id, &names).await?;
            let empty = drafts.is_empty();
            Ok(drafts_to_preview(
                agent_id,
                source,
                None,
                drafts,
                empty.then(|| "当前原生配置没有可导入的端点".to_string()),
            ))
        }
        AgentModelProviderImportSource::CcSwitch => {
            let (path, drafts, error) = preview_cc_switch(home, &agent_id, &names).await;
            Ok(drafts_to_preview(
                agent_id,
                source,
                Some(path.display().to_string()),
                drafts,
                error,
            ))
        }
    }
}

pub async fn apply_import(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
    source_ids: &[String],
) -> Result<AgentModelProvidersView, crate::host::native::NativeError> {
    let selected: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
    let existing_names = existing_managed_names(store_path, agent_id.clone()).await?;
    let drafts = match source {
        AgentModelProviderImportSource::Native => {
            native_import_drafts(home, environment, &agent_id, &existing_names).await?
        }
        AgentModelProviderImportSource::CcSwitch => {
            preview_cc_switch(home, &agent_id, &existing_names).await.1
        }
    };
    let mut imported = 0;
    for draft in drafts {
        if !selected.contains(draft.source_id.as_str()) {
            continue;
        }
        if draft.skip_reason.is_some() {
            continue;
        }
        save(
            store_path,
            home,
            environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: draft.name,
                agent_id: agent_id.clone(),
                api_url: draft.api_url,
                api_key: Some(draft.api_key),
                model: draft.model,
            },
        )
        .await?;
        imported += 1;
    }
    if imported == 0 {
        return Err("没有可导入的供应商".into());
    }
    let homes = ProviderNativeHomes::resolve(home, environment);
    list_with_native(
        store_path,
        agent_id.clone(),
        Some(homes.native_list_home(&agent_id)),
    )
    .await
}

async fn existing_managed_names(
    store_path: &Path,
    agent_id: AgentId,
) -> Result<Vec<String>, String> {
    Ok(list(store_path, agent_id)
        .await?
        .providers
        .into_iter()
        .filter(|provider| provider.managed)
        .map(|provider| provider.name)
        .collect())
}

pub async fn resolve_probe_target(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
    provider_id: Option<&str>,
    api_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(String, String), crate::host::native::NativeError> {
    if let Some(url) = api_url.map(str::trim).filter(|value| !value.is_empty()) {
        let key = resolve_probe_api_key_from(
            store_path,
            agent_id,
            provider_id,
            api_key,
            Some(home),
            Some(environment),
        )
        .await?;
        return Ok((url.to_string(), key));
    }
    let provider_id = provider_id.map(str::trim).filter(|value| !value.is_empty());
    let homes = ProviderNativeHomes::resolve(home, environment);
    let view = if validate_agent(agent_id).is_ok() {
        Some(
            list_with_native(
                store_path,
                agent_id.clone(),
                Some(homes.native_list_home(agent_id)),
            )
            .await?,
        )
    } else {
        None
    };

    if let Some(provider_id) = provider_id {
        if let Some(view) = &view
            && let Some(provider) = view.providers.iter().find(|item| item.id == provider_id)
        {
            if provider.api_url.is_empty() {
                return Err("Provider 没有可测试的 API URL".into());
            }
            if provider.managed {
                let key = resolve_probe_api_key_from(
                    store_path,
                    agent_id,
                    Some(provider_id),
                    api_key,
                    Some(home),
                    Some(environment),
                )
                .await?;
                return Ok((provider.api_url.clone(), key));
            }
            let drafts = native_import_drafts(home, environment, agent_id, &[]).await?;
            let key = drafts
                .into_iter()
                .find(|draft| draft.source_id == provider_id)
                .map(|draft| draft.api_key)
                .filter(|value| !value.is_empty())
                .or_else(|| (!provider.api_key.is_empty()).then(|| provider.api_key.clone()))
                .ok_or_else(|| {
                    crate::host::native::NativeError::from("找不到可用于测试的 Provider 凭据")
                })?;
            return Ok((provider.api_url.clone(), key));
        }
        if agent_id.as_str() == "deepseek_harness" {
            let paths = crate::host::native::dsh_configuration::resolve_paths(home, environment);
            let url =
                crate::host::native::dsh_configuration::resolve_stored_base_url(&paths, Some(provider_id));
            let key = resolve_probe_api_key_from(
                store_path,
                agent_id,
                Some(provider_id),
                api_key,
                Some(home),
                Some(environment),
            )
            .await?;
            return Ok((url, key));
        }
        return Err("找不到要测试的 Provider".into());
    }

    if let Some(view) = &view
        && let Some(bound_id) = view.bound_provider_id.as_deref()
        && let Some(provider) = view.providers.iter().find(|item| item.id == bound_id)
        && !provider.api_url.is_empty()
    {
        let key = resolve_probe_api_key_from(
            store_path,
            agent_id,
            Some(bound_id),
            api_key,
            Some(home),
            Some(environment),
        )
        .await?;
        return Ok((provider.api_url.clone(), key));
    }

    if let Some(url) = resolve_fallback_api_url(home, environment, agent_id).await {
        let key = resolve_probe_api_key_from(
            store_path,
            agent_id,
            None,
            api_key,
            Some(home),
            Some(environment),
        )
        .await?;
        return Ok((url, key));
    }

    Err("测试连接需要 Provider".into())
}

async fn resolve_fallback_api_url(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
) -> Option<String> {
    if agent_id.as_str() == "deepseek_harness" {
        let paths = crate::host::native::dsh_configuration::resolve_paths(home, environment);
        let default_provider = environment
            .get(crate::host::native::dsh_configuration::ACP_PROVIDER_ENV)
            .map(String::as_str);
        return Some(
            crate::host::native::dsh_configuration::resolve_stored_base_url(
                &paths,
                default_provider,
            ),
        );
    }
    let homes = ProviderNativeHomes::resolve(home, environment);
    let native_url = match agent_id.as_str() {
        "claude_code" => native_claude_draft(&homes.claude)
            .await
            .ok()
            .flatten()
            .map(|draft| draft.api_url)
            .filter(|url| !url.is_empty()),
        "codex" => read_native_codex_state(&homes.codex)
            .await
            .ok()
            .and_then(|state| {
                state
                    .active_provider
                    .as_deref()
                    .and_then(|id| {
                        state
                            .providers
                            .iter()
                            .find(|item| item.id == id && !item.api_url.is_empty())
                            .map(|item| item.api_url.clone())
                    })
                    .or_else(|| state.base_url.filter(|url| !url.is_empty()))
            }),
        "grok" => {
            let settings = read_json_object_or_empty(&homes.grok.join("user-settings.json"))
                .await
                .unwrap_or_default();
            let base_url = json_text(&settings, &["baseURL", "baseUrl", "base_url"]);
            if !base_url.is_empty() {
                Some(base_url)
            } else {
                read_native_grok_state(&homes.grok)
                    .await
                    .ok()
                    .and_then(|state| {
                        state
                            .active_provider
                            .as_deref()
                            .and_then(|id| {
                                state
                                    .providers
                                    .iter()
                                    .find(|item| item.id == id && !item.api_url.is_empty())
                                    .map(|item| item.api_url.clone())
                            })
                            .or_else(|| {
                                state
                                    .providers
                                    .into_iter()
                                    .find_map(|item| (!item.api_url.is_empty()).then_some(item.api_url))
                            })
                    })
            }
        }
        "kimi_code" => {
            let mut found = None;
            for candidate_home in [homes.kimi.clone(), home.join(".kimi")] {
                if let Ok(Some(draft)) = native_kimi_draft(&candidate_home).await
                    && !draft.api_url.is_empty()
                {
                    found = Some(draft.api_url);
                    break;
                }
                if let Ok(drafts) = super::kimi::native_kimi_provider_drafts(&candidate_home).await
                    && let Some(url) = drafts
                        .into_iter()
                        .find_map(|draft| (!draft.api_url.is_empty()).then_some(draft.api_url))
                {
                    found = Some(url);
                    break;
                }
            }
            found
        }
        "hermes" => super::hermes::native_hermes_draft(&homes.hermes)
            .await
            .ok()
            .and_then(|drafts| {
                drafts
                    .into_iter()
                    .find_map(|draft| (!draft.api_url.is_empty()).then_some(draft.api_url))
            }),
        "cline" => super::cline::native_cline_draft(&homes.cline)
            .await
            .ok()
            .and_then(|drafts| {
                drafts
                    .into_iter()
                    .find_map(|draft| (!draft.api_url.is_empty()).then_some(draft.api_url))
            }),
        _ if is_antigravity(agent_id) => native_gemini_draft(&homes.gemini, agent_id)
            .await
            .ok()
            .flatten()
            .map(|draft| draft.api_url)
            .filter(|url| !url.is_empty()),
        _ => None,
    };
    if let Some(url) = native_url {
        return Some(url);
    }

    for env_key in [
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "GEMINI_BASE_URL",
        "GOOGLE_GEMINI_BASE_URL",
        "DEEPSEEK_BASE_URL",
        "CODEBUDDY_BASE_URL",
        "AUGMENT_API_URL",
        "CURSOR_API_BASE_URL",
        "API_BASE_URL",
    ] {
        if let Some(url) = environment
            .get(env_key)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(url.to_string());
        }
    }

    [
        "official_api",
        "api_key",
        "custom",
        "gemini-api-key",
        "deepseek",
    ]
    .into_iter()
    .find_map(|mode| agents::official_api_url(agent_id, mode).map(str::to_string))
}

async fn capture_files(
    home: &Path,
    files: &[&str],
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    for file in files {
        capture_text_file(&home.join(file), file, backup).await?;
    }
    Ok(())
}

async fn restore_files(
    home: &Path,
    files: &[(&str, bool)],
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    for (file, sensitive) in files {
        restore_text_file(&home.join(file), file, backup, *sensitive).await?;
    }
    Ok(())
}

pub(super) async fn capture_projection(
    homes: &ProviderNativeHomes,
    agent_id: &AgentId,
) -> Result<ProviderProjectionBackup, crate::host::native::NativeError> {
    validate_agent(agent_id)?;
    let mut backup = ProviderProjectionBackup::default();
    match agent_id.as_str() {
        "claude_code" => {
            capture_json_env(
                &homes.claude.join("settings.json"),
                CLAUDE_ENV_KEYS,
                &mut backup,
            )
            .await?;
        }
        "codex" => {
            capture_json_root(&homes.codex.join("auth.json"), CODEX_AUTH_KEYS, &mut backup).await?;
            capture_codex_toml(&homes.codex.join("config.toml"), &mut backup).await?;
            capture_files(
                &homes.codex,
                &[CODEX_CATALOG_FILE, CODEX_SOURCE_FILE],
                &mut backup,
            )
            .await?;
        }
        id if is_antigravity(agent_id) => {
            let settings = if id == "gemini" {
                homes.gemini.join("settings.json")
            } else {
                antigravity_settings_path(&homes.gemini)
            };
            capture_json_env(&settings, GEMINI_ENV_KEYS, &mut backup).await?;
            if id != "gemini" {
                capture_antigravity_auth_type(&settings, &mut backup).await?;
            }
        }
        "grok" => capture_grok_toml(&homes.grok.join("config.toml"), &mut backup).await?,
        "kimi_code" => {
            capture_files(
                &homes.kimi,
                &["config.toml", "credentials/kimi-code.json"],
                &mut backup,
            )
            .await?;
        }
        "hermes" => capture_files(&homes.hermes, &["config.yaml"], &mut backup).await?,
        "openclaw" => capture_files(&homes.openclaw, &["openclaw.json"], &mut backup).await?,
        "cline" => {
            capture_files(
                &homes.cline,
                &["globalState.json", "secrets.json"],
                &mut backup,
            )
            .await?;
        }
        "pi" => {
            capture_files(
                &homes.pi,
                &["settings.json", "models.json", "auth.json"],
                &mut backup,
            )
            .await?;
        }
        "omp" => {
            capture_files(&homes.omp, &["models.yml", "config.yml"], &mut backup).await?;
        }
        "codebuddy" => capture_files(&homes.codebuddy, &[".env"], &mut backup).await?,
        "qoder" => capture_files(&homes.qoder, &["settings.json"], &mut backup).await?,
        "auggie" => capture_files(&homes.auggie, &["settings.json"], &mut backup).await?,
        "trae" => capture_files(&homes.trae, &["traecli.toml"], &mut backup).await?,
        "command_code" => {
            capture_files(&homes.command_code, &["providers.json"], &mut backup).await?;
        }
        "zcode" => capture_files(&homes.zcode, &["settings.json"], &mut backup).await?,
        _ => unreachable!("validated Agent"),
    }
    Ok(backup)
}

pub(super) fn empty_projection_backup(agent_id: &AgentId) -> ProviderProjectionBackup {
    let mut backup = ProviderProjectionBackup::default();
    let json_keys: &[&str] = match agent_id.as_str() {
        "claude_code" => CLAUDE_ENV_KEYS,
        "codex" => CODEX_AUTH_KEYS,
        _ if is_antigravity(agent_id) => GEMINI_ENV_KEYS,
        _ => &[],
    };
    for key in json_keys {
        backup.json_values.insert((*key).to_string(), None);
    }
    if agent_id.as_str() == "codex" {
        for key in CODEX_CONFIG_KEYS {
            backup.toml_values.insert((*key).to_string(), None);
        }
        backup
            .toml_values
            .insert(CODEX_PROVIDER_ENTRY_BACKUP_KEY.to_string(), None);
        backup
            .file_values
            .insert(CODEX_CATALOG_FILE.to_string(), None);
        backup
            .file_values
            .insert(CODEX_SOURCE_FILE.to_string(), None);
    }
    if agent_id.as_str() == "grok" {
        backup
            .toml_values
            .insert(GROK_DEFAULT_BACKUP_KEY.to_string(), None);
    }
    for key in match agent_id.as_str() {
        "kimi_code" => ["config.toml", "credentials/kimi-code.json"].as_slice(),
        "hermes" => ["config.yaml"].as_slice(),
        "openclaw" => ["openclaw.json"].as_slice(),
        "cline" => ["globalState.json", "secrets.json"].as_slice(),
        "pi" => ["settings.json", "models.json", "auth.json"].as_slice(),
        "omp" => ["models.yml", "config.yml"].as_slice(),
        "codebuddy" => [".env"].as_slice(),
        "qoder" | "auggie" | "zcode" => ["settings.json"].as_slice(),
        "trae" => ["traecli.toml"].as_slice(),
        "command_code" => ["providers.json"].as_slice(),
        _ => [].as_slice(),
    } {
        backup.file_values.insert((*key).to_string(), None);
    }
    backup
}

pub(super) async fn restore_projection(
    homes: &ProviderNativeHomes,
    agent_id: &AgentId,
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    match agent_id.as_str() {
        "claude_code" => {
            restore_json_env(
                &homes.claude.join("settings.json"),
                CLAUDE_ENV_KEYS,
                backup,
                true,
            )
            .await
        }
        "codex" => restore_codex_projection(&homes.codex, backup).await,
        id if is_antigravity(agent_id) => {
            let settings = if id == "gemini" {
                homes.gemini.join("settings.json")
            } else {
                antigravity_settings_path(&homes.gemini)
            };
            restore_json_env(&settings, GEMINI_ENV_KEYS, backup, true).await?;
            if id == "gemini" {
                Ok(())
            } else {
                restore_antigravity_auth_type(&settings, backup).await
            }
        }
        "grok" => restore_grok_projection(&homes.grok, backup).await,
        "kimi_code" => {
            restore_files(
                &homes.kimi,
                &[("config.toml", true), ("credentials/kimi-code.json", true)],
                backup,
            )
            .await
        }
        "hermes" => restore_files(&homes.hermes, &[("config.yaml", true)], backup).await,
        "openclaw" => restore_files(&homes.openclaw, &[("openclaw.json", true)], backup).await,
        "cline" => {
            restore_files(
                &homes.cline,
                &[("globalState.json", false), ("secrets.json", true)],
                backup,
            )
            .await
        }
        "pi" => {
            restore_files(
                &homes.pi,
                &[
                    ("settings.json", false),
                    ("models.json", false),
                    ("auth.json", true),
                ],
                backup,
            )
            .await
        }
        "omp" => {
            restore_files(
                &homes.omp,
                &[("models.yml", true), ("config.yml", false)],
                backup,
            )
            .await
        }
        "codebuddy" => restore_files(&homes.codebuddy, &[(".env", true)], backup).await,
        "qoder" => restore_files(&homes.qoder, &[("settings.json", true)], backup).await,
        "auggie" => restore_files(&homes.auggie, &[("settings.json", true)], backup).await,
        "trae" => restore_files(&homes.trae, &[("traecli.toml", true)], backup).await,
        "command_code" => {
            restore_files(&homes.command_code, &[("providers.json", true)], backup).await
        }
        "zcode" => restore_files(&homes.zcode, &[("settings.json", true)], backup).await,
        _ => validate_agent(agent_id),
    }
}

pub(super) async fn read_store_reconciled(
    store_path: &Path,
    agent_id: &AgentId,
    native: Option<&NativeCodexState>,
) -> Result<ProviderStore, crate::host::native::NativeError> {
    let mut store = read_store(store_path).await?;
    if reconcile_codex_store_bindings(&mut store, agent_id, native) {
        write_store(store_path, &store).await?;
    }
    Ok(store)
}

pub(super) fn reconcile_codex_store_bindings(
    store: &mut ProviderStore,
    agent_id: &AgentId,
    native: Option<&NativeCodexState>,
) -> bool {
    if agent_id.as_str() != "codex" || !store.bindings.contains_key(agent_id.as_str()) {
        return false;
    }
    if native_uses_vibex_projection(native) {
        return false;
    }
    store.bindings.remove(agent_id.as_str());
    store.projection_backups.remove(agent_id.as_str());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_probe_target_falls_back_to_official_url_and_native_or_env_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path();
        let store_path = home.join("agent-model-providers.json");

        // Claude Code: saved in settings.json env.ANTHROPIC_AUTH_TOKEN, no provider_id
        let claude_dir = home.join(".claude");
        std::fs::create_dir_all(&claude_dir).expect("claude dir");
        std::fs::write(
            claude_dir.join("settings.json"),
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-saved"}}"#,
        )
        .expect("write claude settings");

        let claude_id = AgentId::parse("claude_code").expect("claude_code");
        let (url, key) = resolve_probe_target(
            &store_path,
            home,
            &HashMap::new(),
            &claude_id,
            None,
            None,
            None,
        )
        .await
        .expect("claude probe target");
        assert_eq!(url, "https://api.anthropic.com");
        assert_eq!(key, "sk-ant-saved");

        // Grok: saved in user-settings.json apiKey, no provider_id
        let grok_dir = home.join(".grok");
        std::fs::create_dir_all(&grok_dir).expect("grok dir");
        std::fs::write(
            grok_dir.join("user-settings.json"),
            r#"{"apiKey":"xai-saved-key"}"#,
        )
        .expect("write grok settings");

        let grok_id = AgentId::parse("grok").expect("grok");
        let (grok_url, grok_key) = resolve_probe_target(
            &store_path,
            home,
            &HashMap::new(),
            &grok_id,
            None,
            None,
            None,
        )
        .await
        .expect("grok probe target");
        assert_eq!(grok_url, "https://api.x.ai/v1");
        assert_eq!(grok_key, "xai-saved-key");

        // DeepSeek Harness: saved in .dsh/.credentials.yaml under refs.DEEPSEEK_API_KEY
        let dsh_dir = home.join(".dsh");
        std::fs::create_dir_all(&dsh_dir).expect("dsh dir");
        std::fs::write(
            dsh_dir.join(".credentials.yaml"),
            "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-dsh-saved\n",
        )
        .expect("write dsh credentials");

        let dsh_id = AgentId::parse("deepseek_harness").expect("deepseek_harness");
        let (dsh_url, dsh_key) = resolve_probe_target(
            &store_path,
            home,
            &HashMap::new(),
            &dsh_id,
            None,
            None,
            None,
        )
        .await
        .expect("dsh probe target");
        assert_eq!(dsh_url, "https://api.deepseek.com");
        assert_eq!(dsh_key, "sk-dsh-saved");
    }
}

