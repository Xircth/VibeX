use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{AgentId, AgentModelProvidersView};
use serde_json::{Map, Value};

use super::common::*;
use crate::host::native::{model_provider_import::ImportDraft, read_json_object_or_empty};

#[derive(Debug, Clone, Default)]
pub(super) struct NativeOpenClawState {
    pub(super) providers: Vec<ImportDraft>,
    pub(super) primary_provider: Option<String>,
}

pub(super) async fn read_native_openclaw_state(
    openclaw_home: &Path,
) -> Result<NativeOpenClawState, String> {
    let document = read_json_object_or_empty(&openclaw_home.join("openclaw.json"))
        .await
        .map_err(|error| error.to_string())?;
    let primary_provider = document
        .pointer("/agents/defaults/model/primary")
        .and_then(Value::as_str)
        .and_then(|value| value.split('/').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let Some(providers) = document
        .pointer("/models/providers")
        .and_then(Value::as_object)
    else {
        return Ok(NativeOpenClawState {
            providers: Vec::new(),
            primary_provider,
        });
    };
    let drafts = providers
        .iter()
        .filter(|(id, _)| *id != "dimo")
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
            let api_key = object
                .get("apiKey")
                .or_else(|| object.get("api_key"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let model = object
                .get("models")
                .and_then(Value::as_array)
                .and_then(|models| {
                    models
                        .iter()
                        .find_map(|entry| entry.get("id").and_then(Value::as_str))
                })
                .unwrap_or("")
                .to_string();
            Some(ImportDraft {
                source_id: id.clone(),
                name: id.clone(),
                api_url,
                api_key,
                model,
                skip_reason: None,
            })
        })
        .collect();
    Ok(NativeOpenClawState {
        providers: drafts,
        primary_provider,
    })
}

pub(super) async fn native_openclaw_drafts(
    openclaw_home: &Path,
) -> Result<Vec<ImportDraft>, String> {
    Ok(read_native_openclaw_state(openclaw_home).await?.providers)
}

pub(super) fn project_with_openclaw_native(
    store: &ProviderStore,
    agent_id: AgentId,
    native: Option<&NativeOpenClawState>,
) -> AgentModelProvidersView {
    let mut view = project(store, agent_id);
    let Some(native) = native else {
        return view;
    };
    let mut primary_matched: Option<String> = None;
    for provider in &mut view.providers {
        let slug = openclaw_slug(&provider.name, &provider.id);
        let matched = native.providers.iter().find(|item| {
            item.source_id == provider.id
                || item.source_id == slug
                || (!item.api_url.is_empty() && item.api_url == provider.api_url)
        });
        let enabled = matched.is_some();
        provider.bound = enabled;
        if enabled
            && let Some(item) = matched
            && native.primary_provider.as_deref() == Some(item.source_id.as_str())
        {
            primary_matched = Some(provider.id.clone());
        }
    }
    view.bound_provider_id = primary_matched
        .or_else(|| {
            view.bound_provider_id
                .clone()
                .filter(|id| view.providers.iter().any(|p| p.id == *id && p.bound))
        })
        .or_else(|| {
            view.providers
                .iter()
                .find(|provider| provider.bound)
                .map(|provider| provider.id.clone())
        });
    view
}

pub(super) fn openclaw_slug(name: &str, id: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() || slug == "dimo" {
        let fallback = id
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
            .take(16)
            .collect::<String>()
            .to_ascii_lowercase();
        if fallback.is_empty() || fallback == "dimo" {
            "custom-provider".to_string()
        } else {
            fallback
        }
    } else {
        slug
    }
}

fn resolve_openclaw_key(providers: &Map<String, Value>, provider: &StoredProvider) -> String {
    if providers.contains_key(&provider.id) {
        return provider.id.clone();
    }
    let slug = openclaw_slug(&provider.name, &provider.id);
    if providers.contains_key(&slug) {
        return slug;
    }
    if let Some(existing) = providers.iter().find_map(|(key, value)| {
        if key == "dimo" {
            return None;
        }
        let url = value
            .as_object()
            .and_then(|obj| obj.get("baseUrl").or_else(|| obj.get("base_url")))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        (!provider.api_url.is_empty() && url == provider.api_url).then(|| key.clone())
    }) {
        return existing;
    }
    slug
}

pub(super) async fn apply_openclaw(
    openclaw_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = openclaw_home.join("openclaw.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut document = parse_json_object_bytes(&path, original.as_deref())?;
    let root = document.as_object_mut().expect("object");
    let key = {
        let models = object_entry(root, "models")?;
        models.insert("mode".to_string(), Value::String("merge".to_string()));
        let providers = object_entry(models, "providers")?;
        providers.remove("dimo");
        let key = resolve_openclaw_key(providers, provider);
        let mut entry = Map::new();
        entry.insert(
            "baseUrl".to_string(),
            Value::String(provider.api_url.clone()),
        );
        let api_key = provider.api_key.trim();
        if !api_key.is_empty() {
            entry.insert("apiKey".to_string(), Value::String(api_key.to_string()));
        }
        entry.insert(
            "api".to_string(),
            Value::String("openai-completions".to_string()),
        );
        entry.insert(
            "models".to_string(),
            Value::Array(
                provider_model_ids(&provider.model)
                    .into_iter()
                    .map(|id| serde_json::json!({ "id": id, "name": provider.name }))
                    .collect(),
            ),
        );
        providers.insert(key.clone(), Value::Object(entry));
        key
    };
    let agents = object_entry(root, "agents")?;
    let defaults = object_entry(agents, "defaults")?;
    let model = object_entry(defaults, "model")?;
    model.insert(
        "primary".to_string(),
        Value::String(format!("{key}/{}", model_default(&provider.model))),
    );
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("序列化 OpenClaw 配置失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}

pub(super) async fn remove_native_openclaw_provider(
    openclaw_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = openclaw_home.join("openclaw.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let Some(bytes) = original.as_deref() else {
        return Ok(());
    };
    let mut document = parse_json_object_bytes(&path, Some(bytes))?;
    let root = document.as_object_mut().expect("object");
    let slug = openclaw_slug(&provider.name, &provider.id);
    let mut removed_keys = vec![provider.id.clone(), slug];
    let mut changed = false;
    let mut next_primary: Option<String> = None;

    if let Some(providers) = root
        .get_mut("models")
        .and_then(Value::as_object_mut)
        .and_then(|models| models.get_mut("providers"))
        .and_then(Value::as_object_mut)
    {
        if let Some(url_key) = providers.iter().find_map(|(k, v)| {
            let url = v
                .as_object()
                .and_then(|o| o.get("baseUrl").or_else(|| o.get("base_url")))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            (!provider.api_url.is_empty() && url == provider.api_url).then(|| k.clone())
        }) && !removed_keys.contains(&url_key)
        {
            removed_keys.push(url_key);
        }
        for key in &removed_keys {
            if providers.remove(key).is_some() {
                changed = true;
            }
        }
        next_primary = providers.iter().find_map(|(k, v)| {
            let model_id = v
                .as_object()
                .and_then(|o| o.get("models"))
                .and_then(Value::as_array)
                .and_then(|arr| arr.first())
                .and_then(|m| m.get("id").and_then(Value::as_str).or_else(|| m.as_str()))
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            Some(format!("{k}/{model_id}"))
        });
    }
    if let Some(model) = root
        .get_mut("agents")
        .and_then(Value::as_object_mut)
        .and_then(|agents| agents.get_mut("defaults"))
        .and_then(Value::as_object_mut)
        .and_then(|defaults| defaults.get_mut("model"))
        .and_then(Value::as_object_mut)
        && let Some(primary) = model
            .get("primary")
            .and_then(Value::as_str)
            .map(str::to_string)
        && removed_keys
            .iter()
            .any(|key| primary.starts_with(&format!("{key}/")))
    {
        match next_primary {
            Some(replacement) => {
                model.insert("primary".to_string(), Value::String(replacement));
            }
            None => {
                model.remove("primary");
            }
        }
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("序列化 OpenClaw 配置失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}
