use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use serde_json::Value;

use super::common::*;

pub(super) async fn apply_command_code(
    command_code_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = command_code_home.join("providers.json");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut document = parse_json_object_bytes(&path, original.as_deref())?;
    let root = document.as_object_mut().expect("object");
    root.insert(
        "defaultProvider".to_string(),
        Value::String("dimo".to_string()),
    );
    let providers = object_entry(root, "providers")?;
    let model = model_default(&provider.model);
    let mut entry = serde_json::Map::new();
    entry.insert("name".to_string(), Value::String(provider.name.clone()));
    entry.insert(
        "baseUrl".to_string(),
        Value::String(provider.api_url.clone()),
    );
    if !provider.api_key.trim().is_empty() {
        entry.insert(
            "apiKey".to_string(),
            Value::String(provider.api_key.trim().to_string()),
        );
    }
    entry.insert("model".to_string(), Value::String(model));
    providers.insert("dimo".to_string(), Value::Object(entry));
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
