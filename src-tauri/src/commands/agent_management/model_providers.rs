use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{
    AgentId, AgentKind, AgentModelProviderImportPreviewView, AgentModelProviderImportSource,
    AgentModelProviderSaveRequest, AgentModelProviderView, AgentModelProvidersView,
    CodexModelCatalogConfigRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    model_provider_import::{
        ImportDraft, annotate_duplicate, drafts_to_preview, preview_cc_switch,
    },
    read_json_object_or_empty, write_bytes_document,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProvider {
    id: String,
    name: String,
    agent_id: AgentId,
    api_url: String,
    api_key: String,
    model: String,
}

/// 原生 Codex `config.toml` 中声明的自定义 Provider（`[model_providers.xxx]`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct NativeCodexProvider {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
}

/// 原生 Codex 配置的 Provider 相关状态。用于把用户手写在 `config.toml` 中的
/// 自定义 Provider（而非 VibeX 预设）投影为"已绑定"视图，只读识别、不改文件。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct NativeCodexState {
    pub providers: Vec<NativeCodexProvider>,
    /// `model_provider` 键指向的非 vibex 提供商标识。
    pub active_provider: Option<String>,
    /// 顶层 `openai_base_url` / `api_base_url`（内置 OpenAI provider 端点）。
    pub base_url: Option<String>,
    /// 顶层 `model` 键。
    pub model: Option<String>,
    /// `auth.json` 中是否存在非空 `OPENAI_API_KEY`。
    pub credential_present: bool,
}

/// 只有顶层 base_url、没有显式 `[model_providers.xxx]` 表时使用的合成标识。
const NATIVE_ENDPOINT_PROVIDER_ID: &str = "__vibex_native_endpoint__";

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProviderStore {
    #[serde(default)]
    providers: Vec<StoredProvider>,
    #[serde(default)]
    bindings: BTreeMap<String, String>,
    #[serde(default)]
    projection_backups: BTreeMap<String, ProviderProjectionBackup>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProviderProjectionBackup {
    #[serde(default)]
    json_values: BTreeMap<String, Option<Value>>,
    #[serde(default)]
    toml_values: BTreeMap<String, Option<toml::Value>>,
    #[serde(default)]
    file_values: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone)]
struct ProviderNativeHomes {
    claude: PathBuf,
    codex: PathBuf,
    gemini: PathBuf,
    grok: PathBuf,
    kimi: PathBuf,
    hermes: PathBuf,
    openclaw: PathBuf,
    cline: PathBuf,
}

impl ProviderNativeHomes {
    fn resolve(home: &Path, environment: &HashMap<String, String>) -> Self {
        Self {
            claude: resolve_native_home(home, environment, "CLAUDE_CONFIG_DIR", ".claude"),
            codex: resolve_native_home(home, environment, "CODEX_HOME", ".codex"),
            gemini: resolve_gemini_home(home, environment),
            grok: resolve_native_home(home, environment, "GROK_HOME", ".grok"),
            kimi: resolve_native_home(home, environment, "KIMI_CODE_HOME", ".kimi-code"),
            hermes: resolve_native_home(home, environment, "HERMES_HOME", ".hermes"),
            openclaw: resolve_native_home(home, environment, "OPENCLAW_HOME", ".openclaw"),
            cline: resolve_native_home(home, environment, "CLINE_DIR", ".cline/data"),
        }
    }
}

fn resolve_gemini_home(home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    if let Some(value) = environment
        .get("GEMINI_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return super::expand_agent_home_path(home, value);
    }
    if let Some(value) = std::env::var_os("GEMINI_HOME").filter(|value| !value.is_empty()) {
        return super::expand_agent_home_path(home, &value.to_string_lossy());
    }
    if let Some(value) = environment
        .get("GEMINI_CLI_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return super::expand_agent_home_path(home, value).join(".gemini");
    }
    if let Some(value) = std::env::var_os("GEMINI_CLI_HOME").filter(|value| !value.is_empty()) {
        return super::expand_agent_home_path(home, &value.to_string_lossy()).join(".gemini");
    }
    home.join(".gemini")
}

fn is_antigravity(agent_id: &AgentId) -> bool {
    AgentKind::Antigravity.matches_id(agent_id.as_str())
}

fn antigravity_settings_path(gemini_home: &Path) -> PathBuf {
    gemini_home.join("antigravity-acp").join("settings.json")
}

fn resolve_native_home(
    home: &Path,
    environment: &HashMap<String, String>,
    variable: &str,
    fallback: &str,
) -> PathBuf {
    environment
        .get(variable)
        .filter(|value| !value.trim().is_empty())
        .map(|value| super::expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(fallback))
}

pub(super) async fn list(
    store_path: &Path,
    agent_id: AgentId,
) -> Result<AgentModelProvidersView, String> {
    list_with_native(store_path, agent_id, None).await
}

/// 与 `list` 相同，但对 Codex 额外把原生 `config.toml` 中已激活的自定义
/// Provider 合并进视图，使未使用 VibeX 预设的手写配置也能如实显示。
pub(super) async fn list_with_native(
    store_path: &Path,
    agent_id: AgentId,
    codex_home: Option<&Path>,
) -> Result<AgentModelProvidersView, String> {
    validate_agent(&agent_id)?;
    let store = read_store(store_path).await?;
    let native = if agent_id.as_str() == "codex" {
        match codex_home {
            Some(home) => Some(read_native_codex_state(home).await?),
            None => None,
        }
    } else {
        None
    };
    Ok(project_with_native(&store, agent_id, native.as_ref()))
}

pub(super) async fn resolve_probe_api_key(
    store_path: &Path,
    agent_id: &AgentId,
    provider_id: Option<&str>,
    submitted_api_key: Option<&str>,
) -> Result<String, String> {
    validate_agent(agent_id)?;
    if let Some(api_key) = submitted_api_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(api_key.to_string());
    }
    let provider_id = provider_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "读取 Provider 模型需要填写 API Key".to_string())?;
    let store = read_store(store_path).await?;
    store
        .providers
        .iter()
        .find(|provider| provider.id == provider_id && &provider.agent_id == agent_id)
        .map(|provider| provider.api_key.clone())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "找不到可用于模型探测的 Provider 凭据".to_string())
}

pub(super) async fn save(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    request: AgentModelProviderSaveRequest,
) -> Result<AgentModelProvidersView, String> {
    let homes = ProviderNativeHomes::resolve(home, environment);
    validate_request(&request)?;
    let mut store = read_store(store_path).await?;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing = store
        .providers
        .iter()
        .position(|provider| provider.id == id);
    if let Some(index) = existing
        && store.providers[index].agent_id != request.agent_id
    {
        return Err("Model Provider 的 Agent 类型不能更改".to_string());
    }
    let prior_key = existing
        .map(|index| store.providers[index].api_key.clone())
        .unwrap_or_default();
    let api_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(prior_key);
    if api_key.is_empty() {
        return Err("Model Provider 需要 API Key".to_string());
    }
    let provider = StoredProvider {
        id: id.clone(),
        name: request.name.trim().to_string(),
        agent_id: request.agent_id.clone(),
        api_url: request.api_url.trim().to_string(),
        api_key,
        model: request.model.trim().to_string(),
    };
    match existing {
        Some(index) => store.providers[index] = provider.clone(),
        None => store.providers.push(provider.clone()),
    }
    if store.bindings.get(request.agent_id.as_str()) == Some(&id) {
        let rollback = capture_projection(&homes, &request.agent_id).await?;
        if let Err(error) =
            apply_provider(&homes, &provider, &codex_catalog_cache(store_path)).await
        {
            restore_projection(&homes, &request.agent_id, &rollback).await?;
            return Err(error);
        }
        if let Err(error) = write_store(store_path, &store).await {
            restore_projection(&homes, &request.agent_id, &rollback).await?;
            return Err(error);
        }
    } else {
        write_store(store_path, &store).await?;
    }
    projected_view(&store, &homes, request.agent_id).await
}

