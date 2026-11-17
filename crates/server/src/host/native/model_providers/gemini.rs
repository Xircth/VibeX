use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::{AgentId, AgentKind};
use serde_json::Value;

use super::common::*;
use crate::host::native::{
    expand_agent_home_path, model_provider_import::ImportDraft, read_json_object_or_empty,
};

pub(super) fn resolve_gemini_home(home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    if let Some(value) = environment
        .get("GEMINI_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return expand_agent_home_path(home, value);
    }
    if let Some(value) = environment
        .get("GEMINI_CLI_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return expand_agent_home_path(home, value).join(".gemini");
    }
    if let Some(value) = std::env::var_os("GEMINI_HOME").filter(|value| !value.is_empty()) {
        return expand_agent_home_path(home, &value.to_string_lossy());
    }
    if let Some(value) = std::env::var_os("GEMINI_CLI_HOME").filter(|value| !value.is_empty()) {
        return expand_agent_home_path(home, &value.to_string_lossy()).join(".gemini");
    }
    home.join(".gemini")
}

pub(super) fn is_antigravity(agent_id: &AgentId) -> bool {
    AgentKind::Antigravity.matches_id(agent_id.as_str())
}

pub(super) fn antigravity_settings_path(gemini_home: &Path) -> PathBuf {
    gemini_home.join("antigravity-acp").join("settings.json")
}

pub(super) async fn native_gemini_draft(
    gemini_home: &Path,
    agent_id: &AgentId,
) -> Result<Option<ImportDraft>, String> {
    if agent_id.as_str() == "gemini" {
        let env_map = read_dotenv_map(&gemini_home.join(".env")).await?;
        let document = read_json_object_or_empty(&gemini_home.join("settings.json"))
            .await
            .map_err(|error| error.to_string())?;
        let empty_env = Value::Object(Default::default());
        let json_env = document.get("env").unwrap_or(&empty_env);
        let api_url = env_or_json_text(
            &env_map,
            json_env,
            &["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "API_BASE_URL"],
        );
        let api_key = env_or_json_text(
            &env_map,
            json_env,
            &["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"],
        );
        if api_url.is_empty() && api_key.is_empty() {
            return Ok(None);
        }
        let mut model = env_or_json_text(&env_map, json_env, &["GEMINI_MODEL"]);
        if model.is_empty() {
            model = document
                .pointer("/model/name")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
        }
        return Ok(Some(ImportDraft {
            source_id: "__native_live__".to_string(),
            name: "当前原生配置".to_string(),
            api_url,
            api_key,
            model,
            skip_reason: None,
        }));
    }
    let path = antigravity_settings_path(gemini_home);
    let document = read_json_object_or_empty(&path)
        .await
        .map_err(|error| error.to_string())?;
    let empty_env = Value::Object(Default::default());
    let env = document.get("env").unwrap_or(&empty_env);
    let api_url = json_text(
        env,
        &["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "API_BASE_URL"],
    );
    let api_key = json_text(
        env,
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
        model: json_text(env, &["GEMINI_MODEL"]),
        skip_reason: None,
    }))
}

pub(super) const GEMINI_ENV_KEYS: &[&str] = &[
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

pub(super) const ANTIGRAVITY_AUTH_TYPE_BACKUP_KEY: &str = "auth.type";
pub(super) const GEMINI_ENV_FILE: &str = ".env";
pub(super) const GEMINI_SECURITY_AUTH_TYPE_KEY: &str = "security.auth.selectedType";
pub(super) const GEMINI_MODEL_NAME_KEY: &str = "model.name";

fn env_or_json_text(env_map: &[(String, String)], json_env: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some((_, value)) = env_map.iter().find(|(k, _)| k == key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    json_text(json_env, keys)
}

async fn read_dotenv_map(path: &Path) -> Result<Vec<(String, String)>, String> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display())),
    };
    Ok(parse_dotenv_entries(&text))
}

fn parse_dotenv_entries(text: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let line = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let val = v.trim();
        let unquoted = if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
            || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
        {
            &val[1..val.len() - 1]
        } else {
            val
        };
        entries.push((key.to_string(), unquoted.to_string()));
    }
    entries
}

