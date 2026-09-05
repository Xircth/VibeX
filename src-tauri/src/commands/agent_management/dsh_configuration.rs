use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};

use api_types::{
    DshCatalogProviderView, DshExtensionKind, DshPluginSummaryView, DshPluginView, DshProviderKind,
    DshProviderModelView, DshProviderSaveRequest, DshProviderView, DshProvidersView,
};
use serde_yaml::Value;

use super::NativeFileMutation;

pub const OFFICIAL_PROVIDER_ID: &str = "deepseek-official";
pub const OFFICIAL_API_KEY_ENV: &str = "DEEPSEEK_API_KEY";
pub const OFFICIAL_BASE_URL: &str = "https://api.deepseek.com";
pub const DEFAULT_OFFICIAL_MODEL: &str = "deepseek-v4-flash";
pub const ACP_PROVIDER_ENV: &str = "DEEPSEEK_ACP_PROVIDER";
pub const ACP_MODEL_ENV: &str = "DEEPSEEK_ACP_MODEL";
pub const BASE_URL_ENV: &str = "DEEPSEEK_BASE_URL";
pub const DSH_PROFILE: &str = "default";
const DSH_CLI_PACKAGE: &str = "@deepseek-ai/dsh@0.1.0-rc.6";
const PLUGIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(180);
const RESERVED_PLUGIN: &str = "@deepseek-ai/dsh-base";

const OFFICIAL_MODELS: &[(&str, &str)] = &[
    ("deepseek-v4-flash", "DeepSeek-V4-Flash"),
    ("deepseek-v4-pro", "DeepSeek-V4-Pro"),
];

const CUSTOM_APIS: &[&str] = &["openai-completions", "openai-responses"];

const CATALOG_PROVIDERS: &[(&str, &str, &str)] = &[
    ("anthropic", "Anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OpenAI", "OPENAI_API_KEY"),
    ("google", "Google Gemini", "GEMINI_API_KEY"),
    ("openrouter", "OpenRouter", "OPENROUTER_API_KEY"),
    ("groq", "Groq", "GROQ_API_KEY"),
    ("cerebras", "Cerebras", "CEREBRAS_API_KEY"),
    ("mistral", "Mistral", "MISTRAL_API_KEY"),
    ("together", "Together AI", "TOGETHER_API_KEY"),
    ("fireworks", "Fireworks", "FIREWORKS_API_KEY"),
    ("xai", "xAI", "XAI_API_KEY"),
    ("deepseek", "DeepSeek", "DEEPSEEK_API_KEY"),
];

static PLUGIN_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub struct DshPaths {
    pub home: PathBuf,
    pub settings: PathBuf,
    pub credentials: PathBuf,
    pub profile_dir: PathBuf,
}

