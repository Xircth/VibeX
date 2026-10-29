use std::{collections::HashSet, path::Path};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{AgentId, AgentModelProvidersView};
use serde_json::{Map, Value};

use super::common::*;
use crate::host::native::{model_provider_import::ImportDraft, read_json_object_or_empty};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct NativePiProvider {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) api_url: String,
    pub(super) model: String,
    pub(super) api_key: String,
    pub(super) credential_present: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct NativePiState {
    pub(super) providers: Vec<NativePiProvider>,
    pub(super) active_provider: Option<String>,
}

pub(super) fn project_with_pi_native(
    store: &ProviderStore,
    agent_id: AgentId,
    native: Option<&NativePiState>,
) -> AgentModelProvidersView {
    let mut view = project(store, agent_id);
    let Some(native) = native else {
        return view;
    };
    if view.bound_provider_id.is_some() {
        return view;
    }
    apply_native_active_binding(
        &mut view,
        native.active_provider.as_deref(),
        native
            .providers
            .iter()
            .map(|provider| (provider.id.as_str(), provider.api_url.as_str())),
        None,
    );
    view
}

pub(super) fn pi_native_drafts(native: Option<&NativePiState>) -> Vec<NativeProviderDraft> {
    let Some(native) = native else {
        return Vec::new();
    };
    native
        .providers
        .iter()
        .filter(|provider| !provider.api_url.is_empty())
        .map(|provider| NativeProviderDraft {
            id: provider.id.clone(),
            name: provider.name.clone(),
            api_url: provider.api_url.clone(),
            api_key: provider.api_key.clone(),
            model: provider.model.clone(),
        })
        .collect()
}

