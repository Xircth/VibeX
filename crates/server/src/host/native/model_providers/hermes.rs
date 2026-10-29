use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};

use super::common::*;
use crate::host::native::model_provider_import::ImportDraft;

pub(super) async fn native_hermes_draft(hermes_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let path = hermes_home.join("config.yaml");
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 {} 失败：{error}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let document: serde_yaml::Value =
        serde_yaml::from_str(&text).map_err(|error| format!("{} 无效：{error}", path.display()))?;
    let Some(model) = document.get("model") else {
        return Ok(Vec::new());
    };
    let api_url = model
        .get("base_url")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if api_url.is_empty() {
        return Ok(Vec::new());
    }
    let api_key = model
        .get("api_key")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let model_id = model
        .get("default")
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(vec![ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key,
        model: model_id,
        skip_reason: None,
    }])
}

pub(super) async fn apply_hermes(
    hermes_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = hermes_home.join("config.yaml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut document: serde_yaml::Value = match original.as_deref() {
        Some(bytes) if !bytes.is_empty() => serde_yaml::from_slice(bytes)
            .map_err(|error| format!("{} 无效：{error}", path.display()))?,
        _ => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };
    let root = document.as_mapping_mut().ok_or_else(|| {
        crate::host::native::NativeError::from("Hermes config.yaml 顶层必须是对象")
    })?;
    let model_key = serde_yaml::Value::String("model".to_string());
    if !root
        .get(&model_key)
        .is_some_and(serde_yaml::Value::is_mapping)
    {
        root.insert(
            model_key.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    let model = root
        .get_mut(&model_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| crate::host::native::NativeError::from("Hermes model 必须是对象"))?;
    model.insert(
        serde_yaml::Value::String("provider".to_string()),
        serde_yaml::Value::String("custom".to_string()),
    );
    model.insert(
        serde_yaml::Value::String("default".to_string()),
        serde_yaml::Value::String(model_default(&provider.model)),
    );
    model.insert(
        serde_yaml::Value::String("base_url".to_string()),
        serde_yaml::Value::String(provider.api_url.clone()),
    );
    model.insert(
        serde_yaml::Value::String("api_key".to_string()),
        serde_yaml::Value::String(provider.api_key.clone()),
    );
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(
            serde_yaml::to_string(&document)
                .map_err(|error| format!("序列化 Hermes 配置失败：{error}"))?
                .into_bytes(),
        ),
        sensitive: true,
    }])
    .await
}
