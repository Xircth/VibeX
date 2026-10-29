use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use serde_json::Value;

use super::common::*;
use crate::host::native::{model_provider_import::ImportDraft, read_json_object_or_empty};

pub(super) async fn native_claude_draft(claude_home: &Path) -> Result<Option<ImportDraft>, String> {
    let document = read_json_object_or_empty(&claude_home.join("settings.json")).await?;
    let empty_env = Value::Object(Default::default());
    let env = document.get("env").unwrap_or(&empty_env);
    let api_url = json_text(env, &["ANTHROPIC_BASE_URL"]);
    let api_key = json_text(env, &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
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
        let value = json_text(env, &[key]);
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

pub(super) const CLAUDE_ENV_KEYS: &[&str] = &[
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

pub(super) async fn apply_claude(
    claude_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
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
