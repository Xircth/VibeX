use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{AgentId, AgentModelProvidersView, CodexModelCatalogConfigRequest};
use serde_json::Value;

use super::common::*;
use crate::host::native::{
    catalog_cache_dir, model_catalogs, model_provider_import::ImportDraft,
    read_json_object_or_empty,
};

/// 原生 Codex `config.toml` 中声明的 Provider（`[model_providers.xxx]`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeCodexProvider {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
    pub api_key: String,
}

/// Codex 原生配置的 Provider 状态。`config.toml` / `auth.json` 是当前启用项的
/// 唯一真相源；VibeX 预设只在原生 `model_provider = "vibex"` 时才算启用。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeCodexState {
    pub providers: Vec<NativeCodexProvider>,
    /// `model_provider` 键，包括 VibeX 投影槽 `vibex`。
    pub active_provider: Option<String>,
    /// 顶层 `openai_base_url` / `api_base_url`（内置 OpenAI provider 端点）。
    pub base_url: Option<String>,
    /// 顶层 `model` 键，或外部 catalog 的默认 / 首个 slug。
    pub model: Option<String>,
    /// `auth.json` 的 `OPENAI_API_KEY`，或当前 Provider 表内的 `api_key` /
    /// `experimental_bearer_token`。
    pub credential_present: bool,
    /// `auth.json` 中的 `OPENAI_API_KEY` 原文，纳入 VibeX 预设时复用。
    pub auth_api_key: String,
}

/// 原生 Codex Provider 已纳入 VibeX 预设。启用态以 `config.toml` 的
/// `model_provider` 为准：指向 `vibex` 槽时沿用 store 绑定，否则按原生
/// 当前项的 id / URL 标记对应预设。
pub(super) fn project_with_codex_native(
    store: &ProviderStore,
    agent_id: AgentId,
    native: Option<&NativeCodexState>,
) -> AgentModelProvidersView {
    let mut view = project(store, agent_id);
    let Some(native) = native else {
        return view;
    };
    if native_uses_vibex_projection(Some(native)) {
        return view;
    }
    apply_native_active_binding(
        &mut view,
        native.active_provider.as_deref(),
        native
            .providers
            .iter()
            .map(|provider| (provider.id.as_str(), provider.api_url.as_str())),
        native.base_url.as_deref(),
    );
    overlay_native_codex_credentials(&mut view, native);
    view
}

pub(super) fn overlay_native_codex_credentials(
    view: &mut AgentModelProvidersView,
    native: &NativeCodexState,
) {
    for provider in &mut view.providers {
        if provider.credential_present {
            continue;
        }
        let matched = native.providers.iter().find(|item| {
            item.id == provider.id || (!item.api_url.is_empty() && item.api_url == provider.api_url)
        });
        let key = matched
            .map(|item| item.api_key.as_str())
            .filter(|key| !key.is_empty())
            .or_else(|| {
                (provider.bound && !native.auth_api_key.is_empty())
                    .then_some(native.auth_api_key.as_str())
            });
        if let Some(key) = key {
            provider.api_key = key.to_string();
            provider.credential_present = true;
        }
    }
}

pub(super) fn codex_native_drafts(native: Option<&NativeCodexState>) -> Vec<NativeProviderDraft> {
    let Some(native) = native else {
        return Vec::new();
    };
    let mut drafts = native
        .providers
        .iter()
        .filter(|provider| provider.id != "vibex" && !provider.api_url.is_empty())
        .map(|provider| NativeProviderDraft {
            id: provider.id.clone(),
            name: provider.name.clone(),
            api_url: provider.api_url.clone(),
            api_key: if provider.api_key.is_empty() {
                native.auth_api_key.clone()
            } else {
                provider.api_key.clone()
            },
            model: provider.model.clone(),
        })
        .collect::<Vec<_>>();
    if drafts.is_empty()
        && let Some(api_url) = native
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        drafts.push(NativeProviderDraft {
            id: NATIVE_ENDPOINT_PROVIDER_ID.to_string(),
            name: "原生端点".to_string(),
            api_url: api_url.to_string(),
            api_key: native.auth_api_key.clone(),
            model: native.model.clone().unwrap_or_default(),
        });
    }
    drafts
}

