//! Per-agent model provider configuration.
//!
//! Aligned with the cc-switch model: providers are organized **per agent**, one
//! provider can be marked "current", and applying a provider writes its config
//! into that agent CLI's real config file (`~/.claude/settings.json`,
//! `~/.codex/config.toml` + `auth.json`, `~/.gemini/.env` + `settings.json`,
//! `~/.config/opencode/opencode.json`, `~/.openclaw/openclaw.json`,
//! `~/.hermes/config.yaml`). Every write is backed up + atomic.
//!
//! Writing is a two-step pipeline: `render_*` builds the file contents in
//! memory (used for the live preview), then `write_rendered` persists them
//! (honoring any per-file manual override stored with the provider).

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

use chrono::Utc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "model-provider-settings.json";
const SECRETS_FILE_NAME: &str = "model-provider-secrets.json";
const STORE_VERSION: u32 = 2;
const BACKUP_KEEP: usize = 10;

const AUTH_ANTHROPIC: &str = "anthropic";

/// Agents whose provider config we know how to manage.
const SUPPORTED_AGENTS: &[&str] = &[
    "claude_code",
    "codex",
    "gemini",
    "open_code",
    "open_claw",
    "hermes",
    "cline",
];

/// `cline` keeps its provider config inside the VS Code extension's global
/// state, not a switchable file, so file-based apply is unavailable for it.
fn supports_apply(agent: &str) -> bool {
    !matches!(agent, "cline")
}

fn is_anthropic(record: &ProviderRecord) -> bool {
    record.auth_type.as_deref() == Some(AUTH_ANTHROPIC)
}

// ---------------------------------------------------------------------------
// Persistent model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderRecord {
    id: String,
    name: String,
    api_url: String,
    #[serde(default)]
    default_model: Option<String>,
    #[serde(default)]
    models: Vec<String>,
    /// Provider protocol: "openai_compatible" (default) or "anthropic".
    #[serde(default)]
    auth_type: Option<String>,
    /// Codex wire protocol: "chat" (default) or "responses".
    #[serde(default)]
    wire_api: Option<String>,
    /// Manual per-file overrides keyed by file id (e.g. "config.toml").
    #[serde(default)]
    config_overrides: HashMap<String, String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AgentProviders {
    #[serde(default)]
    providers: Vec<ProviderRecord>,
    #[serde(default)]
    current: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderStore {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    agents: HashMap<String, AgentProviders>,
}

impl Default for ProviderStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            agents: HashMap::new(),
        }
    }
}

