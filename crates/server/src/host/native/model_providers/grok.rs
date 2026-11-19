use std::{collections::HashSet, path::Path};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{AgentId, AgentModelProvidersView};
use serde_json::Value;

use super::common::*;
use crate::host::native::model_provider_import::ImportDraft;

/// Grok `config.toml` 的 Provider 状态。`[models] default` 与 `[model.*]` 是
/// 当前启用项的唯一真相源；Dimo 预设只在 default 指向 `dimo` 时才算启用。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeGrokProvider {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeGrokState {
    pub providers: Vec<NativeGrokProvider>,
    pub active_provider: Option<String>,
}

pub(super) const GROK_DEFAULT_BACKUP_KEY: &str = "models.default";
pub(super) const GROK_WEB_SEARCH_BACKUP_KEY: &str = "models.web_search";

pub(super) fn project_with_grok_native(
    store: &ProviderStore,
    agent_id: AgentId,
    native: Option<&NativeGrokState>,
) -> AgentModelProvidersView {
    let mut view = project(store, agent_id);
    let Some(native) = native else {
        return view;
    };
    // `models.default` is the enabled Provider. The `dimo` table is still a
    // real endpoint: skipping it left BeeAPI-style configs looking unbound
    // even while Grok was already routing through that table.
    let active_id = native.active_provider.as_deref();
    let active_url = native
        .providers
        .iter()
        .find(|provider| Some(provider.id.as_str()) == active_id)
        .map(|provider| provider.api_url.as_str())
        .filter(|url| !url.is_empty());
    let match_id = active_id.filter(|id| *id != "dimo");
    apply_native_active_binding(
        &mut view,
        match_id,
        native
            .providers
            .iter()
            .map(|provider| (provider.id.as_str(), provider.api_url.as_str())),
        active_url,
    );
    view
}

pub(super) fn grok_native_drafts(native: Option<&NativeGrokState>) -> Vec<NativeProviderDraft> {
    let Some(native) = native else {
        return Vec::new();
    };
    let grok = AgentId::parse("grok").expect("grok");
    native
        .providers
        .iter()
        .filter(|provider| {
            !provider.api_url.is_empty() && !is_official_endpoint(&grok, &provider.api_url)
        })
        .map(|provider| NativeProviderDraft {
            id: provider.id.clone(),
            name: provider.name.clone(),
            api_url: provider.api_url.clone(),
            api_key: provider.api_key.clone(),
            model: provider.model.clone(),
        })
        .collect()
}

pub(super) fn native_uses_dimo_grok_projection(native: Option<&NativeGrokState>) -> bool {
    native.is_some_and(|state| state.active_provider.as_deref() == Some("dimo"))
}

pub(super) fn is_native_grok_channel(
    provider: &StoredProvider,
    native: Option<&NativeGrokState>,
) -> bool {
    let Some(native) = native else {
        return false;
    };
    if is_dimo_grok_table(&provider.id) {
        return false;
    }
    native
        .providers
        .iter()
        .any(|candidate| candidate.id == provider.id && !is_dimo_grok_table(&candidate.id))
}

pub(super) async fn activate_native_grok_provider(
    grok_home: &Path,
    provider_id: &str,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let path = grok_home.join("config.toml");
    let original = filesystem.read(&path).await?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    let models = toml_table_entry(&mut table, "models")?;
    models.insert(
        "default".to_string(),
        toml::Value::String(provider_id.to_string()),
    );
    write_toml_mutation(&path, original, &table, false).await
}

pub(super) async fn remove_native_grok_provider(
    grok_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    if is_dimo_grok_table(&provider.id) {
        return Ok(());
    }
    let path = grok_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    let Some(models) = table.get_mut("model").and_then(toml::Value::as_table_mut) else {
        return Ok(());
    };
    let match_id = if models.contains_key(&provider.id) {
        Some(provider.id.clone())
    } else if provider.api_url.is_empty() {
        None
    } else {
        models.iter().find_map(|(id, value)| {
            if is_dimo_grok_table(id) {
                return None;
            }
            value
                .as_table()
                .and_then(|entry| entry.get("base_url"))
                .and_then(toml::Value::as_str)
                .filter(|url| *url == provider.api_url)
                .map(|_| id.clone())
        })
    };
    let Some(id) = match_id else {
        return Ok(());
    };
    models.remove(&id);
    if models.is_empty() {
        table.remove("model");
    }
    write_toml_mutation(&path, original, &table, true).await
}