pub fn resolve_paths(user_home: &Path, environment: &HashMap<String, String>) -> DshPaths {
    let home = environment
        .get("DSH_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| expand_home(user_home, value))
        .or_else(|| {
            std::env::var("DSH_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| user_home.join(".dsh"));
    DshPaths {
        settings: home.join("settings.yaml"),
        credentials: home.join(".credentials.yaml"),
        profile_dir: home.join("profiles").join(DSH_PROFILE),
        home,
    }
}

pub fn catalog() -> Vec<DshCatalogProviderView> {
    CATALOG_PROVIDERS
        .iter()
        .map(|(id, name, env)| DshCatalogProviderView {
            id: (*id).to_string(),
            name: (*name).to_string(),
            api_key_env: (*env).to_string(),
        })
        .collect()
}

pub fn load_providers(
    paths: &DshPaths,
    default_provider: Option<&str>,
    default_model: Option<&str>,
) -> Result<DshProvidersView, String> {
    let settings = read_yaml_mapping(&paths.settings)?;
    let credentials = read_yaml_mapping(&paths.credentials)?;
    Ok(project_providers(
        paths,
        &settings,
        &credentials,
        default_provider,
        default_model,
    ))
}

/// Build the view from already-resolved documents.
///
/// A save returns the mutations for the caller to persist, so re-reading the
/// files here would project the state from before the save and the UI would
/// show a stale provider list until something else forced a reload.
fn project_providers(
    paths: &DshPaths,
    settings: &serde_yaml::Mapping,
    credentials: &serde_yaml::Mapping,
    default_provider: Option<&str>,
    default_model: Option<&str>,
) -> DshProvidersView {
    let mut providers = vec![official_provider(settings, credentials)];
    let mut seen = HashSet::from([OFFICIAL_PROVIDER_ID.to_string()]);
    if let Some(configured) = settings
        .get(Value::String("llm-pi-ai".into()))
        .and_then(Value::as_mapping)
        .and_then(|section| section.get(Value::String("providers".into())))
        .and_then(Value::as_mapping)
    {
        let mut ids = configured
            .keys()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        ids.sort();
        for id in ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(entry) = configured
                .get(Value::String(id.clone()))
                .and_then(Value::as_mapping)
            else {
                continue;
            };
            providers.push(project_pi_provider(&id, entry, credentials));
        }
    }

    let default_provider = default_provider
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(OFFICIAL_PROVIDER_ID)
        .to_string();
    let default_model = default_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            providers
                .iter()
                .find(|provider| provider.id == default_provider)
                .and_then(|provider| provider.models.first().map(|model| model.id.clone()))
        })
        .unwrap_or_else(|| DEFAULT_OFFICIAL_MODEL.to_string());

    DshProvidersView {
        settings_path: paths.settings.display().to_string(),
        credentials_path: paths.credentials.display().to_string(),
        default_provider,
        default_model,
        providers,
        catalog: catalog(),
    }
}

pub fn save_provider(
    paths: &DshPaths,
    request: DshProviderSaveRequest,
) -> Result<(DshProvidersView, Vec<NativeFileMutation>), String> {
    let id = normalize_provider_id(&request.id)?;
    let (mut settings, settings_original) = read_yaml_state(&paths.settings)?;
    let (mut credentials, credentials_original) = read_yaml_state(&paths.credentials)?;
    let kind = provider_kind(&id);
    match kind {
        DshProviderKind::Official => apply_official_provider(&mut settings, &request)?,
        DshProviderKind::Catalog | DshProviderKind::Custom => {
            apply_pi_provider(&mut settings, &id, kind, &request)?;
        }
    }
    if let Some(api_key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_secret(api_key)?;
        credentials.insert(
            Value::String(api_key_env_for(&id, &request)),
            Value::String(api_key.to_string()),
        );
        if request.set_default && kind != DshProviderKind::Official {
            credentials.insert(
                Value::String(OFFICIAL_API_KEY_ENV.into()),
                Value::String(api_key.to_string()),
            );
        }
    }
    if request.set_default && kind != DshProviderKind::Official {
        apply_official_provider(
            &mut settings,
            &DshProviderSaveRequest {
                id: OFFICIAL_PROVIDER_ID.to_string(),
                display_name: None,
                notes: None,
                api: None,
                base_url: request.base_url.clone(),
                api_key: None,
                models: request.models.clone(),
                set_default: false,
                default_model: request.default_model.clone(),
            },
        )?;
    }

    let mutations = vec![
        yaml_mutation(&paths.settings, settings_original, &settings, false)?,
        yaml_mutation(&paths.credentials, credentials_original, &credentials, true)?,
    ];
    let default_provider = if request.set_default {
        Some(id.as_str())
    } else {
        None
    };
    let default_model = request
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok((
        project_providers(
            paths,
            &settings,
            &credentials,
            default_provider,
            default_model,
        ),
        mutations,
    ))
}

pub fn delete_provider(
    paths: &DshPaths,
    provider_id: &str,
) -> Result<(DshProvidersView, Vec<NativeFileMutation>), String> {
    let id = normalize_provider_id(provider_id)?;
    if id == OFFICIAL_PROVIDER_ID {
        return Err("不能删除官方 DeepSeek Provider".to_string());
    }
    let (mut settings, settings_original) = read_yaml_state(&paths.settings)?;
    let (mut credentials, credentials_original) = read_yaml_state(&paths.credentials)?;
    let removed_env = remove_pi_provider(&mut settings, &id);
    if let Some(env_name) = removed_env.filter(|name| name != OFFICIAL_API_KEY_ENV)
        && !credential_still_referenced(&settings, &env_name)
    {
        credentials.remove(Value::String(env_name));
    }
    let mutations = vec![
        yaml_mutation(&paths.settings, settings_original, &settings, false)?,
        yaml_mutation(&paths.credentials, credentials_original, &credentials, true)?,
    ];
    Ok((
        project_providers(paths, &settings, &credentials, None, None),
        mutations,
    ))
}

pub async fn discover_models(
    paths: &DshPaths,
    base_url: &str,
    api_key: Option<&str>,
    provider_id: Option<&str>,
) -> Result<Vec<DshProviderModelView>, String> {
    let endpoint = normalize_models_url(base_url)?;
    let key = api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let id = provider_id
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let credentials = read_yaml_mapping(&paths.credentials).ok()?;
            let env_name = catalog_env(id).unwrap_or_else(|| default_custom_env(id));
            credentials
                .get(Value::String(env_name))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| "拉取模型需要 API Key".to_string())?;
    validate_secret(&key)?;
    let response = reqwest::Client::new()
        .get(endpoint)
        .bearer_auth(key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("读取模型目录失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "读取模型目录失败：HTTP {}",
            response.status().as_u16()
        ));
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("解析模型目录失败：{error}"))?;
    let mut models = body
        .get("data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            Some(DshProviderModelView {
                id: id.to_string(),
                name: entry
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            })
        })
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    Ok(models)
}

pub fn load_plugins(paths: &DshPaths) -> Result<DshPluginSummaryView, String> {
    let mut plugins = Vec::new();
    let mut seen = HashSet::new();
    let profiles_root = paths.home.join("profiles");
    if let Ok(entries) = std::fs::read_dir(&profiles_root) {
        let mut names = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>();
        names.sort();
        for name in names {
            let profile_dir = profiles_root.join(&name);
            let manifest = profile_dir.join("package.json");
            if let Ok(bytes) = std::fs::read(&manifest) {
                for plugin in parse_profile_plugins(&bytes, &name)? {
                    if seen.insert(plugin_key(&plugin)) {
                        plugins.push(plugin);
                    }
                }
            }
        }
    }
    if let Ok(bytes) = std::fs::read(paths.home.join("cordis.patch.yml")) {
        for plugin in parse_patch_plugins(&bytes, "home")? {
            if seen.insert(plugin_key(&plugin)) {
                plugins.push(plugin);
            }
        }
    }
    plugins.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.name.cmp(&right.name)));
    Ok(DshPluginSummaryView {
        profile: DSH_PROFILE.to_string(),
        profile_dir: paths.profile_dir.display().to_string(),
        plugins,
    })
}

