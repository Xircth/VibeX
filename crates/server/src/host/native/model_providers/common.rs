use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};

use agents::{
    BuiltInProfileCatalog, NativeFileMutation, NativeFileSystem, TokioNativeFileSystem,
    official_api_url,
};
use api_types::{
    AgentId, AgentModelProviderSaveRequest, AgentModelProviderView, AgentModelProvidersView,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::host::native::{
    model_provider_import::ImportDraft, read_json_object_or_empty, write_bytes_document,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct StoredProvider {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) agent_id: AgentId,
    pub(super) api_url: String,
    pub(super) api_key: String,
    pub(super) model: String,
}

/// 只有顶层 base_url、没有显式 `[model_providers.xxx]` 表时使用的合成标识。
pub(super) const NATIVE_ENDPOINT_PROVIDER_ID: &str = "__vibex_native_endpoint__";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct ProviderStore {
    #[serde(default)]
    pub(super) providers: Vec<StoredProvider>,
    #[serde(default)]
    pub(super) bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub(super) projection_backups: BTreeMap<String, ProviderProjectionBackup>,
    /// Set after the Host store has absorbed the pre-0.2.0 Tauri app-data file.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(super) adopted_legacy_store: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct ProviderProjectionBackup {
    #[serde(default)]
    pub(super) json_values: BTreeMap<String, Option<Value>>,
    #[serde(default)]
    pub(super) toml_values: BTreeMap<String, Option<toml::Value>>,
    #[serde(default)]
    pub(super) file_values: BTreeMap<String, Option<String>>,
}

pub(super) fn resolve_native_home(
    home: &Path,
    environment: &HashMap<String, String>,
    variable: &str,
    fallback: &str,
) -> PathBuf {
    environment
        .get(variable)
        .filter(|value| !value.trim().is_empty())
        .map(|value| super::super::expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(|value| super::super::expand_agent_home_path(home, &value.to_string_lossy()))
        })
        .unwrap_or_else(|| home.join(fallback))
}

pub(super) fn project(store: &ProviderStore, agent_id: AgentId) -> AgentModelProvidersView {
    let bound_provider_id = store.bindings.get(agent_id.as_str()).cloned();
    let mut providers = store
        .providers
        .iter()
        .filter(|provider| provider.agent_id == agent_id)
        .map(|provider| AgentModelProviderView {
            id: provider.id.clone(),
            name: provider.name.clone(),
            agent_id: provider.agent_id.clone(),
            api_url: provider.api_url.clone(),
            model: provider.model.clone(),
            api_key: provider.api_key.clone(),
            credential_present: !provider.api_key.is_empty(),
            bound: bound_provider_id.as_deref() == Some(provider.id.as_str()),
            managed: true,
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    AgentModelProvidersView {
        agent_id,
        providers,
        bound_provider_id,
    }
}

pub(super) fn apply_native_active_binding<'a>(
    view: &mut AgentModelProvidersView,
    active_id: Option<&str>,
    native_providers: impl IntoIterator<Item = (&'a str, &'a str)>,
    fallback_url: Option<&str>,
) {
    let native_providers: Vec<(&str, &str)> = native_providers.into_iter().collect();
    let active_url = active_id
        .filter(|id| *id != "vibex")
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
    let match_id = active_id.filter(|id| *id != "vibex");
    let matched_id = view
        .providers
        .iter()
        .find(|provider| {
            match_id.is_some_and(|id| provider.id == id)
                || active_url.is_some_and(|url| provider.api_url == url)
                || (match_id.is_none()
                    && active_url.is_some()
                    && provider.id == NATIVE_ENDPOINT_PROVIDER_ID)
        })
        .map(|provider| provider.id.clone());
    for provider in &mut view.providers {
        provider.bound = matched_id.as_deref() == Some(provider.id.as_str());
    }
    view.bound_provider_id = matched_id;
}

pub(super) fn project_with_live_native(
    store: &ProviderStore,
    agent_id: AgentId,
    drafts: &[NativeProviderDraft],
) -> AgentModelProvidersView {
    let mut view = project(store, agent_id);
    if view.bound_provider_id.is_some() || drafts.len() != 1 {
        return view;
    }
    let live = &drafts[0];
    apply_native_active_binding(
        &mut view,
        Some(live.id.as_str()),
        std::iter::once((live.id.as_str(), live.api_url.as_str())),
        Some(live.api_url.as_str()),
    );
    view
}

pub(super) struct NativeProviderDraft {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) api_url: String,
    pub(super) api_key: String,
    pub(super) model: String,
}

