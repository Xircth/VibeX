use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

use executors::{command::CommandBuilder, executors::ExecutorError};
use serde::{Deserialize, Serialize};
use strum_macros::{EnumIter, EnumString};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS, Error)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum EditorOpenError {
    #[error("Editor executable '{executable}' not found in PATH")]
    ExecutableNotFound {
        executable: String,
        editor_type: EditorType,
    },
    #[error("Editor command for {editor_type:?} is invalid: {details}")]
    InvalidCommand {
        details: String,
        editor_type: EditorType,
    },
    #[error("Failed to launch '{executable}' for {editor_type:?}: {details}")]
    LaunchFailed {
        executable: String,
        details: String,
        editor_type: EditorType,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EditorConfig {
    editor_type: EditorType,
    custom_command: Option<String>,
    #[serde(default)]
    remote_ssh_host: Option<String>,
    #[serde(default)]
    remote_ssh_user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, EnumString, EnumIter)]
#[ts(use_ts_enum)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE")]
pub enum EditorType {
    VsCode,
    VsCodeInsiders,
    Cursor,
    Windsurf,
    IntelliJ,
    Zed,
    Xcode,
    GoogleAntigravity,
    Custom,
    /// The OS file manager (Explorer / Finder / xdg-open) — opens the path's
    /// location rather than a code editor.
    FileManager,
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            editor_type: EditorType::VsCode,
            custom_command: None,
            remote_ssh_host: None,
            remote_ssh_user: None,
        }
    }
}

impl EditorConfig {
    /// Create a new EditorConfig. This is primarily used by version migrations.
    pub fn new(
        editor_type: EditorType,
        custom_command: Option<String>,
        remote_ssh_host: Option<String>,
        remote_ssh_user: Option<String>,
    ) -> Self {
        Self {
            editor_type,
            custom_command,
            remote_ssh_host,
            remote_ssh_user,
        }
    }