pub fn any_credential_present(paths: &DshPaths) -> bool {
    let Ok(credentials) = read_yaml_mapping(&paths.credentials) else {
        return false;
    };
    credentials.values().any(|value| {
        value
            .as_str()
            .is_some_and(|secret| !secret.trim().is_empty())
    })
}

pub fn inferred_auth_mode(paths: &DshPaths, configured: Option<&str>) -> &'static str {
    if configured == Some("custom") {
        return "custom";
    }
    if configured == Some("deepseek") {
        return "deepseek";
    }
    let Ok(view) = load_providers(paths, None, None) else {
        return "deepseek";
    };
    let official = view
        .providers
        .iter()
        .find(|provider| provider.id == OFFICIAL_PROVIDER_ID);
    if official
        .and_then(|provider| provider.base_url.as_deref())
        .is_some_and(|url| !url.trim().is_empty() && url != OFFICIAL_BASE_URL)
    {
        return "custom";
    }
    if view.default_provider != OFFICIAL_PROVIDER_ID {
        return "custom";
    }
    if official.is_none_or(|provider| !provider.credential_present)
        && view
            .providers
            .iter()
            .any(|provider| provider.id != OFFICIAL_PROVIDER_ID && provider.credential_present)
    {
        return "custom";
    }
    "deepseek"
}

pub async fn add_plugin(paths: &DshPaths, spec: &str) -> Result<DshPluginSummaryView, String> {
    let spec = validate_plugin_spec(spec)?;
    run_dsh_plugin(paths, &["add", spec.as_str()]).await?;
    load_plugins(paths)
}

pub async fn remove_plugin(paths: &DshPaths, name: &str) -> Result<DshPluginSummaryView, String> {
    let name = validate_plugin_name(name)?;
    if name == RESERVED_PLUGIN {
        return Err("不能卸载 DeepSeek Harness 基础包".to_string());
    }
    run_dsh_plugin(paths, &["remove", name.as_str()]).await?;
    load_plugins(paths)
}

pub fn default_env_updates(
    request: &DshProviderSaveRequest,
    _current: &HashMap<String, String>,
) -> BTreeMap<String, Option<String>> {
    if !request.set_default {
        return BTreeMap::new();
    }
    let Ok(id) = normalize_provider_id(&request.id) else {
        return BTreeMap::new();
    };
    let model = request
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| request.models.first().map(|model| model.id.as_str()))
        .unwrap_or(DEFAULT_OFFICIAL_MODEL)
        .to_string();
    let official = id == OFFICIAL_PROVIDER_ID;
    let mut updates = BTreeMap::from([
        (
            ACP_PROVIDER_ENV.to_string(),
            Some(OFFICIAL_PROVIDER_ID.to_string()),
        ),
        (ACP_MODEL_ENV.to_string(), Some(model)),
    ]);
    updates.insert(
        BASE_URL_ENV.to_string(),
        if official {
            None
        } else {
            request
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        },
    );
    updates
}

