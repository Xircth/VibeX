use std::path::{Path, PathBuf};

use agents::{AgentType, codex_home, opencode_auth_path, opencode_config_dir};
use chrono::Local;
use serde::{Deserialize, Serialize};
use tokio::fs;
use ts_rs::TS;
use utils::path::normalize_windows_extended_path_prefix;

use crate::error::AppError;

/// Maximum number of timestamped backups kept per source file.
const MAX_BACKUPS_PER_FILE: usize = 20;

/// Root directory for VibeX-managed config backups (`~/.vibex`).
fn vibex_backup_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".vibex"))
}

/// `<stem>-backup-<stamp>.<ext>`, e.g. `config-backup-202606132121.toml`.
fn backup_file_name(stem: &str, ext: Option<&str>, stamp: &str) -> String {
    match ext {
        Some(ext) => format!("{stem}-backup-{stamp}.{ext}"),
        None => format!("{stem}-backup-{stamp}"),
    }
}

/// Back up `src` before it is overwritten, copying it to
/// `~/.vibex/<agent_key>/<stem>-backup-<YYYYMMDDHHMMSS>.<ext>`.
///
/// Returns `Ok(None)` when `src` does not yet exist or the home directory
/// cannot be resolved. A backup failure aborts the caller, so a real config
/// file is never overwritten without first preserving a copy.
async fn backup_agent_config_file(
    agent_key: &str,
    src: &Path,
) -> Result<Option<PathBuf>, AppError> {
    if !src.exists() {
        return Ok(None);
    }
    let Some(root) = vibex_backup_root() else {
        return Ok(None);
    };

    let dir = root.join(agent_key);
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create backup directory: {}", e)))?;

    let stem = src
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("config");
    let ext = src.extension().and_then(|value| value.to_str());
    let stamp = Local::now().format("%Y%m%d%H%M%S").to_string();
    let dest = dir.join(backup_file_name(stem, ext, &stamp));

    fs::copy(src, &dest)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to back up {}: {}", src.display(), e)))?;

    prune_old_backups(&dir, stem, ext).await;
    Ok(Some(dest))
}

/// Keep only the most recent `MAX_BACKUPS_PER_FILE` backups for a given
/// `<stem>.<ext>` pair. Best-effort: never fails the surrounding write.
async fn prune_old_backups(dir: &Path, stem: &str, ext: Option<&str>) {
    let prefix = format!("{stem}-backup-");
    let suffix = ext.map(|ext| format!(".{ext}")).unwrap_or_default();

    let Ok(mut entries) = fs::read_dir(dir).await else {
        return;
    };
    let mut matches: Vec<PathBuf> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) && name.ends_with(suffix.as_str()) {
            matches.push(entry.path());
        }
    }

    if matches.len() <= MAX_BACKUPS_PER_FILE {
        return;
    }
    // Timestamps are fixed-width, so lexicographic order is chronological.
    matches.sort();
    let remove = matches.len() - MAX_BACKUPS_PER_FILE;
    for path in matches.into_iter().take(remove) {
        let _ = fs::remove_file(path).await;
    }
}

// ─── Generic per-agent native config files (all 7 ACP agents) ──────────────
//
// Each agent edits its OWN native config file(s) directly — the same files the
// underlying CLI reads. OpenClaw has none (it is configured via gateway env
// vars), so it returns an empty list. Writes are backed up to `~/.vibex` first.

/// One editable native config file for an agent.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct AgentNativeFile {
    /// Stable identifier within the agent (e.g. "config", "auth", "secrets").
    pub id: String,
    /// Display label / filename (e.g. "config.toml").
    pub label: String,
    /// Absolute path on disk.
    pub path: String,
    /// Editor language hint: "json" | "toml" | "yaml" | "env" | "text".
    pub format: String,
    pub exists: bool,
    pub content: Option<String>,
}

/// A single file to persist via `agent_native_files_write`.
#[derive(Debug, Serialize, Deserialize, TS)]
pub struct AgentNativeFileWrite {
    pub id: String,
    pub content: String,
}

struct NativeFileSpec {
    id: &'static str,
    label: &'static str,
    format: &'static str,
    path: Option<PathBuf>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `$HERMES_HOME` or `~/.hermes`.
fn hermes_home() -> Option<PathBuf> {
    std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".hermes")))
}

/// Backup subdirectory under `~/.vibex` for an agent.
fn backup_key(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => "claude_code",
        AgentType::Codex => "codex",
        AgentType::OpenCode => "opencode",
        AgentType::Gemini => "gemini",
        AgentType::OpenClaw => "open_claw",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
    }
}

