use std::sync::OnceLock;

use api_types::{
    OpenCodeProviderConnectRequest, OpenCodeProviderConnectionView,
    OpenCodeProviderConnectionsView, OpenCodeProviderModelRequest, OpenCodeProviderModelView,
};
use serde_json::Value;

pub fn apply_opencode_provider_connection(
    auth: &mut Value,
    config: &mut Value,
    request: &OpenCodeProviderConnectRequest,
) -> Result<(), String> {
    validate_opencode_provider_id(&request.provider_id)?;
    if !auth.is_object() || !config.is_object() {
        return Err("OpenCode auth.json 与 opencode.json 顶层必须是对象".to_string());
    }
    let submitted_api_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let credential_present = auth.get(&request.provider_id).is_some_and(|entry| {
        entry
            .get("key")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
            || entry.get("type").and_then(Value::as_str) == Some("oauth")
    });
    if submitted_api_key.is_none() && !credential_present {
        return Err("新 Provider 必须提供 API Key".to_string());
    }
    if let Some(api_key) = submitted_api_key {
        let auth_entry = auth
            .as_object_mut()
            .expect("object")
            .entry(request.provider_id.clone())
            .or_insert_with(|| serde_json::json!({}));
        if !auth_entry.is_object() {
            *auth_entry = serde_json::json!({});
        }
        let auth_entry = auth_entry.as_object_mut().expect("object");
        auth_entry.insert("type".to_string(), serde_json::json!("api"));
        auth_entry.insert("key".to_string(), serde_json::json!(api_key));
    }

    let has_provider_override = request
        .npm
        .as_deref()
        .is_some_and(|npm| !npm.trim().is_empty())
        || request
            .api
            .as_deref()
            .is_some_and(|api| !api.trim().is_empty())
        || request
            .base_url
            .as_deref()
            .is_some_and(|url| !url.trim().is_empty())
        || request
            .models
            .iter()
            .any(|model| !model.id.trim().is_empty());
    if !has_provider_override {
        set_opencode_provider_enabled(config, &request.provider_id, request.enabled)?;
        return Ok(());
    }

    let providers = config
        .as_object_mut()
        .expect("object")
        .entry("provider")
        .or_insert_with(|| serde_json::json!({}));
    let providers = providers
        .as_object_mut()
        .ok_or_else(|| "opencode.json 的 provider 必须是对象".to_string())?;
    let provider = providers
        .entry(request.provider_id.clone())
        .or_insert_with(|| serde_json::json!({}));
    let provider = provider
        .as_object_mut()
        .ok_or_else(|| format!("Provider `{}` 的配置必须是对象", request.provider_id))?;
    provider.insert(
        "name".to_string(),
        Value::String(if request.name.trim().is_empty() {
            request.provider_id.clone()
        } else {
            request.name.trim().to_string()
        }),
    );
    match request
        .npm
        .as_deref()
        .map(str::trim)
        .filter(|npm| !npm.is_empty())
    {
        Some(npm) => {
            provider.insert("npm".to_string(), Value::String(npm.to_string()));
        }
        None => {
            provider.remove("npm");
        }
    }
    match request
        .api
        .as_deref()
        .map(str::trim)
        .filter(|api| !api.is_empty())
    {
        Some(api) => {
            provider.insert("api".to_string(), Value::String(api.to_string()));
        }
        None => {
            provider.remove("api");
        }
    }
    let base_url = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty());
    if base_url.is_some() || provider.contains_key("options") {
        let options = provider
            .entry("options".to_string())
            .or_insert_with(|| serde_json::json!({}));
        let options = options
            .as_object_mut()
            .ok_or_else(|| format!("Provider `{}` 的 options 必须是对象", request.provider_id))?;
        match base_url {
            Some(base_url) => {
                options.insert("baseURL".to_string(), serde_json::json!(base_url));
            }
            None => {
                options.remove("baseURL");
            }
        }
        if options.is_empty() {
            provider.remove("options");
        }
    }
    let requested_models = normalize_opencode_provider_models(&request.models)?;
    let mut existing_models = match provider.remove("models") {
        Some(Value::Object(models)) => models,
        Some(_) => {
            return Err(format!(
                "Provider `{}` 的 models 必须是对象",
                request.provider_id
            ));
        }
        None => serde_json::Map::new(),
    };
    if !requested_models.is_empty() {
        let mut preserved_entries = Vec::with_capacity(requested_models.len());
        for model in &requested_models {
            let source_id = model.previous_id.as_deref().unwrap_or(&model.id);
            let entry = existing_models
                .remove(source_id)
                .or_else(|| existing_models.remove(&model.id));
            preserved_entries.push(entry);
        }
        let models = requested_models
            .into_iter()
            .zip(preserved_entries)
            .map(|(model, existing)| {
                let mut entry = match existing {
                    Some(Value::Object(entry)) => entry,
                    _ => serde_json::Map::new(),
                };
                entry.insert("name".to_string(), serde_json::json!(model.name));
                (model.id, Value::Object(entry))
            })
            .collect::<serde_json::Map<_, _>>();
        provider.insert("models".to_string(), Value::Object(models));
    } else {
        provider.remove("models");
    }
    set_opencode_provider_enabled(config, &request.provider_id, request.enabled)?;
    Ok(())
}