fn official_provider(
    settings: &serde_yaml::Mapping,
    credentials: &serde_yaml::Mapping,
) -> DshProviderView {
    let section = settings
        .get(Value::String("llm-deepseek".into()))
        .and_then(Value::as_mapping);
    let models = section
        .and_then(|section| section.get(Value::String("models".into())))
        .and_then(Value::as_sequence)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model
                        .as_mapping()
                        .and_then(|entry| entry.get(Value::String("id".into())))
                        .and_then(Value::as_str)
                        .or_else(|| model.as_str())?
                        .trim();
                    if id.is_empty() {
                        return None;
                    }
                    Some(DshProviderModelView {
                        id: id.to_string(),
                        name: model
                            .as_mapping()
                            .and_then(|entry| entry.get(Value::String("name".into())))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .filter(|models| !models.is_empty())
        .unwrap_or_else(official_models);
    DshProviderView {
        id: OFFICIAL_PROVIDER_ID.to_string(),
        display_name: "DeepSeek".to_string(),
        kind: DshProviderKind::Official,
        notes: None,
        api: None,
        base_url: section
            .and_then(|section| section.get(Value::String("baseURL".into())))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        api_key_env: OFFICIAL_API_KEY_ENV.to_string(),
        credential_present: credential_present(credentials, OFFICIAL_API_KEY_ENV),
        models,
    }
}

fn official_models() -> Vec<DshProviderModelView> {
    OFFICIAL_MODELS
        .iter()
        .map(|(id, name)| DshProviderModelView {
            id: (*id).to_string(),
            name: Some((*name).to_string()),
        })
        .collect()
}

fn project_pi_provider(
    id: &str,
    entry: &serde_yaml::Mapping,
    credentials: &serde_yaml::Mapping,
) -> DshProviderView {
    let kind = provider_kind(id);
    let api_key_env = entry
        .get(Value::String("apiKeyEnv".into()))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| catalog_env(id).unwrap_or_else(|| default_custom_env(id)));
    DshProviderView {
        id: id.to_string(),
        display_name: entry
            .get(Value::String("displayName".into()))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| catalog_name(id).unwrap_or_else(|| id.to_string())),
        notes: entry
            .get(Value::String("notes".into()))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        kind,
        api: entry
            .get(Value::String("api".into()))
            .and_then(Value::as_str)
            .map(str::to_string),
        base_url: entry
            .get(Value::String("baseURL".into()))
            .and_then(Value::as_str)
            .map(str::to_string),
        credential_present: credential_present(credentials, &api_key_env),
        api_key_env,
        models: entry
            .get(Value::String("models".into()))
            .and_then(Value::as_sequence)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model
                    .as_mapping()
                    .and_then(|entry| entry.get(Value::String("id".into())))
                    .and_then(Value::as_str)
                    .or_else(|| model.as_str())?
                    .trim();
                if id.is_empty() {
                    return None;
                }
                Some(DshProviderModelView {
                    id: id.to_string(),
                    name: model
                        .as_mapping()
                        .and_then(|entry| entry.get(Value::String("name".into())))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect(),
    }
}

fn apply_official_provider(
    settings: &mut serde_yaml::Mapping,
    request: &DshProviderSaveRequest,
) -> Result<(), String> {
    let section = mapping_entry(settings, "llm-deepseek");
    section.insert(
        Value::String("apiKeyEnv".into()),
        Value::String(OFFICIAL_API_KEY_ENV.into()),
    );
    if let Some(base_url) = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_http_url(base_url)?;
        section.insert(
            Value::String("baseURL".into()),
            Value::String(base_url.to_string()),
        );
    } else {
        section.remove(Value::String("baseURL".into()));
    }
    if !request.models.is_empty() {
        section.insert(
            Value::String("models".into()),
            Value::Sequence(model_sequence(&request.models)?),
        );
    }
    Ok(())
}

fn apply_pi_provider(
    settings: &mut serde_yaml::Mapping,
    id: &str,
    kind: DshProviderKind,
    request: &DshProviderSaveRequest,
) -> Result<(), String> {
    let providers = {
        let section = mapping_entry(settings, "llm-pi-ai");
        mapping_entry(section, "providers")
    };
    let existing = providers
        .get(Value::String(id.to_string()))
        .and_then(Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    let mut entry = existing;
    let env_name = api_key_env_for(id, request);
    entry.insert(Value::String("apiKeyEnv".into()), Value::String(env_name));
    if let Some(name) = request
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        entry.insert(
            Value::String("displayName".into()),
            Value::String(name.to_string()),
        );
    } else if kind == DshProviderKind::Catalog
        && let Some(name) = catalog_name(id)
    {
        entry.insert(Value::String("displayName".into()), Value::String(name));
    }
    if let Some(notes) = request
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        entry.insert(
            Value::String("notes".into()),
            Value::String(notes.to_string()),
        );
    }
    if kind == DshProviderKind::Custom {
        let api = request
            .api
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "自定义 Provider 需要 API 协议".to_string())?;
        if !CUSTOM_APIS.contains(&api) {
            return Err("自定义 Provider 协议无效".to_string());
        }
        let base_url = request
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "自定义 Provider 需要 Base URL".to_string())?;
        validate_http_url(base_url)?;
        if request.models.is_empty() {
            return Err("自定义 Provider 至少需要一个模型".to_string());
        }
        entry.insert(Value::String("api".into()), Value::String(api.to_string()));
        entry.insert(
            Value::String("baseURL".into()),
            Value::String(base_url.to_string()),
        );
        entry.insert(
            Value::String("models".into()),
            Value::Sequence(model_sequence(&request.models)?),
        );
    } else if !request.models.is_empty() {
        entry.insert(
            Value::String("models".into()),
            Value::Sequence(model_sequence(&request.models)?),
        );
    }
    providers.insert(Value::String(id.to_string()), Value::Mapping(entry));
    Ok(())
}

fn remove_pi_provider(settings: &mut serde_yaml::Mapping, id: &str) -> Option<String> {
    let providers = settings
        .get_mut(Value::String("llm-pi-ai".into()))?
        .as_mapping_mut()?
        .get_mut(Value::String("providers".into()))?
        .as_mapping_mut()?;
    let removed = providers.remove(Value::String(id.to_string()))?;
    removed
        .as_mapping()
        .and_then(|entry| entry.get(Value::String("apiKeyEnv".into())))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn credential_still_referenced(settings: &serde_yaml::Mapping, env_name: &str) -> bool {
    if settings
        .get(Value::String("llm-deepseek".into()))
        .and_then(Value::as_mapping)
        .and_then(|section| section.get(Value::String("apiKeyEnv".into())))
        .and_then(Value::as_str)
        == Some(env_name)
    {
        return true;
    }
    settings
        .get(Value::String("llm-pi-ai".into()))
        .and_then(Value::as_mapping)
        .and_then(|section| section.get(Value::String("providers".into())))
        .and_then(Value::as_mapping)
        .into_iter()
        .flatten()
        .any(|(_, provider)| {
            provider
                .as_mapping()
                .and_then(|entry| entry.get(Value::String("apiKeyEnv".into())))
                .and_then(Value::as_str)
                == Some(env_name)
        })
}

fn model_sequence(models: &[DshProviderModelView]) -> Result<Vec<Value>, String> {
    let mut seen = HashSet::new();
    let mut sequence = Vec::new();
    for model in models {
        let id = model.id.trim();
        if id.is_empty() {
            return Err("模型 ID 不能为空".to_string());
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("模型 ID `{id}` 重复"));
        }
        let mut entry = serde_yaml::Mapping::new();
        entry.insert(Value::String("id".into()), Value::String(id.to_string()));
        if let Some(name) = model
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            entry.insert(
                Value::String("name".into()),
                Value::String(name.to_string()),
            );
        }
        sequence.push(Value::Mapping(entry));
    }
    Ok(sequence)
}

