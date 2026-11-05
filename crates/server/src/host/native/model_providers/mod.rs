use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use api_types::{AgentId, AgentModelProviderSaveRequest, AgentModelProvidersView};

use super::model_provider_import::{ImportDraft, annotate_duplicate};

mod auggie;
mod claude;
mod cline;
mod codebuddy;
mod codex;
mod command_code;
mod common;
mod gemini;
mod grok;
mod hermes;
mod kimi;
mod openclaw;
mod ops;
mod pi;
mod qoder;
mod trae;
mod zcode;

use auggie::*;
use claude::*;
use cline::*;
use codebuddy::*;
use codex::*;
pub use codex::{
    NativeCodexProvider, NativeCodexState, native_codex_provider_ready,
    native_codex_provider_ready_at, read_native_codex_state,
};
use command_code::*;
use common::*;
use gemini::*;
use grok::*;
pub use grok::{NativeGrokProvider, NativeGrokState, read_native_grok_state};
use hermes::*;
use kimi::*;
pub use kimi::{
    has_synthetic_gate, kimi_credential_is_synthetic, prepare_kimi_vibex_configuration_cleanup,
};
use openclaw::*;
use ops::*;
pub use ops::{apply_import, preview_import, resolve_probe_api_key_from, resolve_probe_target};
use pi::*;
use qoder::*;
use trae::*;
use zcode::*;

#[derive(Debug, Clone)]
struct ProviderNativeHomes {
    pub(super) claude: PathBuf,
    pub(super) codex: PathBuf,
    pub(super) gemini: PathBuf,
    pub(super) grok: PathBuf,
    pub(super) kimi: PathBuf,
    pub(super) hermes: PathBuf,
    pub(super) openclaw: PathBuf,
    pub(super) cline: PathBuf,
    pub(super) pi: PathBuf,
    pub(super) codebuddy: PathBuf,
    pub(super) qoder: PathBuf,
    pub(super) auggie: PathBuf,
    pub(super) trae: PathBuf,
    pub(super) command_code: PathBuf,
    pub(super) zcode: PathBuf,
    pub(super) omp: PathBuf,
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
            codebuddy: resolve_native_home(home, environment, "CODEBUDDY_CONFIG_DIR", ".codebuddy"),
            qoder: resolve_native_home(home, environment, "QODER_CONFIG_DIR", ".qoder"),
            auggie: resolve_native_home(home, environment, "AUGMENT_CACHE_DIR", ".augment"),
            trae: resolve_native_home(home, environment, "TRAE_HOME", ".trae"),
            command_code: resolve_native_home(
                home,
                environment,
                "COMMAND_CODE_HOME",
                ".commandcode",
            ),
            zcode: resolve_native_home(home, environment, "ZCODE_HOME", ".zcode"),
            omp: omp_provider_home(home, environment),
        }
    }

    fn native_list_home(&self, agent_id: &AgentId) -> &Path {
        match agent_id.as_str() {
            "pi" => &self.pi,
            "omp" => &self.omp,
            "claude_code" => &self.claude,
            "grok" => &self.grok,
            "kimi_code" => &self.kimi,
            "hermes" => &self.hermes,
            "openclaw" => &self.openclaw,
            "cline" => &self.cline,
            "codebuddy" => &self.codebuddy,
            "qoder" => &self.qoder,
            "auggie" => &self.auggie,
            "trae" => &self.trae,
            "command_code" => &self.command_code,
            "zcode" => &self.zcode,
            _ if is_antigravity(agent_id) => &self.gemini,
            _ => &self.codex,
        }
    }
}