fn default_version() -> u32 {
    STORE_VERSION
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProviderSecrets {
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

// Legacy (v1) shape, kept only for one-time migration.
#[derive(Debug, Clone, Default, Deserialize)]
struct LegacyStore {
    #[serde(default)]
    providers: Vec<LegacyProvider>,
    #[serde(default)]
    active_by_agent: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LegacyProvider {
    id: String,
    name: String,
    #[serde(default)]
    agent_types: Vec<String>,
    api_url: String,
    #[serde(default)]
    auth_type: Option<String>,
    #[serde(default)]
    default_model: Option<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
}

// ---------------------------------------------------------------------------
// DTOs (frontend-facing)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ProviderView {
    id: String,
    name: String,
    api_url: String,
    default_model: Option<String>,
    models: Vec<String>,
    auth_type: Option<String>,
    wire_api: Option<String>,
    config_overrides: HashMap<String, String>,
    has_api_key: bool,
    is_current: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProvidersView {
    agent_type: String,
    providers: Vec<ProviderView>,
    current: Option<String>,
    supports_apply: bool,
    config_path: Option<String>,
}

/// A config file rendered in memory for preview / write.
#[derive(Debug, Clone, Serialize)]
pub struct RenderedFile {
    /// Stable logical id (file basename), used to key manual overrides.
    id: String,
    path: String,
    language: String,
    content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderPayload {
    pub name: String,
    pub api_url: String,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub auth_type: Option<String>,
    #[serde(default)]
    pub wire_api: Option<String>,
    #[serde(default)]
    pub config_overrides: HashMap<String, String>,
    /// Optional; empty/absent leaves a stored key unchanged on update.
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModelsResult {
    pub provider_id: String,
    pub models: Vec<String>,
    pub fetched_at: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

// ---------------------------------------------------------------------------
// Store IO (VibeX-owned settings + secrets)
// ---------------------------------------------------------------------------

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

fn secrets_path() -> PathBuf {
    utils::assets::asset_dir().join(SECRETS_FILE_NAME)
}

async fn read_store_json<T>(path: PathBuf) -> Result<T, AppError>
where
    T: Default + for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read {}: {e}", path.display())))?;
    if content.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Invalid {}: {e}", path.display())))
}

async fn write_store_json<T>(path: PathBuf, value: &T) -> Result<(), AppError>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to create {}: {e}", parent.display())))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Internal(format!("Failed to serialize JSON: {e}")))?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write {}: {e}", path.display())))
}

async fn save_store(store: &ProviderStore) -> Result<(), AppError> {
    write_store_json(settings_path(), store).await
}

async fn load_secrets() -> Result<ProviderSecrets, AppError> {
    read_store_json(secrets_path()).await
}

async fn save_secrets(secrets: &ProviderSecrets) -> Result<(), AppError> {
    write_store_json(secrets_path(), secrets).await
}

/// Load the store, migrating a legacy (v1) file to the per-agent layout on the
/// fly (and persisting the migration + remapped secrets).
async fn load_store() -> Result<ProviderStore, AppError> {
    let path = settings_path();
    if !path.exists() {
        return Ok(ProviderStore::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read {}: {e}", path.display())))?;
    if content.trim().is_empty() {
        return Ok(ProviderStore::default());
    }
    let value: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Invalid {}: {e}", path.display())))?;

    if value.get("agents").is_some() {
        return serde_json::from_value(value)
            .map_err(|e| AppError::Internal(format!("Invalid {}: {e}", path.display())));
    }

    // Legacy v1 -> v2 migration.
    let legacy: LegacyStore = serde_json::from_value(value).unwrap_or_default();
    let legacy_secrets = load_secrets().await?;
    let (store, secrets) = migrate_legacy(legacy, legacy_secrets);
    save_store(&store).await?;
    save_secrets(&secrets).await?;
    Ok(store)
}

fn migrate_legacy(
    legacy: LegacyStore,
    legacy_secrets: ProviderSecrets,
) -> (ProviderStore, ProviderSecrets) {
    let mut store = ProviderStore::default();
    let mut secrets = ProviderSecrets::default();

    for lp in &legacy.providers {
        let agents: Vec<String> = lp
            .agent_types
            .iter()
            .filter(|agent| SUPPORTED_AGENTS.contains(&agent.as_str()))
            .cloned()
            .collect();

        for agent in agents {
            let new_id = Uuid::new_v4().to_string();
            let created_at = if lp.created_at.is_empty() {
                Utc::now().to_rfc3339()
            } else {
                lp.created_at.clone()
            };
            let updated_at = if lp.updated_at.is_empty() {
                Utc::now().to_rfc3339()
            } else {
                lp.updated_at.clone()
            };

            let entry = store.agents.entry(agent.clone()).or_default();
            entry.providers.push(ProviderRecord {
                id: new_id.clone(),
                name: lp.name.clone(),
                api_url: lp.api_url.clone(),
                default_model: lp.default_model.clone(),
                models: Vec::new(),
                auth_type: lp.auth_type.clone(),
                wire_api: None,
                config_overrides: HashMap::new(),
                created_at,
                updated_at,
            });
            if legacy.active_by_agent.get(&agent) == Some(&lp.id) {
                entry.current = Some(new_id.clone());
            }
            if let Some(key) = legacy_secrets.api_keys.get(&lp.id) {
                secrets.api_keys.insert(new_id, key.clone());
            }
        }
    }

    (store, secrets)
}

// ---------------------------------------------------------------------------
// Validation / helpers
// ---------------------------------------------------------------------------

fn normalize_agent(agent: &str) -> Result<String, AppError> {
    let agent = agent.trim();
    if SUPPORTED_AGENTS.contains(&agent) {
        Ok(agent.to_string())
    } else {
        Err(AppError::BadRequest(format!("未知 Agent：{agent}")))
    }
}

fn opt_trim(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn validate_payload(payload: &ProviderPayload) -> Result<(), AppError> {
    if payload.name.trim().is_empty() {
        return Err(AppError::BadRequest("供应商名称不能为空".to_string()));
    }
    let api_url = payload.api_url.trim().trim_end_matches('/');
    Url::parse(api_url).map_err(|e| AppError::BadRequest(format!("API 地址无效：{e}")))?;
    Ok(())
}

fn record_from_payload(id: String, payload: &ProviderPayload, created_at: String) -> ProviderRecord {
    ProviderRecord {
        id,
        name: payload.name.trim().to_string(),
        api_url: payload.api_url.trim().trim_end_matches('/').to_string(),
        default_model: opt_trim(&payload.default_model),
        models: payload
            .models
            .iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect(),
        auth_type: opt_trim(&payload.auth_type),
        wire_api: opt_trim(&payload.wire_api),
        config_overrides: payload
            .config_overrides
            .iter()
            .filter(|(_, content)| !content.trim().is_empty())
            .map(|(id, content)| (id.clone(), content.clone()))
            .collect(),
        created_at,
        updated_at: Utc::now().to_rfc3339(),
    }
}

fn build_view(agent: &str, store: &ProviderStore, secrets: &ProviderSecrets) -> AgentProvidersView {
    let agent_providers = store.agents.get(agent).cloned().unwrap_or_default();
    let current = agent_providers.current.clone();
    let providers = agent_providers
        .providers
        .iter()
        .map(|record| ProviderView {
            id: record.id.clone(),
            name: record.name.clone(),
            api_url: record.api_url.clone(),
            default_model: record.default_model.clone(),
            models: record.models.clone(),
            auth_type: record.auth_type.clone(),
            wire_api: record.wire_api.clone(),
            config_overrides: record.config_overrides.clone(),
            has_api_key: secrets.api_keys.contains_key(&record.id),
            is_current: current.as_deref() == Some(record.id.as_str()),
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
        })
        .collect();

    AgentProvidersView {
        agent_type: agent.to_string(),
        providers,
        current,
        supports_apply: supports_apply(agent),
        config_path: display_config_path(agent),
    }
}

fn find_record<'a>(
    store: &'a ProviderStore,
    agent: &str,
    provider_id: &str,
) -> Option<&'a ProviderRecord> {
    store
        .agents
        .get(agent)
        .and_then(|ap| ap.providers.iter().find(|p| p.id == provider_id))
}

fn slug(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "provider".to_string()
    } else {
        trimmed
    }
}

fn model_list(record: &ProviderRecord) -> Vec<String> {
    if !record.models.is_empty() {
        return record.models.clone();
    }
    record
        .default_model
        .clone()
        .into_iter()
        .filter(|m| !m.is_empty())
        .collect()
}

fn models_url(api_url: &str) -> String {
    let base = api_url.trim_end_matches('/');
    if base.ends_with("/models") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

// ---------------------------------------------------------------------------
// Config file paths
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn codex_home_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
}

fn hermes_home_dir() -> PathBuf {
    std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".hermes"))
}

