use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentType;

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
        matches!(
            self,
            Self::LoginDetected { .. } | Self::InstallationFound
        )
    }
}

pub fn agent_capabilities(agent_type: AgentType) -> Vec<AgentCapability> {
    match agent_type {
        AgentType::ClaudeCode | AgentType::OpenCode => {
            vec![AgentCapability::SessionFork, AgentCapability::ContextUsage]
        }
        AgentType::Codex => vec![
            AgentCapability::SessionFork,
            AgentCapability::SetupHelper,
            AgentCapability::ContextUsage,
        ],
        AgentType::Gemini | AgentType::OpenClaw | AgentType::Cline | AgentType::Hermes => {
            vec![AgentCapability::ContextUsage]
        }
    }
}

pub fn agent_availability(agent_type: AgentType) -> AgentAvailabilityInfo {
    match agent_type {
        AgentType::ClaudeCode => modified_timestamp(claude_config_path()).map_or(
            AgentAvailabilityInfo::NotFound,
            |last_auth_timestamp| AgentAvailabilityInfo::LoginDetected {
                last_auth_timestamp,
            },
        ),
        AgentType::Codex => {
            if let Some(last_auth_timestamp) = modified_timestamp(codex_auth_path()) {
                return AgentAvailabilityInfo::LoginDetected {
                    last_auth_timestamp,
                };
            }

            let has_codex_files = codex_home()
                .map(|home| {
                    home.join("version.json").exists() || home.join("config.toml").exists()
                })
                .unwrap_or(false);
            if has_codex_files {
                AgentAvailabilityInfo::InstallationFound
            } else {
                AgentAvailabilityInfo::NotFound
            }
        }
        AgentType::OpenCode => {
            if opencode_config_path()
                .map(|path| path.exists())
                .unwrap_or(false)
            {
                AgentAvailabilityInfo::InstallationFound
            } else {
                AgentAvailabilityInfo::NotFound
            }
        }
        AgentType::Gemini | AgentType::OpenClaw | AgentType::Cline | AgentType::Hermes => {
            AgentAvailabilityInfo::NotFound
        }
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
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir()?;
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let dir = config_home.join("opencode");
        let json = dir.join("opencode.json");
        if json.exists() {
            Some(json)
        } else {
            Some(dir.join("opencode.jsonc"))
        }
    }
    #[cfg(windows)]
    {
        let config_dir = std::env::var("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Roaming")))
            .map(|base| base.join("opencode"));
        config_dir.map(|dir| {
            let json = dir.join("opencode.json");
            if json.exists() {
                json
            } else {
                dir.join("opencode.jsonc")
            }
        })
    }
}

fn modified_timestamp(path: Option<std::path::PathBuf>) -> Option<i64> {
    path.and_then(|path| std::fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
}