/// 只读解析 Codex 原生配置的 Provider 状态，不修改任何 Agent 文件。
pub async fn read_native_codex_state(
    codex_home: &Path,
) -> Result<NativeCodexState, crate::host::native::NativeError> {
    let mut state = NativeCodexState::default();
    // config.toml 损坏时降级为空状态，鉴权管理按「未配置 Provider」处理。
    let table = match read_toml_table(&codex_home.join("config.toml")).await {
        Ok(table) => table,
        Err(_) => toml::Table::new(),
    };
    state.active_provider = table
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    state.base_url = table
        .get("openai_base_url")
        .or_else(|| table.get("api_base_url"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    state.model = table
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(providers) = table.get("model_providers").and_then(toml::Value::as_table) {
        for (id, value) in providers {
            let Some(provider) = value.as_table() else {
                continue;
            };
            let api_key = codex_provider_secret(provider);
            state.providers.push(NativeCodexProvider {
                id: id.clone(),
                name: provider
                    .get("name")
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(id)
                    .to_string(),
                api_url: provider
                    .get("base_url")
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_default()
                    .to_string(),
                model: String::new(),
                api_key,
            });
        }
    }
    if let Some((_, catalog, catalog_model)) =
        crate::host::native::model_catalogs::peek_external_codex_catalog(codex_home).await
    {
        let model = state
            .model
            .clone()
            .or(catalog_model)
            .or_else(|| crate::host::native::model_catalogs::first_catalog_slug(&catalog));
        state.model = model;
    }
    let shared_model = state.model.clone().unwrap_or_default();
    for provider in &mut state.providers {
        if provider.model.is_empty() {
            provider.model = shared_model.clone();
        }
    }
    let auth = read_json_object_or_empty(&codex_home.join("auth.json")).await?;
    state.auth_api_key = auth
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    let table_key = state.active_provider.as_deref().is_some_and(|active| {
        state
            .providers
            .iter()
            .any(|provider| provider.id == active && !provider.api_key.is_empty())
    });
    state.credential_present = !state.auth_api_key.is_empty() || table_key;
    Ok(state)
}

pub(super) fn codex_provider_secret(provider: &toml::Table) -> String {
    ["api_key", "experimental_bearer_token"]
        .into_iter()
        .find_map(|key| {
            provider
                .get(key)
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

pub(super) fn native_uses_vibex_projection(native: Option<&NativeCodexState>) -> bool {
    native.is_some_and(|state| state.active_provider.as_deref() == Some("vibex"))
}

pub(super) fn is_native_codex_channel(
    provider: &StoredProvider,
    native: Option<&NativeCodexState>,
) -> bool {
    let Some(native) = native else {
        return false;
    };
    if provider.id == "vibex" {
        return false;
    }
    native
        .providers
        .iter()
        .any(|candidate| candidate.id == provider.id)
        || provider.id == NATIVE_ENDPOINT_PROVIDER_ID
}

pub(super) async fn activate_native_codex_provider(
    codex_home: &Path,
    provider_id: &str,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let path = codex_home.join("config.toml");
    let original = filesystem.read(&path).await?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    if provider_id == NATIVE_ENDPOINT_PROVIDER_ID {
        table.remove("model_provider");
    } else {
        table.insert(
            "model_provider".to_string(),
            toml::Value::String(provider_id.to_string()),
        );
    }
    let bytes = toml::to_string_pretty(&table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 Codex config.toml 失败：{error}"))?;
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(bytes),
        sensitive: false,
    }])
    .await
}

pub fn native_codex_provider_ready(state: &NativeCodexState) -> bool {
    match state.active_provider.as_deref() {
        Some(active) => {
            state.providers.iter().any(|provider| provider.id == active) || active == "openai"
        }
        None => state.base_url.is_some(),
    }
}

pub async fn native_codex_provider_ready_at(codex_home: &Path) -> bool {
    match read_native_codex_state(codex_home).await {
        Ok(state) => native_codex_provider_ready(&state),
        Err(_) => false,
    }
}

pub(super) async fn native_codex_drafts(codex_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let state = read_native_codex_state(codex_home).await?;
    let key = if state.credential_present {
        read_json_object_or_empty(&codex_home.join("auth.json"))
            .await?
            .get("OPENAI_API_KEY")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    let mut drafts = Vec::new();
    for provider in state.providers {
        if provider.id == "vibex" {
            continue;
        }
        let api_key = if !key.is_empty() {
            key.clone()
        } else {
            provider.api_key
        };
        drafts.push(ImportDraft {
            source_id: provider.id.clone(),
            name: provider.name,
            api_url: provider.api_url,
            api_key,
            model: if provider.model.is_empty() {
                String::new()
            } else {
                serde_json::json!({ "default_model": provider.model }).to_string()
            },
            skip_reason: None,
        });
    }
    if drafts.is_empty()
        && let (Some(url), Some(model)) = (state.base_url, state.model)
    {
        drafts.push(ImportDraft {
            source_id: NATIVE_ENDPOINT_PROVIDER_ID.to_string(),
            name: "当前原生配置".to_string(),
            api_url: url,
            api_key: key,
            model: serde_json::json!({ "default_model": model }).to_string(),
            skip_reason: None,
        });
    }
    Ok(drafts)
}

pub(super) const CODEX_AUTH_KEYS: &[&str] = &["OPENAI_API_KEY", "auth_mode"];

pub(super) const CODEX_CONFIG_KEYS: &[&str] = &[
    "api_base_url",
    "openai_base_url",
    "model_provider",
    "model",
    "model_catalog_json",
];

pub(super) const CODEX_PROVIDER_ENTRY_BACKUP_KEY: &str = "model_providers.vibex";

pub(super) const CODEX_CATALOG_FILE: &str = "vibex-model-catalog.json";

pub(super) const CODEX_SOURCE_FILE: &str = "vibex-model-catalog.source.json";

pub(super) async fn capture_codex_toml(
    path: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let table = read_toml_table(path).await?;
    for key in CODEX_CONFIG_KEYS {
        backup
            .toml_values
            .insert((*key).to_string(), table.get(*key).cloned());
    }
    let provider = table
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get("vibex"))
        .cloned();
    backup
        .toml_values
        .insert(CODEX_PROVIDER_ENTRY_BACKUP_KEY.to_string(), provider);
    Ok(())
}

pub(super) async fn restore_codex_projection(
    codex_home: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let auth_path = codex_home.join("auth.json");
    let config_path = codex_home.join("config.toml");
    let catalog_path = codex_home.join(CODEX_CATALOG_FILE);
    let source_path = codex_home.join(CODEX_SOURCE_FILE);
    let auth_original = filesystem.read(&auth_path).await?;
    let config_original = filesystem.read(&config_path).await?;
    let catalog_original = filesystem.read(&catalog_path).await?;
    let source_original = filesystem.read(&source_path).await?;

    let mut auth = parse_json_object_bytes(&auth_path, auth_original.as_deref())?;
    restore_json_values(
        auth.as_object_mut().expect("validated object"),
        CODEX_AUTH_KEYS,
        backup,
    );
    let mut table = parse_toml_table_bytes(&config_path, config_original.as_deref())?;
    restore_codex_toml_values(&mut table, backup)?;
    apply_projection_mutations(&[
        NativeFileMutation {
            path: auth_path,
            expected: auth_original,
            replacement: Some(
                serde_json::to_vec_pretty(&auth)
                    .map_err(|error| format!("序列化 Codex auth.json 失败：{error}"))?,
            ),
            sensitive: true,
        },
        NativeFileMutation {
            path: config_path,
            expected: config_original,
            replacement: Some(
                toml::to_string_pretty(&table)
                    .map(String::into_bytes)
                    .map_err(|error| format!("序列化 Codex config.toml 失败：{error}"))?,
            ),
            sensitive: false,
        },
        NativeFileMutation {
            path: catalog_path,
            expected: catalog_original,
            replacement: backup
                .file_values
                .get(CODEX_CATALOG_FILE)
                .cloned()
                .flatten()
                .map(String::into_bytes),
            sensitive: false,
        },
        NativeFileMutation {
            path: source_path,
            expected: source_original,
            replacement: backup
                .file_values
                .get(CODEX_SOURCE_FILE)
                .cloned()
                .flatten()
                .map(String::into_bytes),
            sensitive: false,
        },
    ])
    .await
}

pub(super) fn restore_codex_toml_values(
    table: &mut toml::Table,
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    for key in CODEX_CONFIG_KEYS {
        match backup.toml_values.get(*key).cloned().flatten() {
            Some(value) => {
                table.insert((*key).to_string(), value);
            }
            None => {
                table.remove(*key);
            }
        }
    }
    let original_vibex = backup
        .toml_values
        .get(CODEX_PROVIDER_ENTRY_BACKUP_KEY)
        .cloned()
        .flatten();
    if original_vibex.is_some() || table.contains_key("model_providers") {
        let providers = table
            .entry("model_providers".to_string())
            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
        let providers = providers.as_table_mut().ok_or_else(|| {
            crate::host::native::NativeError::from("Codex model_providers 必须是表")
        })?;
        match original_vibex {
            Some(value) => {
                providers.insert("vibex".to_string(), value);
            }
            None => {
                providers.remove("vibex");
            }
        }
        if providers.is_empty() {
            table.remove("model_providers");
        }
    }
    Ok(())
}

pub(super) async fn apply_codex(
    codex_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let auth_path = codex_home.join("auth.json");
    let auth_original = filesystem.read(&auth_path).await?;
    let mut auth = parse_json_object_bytes(&auth_path, auth_original.as_deref())?;
    {
        let auth_object = auth.as_object_mut().expect("object");
        auth_object.remove("auth_mode");
        auth_object.insert(
            "OPENAI_API_KEY".to_string(),
            Value::String(provider.api_key.clone()),
        );
    }
    let config_path = codex_home.join("config.toml");
    let config_original = filesystem.read(&config_path).await?;
    let mut table = parse_toml_table_bytes(&config_path, config_original.as_deref())?;
    table.remove("api_base_url");
    table.remove("openai_base_url");
    let provider_name = "vibex".to_string();
    table.insert(
        "model_provider".to_string(),
        toml::Value::String(provider_name.clone()),
    );
    let providers = table
        .entry("model_providers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if !providers.is_table() {
        *providers = toml::Value::Table(toml::Table::new());
    }
    let provider_table = providers
        .as_table_mut()
        .expect("normalized table")
        .entry(provider_name.clone())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if !provider_table.is_table() {
        *provider_table = toml::Value::Table(toml::Table::new());
    }
    let provider_table = provider_table.as_table_mut().expect("normalized table");
    if provider.api_url.is_empty() {
        provider_table.remove("base_url");
    } else {
        provider_table.insert(
            "base_url".to_string(),
            toml::Value::String(provider.api_url.clone()),
        );
    }
    provider_table.insert("name".to_string(), toml::Value::String("vibex".to_string()));
    provider_table.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    provider_table.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(true),
    );

    let structured = serde_json::from_str::<CodexModelCatalogConfigRequest>(&provider.model).ok();
    let default_model = structured
        .as_ref()
        .and_then(|request| request.default_model.clone())
        .unwrap_or_else(|| model_default(&provider.model));
    if default_model.trim().is_empty() {
        table.remove("model");
    } else {
        table.insert("model".to_string(), toml::Value::String(default_model));
    }
    let official =
        model_catalogs::cached_official_models(&catalog_cache_dir().join("codex-bundled.json"))
            .await;
    let catalog_document = structured
        .as_ref()
        .map(|request| model_catalogs::expand_provider_codex_catalog(request, &official))
        .transpose()?;
    let catalog_models = catalog_document
        .as_ref()
        .and_then(|document| document.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !catalog_models.is_empty() {
        table.insert(
            "model_catalog_json".to_string(),
            toml::Value::String(CODEX_CATALOG_FILE.to_string()),
        );
    }
    let auth_bytes = serde_json::to_vec_pretty(&auth)
        .map_err(|error| format!("序列化 Codex auth.json 失败：{error}"))?;
    let config_bytes = toml::to_string_pretty(&table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 Codex config.toml 失败：{error}"))?;
    let mut mutations = vec![
        NativeFileMutation {
            path: auth_path,
            expected: auth_original,
            replacement: Some(auth_bytes),
            sensitive: true,
        },
        NativeFileMutation {
            path: config_path,
            expected: config_original,
            replacement: Some(config_bytes),
            sensitive: false,
        },
    ];
    if !catalog_models.is_empty() {
        let catalog_path = codex_home.join(CODEX_CATALOG_FILE);
        let source_path = codex_home.join(CODEX_SOURCE_FILE);
        let catalog_original = filesystem.read(&catalog_path).await?;
        let source_original = filesystem.read(&source_path).await?;
        let catalog_bytes = serde_json::to_vec_pretty(catalog_document.as_ref().expect("catalog"))
            .map_err(|error| format!("序列化 Codex 模型目录失败：{error}"))?;
        let source_bytes =
            serde_json::to_vec_pretty(structured.as_ref().expect("structured model"))
                .map_err(|error| format!("序列化 Codex 模型目录源文件失败：{error}"))?;
        mutations.push(NativeFileMutation {
            path: catalog_path,
            expected: catalog_original,
            replacement: Some(catalog_bytes),
            sensitive: false,
        });
        mutations.push(NativeFileMutation {
            path: source_path,
            expected: source_original,
            replacement: Some(source_bytes),
            sensitive: false,
        });
    }
    apply_projection_mutations(&mutations).await
}

pub(super) async fn remove_native_codex_provider(
    codex_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    if provider.id == "vibex" {
        return Ok(());
    }
    let path = codex_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    let mut changed = false;
    if provider.id == NATIVE_ENDPOINT_PROVIDER_ID {
        for key in ["openai_base_url", "api_base_url"] {
            if table.remove(key).is_some() {
                changed = true;
            }
        }
    }
    let match_id = table
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| {
            if providers.contains_key(&provider.id) {
                return Some(provider.id.clone());
            }
            if provider.api_url.is_empty() {
                return None;
            }
            providers.iter().find_map(|(id, value)| {
                if id == "vibex" {
                    return None;
                }
                value
                    .as_table()
                    .and_then(|entry| entry.get("base_url"))
                    .and_then(toml::Value::as_str)
                    .filter(|url| *url == provider.api_url)
                    .map(|_| id.clone())
            })
        });
    if let Some(id) = match_id
        && let Some(providers) = table
            .get_mut("model_providers")
            .and_then(toml::Value::as_table_mut)
    {
        providers.remove(&id);
        changed = true;
        if providers.is_empty() {
            table.remove("model_providers");
        }
    }
    if !changed {
        return Ok(());
    }
    let bytes = toml::to_string_pretty(&table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 Codex config.toml 失败：{error}"))?;
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(bytes),
        sensitive: false,
    }])
    .await
}
