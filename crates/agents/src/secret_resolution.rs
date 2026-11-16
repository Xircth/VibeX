//! Multi-account `ProviderInstanceConfig` auth models and dynamic `SecretResolver`
//! (`op://` 1Password CLI, OS keychain / Windows DPAPI, environment variables, inline).
//!
//! Supports lossless JSON round-tripping with both `frontend/src/lib/providerInstancesApi.ts`
//! (internally tagged camelCase) and externally tagged snake_case Rust payloads.

use std::{
    collections::HashMap,
    fmt::Write as _,
    io::Write as _,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use api_types::AgentKind;
use async_trait::async_trait;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use workspace_utils::process::new_hidden_tokio_command;

const OP_CLI_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("Invalid 1Password secret reference `{0}`: must follow `op://<vault>/<item>/<field>`")]
    InvalidOnePasswordRef(String),

    #[error("Invalid environment variable name `{0}`")]
    InvalidEnvVarName(String),

    #[error("Environment variable `{0}` is not set")]
    EnvVarNotSet(String),

    #[error("1Password CLI (`op read`) failed: {0}")]
    OnePasswordCliFailed(String),

    #[error("System keychain lookup failed for `{key_id}`: {reason}")]
    KeychainReadFailed { key_id: String, reason: String },

    #[error("System keychain write failed for `{key_id}`: {reason}")]
    KeychainWriteFailed { key_id: String, reason: String },

    #[error("Provider auth mode has no configured secret reference")]
    MissingSecretReference,
}

pub type SecretResolutionError = SecretError;

/// Ensures a private per-instance directory exists (`0o700` on Unix) so
/// provider auth/config artifacts are restricted to the current OS user.
pub fn ensure_private_instance_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `contents` to `dir.join(filename)` inside a private directory
/// (`0o700` directory and `0o600` file permissions on Unix).
pub fn write_private_credential_file(
    dir: &Path,
    filename: &str,
    contents: &[u8],
) -> std::io::Result<PathBuf> {
    let candidate = Path::new(filename);
    let mut components = candidate.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "credential filename must be a single normal path component",
            ));
        }
    }

    ensure_private_instance_dir(dir)?;
    let path = dir.join(candidate);

    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents)?;
    file.sync_data()?;
    Ok(path)
}

/// Secret reference supporting OS keychain, env vars, 1Password `op://`, and inline values.
///
/// Serializes canonically to the internally-tagged camelCase wire format consumed by
/// `frontend/src/lib/providerInstancesApi.ts`, while deserializing both internally-tagged
/// (camelCase or snake_case) and externally-tagged representations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SecretRef {
    SystemKeychain {
        #[serde(rename = "keyId")]
        key_id: String,
    },
    EnvVar {
        name: String,
    },
    OnePassword {
        #[serde(rename = "opRef")]
        op_ref: String,
    },
    Inline {
        value: String,
    },
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let Some(obj) = raw.as_object() else {
            return Err(serde::de::Error::custom("SecretRef must be a JSON object"));
        };

        if let Some(kind_val) = obj.get("kind").and_then(Value::as_str) {
            let normalized = normalize_tag(kind_val);
            return match normalized.as_str() {
                "system_keychain" | "systemkeychain" => {
                    let key_id = read_required_field(obj, &["keyId", "key_id"])
                        .map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::SystemKeychain { key_id })
                }
                "env_var" | "envvar" => {
                    let name =
                        read_required_field(obj, &["name"]).map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::EnvVar { name })
                }
                "one_password" | "onepassword" => {
                    let op_ref = read_required_field(obj, &["opRef", "op_ref"])
                        .map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::OnePassword { op_ref })
                }
                "inline" => {
                    let value =
                        read_required_field(obj, &["value"]).map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::Inline { value })
                }
                other => Err(serde::de::Error::custom(format!(
                    "unknown SecretRef kind `{other}`"
                ))),
            };
        }

        // Externally tagged fallback (`{"OnePassword": {"op_ref": "op://..."}}`).
        if let Some((variant_key, inner)) = obj.iter().next()
            && obj.len() == 1
            && let Some(inner_obj) = inner.as_object()
        {
            return match normalize_tag(variant_key).as_str() {
                "system_keychain" | "systemkeychain" => {
                    let key_id = read_required_field(inner_obj, &["keyId", "key_id"])
                        .map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::SystemKeychain { key_id })
                }
                "env_var" | "envvar" => {
                    let name = read_required_field(inner_obj, &["name"])
                        .map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::EnvVar { name })
                }
                "one_password" | "onepassword" => {
                    let op_ref = read_required_field(inner_obj, &["opRef", "op_ref"])
                        .map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::OnePassword { op_ref })
                }
                "inline" => {
                    let value = read_required_field(inner_obj, &["value"])
                        .map_err(serde::de::Error::custom)?;
                    Ok(SecretRef::Inline { value })
                }
                other => Err(serde::de::Error::custom(format!(
                    "unknown externally-tagged SecretRef variant `{other}`"
                ))),
            };
        }

        Err(serde::de::Error::custom(
            "invalid SecretRef JSON representation",
        ))
    }
}

