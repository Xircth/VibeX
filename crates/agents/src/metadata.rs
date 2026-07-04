use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentKind;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
#[ts(export)]
pub enum AgentCapability {
    SessionFork,
    SetupHelper,
    ContextUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export)]
pub enum AgentAvailabilityInfo {
    LoginDetected { last_auth_timestamp: i64 },
    InstallationFound,
    NotFound,
}

impl AgentAvailabilityInfo {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::LoginDetected { .. } | Self::InstallationFound)
    }
}

pub fn agent_capabilities(agent_type: AgentKind) -> Vec<AgentCapability> {
    match agent_type {
        AgentKind::ClaudeCode | AgentKind::Opencode => {
            vec![AgentCapability::SessionFork, AgentCapability::ContextUsage]
        }
        AgentKind::Codex => vec![
            AgentCapability::SessionFork,
            AgentCapability::SetupHelper,
            AgentCapability::ContextUsage,
        ],
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => {
            vec![AgentCapability::ContextUsage]
        }
    }
}

pub fn agent_availability(agent_type: AgentKind) -> AgentAvailabilityInfo {
    match agent_type {
        AgentKind::ClaudeCode => modified_timestamp(claude_config_path()).map_or(
            AgentAvailabilityInfo::NotFound,
            |last_auth_timestamp| AgentAvailabilityInfo::LoginDetected {
                last_auth_timestamp,
            },
        ),
        AgentKind::Codex => {
            if let Some(last_auth_timestamp) = modified_timestamp(codex_auth_path()) {
                return AgentAvailabilityInfo::LoginDetected {
                    last_auth_timestamp,
                };
            }

            let has_codex_files = codex_home()
                .map(|home| home.join("version.json").exists() || home.join("config.toml").exists())
                .unwrap_or(false);
            if has_codex_files {
                AgentAvailabilityInfo::InstallationFound
            } else {
                AgentAvailabilityInfo::NotFound
            }
        }
        AgentKind::Opencode => {
            if opencode_config_path()
                .map(|path| path.exists())
                .unwrap_or(false)
            {
                AgentAvailabilityInfo::InstallationFound
            } else {
                AgentAvailabilityInfo::NotFound
            }
        }
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => AgentAvailabilityInfo::NotFound,
    }
}

pub fn claude_config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude.json"))
}

pub fn codex_home() -> Option<std::path::PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

pub fn codex_config_path() -> Option<std::path::PathBuf> {
    codex_home().map(|home| home.join("config.toml"))
}

pub fn codex_auth_path() -> Option<std::path::PathBuf> {
    codex_home().map(|home| home.join("auth.json"))
}

pub fn opencode_config_path() -> Option<std::path::PathBuf> {
    let dir = opencode_config_dir()?;
    let json = dir.join("opencode.json");
    if json.exists() {
        Some(json)
    } else {
        Some(dir.join("opencode.jsonc"))
    }
}

pub fn opencode_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|path| path.join(".config").join("opencode"))
    }
    #[cfg(windows)]
    {
        std::env::var("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Roaming")))
            .map(|base| base.join("opencode"))
    }
}

pub fn opencode_auth_path() -> Option<std::path::PathBuf> {
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|path| {
            path.join(".local")
                .join("share")
                .join("opencode")
                .join("auth.json")
        })
    }
    #[cfg(windows)]
    {
        std::env::var("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|path| path.join(".local").join("share")))
            .map(|path| path.join("opencode").join("auth.json"))
    }
}

fn modified_timestamp(path: Option<std::path::PathBuf>) -> Option<i64> {
    path.and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
}
