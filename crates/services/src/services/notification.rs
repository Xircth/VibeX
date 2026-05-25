use std::sync::{Arc, OnceLock};

use tokio::sync::RwLock;
use utils;

use crate::services::config::{Config, NotificationConfig, SoundFile};

/// Service for handling completion sound alerts.
#[derive(Debug, Clone)]
pub struct NotificationService {
    config: Arc<RwLock<Config>>,
}

/// Cache for WSL root path from PowerShell
static WSL_ROOT_PATH_CACHE: OnceLock<Option<String>> = OnceLock::new();

impl NotificationService {
    pub fn new(config: Arc<RwLock<Config>>) -> Self {
        Self { config }
    }

    /// Send completion notifications if enabled.
    pub async fn notify(&self, _title: &str, _message: &str) {
        let config = self.config.read().await.notifications.clone();
        Self::send_notification(&config).await;
    }

    /// Internal method to send notifications with a given config
    async fn send_notification(config: &NotificationConfig) {
        if config.sound_enabled {
            Self::play_sound_notification(&config.sound_file).await;
        }
    }

    /// Play a system sound notification across platforms
    async fn play_sound_notification(sound_file: &SoundFile) {
        let file_path = match sound_file.get_path().await {
            Ok(path) => path,
            Err(e) => {
                tracing::error!("Failed to create cached sound file: {}", e);
                return;
            }
        };

        // Use platform-specific sound notification
        // Note: spawn() calls are intentionally not awaited - sound notifications should be fire-and-forget
        if cfg!(target_os = "macos") {
            let _ = tokio::process::Command::new("afplay")
                .arg(&file_path)
                .spawn();
        } else if cfg!(target_os = "linux") && !utils::is_wsl2() {
            // Try different Linux audio players
            if tokio::process::Command::new("paplay")
                .arg(&file_path)
                .spawn()
                .is_ok()
            {
                // Success with paplay
            } else if tokio::process::Command::new("aplay")
                .arg(&file_path)
                .spawn()
                .is_ok()
            {
                // Success with aplay
            } else {
                // Try system bell as fallback
                let _ = tokio::process::Command::new("echo")
                    .arg("-e")
                    .arg("\\a")
                    .spawn();
            }
        } else if cfg!(target_os = "windows") || (cfg!(target_os = "linux") && utils::is_wsl2()) {
            // Convert WSL path to Windows path if in WSL2
            let file_path = if utils::is_wsl2() {
                if let Some(windows_path) = Self::wsl_to_windows_path(&file_path).await {
                    windows_path
                } else {
                    file_path.to_string_lossy().to_string()
                }
            } else {
                file_path.to_string_lossy().to_string()
            };

            // Sanitize file path: use PowerShell single-quoted string (verbatim),
            // which only requires escaping single quotes (by doubling them).
            // Single-quoted strings in PowerShell do NOT expand variables ($),
            // subexpressions, or backtick escapes, making them injection-safe.
            let safe_path = file_path.replace('\'', "''");
            let mut cmd = tokio::process::Command::new("powershell.exe");
            cmd.arg("-NoProfile").arg("-Command").arg(format!(
                "(New-Object Media.SoundPlayer '{safe_path}').PlaySync()"
            ));
            utils::process::configure_tokio_command_no_window(&mut cmd);
            let _ = cmd.spawn();
        }
    }

    /// Get WSL root path via PowerShell (cached)
    async fn get_wsl_root_path() -> Option<String> {
        if let Some(cached) = WSL_ROOT_PATH_CACHE.get() {
            return cached.clone();
        }

        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.arg("-c")
            .arg("(Get-Location).Path -replace '^.*::', ''")
            .current_dir("/");
        utils::process::configure_tokio_command_no_window(&mut cmd);
        match cmd.output().await {
            Ok(output) => {
                match String::from_utf8(output.stdout) {
                    Ok(pwd_str) => {
                        let pwd = pwd_str.trim();
                        tracing::info!("WSL root path detected: {}", pwd);

                        // Cache the result
                        let _ = WSL_ROOT_PATH_CACHE.set(Some(pwd.to_string()));
                        return Some(pwd.to_string());
                    }
                    Err(e) => {
                        tracing::error!("Failed to parse PowerShell pwd output as UTF-8: {}", e);
                    }
                }
            }
            Err(e) => {
                tracing::error!("Failed to execute PowerShell pwd command: {}", e);
            }
        }

        // Cache the failure result
        let _ = WSL_ROOT_PATH_CACHE.set(None);
        None
    }

    /// Convert WSL path to Windows UNC path for PowerShell
    async fn wsl_to_windows_path(wsl_path: &std::path::Path) -> Option<String> {
        let path_str = wsl_path.to_string_lossy();

        // Relative paths work fine as-is in PowerShell
        if !path_str.starts_with('/') {
            tracing::debug!("Using relative path as-is: {}", path_str);
            return Some(path_str.to_string());
        }

        // Get cached WSL root path from PowerShell
        if let Some(wsl_root) = Self::get_wsl_root_path().await {
            // Simply concatenate WSL root with the absolute path - PowerShell doesn't mind /
            let windows_path = format!("{wsl_root}{path_str}");
            tracing::debug!("WSL path converted: {} -> {}", path_str, windows_path);
            Some(windows_path)
        } else {
            tracing::error!(
                "Failed to determine WSL root path for conversion: {}",
                path_str
            );
            None
        }
    }
}