pub fn disconnect_opencode_provider(
    auth: &mut Value,
    config: &mut Value,
    provider_id: &str,
) -> Result<(), String> {
    validate_opencode_provider_id(provider_id)?;
    if let Some(object) = auth.as_object_mut() {
        object.remove(provider_id);
    }
    if let Some(providers) = config.get_mut("provider").and_then(Value::as_object_mut) {
        providers.remove(provider_id);
        if providers.is_empty() {
            config
                .as_object_mut()
                .map(|object| object.remove("provider"));
        }
    }
    remove_opencode_provider_state(config, provider_id);
    Ok(())
}

fn normalize_opencode_provider_models(
    models: &[OpenCodeProviderModelRequest],
) -> Result<Vec<OpenCodeProviderModelRequest>, String> {
    let mut ids = std::collections::BTreeSet::new();
    let mut normalized = Vec::with_capacity(models.len());
    for model in models {
        let id = model.id.trim();
        if id.is_empty() {
            return Err("模型 ID 不能为空".to_string());
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("模型 ID `{id}` 重复"));
        }
        let name = model.name.trim();
        normalized.push(OpenCodeProviderModelRequest {
            id: id.to_string(),
            name: if name.is_empty() { id } else { name }.to_string(),
            previous_id: model
                .previous_id
                .as_deref()
                .map(str::trim)
                .filter(|previous_id| !previous_id.is_empty())
                .map(str::to_string),
        });
    }
    Ok(normalized)
}

pub fn set_opencode_provider_enabled(
    config: &mut Value,
    provider_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| "opencode.json 顶层必须是对象".to_string())?;
    update_provider_id_array(object, "disabled_providers", provider_id, !enabled)?;
    if object
        .get("enabled_providers")
        .and_then(Value::as_array)
        .is_some_and(|values| !values.is_empty())
    {
        update_provider_id_array(object, "enabled_providers", provider_id, enabled)?;
    }
    Ok(())
}

pub fn remove_opencode_provider_state(config: &mut Value, provider_id: &str) {
    let Some(object) = config.as_object_mut() else {
        return;
    };
    for key in ["enabled_providers", "disabled_providers"] {
        if let Some(values) = object.get_mut(key).and_then(Value::as_array_mut) {
            values.retain(|value| value.as_str() != Some(provider_id));
            if values.is_empty() {
                object.remove(key);
            }
        }
    }
}

fn update_provider_id_array(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    provider_id: &str,
    present: bool,
) -> Result<(), String> {
    if !present && object.get(key).is_none() {
        return Ok(());
    }
    let values = object
        .entry(key.to_string())
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("opencode.json 的 {key} 必须是数组"))?;
    values.retain(|value| value.as_str() != Some(provider_id));
    if present {
        values.push(Value::String(provider_id.to_string()));
    } else if values.is_empty() {
        object.remove(key);
    }
    Ok(())
}

pub fn validate_opencode_provider_id(provider_id: &str) -> Result<(), String> {
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    let pattern =
        ID.get_or_init(|| regex::Regex::new(r"^[a-z0-9][a-z0-9._-]*$").expect("provider id regex"));
    if pattern.is_match(provider_id) {
        Ok(())
    } else {
        Err("Provider ID 只能包含小写字母、数字、点、短横线和下划线".to_string())
    }
}