fn display_config_path(agent: &str) -> Option<String> {
    let path = match agent {
        "claude_code" => home_dir().join(".claude").join("settings.json"),
        "codex" => codex_home_dir().join("config.toml"),
        "gemini" => home_dir().join(".gemini").join("settings.json"),
        "open_code" => home_dir()
            .join(".config")
            .join("opencode")
            .join("opencode.json"),
        "open_claw" => home_dir().join(".openclaw").join("openclaw.json"),
        "hermes" => hermes_home_dir().join("config.yaml"),
        _ => return None,
    };
    Some(path.display().to_string())
}

// ---------------------------------------------------------------------------
// Atomic write + rotating backups
// ---------------------------------------------------------------------------

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("Failed to create {}: {e}", parent.display())))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".vibextmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)
        .map_err(|e| AppError::Internal(format!("Failed to write {}: {e}", tmp.display())))?;
    #[cfg(windows)]
    {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(format!("Failed to replace {}: {e}", path.display())))
}

/// Best-effort backup of an existing file before overwriting it.
fn backup_existing(path: &Path, agent: &str) {
    if !path.exists() {
        return;
    }
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home
        .join(".vibex")
        .join("provider-backups")
        .join(agent);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let base = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let stamp = Utc::now().format("%Y%m%dT%H%M%S%3f");
    let dest = dir.join(format!("{base}.{stamp}.bak"));
    if std::fs::copy(path, &dest).is_err() {
        tracing::warn!(path = %path.display(), "Failed to back up provider config");
        return;
    }
    rotate_backups(&dir, &base);
}