pub(super) async fn bind(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    provider_id: Option<String>,
) -> Result<AgentModelProvidersView, String> {
    validate_agent(&agent_id)?;
    let homes = ProviderNativeHomes::resolve(home, environment);
    let mut store = read_store(store_path).await?;
    let current_binding = store.bindings.get(agent_id.as_str()).cloned();
    let rollback = capture_projection(&homes, &agent_id).await?;
    if let Some(provider_id) = provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let provider = store
            .providers
            .iter()
            .find(|provider| provider.id == provider_id && provider.agent_id == agent_id)
            .ok_or_else(|| "找不到可绑定的 Model Provider".to_string())?;
        if current_binding.is_none() {
            store
                .projection_backups
                .insert(agent_id.as_str().to_string(), rollback.clone());
            // Persist the recovery point before touching any Agent-owned file.
            write_store(store_path, &store).await?;
        }
        if let Err(error) = apply_provider(&homes, provider, &codex_catalog_cache(store_path)).await
        {
            restore_projection(&homes, &agent_id, &rollback).await?;
            if current_binding.is_none() {
                store.projection_backups.remove(agent_id.as_str());
                write_store(store_path, &store).await?;
            }
            return Err(error);
        }
        store
            .bindings
            .insert(agent_id.as_str().to_string(), provider_id.to_string());
    } else {
        if current_binding.is_none() {
            return projected_view(&store, &homes, agent_id).await;
        }
        let backup = store
            .projection_backups
            .get(agent_id.as_str())
            .cloned()
            .unwrap_or_else(|| empty_projection_backup(&agent_id));
        restore_projection(&homes, &agent_id, &backup).await?;
        store.bindings.remove(agent_id.as_str());
        store.projection_backups.remove(agent_id.as_str());
    }
    if let Err(error) = write_store(store_path, &store).await {
        restore_projection(&homes, &agent_id, &rollback).await?;
        return Err(error);
    }
    projected_view(&store, &homes, agent_id).await
}

pub(super) async fn delete(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    provider_id: &str,
) -> Result<AgentModelProvidersView, String> {
    validate_agent(&agent_id)?;
    let homes = ProviderNativeHomes::resolve(home, environment);
    let mut store = read_store(store_path).await?;
    let bound = store.bindings.get(agent_id.as_str()).cloned();
    // 其它 Agent 不可能绑定本 Agent 的 Provider（bind 会校验归属），此处保留
    // 防御性检查：只有当前 Agent 的绑定会在下方随删除一起解除。
    if bound.as_deref() != Some(provider_id)
        && store.bindings.values().any(|value| value == provider_id)
    {
        return Err("Model Provider 正在使用中，请先解除绑定".to_string());
    }
    // 删除当前绑定的 Provider 时先恢复原生投影并移除绑定，与 bind 一样在单次
    // 写盘内完成：写盘失败时回滚投影，不会留下"已解绑但未删除"的中间状态。
    let rollback = if bound.as_deref() == Some(provider_id) {
        let rollback = capture_projection(&homes, &agent_id).await?;
        let backup = store
            .projection_backups
            .get(agent_id.as_str())
            .cloned()
            .unwrap_or_else(|| empty_projection_backup(&agent_id));
        restore_projection(&homes, &agent_id, &backup).await?;
        store.bindings.remove(agent_id.as_str());
        store.projection_backups.remove(agent_id.as_str());
        Some(rollback)
    } else {
        None
    };
    let before = store.providers.len();
    store
        .providers
        .retain(|provider| provider.id != provider_id || provider.agent_id != agent_id);
    if store.providers.len() == before {
        return Err("找不到要删除的 Model Provider".to_string());
    }
    if let Err(error) = write_store(store_path, &store).await {
        if let Some(rollback) = rollback {
            restore_projection(&homes, &agent_id, &rollback).await?;
        }
        return Err(error);
    }
    projected_view(&store, &homes, agent_id).await
}

fn project(store: &ProviderStore, agent_id: AgentId) -> AgentModelProvidersView {
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

/// 在 VibeX 预设视图之上合并原生 Codex Provider。启用某个 VibeX 预设后
/// 仍保留 `config.toml` 里的其它原生表，只把绑定态交给当前生效的那一项。
fn project_with_native(
    store: &ProviderStore,
    agent_id: AgentId,
    native: Option<&NativeCodexState>,
) -> AgentModelProvidersView {
    let mut view = project(store, agent_id.clone());
    if agent_id.as_str() != "codex" {
        return view;
    }
    let Some(native) = native else {
        return view;
    };
    let managed_bound = view.bound_provider_id.is_some();
    let existing_ids = view
        .providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect::<HashSet<_>>();
    for provider in &native.providers {
        if provider.id == "vibex" || existing_ids.contains(&provider.id) {
            continue;
        }
        let bound =
            !managed_bound && native.active_provider.as_deref() == Some(provider.id.as_str());
        view.providers.push(AgentModelProviderView {
            id: provider.id.clone(),
            name: provider.name.clone(),
            agent_id: agent_id.clone(),
            api_url: provider.api_url.clone(),
            model: native.model.clone().unwrap_or_default(),
            credential_present: native.credential_present,
            bound,
            managed: false,
        });
        if bound {
            view.bound_provider_id = Some(provider.id.clone());
        }
    }
    if !managed_bound
        && view.bound_provider_id.is_none()
        && let Some(active) = native.active_provider.as_deref()
        && !existing_ids.contains(active)
    {
        view.providers.push(AgentModelProviderView {
            id: active.to_string(),
            name: active.to_string(),
            agent_id: agent_id.clone(),
            api_url: native.base_url.clone().unwrap_or_default(),
            model: native.model.clone().unwrap_or_default(),
            credential_present: native.credential_present,
            bound: true,
            managed: false,
        });
        view.bound_provider_id = Some(active.to_string());
    }
    if !managed_bound
        && view.bound_provider_id.is_none()
        && let Some(base_url) = native
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
    {
        view.providers.push(AgentModelProviderView {
            id: NATIVE_ENDPOINT_PROVIDER_ID.to_string(),
            name: "原生端点".to_string(),
            agent_id: agent_id.clone(),
            api_url: base_url.to_string(),
            model: native.model.clone().unwrap_or_default(),
            credential_present: native.credential_present,
            bound: true,
            managed: false,
        });
        view.bound_provider_id = Some(NATIVE_ENDPOINT_PROVIDER_ID.to_string());
    }
    view.providers
        .sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    view
}

async fn projected_view(
    store: &ProviderStore,
    homes: &ProviderNativeHomes,
    agent_id: AgentId,
) -> Result<AgentModelProvidersView, String> {
    let native = if agent_id.as_str() == "codex" {
        Some(read_native_codex_state(&homes.codex).await?)
    } else {
        None
    };
    Ok(project_with_native(store, agent_id, native.as_ref()))
}

/// 只读解析 Codex 原生配置的 Provider 状态，不修改任何文件。
pub(super) async fn read_native_codex_state(codex_home: &Path) -> Result<NativeCodexState, String> {
    let mut state = NativeCodexState::default();
    // 原生识别是辅助视图：config.toml 损坏时降级为空状态，不影响 VibeX 预设
    // 的列表与绑定流程。
    let table = match read_toml_table(&codex_home.join("config.toml")).await {
        Ok(table) => table,
        Err(_) => toml::Table::new(),
    };
    state.active_provider = table
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "vibex")
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
            if id == "vibex" {
                continue;
            }
            let Some(provider) = value.as_table() else {
                continue;
            };
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
                model: state.model.clone().unwrap_or_default(),
            });
        }
    }
    let auth = read_json_object_or_empty(&codex_home.join("auth.json"))
        .await
        .map_err(|error| error.message)?;
    state.credential_present = auth
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    Ok(state)
}

async fn read_store(path: &Path) -> Result<ProviderStore, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Model Provider 存储文件无效：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProviderStore::default()),
        Err(error) => Err(format!("读取 Model Provider 失败：{error}")),
    }
}

async fn write_store(path: &Path, store: &ProviderStore) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("序列化 Model Provider 失败：{error}"))?;
    write_bytes_document(path, &bytes, true)
        .await
        .map_err(|error| error.message)
}

fn validate_agent(agent_id: &AgentId) -> Result<(), String> {
    if matches!(
        agent_id.as_str(),
        "claude_code" | "codex" | "grok" | "kimi_code" | "hermes" | "openclaw" | "cline"
    ) || is_antigravity(agent_id)
    {
        Ok(())
    } else {
        Err("此 Agent 不支持可复用 Model Provider".to_string())
    }
}

fn validate_request(request: &AgentModelProviderSaveRequest) -> Result<(), String> {
    validate_agent(&request.agent_id)?;
    if request.name.trim().is_empty() {
        return Err("Model Provider 名称不能为空".to_string());
    }
    if request.api_url.trim().is_empty() {
        return Err("Model Provider API URL 不能为空".to_string());
    }
    let url = url::Url::parse(request.api_url.trim())
        .map_err(|error| format!("Model Provider API URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Model Provider API URL 必须是无内嵌凭据的 http(s) 地址".to_string());
    }
    Ok(())
}