fn plugin_key(plugin: &DshPluginView) -> String {
    format!("{:?}:{}", plugin.kind, plugin.name)
}

fn extension_view(name: String, version: Option<String>, source: &str) -> DshPluginView {
    DshPluginView {
        reserved: name == RESERVED_PLUGIN,
        name,
        version,
        source: source.to_string(),
        kind: DshExtensionKind::Plugin,
        path: None,
        summary: None,
    }
}

fn parse_profile_plugins(bytes: &[u8], source: &str) -> Result<Vec<DshPluginView>, String> {
    let document: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 profile package.json 失败：{error}"))?;
    let dependencies = document
        .get("dependencies")
        .and_then(serde_json::Value::as_object);
    Ok(document
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(|name| {
            extension_view(
                name.to_string(),
                dependencies
                    .and_then(|deps| deps.get(name))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                source,
            )
        })
        .collect())
}

fn parse_patch_plugins(bytes: &[u8], source: &str) -> Result<Vec<DshPluginView>, String> {
    let value: Value = serde_yaml::from_slice(bytes)
        .map_err(|error| format!("解析 cordis.patch.yml 失败：{error}"))?;
    let mut plugins = Vec::new();
    let Some(items) = value.as_sequence() else {
        return Ok(plugins);
    };
    for item in items {
        let Some(insert) = item
            .as_mapping()
            .and_then(|entry| entry.get(Value::String("insert".into())))
            .and_then(Value::as_sequence)
        else {
            continue;
        };
        for row in insert {
            let Some(name) = row
                .as_mapping()
                .and_then(|entry| entry.get(Value::String("name".into())))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| {
                    !value.is_empty() && !value.starts_with('.') && !value.starts_with('/')
                })
            else {
                continue;
            };
            plugins.push(extension_view(name.to_string(), None, source));
        }
    }
    Ok(plugins)
}

async fn run_dsh_plugin(paths: &DshPaths, args: &[&str]) -> Result<(), String> {
    let _guard = PLUGIN_OPERATION
        .try_lock()
        .map_err(|_| "另一个 DeepSeek Harness 插件操作正在进行".to_string())?;
    tokio::fs::create_dir_all(&paths.profile_dir)
        .await
        .map_err(|error| format!("创建 DSH profile 失败：{error}"))?;
    let (program, prefix): (PathBuf, Vec<&str>) = if let Ok(dsh) = which::which("dsh") {
        (dsh, vec!["plugin", "--profile", DSH_PROFILE])
    } else {
        let npx = which::which("npx")
            .map_err(|_| "未找到 dsh 或 npx；安装 DeepSeek Harness 后才能管理插件".to_string())?;
        (
            npx,
            vec!["--yes", DSH_CLI_PACKAGE, "plugin", "--profile", DSH_PROFILE],
        )
    };
    let mut command = utils::process::new_hidden_tokio_command(
        &program,
        prefix.into_iter().chain(args.iter().copied()),
    );
    command
        .env("DSH_HOME", &paths.home)
        .current_dir(&paths.home)
        .kill_on_drop(true);
    let output = tokio::time::timeout(PLUGIN_OPERATION_TIMEOUT, command.output())
        .await
        .map_err(|_| "dsh plugin 超时并已终止".to_string())?
        .map_err(|error| format!("启动 dsh plugin 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("dsh plugin 退出码为 {}", output.status)))
}

fn normalize_provider_id(id: &str) -> Result<String, String> {
    let id = id.trim().to_ascii_lowercase();
    if id == OFFICIAL_PROVIDER_ID {
        return Ok(id);
    }
    if id.is_empty()
        || !id.chars().next().is_some_and(|ch| ch.is_ascii_lowercase())
        || !id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err("Provider ID 只能使用小写字母、数字和连字符，并以字母开头".to_string());
    }
    if id.len() > 64 {
        return Err("Provider ID 过长".to_string());
    }
    Ok(id)
}

fn provider_kind(id: &str) -> DshProviderKind {
    if id == OFFICIAL_PROVIDER_ID {
        DshProviderKind::Official
    } else if CATALOG_PROVIDERS.iter().any(|(catalog, ..)| *catalog == id) {
        DshProviderKind::Catalog
    } else {
        DshProviderKind::Custom
    }
}

fn api_key_env_for(id: &str, _request: &DshProviderSaveRequest) -> String {
    if id == OFFICIAL_PROVIDER_ID {
        return OFFICIAL_API_KEY_ENV.to_string();
    }
    catalog_env(id).unwrap_or_else(|| default_custom_env(id))
}

fn catalog_env(id: &str) -> Option<String> {
    CATALOG_PROVIDERS
        .iter()
        .find(|(catalog, ..)| *catalog == id)
        .map(|(_, _, env)| (*env).to_string())
}

fn catalog_name(id: &str) -> Option<String> {
    CATALOG_PROVIDERS
        .iter()
        .find(|(catalog, ..)| *catalog == id)
        .map(|(_, name, _)| (*name).to_string())
}

fn default_custom_env(id: &str) -> String {
    format!("{}_API_KEY", id.to_ascii_uppercase().replace('-', "_"))
}

fn credential_present(credentials: &serde_yaml::Mapping, env_name: &str) -> bool {
    credentials
        .get(Value::String(env_name.to_string()))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn validate_secret(value: &str) -> Result<(), String> {
    if value.contains(['\n', '\r', '\0']) {
        return Err("API Key 不能包含换行或空字符".to_string());
    }
    if value.len() > 16 * 1024 {
        return Err("API Key 过长".to_string());
    }
    Ok(())
}

fn validate_http_url(value: &str) -> Result<(), String> {
    let parsed = url::Url::parse(value).map_err(|_| "Base URL 无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Base URL 必须是 http 或 https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Base URL 缺少主机名".to_string());
    }
    Ok(())
}

fn normalize_models_url(base_url: &str) -> Result<String, String> {
    validate_http_url(base_url)?;
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/models") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/models"))
    }
}