/// The native config files each agent exposes for direct editing.
fn native_file_specs(agent_type: AgentType) -> Vec<NativeFileSpec> {
    match agent_type {
        AgentType::ClaudeCode => vec![NativeFileSpec {
            id: "settings",
            label: "settings.json",
            format: "json",
            path: home().map(|h| h.join(".claude").join("settings.json")),
        }],
        AgentType::Codex => vec![
            NativeFileSpec {
                id: "config",
                label: "config.toml",
                format: "toml",
                path: codex_home().map(|h| h.join("config.toml")),
            },
            NativeFileSpec {
                id: "auth",
                label: "auth.json",
                format: "json",
                path: codex_home().map(|h| h.join("auth.json")),
            },
        ],
        AgentType::OpenCode => vec![
            NativeFileSpec {
                id: "config",
                label: "opencode.json",
                format: "json",
                path: opencode_config_dir().map(|d| d.join("opencode.json")),
            },
            NativeFileSpec {
                id: "auth",
                label: "auth.json",
                format: "json",
                path: opencode_auth_path(),
            },
        ],
        AgentType::Gemini => vec![NativeFileSpec {
            id: "settings",
            label: "settings.json",
            format: "json",
            path: home().map(|h| h.join(".gemini").join("settings.json")),
        }],
        AgentType::Cline => vec![
            NativeFileSpec {
                id: "global_state",
                label: "globalState.json",
                format: "json",
                path: home().map(|h| h.join(".cline").join("data").join("globalState.json")),
            },
            NativeFileSpec {
                id: "secrets",
                label: "secrets.json",
                format: "json",
                path: home().map(|h| h.join(".cline").join("data").join("secrets.json")),
            },
        ],
        AgentType::Hermes => vec![
            NativeFileSpec {
                id: "config",
                label: "config.yaml",
                format: "yaml",
                path: hermes_home().map(|h| h.join("config.yaml")),
            },
            NativeFileSpec {
                id: "env",
                label: ".env",
                format: "env",
                path: hermes_home().map(|h| h.join(".env")),
            },
        ],
        // OpenClaw is configured through gateway environment variables, not a file.
        AgentType::OpenClaw => Vec::new(),
    }
}

pub(crate) async fn agent_native_files_read(
    agent_type: AgentType,
) -> Result<Vec<AgentNativeFile>, AppError> {
    let mut files = Vec::new();
    for spec in native_file_specs(agent_type) {
        let Some(path) = spec.path else {
            continue;
        };
        let exists = path.exists();
        let content =
            if exists {
                Some(fs::read_to_string(&path).await.map_err(|e| {
                    AppError::Internal(format!("Failed to read {}: {}", spec.label, e))
                })?)
            } else {
                None
            };
        files.push(AgentNativeFile {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            path: normalize_windows_extended_path_prefix(&path)
                .display()
                .to_string(),
            format: spec.format.to_string(),
            exists,
            content,
        });
    }
    Ok(files)
}

pub(crate) async fn agent_native_files_write(
    agent_type: AgentType,
    files: Vec<AgentNativeFileWrite>,
) -> Result<Vec<AgentNativeFile>, AppError> {
    let specs = native_file_specs(agent_type);
    let key = backup_key(agent_type);

    for write in &files {
        let spec = specs
            .iter()
            .find(|spec| spec.id == write.id)
            .ok_or_else(|| {
                AppError::BadRequest(format!("Unknown native config file id: {}", write.id))
            })?;
        let path = spec.path.clone().ok_or_else(|| {
            AppError::Internal(format!("Could not resolve path for {}", spec.label))
        })?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(|e| {
                AppError::Internal(format!("Failed to create config directory: {}", e))
            })?;
        }

        backup_agent_config_file(key, &path).await?;
        fs::write(&path, &write.content)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to write {}: {}", spec.label, e)))?;
    }

    agent_native_files_read(agent_type).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_claw_has_no_native_config_file() {
        assert!(native_file_specs(AgentType::OpenClaw).is_empty());
    }

    #[test]
    fn file_backed_agents_expose_expected_files() {
        let ids = |agent: AgentType| {
            native_file_specs(agent)
                .iter()
                .map(|spec| spec.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(AgentType::Codex), vec!["config", "auth"]);
        assert_eq!(ids(AgentType::Cline), vec!["global_state", "secrets"]);
        assert_eq!(ids(AgentType::Hermes), vec!["config", "env"]);
        assert_eq!(ids(AgentType::ClaudeCode), vec!["settings"]);
        assert_eq!(ids(AgentType::Gemini), vec!["settings"]);
    }

    #[test]
    fn builds_timestamped_backup_name() {
        assert_eq!(
            backup_file_name("config", Some("toml"), "202606132121"),
            "config-backup-202606132121.toml"
        );
        assert_eq!(
            backup_file_name("auth", Some("json"), "20260613212100"),
            "auth-backup-20260613212100.json"
        );
        assert_eq!(
            backup_file_name("config", None, "202606132121"),
            "config-backup-202606132121"
        );
    }

    #[test]
    fn backup_root_lives_under_dot_vibex() {
        if let Some(root) = vibex_backup_root() {
            assert!(root.ends_with(".vibex"));
        }
    }
}
