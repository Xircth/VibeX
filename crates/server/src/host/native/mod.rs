use std::path::{Path, PathBuf};

use agents::{BoundaryError, NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};
use serde_json::Value;

#[derive(Debug)]
pub struct NativeError {
    pub message: String,
}

impl NativeError {
    pub fn contains(&self, needle: &str) -> bool {
        self.message.contains(needle)
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<BoundaryError> for NativeError {
    fn from(error: BoundaryError) -> Self {
        Self {
            message: error.to_string(),
        }
    }
}

impl From<String> for NativeError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

impl From<&str> for NativeError {
    fn from(message: &str) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}

impl From<NativeError> for String {
    fn from(error: NativeError) -> Self {
        error.message
    }
}

pub mod codex_device_auth;
pub mod dsh_configuration;
pub mod grok_plugins;
pub mod model_catalogs;
pub mod model_provider_import;
pub mod model_providers;
pub mod opencode_catalog;
pub mod opencode_plugins;
pub mod opencode_providers;
pub mod pi_configuration;
pub mod pi_plugins;

pub fn agent_process_command(program: impl AsRef<Path>) -> tokio::process::Command {
    utils::process::new_hidden_tokio_command(program, std::iter::empty::<&str>())
}

pub async fn write_bytes_document(
    path: &Path,
    bytes: &[u8],
    sensitive: bool,
) -> Result<(), NativeError> {
    TokioNativeFileSystem
        .write_atomic(path, bytes, sensitive)
        .await
        .map_err(NativeError::from)
}

pub async fn write_json_document(
    path: &Path,
    value: &Value,
    sensitive: bool,
) -> Result<(), NativeError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    write_bytes_document(path, &bytes, sensitive).await
}

pub async fn apply_native_file_mutations(
    mutations: &[NativeFileMutation],
) -> Result<(), NativeError> {
    TokioNativeFileSystem
        .apply_many_atomic(mutations)
        .await
        .map_err(NativeError::from)
}

pub async fn read_json_object_or_empty(path: &Path) -> Result<Value, NativeError> {
    read_json_object_state(path).await.map(|(value, _)| value)
}

pub async fn read_json_object_state(path: &Path) -> Result<(Value, Option<Vec<u8>>), NativeError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string().into()),
    };
    let Some(source) = bytes.as_deref() else {
        return Ok((serde_json::json!({}), None));
    };
    let value: Value = serde_json::from_slice(source).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err(format!("{} 顶层必须是 JSON 对象", path.display()).into());
    }
    Ok((value, bytes))
}

pub fn json_document_mutation(
    path: &Path,
    expected: Option<Vec<u8>>,
    value: &Value,
    sensitive: bool,
) -> Result<NativeFileMutation, NativeError> {
    Ok(NativeFileMutation {
        path: path.to_path_buf(),
        expected,
        replacement: Some(serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?),
        sensitive,
    })
}

pub fn expand_agent_home_path(home: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    if let Ok(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    if path.is_relative() {
        return home.join(path);
    }
    path
}

pub fn provider_store_path() -> PathBuf {
    let dest = utils::assets::host_data_dir().join("agent-model-providers.json");
    utils::assets::adopt_tauri_app_data_file("agent-model-providers.json", &dest);
    dest
}

pub fn catalog_cache_dir() -> PathBuf {
    let dest = utils::assets::host_data_dir().join("agent-catalogs");
    utils::assets::adopt_tauri_app_data_dir_files("agent-catalogs", &dest);
    dest
}

pub fn resolve_agent_home(
    home: &Path,
    env: &std::collections::HashMap<String, String>,
    override_env: &str,
    relative: &str,
) -> PathBuf {
    env.get(override_env)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os(override_env)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(relative))
}