    pub fn get_command(&self) -> CommandBuilder {
        let base_command = match &self.editor_type {
            EditorType::VsCode => "code",
            EditorType::VsCodeInsiders => "code-insiders",
            EditorType::Cursor => "cursor",
            EditorType::Windsurf => "windsurf",
            EditorType::IntelliJ => "idea",
            EditorType::Zed => "zed",
            EditorType::Xcode => "xed",
            EditorType::GoogleAntigravity => "antigravity",
            EditorType::Custom => {
                // Custom editor - use user-provided command or fallback to VSCode
                self.custom_command.as_deref().unwrap_or("code")
            }
            EditorType::FileManager => {
                if cfg!(target_os = "windows") {
                    "explorer"
                } else if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                }
            }
        };
        CommandBuilder::new(base_command)
    }

    /// Resolve the editor command to an executable path and args.
    /// This is shared logic used by both check_availability() and spawn_local().
    async fn resolve_command(&self) -> Result<(std::path::PathBuf, Vec<String>), EditorOpenError> {
        let command_builder = self.get_command();
        let command_parts =
            command_builder
                .build_initial()
                .map_err(|e| EditorOpenError::InvalidCommand {
                    details: e.to_string(),
                    editor_type: self.editor_type.clone(),
                })?;

        let (executable, args) = match command_parts.into_resolved().await {
            Ok(resolved) => resolved,
            Err(ExecutorError::ExecutableNotFound { program }) => {
                if let Some(resolved) = self.resolve_macos_app_command().await? {
                    resolved
                } else {
                    return Err(EditorOpenError::ExecutableNotFound {
                        executable: program,
                        editor_type: self.editor_type.clone(),
                    });
                }
            }
            Err(e) => {
                return Err(EditorOpenError::InvalidCommand {
                    details: e.to_string(),
                    editor_type: self.editor_type.clone(),
                });
            }
        };

        Ok((executable, args))
    }

    async fn resolve_macos_app_command(
        &self,
    ) -> Result<Option<(PathBuf, Vec<String>)>, EditorOpenError> {
        if !cfg!(target_os = "macos") || !self.macos_app_is_installed() {
            return Ok(None);
        }

        let app_name = self.macos_app_name().expect("app was checked above");
        let command_parts = CommandBuilder::new("open")
            .params(["-a", app_name])
            .build_initial()
            .map_err(|e| EditorOpenError::InvalidCommand {
                details: e.to_string(),
                editor_type: self.editor_type.clone(),
            })?;

        command_parts
            .into_resolved()
            .await
            .map(Some)
            .map_err(|e| match e {
                ExecutorError::ExecutableNotFound { program } => {
                    EditorOpenError::ExecutableNotFound {
                        executable: program,
                        editor_type: self.editor_type.clone(),
                    }
                }
                _ => EditorOpenError::InvalidCommand {
                    details: e.to_string(),
                    editor_type: self.editor_type.clone(),
                },
            })
    }

    fn macos_app_name(&self) -> Option<&'static str> {
        match self.editor_type {
            EditorType::VsCode => Some("Visual Studio Code"),
            EditorType::VsCodeInsiders => Some("Visual Studio Code - Insiders"),
            EditorType::Cursor => Some("Cursor"),
            EditorType::Windsurf => Some("Windsurf"),
            EditorType::IntelliJ => Some("IntelliJ IDEA"),
            EditorType::Zed => Some("Zed"),
            EditorType::Xcode => Some("Xcode"),
            EditorType::GoogleAntigravity => Some("Google Antigravity"),
            EditorType::Custom | EditorType::FileManager => None,
        }
    }

    fn macos_app_bundle_candidates(&self) -> Vec<PathBuf> {
        let Some(app_name) = self.macos_app_name() else {
            return Vec::new();
        };
        let app_bundle = format!("{app_name}.app");
        let mut candidates = vec![PathBuf::from("/Applications").join(&app_bundle)];
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications").join(app_bundle));
        }
        candidates
    }

    fn macos_app_is_installed(&self) -> bool {
        self.macos_app_bundle_candidates()
            .iter()
            .any(|path| path.is_dir())
    }

    /// Check if the editor is available on the system.
    /// Uses the same command resolution logic as spawn_local().
    pub async fn check_availability(&self) -> bool {
        // The OS file manager is always present.
        if matches!(self.editor_type, EditorType::FileManager) {
            return true;
        }
        self.resolve_command().await.is_ok()
    }

    /// Reveal a path in the OS file manager (Explorer / Finder / xdg-open).
    fn reveal_in_file_manager(&self, path: &Path) -> Result<(), EditorOpenError> {
        let fail = |details: String| EditorOpenError::LaunchFailed {
            executable: "file-manager".to_string(),
            details,
            editor_type: EditorType::FileManager,
        };
        let no_args: Vec<String> = Vec::new();
        let mut cmd;
        if cfg!(target_os = "windows") {
            cmd = utils::process::new_hidden_std_command("explorer", &no_args);
            if path.is_file() {
                // `/select,<file>` highlights the file in its folder.
                cmd.arg(format!("/select,{}", path.display()));
            } else {
                cmd.arg(path);
            }
        } else if cfg!(target_os = "macos") {
            cmd = utils::process::new_hidden_std_command("open", &no_args);
            if path.is_file() {
                cmd.arg("-R");
            }
            cmd.arg(path);
        } else {
            let target = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            cmd = utils::process::new_hidden_std_command("xdg-open", &no_args);
            cmd.arg(target);
        }
        // Note: Explorer exits non-zero even on success, so we only spawn.
        cmd.spawn().map_err(|e| fail(e.to_string()))?;
        Ok(())
    }

    fn supports_vscode_extensions(&self) -> bool {
        matches!(
            self.editor_type,
            EditorType::VsCode
                | EditorType::VsCodeInsiders
                | EditorType::Cursor
                | EditorType::Windsurf
                | EditorType::GoogleAntigravity
        )
    }

    fn ensure_extension_recommended(path: &Path) {
        if !path.is_dir() {
            return;
        }

        let vscode_dir = path.join(".vscode");
        let extensions_file = vscode_dir.join("extensions.json");
        const EXTENSION_ID: &str = "vibex.vibex";

        let mut json: serde_json::Value = if extensions_file.exists() {
            match std::fs::read_to_string(&extensions_file) {
                Ok(content) => match serde_json::from_str(&content) {
                    Ok(parsed) => parsed,
                    Err(e) => {
                        // Do not clobber a file we cannot parse (e.g. JSONC with
                        // comments, which VSCode accepts): skip rather than
                        // overwrite the user's other recommendations with `[]`.
                        tracing::warn!(
                            file = ?extensions_file,
                            error = %e,
                            "extensions.json is not valid JSON; skipping VibeX recommendation"
                        );
                        return;
                    }
                },
                Err(e) => {
                    tracing::warn!(
                        file = ?extensions_file,
                        error = %e,
                        "failed to read extensions.json; skipping VibeX recommendation"
                    );
                    return;
                }
            }
        } else {
            serde_json::json!({"recommendations": []})
        };

        if !json.get("recommendations").is_some_and(|v| v.is_array()) {
            json["recommendations"] = serde_json::json!([]);
        }

        let recommendations = json["recommendations"].as_array().unwrap();
        if recommendations
            .iter()
            .any(|v| v.as_str() == Some(EXTENSION_ID))
        {
            return;
        }

        json["recommendations"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!(EXTENSION_ID));

        if let Err(e) = std::fs::create_dir_all(&vscode_dir) {
            tracing::warn!("Failed to create .vscode directory: {}", e);
            return;
        }
        match serde_json::to_string_pretty(&json) {
            Ok(content) => {
                if let Err(e) = std::fs::write(&extensions_file, content) {
                    tracing::warn!("Failed to write extensions.json: {}", e);
                }
            }
            Err(e) => tracing::warn!("Failed to serialize extensions.json: {}", e),
        }
    }

    pub async fn open_file(&self, path: &Path) -> Result<Option<String>, EditorOpenError> {
        if matches!(self.editor_type, EditorType::FileManager) {
            self.reveal_in_file_manager(path)?;
            return Ok(None);
        }
        if let Some(url) = self.remote_url(path) {
            return Ok(Some(url));
        }
        if self.supports_vscode_extensions() {
            Self::ensure_extension_recommended(path);
        }
        self.spawn_local(path).await?;
        Ok(None)
    }

    fn remote_url(&self, path: &Path) -> Option<String> {
        let remote_host = self.remote_ssh_host.as_ref()?;
        let user_part = self
            .remote_ssh_user
            .as_ref()
            .map(|u| format!("{u}@"))
            .unwrap_or_default();
        let path_str = path.to_string_lossy();

        let scheme = match self.editor_type {
            EditorType::VsCode => "vscode",
            EditorType::VsCodeInsiders => "vscode-insiders",
            EditorType::Cursor => "cursor",
            EditorType::Windsurf => "windsurf",
            EditorType::GoogleAntigravity => "antigravity",
            EditorType::Zed => {
                return Some(format!("zed://ssh/{user_part}{remote_host}{path_str}"));
            }
            _ => return None,
        };

        // files must contain a line and column number
        let line_col = if path.is_file() { ":1:1" } else { "" };
        Some(format!(
            "{scheme}://vscode-remote/ssh-remote+{user_part}{remote_host}{path_str}{line_col}"
        ))
    }

    pub async fn spawn_local(&self, path: &Path) -> Result<(), EditorOpenError> {
        let (executable, args) = self.resolve_command().await?;

        let mut cmd = utils::process::new_hidden_std_command(&executable, &args);
        cmd.arg(path);
        cmd.spawn().map_err(|e| EditorOpenError::LaunchFailed {
            executable: executable.to_string_lossy().into_owned(),
            details: e.to_string(),
            editor_type: self.editor_type.clone(),
        })?;
        Ok(())
    }

    pub fn with_override(&self, editor_type_str: Option<&str>) -> Self {
        if let Some(editor_type_str) = editor_type_str {
            let editor_type =
                EditorType::from_str(editor_type_str).unwrap_or(self.editor_type.clone());
            EditorConfig {
                editor_type,
                custom_command: self.custom_command.clone(),
                remote_ssh_host: self.remote_ssh_host.clone(),
                remote_ssh_user: self.remote_ssh_user.clone(),
            }
        } else {
            self.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{EditorConfig, EditorType};

    #[test]
    fn vscode_macos_app_fallback_checks_standard_bundle_locations() {
        let config = EditorConfig::new(EditorType::VsCode, None, None, None);
        let candidates = config.macos_app_bundle_candidates();

        assert!(
            candidates
                .iter()
                .any(|path| path.ends_with("Visual Studio Code.app"))
        );
        assert!(
            candidates
                .iter()
                .any(|path| path
                    == &std::path::PathBuf::from("/Applications/Visual Studio Code.app"))
        );
    }

    #[test]
    fn custom_editor_does_not_use_macos_app_fallback() {
        let config = EditorConfig::new(
            EditorType::Custom,
            Some("my-editor".to_string()),
            None,
            None,
        );

        assert!(config.macos_app_name().is_none());
        assert!(config.macos_app_bundle_candidates().is_empty());
    }
}