fn validate_plugin_spec(spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("插件规格不能为空".to_string());
    }
    if spec
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '`' | '$' | '\n' | '\r'))
    {
        return Err("插件规格包含非法字符".to_string());
    }
    if spec.starts_with("github:") {
        let rest = spec.trim_start_matches("github:");
        if rest.split('/').count() != 2 || rest.contains("..") {
            return Err("GitHub 插件规格无效".to_string());
        }
        return Ok(spec.to_string());
    }
    validate_plugin_name(spec)
}

fn validate_plugin_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let package = package_name(name);
    if package.starts_with('.')
        || package.contains("..")
        || (package.contains('/') && !package.starts_with('@'))
    {
        return Err("插件名无效".to_string());
    }
    let scoped = package.starts_with('@') && package.matches('/').count() == 1;
    let plain = !package.starts_with('@') && !package.contains('/');
    if !(scoped || plain)
        || !package
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '@' | '/' | '-' | '_' | '.'))
    {
        return Err("插件名无效".to_string());
    }
    Ok(name.to_string())
}

fn package_name(spec: &str) -> &str {
    if spec.starts_with('@') {
        spec.rsplit_once('@')
            .filter(|(package, _)| package.starts_with('@') && package.contains('/'))
            .map(|(package, _)| package)
            .unwrap_or(spec)
    } else {
        spec.split_once('@')
            .map(|(package, _)| package)
            .unwrap_or(spec)
    }
}

fn expand_home(user_home: &Path, value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        return user_home.join(rest);
    }
    if value == "~" {
        return user_home.to_path_buf();
    }
    PathBuf::from(value)
}

fn read_yaml_mapping(path: &Path) -> Result<serde_yaml::Mapping, String> {
    Ok(read_yaml_state(path)?.0)
}

fn read_yaml_state(path: &Path) -> Result<(serde_yaml::Mapping, Option<Vec<u8>>), String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_yaml::from_slice(&bytes)
                .map_err(|error| format!("解析 {} 失败：{error}", path.display()))?;
            match value {
                Value::Mapping(mapping) => Ok((mapping, Some(bytes))),
                Value::Null => Ok((serde_yaml::Mapping::new(), Some(bytes))),
                _ => Err(format!("{} 顶层必须是 YAML 对象", path.display())),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((serde_yaml::Mapping::new(), None))
        }
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