pub fn slug_provider_id(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "imported".to_string()
    } else {
        slug
    }
}

pub fn provider_exists(auth: &Value, config: &Value, provider_id: &str) -> bool {
    auth.get(provider_id).is_some()
        || config
            .get("provider")
            .and_then(|providers| providers.get(provider_id))
            .is_some()
}

pub fn project_opencode_provider_connections(
    auth: &Value,
    config: &Value,
) -> OpenCodeProviderConnectionsView {
    let mut ids = std::collections::BTreeSet::new();
    ids.extend(
        auth.as_object()
            .into_iter()
            .flat_map(|object| object.keys().cloned()),
    );
    ids.extend(
        config
            .get("provider")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|object| object.keys().cloned()),
    );
    let providers = ids
        .into_iter()
        .map(|provider_id| {
            let definition = config
                .get("provider")
                .and_then(|value| value.get(&provider_id));
            let credential_present = auth.get(&provider_id).is_some_and(|entry| {
                entry
                    .get("key")
                    .and_then(Value::as_str)
                    .is_some_and(|key| !key.trim().is_empty())
                    || entry.get("type").and_then(Value::as_str) == Some("oauth")
            });
            let disabled = config
                .get("disabled_providers")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| value.as_str() == Some(&provider_id))
                });
            let enabled_allowlist = config.get("enabled_providers").and_then(Value::as_array);
            let enabled = !disabled
                && enabled_allowlist.is_none_or(|values| {
                    values.is_empty()
                        || values
                            .iter()
                            .any(|value| value.as_str() == Some(&provider_id))
                });
            OpenCodeProviderConnectionView {
                name: definition
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(&provider_id)
                    .to_string(),
                npm: definition
                    .and_then(|value| value.get("npm"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                api: definition
                    .and_then(|value| value.get("api"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                base_url: definition
                    .and_then(|value| value.get("options"))
                    .and_then(|value| value.get("baseURL"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                models: definition
                    .and_then(|value| value.get("models"))
                    .and_then(Value::as_object)
                    .map(|models| {
                        models
                            .iter()
                            .map(|(id, model)| OpenCodeProviderModelView {
                                id: id.clone(),
                                name: model
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or(id)
                                    .to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                provider_id,
                credential_present,
                enabled,
            }
        })
        .collect();
    OpenCodeProviderConnectionsView { providers }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_provider_connection_updates_auth_and_config_documents() {
        let mut auth = serde_json::json!({
            "my-openai": {"refresh": "preserve"}
        });
        let mut config = serde_json::json!({
            "model": "openai/gpt-5",
            "provider": {
                "my-openai": {
                    "unknown": true,
                    "options": {"timeout": 30},
                    "models": {"gpt-5": {"name": "Custom GPT", "contextWindow": 9000}}
                }
            }
        });
        apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "my-openai".to_string(),
                name: "My OpenAI".to_string(),
                npm: Some("@ai-sdk/openai-compatible".to_string()),
                api: Some("openai.responses".to_string()),
                base_url: Some("https://example.test/v1".to_string()),
                api_key: Some("secret".to_string()),
                models: vec![
                    OpenCodeProviderModelRequest {
                        id: "gpt-5".to_string(),
                        name: "Renamed GPT".to_string(),
                        previous_id: None,
                    },
                    OpenCodeProviderModelRequest {
                        id: "gpt-5-mini".to_string(),
                        name: "GPT 5 Mini".to_string(),
                        previous_id: None,
                    },
                ],
                enabled: true,
            },
        )
        .unwrap();

        assert_eq!(auth["my-openai"]["type"], "api");
        assert_eq!(auth["my-openai"]["key"], "secret");
        assert_eq!(auth["my-openai"]["refresh"], "preserve");
        assert_eq!(
            config["provider"]["my-openai"]["options"]["baseURL"],
            "https://example.test/v1"
        );
        assert_eq!(config["model"], "openai/gpt-5");
        assert_eq!(config["provider"]["my-openai"]["api"], "openai.responses");
        assert!(config["provider"]["my-openai"]["models"]["gpt-5"].is_object());
        assert_eq!(config["provider"]["my-openai"]["unknown"], true);
        assert_eq!(config["provider"]["my-openai"]["options"]["timeout"], 30);
        assert_eq!(
            config["provider"]["my-openai"]["models"]["gpt-5"]["contextWindow"],
            9000
        );
        assert_eq!(
            config["provider"]["my-openai"]["models"]["gpt-5"]["name"],
            "Renamed GPT"
        );
    }

    #[test]
    fn opencode_builtin_connection_does_not_delete_existing_provider_options() {
        let mut auth = serde_json::json!({});
        let mut config = serde_json::json!({
            "provider": {"openai": {"options": {"timeout": 30}, "unknown": true}}
        });

        apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "openai".to_string(),
                name: "OpenAI".to_string(),
                npm: None,
                api: None,
                base_url: None,
                api_key: Some("secret".to_string()),
                models: Vec::new(),
                enabled: true,
            },
        )
        .unwrap();

        assert_eq!(config["provider"]["openai"]["options"]["timeout"], 30);
        assert_eq!(config["provider"]["openai"]["unknown"], true);
    }

    #[test]
    fn opencode_provider_edit_preserves_credential_and_renamed_model_extensions() {
        let mut auth = serde_json::json!({
            "my-openai": {"type": "api", "key": "keep-secret", "refresh": "keep"}
        });
        let mut config = serde_json::json!({
            "provider": {
                "my-openai": {
                    "models": {
                        "old-id": {"name": "Old name", "contextWindow": 42}
                    }
                }
            }
        });

        apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "my-openai".to_string(),
                name: "My OpenAI".to_string(),
                npm: Some("@ai-sdk/openai-compatible".to_string()),
                api: None,
                base_url: None,
                api_key: None,
                models: vec![OpenCodeProviderModelRequest {
                    id: "new-id".to_string(),
                    name: "New name".to_string(),
                    previous_id: Some("old-id".to_string()),
                }],
                enabled: true,
            },
        )
        .unwrap();

        assert_eq!(auth["my-openai"]["key"], "keep-secret");
        assert_eq!(auth["my-openai"]["refresh"], "keep");
        assert!(config["provider"]["my-openai"]["models"]["old-id"].is_null());
        assert_eq!(
            config["provider"]["my-openai"]["models"]["new-id"]["contextWindow"],
            42
        );
        assert_eq!(
            config["provider"]["my-openai"]["models"]["new-id"]["name"],
            "New name"
        );
    }

    #[test]
    fn opencode_new_provider_requires_a_credential() {
        let mut auth = serde_json::json!({});
        let mut config = serde_json::json!({});
        let error = apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "new-provider".to_string(),
                name: "New Provider".to_string(),
                npm: None,
                api: None,
                base_url: None,
                api_key: None,
                models: Vec::new(),
                enabled: true,
            },
        )
        .unwrap_err();

        assert!(error.contains("API Key"));
    }

    #[test]
    fn opencode_provider_enable_state_updates_both_supported_lists() {
        let auth = serde_json::json!({
            "openrouter": {"type": "api", "key": "secret"}
        });
        let mut config = serde_json::json!({
            "enabled_providers": ["anthropic", "openrouter"],
            "provider": {"openrouter": {"name": "OpenRouter"}}
        });

        set_opencode_provider_enabled(&mut config, "openrouter", false).unwrap();
        assert_eq!(
            config["enabled_providers"],
            serde_json::json!(["anthropic"])
        );
        assert_eq!(
            config["disabled_providers"],
            serde_json::json!(["openrouter"])
        );
        assert!(!project_opencode_provider_connections(&auth, &config).providers[0].enabled);

        set_opencode_provider_enabled(&mut config, "openrouter", true).unwrap();
        assert_eq!(
            config["enabled_providers"],
            serde_json::json!(["anthropic", "openrouter"])
        );
        assert!(config.get("disabled_providers").is_none());
        assert!(project_opencode_provider_connections(&auth, &config).providers[0].enabled);
    }

    #[test]
    fn disconnect_cleanup_removes_provider_from_enable_state() {
        let mut config = serde_json::json!({
            "enabled_providers": ["openrouter", "anthropic"],
            "disabled_providers": ["openrouter", "google"]
        });

        remove_opencode_provider_state(&mut config, "openrouter");

        assert_eq!(
            config["enabled_providers"],
            serde_json::json!(["anthropic"])
        );
        assert_eq!(config["disabled_providers"], serde_json::json!(["google"]));
    }
}