pub(super) async fn preview_import(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
) -> Result<AgentModelProviderImportPreviewView, String> {
    if source != AgentModelProviderImportSource::CcSwitch
        || super::model_provider_import::cc_switch_app_type(&agent_id).is_none()
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

pub(super) async fn apply_import(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
    source_ids: &[String],
) -> Result<AgentModelProvidersView, String> {
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
        return Err("没有可导入的供应商".to_string());
    }
    list_with_native(
        store_path,
        agent_id,
        Some(&ProviderNativeHomes::resolve(home, environment).codex),
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

async fn native_import_drafts(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
    existing_names: &[String],
) -> Result<Vec<ImportDraft>, String> {
    let homes = ProviderNativeHomes::resolve(home, environment);
    let mut drafts = Vec::new();
    match agent_id.as_str() {
        "claude_code" => {
            if let Some(draft) = native_claude_draft(&homes.claude).await? {
                drafts.push(draft);
            }
        }
        "codex" => {
            drafts.extend(native_codex_drafts(&homes.codex).await?);
        }
        "grok" => drafts.extend(native_grok_drafts(&homes.grok).await?),
        "kimi_code" => {
            if let Some(draft) = native_kimi_draft(&homes.kimi).await? {
                drafts.push(draft);
            }
        }
        _ if is_antigravity(agent_id) => {
            if let Some(draft) = native_gemini_draft(&homes.gemini, agent_id).await? {
                drafts.push(draft);
            }
        }
        _ => {}
    }
    Ok(drafts
        .into_iter()
        .map(|mut draft| {
            if draft.skip_reason.is_none() && (draft.api_url.is_empty() || draft.api_key.is_empty())
            {
                draft.skip_reason = Some("缺少端点或凭据".to_string());
            }
            annotate_duplicate(draft, existing_names)
        })
        .collect())
}

async fn native_claude_draft(claude_home: &Path) -> Result<Option<ImportDraft>, String> {
    let document = read_json_object_or_empty(&claude_home.join("settings.json"))
        .await
        .map_err(|error| error.message)?;
    let env = document
        .get("env")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let api_url = json_text(&env, &["ANTHROPIC_BASE_URL"]);
    let api_key = json_text(&env, &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    if api_url.is_empty() && api_key.is_empty() {
        return Ok(None);
    }
    let mut mapping = serde_json::Map::new();
    for (source, key) in [
        ("main", "ANTHROPIC_MODEL"),
        ("reasoning", "ANTHROPIC_REASONING_MODEL"),
        ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
        ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
        ("customOption", "ANTHROPIC_CUSTOM_MODEL_OPTION"),
        ("customOptionName", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
        (
            "customOptionDescription",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
        ),
    ] {
        let value = json_text(&env, &[key]);
        if !value.is_empty() {
            mapping.insert(source.to_string(), Value::String(value));
        }
    }
    Ok(Some(ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key,
        model: if mapping.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&mapping).unwrap_or_default()
        },
        skip_reason: None,
    }))
}

async fn native_gemini_draft(
    gemini_home: &Path,
    agent_id: &AgentId,
) -> Result<Option<ImportDraft>, String> {
    let path = if agent_id.as_str() == "gemini" {
        gemini_home.join("settings.json")
    } else {
        antigravity_settings_path(gemini_home)
    };
    let document = read_json_object_or_empty(&path)
        .await
        .map_err(|error| error.message)?;
    let env = document
        .get("env")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let api_url = json_text(
        &env,
        &["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "API_BASE_URL"],
    );
    let api_key = json_text(
        &env,
        &["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"],
    );
    if api_url.is_empty() && api_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key,
        model: json_text(&env, &["GEMINI_MODEL"]),
        skip_reason: None,
    }))
}

async fn native_grok_drafts(grok_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let table = read_toml_table(&grok_home.join("config.toml")).await?;
    let Some(models) = table.get("model").and_then(toml::Value::as_table) else {
        return Ok(Vec::new());
    };
    let mut drafts = Vec::new();
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
        let backend = entry
            .get("api_backend")
            .and_then(toml::Value::as_str)
            .unwrap_or("responses");
        let context = entry
            .get("context_window")
            .and_then(toml::Value::as_integer);
        drafts.push(ImportDraft {
            source_id: format!("native:{id}"),
            name: entry
                .get("name")
                .and_then(toml::Value::as_str)
                .unwrap_or(id)
                .to_string(),
            api_url,
            api_key,
            model: serde_json::json!({
                "id": model_id,
                "api_backend": backend,
                "context_window": context
            })
            .to_string(),
            skip_reason: None,
        });
    }
    Ok(drafts)
}

async fn native_kimi_draft(kimi_home: &Path) -> Result<Option<ImportDraft>, String> {
    let table = read_toml_table(&kimi_home.join("config.toml")).await?;
    let provider = table
        .get("providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get("vibex"))
        .and_then(toml::Value::as_table);
    let Some(provider) = provider else {
        return Ok(None);
    };
    let api_url = provider
        .get("base_url")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let api_key = provider
        .get("api_key")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if api_url.is_empty() && api_key.is_empty() {
        return Ok(None);
    }
    let model = table
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get("vibex"))
        .and_then(toml::Value::as_table)
        .and_then(|model| model.get("model"))
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(Some(ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key,
        model,
        skip_reason: None,
    }))
}

async fn native_codex_drafts(codex_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let state = read_native_codex_state(codex_home).await?;
    let key = if state.credential_present {
        read_json_object_or_empty(&codex_home.join("auth.json"))
            .await
            .map_err(|error| error.message)?
            .get("OPENAI_API_KEY")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    let mut drafts = Vec::new();
    for provider in state.providers {
        drafts.push(ImportDraft {
            source_id: provider.id.clone(),
            name: provider.name,
            api_url: provider.api_url,
            api_key: key.clone(),
            model: if provider.model.is_empty() {
                String::new()
            } else {
                serde_json::json!({ "default_model": provider.model }).to_string()
            },
            skip_reason: None,
        });
    }
    if drafts.is_empty() {
        if let (Some(url), Some(model)) = (state.base_url, state.model) {
            drafts.push(ImportDraft {
                source_id: NATIVE_ENDPOINT_PROVIDER_ID.to_string(),
                name: "当前原生配置".to_string(),
                api_url: url,
                api_key: key,
                model: serde_json::json!({ "default_model": model }).to_string(),
                skip_reason: None,
            });
        }
    }
    Ok(drafts)
}

fn json_text(value: &Value, keys: &[&str]) -> String {
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

pub(super) async fn resolve_probe_target(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
    provider_id: Option<&str>,
    api_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(url) = api_url.map(str::trim).filter(|value| !value.is_empty()) {
        let key = resolve_probe_api_key(store_path, agent_id, provider_id, api_key).await?;
        return Ok((url.to_string(), key));
    }
    let provider_id = provider_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "测试连接需要 Provider".to_string())?;
    let homes = ProviderNativeHomes::resolve(home, environment);
    let view = list_with_native(store_path, agent_id.clone(), Some(&homes.codex)).await?;
    let provider = view
        .providers
        .iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| "找不到要测试的 Provider".to_string())?;
    if provider.api_url.is_empty() {
        return Err("Provider 没有可测试的 API URL".to_string());
    }
    if provider.managed {
        let key = resolve_probe_api_key(store_path, agent_id, Some(provider_id), api_key).await?;
        return Ok((provider.api_url.clone(), key));
    }
    let drafts = native_import_drafts(home, environment, agent_id, &[]).await?;
    let key = drafts
        .into_iter()
        .find(|draft| draft.source_id == provider_id)
        .map(|draft| draft.api_key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "找不到可用于测试的 Provider 凭据".to_string())?;
    Ok((provider.api_url.clone(), key))
}

const CLAUDE_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "API_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
];
const GEMINI_ENV_KEYS: &[&str] = &[
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_BASE_URL",
    "API_BASE_URL",
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GEMINI_MODEL",
];
const CODEX_AUTH_KEYS: &[&str] = &["OPENAI_API_KEY", "auth_mode"];
const CODEX_CONFIG_KEYS: &[&str] = &[
    "api_base_url",
    "openai_base_url",
    "model_provider",
    "model",
    "model_catalog_json",
];
const CODEX_PROVIDER_ENTRY_BACKUP_KEY: &str = "model_providers.vibex";
const CODEX_CATALOG_FILE: &str = "vibex-model-catalog.json";
const CODEX_SOURCE_FILE: &str = "vibex-model-catalog.source.json";

