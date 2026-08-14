use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    sync::Mutex,
    time::{Instant, timeout},
};
use uuid::Uuid;

use crate::{
    PluginPreviewHost, PluginPreviewHostError, PluginPreviewRequest, PluginPreviewSession,
};

type WatchKey = (String, String, u64, String, PathBuf);
const PREVIEW_LEASE_TTL: Duration = Duration::from_secs(5 * 60);

struct PreviewWatch {
    child: Child,
    port: u16,
    references: u32,
}

struct PreviewLease {
    watch: WatchKey,
    expires_at: Instant,
}

#[derive(Default)]
struct PreviewState {
    watches: HashMap<WatchKey, PreviewWatch>,
    leases: HashMap<String, PreviewLease>,
}

/// Executes preview providers solely from active Registry contributions and an
/// exact content-addressed Runtime lock. No plugin id or provider is compiled
/// into this Host.
pub struct ExternalProcessPreviewHost {
    plugins: Arc<crate::PluginControlPlane>,
    state: Arc<Mutex<PreviewState>>,
}

impl ExternalProcessPreviewHost {
    pub fn new(plugins: Arc<crate::PluginControlPlane>) -> Self {
        Self {
            plugins,
            state: Arc::new(Mutex::new(PreviewState::default())),
        }
    }
}

#[async_trait]
impl PluginPreviewHost for ExternalProcessPreviewHost {
    async fn open_preview(
        &self,
        request: PluginPreviewRequest,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        let plugin = self
            .plugins
            .plugin(&request.plugin_id)
            .await
            .map_err(plugin_error)?
            .filter(|plugin| plugin.activation == crate::PluginActivation::Enabled)
            .ok_or_else(|| preview_error("PLUGIN_DISABLED", "Preview plugin is not active"))?;
        if plugin.version != request.plugin_version {
            return Err(preview_error(
                "GENERATION_STALE",
                "Preview package version changed before launch",
            ));
        }
        let provider = plugin
            .app
            .preview_providers
            .iter()
            .find(|provider| provider.id == request.provider_id)
            .ok_or_else(|| {
                preview_error("PROVIDER_MISSING", "Preview provider is not published")
            })?;
        let process = provider.process.as_ref().ok_or_else(|| {
            preview_error(
                "PROVIDER_PROTOCOL_MISSING",
                "Preview provider has no external process protocol",
            )
        })?;
        if !provider
            .media_types
            .iter()
            .any(|media_type| media_type == &request.media_type)
        {
            return Err(preview_error(
                "MEDIA_TYPE_DENIED",
                "Preview media type is outside the provider declaration",
            ));
        }
        let runtime_id = provider.runtime.as_deref().ok_or_else(|| {
            preview_error(
                "RUNTIME_MISSING",
                "External preview provider must declare a Runtime",
            )
        })?;
        let runtime = self
            .plugins
            .runtime_for_package(&request.plugin_id, &request.package_digest, runtime_id)
            .await
            .map_err(plugin_error)?
            .ok_or_else(|| preview_error("RUNTIME_NOT_READY", "Preview Runtime is not locked"))?;
        let artifact = canonical_artifact(&request.file_path).await?;
        let watch_key = (
            request.plugin_id.clone(),
            request.provider_id.clone(),
            request.generation,
            request.package_digest.clone(),
            artifact.clone(),
        );
        let mut state = self.state.lock().await;
        if let Some(watch) = state.watches.get_mut(&watch_key) {
            if watch
                .child
                .try_wait()
                .map_err(|error| preview_error("PROCESS_FAILED", error.to_string()))?
                .is_none()
            {
                watch.references = watch.references.saturating_add(1);
                let port = watch.port;
                let session = register_lease(&mut state, watch_key, port);
                drop(state);
                schedule_expiry(self.state.clone(), session.lease_id.clone());
                return Ok(session);
            }
            state.watches.remove(&watch_key);
        }
        let active_for_provider = state
            .watches
            .keys()
            .filter(|(plugin_id, provider_id, _, _, _)| {
                plugin_id == &request.plugin_id && provider_id == &request.provider_id
            })
            .count();
        if active_for_provider >= provider.max_concurrent_previews as usize {
            return Err(preview_error(
                "PREVIEW_LIMIT_REACHED",
                "Preview provider reached its declared concurrency limit",
            ));
        }
        let port = allocate_loopback_port()?;
        let arguments = render_arguments(&process.argv, &artifact, port)?;
        let mut command = Command::new(&runtime.executable_path);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(parent) = artifact.parent() {
            command.current_dir(parent);
        }
        for (key, value) in &process.environment {
            if !valid_environment_entry(key, value) {
                return Err(preview_error(
                    "PROVIDER_PROTOCOL_INVALID",
                    "Preview provider environment declaration is invalid",
                ));
            }
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| preview_error("PROCESS_FAILED", error.to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            preview_error("PROCESS_FAILED", "Preview process stdout is unavailable")
        })?;
        let ready_timeout = Duration::from_secs(process.ready_timeout_seconds.clamp(1, 60));
        let announced = wait_for_announcement(stdout, port, ready_timeout).await;
        if let Err(error) = announced {
            let _ = child.kill().await;
            return Err(error);
        }
        if let Err(error) = wait_for_tcp(port, ready_timeout).await {
            let _ = child.kill().await;
            return Err(error);
        }
        state.watches.insert(
            watch_key.clone(),
            PreviewWatch {
                child,
                port,
                references: 1,
            },
        );
        let session = register_lease(&mut state, watch_key, port);
        drop(state);
        schedule_expiry(self.state.clone(), session.lease_id.clone());
        Ok(session)
    }

