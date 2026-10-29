use std::{collections::HashMap, path::Path};

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use api_types::AgentId;
use serde_json::Value;

use super::common::*;
use crate::host::native::model_provider_import::ImportDraft;

pub(super) async fn native_kimi_draft(kimi_home: &Path) -> Result<Option<ImportDraft>, String> {
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

pub(super) async fn native_kimi_provider_drafts(
    kimi_home: &Path,
) -> Result<Vec<ImportDraft>, String> {
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

pub(super) async fn apply_kimi(
    kimi_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
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

/// Whether applying a provider gives this agent a synthetic local gate, i.e.
/// whether an official account action has to strip one first. Keep in step with
/// the gate-writing arms of [`apply_provider`].
pub fn has_synthetic_gate(agent_id: &AgentId) -> bool {
    agent_id.as_str() == "kimi_code"
}

/// The mutations that put Kimi back on the vendor's own endpoint for the
/// duration of an official login: the synthetic provider, the model that points
/// at it and the local gate credential all have to go, or the CLI signs in
/// against VibeX. Returned rather than applied so the caller can restore them
/// when the login terminal never starts.
pub async fn prepare_kimi_vibex_configuration_cleanup(
    home: &Path,
    environment: &HashMap<String, String>,
) -> Result<Vec<NativeFileMutation>, crate::host::native::NativeError> {
    let kimi_home = resolve_native_home(home, environment, "KIMI_CODE_HOME", ".kimi-code");
    let filesystem = TokioNativeFileSystem;
    let mut mutations = Vec::with_capacity(2);

    let config_path = kimi_home.join("config.toml");
    let config_original = filesystem.read(&config_path).await?;
    if let Some(source) = config_original.as_deref() {
        let text = std::str::from_utf8(source)
            .map_err(|error| format!("{} 不是 UTF-8：{error}", config_path.display()))?;
        let mut document: toml::Value = toml::from_str(text)
            .map_err(|error| format!("{} 无效：{error}", config_path.display()))?;
        let root = document
            .as_table_mut()
            .ok_or_else(|| format!("{} 顶层必须是表", config_path.display()))?;
        // A round trip through `toml::Value` drops comments and reflows the
        // file, so a config that never mentioned the gate is left byte-exact.
        let mut changed = root.get("default_model").and_then(toml::Value::as_str) == Some("vibex");
        if changed {
            root.remove("default_model");
        }
        if let Some(providers) = root
            .get_mut("providers")
            .and_then(toml::Value::as_table_mut)
        {
            changed |= providers.remove("vibex").is_some();
        }
        if let Some(models) = root.get_mut("models").and_then(toml::Value::as_table_mut) {
            changed |= models.remove("vibex").is_some();
        }
        if changed {
            let serialized = toml::to_string_pretty(&document)
                .map_err(|error| format!("序列化 {} 失败：{error}", config_path.display()))?;
            mutations.push(NativeFileMutation {
                path: config_path,
                expected: config_original,
                replacement: Some(format!("{serialized}\n").into_bytes()),
                sensitive: false,
            });
        }
    }

    let credential_path = kimi_home.join("credentials/kimi-code.json");
    let credential_original = filesystem.read(&credential_path).await?;
    if let Some(source) = credential_original.as_deref() {
        let value: Value = serde_json::from_slice(source)
            .map_err(|error| format!("{} 无效：{error}", credential_path.display()))?;
        if kimi_credential_is_synthetic(&value) {
            mutations.push(NativeFileMutation {
                path: credential_path,
                expected: credential_original,
                replacement: None,
                sensitive: true,
            });
        }
    }
    Ok(mutations)
}

/// Whether a Kimi credential document is the local gate this app wrote rather
/// than a token the vendor CLI obtained from a real login.
pub fn kimi_credential_is_synthetic(value: &Value) -> bool {
    value.get("_vibex_synthetic").and_then(Value::as_bool) == Some(true)
        || value.get("access_token").and_then(Value::as_str) == Some("vibex-local-gate")
}

pub(super) async fn seed_kimi_gate_credential(
    path: &Path,
) -> Result<(), crate::host::native::NativeError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("创建 Kimi credentials 失败：{error}"))?;
    }
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(path).await?;
    if let Some(bytes) = original.as_deref().filter(|bytes| !bytes.is_empty())
        && let Ok(existing) = serde_json::from_slice::<Value>(bytes)
        && !kimi_credential_is_synthetic(&existing)
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
