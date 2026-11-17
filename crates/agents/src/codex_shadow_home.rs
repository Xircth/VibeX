//! T3Code-inspired Codex shadow home preparation and ambient credential scrubbing.
//!
//! Ensures isolated provider instances:
//! - Never inherit ambient shell API keys or tokens (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
//!   unless explicitly configured in the instance launch environment.
//! - Sync non-auth Codex settings (`~/.codex/config.toml`) into an isolated `CODEX_HOME`
//!   without symlinking `config.toml`, SQLite state files, or `cloud-config-bundle-cache.json`,
//!   stripping global `model_provider` / `[model_providers.*]` routing keys so each instance
//!   stays clean and self-contained.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use api_types::AgentId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::secret_resolution::{ensure_private_instance_dir, write_private_credential_file};

pub const AMBIENT_PROVIDER_CREDENTIAL_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
];

pub const LOCAL_INSTANCE_OVERRIDE_ENV_KEYS: &[&str] = &["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

const SHADOW_SYNC_META_FILE: &str = ".dimo-shadow-sync.json";

#[derive(Debug, Serialize, Deserialize)]
struct ShadowSyncMeta {
    source_sha256: String,
    written_sha256: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Strips top-level `model_provider` and `[model_providers.*]` tables from a Codex
/// `config.toml` snapshot so non-auth preferences carry over cleanly without inheriting
/// the local instance's third-party model provider bindings.
pub fn strip_provider_routing_from_codex_config(raw: &str) -> Option<String> {
    let mut table = raw.parse::<toml::Table>().ok()?;
    table.remove("model_provider");
    table.remove("model_providers");
    table.remove("model_catalog_json");
    toml::to_string_pretty(&table).ok()
}

/// Prepares an isolated Codex shadow home directory.
///
/// Copies sanitized non-auth settings from `source_home/config.toml` when the shadow
/// `config.toml` does not yet exist (or was last written verbatim by this sync and has not
/// been customized locally). Never creates symlinks for `config.toml`, SQLite databases,
/// or `cloud-config-bundle-cache.json`.
pub fn prepare_codex_shadow_home(
    source_home: Option<&Path>,
    shadow_home: &Path,
) -> std::io::Result<()> {
    ensure_private_instance_dir(shadow_home)?;

    let resolved_source = source_home
        .map(Path::to_path_buf)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
    let Some(src_dir) = resolved_source else {
        return Ok(());
    };
    let src_config = src_dir.join("config.toml");
    let Ok(src_bytes) = std::fs::read(&src_config) else {
        return Ok(());
    };
    let Ok(src_text) = std::str::from_utf8(&src_bytes) else {
        return Ok(());
    };
    let Some(sanitized) = strip_provider_routing_from_codex_config(src_text) else {
        return Ok(());
    };

    let dst_config = shadow_home.join("config.toml");
    let meta_path = shadow_home.join(SHADOW_SYNC_META_FILE);
    let source_sha256 = sha256_hex(&src_bytes);

    let should_write = if !dst_config.exists() {
        true
    } else if let Ok(meta_bytes) = std::fs::read(&meta_path)
        && let Ok(meta) = serde_json::from_slice::<ShadowSyncMeta>(&meta_bytes)
        && let Ok(existing_bytes) = std::fs::read(&dst_config)
    {
        // Only refresh if the shadow config has not been edited since our last sync
        // and the source `~/.codex/config.toml` actually changed.
        meta.source_sha256 != source_sha256 && sha256_hex(&existing_bytes) == meta.written_sha256
    } else {
        false
    };

    if should_write {
        let written_bytes = sanitized.as_bytes();
        write_private_credential_file(shadow_home, "config.toml", written_bytes)?;
        let meta = ShadowSyncMeta {
            source_sha256,
            written_sha256: sha256_hex(written_bytes),
        };
        if let Ok(meta_json) = serde_json::to_vec(&meta) {
            let _ = write_private_credential_file(shadow_home, SHADOW_SYNC_META_FILE, &meta_json);
        }
    }
    Ok(())
}

/// Writes `auth.json` exclusively inside `shadow_home` (`0o600` on Unix).
pub fn write_codex_shadow_auth(shadow_home: &Path, auth_bytes: &[u8]) -> std::io::Result<PathBuf> {
    write_private_credential_file(shadow_home, "auth.json", auth_bytes)
}

/// Returns environment variable keys that must be removed from child processes for
/// `claude_code` and `codex` unless explicitly provided by `explicit_env`:
/// 1. Ambient credentials (`AMBIENT_PROVIDER_CREDENTIAL_ENV_KEYS`) so shell exports never bleed across instances.
/// 2. When launching the implicit `"local"` instance, inherited `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
///    unless explicitly configured in `explicit_env`.
pub fn scrub_keys_for_agent_launch(
    agent_id: &AgentId,
    explicit_env: &HashMap<String, String>,
) -> Vec<&'static str> {
    if !matches!(agent_id.as_str(), "claude_code" | "codex") {
        return Vec::new();
    }
    let mut keys = Vec::new();
    for key in AMBIENT_PROVIDER_CREDENTIAL_ENV_KEYS {
        if !explicit_env.contains_key(*key) {
            keys.push(*key);
        }
    }
    let is_custom_instance = explicit_env
        .get("DIMO_PROVIDER_INSTANCE_ID")
        .map(String::as_str)
        .map(str::trim)
        .is_some_and(|id| !id.is_empty() && !id.eq_ignore_ascii_case("local"));
    if !is_custom_instance {
        for key in LOCAL_INSTANCE_OVERRIDE_ENV_KEYS {
            if !explicit_env.contains_key(*key) {
                keys.push(*key);
            }
        }
    }
    keys
}

/// Applies Codex shadow-home preparation and ambient/override env scrubbing onto `cmd`
/// before overlaying `isolation_env` and `spec_env`.
pub fn apply_codex_instance_isolation_env(
    cmd: &mut tokio::process::Command,
    provider_instance_id: Option<&str>,
    isolate_profile: bool,
    isolation_env: &HashMap<String, String>,
    spec_env: &HashMap<String, String>,
    scrubbed_env_keys: &[String],
) {
    let isolated_codex_home = isolation_env
        .get("CODEX_HOME")
        .or_else(|| spec_env.get("CODEX_HOME"))
        .map(PathBuf::from)
        .filter(|dir| {
            let is_custom = provider_instance_id
                .map(str::trim)
                .is_some_and(|id| !id.is_empty() && !id.eq_ignore_ascii_case("local"));
            isolate_profile || is_custom || dir.to_string_lossy().contains("provider-instances")
        });
    if let Some(ref shadow_home) = isolated_codex_home {
        let _ = prepare_codex_shadow_home(None, shadow_home);
    }
    for key in AMBIENT_PROVIDER_CREDENTIAL_ENV_KEYS {
        if !spec_env.contains_key(*key) {
            cmd.env_remove(key);
        }
    }
    if !spec_env.contains_key("CODEX_HOME") && !isolation_env.contains_key("CODEX_HOME") {
        cmd.env_remove("CODEX_HOME");
    }
    cmd.envs(isolation_env).envs(spec_env);
    for key in scrubbed_env_keys {
        cmd.env_remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_home_strips_provider_routing_and_preserves_local_edits() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src-codex");
        let dst = temp.path().join("shadow-codex");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("config.toml"),
            r#"
model = "gpt-5.4"
model_reasoning_effort = "high"
model_provider = "proxy-one"

[model_providers.proxy-one]
name = "Proxy One"
base_url = "https://proxy.example/v1"

[mcp_servers.dimo]
command = "node"
"#,
        )
        .unwrap();

        prepare_codex_shadow_home(Some(&src), &dst).unwrap();
        let first = std::fs::read_to_string(dst.join("config.toml")).unwrap();
        assert!(first.contains("model_reasoning_effort"));
        assert!(first.contains("[mcp_servers.dimo]"));
        assert!(!first.contains("model_provider"));
        assert!(!first.contains("proxy.example"));

        // Local customization in shadow home is preserved even if source changes.
        std::fs::write(dst.join("config.toml"), "model = \"custom-local\"\n").unwrap();
        std::fs::write(src.join("config.toml"), "model = \"updated-upstream\"\n").unwrap();
        prepare_codex_shadow_home(Some(&src), &dst).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.join("config.toml")).unwrap(),
            "model = \"custom-local\"\n"
        );
    }

    #[test]
    fn scrub_keys_block_ambient_credentials_and_local_dir_overrides() {
        let claude = AgentId::parse("claude_code").unwrap();
        let empty = HashMap::new();
        let scrubbed_local = scrub_keys_for_agent_launch(&claude, &empty);
        assert!(scrubbed_local.contains(&"ANTHROPIC_API_KEY"));
        assert!(scrubbed_local.contains(&"OPENAI_API_KEY"));
        assert!(scrubbed_local.contains(&"CLAUDE_CONFIG_DIR"));
        assert!(scrubbed_local.contains(&"CODEX_HOME"));

        let mut custom = HashMap::new();
        custom.insert("DIMO_PROVIDER_INSTANCE_ID".to_string(), "work-1".to_string());
        custom.insert("CLAUDE_CONFIG_DIR".to_string(), "/tmp/work-1".to_string());
        custom.insert("ANTHROPIC_API_KEY".to_string(), "sk-work".to_string());
        let scrubbed_custom = scrub_keys_for_agent_launch(&claude, &custom);
        assert!(!scrubbed_custom.contains(&"ANTHROPIC_API_KEY"));
        assert!(scrubbed_custom.contains(&"OPENAI_API_KEY"));
        assert!(!scrubbed_custom.contains(&"CLAUDE_CONFIG_DIR"));
    }
}
