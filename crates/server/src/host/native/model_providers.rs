use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem, official_api_url};
use api_types::{
    AgentId, AgentKind, AgentModelProviderImportPreviewView, AgentModelProviderImportSource,
    AgentModelProviderSaveRequest, AgentModelProviderView, AgentModelProvidersView,
    CodexModelCatalogConfigRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    catalog_cache_dir, model_catalogs,
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
    /// `auth.json` 的 `OPENAI_API_KEY` 或当前 Provider 表内的 `api_key`。
    pub credential_present: bool,
    /// `auth.json` 中的 `OPENAI_API_KEY` 原文，纳入 VibeX 预设时复用。
    pub auth_api_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct NativePiProvider {
    id: String,
    name: String,
    api_url: String,
    model: String,
    api_key: String,
    credential_present: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct NativePiState {
    providers: Vec<NativePiProvider>,
    active_provider: Option<String>,
}

/// 只有顶层 base_url、没有显式 `[model_providers.xxx]` 表时使用的合成标识。
const NATIVE_ENDPOINT_PROVIDER_ID: &str = "__vibex_native_endpoint__";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    pi: PathBuf,
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
            pi: resolve_native_home(home, environment, "PI_CODING_AGENT_DIR", ".pi/agent"),
        }
    }

    fn native_list_home(&self, agent_id: &AgentId) -> &Path {
        match agent_id.as_str() {
            "pi" => &self.pi,
            "claude_code" => &self.claude,
            "grok" => &self.grok,
            "kimi_code" => &self.kimi,
            "hermes" => &self.hermes,
            "openclaw" => &self.openclaw,
            "cline" => &self.cline,
            _ if is_antigravity(agent_id) => &self.gemini,
            _ => &self.codex,
        }
    }
}

pub fn provider_native_home(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
) -> PathBuf {
    ProviderNativeHomes::resolve(home, environment)
        .native_list_home(agent_id)
        .to_path_buf()
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

pub async fn list(
    store_path: &Path,
    agent_id: AgentId,
) -> Result<AgentModelProvidersView, super::NativeError> {
    list_with_native(store_path, agent_id, None).await
}

/// 与 `list` 相同，并对 Codex / Pi 把原生存储中已有的供应商合并进视图。
pub async fn list_with_native(
    store_path: &Path,
    agent_id: AgentId,
    native_home: Option<&Path>,
) -> Result<AgentModelProvidersView, super::NativeError> {
    validate_agent(&agent_id)?;
    match agent_id.as_str() {
        "pi" => {
            let native = match native_home {
                Some(home) => Some(read_native_pi_state(home).await?),
                None => None,
            };
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, &agent_id, &pi_native_drafts(native.as_ref())) {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_pi_native(&store, agent_id, native.as_ref()))
        }
        "codex" => {
            let native = match native_home {
                Some(home) => Some(read_native_codex_state(home).await?),
                None => None,
            };
            let mut store = read_store_reconciled(store_path, &agent_id, native.as_ref()).await?;
            if adopt_native_providers(&mut store, &agent_id, &codex_native_drafts(native.as_ref()))
            {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_codex_native(&store, agent_id, native.as_ref()))
        }
        _ => {
            let drafts = match native_home {
                Some(home) => live_native_drafts(&agent_id, home).await?,
                None => Vec::new(),
            };
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, &agent_id, &drafts) {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_live_native(&store, agent_id, &drafts))
        }
    }
}

pub async fn resolve_probe_api_key_from(
    store_path: &Path,
    agent_id: &AgentId,
    provider_id: Option<&str>,
    submitted_api_key: Option<&str>,
    home: Option<&Path>,
    environment: Option<&HashMap<String, String>>,
) -> Result<String, super::NativeError> {
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
        .ok_or_else(|| super::NativeError::from("读取 Provider 模型需要填写 API Key"))?;
    let store = if let (Some(home), Some(environment)) = (home, environment) {
        let homes = ProviderNativeHomes::resolve(home, environment);
        load_store_with_natives(store_path, agent_id, &homes).await?
    } else {
        read_store(store_path).await?
    };
    if let Some(api_key) = store
        .providers
        .iter()
        .find(|provider| provider.id == provider_id && &provider.agent_id == agent_id)
        .map(|provider| provider.api_key.clone())
        .filter(|value| !value.is_empty())
    {
        return Ok(api_key);
    }
    if let (Some(home), Some(environment)) = (home, environment) {
        let url = store
            .providers
            .iter()
            .find(|provider| provider.id == provider_id && &provider.agent_id == agent_id)
            .map(|provider| provider.api_url.as_str())
            .unwrap_or("");
        if let Some(api_key) = native_api_key(home, environment, agent_id, provider_id, url).await?
        {
            return Ok(api_key);
        }
    }
    Err("找不到可用于模型探测的 Provider 凭据".into())
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
    Ok(drafts.into_iter().find_map(|draft| {
        let matches_id = draft.source_id == provider_id || draft.source_id == native_id;
        let matches_url = !api_url.is_empty() && draft.api_url == api_url;
        (matches_id || matches_url)
            .then_some(draft.api_key)
            .filter(|value| !value.is_empty())
    }))
}

