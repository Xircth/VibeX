use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

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
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            return Some(std::path::PathBuf::from(trimmed).join("opencode"));
        }
    }
    let home = dirs::home_dir()?;
    let xdg_style = home.join(".config").join("opencode");
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("opencode");
        if !xdg_style.exists() && appdata.exists() {
            return Some(appdata);
        }
    }
    Some(xdg_style)
}

pub fn opencode_auth_path() -> Option<std::path::PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let trimmed = xdg.trim();
        if !trimmed.is_empty() {
            return Some(
                std::path::PathBuf::from(trimmed)
                    .join("opencode")
                    .join("auth.json"),
            );
        }
    }
    dirs::home_dir().map(|home| {
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json")
    })
}

pub fn opencode_config_dir_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    xdg_dir_from_env(env, "XDG_CONFIG_HOME")
        .map(|root| root.join("opencode"))
        .or_else(opencode_config_dir)
}

pub fn opencode_auth_path_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    xdg_dir_from_env(env, "XDG_DATA_HOME")
        .map(|root| root.join("opencode").join("auth.json"))
        .or_else(opencode_auth_path)
}

pub fn mimo_native_binding_path(
    binding_id: &str,
    home: &Path,
    environment: &std::collections::BTreeMap<String, String>,
) -> Option<PathBuf> {
    let env: HashMap<String, String> = environment
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    match binding_id {
        "mimo_auth" => Some(mimo_auth_path(home, &env)),
        "mimo_config" => Some(mimo_config_file(home, &env)),
        _ => None,
    }
}

pub fn mimo_config_dir_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    dirs::home_dir().map(|home| mimo_config_dir(&home, env))
}

pub fn mimo_auth_path_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    dirs::home_dir().map(|home| mimo_auth_path(&home, env))
}

pub fn mimo_config_path_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    dirs::home_dir().map(|home| mimo_config_file(&home, env))
}

pub fn mimo_cache_dir_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    dirs::home_dir().map(|home| mimo_cache_dir(&home, env))
}

fn mimo_config_dir(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    if let Some(root) = mimo_home_from_env(env) {
        return root.join("config");
    }
    xdg_dir_from_env(env, "XDG_CONFIG_HOME")
        .map(|root| root.join("mimocode"))
        .unwrap_or_else(|| home.join(".config").join("mimocode"))
}

fn mimo_auth_path(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    if let Some(root) = mimo_home_from_env(env) {
        return root.join("data").join("auth.json");
    }
    xdg_dir_from_env(env, "XDG_DATA_HOME")
        .map(|root| root.join("mimocode").join("auth.json"))
        .unwrap_or_else(|| {
            home.join(".local")
                .join("share")
                .join("mimocode")
                .join("auth.json")
        })
}

fn mimo_config_file(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    let dir = mimo_config_dir(home, env);
    let json = dir.join("mimocode.json");
    let jsonc = dir.join("mimocode.jsonc");
    if json.is_file() {
        json
    } else if jsonc.is_file() {
        jsonc
    } else {
        json
    }
}

fn mimo_cache_dir(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    if let Some(root) = mimo_home_from_env(env) {
        return root.join("cache");
    }
    xdg_dir_from_env(env, "XDG_CACHE_HOME")
        .map(|root| root.join("mimocode"))
        .unwrap_or_else(|| home.join(".cache").join("mimocode"))
}

fn mimo_home_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    env.get("MIMOCODE_HOME")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| expand_home_prefix(dirs::home_dir().as_deref(), value))
        .or_else(|| {
            std::env::var("MIMOCODE_HOME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| expand_home_prefix(dirs::home_dir().as_deref(), &value))
        })
        .filter(|path| path.is_absolute())
}

pub fn opencode_cache_dir_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    xdg_dir_from_env(env, "XDG_CACHE_HOME")
        .map(|root| root.join("opencode"))
        .or_else(|| {
            std::env::var("XDG_CACHE_HOME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join("opencode"))
        })
        .or_else(|| dirs::home_dir().map(|home| home.join(".cache").join("opencode")))
}

fn xdg_dir_from_env(env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
    let value = env
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())?;
    Some(expand_home_prefix(dirs::home_dir().as_deref(), value))
}

fn expand_home_prefix(home: Option<&Path>, value: &str) -> PathBuf {
    if value == "~" {
        return home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home
            .map(|home| home.join(relative))
            .unwrap_or_else(|| PathBuf::from(value));
    }
    PathBuf::from(value)
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

    #[test]
    fn opencode_paths_prefer_saved_xdg_over_process_env() {
        let env = HashMap::from([
            ("XDG_DATA_HOME".to_string(), "/tmp/agent-data".to_string()),
            (
                "XDG_CONFIG_HOME".to_string(),
                "/tmp/agent-config".to_string(),
            ),
            ("XDG_CACHE_HOME".to_string(), "/tmp/agent-cache".to_string()),
        ]);

        assert_eq!(
            opencode_auth_path_from_env(&env).unwrap(),
            PathBuf::from("/tmp/agent-data/opencode/auth.json")
        );
        assert_eq!(
            opencode_config_dir_from_env(&env).unwrap(),
            PathBuf::from("/tmp/agent-config/opencode")
        );
        assert_eq!(
            opencode_cache_dir_from_env(&env).unwrap(),
            PathBuf::from("/tmp/agent-cache/opencode")
        );
    }
}
