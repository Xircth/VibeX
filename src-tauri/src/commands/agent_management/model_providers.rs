use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{
    AgentId, AgentModelProviderSaveRequest, AgentModelProviderView, AgentModelProvidersView,
    CodexModelCatalogConfigRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{read_json_object_or_empty, write_bytes_document};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProvider {
    id: String,
    name: String,
    agent_id: AgentId,
    api_url: String,
    api_key: String,
    model: String,
}

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
}

impl ProviderNativeHomes {
    fn resolve(home: &Path, environment: &HashMap<String, String>) -> Self {
        Self {
            claude: resolve_native_home(home, environment, "CLAUDE_CONFIG_DIR", ".claude"),
            codex: resolve_native_home(home, environment, "CODEX_HOME", ".codex"),
            gemini: resolve_gemini_home(home, environment),
        }
    }
}

fn resolve_gemini_home(home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    environment
        .get("GEMINI_CLI_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(|value| super::expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os("GEMINI_CLI_HOME")
                .filter(|value| !value.is_empty())
                .map(|value| super::expand_agent_home_path(home, &value.to_string_lossy()))
        })
        .unwrap_or_else(|| home.to_path_buf())
        .join(".gemini")
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
    validate_agent(&agent_id)?;
    let store = read_store(store_path).await?;
    Ok(project(&store, agent_id))
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
    Ok(project(&store, request.agent_id))
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
            return Ok(project(&store, agent_id));
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
    Ok(project(&store, agent_id))
}

pub(super) async fn delete(
    store_path: &Path,
    agent_id: AgentId,
    provider_id: &str,
) -> Result<AgentModelProvidersView, String> {
    validate_agent(&agent_id)?;
    let mut store = read_store(store_path).await?;
    if store.bindings.values().any(|bound| bound == provider_id) {
        return Err("Model Provider 正在使用中，请先解除绑定".to_string());
    }
    let before = store.providers.len();
    store
        .providers
        .retain(|provider| provider.id != provider_id || provider.agent_id != agent_id);
    if store.providers.len() == before {
        return Err("找不到要删除的 Model Provider".to_string());
    }
    write_store(store_path, &store).await?;
    Ok(project(&store, agent_id))
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
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    AgentModelProvidersView {
        agent_id,
        providers,
        bound_provider_id,
    }
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
    match agent_id.as_str() {
        "claude_code" | "codex" | "gemini" => Ok(()),
        _ => Err("只有 Claude Code、Codex 与 Gemini 支持可复用 Model Provider".to_string()),
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
        "gemini" => {
            capture_json_env(
                &homes.gemini.join("settings.json"),
                GEMINI_ENV_KEYS,
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
        "gemini" => GEMINI_ENV_KEYS,
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
        "gemini" => {
            restore_json_env(
                &homes.gemini.join("settings.json"),
                GEMINI_ENV_KEYS,
                backup,
                true,
            )
            .await
        }
        _ => validate_agent(agent_id),
    }
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
}