pub(super) fn custom_endpoint_drafts(
    agent_id: &AgentId,
    drafts: Vec<ImportDraft>,
) -> Vec<NativeProviderDraft> {
    drafts
        .into_iter()
        .filter(|draft| {
            !draft.api_url.is_empty()
                && draft.source_id != "vibex"
                && !draft.source_id.ends_with(":vibex")
                && !is_official_endpoint(agent_id, &draft.api_url)
        })
        .map(|draft| {
            let id = native_provider_id(&draft.source_id, &draft.api_url);
            let name = if draft.name == "当前原生配置" || draft.name.trim().is_empty() {
                native_provider_name(&draft.api_url)
            } else {
                draft.name
            };
            NativeProviderDraft {
                id,
                name,
                api_url: draft.api_url,
                api_key: draft.api_key,
                model: draft.model,
            }
        })
        .collect()
}

pub(super) fn is_official_endpoint(agent_id: &AgentId, url: &str) -> bool {
    let normalized = normalized_endpoint(url);
    [
        official_api_url(agent_id, "official_api"),
        official_api_url(agent_id, "api_key"),
        official_api_url(agent_id, "custom"),
        official_api_url(agent_id, "gemini-api-key"),
        official_api_url(agent_id, "deepseek"),
    ]
    .into_iter()
    .flatten()
    .any(|official| normalized_endpoint(official) == normalized)
}

pub(super) fn normalized_endpoint(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').to_ascii_lowercase();
    trimmed
        .strip_suffix("/v1")
        .unwrap_or(trimmed.as_str())
        .trim_end_matches('/')
        .to_string()
}

pub(super) fn native_provider_id(source_id: &str, url: &str) -> String {
    let stripped = source_id.strip_prefix("native:").unwrap_or(source_id);
    if stripped == "__native_live__"
        || stripped == NATIVE_ENDPOINT_PROVIDER_ID
        || stripped.is_empty()
    {
        return host_slug(url);
    }
    stripped.to_string()
}

pub(super) fn native_provider_name(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "原生端点".to_string())
}

pub(super) fn host_slug(url: &str) -> String {
    native_provider_name(url)
        .chars()
        .map(|ch| if ch == '.' { '-' } else { ch })
        .collect()
}

pub(super) fn adopt_native_providers(
    store: &mut ProviderStore,
    agent_id: &AgentId,
    natives: &[NativeProviderDraft],
) -> bool {
    let mut changed = false;
    for native in natives {
        if native.id == "vibex" {
            continue;
        }
        if let Some(existing) = store.providers.iter_mut().find(|provider| {
            provider.agent_id == *agent_id
                && (provider.id == native.id
                    || (!native.api_url.is_empty() && provider.api_url == native.api_url))
        }) {
            if existing.api_key.is_empty() && !native.api_key.is_empty() {
                existing.api_key = native.api_key.clone();
                changed = true;
            }
            continue;
        }
        store.providers.push(StoredProvider {
            id: native.id.clone(),
            name: if native.name.trim().is_empty() {
                native.id.clone()
            } else {
                native.name.clone()
            },
            agent_id: agent_id.clone(),
            api_url: native.api_url.clone(),
            api_key: native.api_key.clone(),
            model: native.model.clone(),
        });
        changed = true;
    }
    changed
}

pub(super) async fn read_store(
    path: &Path,
) -> Result<ProviderStore, crate::host::native::NativeError> {
    let mut store = read_store_file(path).await?;
    if !is_live_host_provider_store(path) || store.adopted_legacy_store {
        return Ok(store);
    }
    for legacy in utils::assets::tauri_app_data_file_candidates("agent-model-providers.json") {
        if legacy == path {
            continue;
        }
        if let Ok(legacy_store) = read_store_file(&legacy).await {
            merge_provider_stores(&mut store, legacy_store);
        }
    }
    store.adopted_legacy_store = true;
    write_store(path, &store).await?;
    Ok(store)
}

pub(super) async fn read_store_file(
    path: &Path,
) -> Result<ProviderStore, crate::host::native::NativeError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Model Provider 存储文件无效：{error}").into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProviderStore::default()),
        Err(error) => Err(format!("读取 Model Provider 失败：{error}").into()),
    }
}

pub(super) fn is_live_host_provider_store(path: &Path) -> bool {
    path == utils::assets::host_data_dir().join("agent-model-providers.json")
}