/// Authentication mode for a `ProviderInstanceConfig`, round-trip compatible with
/// `frontend/src/lib/providerInstancesApi.ts` (`mode: "OfficialOAuth" | "ApiKey" | "SecretManager"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "mode")]
pub enum ProviderAuthMode {
    OfficialOAuth {
        #[serde(
            rename = "oauthTokenRef",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        oauth_token_ref: Option<SecretRef>,
        #[serde(
            rename = "accountEmail",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        account_email: Option<String>,
    },
    ApiKey {
        #[serde(rename = "keyRef", default, skip_serializing_if = "Option::is_none")]
        key_ref: Option<SecretRef>,
    },
    SecretManager {
        #[serde(rename = "opReference")]
        op_reference: String,
    },
}

impl<'de> Deserialize<'de> for ProviderAuthMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let Some(obj) = raw.as_object() else {
            return Err(serde::de::Error::custom(
                "ProviderAuthMode must be a JSON object",
            ));
        };

        if let Some(mode_str) = obj.get("mode").and_then(Value::as_str) {
            return parse_auth_mode_fields(mode_str, obj).map_err(serde::de::Error::custom);
        }

        if let Some((variant_key, inner)) = obj.iter().next()
            && obj.len() == 1
            && let Some(inner_obj) = inner.as_object()
        {
            return parse_auth_mode_fields(variant_key, inner_obj)
                .map_err(serde::de::Error::custom);
        }

        Err(serde::de::Error::custom(
            "invalid ProviderAuthMode JSON representation",
        ))
    }
}

fn parse_auth_mode_fields(
    tag: &str,
    obj: &serde_json::Map<String, Value>,
) -> Result<ProviderAuthMode, String> {
    match normalize_tag(tag).as_str() {
        "official_oauth" | "officialoauth" | "oauth" => {
            let oauth_token_ref = obj
                .get("oauthTokenRef")
                .or_else(|| obj.get("oauth_token_ref"))
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value::<SecretRef>)
                .transpose()
                .map_err(|e| e.to_string())?;
            let account_email = obj
                .get("accountEmail")
                .or_else(|| obj.get("account_email"))
                .and_then(Value::as_str)
                .map(str::to_string);
            Ok(ProviderAuthMode::OfficialOAuth {
                oauth_token_ref,
                account_email,
            })
        }
        "api_key" | "apikey" => {
            let key_ref = obj
                .get("keyRef")
                .or_else(|| obj.get("key_ref"))
                .filter(|v| !v.is_null())
                .cloned()
                .map(serde_json::from_value::<SecretRef>)
                .transpose()
                .map_err(|e| e.to_string())?;
            Ok(ProviderAuthMode::ApiKey { key_ref })
        }
        "secret_manager" | "secretmanager" | "one_password" | "onepassword" => {
            let op_reference = read_required_field(obj, &["opReference", "op_reference"])?;
            Ok(ProviderAuthMode::SecretManager { op_reference })
        }
        other => Err(format!("unknown ProviderAuthMode `{other}`")),
    }
}

/// Multi-account provider identity bound to a base coding agent (`ClaudeCode`, `Codex`, etc.).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstanceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    #[serde(alias = "instance_id")]
    pub instance_id: String,
    #[serde(alias = "agent_id")]
    pub agent_id: AgentKind,
    #[serde(alias = "auth_mode")]
    pub auth_mode: ProviderAuthMode,
    #[serde(alias = "display_name")]
    pub display_name: String,
    #[serde(default, alias = "is_default")]
    pub is_default: bool,
}