pub(super) async fn read_native_pi_state(
    pi_home: &Path,
) -> Result<NativePiState, crate::host::native::NativeError> {
    let models = read_json_object_or_empty(&pi_home.join("models.json")).await?;
    let auth = read_json_object_or_empty(&pi_home.join("auth.json")).await?;
    let settings = read_json_object_or_empty(&pi_home.join("settings.json")).await?;
    let active_provider = settings
        .get("defaultProvider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let default_model = settings
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let default_thinking_level = settings.get("defaultThinkingLevel").and_then(Value::as_str);
    let mut providers = Vec::new();
    let mut seen = HashSet::new();
    if let Some(entries) = models.get("providers").and_then(Value::as_object) {
        for (id, provider) in entries {
            let Some(object) = provider.as_object() else {
                continue;
            };
            let api_url = object
                .get("baseUrl")
                .or_else(|| object.get("base_url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let model = pi_native_model_payload(
                id,
                object,
                active_provider.as_deref().unwrap_or(""),
                default_model,
                default_thinking_level,
            );
            let api_key = pi_provider_key(&auth, id, Some(provider));
            let credential_present = !api_key.is_empty();
            seen.insert(id.clone());
            providers.push(NativePiProvider {
                name: id.clone(),
                id: id.clone(),
                api_url,
                model,
                api_key,
                credential_present,
            });
        }
    }
    if let Some(auth_entries) = auth.as_object() {
        for (id, entry) in auth_entries {
            if seen.contains(id) {
                continue;
            }
            let api_key = pi_auth_key(entry);
            if api_key.is_empty() {
                continue;
            }
            seen.insert(id.clone());
            providers.push(NativePiProvider {
                name: id.clone(),
                id: id.clone(),
                api_url: String::new(),
                model: if active_provider.as_deref() == Some(id.as_str()) {
                    default_model.to_string()
                } else {
                    String::new()
                },
                api_key,
                credential_present: true,
            });
        }
    }
    if let Some(active) = active_provider.as_deref()
        && !seen.contains(active)
    {
        providers.push(NativePiProvider {
            id: active.to_string(),
            name: active.to_string(),
            api_url: String::new(),
            model: default_model.to_string(),
            api_key: String::new(),
            credential_present: false,
        });
    }
    providers.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(NativePiState {
        providers,
        active_provider,
    })
}

pub(super) async fn native_pi_drafts(pi_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let models = read_json_object_or_empty(&pi_home.join("models.json")).await?;
    let auth = read_json_object_or_empty(&pi_home.join("auth.json")).await?;
    let settings = read_json_object_or_empty(&pi_home.join("settings.json")).await?;
    let default_provider = settings
        .get("defaultProvider")
        .and_then(Value::as_str)
        .unwrap_or("");
    let default_model = settings
        .get("defaultModel")
        .and_then(Value::as_str)
        .unwrap_or("");
    let default_thinking_level = settings.get("defaultThinkingLevel").and_then(Value::as_str);
    let Some(providers) = models.get("providers").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    Ok(providers
        .iter()
        .filter_map(|(id, provider)| {
            let object = provider.as_object()?;
            let api_url = object
                .get("baseUrl")
                .or_else(|| object.get("base_url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if api_url.is_empty() {
                return None;
            }
            let api_key = pi_provider_key(&auth, id, Some(provider));
            Some(ImportDraft {
                source_id: format!("native:{id}"),
                name: id.clone(),
                api_url,
                api_key,
                model: pi_native_model_payload(
                    id,
                    object,
                    default_provider,
                    default_model,
                    default_thinking_level,
                ),
                skip_reason: None,
            })
        })
        .collect())
}

pub(super) async fn apply_pi(
    pi_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let settings_path = pi_home.join("settings.json");
    let models_path = pi_home.join("models.json");
    let auth_path = pi_home.join("auth.json");
    let filesystem = TokioNativeFileSystem;
    let settings_original = filesystem.read(&settings_path).await?;
    let models_original = filesystem.read(&models_path).await?;
    let auth_original = filesystem.read(&auth_path).await?;
    let mut settings = parse_json_object_bytes(&settings_path, settings_original.as_deref())?;
    let mut models = parse_json_object_bytes(&models_path, models_original.as_deref())?;
    let mut auth = parse_json_object_bytes(&auth_path, auth_original.as_deref())?;
    let native_id = pi_native_id(provider);
    let selected = provider_model_ids(&provider.model);
    let model_id = selected
        .first()
        .cloned()
        .unwrap_or_else(|| pi_model_id(&provider.model));
    let api = pi_wire_api(&provider.model);
    insert_string(
        settings.as_object_mut().expect("object"),
        "defaultProvider",
        &native_id,
    );
    insert_string(
        settings.as_object_mut().expect("object"),
        "defaultModel",
        &model_id,
    );
    apply_pi_thinking_level(settings.as_object_mut().expect("object"), &provider.model);
    let providers = object_entry(models.as_object_mut().expect("object"), "providers")?;
    let api_key = provider.api_key.trim();
    let auth = auth.as_object_mut().expect("object");
    if api_key.is_empty() {
        // A present-but-empty entry is not "no credential" to pi: it shadows the
        // provider's inline `apiKey`, so leaving one behind silently disables a
        // provider that pi can otherwise reach. VibeX never writes an empty key,
        // so this only ever clears one left by an earlier keyless save.
        if auth.get(&native_id).is_some_and(is_empty_pi_api_key_entry) {
            auth.remove(&native_id);
        }
    } else {
        auth.insert(
            native_id.clone(),
            serde_json::json!({
                "type": "api_key",
                "key": api_key
            }),
        );
    }
    // Merge into the existing node rather than replacing it. `models.json`
    // carries fields VibeX has no UI for and does not own — cc-switch writes the
    // key inline as `apiKey`, and users hand-tune `name` / `headers` / `compat`.
    // Replacing the node would drop them on every save.
    let node = providers
        .entry(native_id)
        .or_insert_with(|| Value::Object(Map::new()));
    if !node.is_object() {
        *node = Value::Object(Map::new());
    }
    let node = node.as_object_mut().expect("object");
    node.insert(
        "baseUrl".to_string(),
        Value::String(provider.api_url.clone()),
    );
    node.insert("api".to_string(), Value::String(api.to_string()));
    let native_models = pi_projected_models(node.get("models"), provider, &model_id);
    node.insert("models".to_string(), native_models);
    // Pi treats a models.json provider as unconfigured unless auth.json is
    // already loaded *or* this field names an environment variable that is
    // present at process start. Bind writes the secret to auth.json; launch
    // exports it as PI_API_KEY. Do not replace an inline key another tool owns.
    let has_api_key = node
        .get("apiKey")
        .or_else(|| node.get("api_key"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if !has_api_key {
        node.insert(
            "apiKey".to_string(),
            Value::String("$PI_API_KEY".to_string()),
        );
    }
    apply_projection_mutations(&[
        NativeFileMutation {
            path: settings_path,
            expected: settings_original,
            replacement: Some(
                serde_json::to_vec_pretty(&settings)
                    .map_err(|error| format!("序列化 Pi settings.json 失败：{error}"))?,
            ),
            sensitive: false,
        },
        NativeFileMutation {
            path: models_path,
            expected: models_original,
            replacement: Some(
                serde_json::to_vec_pretty(&models)
                    .map_err(|error| format!("序列化 Pi models.json 失败：{error}"))?,
            ),
            sensitive: false,
        },
        NativeFileMutation {
            path: auth_path,
            expected: auth_original,
            replacement: Some(
                serde_json::to_vec_pretty(&auth)
                    .map_err(|error| format!("序列化 Pi auth.json 失败：{error}"))?,
            ),
            sensitive: true,
        },
    ])
    .await
}

pub(super) async fn remove_native_pi_provider(
    pi_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let models_path = pi_home.join("models.json");
    let auth_path = pi_home.join("auth.json");
    let filesystem = TokioNativeFileSystem;
    let models_original = filesystem.read(&models_path).await?;
    let auth_original = filesystem.read(&auth_path).await?;
    let mut models = parse_json_object_bytes(&models_path, models_original.as_deref())?;
    let mut auth = parse_json_object_bytes(&auth_path, auth_original.as_deref())?;
    let slug = pi_native_id(provider);
    let ids = [provider.id.as_str(), slug.as_str()];
    let mut changed = false;
    if let Some(entries) = models.get_mut("providers").and_then(Value::as_object_mut) {
        for id in ids {
            if entries.remove(id).is_some() {
                changed = true;
            }
        }
        if entries.is_empty() {
            models.as_object_mut().expect("object").remove("providers");
        }
    }
    if let Some(entries) = auth.as_object_mut() {
        for id in ids {
            if entries.remove(id).is_some() {
                changed = true;
            }
        }
    }
    if !changed {
        return Ok(());
    }
    apply_projection_mutations(&[
        NativeFileMutation {
            path: models_path,
            expected: models_original,
            replacement: Some(
                serde_json::to_vec_pretty(&models)
                    .map_err(|error| format!("序列化 Pi models.json 失败：{error}"))?,
            ),
            sensitive: false,
        },
        NativeFileMutation {
            path: auth_path,
            expected: auth_original,
            replacement: Some(
                serde_json::to_vec_pretty(&auth)
                    .map_err(|error| format!("序列化 Pi auth.json 失败：{error}"))?,
            ),
            sensitive: true,
        },
    ])
    .await
}

#[rustfmt::skip]
pub(super) const PI_RESERVED_PROVIDER_IDS: &[&str] = &[
    "anthropic", "openai", "google", "openrouter", "vercel-ai-gateway", "xai",
    "deepseek", "groq", "cerebras", "mistral", "nvidia", "together", "fireworks",
    "huggingface", "kimi-coding", "moonshotai", "moonshotai-cn", "zai",
    "zai-coding-cn", "minimax", "minimax-cn", "ant-ling", "xiaomi",
    "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
    "opencode", "opencode-go",
];

pub(super) fn pi_auth_key(entry: &Value) -> String {
    ["key", "apiKey", "api_key"]
        .iter()
        .find_map(|name| {
            entry
                .get(*name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// The API key pi itself would use for one provider node.
///
/// pi resolves credentials as `--api-key` -> `auth.json` -> environment -> the
/// provider node's inline `apiKey` in `models.json`. VibeX only sees the two
/// file-backed slots, so mirror them in that order. Reading `auth.json` alone
/// drops a working credential: cc-switch and hand-edited configs keep the key
/// inline in `models.json` and never write `auth.json` at all.
pub(super) fn pi_provider_key(auth: &Value, id: &str, provider: Option<&Value>) -> String {
    let stored = auth.get(id).map(pi_auth_key).unwrap_or_default();
    if !stored.is_empty() {
        return stored;
    }
    provider
        .map(|node| json_text(node, &["apiKey", "api_key"]))
        .unwrap_or_default()
}

/// Whether an `auth.json` entry is a credential slot holding no credential.
///
/// pi never writes one, and its resolver does not fall through a present-but-
/// empty entry to the provider's inline `apiKey`, so such an entry only ever
/// shadows a usable key. OAuth logins (`pi /login`) and any other shape belong
/// to pi and are never matched here.
pub(super) fn is_empty_pi_api_key_entry(entry: &Value) -> bool {
    match entry {
        Value::Object(object) => {
            object
                .get("type")
                .and_then(Value::as_str)
                .is_none_or(|kind| kind == "api_key")
                && pi_auth_key(entry).is_empty()
        }
        Value::String(key) => key.trim().is_empty(),
        _ => false,
    }
}

pub(super) fn pi_native_id(provider: &StoredProvider) -> String {
    let mut slug = provider
        .name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "vibex-provider".to_string()
    } else if PI_RESERVED_PROVIDER_IDS.contains(&slug.as_str()) {
        format!("vibex-{slug}")
    } else {
        slug
    }
}

pub(super) const PI_THINKING_LEVELS: &[&str] =
    &["off", "minimal", "low", "medium", "high", "xhigh"];

pub(super) fn pi_model_id(raw: &str) -> String {
    match parse_model(raw) {
        Value::Object(object) => object
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(raw)
            .to_string(),
        Value::String(model) => model,
        _ => raw.to_string(),
    }
}

pub(super) fn apply_pi_thinking_level(settings: &mut Map<String, Value>, raw: &str) {
    let spec = match parse_model(raw) {
        Value::Object(object) => object,
        _ => {
            settings.remove("defaultThinkingLevel");
            return;
        }
    };
    if let Some(level) = spec
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if PI_THINKING_LEVELS.contains(&level) {
            settings.insert(
                "defaultThinkingLevel".to_string(),
                Value::String(level.to_string()),
            );
        }
        return;
    }
    match spec.get("reasoning") {
        Some(Value::Bool(true | false)) => {
            settings.insert(
                "defaultThinkingLevel".to_string(),
                Value::String("off".to_string()),
            );
        }
        _ => {
            settings.remove("defaultThinkingLevel");
        }
    }
}

pub(super) fn pi_projected_models(
    existing: Option<&Value>,
    provider: &StoredProvider,
    default_id: &str,
) -> Value {
    let selected = provider_model_ids(&provider.model);
    let ids = if selected.is_empty() {
        vec![default_id.to_string()]
    } else {
        selected
    };
    let mut existing_by_id = Map::new();
    if let Some(models) = existing.and_then(Value::as_array) {
        for entry in models {
            let Some(id) = entry
                .as_str()
                .or_else(|| entry.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let mut object = match entry {
                Value::Object(object) => object.clone(),
                _ => Map::new(),
            };
            object.insert("id".to_string(), Value::String(id.to_string()));
            existing_by_id.insert(id.to_string(), Value::Object(object));
        }
    }
    let spec = parse_model(&provider.model);
    Value::Array(
        ids.into_iter()
            .map(|id| {
                let mut object = existing_by_id
                    .remove(&id)
                    .and_then(|value| match value {
                        Value::Object(object) => Some(object),
                        _ => None,
                    })
                    .unwrap_or_else(|| {
                        let mut object = Map::new();
                        object.insert("id".to_string(), Value::String(id.clone()));
                        object.insert("name".to_string(), Value::String(provider.name.clone()));
                        object
                    });
                object.insert("id".to_string(), Value::String(id.clone()));
                if id == default_id {
                    apply_pi_model_reasoning(&mut object, &spec);
                }
                Value::Object(object)
            })
            .collect(),
    )
}

pub(super) fn pi_native_model_payload(
    provider_id: &str,
    object: &Map<String, Value>,
    default_provider: &str,
    default_model: &str,
    default_thinking_level: Option<&str>,
) -> String {
    // Every model the provider lists, not just the first. Keeping only one
    // here is what made an imported Pi provider come back with a single model
    // after the user had enabled several.
    let mut model_ids: Vec<String> = Vec::new();
    for entry in object
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        // pi writes `{ "id": .. }`; cc-switch and hand-edits write the bare id.
        let candidate = entry
            .as_str()
            .or_else(|| entry.get("id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some(candidate) = candidate
            && !model_ids.iter().any(|seen| seen == candidate)
        {
            model_ids.push(candidate.to_string());
        }
    }
    // pi starts sessions on `defaultModel`, so it has to lead the list:
    // `apply_pi` reads the first entry back as the default, and without this a
    // re-apply would silently move the user off their model.
    if default_provider == provider_id
        && let Some(position) = model_ids.iter().position(|model| model == default_model)
    {
        let default = model_ids.remove(position);
        model_ids.insert(0, default);
    }
    let model_id = model_ids.first().cloned().unwrap_or_else(|| {
        if default_provider == provider_id {
            default_model.to_string()
        } else {
            String::new()
        }
    });
    let api = object
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-responses");
    let mut model = serde_json::json!({ "id": model_id, "api": api });
    if !model_ids.is_empty() {
        model["models"] = serde_json::json!(model_ids);
    }
    if let Some(entry) = object
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(model_id.as_str()))
    {
        if let Some(reasoning) = entry.get("reasoning") {
            model["reasoning"] = reasoning.clone();
        }
        if let Some(map) = entry.get("thinkingLevelMap") {
            model["thinkingLevelMap"] = map.clone();
        }
    }
    if default_provider == provider_id
        && let Some(level) = default_thinking_level
    {
        model["thinkingLevel"] = Value::String(level.to_string());
    }
    model.to_string()
}

pub(super) fn apply_pi_model_reasoning(model: &mut Map<String, Value>, spec: &Value) {
    let Value::Object(spec) = spec else {
        return;
    };
    match spec.get("reasoning") {
        Some(Value::Bool(true)) => {
            model.insert("reasoning".to_string(), Value::Bool(true));
            match spec.get("thinkingLevelMap") {
                Some(Value::Object(map)) => {
                    model.insert("thinkingLevelMap".to_string(), Value::Object(map.clone()));
                }
                _ => {
                    model.remove("thinkingLevelMap");
                }
            }
        }
        Some(Value::Bool(false)) => {
            model.insert("reasoning".to_string(), Value::Bool(false));
            model.remove("thinkingLevelMap");
        }
        _ => {}
    }
}

pub(super) fn pi_wire_api(raw: &str) -> &'static str {
    let api = match parse_model(raw) {
        Value::Object(object) => object
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or("openai-responses")
            .to_string(),
        _ => "openai-responses".to_string(),
    };
    match api.as_str() {
        "openai-completions" => "openai-completions",
        "anthropic-messages" => "anthropic-messages",
        "google-generative-ai" => "google-generative-ai",
        _ => "openai-responses",
    }
}