fn rotate_backups(dir: &Path, base: &str) {
    let prefix = format!("{base}.");
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(read) => read
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(prefix.as_str())
            })
            .map(|entry| entry.path())
            .collect(),
        Err(_) => return,
    };
    entries.sort();
    while entries.len() > BACKUP_KEEP {
        let old = entries.remove(0);
        let _ = std::fs::remove_file(old);
    }
}

// ---------------------------------------------------------------------------
// Typed read helpers per file format
// ---------------------------------------------------------------------------

fn read_json_file(path: &Path) -> Result<Value, AppError> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("Failed to read {}: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&raw)
        .map_err(|e| AppError::BadRequest(format!("invalid JSON at {}: {e}", path.display())))
}

fn read_toml_file(path: &Path) -> Result<toml::Value, AppError> {
    if !path.exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("Failed to read {}: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let parsed: toml::Value = raw
        .parse()
        .map_err(|e| AppError::BadRequest(format!("invalid TOML at {}: {e}", path.display())))?;
    if !parsed.is_table() {
        return Err(AppError::BadRequest(format!(
            "invalid TOML root at {}: expected table",
            path.display()
        )));
    }
    Ok(parsed)
}

fn read_yaml_file(path: &Path) -> Result<serde_yaml::Value, AppError> {
    if !path.exists() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("Failed to read {}: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    serde_yaml::from_str(&raw)
        .map_err(|e| AppError::BadRequest(format!("invalid YAML at {}: {e}", path.display())))
}

fn read_dotenv(path: &Path) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Ok(raw) = std::fs::read_to_string(path) {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                map.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
    }
    map
}

// Serializers producing the final file content (with trailing newline).
fn json_content(value: &Value) -> Result<String, AppError> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::Internal(format!("Failed to serialize JSON: {e}")))?;
    Ok(format!("{serialized}\n"))
}

fn toml_content(value: &toml::Value) -> Result<String, AppError> {
    toml::to_string_pretty(value)
        .map_err(|e| AppError::Internal(format!("Failed to serialize TOML: {e}")))
}

fn yaml_content(value: &serde_yaml::Value) -> Result<String, AppError> {
    serde_yaml::to_string(value)
        .map_err(|e| AppError::Internal(format!("Failed to serialize YAML: {e}")))
}

fn dotenv_content(map: &BTreeMap<String, String>) -> String {
    let mut out = String::new();
    for (key, value) in map {
        out.push_str(&format!("{key}={value}\n"));
    }
    out
}