    async fn close_preview(
        &self,
        file_path: &str,
        lease_id: Option<&str>,
    ) -> Result<(), PluginPreviewHostError> {
        let mut state = self.state.lock().await;
        let lease_id = if let Some(lease_id) = lease_id {
            lease_id.to_owned()
        } else {
            let artifact = canonical_artifact(file_path).await?;
            state
                .leases
                .iter()
                .find_map(|(lease_id, lease)| (lease.watch.4 == artifact).then(|| lease_id.clone()))
                .unwrap_or_default()
        };
        let Some(lease) = state.leases.remove(&lease_id) else {
            return Ok(());
        };
        let mut remove_watch = false;
        if let Some(watch) = state.watches.get_mut(&lease.watch) {
            watch.references = watch.references.saturating_sub(1);
            remove_watch = watch.references == 0;
        }
        if remove_watch && let Some(mut watch) = state.watches.remove(&lease.watch) {
            let _ = watch.child.kill().await;
            let _ = watch.child.wait().await;
        }
        Ok(())
    }
}

fn register_lease(state: &mut PreviewState, watch: WatchKey, port: u16) -> PluginPreviewSession {
    let lease_id = Uuid::new_v4().to_string();
    state.leases.insert(
        lease_id.clone(),
        PreviewLease {
            watch: watch.clone(),
            expires_at: Instant::now() + PREVIEW_LEASE_TTL,
        },
    );
    PluginPreviewSession {
        lease_id,
        loopback_port: port,
        capability_token: Uuid::new_v4().simple().to_string(),
        expires_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .saturating_add(PREVIEW_LEASE_TTL.as_millis()) as u64,
    }
}

fn schedule_expiry(state: Arc<Mutex<PreviewState>>, lease_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(PREVIEW_LEASE_TTL).await;
        let mut state = state.lock().await;
        let Some(lease) = state
            .leases
            .remove(&lease_id)
            .filter(|lease| lease.expires_at <= Instant::now())
        else {
            return;
        };
        let mut remove_watch = false;
        if let Some(watch) = state.watches.get_mut(&lease.watch) {
            watch.references = watch.references.saturating_sub(1);
            remove_watch = watch.references == 0;
        }
        if remove_watch && let Some(mut watch) = state.watches.remove(&lease.watch) {
            let _ = watch.child.kill().await;
            let _ = watch.child.wait().await;
        }
    });
}

async fn canonical_artifact(file_path: &str) -> Result<PathBuf, PluginPreviewHostError> {
    let path = Path::new(file_path);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(preview_error(
            "PATH_OUTSIDE_SCOPE",
            "Preview artifact path is outside the Host-issued file scope",
        ));
    }
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| preview_error("ARTIFACT_MISSING", error.to_string()))?;
    if !canonical.is_file() {
        return Err(preview_error(
            "ARTIFACT_MISSING",
            "Preview artifact is not a regular file",
        ));
    }
    Ok(canonical)
}

