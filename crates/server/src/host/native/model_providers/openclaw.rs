use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use serde_json::Value;

use super::common::*;
use crate::host::native::{model_provider_import::ImportDraft, read_json_object_or_empty};

pub(super) async fn native_openclaw_drafts(
    openclaw_home: &Path,
) -> Result<Vec<ImportDraft>, String> {
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

pub(super) async fn apply_openclaw(
    openclaw_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
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
            "models": provider_model_ids(&provider.model)
                .into_iter()
                .map(|id| serde_json::json!({ "id": id, "name": provider.name }))
                .collect::<Vec<_>>()
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