pub(super) async fn clear_grok_subscription_auth(
    grok_home: &Path,
) -> Result<(), crate::host::native::NativeError> {
    let path = grok_home.join("auth.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let Some(bytes) = original.as_deref() else {
        return Ok(());
    };
    let trimmed = std::str::from_utf8(bytes).unwrap_or("").trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(());
    }
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(b"{}\n".to_vec()),
        sensitive: true,
    }])
    .await
}

pub async fn read_native_grok_state(
    grok_home: &Path,
) -> Result<NativeGrokState, crate::host::native::NativeError> {
    let table = match read_toml_table(&grok_home.join("config.toml")).await {
        Ok(table) => table,
        Err(_) => return Ok(NativeGrokState::default()),
    };
    Ok(native_grok_state_from_table(&table))
}

fn attach_grok_entry_model_fields(
    model: &mut Value,
    entry: &toml::Table,
    web_search_enabled: bool,
) {
    if let Some(supports_backend_search) = entry
        .get("supports_backend_search")
        .and_then(toml::Value::as_bool)
    {
        model["supports_backend_search"] = Value::Bool(supports_backend_search);
    }
    if let Some(max_retries) = entry.get("max_retries").and_then(toml::Value::as_integer) {
        model["max_retries"] = Value::from(max_retries);
    }
    if web_search_enabled {
        model["web_search"] = Value::Bool(true);
    }
}