/// Strict validator ensuring `op_ref` begins with `op://`, contains no control
/// characters, and cannot inject CLI flags (such as `-f` or `--config`) into `op read`.
pub fn validate_op_reference(op_ref: &str) -> Result<&str, SecretError> {
    if op_ref.is_empty()
        || op_ref.starts_with('-')
        || op_ref.chars().any(|ch| ch.is_control())
        || !op_ref.starts_with("op://")
    {
        return Err(SecretError::InvalidOnePasswordRef(op_ref.to_string()));
    }

    let rest = &op_ref["op://".len()..];
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.len() < 3 {
        return Err(SecretError::InvalidOnePasswordRef(op_ref.to_string()));
    }

    for seg in segments {
        let trimmed = seg.trim();
        if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.starts_with('-') {
            return Err(SecretError::InvalidOnePasswordRef(op_ref.to_string()));
        }
    }

    Ok(op_ref)
}

/// Produces a redacted preview safe for UI logs and diagnostics (e.g. `"sk-ant-...****"`).
pub fn mask_secret_preview(secret: &str) -> String {
    let trimmed = secret.trim();
    let char_count = trimmed.chars().count();
    if char_count == 0 {
        return String::new();
    }
    if char_count <= 8 {
        return "••••••••".to_string();
    }
    let prefix: String = trimmed.chars().take(7).collect();
    format!("{prefix}...****")
}

/// Injectable backend trait for resolving OS keychain, environment, and 1Password secrets.
#[async_trait]
pub trait SecretBackend: Send + Sync + 'static {
    async fn read_keychain(&self, key_id: &str) -> Result<String, SecretError>;
    async fn write_keychain(&self, key_id: &str, _secret: &str) -> Result<(), SecretError> {
        Err(SecretError::KeychainWriteFailed {
            key_id: key_id.to_string(),
            reason: "keychain write unsupported by backend".to_string(),
        })
    }
    fn read_env(&self, name: &str) -> Result<String, SecretError>;
    async fn read_one_password(&self, op_ref: &str) -> Result<String, SecretError>;
}

/// Default production secret backend using OS credential utilities + hidden `op` CLI.
#[derive(Debug, Default, Clone)]
pub struct OsSecretBackend {
    keychain_dir_override: Option<PathBuf>,
}

impl OsSecretBackend {
    pub fn new() -> Self {
        Self {
            keychain_dir_override: None,
        }
    }

    pub fn with_keychain_dir(dir: PathBuf) -> Self {
        Self {
            keychain_dir_override: Some(dir),
        }
    }