pub(super) fn merge_provider_stores(dest: &mut ProviderStore, legacy: ProviderStore) {
    let existing: HashSet<String> = dest
        .providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect();
    for provider in legacy.providers {
        if existing.contains(&provider.id) {
            continue;
        }
        dest.providers.push(provider);
    }
    for (agent_id, provider_id) in legacy.bindings {
        dest.bindings.entry(agent_id).or_insert(provider_id);
    }
    for (agent_id, backup) in legacy.projection_backups {
        dest.projection_backups.entry(agent_id).or_insert(backup);
    }
}

pub(super) async fn write_store(
    path: &Path,
    store: &ProviderStore,
) -> Result<(), crate::host::native::NativeError> {
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("序列化 Model Provider 失败：{error}"))?;
    write_bytes_document(path, &bytes, true).await
}

pub(super) fn validate_agent(agent_id: &AgentId) -> Result<(), crate::host::native::NativeError> {
    if BuiltInProfileCatalog::bundled().supports_reusable_model_providers(agent_id) {
        Ok(())
    } else {
        Err("此 Agent 不支持可复用 Model Provider".into())
    }
}

pub(super) fn validate_request(
    request: &AgentModelProviderSaveRequest,
) -> Result<(), crate::host::native::NativeError> {
    validate_agent(&request.agent_id)?;
    if request.name.trim().is_empty() {
        return Err("Model Provider 名称不能为空".into());
    }
    if request.api_url.trim().is_empty() {
        return Err("Model Provider API URL 不能为空".into());
    }
    let url = url::Url::parse(request.api_url.trim())
        .map_err(|error| format!("Model Provider API URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Model Provider API URL 必须是无内嵌凭据的 http(s) 地址".into());
    }
    Ok(())
}

pub(super) fn json_text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| {
            value
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
        })
        .unwrap_or("")
        .to_string()
}

pub(super) async fn capture_json_env(
    path: &Path,
    keys: &[&str],
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let document = read_json_object_or_empty(path).await?;
    let env = match document.get("env") {
        Some(Value::Object(env)) => Some(env),
        Some(_) => return Err("原生配置字段 `env` 必须是对象".into()),
        None => None,
    };
    for key in keys {
        backup.json_values.insert(
            (*key).to_string(),
            env.and_then(|values| values.get(*key)).cloned(),
        );
    }
    Ok(())
}

pub(super) async fn capture_json_root(
    path: &Path,
    keys: &[&str],
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let document = read_json_object_or_empty(path).await?;
    for key in keys {
        backup
            .json_values
            .insert((*key).to_string(), document.get(*key).cloned());
    }
    Ok(())
}

pub(super) async fn capture_text_file(
    path: &Path,
    key: &str,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let value = match tokio::fs::read_to_string(path).await {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display()).into()),
    };
    backup.file_values.insert(key.to_string(), value);
    Ok(())
}

pub(super) async fn restore_text_file(
    path: &Path,
    key: &str,
    backup: &ProviderProjectionBackup,
    sensitive: bool,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(path).await?;
    let replacement = backup
        .file_values
        .get(key)
        .cloned()
        .flatten()
        .map(String::into_bytes);
    apply_projection_mutations(&[NativeFileMutation {
        path: path.to_path_buf(),
        expected: original,
        replacement,
        sensitive,
    }])
    .await
}

pub(super) async fn restore_json_env(
    path: &Path,
    keys: &[&str],
    backup: &ProviderProjectionBackup,
    sensitive: bool,
) -> Result<(), crate::host::native::NativeError> {
    let mut document = read_json_object_or_empty(path).await?;
    let env = object_entry(document.as_object_mut().expect("object"), "env")?;
    restore_json_values(env, keys, backup);
    write_json(path, &document, sensitive).await
}

pub(super) fn restore_json_values(
    object: &mut Map<String, Value>,
    keys: &[&str],
    backup: &ProviderProjectionBackup,
) {
    for key in keys {
        match backup.json_values.get(*key).cloned().flatten() {
            Some(value) => {
                object.insert((*key).to_string(), value);
            }
            None => {
                object.remove(*key);
            }
        }
    }
}

pub(super) async fn read_toml_table(
    path: &Path,
) -> Result<toml::Table, crate::host::native::NativeError> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display()).into()),
    };
    if text.trim().is_empty() {
        Ok(toml::Table::new())
    } else {
        toml::from_str(&text).map_err(|error| format!("{} 无效：{error}", path.display()).into())
    }
}