pub(super) fn native_grok_state_from_table(table: &toml::Table) -> NativeGrokState {
    let Some(models) = table.get("model").and_then(toml::Value::as_table) else {
        return NativeGrokState {
            active_provider: grok_default_provider(table),
            ..NativeGrokState::default()
        };
    };
    let web_search_target = grok_models_entry_str(table, "web_search");
    let mut providers = Vec::new();
    let mut dimo_models: Vec<String> = Vec::new();
    let mut dimo_entry: Option<(&str, &toml::Table)> = None;
    for (id, value) in models {
        let Some(entry) = value.as_table() else {
            continue;
        };
        let api_url = entry
            .get("base_url")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let api_key = entry
            .get("api_key")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if api_url.is_empty() && api_key.is_empty() {
            continue;
        }
        let model_id = entry
            .get("model")
            .and_then(toml::Value::as_str)
            .unwrap_or(id)
            .to_string();
        if is_dimo_grok_table(id) {
            if id == "dimo" {
                dimo_models.insert(0, model_id);
                dimo_entry = Some((id.as_str(), entry));
            } else {
                dimo_models.push(model_id);
                dimo_entry.get_or_insert((id.as_str(), entry));
            }
            continue;
        }
        let backend = entry
            .get("api_backend")
            .and_then(toml::Value::as_str)
            .unwrap_or("responses");
        let context = entry
            .get("context_window")
            .and_then(toml::Value::as_integer);
        let mut model_json = serde_json::json!({
            "id": model_id,
            "api_backend": backend,
            "context_window": context
        });
        attach_grok_entry_model_fields(
            &mut model_json,
            entry,
            web_search_target.as_deref() == Some(id.as_str()),
        );
        providers.push(NativeGrokProvider {
            id: id.clone(),
            name: entry
                .get("name")
                .and_then(toml::Value::as_str)
                .unwrap_or(id)
                .to_string(),
            api_url,
            api_key,
            model: model_json.to_string(),
        });
    }
    if let Some((id, entry)) = dimo_entry {
        let primary = dimo_models.first().cloned().unwrap_or_default();
        let mut model = serde_json::json!({
            "id": primary,
            "api_backend": entry
                .get("api_backend")
                .and_then(toml::Value::as_str)
                .unwrap_or("responses"),
            "context_window": entry
                .get("context_window")
                .and_then(toml::Value::as_integer),
        });
        if !dimo_models.is_empty() {
            model["models"] = serde_json::json!(dimo_models);
        }
        attach_grok_entry_model_fields(
            &mut model,
            entry,
            web_search_target
                .as_deref()
                .is_some_and(is_dimo_grok_table),
        );
        providers.insert(
            0,
            NativeGrokProvider {
                id: if id == "dimo" {
                    "dimo".to_string()
                } else {
                    id.to_string()
                },
                name: entry
                    .get("name")
                    .and_then(toml::Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                api_url: entry
                    .get("base_url")
                    .and_then(toml::Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                api_key: entry
                    .get("api_key")
                    .and_then(toml::Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                model: model.to_string(),
            },
        );
    }
    let default = grok_default_provider(table);
    let active_provider = default
        .as_deref()
        .and_then(|id| {
            if is_dimo_grok_table(id) {
                return Some("dimo".to_string());
            }
            providers
                .iter()
                .any(|provider| provider.id == id)
                .then(|| id.to_string())
        })
        .or_else(|| {
            let only = providers.first()?;
            (default.is_none() && providers.len() == 1 && !is_dimo_grok_table(&only.id))
                .then(|| only.id.clone())
        });
    NativeGrokState {
        providers,
        active_provider,
    }
}

fn grok_models_entry_str(table: &toml::Table, key: &str) -> Option<String> {
    table
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get(key))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn grok_default_provider(table: &toml::Table) -> Option<String> {
    grok_models_entry_str(table, "default")
}

pub(super) async fn native_grok_drafts(grok_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let state = read_native_grok_state(grok_home).await?;
    Ok(state
        .providers
        .into_iter()
        .map(|provider| ImportDraft {
            source_id: format!("native:{}", provider.id),
            name: provider.name,
            api_url: provider.api_url,
            api_key: provider.api_key,
            model: provider.model,
            skip_reason: None,
        })
        .collect())
}

pub(super) async fn capture_grok_toml(
    path: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let table = match read_toml_table(path).await {
        Ok(table) => table,
        Err(_) => {
            backup
                .toml_values
                .insert(GROK_DEFAULT_BACKUP_KEY.to_string(), None);
            backup
                .toml_values
                .insert(GROK_WEB_SEARCH_BACKUP_KEY.to_string(), None);
            return Ok(());
        }
    };
    let models_table = table.get("models").and_then(toml::Value::as_table);
    backup.toml_values.insert(
        GROK_DEFAULT_BACKUP_KEY.to_string(),
        models_table.and_then(|models| models.get("default")).cloned(),
    );
    backup.toml_values.insert(
        GROK_WEB_SEARCH_BACKUP_KEY.to_string(),
        models_table
            .and_then(|models| models.get("web_search"))
            .cloned(),
    );
    Ok(())
}

fn restore_grok_models_entry(
    table: &mut toml::Table,
    backup: &ProviderProjectionBackup,
    backup_key: &str,
    toml_key: &str,
    custom_ids: &HashSet<String>,
) -> Result<(), crate::host::native::NativeError> {
    let restored = backup
        .toml_values
        .get(backup_key)
        .and_then(Option::as_ref)
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && !is_dimo_grok_table(value) && !custom_ids.contains(*value)
        });
    if let Some(value) = restored {
        let models = toml_table_entry(table, "models")?;
        models.insert(
            toml_key.to_string(),
            toml::Value::String(value.to_string()),
        );
    } else if let Some(models) = table.get_mut("models").and_then(toml::Value::as_table_mut) {
        let current = models
            .get(toml_key)
            .and_then(toml::Value::as_str)
            .unwrap_or("");
        if is_dimo_grok_table(current) || custom_ids.contains(current) {
            models.remove(toml_key);
        }
        if models.is_empty() {
            table.remove("models");
        }
    }
    Ok(())
}

pub(super) async fn restore_grok_projection(
    grok_home: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let path = grok_home.join("config.toml");
    let original = filesystem.read(&path).await?;
    if original.is_none()
        && !backup.toml_values.contains_key(GROK_DEFAULT_BACKUP_KEY)
        && !backup.toml_values.contains_key(GROK_WEB_SEARCH_BACKUP_KEY)
    {
        return Ok(());
    }
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    if let Some(models) = table.get_mut("model").and_then(toml::Value::as_table_mut) {
        models.retain(|name, _| !is_dimo_grok_table(name));
        if models.is_empty() {
            table.remove("model");
        }
    }
    let custom_ids: HashSet<String> = table
        .get("model")
        .and_then(toml::Value::as_table)
        .map(|models| {
            models
                .iter()
                .filter_map(|(id, value)| {
                    let url = value
                        .as_table()?
                        .get("base_url")
                        .and_then(toml::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let grok = AgentId::parse("grok").ok()?;
                    (!is_official_endpoint(&grok, url)).then(|| id.clone())
                })
                .collect()
        })
        .unwrap_or_default();
    restore_grok_models_entry(
        &mut table,
        backup,
        GROK_DEFAULT_BACKUP_KEY,
        "default",
        &custom_ids,
    )?;
    restore_grok_models_entry(
        &mut table,
        backup,
        GROK_WEB_SEARCH_BACKUP_KEY,
        "web_search",
        &custom_ids,
    )?;
    write_toml_mutation(&path, original, &table, true).await
}

/// How an optional Grok `config.toml` override field should be updated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum GrokFieldUpdate<T> {
    /// Key was absent in stored JSON — keep any hand-written TOML value intact.
    Unchanged,
    /// Explicitly configured — write this value to TOML.
    Set(T),
    /// Explicitly cleared (`null`) — remove from TOML.
    Clear,
}

/// One `[model.*]` table a grok provider projects.
pub(super) struct GrokModelSpec {
    /// Table name under `[model.*]`; `[models] default` refers to it by name.
    pub(super) table: String,
    /// Identifier sent to the API.
    pub(super) id: String,
    /// Label grok's model picker shows.
    pub(super) name: String,
}

/// Everything a provider's `model` field projects onto `config.toml`.
pub(super) struct GrokProviderSpec {
    pub(super) models: Vec<GrokModelSpec>,
    pub(super) api_backend: String,
    pub(super) context_window: Option<i64>,
    pub(super) supports_backend_search: GrokFieldUpdate<bool>,
    pub(super) max_retries: GrokFieldUpdate<i64>,
    pub(super) web_search: GrokFieldUpdate<String>,
}

/// Whether Dimo mints this `[model.*]` name. Only these get swept, so a table
/// the user added by hand never disappears.
pub(super) fn is_dimo_grok_table(name: &str) -> bool {
    name == "dimo" || name.starts_with("dimo-")
}

/// Table name for one model. The first keeps `dimo`, so an existing
/// single-model config is rewritten in place and `[models] default = "dimo"`
/// keeps naming the default however often the user changes it. The rest get a
/// suffix derived from the model id, which survives that reordering.
pub(super) fn grok_model_table(taken: &mut HashSet<String>, index: usize, id: &str) -> String {
    if index == 0 {
        taken.insert("dimo".to_string());
        return "dimo".to_string();
    }
    let mut slug = String::new();
    for character in id.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let base = if slug.trim_end_matches('-').is_empty() {
        format!("dimo-{index}")
    } else {
        format!("dimo-{}", slug.trim_end_matches('-'))
    };
    let mut table = base.clone();
    let mut suffix = 2;
    while !taken.insert(table.clone()) {
        table = format!("{base}-{suffix}");
        suffix += 1;
    }
    table
}

/// The `[model.*]` tables for a provider, default model first.
///
/// Grok resolves a model to a whole table and `[models] default` names one, so
/// a provider that enables several models has to write one table per model.
/// Writing only the first — as this used to — left the others checked in Dimo
/// but unreachable in grok.
pub(super) fn grok_spec(raw: &str, provider_name: &str) -> GrokProviderSpec {
    let object = serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object);
    let api_backend = object
        .as_ref()
        .and_then(|object| object.get("api_backend"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("responses")
        .to_string();
    let context_window = object
        .as_ref()
        .and_then(|object| object.get("context_window"))
        .and_then(Value::as_i64);
    let supports_backend_search = match object
        .as_ref()
        .and_then(|object| object.get("supports_backend_search"))
    {
        Some(Value::Bool(enabled)) => GrokFieldUpdate::Set(*enabled),
        Some(Value::Null) => GrokFieldUpdate::Clear,
        _ => GrokFieldUpdate::Unchanged,
    };
    let max_retries = match object.as_ref().and_then(|object| object.get("max_retries")) {
        Some(Value::Number(value)) => value
            .as_i64()
            .filter(|retries| *retries >= 0)
            .map_or(GrokFieldUpdate::Unchanged, GrokFieldUpdate::Set),
        Some(Value::Null) => GrokFieldUpdate::Clear,
        _ => GrokFieldUpdate::Unchanged,
    };
    let web_search = match object.as_ref().and_then(|object| object.get("web_search")) {
        Some(Value::Bool(true)) => GrokFieldUpdate::Set("dimo".to_string()),
        Some(Value::Bool(false)) | Some(Value::Null) => GrokFieldUpdate::Clear,
        Some(Value::String(target)) => {
            let trimmed = target.trim();
            if trimmed.is_empty() {
                GrokFieldUpdate::Clear
            } else {
                GrokFieldUpdate::Set(trimmed.to_string())
            }
        }
        _ => match supports_backend_search {
            GrokFieldUpdate::Set(true) => GrokFieldUpdate::Set("dimo".to_string()),
            GrokFieldUpdate::Set(false) | GrokFieldUpdate::Clear => GrokFieldUpdate::Clear,
            GrokFieldUpdate::Unchanged => GrokFieldUpdate::Unchanged,
        },
    };
    let mut ids = provider_model_ids(raw);
    if ids.is_empty() {
        // Older saves put the id in `model`, the key grok's own tables use.
        if let Some(id) = object
            .as_ref()
            .and_then(|object| object.get("model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        // Nothing usable in `model`, so grok gets the provider name alone.
        ids.push(provider_name.to_string());
    }
    // One endpoint, several models: without the id in the label grok's picker
    // would list the same provider name once per model. The default keeps the
    // bare name — it is the provider — and the import side reads it back as the
    // draft's name.
    let mut taken = HashSet::new();
    let models = ids
        .into_iter()
        .enumerate()
        .map(|(index, id)| {
            let table = grok_model_table(&mut taken, index, &id);
            let name = if index == 0 {
                provider_name.to_string()
            } else {
                format!("{provider_name} ({id})")
            };
            GrokModelSpec { table, id, name }
        })
        .collect();
    GrokProviderSpec {
        models,
        api_backend,
        context_window,
        supports_backend_search,
        max_retries,
        web_search,
    }
}

pub(super) async fn apply_grok(
    grok_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = grok_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    let spec = grok_spec(&provider.model, &provider.name);
    let models = toml_table_entry(&mut table, "models")?;
    models.insert(
        "default".to_string(),
        toml::Value::String("dimo".to_string()),
    );
    match &spec.web_search {
        GrokFieldUpdate::Set(target) => {
            models.insert(
                "web_search".to_string(),
                toml::Value::String(target.clone()),
            );
        }
        GrokFieldUpdate::Clear => {
            let current = models
                .get("web_search")
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            if is_dimo_grok_table(current) {
                models.remove("web_search");
            }
        }
        GrokFieldUpdate::Unchanged => {}
    }
    let owned: HashSet<&str> = spec
        .models
        .iter()
        .map(|model| model.table.as_str())
        .collect();
    let model_root = toml_table_entry(&mut table, "model")?;
    // Drop the tables an earlier save projected but this one does not, so
    // unchecking a model takes it out of grok's picker instead of leaving it
    // reachable forever. `dimo` always leads the list, so it is always kept.
    model_root.retain(|name, _| !is_dimo_grok_table(name) || owned.contains(name));
    for model in &spec.models {
        let entry = toml_table_entry(model_root, &model.table)?;
        // Update Dimo-managed keys individually instead of clearing the whole
        // table, so manual TOML extensions (e.g. extra retries/params) survive.
        entry.insert("model".to_string(), toml::Value::String(model.id.clone()));
        entry.insert(
            "base_url".to_string(),
            toml::Value::String(provider.api_url.clone()),
        );
        entry.insert("name".to_string(), toml::Value::String(model.name.clone()));
        if provider.api_key.trim().is_empty() {
            entry.remove("api_key");
        } else {
            entry.insert(
                "api_key".to_string(),
                toml::Value::String(provider.api_key.trim().to_string()),
            );
        }
        entry.insert(
            "api_backend".to_string(),
            toml::Value::String(spec.api_backend.clone()),
        );
        match spec.context_window {
            Some(context) => {
                entry.insert("context_window".to_string(), toml::Value::Integer(context));
            }
            None => {
                entry.remove("context_window");
            }
        }
        match spec.supports_backend_search {
            GrokFieldUpdate::Set(enabled) => {
                entry.insert(
                    "supports_backend_search".to_string(),
                    toml::Value::Boolean(enabled),
                );
            }
            GrokFieldUpdate::Clear => {
                entry.remove("supports_backend_search");
            }
            GrokFieldUpdate::Unchanged => {}
        }
        match spec.max_retries {
            GrokFieldUpdate::Set(retries) => {
                entry.insert("max_retries".to_string(), toml::Value::Integer(retries));
            }
            GrokFieldUpdate::Clear => {
                entry.remove("max_retries");
            }
            GrokFieldUpdate::Unchanged => {}
        }
    }
    write_toml_mutation(&path, original, &table, true).await
}