    fn windows_dpapi_file(&self, key_id: &str) -> PathBuf {
        let base = self
            .keychain_dir_override
            .clone()
            .or_else(|| {
                std::env::var_os("DIMO_KEYCHAIN_DIR")
                    .filter(|val| !val.is_empty())
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| workspace_utils::assets::asset_dir().join("secrets"));
        let digest = Sha256::digest(key_id.as_bytes());
        let mut hex = String::with_capacity(64);
        for byte in &digest[..] {
            let _ = write!(&mut hex, "{byte:02x}");
        }
        base.join(format!("{hex}.dpapi"))
    }
}

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, SecretResolutionError> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
        },
    };

    let cb_data =
        u32::try_from(plaintext.len()).map_err(|_| SecretError::KeychainWriteFailed {
            key_id: String::new(),
            reason: "secret payload exceeds u32::MAX bytes".to_string(),
        })?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: cb_data,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: `in_blob` points to `plaintext` (or a valid non-null dangling pointer when
    // `cbData == 0`) for the duration of the FFI call. `out_blob.pbData` is allocated by
    // `CryptProtectData` via `LocalAlloc` and always freed with `LocalFree`.
    unsafe {
        let ok = CryptProtectData(
            &raw const in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut out_blob,
        );
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if !out_blob.pbData.is_null() {
                let _ = LocalFree(out_blob.pbData.cast());
            }
            return Err(SecretError::KeychainWriteFailed {
                key_id: String::new(),
                reason: format!("CryptProtectData failed: {err}"),
            });
        }

        let protected = if out_blob.cbData > 0 && !out_blob.pbData.is_null() {
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
        } else {
            Vec::new()
        };
        if !out_blob.pbData.is_null() {
            let _ = LocalFree(out_blob.pbData.cast());
        }
        Ok(protected)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, SecretResolutionError> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let cb_data =
        u32::try_from(ciphertext.len()).map_err(|_| SecretError::KeychainReadFailed {
            key_id: String::new(),
            reason: "DPAPI ciphertext exceeds u32::MAX bytes".to_string(),
        })?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: cb_data,
        pbData: ciphertext.as_ptr().cast_mut(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: `in_blob` points to `ciphertext` (or a valid non-null dangling pointer when
    // `cbData == 0`) for the duration of the FFI call. `out_blob.pbData` is allocated by
    // `CryptUnprotectData` via `LocalAlloc` and always freed with `LocalFree`.
    unsafe {
        let ok = CryptUnprotectData(
            &raw const in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut out_blob,
        );
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if !out_blob.pbData.is_null() {
                let _ = LocalFree(out_blob.pbData.cast());
            }
            return Err(SecretError::KeychainReadFailed {
                key_id: String::new(),
                reason: format!("CryptUnprotectData failed: {err}"),
            });
        }

        let plaintext = if out_blob.cbData > 0 && !out_blob.pbData.is_null() {
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
        } else {
            Vec::new()
        };
        if !out_blob.pbData.is_null() {
            let _ = LocalFree(out_blob.pbData.cast());
        }
        Ok(plaintext)
    }
}

#[async_trait]
impl SecretBackend for OsSecretBackend {
    async fn read_keychain(&self, key_id: &str) -> Result<String, SecretError> {
        let trimmed_id = key_id.trim();
        if trimmed_id.is_empty()
            || trimmed_id.starts_with('-')
            || trimmed_id.chars().any(char::is_control)
        {
            return Err(SecretError::KeychainReadFailed {
                key_id: key_id.to_string(),
                reason: "invalid key_id".to_string(),
            });
        }

        #[cfg(target_os = "macos")]
        {
            let mut cmd = new_hidden_tokio_command(
                "security",
                [
                    "find-generic-password",
                    "-s",
                    "dimo",
                    "-a",
                    trimmed_id,
                    "-w",
                ],
            );
            let out = cmd
                .output()
                .await
                .map_err(|err| SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                })?;
            if !out.status.success() {
                return Err(SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                });
            }
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }

        #[cfg(target_os = "linux")]
        {
            let mut cmd = new_hidden_tokio_command(
                "secret-tool",
                ["lookup", "service", "dimo", "account", trimmed_id],
            );
            let out = cmd
                .output()
                .await
                .map_err(|err| SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                })?;
            if !out.status.success() {
                return Err(SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                });
            }
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }

        #[cfg(windows)]
        {
            let dpapi_path = self.windows_dpapi_file(trimmed_id);
            if !dpapi_path.is_file() {
                return Err(SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: "credential entry not found in Windows DPAPI store".to_string(),
                });
            }
            let ciphertext =
                std::fs::read(&dpapi_path).map_err(|err| SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                })?;
            let plaintext = dpapi_unprotect(&ciphertext).map_err(|err| match err {
                SecretError::KeychainReadFailed { reason, .. } => SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason,
                },
                other => other,
            })?;
            let decoded =
                String::from_utf8(plaintext).map_err(|err| SecretError::KeychainReadFailed {
                    key_id: trimmed_id.to_string(),
                    reason: format!("decrypted DPAPI payload is not valid UTF-8: {err}"),
                })?;
            return Ok(decoded.trim().to_string());
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        {
            let _ = self.windows_dpapi_file(trimmed_id);
            Err(SecretError::KeychainReadFailed {
                key_id: trimmed_id.to_string(),
                reason: "system keychain unsupported on this platform".to_string(),
            })
        }
    }

    async fn write_keychain(&self, key_id: &str, secret: &str) -> Result<(), SecretError> {
        let trimmed_id = key_id.trim();
        let trimmed_secret = secret.trim();
        if trimmed_id.is_empty()
            || trimmed_id.starts_with('-')
            || trimmed_id.chars().any(char::is_control)
            || trimmed_secret.is_empty()
        {
            return Err(SecretError::KeychainWriteFailed {
                key_id: key_id.to_string(),
                reason: "invalid key_id or empty secret".to_string(),
            });
        }

        #[cfg(target_os = "macos")]
        {
            let mut cmd = new_hidden_tokio_command(
                "security",
                [
                    "add-generic-password",
                    "-U",
                    "-s",
                    "dimo",
                    "-a",
                    trimmed_id,
                    "-w",
                    trimmed_secret,
                ],
            );
            let out = cmd
                .output()
                .await
                .map_err(|err| SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                })?;
            if !out.status.success() {
                return Err(SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                });
            }
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        {
            use tokio::io::AsyncWriteExt;
            let mut cmd = new_hidden_tokio_command(
                "secret-tool",
                [
                    "store",
                    "--label=Dimo Provider Secret",
                    "service",
                    "dimo",
                    "account",
                    trimmed_id,
                ],
            );
            cmd.stdin(std::process::Stdio::piped());
            let mut child = cmd
                .spawn()
                .map_err(|err| SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                })?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(trimmed_secret.as_bytes()).await;
            }
            let out = child
                .wait_with_output()
                .await
                .map_err(|err| SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                })?;
            if !out.status.success() {
                return Err(SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: String::from_utf8_lossy(&out.stderr).trim().to_string(),
                });
            }
            return Ok(());
        }

        #[cfg(windows)]
        {
            let dpapi_path = self.windows_dpapi_file(trimmed_id);
            let parent = dpapi_path
                .parent()
                .ok_or_else(|| SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: "invalid DPAPI credential path".to_string(),
                })?;
            let file_name = dpapi_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: "invalid DPAPI credential filename".to_string(),
                })?;
            let ciphertext = dpapi_protect(trimmed_secret.as_bytes()).map_err(|err| match err {
                SecretError::KeychainWriteFailed { reason, .. } => {
                    SecretError::KeychainWriteFailed {
                        key_id: trimmed_id.to_string(),
                        reason,
                    }
                }
                other => other,
            })?;
            write_private_credential_file(parent, file_name, &ciphertext).map_err(|err| {
                SecretError::KeychainWriteFailed {
                    key_id: trimmed_id.to_string(),
                    reason: err.to_string(),
                }
            })?;
            return Ok(());
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        {
            let _ = self.windows_dpapi_file(trimmed_id);
            Err(SecretError::KeychainWriteFailed {
                key_id: trimmed_id.to_string(),
                reason: "system keychain unsupported on this platform".to_string(),
            })
        }
    }

    fn read_env(&self, name: &str) -> Result<String, SecretError> {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.contains('=') || trimmed.contains('\0') {
            return Err(SecretError::InvalidEnvVarName(name.to_string()));
        }
        std::env::var(trimmed).map_err(|_| SecretError::EnvVarNotSet(trimmed.to_string()))
    }

    async fn read_one_password(&self, op_ref: &str) -> Result<String, SecretError> {
        let validated = validate_op_reference(op_ref)?;
        let binary = if cfg!(windows) { "op.exe" } else { "op" };
        let mut cmd = new_hidden_tokio_command(binary, ["read", validated]);
        cmd.kill_on_drop(true);

        let output = tokio::time::timeout(Duration::from_secs(OP_CLI_TIMEOUT_SECS), cmd.output())
            .await
            .map_err(|_| {
                SecretError::OnePasswordCliFailed(format!(
                    "`op read` timed out after {OP_CLI_TIMEOUT_SECS}s"
                ))
            })?
            .map_err(|err| SecretError::OnePasswordCliFailed(err.to_string()))?;

        if !output.status.success() {
            return Err(SecretError::OnePasswordCliFailed(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

/// Resolves [`SecretRef`] and [`ProviderAuthMode`] into concrete runtime credentials.
#[derive(Clone)]
pub struct SecretResolver {
    backend: Arc<dyn SecretBackend>,
}

impl std::fmt::Debug for SecretResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretResolver").finish()
    }
}

impl Default for SecretResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretResolver {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(OsSecretBackend::new()),
        }
    }

    pub fn with_backend<B: SecretBackend>(backend: B) -> Self {
        Self {
            backend: Arc::new(backend),
        }
    }

    pub async fn store_keychain(
        &self,
        key_id: &str,
        secret: &str,
    ) -> Result<SecretRef, SecretError> {
        self.backend.write_keychain(key_id, secret).await?;
        Ok(SecretRef::SystemKeychain {
            key_id: key_id.trim().to_string(),
        })
    }

    pub async fn resolve(&self, secret_ref: &SecretRef) -> Result<String, SecretError> {
        match secret_ref {
            SecretRef::SystemKeychain { key_id } => self.backend.read_keychain(key_id).await,
            SecretRef::EnvVar { name } => self.backend.read_env(name),
            SecretRef::OnePassword { op_ref } => {
                validate_op_reference(op_ref)?;
                self.backend.read_one_password(op_ref).await
            }
            SecretRef::Inline { value } => Ok(value.clone()),
        }
    }

    /// Resolves environment variables to inject when launching `instance`.
    pub async fn resolve_launch_env(
        &self,
        instance: &ProviderInstanceConfig,
    ) -> Result<HashMap<String, String>, SecretError> {
        let mut env = HashMap::new();
        match &instance.auth_mode {
            ProviderAuthMode::OfficialOAuth {
                oauth_token_ref: Some(token_ref),
                ..
            } => {
                let token = self.resolve(token_ref).await?;
                match instance.agent_id {
                    AgentKind::ClaudeCode => {
                        env.insert("CLAUDE_CODE_OAUTH_TOKEN".to_string(), token);
                    }
                    AgentKind::Codex => {
                        env.insert("CODEX_ACCESS_TOKEN".to_string(), token);
                    }
                    _ => {}
                }
            }
            ProviderAuthMode::OfficialOAuth {
                oauth_token_ref: None,
                ..
            } => {}
            ProviderAuthMode::ApiKey { key_ref } => {
                let secret_ref = key_ref
                    .as_ref()
                    .ok_or(SecretError::MissingSecretReference)?;
                let key = self.resolve(secret_ref).await?;
                insert_agent_api_key(&mut env, instance.agent_id, key);
            }
            ProviderAuthMode::SecretManager { op_reference } => {
                validate_op_reference(op_reference)?;
                let key = self.backend.read_one_password(op_reference).await?;
                insert_agent_api_key(&mut env, instance.agent_id, key);
            }
        }
        Ok(env)
    }
}