#[cfg(test)]
pub(super) async fn write_toml_table(
    path: &Path,
    table: &toml::Table,
) -> Result<(), crate::host::native::NativeError> {
    let bytes = toml::to_string_pretty(table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 {} 失败：{error}", path.display()))?;
    write_bytes_document(path, &bytes, false).await
}

pub(super) async fn apply_generic_json_env_provider(
    path: &Path,
    provider: &StoredProvider,
    pairs: &[(&str, &str)],
    model_env_key: &str,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(path).await?;
    let mut document = parse_json_object_bytes(path, original.as_deref())?;
    let env = object_entry(document.as_object_mut().expect("object"), "env")?;
    for (key, value) in pairs {
        insert_string(env, key, value);
    }
    let model = model_default(&provider.model);
    insert_string(env, model_env_key, model.trim());
    apply_projection_mutations(&[NativeFileMutation {
        path: path.to_path_buf(),
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("序列化原生配置失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}

pub(super) fn toml_table_entry<'a>(
    table: &'a mut toml::Table,
    key: &str,
) -> Result<&'a mut toml::Table, crate::host::native::NativeError> {
    let entry = table
        .entry(key.to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if !entry.is_table() {
        *entry = toml::Value::Table(toml::Table::new());
    }
    entry
        .as_table_mut()
        .ok_or_else(|| format!("{key} 必须是表").into())
}

pub(super) async fn write_toml_mutation(
    path: &Path,
    original: Option<Vec<u8>>,
    table: &toml::Table,
    sensitive: bool,
) -> Result<(), crate::host::native::NativeError> {
    apply_projection_mutations(&[NativeFileMutation {
        path: path.to_path_buf(),
        expected: original,
        replacement: Some(
            toml::to_string_pretty(table)
                .map(String::into_bytes)
                .map_err(|error| format!("序列化 {} 失败：{error}", path.display()))?,
        ),
        sensitive,
    }])
    .await
}

pub(super) fn parse_json_object_bytes(
    path: &Path,
    bytes: Option<&[u8]>,
) -> Result<Value, crate::host::native::NativeError> {
    let Some(bytes) = bytes else {
        return Ok(Value::Object(Map::new()));
    };
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("{} 无效：{error}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} 顶层必须是对象", path.display()).into())
    }
}

pub(super) fn parse_toml_table_bytes(
    path: &Path,
    bytes: Option<&[u8]>,
) -> Result<toml::Table, crate::host::native::NativeError> {
    let text = bytes
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|error| format!("{} 不是 UTF-8：{error}", path.display()))?
        .unwrap_or_default();
    if text.trim().is_empty() {
        Ok(toml::Table::new())
    } else {
        toml::from_str(text).map_err(|error| format!("{} 无效：{error}", path.display()).into())
    }
}

pub(super) async fn apply_projection_mutations(
    mutations: &[NativeFileMutation],
) -> Result<(), crate::host::native::NativeError> {
    TokioNativeFileSystem
        .apply_many_atomic(mutations)
        .await
        .map_err(crate::host::native::NativeError::from)
}

pub(super) fn object_entry<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, crate::host::native::NativeError> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .ok_or_else(|| format!("原生配置字段 `{key}` 必须是对象").into())
}

pub(super) fn insert_string(object: &mut Map<String, Value>, key: &str, value: &str) {
    if value.is_empty() {
        object.remove(key);
    } else {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

pub(super) fn parse_model(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

pub(super) fn model_default(raw: &str) -> String {
    provider_model_ids(raw)
        .into_iter()
        .next()
        .unwrap_or_else(|| match parse_model(raw) {
            Value::Object(object) => object
                .get("default")
                .or_else(|| object.get("main"))
                .and_then(Value::as_str)
                .unwrap_or(raw)
                .to_string(),
            Value::String(model) => model,
            _ => raw.to_string(),
        })
}

pub(super) fn provider_model_ids(raw: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |value: &str| {
        let id = value.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            return;
        }
        ids.push(id.to_string());
    };
    match parse_model(raw) {
        Value::Object(object) => {
            for key in ["id", "default", "main"] {
                if let Some(value) = object.get(key).and_then(Value::as_str) {
                    push(value);
                }
            }
            if let Some(models) = object.get("models").and_then(Value::as_array) {
                for model in models {
                    if let Some(value) = model.as_str() {
                        push(value);
                    } else if let Some(value) = model.get("id").and_then(Value::as_str) {
                        push(value);
                    }
                }
            }
        }
        Value::String(model) => push(&model),
        _ => {}
    }
    ids
}

pub(super) async fn write_json(
    path: &Path,
    document: &Value,
    sensitive: bool,
) -> Result<(), crate::host::native::NativeError> {
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("序列化原生配置失败：{error}"))?;
    write_bytes_document(path, &bytes, sensitive).await
}