async fn capture_projection(
    homes: &ProviderNativeHomes,
    agent_id: &AgentId,
) -> Result<ProviderProjectionBackup, String> {
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
            capture_text_file(
                &homes.codex.join(CODEX_CATALOG_FILE),
                CODEX_CATALOG_FILE,
                &mut backup,
            )
            .await?;
            capture_text_file(
                &homes.codex.join(CODEX_SOURCE_FILE),
                CODEX_SOURCE_FILE,
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
        "grok" => {
            capture_text_file(&homes.grok.join("config.toml"), "config.toml", &mut backup).await?;
        }
        "kimi_code" => {
            capture_text_file(&homes.kimi.join("config.toml"), "config.toml", &mut backup).await?;
            capture_text_file(
                &homes.kimi.join("credentials/kimi-code.json"),
                "credentials/kimi-code.json",
                &mut backup,
            )
            .await?;
        }
        "hermes" => {
            capture_text_file(
                &homes.hermes.join("config.yaml"),
                "config.yaml",
                &mut backup,
            )
            .await?;
        }
        "openclaw" => {
            capture_text_file(
                &homes.openclaw.join("openclaw.json"),
                "openclaw.json",
                &mut backup,
            )
            .await?;
        }
        "cline" => {
            capture_text_file(
                &homes.cline.join("globalState.json"),
                "globalState.json",
                &mut backup,
            )
            .await?;
            capture_text_file(
                &homes.cline.join("secrets.json"),
                "secrets.json",
                &mut backup,
            )
            .await?;
        }
        _ => unreachable!("validated Agent"),
    }
    Ok(backup)
}

fn empty_projection_backup(agent_id: &AgentId) -> ProviderProjectionBackup {
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
    for key in match agent_id.as_str() {
        "grok" => ["config.toml"].as_slice(),
        "kimi_code" => ["config.toml", "credentials/kimi-code.json"].as_slice(),
        "hermes" => ["config.yaml"].as_slice(),
        "openclaw" => ["openclaw.json"].as_slice(),
        "cline" => ["globalState.json", "secrets.json"].as_slice(),
        _ => [].as_slice(),
    } {
        backup.file_values.insert((*key).to_string(), None);
    }
    backup
}

async fn capture_json_env(
    path: &Path,
    keys: &[&str],
    backup: &mut ProviderProjectionBackup,
) -> Result<(), String> {
    let document = read_json_object_or_empty(path)
        .await
        .map_err(|error| error.message)?;
    let env = match document.get("env") {
        Some(Value::Object(env)) => Some(env),
        Some(_) => return Err("原生配置字段 `env` 必须是对象".to_string()),
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

async fn capture_json_root(
    path: &Path,
    keys: &[&str],
    backup: &mut ProviderProjectionBackup,
) -> Result<(), String> {
    let document = read_json_object_or_empty(path)
        .await
        .map_err(|error| error.message)?;
    for key in keys {
        backup
            .json_values
            .insert((*key).to_string(), document.get(*key).cloned());
    }
    Ok(())
}

async fn capture_codex_toml(
    path: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), String> {
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

async fn capture_text_file(
    path: &Path,
    key: &str,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), String> {
    let value = match tokio::fs::read_to_string(path).await {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display())),
    };
    backup.file_values.insert(key.to_string(), value);
    Ok(())
}

async fn restore_projection(
    homes: &ProviderNativeHomes,
    agent_id: &AgentId,
    backup: &ProviderProjectionBackup,
) -> Result<(), String> {
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
        "grok" => {
            restore_text_file(&homes.grok.join("config.toml"), "config.toml", backup, true).await
        }
        "kimi_code" => {
            restore_text_file(&homes.kimi.join("config.toml"), "config.toml", backup, true).await?;
            restore_text_file(
                &homes.kimi.join("credentials/kimi-code.json"),
                "credentials/kimi-code.json",
                backup,
                true,
            )
            .await
        }
        "hermes" => {
            restore_text_file(
                &homes.hermes.join("config.yaml"),
                "config.yaml",
                backup,
                true,
            )
            .await
        }
        "openclaw" => {
            restore_text_file(
                &homes.openclaw.join("openclaw.json"),
                "openclaw.json",
                backup,
                true,
            )
            .await
        }
        "cline" => {
            restore_text_file(
                &homes.cline.join("globalState.json"),
                "globalState.json",
                backup,
                false,
            )
            .await?;
            restore_text_file(
                &homes.cline.join("secrets.json"),
                "secrets.json",
                backup,
                true,
            )
            .await
        }
        _ => validate_agent(agent_id),
    }
}

async fn restore_text_file(
    path: &Path,
    key: &str,
    backup: &ProviderProjectionBackup,
    sensitive: bool,
) -> Result<(), String> {
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(path).await.map_err(|error| error.message)?;
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

async fn restore_codex_projection(
    codex_home: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), String> {
    let filesystem = TokioNativeFileSystem;
    let auth_path = codex_home.join("auth.json");
    let config_path = codex_home.join("config.toml");
    let catalog_path = codex_home.join(CODEX_CATALOG_FILE);
    let source_path = codex_home.join(CODEX_SOURCE_FILE);
    let auth_original = filesystem
        .read(&auth_path)
        .await
        .map_err(|error| error.message)?;
    let config_original = filesystem
        .read(&config_path)
        .await
        .map_err(|error| error.message)?;
    let catalog_original = filesystem
        .read(&catalog_path)
        .await
        .map_err(|error| error.message)?;
    let source_original = filesystem
        .read(&source_path)
        .await
        .map_err(|error| error.message)?;

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

async fn restore_json_env(
    path: &Path,
    keys: &[&str],
    backup: &ProviderProjectionBackup,
    sensitive: bool,
) -> Result<(), String> {
    let mut document = read_json_object_or_empty(path)
        .await
        .map_err(|error| error.message)?;
    let env = object_entry(document.as_object_mut().expect("object"), "env")?;
    restore_json_values(env, keys, backup);
    write_json(path, &document, sensitive).await
}

fn restore_json_values(
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

fn restore_codex_toml_values(
    table: &mut toml::Table,
    backup: &ProviderProjectionBackup,
) -> Result<(), String> {
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
        let providers = providers
            .as_table_mut()
            .ok_or_else(|| "Codex model_providers 必须是表".to_string())?;
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

async fn read_toml_table(path: &Path) -> Result<toml::Table, String> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display())),
    };
    if text.trim().is_empty() {
        Ok(toml::Table::new())
    } else {
        toml::from_str(&text).map_err(|error| format!("{} 无效：{error}", path.display()))
    }
}

