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
        Value::String("vibex".to_string()),
    );
    let providers = object_entry(root, "providers")?;
    let model = model_default(&provider.model);
    providers.insert(
        "vibex".to_string(),
        serde_json::json!({
            "name": provider.name,
            "baseUrl": provider.api_url,
            "apiKey": provider.api_key,
            "model": model,
        }),
    );
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