fn render_arguments(
    templates: &[String],
    artifact: &Path,
    port: u16,
) -> Result<Vec<String>, PluginPreviewHostError> {
    let artifact = artifact
        .to_str()
        .ok_or_else(|| preview_error("PATH_ENCODING_INVALID", "Artifact path is not UTF-8"))?;
    let mut saw_artifact = false;
    let mut saw_port = false;
    let mut arguments = Vec::with_capacity(templates.len());
    for template in templates {
        if template.contains('{')
            && !template.contains("{artifact}")
            && !template.contains("{port}")
        {
            return Err(preview_error(
                "PROVIDER_PROTOCOL_INVALID",
                "Preview argv contains an unknown placeholder",
            ));
        }
        saw_artifact |= template.contains("{artifact}");
        saw_port |= template.contains("{port}");
        arguments.push(
            template
                .replace("{artifact}", artifact)
                .replace("{port}", &port.to_string()),
        );
    }
    if !saw_artifact || !saw_port {
        return Err(preview_error(
            "PROVIDER_PROTOCOL_INVALID",
            "Preview argv must bind both artifact and Host-allocated port",
        ));
    }
    Ok(arguments)
}

fn valid_environment_entry(key: &str, value: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && value.len() <= 4096
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn allocate_loopback_port() -> Result<u16, PluginPreviewHostError> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| preview_error("PORT_UNAVAILABLE", error.to_string()))
}

async fn wait_for_announcement(
    stdout: tokio::process::ChildStdout,
    expected_port: u16,
    duration: Duration,
) -> Result<(), PluginPreviewHostError> {
    timeout(duration, async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| preview_error("PROCESS_FAILED", error.to_string()))?
        {
            if announced_loopback_port(&line) == Some(expected_port) {
                tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
                return Ok(());
            }
        }
        Err(preview_error(
            "PROCESS_FAILED",
            "Preview process exited before readiness",
        ))
    })
    .await
    .map_err(|_| preview_error("PORT_TIMEOUT", "Preview readiness announcement timed out"))?
}

fn announced_loopback_port(line: &str) -> Option<u16> {
    for marker in ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"] {
        if let Some(value) = line.split_once(marker).map(|(_, value)| value) {
            return value
                .split(|character: char| !character.is_ascii_digit())
                .next()?
                .parse()
                .ok();
        }
    }
    None
}

async fn wait_for_tcp(port: u16, duration: Duration) -> Result<(), PluginPreviewHostError> {
    let deadline = Instant::now() + duration;
    loop {
        if timeout(
            Duration::from_millis(250),
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .is_ok_and(|result| result.is_ok())
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(preview_error(
                "PORT_TIMEOUT",
                "Preview process did not bind its Host-allocated loopback port",
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn plugin_error(error: crate::PluginError) -> PluginPreviewHostError {
    preview_error("PLUGIN_REGISTRY_FAILED", error.to_string())
}

fn preview_error(code: &'static str, message: impl Into<String>) -> PluginPreviewHostError {
    PluginPreviewHostError::new(code, message)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{announced_loopback_port, render_arguments, valid_environment_entry};

    #[test]
    fn process_protocol_expands_only_host_owned_values() {
        let args = render_arguments(
            &[
                "watch".to_owned(),
                "{artifact}".to_owned(),
                "--port={port}".to_owned(),
            ],
            Path::new("/tmp/report.docx"),
            43100,
        )
        .unwrap();
        assert_eq!(args, ["watch", "/tmp/report.docx", "--port=43100"]);
        assert!(render_arguments(&["{unknown}".to_owned()], Path::new("/tmp/a"), 1).is_err());
    }

    #[test]
    fn readiness_accepts_loopback_only() {
        assert_eq!(
            announced_loopback_port("ready http://127.0.0.1:43100/"),
            Some(43100)
        );
        assert_eq!(announced_loopback_port("ready http://0.0.0.0:43100/"), None);
        assert!(valid_environment_entry("OFFICECLI_SKIP_UPDATE", "1"));
        assert!(!valid_environment_entry("LD_PRELOAD-", "x"));
    }
}