fn insert_agent_api_key(env: &mut HashMap<String, String>, agent: AgentKind, key: String) {
    match agent {
        AgentKind::ClaudeCode => {
            env.insert("ANTHROPIC_API_KEY".to_string(), key);
        }
        AgentKind::Codex => {
            env.insert("OPENAI_API_KEY".to_string(), key);
        }
        _ => {
            env.insert("API_KEY".to_string(), key);
        }
    }
}

fn normalize_tag(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|ch| {
            if ch == '-' || ch == ' ' {
                '_'
            } else {
                ch.to_ascii_lowercase()
            }
        })
        .collect()
}

fn read_required_field(
    obj: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Result<String, String> {
    for key in keys {
        if let Some(val) = obj.get(*key).and_then(Value::as_str) {
            return Ok(val.to_string());
        }
    }
    Err(format!(
        "missing required string field (expected one of {keys:?})"
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct MockSecretBackend {
        env_map: HashMap<String, String>,
        keychain_map: HashMap<String, String>,
        op_map: HashMap<String, String>,
    }

    #[async_trait]
    impl SecretBackend for MockSecretBackend {
        async fn read_keychain(&self, key_id: &str) -> Result<String, SecretError> {
            self.keychain_map
                .get(key_id)
                .cloned()
                .ok_or_else(|| SecretError::KeychainReadFailed {
                    key_id: key_id.to_string(),
                    reason: "not found".to_string(),
                })
        }

        fn read_env(&self, name: &str) -> Result<String, SecretError> {
            self.env_map
                .get(name)
                .cloned()
                .ok_or_else(|| SecretError::EnvVarNotSet(name.to_string()))
        }

        async fn read_one_password(&self, op_ref: &str) -> Result<String, SecretError> {
            validate_op_reference(op_ref)?;
            self.op_map
                .get(op_ref)
                .cloned()
                .ok_or_else(|| SecretError::OnePasswordCliFailed("item not found".to_string()))
        }
    }

    #[test]
    fn validates_op_references_and_blocks_cli_flag_injection() {
        assert!(validate_op_reference("op://Personal/Claude/api-key").is_ok());
        assert!(validate_op_reference("op://Work Vault/Anthropic/Section/credential").is_ok());

        for malicious in [
            "",
            "-f",
            "--config=/etc/passwd",
            "op://-flag/item/field",
            "op://VaultOnly/MissingField",
            "op://Vault/../field",
            "op://Vault/Item/field\ninjected",
            "https://1password.com/item",
        ] {
            assert!(
                validate_op_reference(malicious).is_err(),
                "expected `{malicious}` to be rejected"
            );
        }
    }

    #[test]
    fn round_trips_frontend_provider_instances_api_json_and_externally_tagged_rust_json() {
        // Exact JSON shape produced by `frontend/src/lib/providerInstancesApi.ts`.
        let frontend_json = json!({
            "instanceId": "work-claude",
            "agentId": "claude_code",
            "displayName": "Claude (Work)",
            "isDefault": true,
            "authMode": {
                "mode": "ApiKey",
                "keyRef": {
                    "kind": "one_password",
                    "opRef": "op://Work/Anthropic/api_key"
                }
            }
        });

        let parsed: ProviderInstanceConfig =
            serde_json::from_value(frontend_json.clone()).expect("parse frontend JSON");
        assert_eq!(parsed.instance_id, "work-claude");
        assert_eq!(parsed.agent_id, AgentKind::ClaudeCode);
        assert_eq!(
            parsed.auth_mode,
            ProviderAuthMode::ApiKey {
                key_ref: Some(SecretRef::OnePassword {
                    op_ref: "op://Work/Anthropic/api_key".to_string(),
                }),
            }
        );

        let reserialized = serde_json::to_value(&parsed).expect("reserialize");
        assert_eq!(reserialized, frontend_json);

        // Externally tagged snake_case JSON compatibility.
        let legacy_rust_json = json!({
            "instance_id": "personal-codex",
            "agent_id": "Codex",
            "display_name": "Codex (Personal)",
            "is_default": false,
            "auth_mode": {
                "OfficialOAuth": {
                    "oauth_token_ref": {
                        "SystemKeychain": { "key_id": "codex-personal-oauth" }
                    },
                    "account_email": "dev@example.com"
                }
            }
        });
        let parsed_legacy: ProviderInstanceConfig =
            serde_json::from_value(legacy_rust_json).expect("parse legacy externally-tagged JSON");
        assert_eq!(parsed_legacy.agent_id, AgentKind::Codex);
        assert_eq!(
            parsed_legacy.auth_mode,
            ProviderAuthMode::OfficialOAuth {
                oauth_token_ref: Some(SecretRef::SystemKeychain {
                    key_id: "codex-personal-oauth".to_string(),
                }),
                account_email: Some("dev@example.com".to_string()),
            }
        );
    }

    #[tokio::test]
    async fn resolves_all_secret_backends_and_masks_previews_safely() {
        let mut env_map = HashMap::new();
        env_map.insert(
            "TEST_ANTHROPIC_KEY".to_string(),
            "sk-ant-env-1234567890".to_string(),
        );

        let mut keychain_map = HashMap::new();
        keychain_map.insert("kc-1".to_string(), "sk-ant-keychain-987654".to_string());

        let mut op_map = HashMap::new();
        op_map.insert(
            "op://Personal/OpenAI/credential".to_string(),
            "sk-proj-1password-secret".to_string(),
        );

        let resolver = SecretResolver::with_backend(MockSecretBackend {
            env_map,
            keychain_map,
            op_map,
        });

        assert_eq!(
            resolver
                .resolve(&SecretRef::EnvVar {
                    name: "TEST_ANTHROPIC_KEY".to_string()
                })
                .await
                .unwrap(),
            "sk-ant-env-1234567890"
        );
        assert_eq!(
            resolver
                .resolve(&SecretRef::SystemKeychain {
                    key_id: "kc-1".to_string()
                })
                .await
                .unwrap(),
            "sk-ant-keychain-987654"
        );
        assert_eq!(
            resolver
                .resolve(&SecretRef::Inline {
                    value: "inline-dev-token".to_string()
                })
                .await
                .unwrap(),
            "inline-dev-token"
        );

        // Flag injection attempt in SecretRef::OnePassword must fail before touching backend CLI.
        let bad_op = resolver
            .resolve(&SecretRef::OnePassword {
                op_ref: "-f".to_string(),
            })
            .await
            .expect_err("flag injection must fail");
        assert!(matches!(bad_op, SecretError::InvalidOnePasswordRef(_)));

        let instance = ProviderInstanceConfig {
            id: None,
            instance_id: "codex-op".to_string(),
            agent_id: AgentKind::Codex,
            display_name: "Codex 1Password".to_string(),
            is_default: true,
            auth_mode: ProviderAuthMode::SecretManager {
                op_reference: "op://Personal/OpenAI/credential".to_string(),
            },
        };
        let launch_env = resolver.resolve_launch_env(&instance).await.unwrap();
        assert_eq!(
            launch_env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-proj-1password-secret")
        );

        assert_eq!(
            mask_secret_preview("sk-ant-api03-abcdef123456"),
            "sk-ant-...****"
        );
        assert_eq!(mask_secret_preview("short"), "••••••••");
    }

    #[test]
    fn write_private_credential_file_writes_exact_bytes_and_enforces_restrictive_permissions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let instance_dir = temp.path().join("instance-alpha");
        let payload = br#"{"accessToken":"sk-ant-private-token-123"}"#;

        let written = write_private_credential_file(&instance_dir, "credentials.json", payload)
            .expect("write private credential file");
        assert_eq!(written, instance_dir.join("credentials.json"));
        assert_eq!(std::fs::read(&written).expect("read back"), payload);

        let updated = br#"{"accessToken":"sk-ant-rotated-token-456"}"#;
        write_private_credential_file(&instance_dir, "credentials.json", updated)
            .expect("overwrite private credential file");
        assert_eq!(std::fs::read(&written).expect("read updated"), updated);

        for invalid in ["", "../escape.json", "nested/file.json", "."] {
            assert!(
                write_private_credential_file(&instance_dir, invalid, b"x").is_err(),
                "expected invalid credential filename `{invalid}` to be rejected"
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir_mode = std::fs::metadata(&instance_dir)
                .expect("dir metadata")
                .permissions()
                .mode()
                & 0o777;
            let file_mode = std::fs::metadata(&written)
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dpapi_in_process_round_trip_and_corrupted_ciphertext_fail_closed() {
        let empty_cipher = dpapi_protect(&[]).expect("protect empty slice");
        assert!(!empty_cipher.is_empty());
        assert_eq!(
            dpapi_unprotect(&empty_cipher).expect("unprotect empty slice"),
            Vec::<u8>::new()
        );

        let raw_secret = "sk-ant-dpapi-in-process-secret-998877";
        let temp = tempfile::tempdir().expect("tempdir");
        let backend = OsSecretBackend::with_keychain_dir(temp.path().to_path_buf());
        let resolver = SecretResolver::with_backend(backend.clone());

        let secret_ref = resolver
            .store_keychain("claude-work-dpapi", raw_secret)
            .await
            .expect("store_keychain via in-process DPAPI");
        let dpapi_path = backend.windows_dpapi_file("claude-work-dpapi");
        let stored_bytes = std::fs::read(&dpapi_path).expect("read .dpapi file");
        assert!(!stored_bytes.is_empty());
        assert!(
            !String::from_utf8_lossy(&stored_bytes).contains(raw_secret),
            ".dpapi file must never store plaintext secret bytes"
        );

        let resolved = resolver
            .resolve(&secret_ref)
            .await
            .expect("resolve via in-process DPAPI");
        assert_eq!(resolved, raw_secret);

        // Corrupting the `.dpapi` ciphertext must fail closed with `SecretResolutionError`.
        std::fs::write(&dpapi_path, b"corrupted-dpapi-ciphertext-bytes")
            .expect("overwrite with corrupted bytes");
        let err: SecretResolutionError = resolver
            .resolve(&secret_ref)
            .await
            .expect_err("corrupted .dpapi bytes must fail closed");
        assert!(matches!(
            err,
            SecretResolutionError::KeychainReadFailed { ref key_id, .. }
                if key_id == "claude-work-dpapi"
        ));
        assert!(dpapi_unprotect(b"not-valid-dpapi").is_err());
    }
}