pub async fn save(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    request: AgentModelProviderSaveRequest,
) -> Result<AgentModelProvidersView, super::NativeError> {
    let homes = ProviderNativeHomes::resolve(home, environment);
    validate_request(&request)?;
    let mut store = load_store_with_natives(store_path, &request.agent_id, &homes).await?;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let api_url = request.api_url.trim();
            store
                .providers
                .iter()
                .find(|provider| {
                    provider.agent_id == request.agent_id && provider.api_url == api_url
                })
                .map(|provider| provider.id.clone())
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing = store
        .providers
        .iter()
        .position(|provider| provider.id == id);
    if let Some(index) = existing
        && store.providers[index].agent_id != request.agent_id
    {
        return Err("Model Provider 的 Agent 类型不能更改".into());
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
        return Err("Model Provider 需要 API Key".into());
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
        if let Err(error) = apply_provider(&homes, &provider).await {
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
    projected_view(&store, store_path, &homes, request.agent_id).await
}

pub async fn bind(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    provider_id: Option<String>,
) -> Result<AgentModelProvidersView, super::NativeError> {
    validate_agent(&agent_id)?;
    let homes = ProviderNativeHomes::resolve(home, environment);
    let mut store = load_store_with_natives(store_path, &agent_id, &homes).await?;
    let current_binding = store.bindings.get(agent_id.as_str()).cloned();
    let rollback = capture_projection(&homes, &agent_id).await?;
    let native_codex = if agent_id.as_str() == "codex" {
        Some(read_native_codex_state(&homes.codex).await?)
    } else {
        None
    };
    if let Some(provider_id) = provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let provider = store
            .providers
            .iter()
            .find(|provider| provider.id == provider_id && provider.agent_id == agent_id)
            .cloned()
            .ok_or_else(|| super::NativeError::from("找不到可绑定的 Model Provider"))?;
        if is_native_codex_channel(&provider, native_codex.as_ref()) {
            if native_uses_vibex_projection(native_codex.as_ref()) {
                let backup = store
                    .projection_backups
                    .get(agent_id.as_str())
                    .cloned()
                    .unwrap_or_else(|| rollback.clone());
                if let Err(error) = restore_projection(&homes, &agent_id, &backup).await {
                    restore_projection(&homes, &agent_id, &rollback).await?;
                    return Err(error);
                }
            }
            if let Err(error) = activate_native_codex_provider(&homes.codex, &provider.id).await {
                restore_projection(&homes, &agent_id, &rollback).await?;
                return Err(error);
            }
            store.bindings.remove(agent_id.as_str());
            store.projection_backups.remove(agent_id.as_str());
        } else {
            if current_binding.is_none() {
                store
                    .projection_backups
                    .insert(agent_id.as_str().to_string(), rollback.clone());
                // Persist the recovery point before touching any Agent-owned file.
                write_store(store_path, &store).await?;
            }
            if let Err(error) = apply_provider(&homes, &provider).await {
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
        }
    } else {
        if current_binding.is_none() {
            return projected_view(&store, store_path, &homes, agent_id).await;
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
    projected_view(&store, store_path, &homes, agent_id).await
}

pub async fn forget_binding(
    store_path: &Path,
    agent_id: AgentId,
) -> Result<(), super::NativeError> {
    validate_agent(&agent_id)?;
    let mut store = read_store(store_path).await?;
    if store.bindings.remove(agent_id.as_str()).is_none() {
        return Ok(());
    }
    store.projection_backups.remove(agent_id.as_str());
    write_store(store_path, &store).await
}

pub async fn delete(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    provider_id: &str,
) -> Result<AgentModelProvidersView, super::NativeError> {
    validate_agent(&agent_id)?;
    let homes = ProviderNativeHomes::resolve(home, environment);
    let native_codex = if agent_id.as_str() == "codex" {
        Some(read_native_codex_state(&homes.codex).await?)
    } else {
        None
    };
    let native_pi = if agent_id.as_str() == "pi" {
        Some(read_native_pi_state(&homes.pi).await?)
    } else {
        None
    };
    let mut store = load_store_with_natives(store_path, &agent_id, &homes).await?;
    let remaining = store
        .providers
        .iter()
        .filter(|provider| provider.agent_id == agent_id)
        .count();
    if remaining <= 1 {
        return Err("至少需要保留一个供应商".into());
    }
    if provider_is_in_use(
        &store,
        &agent_id,
        provider_id,
        native_codex.as_ref(),
        native_pi.as_ref(),
    ) {
        return Err("无法删除正在使用的供应商".into());
    }
    let Some(index) = store
        .providers
        .iter()
        .position(|provider| provider.id == provider_id && provider.agent_id == agent_id)
    else {
        return Err("找不到要删除的 Model Provider".into());
    };
    let removed = store.providers[index].clone();
    match agent_id.as_str() {
        "codex" => remove_native_codex_provider(&homes.codex, &removed).await?,
        "pi" => remove_native_pi_provider(&homes.pi, &removed).await?,
        _ => {}
    }
    store.providers.remove(index);
    write_store(store_path, &store).await?;
    projected_view(&store, store_path, &homes, agent_id).await
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

/// 原生 Codex Provider 已纳入 VibeX 预设。启用态以 `config.toml` 的
/// `model_provider` 为准：指向 `vibex` 槽时沿用 store 绑定，否则按原生
/// 当前项的 id / URL 标记对应预设。
fn project_with_codex_native(
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
    view
}

fn project_with_pi_native(
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

fn apply_native_active_binding<'a>(
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

fn project_with_live_native(
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

async fn projected_view(
    store: &ProviderStore,
    store_path: &Path,
    homes: &ProviderNativeHomes,
    agent_id: AgentId,
) -> Result<AgentModelProvidersView, super::NativeError> {
    let mut store = store.clone();
    match agent_id.as_str() {
        "codex" => {
            let native = read_native_codex_state(&homes.codex).await?;
            if adopt_native_providers(&mut store, &agent_id, &codex_native_drafts(Some(&native))) {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_codex_native(&store, agent_id, Some(&native)))
        }
        "pi" => {
            let native = read_native_pi_state(&homes.pi).await?;
            if adopt_native_providers(&mut store, &agent_id, &pi_native_drafts(Some(&native))) {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_pi_native(&store, agent_id, Some(&native)))
        }
        _ => {
            let home = homes.native_list_home(&agent_id);
            let drafts = live_native_drafts(&agent_id, home).await?;
            if adopt_native_providers(&mut store, &agent_id, &drafts) {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_live_native(&store, agent_id, &drafts))
        }
    }
}

struct NativeProviderDraft {
    id: String,
    name: String,
    api_url: String,
    api_key: String,
    model: String,
}

fn codex_native_drafts(native: Option<&NativeCodexState>) -> Vec<NativeProviderDraft> {
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

fn pi_native_drafts(native: Option<&NativePiState>) -> Vec<NativeProviderDraft> {
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

async fn live_native_drafts(
    agent_id: &AgentId,
    native_home: &Path,
) -> Result<Vec<NativeProviderDraft>, String> {
    let drafts = match agent_id.as_str() {
        "claude_code" => native_claude_draft(native_home)
            .await?
            .into_iter()
            .collect(),
        "grok" => native_grok_drafts(native_home).await?,
        "kimi_code" => native_kimi_provider_drafts(native_home).await?,
        "hermes" => native_hermes_draft(native_home).await?,
        "cline" => native_cline_draft(native_home).await?,
        "openclaw" => native_openclaw_drafts(native_home).await?,
        _ if is_antigravity(agent_id) => native_gemini_draft(native_home, agent_id)
            .await?
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    Ok(custom_endpoint_drafts(agent_id, drafts))
}

fn custom_endpoint_drafts(
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

fn is_official_endpoint(agent_id: &AgentId, url: &str) -> bool {
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

fn normalized_endpoint(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').to_ascii_lowercase();
    trimmed
        .strip_suffix("/v1")
        .unwrap_or(trimmed.as_str())
        .trim_end_matches('/')
        .to_string()
}

fn native_provider_id(source_id: &str, url: &str) -> String {
    let stripped = source_id.strip_prefix("native:").unwrap_or(source_id);
    if stripped == "__native_live__"
        || stripped == NATIVE_ENDPOINT_PROVIDER_ID
        || stripped.is_empty()
    {
        return host_slug(url);
    }
    stripped.to_string()
}

fn native_provider_name(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "原生端点".to_string())
}

fn host_slug(url: &str) -> String {
    native_provider_name(url)
        .chars()
        .map(|ch| if ch == '.' { '-' } else { ch })
        .collect()
}

fn adopt_native_providers(
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

async fn load_store_with_natives(
    store_path: &Path,
    agent_id: &AgentId,
    homes: &ProviderNativeHomes,
) -> Result<ProviderStore, super::NativeError> {
    match agent_id.as_str() {
        "codex" => {
            let native = read_native_codex_state(&homes.codex).await?;
            let mut store = read_store_reconciled(store_path, agent_id, Some(&native)).await?;
            if adopt_native_providers(&mut store, agent_id, &codex_native_drafts(Some(&native))) {
                write_store(store_path, &store).await?;
            }
            Ok(store)
        }
        "pi" => {
            let native = read_native_pi_state(&homes.pi).await?;
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, agent_id, &pi_native_drafts(Some(&native))) {
                write_store(store_path, &store).await?;
            }
            Ok(store)
        }
        _ => {
            let native_home = homes.native_list_home(agent_id);
            let drafts = live_native_drafts(agent_id, native_home).await?;
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, agent_id, &drafts) {
                write_store(store_path, &store).await?;
            }
            Ok(store)
        }
    }
}

fn provider_is_in_use(
    store: &ProviderStore,
    agent_id: &AgentId,
    provider_id: &str,
    native_codex: Option<&NativeCodexState>,
    native_pi: Option<&NativePiState>,
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

/// 只读解析 Codex 原生配置的 Provider 状态，不修改任何 Agent 文件。
pub async fn read_native_codex_state(
    codex_home: &Path,
) -> Result<NativeCodexState, super::NativeError> {
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
            let api_key = provider
                .get("api_key")
                .and_then(toml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_default()
                .to_string();
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
        super::model_catalogs::peek_external_codex_catalog(codex_home).await
    {
        let model = state
            .model
            .clone()
            .or(catalog_model)
            .or_else(|| super::model_catalogs::first_catalog_slug(&catalog));
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

async fn read_native_pi_state(pi_home: &Path) -> Result<NativePiState, super::NativeError> {
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
            let model = object
                .get("models")
                .and_then(Value::as_array)
                .and_then(|models| {
                    models
                        .iter()
                        .find_map(|entry| entry.get("id").and_then(Value::as_str))
                })
                .unwrap_or(if active_provider.as_deref() == Some(id.as_str()) {
                    default_model
                } else {
                    ""
                })
                .to_string();
            let api_key = auth.get(id).map(pi_auth_key).unwrap_or_default();
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

async fn read_store_reconciled(
    store_path: &Path,
    agent_id: &AgentId,
    native: Option<&NativeCodexState>,
) -> Result<ProviderStore, super::NativeError> {
    let mut store = read_store(store_path).await?;
    if reconcile_codex_store_bindings(&mut store, agent_id, native) {
        write_store(store_path, &store).await?;
    }
    Ok(store)
}

fn reconcile_codex_store_bindings(
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

fn native_uses_vibex_projection(native: Option<&NativeCodexState>) -> bool {
    native.is_some_and(|state| state.active_provider.as_deref() == Some("vibex"))
}

fn is_native_codex_channel(provider: &StoredProvider, native: Option<&NativeCodexState>) -> bool {
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

async fn activate_native_codex_provider(
    codex_home: &Path,
    provider_id: &str,
) -> Result<(), super::NativeError> {
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

async fn read_store(path: &Path) -> Result<ProviderStore, super::NativeError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Model Provider 存储文件无效：{error}").into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProviderStore::default()),
        Err(error) => Err(format!("读取 Model Provider 失败：{error}").into()),
    }
}

async fn write_store(path: &Path, store: &ProviderStore) -> Result<(), super::NativeError> {
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("序列化 Model Provider 失败：{error}"))?;
    write_bytes_document(path, &bytes, true).await
}

fn validate_agent(agent_id: &AgentId) -> Result<(), super::NativeError> {
    if matches!(
        agent_id.as_str(),
        "claude_code" | "codex" | "grok" | "kimi_code" | "hermes" | "openclaw" | "cline" | "pi"
    ) || is_antigravity(agent_id)
    {
        Ok(())
    } else {
        Err("此 Agent 不支持可复用 Model Provider".into())
    }
}

fn validate_request(request: &AgentModelProviderSaveRequest) -> Result<(), super::NativeError> {
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

pub async fn preview_import(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
) -> Result<AgentModelProviderImportPreviewView, super::NativeError> {
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

pub async fn apply_import(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
    source_ids: &[String],
) -> Result<AgentModelProvidersView, super::NativeError> {
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
        "pi" => drafts.extend(native_pi_drafts(&homes.pi).await?),
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
    let document = read_json_object_or_empty(&claude_home.join("settings.json")).await?;
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
    let document = read_json_object_or_empty(&path).await?;
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

async fn native_kimi_provider_drafts(kimi_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let table = read_toml_table(&kimi_home.join("config.toml")).await?;
    let Some(providers) = table.get("providers").and_then(toml::Value::as_table) else {
        return Ok(Vec::new());
    };
    let models = table.get("models").and_then(toml::Value::as_table);
    Ok(providers
        .iter()
        .filter(|(id, _)| *id != "vibex")
        .filter_map(|(id, value)| {
            let provider = value.as_table()?;
            let api_url = provider
                .get("base_url")
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if api_url.is_empty() {
                return None;
            }
            let api_key = provider
                .get("api_key")
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let model = models
                .and_then(|models| models.get(id))
                .and_then(toml::Value::as_table)
                .and_then(|model| model.get("model"))
                .and_then(toml::Value::as_str)
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
        .collect())
}

async fn native_hermes_draft(hermes_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let path = hermes_home.join("config.yaml");
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let document: serde_yaml::Value =
        serde_yaml::from_str(&text).map_err(|error| format!("{} 无效：{error}", path.display()))?;
    let Some(model) = document.get("model") else {
        return Ok(Vec::new());
    };
    let api_url = model
        .get("base_url")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if api_url.is_empty() {
        return Ok(Vec::new());
    }
    let api_key = model
        .get("api_key")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let model_id = model
        .get("default")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(vec![ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key,
        model: model_id,
        skip_reason: None,
    }])
}

async fn native_cline_draft(cline_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let state = read_json_object_or_empty(&cline_home.join("globalState.json")).await?;
    let secrets = read_json_object_or_empty(&cline_home.join("secrets.json")).await?;
    let api_url = json_text(&state, &["openAiBaseUrl"]);
    if api_url.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key: json_text(
            &secrets,
            &["openAiApiKey", "apiKey", "openRouterApiKey", "geminiApiKey"],
        ),
        model: json_text(&state, &["apiModelId"]),
        skip_reason: None,
    }])
}

async fn native_openclaw_drafts(openclaw_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let document = read_json_object_or_empty(&openclaw_home.join("openclaw.json")).await?;
    let Some(providers) = document
        .pointer("/models/providers")
        .and_then(Value::as_object)
    else {
        return Ok(Vec::new());
    };
    Ok(providers
        .iter()
        .filter(|(id, _)| *id != "vibex")
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
        .collect())
}

async fn native_pi_drafts(pi_home: &Path) -> Result<Vec<ImportDraft>, String> {
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
            let api_key = auth.get(id).map(pi_auth_key).unwrap_or_default();
            let model_id = object
                .get("models")
                .and_then(Value::as_array)
                .and_then(|models| {
                    models
                        .iter()
                        .find_map(|entry| entry.get("id").and_then(Value::as_str))
                })
                .unwrap_or(if default_provider == id {
                    default_model
                } else {
                    ""
                });
            let api = object
                .get("api")
                .and_then(Value::as_str)
                .unwrap_or("openai-responses");
            Some(ImportDraft {
                source_id: format!("native:{id}"),
                name: id.clone(),
                api_url,
                api_key,
                model: serde_json::json!({ "id": model_id, "api": api }).to_string(),
                skip_reason: None,
            })
        })
        .collect())
}

async fn native_codex_drafts(codex_home: &Path) -> Result<Vec<ImportDraft>, String> {
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

pub async fn resolve_probe_target(
    store_path: &Path,
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
    provider_id: Option<&str>,
    api_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(String, String), super::NativeError> {
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
    let provider_id = provider_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| super::NativeError::from("测试连接需要 Provider"))?;
    let homes = ProviderNativeHomes::resolve(home, environment);
    let view = list_with_native(
        store_path,
        agent_id.clone(),
        Some(homes.native_list_home(agent_id)),
    )
    .await?;
    let provider = view
        .providers
        .iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| super::NativeError::from("找不到要测试的 Provider"))?;
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
        .ok_or_else(|| super::NativeError::from("找不到可用于测试的 Provider 凭据"))?;
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
) -> Result<ProviderProjectionBackup, super::NativeError> {
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
        "pi" => {
            capture_text_file(
                &homes.pi.join("settings.json"),
                "settings.json",
                &mut backup,
            )
            .await?;
            capture_text_file(&homes.pi.join("models.json"), "models.json", &mut backup).await?;
            capture_text_file(&homes.pi.join("auth.json"), "auth.json", &mut backup).await?;
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
        "pi" => ["settings.json", "models.json", "auth.json"].as_slice(),
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
) -> Result<(), super::NativeError> {
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

async fn capture_json_root(
    path: &Path,
    keys: &[&str],
    backup: &mut ProviderProjectionBackup,
) -> Result<(), super::NativeError> {
    let document = read_json_object_or_empty(path).await?;
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
) -> Result<(), super::NativeError> {
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
) -> Result<(), super::NativeError> {
    let value = match tokio::fs::read_to_string(path).await {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display()).into()),
    };
    backup.file_values.insert(key.to_string(), value);
    Ok(())
}

async fn restore_projection(
    homes: &ProviderNativeHomes,
    agent_id: &AgentId,
    backup: &ProviderProjectionBackup,
) -> Result<(), super::NativeError> {
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
        "pi" => {
            restore_text_file(
                &homes.pi.join("settings.json"),
                "settings.json",
                backup,
                false,
            )
            .await?;
            restore_text_file(&homes.pi.join("models.json"), "models.json", backup, false).await?;
            restore_text_file(&homes.pi.join("auth.json"), "auth.json", backup, true).await
        }
        _ => validate_agent(agent_id),
    }
}

async fn restore_text_file(
    path: &Path,
    key: &str,
    backup: &ProviderProjectionBackup,
    sensitive: bool,
) -> Result<(), super::NativeError> {
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

async fn restore_codex_projection(
    codex_home: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), super::NativeError> {
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

async fn restore_json_env(
    path: &Path,
    keys: &[&str],
    backup: &ProviderProjectionBackup,
    sensitive: bool,
) -> Result<(), super::NativeError> {
    let mut document = read_json_object_or_empty(path).await?;
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
) -> Result<(), super::NativeError> {
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
            .ok_or_else(|| super::NativeError::from("Codex model_providers 必须是表"))?;
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

async fn read_toml_table(path: &Path) -> Result<toml::Table, super::NativeError> {
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
async fn write_toml_table(path: &Path, table: &toml::Table) -> Result<(), super::NativeError> {
    let bytes = toml::to_string_pretty(table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 {} 失败：{error}", path.display()))?;
    write_bytes_document(path, &bytes, false).await
}

#[cfg(test)]
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
) -> Result<(), super::NativeError> {
    match provider.agent_id.as_str() {
        "claude_code" => apply_claude(&homes.claude, provider).await,
        "codex" => apply_codex(&homes.codex, provider).await,
        "gemini" => apply_gemini(&homes.gemini, provider).await,
        "grok" => apply_grok(&homes.grok, provider).await,
        "kimi_code" => apply_kimi(&homes.kimi, provider).await,
        "hermes" => apply_hermes(&homes.hermes, provider).await,
        "openclaw" => apply_openclaw(&homes.openclaw, provider).await,
        "cline" => apply_cline(&homes.cline, provider).await,
        "pi" => apply_pi(&homes.pi, provider).await,
        _ if is_antigravity(&provider.agent_id) => apply_antigravity(&homes.gemini, provider).await,
        _ => validate_agent(&provider.agent_id),
    }
}

async fn apply_claude(
    claude_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
    let path = claude_home.join("settings.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
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
) -> Result<(), super::NativeError> {
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

async fn remove_native_codex_provider(
    codex_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
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

const ANTIGRAVITY_AUTH_TYPE_BACKUP_KEY: &str = "auth.type";

async fn capture_antigravity_auth_type(
    path: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), super::NativeError> {
    let document = read_json_object_or_empty(path).await?;
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
) -> Result<(), super::NativeError> {
    let mut document = read_json_object_or_empty(path).await?;
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

async fn apply_antigravity(
    gemini_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
    let path = antigravity_settings_path(gemini_home);
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
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
) -> Result<&'a mut toml::Table, super::NativeError> {
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

async fn write_toml_mutation(
    path: &Path,
    original: Option<Vec<u8>>,
    table: &toml::Table,
    sensitive: bool,
) -> Result<(), super::NativeError> {
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

async fn apply_grok(grok_home: &Path, provider: &StoredProvider) -> Result<(), super::NativeError> {
    let path = grok_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
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

async fn apply_kimi(kimi_home: &Path, provider: &StoredProvider) -> Result<(), super::NativeError> {
    let path = kimi_home.join("config.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
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

async fn seed_kimi_gate_credential(path: &Path) -> Result<(), super::NativeError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("创建 Kimi credentials 失败：{error}"))?;
    }
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(path).await?;
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

async fn apply_hermes(
    hermes_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
    let path = hermes_home.join("config.yaml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut document: serde_yaml::Value = match original.as_deref() {
        Some(bytes) if !bytes.is_empty() => serde_yaml::from_slice(bytes)
            .map_err(|error| format!("{} 无效：{error}", path.display()))?,
        _ => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| super::NativeError::from("Hermes config.yaml 顶层必须是对象"))?;
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
        .ok_or_else(|| super::NativeError::from("Hermes model 必须是对象"))?;
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

async fn apply_openclaw(
    openclaw_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
    let path = openclaw_home.join("openclaw.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
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

async fn apply_pi(pi_home: &Path, provider: &StoredProvider) -> Result<(), super::NativeError> {
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
    let model_id = pi_model_id(&provider.model);
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
    let providers = object_entry(models.as_object_mut().expect("object"), "providers")?;
    let api_key = provider.api_key.trim();
    if !api_key.is_empty() {
        auth.as_object_mut().expect("object").insert(
            native_id.clone(),
            serde_json::json!({
                "type": "api_key",
                "key": api_key
            }),
        );
    }
    providers.insert(
        native_id,
        serde_json::json!({
            "baseUrl": provider.api_url,
            "api": api,
            "models": [{
                "id": model_id,
                "name": provider.name
            }]
        }),
    );
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

async fn remove_native_pi_provider(
    pi_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
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

const PI_RESERVED_PROVIDER_IDS: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "openrouter",
    "vercel-ai-gateway",
    "xai",
    "deepseek",
    "groq",
    "cerebras",
    "mistral",
    "nvidia",
    "together",
    "fireworks",
    "huggingface",
    "kimi-coding",
    "moonshotai",
    "moonshotai-cn",
    "zai",
    "zai-coding-cn",
    "minimax",
    "minimax-cn",
    "ant-ling",
    "xiaomi",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-sgp",
    "opencode",
    "opencode-go",
];

fn pi_auth_key(entry: &Value) -> String {
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

fn pi_native_id(provider: &StoredProvider) -> String {
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

fn pi_model_id(raw: &str) -> String {
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

fn pi_wire_api(raw: &str) -> &'static str {
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

async fn apply_cline(
    cline_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
    let state_path = cline_home.join("globalState.json");
    let secrets_path = cline_home.join("secrets.json");
    let filesystem = TokioNativeFileSystem;
    let state_original = filesystem.read(&state_path).await?;
    let secrets_original = filesystem.read(&secrets_path).await?;
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

async fn apply_gemini(
    gemini_home: &Path,
    provider: &StoredProvider,
) -> Result<(), super::NativeError> {
    let path = gemini_home.join("settings.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
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

fn parse_json_object_bytes(path: &Path, bytes: Option<&[u8]>) -> Result<Value, super::NativeError> {
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

fn parse_toml_table_bytes(
    path: &Path,
    bytes: Option<&[u8]>,
) -> Result<toml::Table, super::NativeError> {
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

async fn apply_projection_mutations(
    mutations: &[NativeFileMutation],
) -> Result<(), super::NativeError> {
    TokioNativeFileSystem
        .apply_many_atomic(mutations)
        .await
        .map_err(super::NativeError::from)
}

fn object_entry<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, super::NativeError> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .ok_or_else(|| format!("原生配置字段 `{key}` 必须是对象").into())
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

async fn write_json(
    path: &Path,
    document: &Value,
    sensitive: bool,
) -> Result<(), super::NativeError> {
    let bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("序列化原生配置失败：{error}"))?;
    write_bytes_document(path, &bytes, sensitive).await
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
            resolve_probe_api_key_from(
                &store_path,
                &AgentId::parse("gemini").unwrap(),
                Some("provider-1"),
                Some("draft-secret"),
                None,
                None
            )
            .await
            .unwrap(),
            "draft-secret"
        );
        assert_eq!(
            resolve_probe_api_key_from(
                &store_path,
                &AgentId::parse("gemini").unwrap(),
                Some("provider-1"),
                None,
                None,
                None
            )
            .await
            .unwrap(),
            "saved-secret"
        );
    }

    #[tokio::test]
    async fn probe_key_falls_back_to_native_codex_auth_when_store_secret_is_empty() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/providers.json");
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
        write_store(
            &store_path,
            &ProviderStore {
                providers: vec![StoredProvider {
                    id: "custom".to_string(),
                    name: "Custom".to_string(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    api_url: "https://api.custom.example/v1".to_string(),
                    api_key: String::new(),
                    model: String::new(),
                }],
                ..ProviderStore::default()
            },
        )
        .await
        .unwrap();

        let key = resolve_probe_api_key_from(
            &store_path,
            &AgentId::parse("codex").unwrap(),
            Some("custom"),
            None,
            Some(&home),
            Some(&HashMap::new()),
        )
        .await
        .unwrap();
        assert_eq!(key, "sk-native");

        let listed = list_with_native(
            &store_path,
            AgentId::parse("codex").unwrap(),
            Some(&codex_home),
        )
        .await
        .unwrap();
        assert_eq!(listed.providers[0].api_key, "sk-native");
        assert!(listed.providers[0].credential_present);
    }

    #[tokio::test]
    async fn lists_native_codex_provider_from_external_catalog_without_official_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("external.json"),
            r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"custom\"\nmodel_catalog_json = \"external.json\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"sk-native"}"#,
        )
        .await
        .unwrap();

        let listed = list_with_native(
            &store_path,
            AgentId::parse("codex").unwrap(),
            Some(&codex_home),
        )
        .await
        .unwrap();

        let custom = listed
            .providers
            .iter()
            .find(|provider| provider.id == "custom")
            .expect("native provider");
        assert_eq!(custom.api_url, "https://api.custom.example/v1");
        assert_eq!(custom.model, "gateway/model");
        assert_eq!(custom.api_key, "sk-native");
        assert!(custom.bound);
        assert_eq!(listed.bound_provider_id.as_deref(), Some("custom"));
    }

    async fn write_external_codex_provider(codex_home: &Path) {
        tokio::fs::create_dir_all(codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("external.json"),
            r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model = \"gateway/model\"\nmodel_provider = \"custom\"\nmodel_catalog_json = \"external.json\"\nkeep = true\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"sk-native","keep":true}"#,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn standard_codex_preset_bind_replaces_provider_fields_without_touching_external_catalog()
    {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/providers.json");
        write_external_codex_provider(&codex_home).await;
        let agent_id = AgentId::parse("codex").unwrap();
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
                model: "preset-model".to_string(),
            },
        )
        .await
        .unwrap();
        let preset_id = created
            .providers
            .iter()
            .find(|provider| provider.name == "Gateway")
            .unwrap()
            .id
            .clone();

        bind(&store_path, &home, &environment, agent_id, Some(preset_id))
            .await
            .unwrap();

        let config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            config.get("model_provider").and_then(toml::Value::as_str),
            Some("vibex")
        );
        assert_eq!(
            config.get("model").and_then(toml::Value::as_str),
            Some("preset-model")
        );
        assert_eq!(
            config
                .get("model_catalog_json")
                .and_then(toml::Value::as_str),
            Some("external.json")
        );
        assert_eq!(
            config.get("keep").and_then(toml::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("vibex"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://gateway.example/v1")
        );
        assert_eq!(
            config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("custom"))
                .and_then(toml::Value::as_table)
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str),
            Some("https://api.custom.example/v1")
        );
        assert_eq!(
            tokio::fs::read_to_string(codex_home.join("external.json"))
                .await
                .unwrap(),
            r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#
        );
        assert!(!codex_home.join(CODEX_SOURCE_FILE).exists());
        let auth: Value =
            serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
                .unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "new-secret");
        assert_eq!(auth["keep"], true);
    }

    #[tokio::test]
    async fn enabling_native_codex_provider_restores_official_config_and_external_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let store_path = temp.path().join("data/providers.json");
        write_external_codex_provider(&codex_home).await;
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let listed = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .unwrap();
        let native_id = listed
            .providers
            .iter()
            .find(|provider| provider.id == "custom")
            .unwrap()
            .id
            .clone();
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
                model: "preset-model".to_string(),
            },
        )
        .await
        .unwrap();
        let preset_id = created
            .providers
            .iter()
            .find(|provider| provider.name == "Gateway")
            .unwrap()
            .id
            .clone();
        bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some(preset_id),
        )
        .await
        .unwrap();

        let rebound = bind(&store_path, &home, &environment, agent_id, Some(native_id))
            .await
            .unwrap();

        let config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            config.get("model_provider").and_then(toml::Value::as_str),
            Some("custom")
        );
        assert_eq!(
            config
                .get("model_catalog_json")
                .and_then(toml::Value::as_str),
            Some("external.json")
        );
        assert_eq!(
            config.get("model").and_then(toml::Value::as_str),
            Some("gateway/model")
        );
        assert!(
            config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .is_none_or(|providers| !providers.contains_key("vibex"))
        );
        assert_eq!(
            tokio::fs::read_to_string(codex_home.join("external.json"))
                .await
                .unwrap(),
            r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#
        );
        assert!(!codex_home.join(CODEX_SOURCE_FILE).exists());
        let custom = rebound
            .providers
            .iter()
            .find(|provider| provider.id == "custom")
            .unwrap();
        assert!(custom.bound);
        assert_eq!(rebound.bound_provider_id.as_deref(), Some("custom"));
        let auth: Value =
            serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
                .unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "sk-native");
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
    async fn structured_codex_preset_model_binds_without_official_catalog() {
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
                name: "Catalog-shaped Provider".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: Some("new-secret".to_string()),
                model: r#"{"customs":[{"slug":"gateway-a","base":"official-a"}],"excluded_officials":[],"default_model":"gateway-a"}"#.to_string(),
            },
        )
        .await
        .unwrap();

        bind(
            &store_path,
            &home,
            &environment,
            agent_id,
            Some(created.providers[0].id.clone()),
        )
        .await
        .unwrap();

        let auth: Value =
            serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
                .unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "new-secret");
        assert_eq!(auth["keep"], true);
        let config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert_eq!(
            config.get("model").and_then(toml::Value::as_str),
            Some("gateway-a")
        );
        assert_eq!(
            config
                .get("model_catalog_json")
                .and_then(toml::Value::as_str),
            Some(CODEX_CATALOG_FILE)
        );
        assert_eq!(
            config.get("keep").and_then(toml::Value::as_bool),
            Some(true)
        );
        let catalog: Value = serde_json::from_slice(
            &tokio::fs::read(codex_home.join(CODEX_CATALOG_FILE))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(catalog["models"][0]["slug"], "gateway-a");
        assert!(codex_home.join(CODEX_SOURCE_FILE).exists());
        let store = read_store(&store_path).await.unwrap();
        assert!(!store.bindings.is_empty());
        assert!(!store.projection_backups.is_empty());
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
        assert_eq!(
            bound_config
                .get("model_catalog_json")
                .and_then(toml::Value::as_str),
            Some("vibex-model-catalog.json")
        );
        let bound_catalog: Value = serde_json::from_slice(
            &tokio::fs::read(codex_home.join(CODEX_CATALOG_FILE))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(bound_catalog["models"][0]["slug"], "gateway-a");

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
        assert_eq!(native.api_key, "sk-native");
        assert!(native.bound);
        assert!(native.managed);
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
        assert!(entry.managed);
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
            .find(|provider| provider.name == "VibeX Gateway")
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
        assert!(native.managed);
    }

    #[tokio::test]
    async fn native_config_wins_over_a_stale_vibex_store_binding() {
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
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let created = save(
            &store_path,
            &home,
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
            &home,
            &environment,
            agent_id.clone(),
            Some(managed_id.clone()),
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model = \"deepseek-v4-flash\"\nmodel_provider = \"DeepSeek\"\n\n[model_providers.DeepSeek]\nname = \"DeepSeek\"\nbase_url = \"https://api.deepseek.example/v1\"\nwire_api = \"responses\"\n",
        )
        .await
        .unwrap();

        let view = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .unwrap();
        assert_eq!(view.bound_provider_id.as_deref(), Some("DeepSeek"));
        let native = view
            .providers
            .iter()
            .find(|provider| provider.id == "DeepSeek")
            .expect("native DeepSeek provider");
        assert!(native.bound);
        assert!(native.managed);
        let managed = view
            .providers
            .iter()
            .find(|provider| provider.id == managed_id)
            .expect("VibeX preset remains listed");
        assert!(!managed.bound);
        assert!(managed.managed);

        let store = read_store(&store_path).await.unwrap();
        assert!(!store.bindings.contains_key("codex"));
        assert!(!store.projection_backups.contains_key("codex"));

        let state = read_native_codex_state(&codex_home).await.unwrap();
        assert!(native_codex_provider_ready(&state));
        assert!(state.credential_present);
    }

    #[tokio::test]
    async fn native_deepseek_provider_is_ready_without_a_vibex_slot() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("auth.json"),
            br#"{"OPENAI_API_KEY":"sk-native"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"deepseek\"\n\n[model_providers.deepseek]\nname = \"DeepSeek Gateway\"\nbase_url = \"https://api.deepseek.example/v1\"\n",
        )
        .await
        .unwrap();
        let state = read_native_codex_state(&codex_home).await.unwrap();
        assert_eq!(state.active_provider.as_deref(), Some("deepseek"));
        assert!(native_codex_provider_ready(&state));
        assert!(!native_uses_vibex_projection(Some(&state)));
    }

    #[tokio::test]
    async fn adopted_native_codex_provider_can_be_enabled_after_creating_another() {
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
            "model = \"deepseek-v4-flash\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\nwire_api = \"responses\"\n",
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        let listed = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .unwrap();
        assert_eq!(listed.bound_provider_id.as_deref(), Some("custom"));
        assert!(listed.providers.iter().all(|provider| provider.managed));
        save(
            &store_path,
            &home,
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
        let bound = bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            Some("custom".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(bound.bound_provider_id.as_deref(), Some("custom"));
        let custom = bound
            .providers
            .iter()
            .find(|provider| provider.id == "custom")
            .unwrap();
        assert!(custom.bound);
        assert!(custom.managed);
        let vibex = bound
            .providers
            .iter()
            .find(|provider| provider.name == "VibeX Gateway")
            .unwrap();
        assert!(!vibex.bound);
    }

    #[tokio::test]
    async fn delete_rejects_the_in_use_provider_and_the_last_remaining_provider() {
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
            "model = \"deepseek-v4-flash\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
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
                name: "VibeX Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://vibex.example/v1".to_string(),
                api_key: Some("vibex-secret".to_string()),
                model: "vibex-model".to_string(),
            },
        )
        .await
        .unwrap();
        let vibex_id = created
            .providers
            .iter()
            .find(|provider| provider.name == "VibeX Gateway")
            .unwrap()
            .id
            .clone();
        let in_use = delete(&store_path, &home, &environment, agent_id.clone(), "custom")
            .await
            .unwrap_err();
        assert!(in_use.contains("无法删除正在使用的供应商"));

        let view = delete(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            &vibex_id,
        )
        .await
        .unwrap();
        assert_eq!(view.providers.len(), 1);
        assert_eq!(view.bound_provider_id.as_deref(), Some("custom"));
        assert!(
            view.providers
                .iter()
                .all(|provider| provider.id == "custom")
        );

        let last = delete(&store_path, &home, &environment, agent_id.clone(), "custom")
            .await
            .unwrap_err();
        assert!(last.contains("至少需要保留一个供应商"));

        let config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        assert!(
            config
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .is_some_and(|providers| providers.contains_key("custom"))
        );
        let relisted = list_with_native(&store_path, agent_id, Some(&codex_home))
            .await
            .unwrap();
        assert_eq!(relisted.providers.len(), 1);
        assert_eq!(relisted.providers[0].id, "custom");
    }

    #[tokio::test]
    async fn delete_unbound_native_provider_removes_native_table() {
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
            "model = \"deepseek-v4-flash\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n\n[model_providers.spare]\nname = \"Spare\"\nbase_url = \"https://api.spare.example/v1\"\n",
        )
        .await
        .unwrap();
        let agent_id = AgentId::parse("codex").unwrap();
        let environment = HashMap::new();
        list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .unwrap();
        let view = delete(&store_path, &home, &environment, agent_id.clone(), "spare")
            .await
            .unwrap();
        assert!(view.providers.iter().all(|provider| provider.id != "spare"));
        assert_eq!(view.bound_provider_id.as_deref(), Some("custom"));
        let config = read_toml_table(&codex_home.join("config.toml"))
            .await
            .unwrap();
        let providers = config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .unwrap();
        assert!(providers.contains_key("custom"));
        assert!(!providers.contains_key("spare"));
        let relisted = list_with_native(&store_path, agent_id, Some(&codex_home))
            .await
            .unwrap();
        assert!(
            relisted
                .providers
                .iter()
                .all(|provider| provider.id != "spare")
        );
    }

    #[tokio::test]
    async fn native_import_of_claude_custom_endpoint_reuses_the_live_provider() {
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
        assert!(imported.providers[0].bound);
        assert_eq!(
            imported.bound_provider_id.as_deref(),
            Some(imported.providers[0].id.as_str())
        );
    }

    #[tokio::test]
    async fn pi_provider_binding_writes_models_auth_and_settings() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let agent_dir = home.join(".pi/agent");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&agent_dir).await.unwrap();
        tokio::fs::write(&agent_dir.join("settings.json"), br#"{"theme":"dark"}"#)
            .await
            .unwrap();
        tokio::fs::write(&agent_dir.join("models.json"), br#"{"keep":true}"#)
            .await
            .unwrap();
        tokio::fs::write(&agent_dir.join("auth.json"), br#"{}"#)
            .await
            .unwrap();
        let agent_id = AgentId::parse("pi").unwrap();
        let created = save(
            &store_path,
            &home,
            &HashMap::new(),
            AgentModelProviderSaveRequest {
                id: None,
                name: "Private Gateway".to_string(),
                agent_id: agent_id.clone(),
                api_url: "https://private.example/v1".to_string(),
                api_key: Some("sk-pi".to_string()),
                model: r#"{"id":"private-model","api":"openai-responses"}"#.to_string(),
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
        let settings: Value = serde_json::from_slice(
            &tokio::fs::read(agent_dir.join("settings.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        let models: Value = serde_json::from_slice(
            &tokio::fs::read(agent_dir.join("models.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        let auth: Value =
            serde_json::from_slice(&tokio::fs::read(agent_dir.join("auth.json")).await.unwrap())
                .unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["defaultProvider"], "private-gateway");
        assert_eq!(settings["defaultModel"], "private-model");
        assert_eq!(
            models["providers"]["private-gateway"]["baseUrl"],
            "https://private.example/v1"
        );
        assert_eq!(
            models["providers"]["private-gateway"]["api"],
            "openai-responses"
        );
        assert_eq!(auth["private-gateway"]["key"], "sk-pi");
        assert_eq!(models["keep"], true);

        bind(&store_path, &home, &HashMap::new(), agent_id, None)
            .await
            .unwrap();
        let restored: Value = serde_json::from_slice(
            &tokio::fs::read(agent_dir.join("settings.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(restored["theme"], "dark");
        assert!(restored.get("defaultProvider").is_none());
    }

    #[tokio::test]
    async fn pi_list_recognizes_native_providers_and_active_binding() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let agent_dir = home.join(".pi/agent");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&agent_dir).await.unwrap();
        tokio::fs::write(
            agent_dir.join("settings.json"),
            br#"{"defaultProvider":"private","defaultModel":"private-model"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            agent_dir.join("models.json"),
            br#"{"providers":{"private":{"baseUrl":"https://private.example/v1","api":"openai-responses","models":[{"id":"private-model"}]}}}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            agent_dir.join("auth.json"),
            br#"{"private":{"type":"api_key","key":"sk-pi"},"anthropic":{"type":"api_key","key":"sk-ant"}}"#,
        )
        .await
        .unwrap();
        let view = list_with_native(&store_path, AgentId::parse("pi").unwrap(), Some(&agent_dir))
            .await
            .unwrap();
        assert_eq!(view.bound_provider_id.as_deref(), Some("private"));
        let private = view
            .providers
            .iter()
            .find(|provider| provider.id == "private")
            .expect("native custom provider");
        assert!(private.bound);
        assert!(private.managed);
        assert!(private.credential_present);
        assert_eq!(private.api_key, "sk-pi");
        assert_eq!(private.api_url, "https://private.example/v1");
        assert!(
            view.providers
                .iter()
                .all(|provider| provider.id != "anthropic")
        );
    }

    #[tokio::test]
    async fn pi_list_reads_api_key_aliases_from_auth_entries() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let agent_dir = home.join(".pi/agent");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&agent_dir).await.unwrap();
        tokio::fs::write(
            agent_dir.join("settings.json"),
            br#"{"defaultProvider":"gateway","defaultModel":"go"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            agent_dir.join("models.json"),
            br#"{"providers":{"gateway":{"baseUrl":"https://opencode.ai/zen/go/v1","api":"openai-completions","models":[{"id":"go"}]}}}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            agent_dir.join("auth.json"),
            br#"{"gateway":{"type":"api_key","apiKey":"sk-go"}}"#,
        )
        .await
        .unwrap();
        let view = list_with_native(&store_path, AgentId::parse("pi").unwrap(), Some(&agent_dir))
            .await
            .unwrap();
        let gateway = view
            .providers
            .iter()
            .find(|provider| provider.id == "gateway")
            .expect("gateway");
        assert!(gateway.bound);
        assert!(gateway.credential_present);
        assert_eq!(gateway.api_key, "sk-go");
    }

    #[tokio::test]
    async fn native_claude_custom_endpoint_is_adopted_and_bound() {
        let temp = tempfile::tempdir().unwrap();
        let claude_home = temp.path().join("home/.claude");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-gateway","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
        )
        .await
        .unwrap();
        let view = list_with_native(
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            Some(&claude_home),
        )
        .await
        .unwrap();
        assert_eq!(view.providers.len(), 1);
        let provider = &view.providers[0];
        assert!(provider.managed);
        assert!(provider.bound);
        assert_eq!(provider.api_url, "https://api.deepseek.com");
        assert_eq!(provider.api_key, "sk-gateway");
        assert_eq!(
            view.bound_provider_id.as_deref(),
            Some(provider.id.as_str())
        );
    }

    #[tokio::test]
    async fn official_anthropic_url_is_not_adopted_as_a_provider() {
        let temp = tempfile::tempdir().unwrap();
        let claude_home = temp.path().join("home/.claude");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&claude_home).await.unwrap();
        tokio::fs::write(
            claude_home.join("settings.json"),
            br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"sk-ant"}}"#,
        )
        .await
        .unwrap();
        let view = list_with_native(
            &store_path,
            AgentId::parse("claude_code").unwrap(),
            Some(&claude_home),
        )
        .await
        .unwrap();
        assert!(view.providers.is_empty());
        assert_eq!(view.bound_provider_id, None);
    }

    #[tokio::test]
    async fn native_gemini_custom_endpoint_is_adopted_and_bound() {
        let temp = tempfile::tempdir().unwrap();
        let gemini_home = temp.path().join("home/.gemini");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&gemini_home).await.unwrap();
        tokio::fs::write(
            gemini_home.join("settings.json"),
            br#"{"env":{"GEMINI_BASE_URL":"https://gateway.example/v1","GEMINI_API_KEY":"sk-gemini","GEMINI_MODEL":"gemini-pro"}}"#,
        )
        .await
        .unwrap();
        let view = list_with_native(
            &store_path,
            AgentId::parse("gemini").unwrap(),
            Some(&gemini_home),
        )
        .await
        .unwrap();
        assert_eq!(view.providers.len(), 1);
        let provider = &view.providers[0];
        assert!(provider.bound);
        assert_eq!(provider.api_url, "https://gateway.example/v1");
        assert_eq!(provider.api_key, "sk-gemini");
    }

    #[tokio::test]
    async fn native_grok_custom_model_is_adopted_and_bound() {
        let temp = tempfile::tempdir().unwrap();
        let grok_home = temp.path().join("home/.grok");
        let store_path = temp.path().join("data/providers.json");
        tokio::fs::create_dir_all(&grok_home).await.unwrap();
        tokio::fs::write(
            grok_home.join("config.toml"),
            r#"
[model.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
api_key = "sk-grok"
model = "grok-4"
"#,
        )
        .await
        .unwrap();
        let view = list_with_native(
            &store_path,
            AgentId::parse("grok").unwrap(),
            Some(&grok_home),
        )
        .await
        .unwrap();
        assert_eq!(view.providers.len(), 1);
        let provider = &view.providers[0];
        assert!(provider.bound);
        assert!(provider.credential_present);
        assert_eq!(provider.api_url, "https://gateway.example/v1");
        assert_eq!(provider.api_key, "sk-grok");
    }
}