fn mapping_entry<'a>(
    parent: &'a mut serde_yaml::Mapping,
    key: &str,
) -> &'a mut serde_yaml::Mapping {
    if !parent
        .get(Value::String(key.into()))
        .is_some_and(Value::is_mapping)
    {
        parent.insert(
            Value::String(key.into()),
            Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    parent
        .get_mut(Value::String(key.into()))
        .and_then(Value::as_mapping_mut)
        .expect("mapping just inserted")
}

fn yaml_mutation(
    path: &Path,
    expected: Option<Vec<u8>>,
    value: &serde_yaml::Mapping,
    sensitive: bool,
) -> Result<NativeFileMutation, String> {
    Ok(NativeFileMutation {
        path: path.to_path_buf(),
        expected,
        replacement: Some(
            serde_yaml::to_string(&Value::Mapping(value.clone()))
                .map_err(|error| format!("序列化 {} 失败：{error}", path.display()))?
                .into_bytes(),
        ),
        sensitive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_provider_is_always_present() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DshPaths {
            home: dir.path().to_path_buf(),
            settings: dir.path().join("settings.yaml"),
            credentials: dir.path().join(".credentials.yaml"),
            profile_dir: dir.path().join("profiles").join("default"),
        };
        let view = load_providers(&paths, None, None).unwrap();
        assert_eq!(view.providers.len(), 1);
        assert_eq!(view.providers[0].id, OFFICIAL_PROVIDER_ID);
        assert!(!view.providers[0].credential_present);
        assert_eq!(view.providers[0].models[0].id, DEFAULT_OFFICIAL_MODEL);
    }

    #[test]
    fn custom_provider_round_trip_preserves_unknown_settings() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DshPaths {
            home: dir.path().to_path_buf(),
            settings: dir.path().join("settings.yaml"),
            credentials: dir.path().join(".credentials.yaml"),
            profile_dir: dir.path().join("profiles").join("default"),
        };
        std::fs::write(&paths.settings, "keep: true\nllm-pi-ai:\n  providers: {}\n").unwrap();
        let request = DshProviderSaveRequest {
            id: "my-gateway".into(),
            display_name: Some("Gateway".into()),
            notes: Some("Company gateway".into()),
            api: Some("openai-completions".into()),
            base_url: Some("https://gateway.example/v1".into()),
            api_key: Some("sk-test".into()),
            models: vec![DshProviderModelView {
                id: "router-large".into(),
                name: Some("Router Large".into()),
            }],
            set_default: true,
            default_model: Some("router-large".into()),
        };
        let (view, mutations) = save_provider(&paths, request).unwrap();
        for mutation in &mutations {
            if let Some(bytes) = &mutation.replacement {
                std::fs::write(&mutation.path, bytes).unwrap();
            }
        }
        let saved = std::fs::read_to_string(&paths.settings).unwrap();
        assert!(saved.contains("keep: true"));
        assert!(saved.contains("my-gateway"));
        assert!(saved.contains("https://gateway.example/v1"));
        let gateway = view
            .providers
            .iter()
            .find(|provider| provider.id == "my-gateway")
            .unwrap();
        assert_eq!(gateway.kind, DshProviderKind::Custom);
        assert!(gateway.credential_present);
        assert_eq!(gateway.api_key_env, "MY_GATEWAY_API_KEY");
        let credentials = std::fs::read_to_string(&paths.credentials).unwrap();
        assert!(credentials.contains("sk-test"));
    }

    #[test]
    fn catalog_provider_uses_declared_credential_env() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DshPaths {
            home: dir.path().to_path_buf(),
            settings: dir.path().join("settings.yaml"),
            credentials: dir.path().join(".credentials.yaml"),
            profile_dir: dir.path().join("profiles").join("default"),
        };
        let request = DshProviderSaveRequest {
            id: "anthropic".into(),
            display_name: None,
            notes: None,
            api: None,
            base_url: None,
            api_key: Some("sk-ant".into()),
            models: Vec::new(),
            set_default: false,
            default_model: None,
        };
        let (view, mutations) = save_provider(&paths, request).unwrap();
        for mutation in &mutations {
            if let Some(bytes) = &mutation.replacement {
                std::fs::write(&mutation.path, bytes).unwrap();
            }
        }
        let anthropic = view
            .providers
            .iter()
            .find(|provider| provider.id == "anthropic")
            .unwrap();
        assert_eq!(anthropic.kind, DshProviderKind::Catalog);
        assert_eq!(anthropic.api_key_env, "ANTHROPIC_API_KEY");
        assert!(anthropic.credential_present);
    }

    #[test]
    fn delete_custom_provider_removes_dedicated_credential() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DshPaths {
            home: dir.path().to_path_buf(),
            settings: dir.path().join("settings.yaml"),
            credentials: dir.path().join(".credentials.yaml"),
            profile_dir: dir.path().join("profiles").join("default"),
        };
        std::fs::write(
            &paths.settings,
            "llm-pi-ai:\n  providers:\n    my-gateway:\n      apiKeyEnv: MY_GATEWAY_API_KEY\n      api: openai-completions\n      baseURL: https://gateway.example/v1\n      models:\n        - id: router-large\n",
        )
        .unwrap();
        std::fs::write(
            &paths.credentials,
            "DEEPSEEK_API_KEY: keep\nMY_GATEWAY_API_KEY: drop\n",
        )
        .unwrap();
        let (view, mutations) = delete_provider(&paths, "my-gateway").unwrap();
        for mutation in &mutations {
            if let Some(bytes) = &mutation.replacement {
                std::fs::write(&mutation.path, bytes).unwrap();
            }
        }
        assert!(
            view.providers
                .iter()
                .all(|provider| provider.id != "my-gateway")
        );
        let credentials = std::fs::read_to_string(&paths.credentials).unwrap();
        assert!(credentials.contains("DEEPSEEK_API_KEY"));
        assert!(!credentials.contains("MY_GATEWAY_API_KEY"));
    }

    #[test]
    fn rejects_deleting_official_provider() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DshPaths {
            home: dir.path().to_path_buf(),
            settings: dir.path().join("settings.yaml"),
            credentials: dir.path().join(".credentials.yaml"),
            profile_dir: dir.path().join("profiles").join("default"),
        };
        let error = delete_provider(&paths, "deepseek-official").unwrap_err();
        assert!(error.contains("官方"));
    }

    #[test]
    fn plugin_spec_accepts_npm_and_github() {
        assert!(validate_plugin_spec("@acme/dsh-weather").is_ok());
        assert!(validate_plugin_spec("dsh-weather@1.2.3").is_ok());
        assert!(validate_plugin_spec("github:acme/dsh-weather").is_ok());
        assert!(validate_plugin_spec("github:acme/dsh-weather#abc123").is_ok());
        assert!(validate_plugin_spec("../evil").is_err());
        assert!(validate_plugin_spec("dsh;rm -rf").is_err());
        assert_eq!(
            validate_plugin_name("@deepseek-ai/dsh-base").unwrap(),
            RESERVED_PLUGIN
        );
    }

    #[test]
    fn profile_bundles_are_projected() {
        let plugins = parse_profile_plugins(
            br#"{
              "dependencies": {
                "@deepseek-ai/dsh-base": "0.1.0-rc.6",
                "dsh-hello-plugin": "0.1.0"
              },
              "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
            }"#,
            "default",
        )
        .unwrap();
        assert_eq!(plugins.len(), 2);
        assert!(plugins[0].reserved);
        assert_eq!(plugins[0].source, "default");
        assert_eq!(plugins[1].name, "dsh-hello-plugin");
        assert_eq!(plugins[1].version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn plugin_list_reads_all_profiles_and_home_patch() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let demo = home.join("profiles").join("demo");
        std::fs::create_dir_all(&demo).unwrap();
        std::fs::write(
            demo.join("package.json"),
            r#"{"dependencies":{"dsh-hello-plugin":"0.1.0"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-hello-plugin"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join("cordis.patch.yml"),
            "- insert:\n    - id: weather\n      name: dsh-weather\n",
        )
        .unwrap();
        let view = load_plugins(&DshPaths {
            home: home.to_path_buf(),
            settings: home.join("settings.yaml"),
            credentials: home.join(".credentials.yaml"),
            profile_dir: home.join("profiles").join("default"),
        })
        .unwrap();
        let names = view
            .plugins
            .iter()
            .map(|plugin| plugin.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"@deepseek-ai/dsh-base"));
        assert!(names.contains(&"dsh-hello-plugin"));
        assert!(names.contains(&"dsh-weather"));
    }

    #[test]
    fn plugin_list_does_not_include_skills() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let skill = home.join("skills").join("vibex-workflow-creator");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: vibex-workflow-creator\ndescription: Create VibeX workflows\n---\n# Skill\n",
        )
        .unwrap();
        let demo = home.join("profiles").join("default");
        std::fs::create_dir_all(&demo).unwrap();
        std::fs::write(
            demo.join("package.json"),
            r#"{"dependencies":{"@deepseek-ai/dsh-base":"0.1.0-rc.6","dsh-hello-plugin":"0.1.0"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-hello-plugin"]}}}"#,
        )
        .unwrap();
        let view = load_plugins(&DshPaths {
            home: home.to_path_buf(),
            settings: home.join("settings.yaml"),
            credentials: home.join(".credentials.yaml"),
            profile_dir: demo,
        })
        .unwrap();
        let names = view
            .plugins
            .iter()
            .map(|plugin| plugin.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"@deepseek-ai/dsh-base"));
        assert!(names.contains(&"dsh-hello-plugin"));
        assert!(!names.contains(&"vibex-workflow-creator"));
        assert!(
            view.plugins
                .iter()
                .all(|plugin| plugin.kind == DshExtensionKind::Plugin)
        );
    }

    #[test]
    fn custom_default_provider_projects_official_acp_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DshPaths {
            home: dir.path().to_path_buf(),
            settings: dir.path().join("settings.yaml"),
            credentials: dir.path().join(".credentials.yaml"),
            profile_dir: dir.path().join("profiles").join("default"),
        };
        let request = DshProviderSaveRequest {
            id: "opencode-go".into(),
            display_name: Some("OpenCode Go".into()),
            notes: None,
            api: Some("openai-completions".into()),
            base_url: Some("https://opencode.ai/zen/go/v1".into()),
            api_key: Some("sk-go".into()),
            models: vec![DshProviderModelView {
                id: "kimi-k3".into(),
                name: None,
            }],
            set_default: true,
            default_model: Some("kimi-k3".into()),
        };
        let (_, mutations) = save_provider(&paths, request).unwrap();
        for mutation in &mutations {
            if let Some(bytes) = &mutation.replacement {
                std::fs::write(&mutation.path, bytes).unwrap();
            }
        }
        assert!(any_credential_present(&paths));
        assert_eq!(inferred_auth_mode(&paths, None), "custom");
        let credentials = std::fs::read_to_string(&paths.credentials).unwrap();
        assert!(credentials.contains("DEEPSEEK_API_KEY"));
        assert!(credentials.contains("OPENCODE_GO_API_KEY"));
        let settings = std::fs::read_to_string(&paths.settings).unwrap();
        assert!(settings.contains("https://opencode.ai/zen/go/v1"));
        let view = load_providers(&paths, Some("opencode-go"), Some("kimi-k3")).unwrap();
        let official = view
            .providers
            .iter()
            .find(|provider| provider.id == OFFICIAL_PROVIDER_ID)
            .unwrap();
        assert_eq!(
            official.base_url.as_deref(),
            Some("https://opencode.ai/zen/go/v1")
        );
    }
}
