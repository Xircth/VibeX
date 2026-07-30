use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
#[ts(export)]
pub enum AgentCapability {
    /// Reset-to-here: truncate the conversation at a chosen turn and resend.
    /// Honestly universal — the backend truncate path has no capability gate.
    ResetToHere,
    SetupHelper,
    ContextUsage,
}

pub fn agent_capabilities() -> Vec<AgentCapability> {
    vec![AgentCapability::ResetToHere, AgentCapability::ContextUsage]
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

#[cfg(test)]
mod tests {
    use super::*;

    // Reset-to-here (truncate + resend) has no capability gate on its backend
    // path and its shipped button is ungated, so the capability must be honest:
    // advertised for every agent, never claiming a fork the app cannot perform.
    #[test]
    fn reset_to_here_is_advertised_for_every_agent() {
        assert!(agent_capabilities().contains(&AgentCapability::ResetToHere));
    }
}