// JSON object helpers.
fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    match value {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

fn set_nested(root: &mut Value, path: &[&str], leaf: Value) {
    let mut current = ensure_object(root);
    let (last, parents) = path.split_last().expect("non-empty path");
    for key in parents {
        let entry = current
            .entry((*key).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        current = entry.as_object_mut().expect("object");
    }
    current.insert((*last).to_string(), leaf);
}

fn ystr(value: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(value.to_string())
}

fn rendered(id: &str, path: PathBuf, language: &str, content: String) -> RenderedFile {
    RenderedFile {
        id: id.to_string(),
        path: path.display().to_string(),
        language: language.to_string(),
        content,
    }
}

// ---------------------------------------------------------------------------
// Per-agent renderers (in-memory; no write)
// ---------------------------------------------------------------------------

fn render_provider_config(
    agent: &str,
    record: &ProviderRecord,
    api_key: Option<&str>,
) -> Result<Vec<RenderedFile>, AppError> {
    match agent {
        "claude_code" => render_claude(record, api_key),
        "codex" => render_codex(record, api_key),
        "gemini" => render_gemini(record, api_key),
        "open_code" => render_opencode(record, api_key),
        "open_claw" => render_openclaw(record, api_key),
        "hermes" => render_hermes(record, api_key),
        "cline" => Err(AppError::BadRequest(
            "Cline 的供应商配置存储在 VS Code 扩展状态中，暂不支持从 VibeX 切换。".to_string(),
        )),
        other => Err(AppError::BadRequest(format!("未知 Agent：{other}"))),
    }
}

fn render_claude(record: &ProviderRecord, api_key: Option<&str>) -> Result<Vec<RenderedFile>, AppError> {
    let path = home_dir().join(".claude").join("settings.json");
    let mut root = read_json_file(&path)?;
    {
        let obj = ensure_object(&mut root);
        let env = obj
            .entry("env".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let env = ensure_object(env);
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            Value::String(record.api_url.clone()),
        );
        if let Some(key) = api_key {
            env.insert(
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                Value::String(key.to_string()),
            );
        }
        if let Some(model) = &record.default_model {
            env.insert("ANTHROPIC_MODEL".to_string(), Value::String(model.clone()));
        }
    }
    Ok(vec![rendered(
        "settings.json",
        path,
        "json",
        json_content(&root)?,
    )])
}

fn render_codex(record: &ProviderRecord, api_key: Option<&str>) -> Result<Vec<RenderedFile>, AppError> {
    let home = codex_home_dir();
    let toml_path = home.join("config.toml");
    let auth_path = home.join("auth.json");
    let key_name = slug(&record.name);

    let mut root = read_toml_file(&toml_path)?;
    {
        let table = root.as_table_mut().expect("toml table");
        table.insert(
            "model_provider".to_string(),
            toml::Value::String(key_name.clone()),
        );
        if let Some(model) = &record.default_model {
            table.insert("model".to_string(), toml::Value::String(model.clone()));
        }
        let providers = table
            .entry("model_providers".to_string())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
        let providers = providers.as_table_mut().ok_or_else(|| {
            AppError::BadRequest("codex model_providers 必须是 table".to_string())
        })?;
        let mut entry = toml::map::Map::new();
        entry.insert("name".to_string(), toml::Value::String(record.name.clone()));
        entry.insert(
            "base_url".to_string(),
            toml::Value::String(record.api_url.clone()),
        );
        entry.insert(
            "wire_api".to_string(),
            toml::Value::String(record.wire_api.clone().unwrap_or_else(|| "chat".to_string())),
        );
        entry.insert(
            "env_key".to_string(),
            toml::Value::String("OPENAI_API_KEY".to_string()),
        );
        providers.insert(key_name, toml::Value::Table(entry));
    }
    let mut files = vec![rendered("config.toml", toml_path, "toml", toml_content(&root)?)];

    if api_key.is_some() || auth_path.exists() {
        let mut auth = read_json_file(&auth_path)?;
        if let Some(key) = api_key {
            ensure_object(&mut auth).insert(
                "OPENAI_API_KEY".to_string(),
                Value::String(key.to_string()),
            );
        }
        files.push(rendered("auth.json", auth_path, "json", json_content(&auth)?));
    }
    Ok(files)
}

fn render_gemini(record: &ProviderRecord, api_key: Option<&str>) -> Result<Vec<RenderedFile>, AppError> {
    let dir = home_dir().join(".gemini");
    let env_path = dir.join(".env");
    let settings_path = dir.join("settings.json");

    let mut env = read_dotenv(&env_path);
    if let Some(key) = api_key {
        env.insert("GEMINI_API_KEY".to_string(), key.to_string());
    }
    env.insert(
        "GOOGLE_GEMINI_BASE_URL".to_string(),
        record.api_url.clone(),
    );
    if let Some(model) = &record.default_model {
        env.insert("GEMINI_MODEL".to_string(), model.clone());
    }

    let mut settings = read_json_file(&settings_path)?;
    set_nested(
        &mut settings,
        &["security", "auth", "selectedType"],
        Value::String("gemini-api-key".to_string()),
    );

    Ok(vec![
        rendered(".env", env_path, "dotenv", dotenv_content(&env)),
        rendered("settings.json", settings_path, "json", json_content(&settings)?),
    ])
}

fn render_opencode(record: &ProviderRecord, api_key: Option<&str>) -> Result<Vec<RenderedFile>, AppError> {
    let path = home_dir()
        .join(".config")
        .join("opencode")
        .join("opencode.json");
    let key_name = slug(&record.name);
    let npm = if is_anthropic(record) {
        "@ai-sdk/anthropic"
    } else {
        "@ai-sdk/openai-compatible"
    };
    let mut root = read_json_file(&path)?;
    {
        let obj = ensure_object(&mut root);
        obj.entry("$schema".to_string())
            .or_insert_with(|| Value::String("https://opencode.ai/config.json".to_string()));

        let mut models = Map::new();
        for model in model_list(record) {
            models.insert(model, json!({}));
        }
        let block = json!({
            "npm": npm,
            "name": record.name,
            "options": {
                "baseURL": record.api_url,
                "apiKey": api_key.unwrap_or(""),
            },
            "models": Value::Object(models),
        });

        {
            let providers = obj
                .entry("provider".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            ensure_object(providers).insert(key_name.clone(), block);
        }
        if let Some(model) = &record.default_model {
            obj.insert(
                "model".to_string(),
                Value::String(format!("{key_name}/{model}")),
            );
        }
    }
    Ok(vec![rendered("opencode.json", path, "json", json_content(&root)?)])
}

fn render_openclaw(record: &ProviderRecord, api_key: Option<&str>) -> Result<Vec<RenderedFile>, AppError> {
    let path = home_dir().join(".openclaw").join("openclaw.json");
    let key_name = slug(&record.name);
    let api_kind = if is_anthropic(record) { "anthropic" } else { "openai" };
    let mut root = read_json_file(&path)?;
    {
        let obj = ensure_object(&mut root);
        let model_entries: Vec<Value> = model_list(record)
            .into_iter()
            .map(|model| json!({ "id": model }))
            .collect();

        let mut block = Map::new();
        block.insert("baseUrl".to_string(), Value::String(record.api_url.clone()));
        if let Some(key) = api_key {
            block.insert("apiKey".to_string(), Value::String(key.to_string()));
        }
        block.insert("api".to_string(), Value::String(api_kind.to_string()));
        block.insert("models".to_string(), Value::Array(model_entries));

        let models_root = obj
            .entry("models".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let models_root = ensure_object(models_root);
        models_root.insert("mode".to_string(), Value::String("merge".to_string()));
        let providers = models_root
            .entry("providers".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        ensure_object(providers).insert(key_name, Value::Object(block));
    }
    Ok(vec![rendered("openclaw.json", path, "json", json_content(&root)?)])
}

fn render_hermes(record: &ProviderRecord, api_key: Option<&str>) -> Result<Vec<RenderedFile>, AppError> {
    let path = hermes_home_dir().join("config.yaml");
    let mut root = read_yaml_file(&path)?;
    {
        let map = root.as_mapping_mut().ok_or_else(|| {
            AppError::BadRequest("hermes config.yaml 根节点必须是 mapping".to_string())
        })?;
        let cp_key = ystr("custom_providers");
        if !map.contains_key(&cp_key) {
            map.insert(cp_key.clone(), serde_yaml::Value::Sequence(Vec::new()));
        }
        let seq = map
            .get_mut(&cp_key)
            .and_then(|value| value.as_sequence_mut())
            .ok_or_else(|| {
                AppError::BadRequest("hermes custom_providers 必须是序列".to_string())
            })?;

        let mut entry = serde_yaml::Mapping::new();
        entry.insert(ystr("name"), ystr(&record.name));
        entry.insert(ystr("base_url"), ystr(&record.api_url));
        if let Some(key) = api_key {
            entry.insert(ystr("api_key"), ystr(key));
        }
        if let Some(model) = &record.default_model {
            entry.insert(ystr("model"), ystr(model));
        }
        let mut models_map = serde_yaml::Mapping::new();
        for model in model_list(record) {
            models_map.insert(
                ystr(&model),
                serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
            );
        }
        if !models_map.is_empty() {
            entry.insert(ystr("models"), serde_yaml::Value::Mapping(models_map));
        }

        let name_key = ystr("name");
        let existing = seq.iter().position(|value| {
            value
                .as_mapping()
                .and_then(|m| m.get(&name_key))
                .and_then(|n| n.as_str())
                == Some(record.name.as_str())
        });
        match existing {
            Some(index) => seq[index] = serde_yaml::Value::Mapping(entry),
            None => seq.push(serde_yaml::Value::Mapping(entry)),
        }
    }
    Ok(vec![rendered("config.yaml", path, "yaml", yaml_content(&root)?)])
}

/// Persist rendered files, substituting any manual per-file override.
fn write_rendered(
    agent: &str,
    files: &[RenderedFile],
    overrides: &HashMap<String, String>,
) -> Result<Vec<String>, AppError> {
    let mut written = Vec::new();
    for file in files {
        let content = match overrides.get(&file.id) {
            Some(override_content) if !override_content.trim().is_empty() => override_content.clone(),
            _ => file.content.clone(),
        };
        let path = PathBuf::from(&file.path);
        backup_existing(&path, agent);
        atomic_write_bytes(&path, content.as_bytes())?;
        written.push(file.path.clone());
    }
    Ok(written)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_agent_providers(agent_type: String) -> Result<AgentProvidersView, AppError> {
    let agent = normalize_agent(&agent_type)?;
    let store = load_store().await?;
    let secrets = load_secrets().await?;
    Ok(build_view(&agent, &store, &secrets))
}

#[tauri::command]
pub async fn create_agent_provider(
    agent_type: String,
    payload: ProviderPayload,
) -> Result<AgentProvidersView, AppError> {
    let agent = normalize_agent(&agent_type)?;
    validate_payload(&payload)?;

    let mut store = load_store().await?;
    let mut secrets = load_secrets().await?;
    let id = Uuid::new_v4().to_string();
    let record = record_from_payload(id.clone(), &payload, Utc::now().to_rfc3339());

    store
        .agents
        .entry(agent.clone())
        .or_default()
        .providers
        .push(record);

    let mut secrets_dirty = false;
    if let Some(key) = opt_trim(&payload.api_key) {
        secrets.api_keys.insert(id, key);
        secrets_dirty = true;
    }

    save_store(&store).await?;
    if secrets_dirty {
        save_secrets(&secrets).await?;
    }
    Ok(build_view(&agent, &store, &secrets))
}

#[tauri::command]
pub async fn update_agent_provider(
    agent_type: String,
    provider_id: String,
    payload: ProviderPayload,
) -> Result<AgentProvidersView, AppError> {
    let agent = normalize_agent(&agent_type)?;
    validate_payload(&payload)?;

    let mut store = load_store().await?;
    let mut secrets = load_secrets().await?;

    let is_current;
    {
        let agent_providers = store
            .agents
            .get_mut(&agent)
            .ok_or_else(|| AppError::NotFound(format!("供应商不存在：{provider_id}")))?;
        let record = agent_providers
            .providers
            .iter_mut()
            .find(|p| p.id == provider_id)
            .ok_or_else(|| AppError::NotFound(format!("供应商不存在：{provider_id}")))?;
        let created_at = record.created_at.clone();
        *record = record_from_payload(provider_id.clone(), &payload, created_at);
        is_current = agent_providers.current.as_deref() == Some(provider_id.as_str());
    }

    let mut secrets_dirty = false;
    if let Some(key) = opt_trim(&payload.api_key) {
        secrets.api_keys.insert(provider_id.clone(), key);
        secrets_dirty = true;
    }

    save_store(&store).await?;
    if secrets_dirty {
        save_secrets(&secrets).await?;
    }

    // Keep the live config in sync when editing the active provider.
    if is_current && supports_apply(&agent) {
        if let Some(record) = find_record(&store, &agent, &provider_id) {
            let key = secrets.api_keys.get(&provider_id).map(String::as_str);
            let files = render_provider_config(&agent, record, key)?;
            write_rendered(&agent, &files, &record.config_overrides)?;
        }
    }

    Ok(build_view(&agent, &store, &secrets))
}

#[tauri::command]
pub async fn delete_agent_provider(
    agent_type: String,
    provider_id: String,
) -> Result<AgentProvidersView, AppError> {
    let agent = normalize_agent(&agent_type)?;
    let mut store = load_store().await?;
    let mut secrets = load_secrets().await?;

    let agent_providers = store
        .agents
        .get_mut(&agent)
        .ok_or_else(|| AppError::NotFound(format!("供应商不存在：{provider_id}")))?;
    let before = agent_providers.providers.len();
    agent_providers.providers.retain(|p| p.id != provider_id);
    if agent_providers.providers.len() == before {
        return Err(AppError::NotFound(format!("供应商不存在：{provider_id}")));
    }
    if agent_providers.current.as_deref() == Some(provider_id.as_str()) {
        agent_providers.current = None;
    }

    let secrets_dirty = secrets.api_keys.remove(&provider_id).is_some();
    save_store(&store).await?;
    if secrets_dirty {
        save_secrets(&secrets).await?;
    }
    Ok(build_view(&agent, &store, &secrets))
}

#[tauri::command]
pub async fn apply_agent_provider(
    agent_type: String,
    provider_id: String,
) -> Result<AgentProvidersView, AppError> {
    let agent = normalize_agent(&agent_type)?;
    if !supports_apply(&agent) {
        return Err(AppError::BadRequest(
            "该 Agent 暂不支持从 VibeX 切换供应商配置。".to_string(),
        ));
    }

    let mut store = load_store().await?;
    let secrets = load_secrets().await?;

    let record = find_record(&store, &agent, &provider_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("供应商不存在：{provider_id}")))?;
    let key = secrets.api_keys.get(&provider_id).map(String::as_str);
    let files = render_provider_config(&agent, &record, key)?;
    write_rendered(&agent, &files, &record.config_overrides)?;

    if let Some(agent_providers) = store.agents.get_mut(&agent) {
        agent_providers.current = Some(provider_id);
    }
    save_store(&store).await?;
    Ok(build_view(&agent, &store, &secrets))
}

/// Render (without writing) the config files a payload would produce, for the
/// live preview. Validation is intentionally lenient so partial form state
/// still previews.
#[tauri::command]
pub async fn preview_agent_provider(
    agent_type: String,
    payload: ProviderPayload,
    provider_id: Option<String>,
) -> Result<Vec<RenderedFile>, AppError> {
    let agent = normalize_agent(&agent_type)?;
    if !supports_apply(&agent) {
        return Ok(Vec::new());
    }

    let secrets = load_secrets().await?;
    let id = provider_id.unwrap_or_default();
    let record = record_from_payload(
        if id.is_empty() { "preview".to_string() } else { id.clone() },
        &payload,
        Utc::now().to_rfc3339(),
    );
    let key = match opt_trim(&payload.api_key) {
        Some(key) => Some(key),
        None if !id.is_empty() => secrets.api_keys.get(&id).cloned(),
        None => None,
    };

    render_provider_config(&agent, &record, key.as_deref())
}

#[tauri::command]
pub async fn clear_agent_provider_key(
    agent_type: String,
    provider_id: String,
) -> Result<AgentProvidersView, AppError> {
    let agent = normalize_agent(&agent_type)?;
    let store = load_store().await?;
    let mut secrets = load_secrets().await?;
    if secrets.api_keys.remove(&provider_id).is_some() {
        save_secrets(&secrets).await?;
    }
    Ok(build_view(&agent, &store, &secrets))
}

#[tauri::command]
pub async fn fetch_agent_provider_models(
    agent_type: String,
    provider_id: String,
) -> Result<ProviderModelsResult, AppError> {
    let agent = normalize_agent(&agent_type)?;
    let store = load_store().await?;
    let secrets = load_secrets().await?;

    let record = find_record(&store, &agent, &provider_id)
        .ok_or_else(|| AppError::NotFound(format!("供应商不存在：{provider_id}")))?;

    let mut request = reqwest::Client::new().get(models_url(&record.api_url));
    if let Some(api_key) = secrets.api_keys.get(&provider_id)
        && !api_key.trim().is_empty()
    {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("获取模型列表失败：{e}")))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(AppError::BadRequest(format!("供应商返回 {status}：{detail}")));
    }

    let parsed: OpenAiModelsResponse = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("解析模型列表失败：{e}")))?;
    let mut models = parsed
        .data
        .into_iter()
        .map(|model| model.id)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();

    Ok(ProviderModelsResult {
        provider_id,
        models,
        fetched_at: Utc::now().to_rfc3339(),
    })
}