#[cfg(test)]
async fn write_toml_table(path: &Path, table: &toml::Table) -> Result<(), String> {
    let bytes = toml::to_string_pretty(table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 {} 失败：{error}", path.display()))?;
    write_bytes_document(path, &bytes, false)
        .await
        .map_err(|error| error.message)
}

fn codex_catalog_cache(store_path: &Path) -> std::path::PathBuf {
    store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("agent-catalogs")
        .join("codex-bundled.json")
}

async fn apply_provider(
    homes: &ProviderNativeHomes,
    provider: &StoredProvider,
    codex_cache_path: &Path,
) -> Result<(), String> {
    match provider.agent_id.as_str() {
        "claude_code" => apply_claude(&homes.claude, provider).await,
        "codex" => apply_codex(&homes.codex, provider, codex_cache_path).await,
        "gemini" => apply_gemini(&homes.gemini, provider).await,
        "grok" => apply_grok(&homes.grok, provider).await,
        "kimi_code" => apply_kimi(&homes.kimi, provider).await,
        "hermes" => apply_hermes(&homes.hermes, provider).await,
        "openclaw" => apply_openclaw(&homes.openclaw, provider).await,
        "cline" => apply_cline(&homes.cline, provider).await,
        _ if is_antigravity(&provider.agent_id) => apply_antigravity(&homes.gemini, provider).await,
        _ => validate_agent(&provider.agent_id),
    }
}

async fn apply_claude(claude_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = claude_home.join("settings.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut document = parse_json_object_bytes(&path, original.as_deref())?;
    let env = object_entry(document.as_object_mut().expect("object"), "env")?;
    for key in [
        "OPENAI_BASE_URL",
        "API_BASE_URL",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
    ] {
        env.remove(key);
    }
    insert_string(env, "ANTHROPIC_BASE_URL", &provider.api_url);
    insert_string(env, "ANTHROPIC_AUTH_TOKEN", &provider.api_key);
    let model = parse_model(&provider.model);
    let mappings = [
        ("main", "ANTHROPIC_MODEL"),
        ("reasoning", "ANTHROPIC_REASONING_MODEL"),
        ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
        ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
        ("customOption", "ANTHROPIC_CUSTOM_MODEL_OPTION"),
        ("customOptionName", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
        (
            "customOptionDescription",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
        ),
    ];
    if let Some(object) = model.as_object() {
        for (source, target) in mappings {
            insert_string(
                env,
                target,
                object
                    .get(source)
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
        }
    } else if let Some(model) = model.as_str() {
        for (_, target) in mappings {
            env.remove(target);
        }
        insert_string(env, "ANTHROPIC_MODEL", model);
    }
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("序列化原生配置失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}

async fn apply_codex(
    codex_home: &Path,
    provider: &StoredProvider,
    codex_cache_path: &Path,
) -> Result<(), String> {
    let filesystem = TokioNativeFileSystem;
    let auth_path = codex_home.join("auth.json");
    let auth_original = filesystem
        .read(&auth_path)
        .await
        .map_err(|error| error.message)?;
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
    let config_original = filesystem
        .read(&config_path)
        .await
        .map_err(|error| error.message)?;
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
    let (catalog_replacement, source_replacement, active) = if let Some(request) = structured {
        let official = super::model_catalogs::codex_official_document(None, codex_cache_path)
            .await
            .map_err(|error| format!("应用 Codex Provider 模型清单失败：{error}"))?;
        let (active, catalog, source) =
            super::model_catalogs::build_codex_catalog_files(&official, &request)?;
        (catalog, source, active)
    } else {
        (None, None, false)
    };
    if active {
        table.insert(
            "model_catalog_json".to_string(),
            toml::Value::String(CODEX_CATALOG_FILE.to_string()),
        );
    } else {
        table.remove("model_catalog_json");
    }
    let catalog_path = codex_home.join(CODEX_CATALOG_FILE);
    let source_path = codex_home.join(CODEX_SOURCE_FILE);
    let catalog_original = filesystem
        .read(&catalog_path)
        .await
        .map_err(|error| error.message)?;
    let source_original = filesystem
        .read(&source_path)
        .await
        .map_err(|error| error.message)?;
    let auth_bytes = serde_json::to_vec_pretty(&auth)
        .map_err(|error| format!("序列化 Codex auth.json 失败：{error}"))?;
    let config_bytes = toml::to_string_pretty(&table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 Codex config.toml 失败：{error}"))?;
    apply_projection_mutations(&[
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
        NativeFileMutation {
            path: catalog_path,
            expected: catalog_original,
            replacement: catalog_replacement,
            sensitive: false,
        },
        NativeFileMutation {
            path: source_path,
            expected: source_original,
            replacement: source_replacement,
            sensitive: false,
        },
    ])
    .await
}

const ANTIGRAVITY_AUTH_TYPE_BACKUP_KEY: &str = "auth.type";

async fn capture_antigravity_auth_type(
    path: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), String> {
    let document = read_json_object_or_empty(path)
        .await
        .map_err(|error| error.message)?;
    backup.json_values.insert(
        ANTIGRAVITY_AUTH_TYPE_BACKUP_KEY.to_string(),
        document
            .get("auth")
            .and_then(Value::as_object)
            .and_then(|auth| auth.get("type"))
            .cloned(),
    );
    Ok(())
}

async fn restore_antigravity_auth_type(
    path: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), String> {
    let mut document = read_json_object_or_empty(path)
        .await
        .map_err(|error| error.message)?;
    let auth = object_entry(document.as_object_mut().expect("object"), "auth")?;
    match backup
        .json_values
        .get(ANTIGRAVITY_AUTH_TYPE_BACKUP_KEY)
        .cloned()
        .flatten()
    {
        Some(value) => {
            auth.insert("type".to_string(), value);
        }
        None => {
            auth.remove("type");
            if auth.is_empty() {
                document.as_object_mut().expect("object").remove("auth");
            }
        }
    }
    write_json(path, &document, true).await
}

async fn apply_antigravity(gemini_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = antigravity_settings_path(gemini_home);
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut document = parse_json_object_bytes(&path, original.as_deref())?;
    let root = document.as_object_mut().expect("object");
    let auth = object_entry(root, "auth")?;
    auth.insert(
        "type".to_string(),
        Value::String("gemini-api-key".to_string()),
    );
    let env = object_entry(root, "env")?;
    for key in GEMINI_ENV_KEYS {
        env.remove(*key);
    }
    insert_string(env, "GOOGLE_GEMINI_BASE_URL", &provider.api_url);
    insert_string(env, "GEMINI_API_KEY", &provider.api_key);
    insert_string(env, "GEMINI_MODEL", &model_default(&provider.model));
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("序列化原生配置失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}

struct GrokModelSpec {
    id: String,
    api_backend: String,
    context_window: Option<i64>,
}

fn grok_spec(raw: &str) -> GrokModelSpec {
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(raw) {
        return GrokModelSpec {
            id: object
                .get("id")
                .or_else(|| object.get("model"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            api_backend: object
                .get("api_backend")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("responses")
                .to_string(),
            context_window: object.get("context_window").and_then(Value::as_i64),
        };
    }
    GrokModelSpec {
        id: raw.trim().to_string(),
        api_backend: "responses".to_string(),
        context_window: None,
    }
}

fn toml_table_entry<'a>(
    table: &'a mut toml::Table,
    key: &str,
) -> Result<&'a mut toml::Table, String> {
    let entry = table
        .entry(key.to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    if !entry.is_table() {
        *entry = toml::Value::Table(toml::Table::new());
    }
    entry
        .as_table_mut()
        .ok_or_else(|| format!("{key} 必须是表"))
}

async fn write_toml_mutation(
    path: &Path,
    original: Option<Vec<u8>>,
    table: &toml::Table,
    sensitive: bool,
) -> Result<(), String> {
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

async fn apply_grok(grok_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = grok_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    let spec = grok_spec(&provider.model);
    let models = toml_table_entry(&mut table, "models")?;
    models.insert(
        "default".to_string(),
        toml::Value::String("vibex".to_string()),
    );
    let model_root = toml_table_entry(&mut table, "model")?;
    let vibex = toml_table_entry(model_root, "vibex")?;
    vibex.insert(
        "model".to_string(),
        toml::Value::String(if spec.id.is_empty() {
            provider.name.clone()
        } else {
            spec.id
        }),
    );
    vibex.insert(
        "base_url".to_string(),
        toml::Value::String(provider.api_url.clone()),
    );
    vibex.insert(
        "name".to_string(),
        toml::Value::String(provider.name.clone()),
    );
    vibex.insert(
        "api_key".to_string(),
        toml::Value::String(provider.api_key.clone()),
    );
    vibex.insert(
        "api_backend".to_string(),
        toml::Value::String(spec.api_backend),
    );
    if let Some(context) = spec.context_window {
        vibex.insert("context_window".to_string(), toml::Value::Integer(context));
    }
    write_toml_mutation(&path, original, &table, true).await
}

async fn apply_kimi(kimi_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = kimi_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    table.insert(
        "default_model".to_string(),
        toml::Value::String("vibex".to_string()),
    );
    let providers = toml_table_entry(&mut table, "providers")?;
    let vibex_provider = toml_table_entry(providers, "vibex")?;
    vibex_provider.insert(
        "type".to_string(),
        toml::Value::String("openai".to_string()),
    );
    vibex_provider.insert(
        "base_url".to_string(),
        toml::Value::String(provider.api_url.clone()),
    );
    vibex_provider.insert(
        "api_key".to_string(),
        toml::Value::String(provider.api_key.clone()),
    );
    let models = toml_table_entry(&mut table, "models")?;
    let vibex_model = toml_table_entry(models, "vibex")?;
    vibex_model.insert(
        "provider".to_string(),
        toml::Value::String("vibex".to_string()),
    );
    vibex_model.insert(
        "model".to_string(),
        toml::Value::String(model_default(&provider.model)),
    );
    vibex_model
        .entry("max_context_size".to_string())
        .or_insert(toml::Value::Integer(262_144));
    write_toml_mutation(&path, original, &table, true).await?;
    seed_kimi_gate_credential(&kimi_home.join("credentials/kimi-code.json")).await
}

async fn seed_kimi_gate_credential(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("创建 Kimi credentials 失败：{error}"))?;
    }
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(path).await.map_err(|error| error.message)?;
    if let Some(bytes) = original.as_deref().filter(|bytes| !bytes.is_empty())
        && let Ok(existing) = serde_json::from_slice::<Value>(bytes)
        && existing.get("_vibex_synthetic") != Some(&Value::Bool(true))
        && existing
            .get("access_token")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.trim().is_empty())
    {
        return Ok(());
    }
    apply_projection_mutations(&[NativeFileMutation {
        path: path.to_path_buf(),
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&serde_json::json!({
                "access_token": "vibex-local-gate",
                "_vibex_synthetic": true
            }))
            .map_err(|error| format!("序列化 Kimi credential 失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}

async fn apply_hermes(hermes_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = hermes_home.join("config.yaml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut document: serde_yaml::Value = match original.as_deref() {
        Some(bytes) if !bytes.is_empty() => serde_yaml::from_slice(bytes)
            .map_err(|error| format!("{} 无效：{error}", path.display()))?,
        _ => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Hermes config.yaml 顶层必须是对象".to_string())?;
    let model_key = serde_yaml::Value::String("model".to_string());
    if !root
        .get(&model_key)
        .is_some_and(serde_yaml::Value::is_mapping)
    {
        root.insert(
            model_key.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    let model = root
        .get_mut(&model_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| "Hermes model 必须是对象".to_string())?;
    model.insert(
        serde_yaml::Value::String("provider".to_string()),
        serde_yaml::Value::String("custom".to_string()),
    );
    model.insert(
        serde_yaml::Value::String("default".to_string()),
        serde_yaml::Value::String(model_default(&provider.model)),
    );
    model.insert(
        serde_yaml::Value::String("base_url".to_string()),
        serde_yaml::Value::String(provider.api_url.clone()),
    );
    model.insert(
        serde_yaml::Value::String("api_key".to_string()),
        serde_yaml::Value::String(provider.api_key.clone()),
    );
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_yaml::to_string(&document)
                .map_err(|error| format!("序列化 Hermes 配置失败：{error}"))?
                .into_bytes(),
        ),
        sensitive: true,
    }])
    .await
}

async fn apply_openclaw(openclaw_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = openclaw_home.join("openclaw.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut document = parse_json_object_bytes(&path, original.as_deref())?;
    let root = document.as_object_mut().expect("object");
    let agents = object_entry(root, "agents")?;
    let defaults = object_entry(agents, "defaults")?;
    let model = object_entry(defaults, "model")?;
    model.insert(
        "primary".to_string(),
        Value::String(format!("vibex/{}", model_default(&provider.model))),
    );
    let models = object_entry(root, "models")?;
    models.insert("mode".to_string(), Value::String("merge".to_string()));
    let providers = object_entry(models, "providers")?;
    providers.insert(
        "vibex".to_string(),
        serde_json::json!({
            "baseUrl": provider.api_url,
            "apiKey": provider.api_key,
            "api": "openai-completions",
            "models": [{
                "id": model_default(&provider.model),
                "name": provider.name
            }]
        }),
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

async fn apply_cline(cline_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let state_path = cline_home.join("globalState.json");
    let secrets_path = cline_home.join("secrets.json");
    let filesystem = TokioNativeFileSystem;
    let state_original = filesystem
        .read(&state_path)
        .await
        .map_err(|error| error.message)?;
    let secrets_original = filesystem
        .read(&secrets_path)
        .await
        .map_err(|error| error.message)?;
    let mut state = parse_json_object_bytes(&state_path, state_original.as_deref())?;
    let mut secrets = parse_json_object_bytes(&secrets_path, secrets_original.as_deref())?;
    let state_root = state.as_object_mut().expect("object");
    insert_string(state_root, "apiProvider", "openai");
    insert_string(state_root, "openAiBaseUrl", &provider.api_url);
    insert_string(state_root, "apiModelId", &model_default(&provider.model));
    insert_string(
        secrets.as_object_mut().expect("object"),
        "openAiApiKey",
        &provider.api_key,
    );
    apply_projection_mutations(&[
        NativeFileMutation {
            path: state_path,
            expected: state_original,
            replacement: Some(
                serde_json::to_vec_pretty(&state)
                    .map_err(|error| format!("序列化 Cline 配置失败：{error}"))?,
            ),
            sensitive: false,
        },
        NativeFileMutation {
            path: secrets_path,
            expected: secrets_original,
            replacement: Some(
                serde_json::to_vec_pretty(&secrets)
                    .map_err(|error| format!("序列化 Cline 凭据失败：{error}"))?,
            ),
            sensitive: true,
        },
    ])
    .await
}

async fn apply_gemini(gemini_home: &Path, provider: &StoredProvider) -> Result<(), String> {
    let path = gemini_home.join("settings.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&path)
        .await
        .map_err(|error| error.message)?;
    let mut document = parse_json_object_bytes(&path, original.as_deref())?;
    let env = object_entry(document.as_object_mut().expect("object"), "env")?;
    for key in GEMINI_ENV_KEYS {
        env.remove(*key);
    }
    insert_string(env, "GOOGLE_GEMINI_BASE_URL", &provider.api_url);
    insert_string(env, "GEMINI_API_KEY", &provider.api_key);
    insert_string(env, "GEMINI_MODEL", &model_default(&provider.model));
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("序列化原生配置失败：{error}"))?,
        ),
        sensitive: true,
    }])
    .await
}

fn parse_json_object_bytes(path: &Path, bytes: Option<&[u8]>) -> Result<Value, String> {
    let Some(bytes) = bytes else {
        return Ok(Value::Object(Map::new()));
    };
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("{} 无效：{error}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} 顶层必须是对象", path.display()))
    }
}

fn parse_toml_table_bytes(path: &Path, bytes: Option<&[u8]>) -> Result<toml::Table, String> {
    let text = bytes
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|error| format!("{} 不是 UTF-8：{error}", path.display()))?
        .unwrap_or_default();
    if text.trim().is_empty() {
        Ok(toml::Table::new())
    } else {
        toml::from_str(text).map_err(|error| format!("{} 无效：{error}", path.display()))
    }
}

async fn apply_projection_mutations(mutations: &[NativeFileMutation]) -> Result<(), String> {
    TokioNativeFileSystem
        .apply_many_atomic(mutations)
        .await
        .map_err(|error| error.message)
}

fn object_entry<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .ok_or_else(|| format!("原生配置字段 `{key}` 必须是对象"))
}

fn insert_string(object: &mut Map<String, Value>, key: &str, value: &str) {
    if value.is_empty() {
        object.remove(key);
    } else {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn parse_model(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn model_default(raw: &str) -> String {
    match parse_model(raw) {
        Value::Object(object) => object
            .get("default")
            .or_else(|| object.get("main"))
            .and_then(Value::as_str)
            .unwrap_or(raw)
            .to_string(),
        Value::String(model) => model,
        _ => raw.to_string(),
    }
}

async fn write_json(path: &Path, document: &Value, sensitive: bool) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("序列化原生配置失败：{error}"))?;
    write_bytes_document(path, &bytes, sensitive)
        .await
        .map_err(|error| error.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_key_prefers_the_draft_and_can_reuse_the_edited_provider_secret() {
        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("providers.json");
        write_store(
            &store_path,
            &ProviderStore {
                providers: vec![StoredProvider {
                    id: "provider-1".to_string(),
                    name: "Gateway".to_string(),
                    agent_id: AgentId::parse("gemini").unwrap(),
                    api_url: "https://saved.example/v1".to_string(),
                    api_key: "saved-secret".to_string(),
                    model: String::new(),
                }],
                ..ProviderStore::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(
            resolve_probe_api_key(
                &store_path,
                &AgentId::parse("gemini").unwrap(),
                Some("provider-1"),
                Some("draft-secret")
            )
            .await
            .unwrap(),
            "draft-secret"
        );
        assert_eq!(
            resolve_probe_api_key(
                &store_path,
                &AgentId::parse("gemini").unwrap(),
                Some("provider-1"),
                None
            )
            .await
            .unwrap(),
            "saved-secret"
        );
    }

    #[test]
    fn gemini_cli_home_is_a_parent_directory_for_provider_projection() {
        let home = Path::new("/users/example");
        let homes = ProviderNativeHomes::resolve(
            home,
            &HashMap::from([(
                "GEMINI_CLI_HOME".to_string(),
                "/profiles/google".to_string(),
            )]),
        );

        assert_eq!(homes.gemini, PathBuf::from("/profiles/google/.gemini"));
    }

    #[tokio::test]
    async fn bound_claude_provider_projects_structured_model_and_preserves_unknown_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(".claude/settings.json");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &path,
            br#"{"unknown":true,"env":{"KEEP":"yes","ANTHROPIC_API_KEY":"old","OPENAI_BASE_URL":"https://old.example"}}"#,
        )
            .await
            .unwrap();
        apply_provider(
            &ProviderNativeHomes::resolve(temp.path(), &HashMap::new()),
            &StoredProvider {
                id: "provider-1".to_string(),
                name: "Gateway".to_string(),
                agent_id: AgentId::parse("claude_code").unwrap(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: "secret".to_string(),
                model: r#"{"main":"gateway/sonnet","reasoning":"gateway/opus"}"#.to_string(),
            },
            &temp.path().join("codex-cache.json"),
        )
        .await
        .unwrap();
        let document: Value =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert_eq!(document["unknown"], true);
        assert_eq!(document["env"]["KEEP"], "yes");
        assert_eq!(document["env"]["ANTHROPIC_MODEL"], "gateway/sonnet");
        assert_eq!(document["env"]["ANTHROPIC_REASONING_MODEL"], "gateway/opus");
        assert_eq!(document["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
        assert!(document["env"].get("ANTHROPIC_API_KEY").is_none());
        assert!(document["env"].get("OPENAI_BASE_URL").is_none());
    }

    #[tokio::test]
    async fn gemini_provider_binding_scrubs_conflicting_auth_and_restores_it_on_unbind() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let settings_path = home.join(".gemini/settings.json");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(settings_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &settings_path,
            br#"{"env":{"GOOGLE_API_KEY":"vertex-old","GOOGLE_CLOUD_PROJECT":"project-old","KEEP":"yes"}}"#,
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("gemini").unwrap();
        let created = save(
            &store_path,
            &home,
            &HashMap::new(),
            AgentModelProviderSaveRequest {
                id: None,
                name: "Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gemini.example/v1".to_string(),
                api_key: Some("provider-secret".to_string()),
                model: "gemini-provider-model".to_string(),
            },
        )
        .await
        .unwrap();
        bind(
            &store_path,
            &home,
            &HashMap::new(),
            agent_id.clone(),
            Some(created.providers[0].id.clone()),
        )
        .await
        .unwrap();
        let bound: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(bound["env"]["GEMINI_API_KEY"], "provider-secret");
        assert_eq!(bound["env"]["KEEP"], "yes");
        assert!(bound["env"].get("GOOGLE_API_KEY").is_none());
        assert!(bound["env"].get("GOOGLE_CLOUD_PROJECT").is_none());

        bind(&store_path, &home, &HashMap::new(), agent_id, None)
            .await
            .unwrap();
        let restored: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(restored["env"]["GOOGLE_API_KEY"], "vertex-old");
        assert_eq!(restored["env"]["GOOGLE_CLOUD_PROJECT"], "project-old");
        assert_eq!(restored["env"]["KEEP"], "yes");
    }

    #[tokio::test]
    async fn antigravity_provider_binding_writes_acp_settings_auth_type() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let settings_path = home.join(".gemini/antigravity-acp/settings.json");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(settings_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &settings_path,
            br#"{"keep":true,"auth":{"type":"oauth-personal"},"env":{"GOOGLE_API_KEY":"old"}}"#,
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("antigravity").unwrap();
        let created = save(
            &store_path,
            &home,
            &HashMap::new(),
            AgentModelProviderSaveRequest {
                id: None,
                name: "Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gemini.example/v1".to_string(),
                api_key: Some("provider-secret".to_string()),
                model: "gemini-3".to_string(),
            },
        )
        .await
        .unwrap();
        bind(
            &store_path,
            &home,
            &HashMap::new(),
            agent_id.clone(),
            Some(created.providers[0].id.clone()),
        )
        .await
        .unwrap();
        let bound: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(bound["keep"], true);
        assert_eq!(bound["auth"]["type"], "gemini-api-key");
        assert_eq!(bound["env"]["GEMINI_API_KEY"], "provider-secret");
        assert_eq!(
            bound["env"]["GOOGLE_GEMINI_BASE_URL"],
            "https://gemini.example/v1"
        );
        assert_eq!(bound["env"]["GEMINI_MODEL"], "gemini-3");
        assert!(bound["env"].get("GOOGLE_API_KEY").is_none());

        bind(&store_path, &home, &HashMap::new(), agent_id, None)
            .await
            .unwrap();
        let restored: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(restored["auth"]["type"], "oauth-personal");
        assert_eq!(restored["env"]["GOOGLE_API_KEY"], "old");
        assert_eq!(restored["keep"], true);
    }

    #[tokio::test]
    async fn unbinding_provider_restores_the_native_values_from_before_first_binding() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let settings_path = home.join(".claude/settings.json");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(settings_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &settings_path,
            br#"{"unknown":true,"env":{"ANTHROPIC_BASE_URL":"https://original.example","ANTHROPIC_AUTH_TOKEN":"original-secret","ANTHROPIC_MODEL":"original-model"}}"#,
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("claude_code").unwrap();
        let environment = HashMap::new();
        let created = save(
            &store_path,
            &home,
            &environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: "Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("new-secret".to_string()),
                model: "gateway-model".to_string(),
            },
        )
        .await
        .unwrap();
        let provider_id = created.providers[0].id.clone();

        bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some(provider_id),
        )
        .await
        .unwrap();
        let bound: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(bound["env"]["ANTHROPIC_AUTH_TOKEN"], "new-secret");
        assert_eq!(bound["env"]["ANTHROPIC_MODEL"], "gateway-model");

        bind(&store_path, &home, &environment, agent_id, None)
            .await
            .unwrap();
        let restored: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(restored["unknown"], true);
        assert_eq!(
            restored["env"]["ANTHROPIC_BASE_URL"],
            "https://original.example"
        );
        assert_eq!(restored["env"]["ANTHROPIC_AUTH_TOKEN"], "original-secret");
        assert_eq!(restored["env"]["ANTHROPIC_MODEL"], "original-model");
    }

    #[tokio::test]
    async fn failed_first_bind_restores_native_files_and_removes_recovery_record() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"original-secret","keep":true}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model = \"original-model\"\nkeep = true\n",
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let created = save(
            &store_path,
            &home,
            &environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: "Broken Catalog Provider".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("new-secret".to_string()),
                model: r#"{"customs":[{"slug":"gateway-a","base":"official-a"}],"excluded_officials":[],"default_model":"gateway-a"}"#.to_string(),
            },
        )
        .await
        .unwrap();

        let error = bind(
            &store_path,
            &home,
            &environment,
            agent_id,
            Some(created.providers[0].id.clone()),
        )
        .await
        .unwrap_err();

        assert!(error.contains("Codex Provider 模型清单"));
        let auth: Value =
            serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
                .unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "original-secret");
        assert_eq!(auth["keep"], true);
        let config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            config.get("model").and_then(toml::Value::as_str),
            Some("original-model")
        );
        assert_eq!(
            config.get("keep").and_then(toml::Value::as_bool),
            Some(true)
        );
        let store = read_store(&store_path).await.unwrap();
        assert!(store.bindings.is_empty());
        assert!(store.projection_backups.is_empty());
    }

    #[tokio::test]
    async fn codex_provider_projects_official_provider_table_and_restores_catalog_on_unbind() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/agent-model-providers.json");
        let cache_path = codex_catalog_cache(&store_path);
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::create_dir_all(cache_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"original-secret","keep":true}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model = \"official-a\"\nmodel_provider = \"original\"\nmodel_catalog_json = \"vibex-model-catalog.json\"\n[model_providers.original]\nbase_url = \"https://original.example\"\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join(CODEX_CATALOG_FILE),
            r#"{"models":[{"slug":"old-custom"}]}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(codex_home.join(CODEX_SOURCE_FILE), r#"{"customs":[]}"#)
            .await
            .unwrap();
        tokio::fs::write(
            &cache_path,
            r#"{"models":[{"slug":"official-a","display_name":"Official A","visibility":"list","priority":0,"context_window":1000}]}"#,
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let created = save(
            &store_path,
            &home,
            &environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: "Codex Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("new-secret".to_string()),
                model: r#"{"customs":[{"slug":"gateway-a","display_name":"Gateway A","base":"official-a","overrides":{"default_verbosity":"high"}}],"excluded_officials":[],"default_model":"gateway-a"}"#.to_string(),
            },
        )
        .await
        .unwrap();
        bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some(created.providers[0].id.clone()),
        )
        .await
        .unwrap();

        let bound_config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            bound_config.get("model").and_then(toml::Value::as_str),
            Some("gateway-a")
        );
        assert_eq!(
            bound_config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("vibex"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://gateway.example/v1")
        );
        assert_eq!(
            bound_config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("original"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://original.example")
        );
        let catalog: Value = serde_json::from_slice(
            &tokio::fs::read(codex_home.join(CODEX_CATALOG_FILE))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(catalog["models"][0]["slug"], "gateway-a");
        assert_eq!(catalog["models"][0]["default_verbosity"], "high");

        let mut externally_changed = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        externally_changed
            .get_mut("model_providers")
            .and_then(toml::Value::as_table_mut)
            .unwrap()
            .insert(
                "third_party".to_string(),
                toml::Value::Table(toml::Table::from_iter([(
                    "base_url".to_string(),
                    toml::Value::String("https://third-party.example".to_string()),
                )])),
            );
        write_toml_table(&codex_home.join("config.toml"), &externally_changed)
            .await
            .unwrap();

        bind(&store_path, &home, &environment, agent_id, None)
            .await
            .unwrap();
        let restored_config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            restored_config.get("model").and_then(toml::Value::as_str),
            Some("official-a")
        );
        assert_eq!(
            restored_config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("original"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://original.example")
        );
        assert_eq!(
            restored_config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("third_party"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://third-party.example")
        );
        assert!(
            restored_config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .is_none_or(|providers| !providers.contains_key("vibex"))
        );
        assert_eq!(
            tokio::fs::read_to_string(codex_home.join(CODEX_CATALOG_FILE))
                .await
                .unwrap(),
            r#"{"models":[{"slug":"old-custom"}]}"#
        );
    }

    #[tokio::test]
    async fn codex_provider_respects_the_saved_custom_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let custom_home = home.join("profiles/work-codex");
        let store_path = temp.path().join("data/providers.json");
        let environment = HashMap::from([(
            "CODEX_HOME".to_string(),
            "~/profiles/work-codex".to_string(),
        )]);
        let agent_id = AgentId::parse("codex").unwrap();
        let created = save(
            &store_path,
            &home,
            &environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: "Work Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("custom-home-secret".to_string()),
                model: "gpt-work".to_string(),
            },
        )
        .await
        .unwrap();

        bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some(created.providers[0].id.clone()),
        )
        .await
        .unwrap();

        let auth: Value = serde_json::from_slice(
            &tokio::fs::read(custom_home.join("auth.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "custom-home-secret");
        assert!(auth.get("auth_mode").is_none());
        assert!(custom_home.join("config.toml").is_file());
        assert!(!home.join(".codex/auth.json").exists());

        bind(&store_path, &home, &environment, agent_id, None)
            .await
            .unwrap();
        let restored: Value = serde_json::from_slice(
            &tokio::fs::read(custom_home.join("auth.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(restored.get("OPENAI_API_KEY").is_none());
    }

    #[tokio::test]
    async fn native_codex_provider_appears_as_bound_when_vibex_has_no_binding() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join("home/.codex");
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
            "model = \"deepseek-v4-flash\"\nmodel_provider = \"deepseek\"\n\n[model_providers.deepseek]\nname = \"DeepSeek Gateway\"\nbase_url = \"https://api.deepseek.example/v1\"\nwire_api = \"responses\"\n",
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let view = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .unwrap();
        assert_eq!(view.bound_provider_id.as_deref(), Some("deepseek"));
        assert_eq!(view.providers.len(), 1);
        let native = &view.providers[0];
        assert_eq!(native.id, "deepseek");
        assert_eq!(native.name, "DeepSeek Gateway");
        assert_eq!(native.api_url, "https://api.deepseek.example/v1");
        assert_eq!(native.model, "deepseek-v4-flash");
        assert!(native.bound);
        assert!(!native.managed);
        assert!(native.credential_present);
    }

    #[tokio::test]
    async fn native_codex_endpoint_without_provider_table_projects_synthetic_entry() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join("home/.codex");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model = \"gpt-custom\"\nopenai_base_url = \"https://gateway.example/v1\"\n",
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let view = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .unwrap();
        let bound = view.bound_provider_id.as_deref().unwrap();
        let entry = view
            .providers
            .iter()
            .find(|provider| provider.id == bound)
            .unwrap();
        assert_eq!(entry.api_url, "https://gateway.example/v1");
        assert_eq!(entry.model, "gpt-custom");
        assert!(entry.bound);
        assert!(!entry.managed);
    }

    #[tokio::test]
    async fn vibex_binding_takes_precedence_over_native_codex_provider() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join("home/.codex");
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
            "model = \"deepseek-v4-flash\"\nmodel_provider = \"deepseek\"\n\n[model_providers.deepseek]\nname = \"DeepSeek Gateway\"\nbase_url = \"https://api.deepseek.example/v1\"\n",
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let created = save(
            &store_path,
            &temp.path().join("home"),
            &environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: "VibeX Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://vibex.example/v1".to_string(),
                api_key: Some("vibex-secret".to_string()),
                model: "vibex-model".to_string(),
            },
        )
        .await
        .unwrap();
        let managed_id = created
            .providers
            .iter()
            .find(|provider| provider.managed)
            .expect("saved VibeX provider")
            .id
            .clone();
        bind(
            &store_path,
            &temp.path().join("home"),
            &environment,
            agent_id.clone(),
            Some(managed_id.clone()),
        )
        .await
        .unwrap();
        let view = list_with_native(&store_path, agent_id, Some(&codex_home))
            .await
            .unwrap();
        assert_eq!(view.bound_provider_id, Some(managed_id.clone()));
        let managed = view
            .providers
            .iter()
            .find(|provider| provider.id == managed_id)
            .unwrap();
        assert!(managed.bound);
        assert!(managed.managed);
        let native = view
            .providers
            .iter()
            .find(|provider| provider.id == "deepseek")
            .expect("native Codex providers remain visible after a VibeX bind");
        assert!(!native.bound);
        assert!(!native.managed);
    }

    #[tokio::test]
    async fn deleting_the_bound_provider_unbinds_it_restores_native_config_and_removes_the_preset()
    {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/agent-model-providers.json");
        let cache_path = codex_catalog_cache(&store_path);
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::create_dir_all(cache_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"original-secret","keep":true}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model = \"official-a\"\nmodel_provider = \"original\"\nmodel_catalog_json = \"vibex-model-catalog.json\"\n[model_providers.original]\nbase_url = \"https://original.example\"\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join(CODEX_CATALOG_FILE),
            r#"{"models":[{"slug":"old-custom"}]}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(codex_home.join(CODEX_SOURCE_FILE), r#"{"customs":[]}"#)
            .await
            .unwrap();
        tokio::fs::write(
            &cache_path,
            r#"{"models":[{"slug":"official-a","display_name":"Official A","visibility":"list","priority":0,"context_window":1000}]}"#,
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let created = save(
            &store_path,
            &home,
            &environment,
            AgentModelProviderSaveRequest {
                id: None,
                name: "Codex Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("new-secret".to_string()),
                model: r#"{"customs":[{"slug":"gateway-a","display_name":"Gateway A","base":"official-a"}],"excluded_officials":[],"default_model":"gateway-a"}"#.to_string(),
            },
        )
        .await
        .unwrap();
        let provider_id = created
            .providers
            .iter()
            .find(|provider| provider.managed)
            .expect("saved VibeX provider")
            .id
            .clone();
        bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some(provider_id.clone()),
        )
        .await
        .unwrap();
        let bound_config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            bound_config.get("model").and_then(toml::Value::as_str),
            Some("gateway-a")
        );

        // 删除当前绑定的 Provider：自动解绑、恢复原生配置并移除预设。
        let view = delete(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            &provider_id,
        )
        .await
        .unwrap();
        assert!(view.providers.iter().all(|provider| !provider.managed));
        assert_eq!(view.bound_provider_id.as_deref(), Some("original"));

        let restored_config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            restored_config.get("model").and_then(toml::Value::as_str),
            Some("official-a")
        );
        assert_eq!(
            restored_config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("original"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://original.example")
        );
        let store = read_store(&store_path).await.unwrap();
        assert!(store.bindings.is_empty());
        assert!(store.projection_backups.is_empty());
        assert!(store.providers.is_empty());

        // 再次删除已不存在的 Provider 报错，且不触碰已恢复的原生配置。
        let error = delete(&store_path, &home, &environment, agent_id, &provider_id)
            .await
            .unwrap_err();
        assert!(error.contains("找不到要删除的 Model Provider"));
    }

    #[tokio::test]
    async fn native_import_previews_claude_env_without_binding() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store_path = temp.path().join("data/agent-model-providers.json");
        tokio::fs::create_dir_all(home.join(".claude"))
            .await
            .unwrap();
        tokio::fs::write(
            home.join(".claude/settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-native","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
        )
        .await
        .unwrap();
        let preview = preview_import(
            &store_path,
            &home,
            &HashMap::new(),
            AgentId::parse("claude_code").unwrap(),
            api_types::AgentModelProviderImportSource::Native,
        )
        .await
        .unwrap();
        assert_eq!(preview.candidates.len(), 1);
        assert_eq!(preview.candidates[0].api_url, "https://api.deepseek.com");
        assert!(preview.candidates[0].credential_present);
        assert!(preview.candidates[0].skip_reason.is_none());
        let imported = apply_import(
            &store_path,
            &home,
            &HashMap::new(),
            AgentId::parse("claude_code").unwrap(),
            api_types::AgentModelProviderImportSource::Native,
            &["__native_live__".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(imported.providers.len(), 1);
        assert!(imported.providers[0].managed);
        assert!(!imported.providers[0].bound);
        assert_eq!(imported.bound_provider_id, None);
    }
}