fn serialize_dotenv(entries: &[(String, String)]) -> String {
    let mut out = String::new();
    for (key, value) in entries {
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    out
}

pub(super) async fn capture_gemini_state(
    gemini_home: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let settings_path = gemini_home.join("settings.json");
    capture_json_env(&settings_path, GEMINI_ENV_KEYS, backup).await?;
    let document = read_json_object_or_empty(&settings_path).await?;
    backup.json_values.insert(
        GEMINI_SECURITY_AUTH_TYPE_KEY.to_string(),
        document.pointer("/security/auth/selectedType").cloned(),
    );
    backup.json_values.insert(
        GEMINI_MODEL_NAME_KEY.to_string(),
        document.pointer("/model/name").cloned(),
    );
    capture_text_file(&gemini_home.join(GEMINI_ENV_FILE), GEMINI_ENV_FILE, backup).await
}

pub(super) async fn restore_gemini_state(
    gemini_home: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
    let settings_path = gemini_home.join("settings.json");
    restore_text_file(
        &gemini_home.join(GEMINI_ENV_FILE),
        GEMINI_ENV_FILE,
        backup,
        true,
    )
    .await?;
    let mut document = read_json_object_or_empty(&settings_path).await?;
    let root = document.as_object_mut().expect("object");
    let has_env_backup = GEMINI_ENV_KEYS
        .iter()
        .any(|key| backup.json_values.get(*key).is_some_and(Option::is_some));
    if has_env_backup || root.get("env").is_some_and(Value::is_object) {
        let env = object_entry(root, "env")?;
        restore_json_values(env, GEMINI_ENV_KEYS, backup);
        if env.is_empty() {
            root.remove("env");
        }
    }
    match backup
        .json_values
        .get(GEMINI_SECURITY_AUTH_TYPE_KEY)
        .cloned()
        .flatten()
    {
        Some(value) => {
            let security = object_entry(root, "security")?;
            let auth = object_entry(security, "auth")?;
            auth.insert("selectedType".to_string(), value);
        }
        None => {
            if let Some(security) = root.get_mut("security").and_then(Value::as_object_mut) {
                if let Some(auth) = security.get_mut("auth").and_then(Value::as_object_mut) {
                    auth.remove("selectedType");
                    if auth.is_empty() {
                        security.remove("auth");
                    }
                }
                if security.is_empty() {
                    root.remove("security");
                }
            }
        }
    }
    match backup
        .json_values
        .get(GEMINI_MODEL_NAME_KEY)
        .cloned()
        .flatten()
    {
        Some(value) => {
            let model = object_entry(root, "model")?;
            model.insert("name".to_string(), value);
        }
        None => {
            if let Some(model) = root.get_mut("model").and_then(Value::as_object_mut) {
                model.remove("name");
                if model.is_empty() {
                    root.remove("model");
                }
            }
        }
    }
    write_json(&settings_path, &document, true).await
}

pub(super) async fn capture_antigravity_auth_type(
    path: &Path,
    backup: &mut ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
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

pub(super) async fn restore_antigravity_auth_type(
    path: &Path,
    backup: &ProviderProjectionBackup,
) -> Result<(), crate::host::native::NativeError> {
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

pub(super) async fn apply_antigravity(
    gemini_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
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

pub(super) async fn apply_gemini(
    gemini_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let filesystem = TokioNativeFileSystem;
    let env_path = gemini_home.join(GEMINI_ENV_FILE);
    let env_original = filesystem.read(&env_path).await?;
    let mut env_entries = env_original
        .as_deref()
        .map(|bytes| parse_dotenv_entries(&String::from_utf8_lossy(bytes)))
        .unwrap_or_default();
    env_entries.retain(|(key, _)| !GEMINI_ENV_KEYS.contains(&key.as_str()));
    if !provider.api_url.trim().is_empty() {
        env_entries.push((
            "GOOGLE_GEMINI_BASE_URL".to_string(),
            provider.api_url.trim().to_string(),
        ));
    }
    if !provider.api_key.trim().is_empty() {
        env_entries.push((
            "GEMINI_API_KEY".to_string(),
            provider.api_key.trim().to_string(),
        ));
    }
    let default_model = model_default(&provider.model).trim().to_string();
    if !default_model.is_empty() {
        env_entries.push(("GEMINI_MODEL".to_string(), default_model.clone()));
    }
    let env_bytes = serialize_dotenv(&env_entries).into_bytes();

    let settings_path = gemini_home.join("settings.json");
    let settings_original = filesystem.read(&settings_path).await?;
    let mut document = parse_json_object_bytes(&settings_path, settings_original.as_deref())?;
    let root = document.as_object_mut().expect("object");
    if let Some(env) = root.get_mut("env").and_then(Value::as_object_mut) {
        for key in GEMINI_ENV_KEYS {
            env.remove(*key);
        }
        if env.is_empty() {
            root.remove("env");
        }
    }
    let security = object_entry(root, "security")?;
    let auth = object_entry(security, "auth")?;
    auth.insert(
        "selectedType".to_string(),
        Value::String("gemini-api-key".to_string()),
    );
    if !default_model.is_empty() {
        let model = object_entry(root, "model")?;
        model.insert("name".to_string(), Value::String(default_model));
    } else if let Some(model) = root.get_mut("model").and_then(Value::as_object_mut) {
        model.remove("name");
        if model.is_empty() {
            root.remove("model");
        }
    }

    apply_projection_mutations(&[
        NativeFileMutation {
            path: env_path,
            expected: env_original,
            replacement: Some(env_bytes),
            sensitive: true,
        },
        NativeFileMutation {
            path: settings_path,
            expected: settings_original,
            replacement: Some(
                serde_json::to_vec_pretty(&document)
                    .map_err(|error| format!("序列化原生配置失败：{error}"))?,
            ),
            sensitive: true,
        },
    ])
    .await
}
