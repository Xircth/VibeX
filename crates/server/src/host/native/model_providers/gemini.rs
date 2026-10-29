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
    if let Some(value) = std::env::var_os("GEMINI_HOME").filter(|value| !value.is_empty()) {
        return expand_agent_home_path(home, &value.to_string_lossy());
    }
    if let Some(value) = environment
        .get("GEMINI_CLI_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return expand_agent_home_path(home, value).join(".gemini");
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
    let path = if agent_id.as_str() == "gemini" {
        gemini_home.join("settings.json")
    } else {
        antigravity_settings_path(gemini_home)
    };
    let document = read_json_object_or_empty(&path).await?;
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