fn omp_provider_home(home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    let map = environment
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    agents::omp_agent_dir(home, &map)
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
        "grok" => {
            let native = match native_home {
                Some(home) => Some(read_native_grok_state(home).await?),
                None => None,
            };
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, &agent_id, &grok_native_drafts(native.as_ref())) {
                write_store(store_path, &store).await?;
            }
            Ok(project_with_grok_native(&store, agent_id, native.as_ref()))
        }
        "omp" => {
            let native = match native_home {
                Some(home) => agents::omp_providers::read_state(home).await?,
                None => agents::omp_providers::OmpNativeState {
                    drafts: Vec::new(),
                    active_provider: None,
                },
            };
            let drafts = omp_native_drafts(&native);
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, &agent_id, &drafts) {
                write_store(store_path, &store).await?;
            }
            let mut view = project(&store, agent_id);
            if view.bound_provider_id.is_none() {
                apply_native_active_binding(
                    &mut view,
                    native.active_provider.as_deref(),
                    native
                        .drafts
                        .iter()
                        .map(|draft| (draft.id.as_str(), draft.api_url.as_str())),
                    None,
                );
            }
            Ok(view)
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
    let bound = store.bindings.get(request.agent_id.as_str()) == Some(&id);
    let index = match existing {
        Some(index) => {
            store.providers[index] = provider;
            index
        }
        None => {
            store.providers.push(provider);
            store.providers.len() - 1
        }
    };
    if bound {
        let rollback = capture_projection(&homes, &request.agent_id).await?;
        if let Err(error) = apply_provider(&homes, &store.providers[index]).await {
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
    projected_view(&mut store, store_path, &homes, request.agent_id).await
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
    let native_grok = if agent_id.as_str() == "grok" {
        Some(read_native_grok_state(&homes.grok).await?)
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
        if is_native_grok_channel(&provider, native_grok.as_ref()) {
            if native_uses_vibex_grok_projection(native_grok.as_ref()) {
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
            if current_binding.is_none()
                && !store.projection_backups.contains_key(agent_id.as_str())
            {
                store
                    .projection_backups
                    .insert(agent_id.as_str().to_string(), rollback.clone());
                write_store(store_path, &store).await?;
            }
            if let Err(error) = activate_native_grok_provider(&homes.grok, &provider.id).await {
                restore_projection(&homes, &agent_id, &rollback).await?;
                return Err(error);
            }
            if let Err(error) = clear_grok_subscription_auth(&homes.grok).await {
                restore_projection(&homes, &agent_id, &rollback).await?;
                return Err(error);
            }
            store.bindings.remove(agent_id.as_str());
        } else if is_native_codex_channel(&provider, native_codex.as_ref()) {
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
            if agent_id.as_str() == "grok"
                && let Err(error) = clear_grok_subscription_auth(&homes.grok).await
            {
                restore_projection(&homes, &agent_id, &rollback).await?;
                return Err(error);
            }
            store
                .bindings
                .insert(agent_id.as_str().to_string(), provider_id.to_string());
        }
    } else {
        let native_grok_active = native_grok
            .as_ref()
            .and_then(|state| state.active_provider.as_deref())
            .is_some_and(|id| !id.is_empty());
        if current_binding.is_none() && !native_grok_active {
            if agent_id.as_str() == "omp" {
                agents::omp_providers::clear_active_role(&homes.omp)
                    .await
                    .map_err(super::NativeError::from)?;
            }
            return projected_view(&mut store, store_path, &homes, agent_id).await;
        }
        let backup = store
            .projection_backups
            .get(agent_id.as_str())
            .cloned()
            .unwrap_or_else(|| empty_projection_backup(&agent_id));
        restore_projection(&homes, &agent_id, &backup).await?;
        if agent_id.as_str() == "omp" {
            agents::omp_providers::clear_active_role(&homes.omp)
                .await
                .map_err(super::NativeError::from)?;
        }
        store.bindings.remove(agent_id.as_str());
        store.projection_backups.remove(agent_id.as_str());
    }
    if let Err(error) = write_store(store_path, &store).await {
        restore_projection(&homes, &agent_id, &rollback).await?;
        return Err(error);
    }
    projected_view(&mut store, store_path, &homes, agent_id).await
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
    let native_grok = if agent_id.as_str() == "grok" {
        Some(read_native_grok_state(&homes.grok).await?)
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
        native_grok.as_ref(),
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
    let removed = store.providers.remove(index);
    match agent_id.as_str() {
        "codex" => remove_native_codex_provider(&homes.codex, &removed).await?,
        "pi" => remove_native_pi_provider(&homes.pi, &removed).await?,
        "grok" => remove_native_grok_provider(&homes.grok, &removed).await?,
        "omp" => {
            agents::omp_providers::remove(&homes.omp, &removed.id, &removed.name).await?;
        }
        _ => {}
    }
    write_store(store_path, &store).await?;
    projected_view(&mut store, store_path, &homes, agent_id).await
}

async fn projected_view(
    store: &mut ProviderStore,
    store_path: &Path,
    homes: &ProviderNativeHomes,
    agent_id: AgentId,
) -> Result<AgentModelProvidersView, super::NativeError> {
    match agent_id.as_str() {
        "codex" => {
            let native = read_native_codex_state(&homes.codex).await?;
            if adopt_native_providers(store, &agent_id, &codex_native_drafts(Some(&native))) {
                write_store(store_path, store).await?;
            }
            Ok(project_with_codex_native(store, agent_id, Some(&native)))
        }
        "pi" => {
            let native = read_native_pi_state(&homes.pi).await?;
            if adopt_native_providers(store, &agent_id, &pi_native_drafts(Some(&native))) {
                write_store(store_path, store).await?;
            }
            Ok(project_with_pi_native(store, agent_id, Some(&native)))
        }
        "grok" => {
            let native = read_native_grok_state(&homes.grok).await?;
            if adopt_native_providers(store, &agent_id, &grok_native_drafts(Some(&native))) {
                write_store(store_path, store).await?;
            }
            Ok(project_with_grok_native(store, agent_id, Some(&native)))
        }
        "omp" => {
            let native = agents::omp_providers::read_state(&homes.omp).await?;
            let drafts = omp_native_drafts(&native);
            if adopt_native_providers(store, &agent_id, &drafts) {
                write_store(store_path, store).await?;
            }
            let mut view = project(store, agent_id);
            if view.bound_provider_id.is_none() {
                apply_native_active_binding(
                    &mut view,
                    native.active_provider.as_deref(),
                    native
                        .drafts
                        .iter()
                        .map(|draft| (draft.id.as_str(), draft.api_url.as_str())),
                    None,
                );
            }
            Ok(view)
        }
        _ => {
            let home = homes.native_list_home(&agent_id);
            let drafts = live_native_drafts(&agent_id, home).await?;
            if adopt_native_providers(store, &agent_id, &drafts) {
                write_store(store_path, store).await?;
            }
            Ok(project_with_live_native(store, agent_id, &drafts))
        }
    }
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
        "kimi_code" => native_kimi_provider_drafts(native_home).await?,
        "hermes" => native_hermes_draft(native_home).await?,
        "cline" => native_cline_draft(native_home).await?,
        "openclaw" => native_openclaw_drafts(native_home).await?,
        "omp" => omp_import_drafts(native_home).await?,
        _ if is_antigravity(agent_id) => native_gemini_draft(native_home, agent_id)
            .await?
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    Ok(custom_endpoint_drafts(agent_id, drafts))
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
        "grok" => {
            let native = read_native_grok_state(&homes.grok).await?;
            let mut store = read_store(store_path).await?;
            if adopt_native_providers(&mut store, agent_id, &grok_native_drafts(Some(&native))) {
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
        "omp" => drafts.extend(omp_import_drafts(&homes.omp).await?),
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

fn omp_native_drafts(native: &agents::omp_providers::OmpNativeState) -> Vec<NativeProviderDraft> {
    native
        .drafts
        .iter()
        .filter(|draft| !draft.api_url.is_empty())
        .map(|draft| NativeProviderDraft {
            id: draft.id.clone(),
            name: draft.name.clone(),
            api_url: draft.api_url.clone(),
            api_key: draft.api_key.clone(),
            model: draft.model.clone(),
        })
        .collect()
}

async fn omp_import_drafts(home: &Path) -> Result<Vec<ImportDraft>, String> {
    let native = agents::omp_providers::read_state(home).await?;
    Ok(native
        .drafts
        .into_iter()
        .map(|draft| ImportDraft {
            source_id: format!("native:{}", draft.id),
            name: draft.name,
            api_url: draft.api_url,
            api_key: draft.api_key,
            model: draft.model,
            skip_reason: None,
        })
        .collect())
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
        "omp" => agents::omp_providers::apply(
            &homes.omp,
            &provider.id,
            &provider.name,
            &provider.api_url,
            &provider.api_key,
            &provider.model,
        )
        .await
        .map_err(super::NativeError::from),
        "codebuddy" => apply_codebuddy(&homes.codebuddy, provider).await,
        "qoder" => apply_qoder(&homes.qoder, provider).await,
        "auggie" => apply_auggie(&homes.auggie, provider).await,
        "trae" => apply_trae(&homes.trae, provider).await,
        "command_code" => apply_command_code(&homes.command_code, provider).await,
        "zcode" => apply_zcode(&homes.zcode, provider).await,
        _ if is_antigravity(&provider.agent_id) => apply_antigravity(&homes.gemini, provider).await,
        _ => validate_agent(&provider.agent_id),
    }
}

#[cfg(test)]
mod tests;
