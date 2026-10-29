use std::path::Path;

use agents::{NativeFileSystem, TokioNativeFileSystem};

use super::common::*;

pub(super) async fn apply_trae(
    trae_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = trae_home.join("traecli.toml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut table = parse_toml_table_bytes(&path, original.as_deref())?;
    table.insert(
        "model_provider".to_string(),
        toml::Value::String("vibex".to_string()),
    );
    let model = model_default(&provider.model);
    if !model.trim().is_empty() {
        table.insert(
            "model".to_string(),
            toml::Value::String(model.trim().to_string()),
        );
    }
    let providers = toml_table_entry(&mut table, "model_providers")?;
    let vibex = toml_table_entry(providers, "vibex")?;
    vibex.insert("name".to_string(), toml::Value::String("vibex".to_string()));
    vibex.insert(
        "base_url".to_string(),
        toml::Value::String(provider.api_url.clone()),
    );
    vibex.insert(
        "api_key".to_string(),
        toml::Value::String(provider.api_key.clone()),
    );
    vibex.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    write_toml_mutation(&path, original, &table, true).await
}
