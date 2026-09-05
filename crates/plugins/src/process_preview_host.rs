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
const MIN_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_IDLE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

struct PreviewWatch {
    child: Child,
    port: u16,
    references: u32,
}

struct PreviewLease {
    watch: WatchKey,
    port: u16,
    capability_token: String,
    idle_timeout: Duration,
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
        let idle_timeout = idle_timeout_for_plugin(&plugin);
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
                let session = register_lease(&mut state, watch_key, port, idle_timeout);
                drop(state);
                schedule_expiry(self.state.clone(), session.lease_id.clone(), idle_timeout);
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
        let session = register_lease(&mut state, watch_key, port, idle_timeout);
        drop(state);
        schedule_expiry(self.state.clone(), session.lease_id.clone(), idle_timeout);
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

    async fn renew_preview(
        &self,
        lease_id: &str,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        let mut state = self.state.lock().await;
        let session = renew_lease(&mut state, lease_id)?;
        let idle_timeout = state
            .leases
            .get(lease_id)
            .map(|lease| lease.idle_timeout)
            .unwrap_or(PREVIEW_LEASE_TTL);
        drop(state);
        schedule_expiry(self.state.clone(), lease_id.to_owned(), idle_timeout);
        Ok(session)
    }
}

fn idle_timeout_for_plugin(plugin: &crate::InstalledPlugin) -> Duration {
    let live = std::fs::read_to_string(plugin.source.path.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    idle_timeout_from_config(live.as_ref().unwrap_or(&plugin.config))
}

fn idle_timeout_from_config(config: &serde_json::Value) -> Duration {
    let Some(minutes) = config.get("idleTimeoutMinutes").and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
    }) else {
        return PREVIEW_LEASE_TTL;
    };
    Duration::from_secs(minutes.saturating_mul(60)).clamp(MIN_IDLE_TIMEOUT, MAX_IDLE_TIMEOUT)
}

fn unix_expiry_ms(idle_timeout: Duration) -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .saturating_add(idle_timeout.as_millis()) as u64
}

fn register_lease(
    state: &mut PreviewState,
    watch: WatchKey,
    port: u16,
    idle_timeout: Duration,
) -> PluginPreviewSession {
    let lease_id = Uuid::new_v4().to_string();
    let capability_token = Uuid::new_v4().simple().to_string();
    state.leases.insert(
        lease_id.clone(),
        PreviewLease {
            watch,
            port,
            capability_token: capability_token.clone(),
            idle_timeout,
            expires_at: Instant::now() + idle_timeout,
        },
    );
    PluginPreviewSession {
        lease_id,
        loopback_port: port,
        capability_token,
        expires_at_unix_ms: unix_expiry_ms(idle_timeout),
    }
}

fn renew_lease(
    state: &mut PreviewState,
    lease_id: &str,
) -> Result<PluginPreviewSession, PluginPreviewHostError> {
    let lease = state
        .leases
        .get_mut(lease_id)
        .ok_or_else(|| preview_error("LEASE_EXPIRED", "Preview lease is not active"))?;
    lease.expires_at = Instant::now() + lease.idle_timeout;
    Ok(PluginPreviewSession {
        lease_id: lease_id.to_owned(),
        loopback_port: lease.port,
        capability_token: lease.capability_token.clone(),
        expires_at_unix_ms: unix_expiry_ms(lease.idle_timeout),
    })
}

fn take_expired_lease(
    state: &mut PreviewState,
    lease_id: &str,
    now: Instant,
) -> Option<PreviewLease> {
    let expired = state
        .leases
        .get(lease_id)
        .is_some_and(|lease| lease.expires_at <= now);
    if expired {
        state.leases.remove(lease_id)
    } else {
        None
    }
}

fn schedule_expiry(state: Arc<Mutex<PreviewState>>, lease_id: String, idle_timeout: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(idle_timeout).await;
        let mut state = state.lock().await;
        let Some(lease) = take_expired_lease(&mut state, &lease_id, Instant::now()) else {
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
    use std::{path::Path, time::Duration};

    use serde_json::json;
    use tokio::time::Instant;

    use super::{
        PREVIEW_LEASE_TTL, PreviewState, announced_loopback_port, idle_timeout_from_config,
        register_lease, render_arguments, renew_lease, schedule_expiry, take_expired_lease,
        valid_environment_entry,
    };

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

    #[test]
    fn idle_timeout_reads_plugin_config_and_falls_back_to_default() {
        assert_eq!(idle_timeout_from_config(&json!({})), PREVIEW_LEASE_TTL);
        assert_eq!(
            idle_timeout_from_config(&json!({ "idleTimeoutMinutes": 10 })),
            Duration::from_secs(10 * 60)
        );
        assert_eq!(
            idle_timeout_from_config(&json!({ "idleTimeoutMinutes": 0 })),
            Duration::from_secs(60)
        );
        assert_eq!(
            idle_timeout_from_config(&json!({ "idleTimeoutMinutes": 90 })),
            Duration::from_secs(60 * 60)
        );
    }

    fn test_watch() -> super::WatchKey {
        (
            "plugin".into(),
            "preview".into(),
            1,
            "digest".into(),
            Path::new("/tmp/doc.docx").to_path_buf(),
        )
    }

    #[tokio::test]
    async fn renew_extends_lease_past_the_original_idle_window() {
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(PreviewState::default()));
        let idle = Duration::from_millis(80);
        let session = {
            let mut locked = state.lock().await;
            register_lease(&mut locked, test_watch(), 43100, idle)
        };
        schedule_expiry(state.clone(), session.lease_id.clone(), idle);

        tokio::time::sleep(Duration::from_millis(40)).await;
        {
            let mut locked = state.lock().await;
            renew_lease(&mut locked, &session.lease_id).expect("renew");
        }
        schedule_expiry(state.clone(), session.lease_id.clone(), idle);

        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(
            state.lock().await.leases.contains_key(&session.lease_id),
            "continuous renew must keep the lease past the first idle window"
        );

        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !state.lock().await.leases.contains_key(&session.lease_id),
            "stopping renew recycles after the captured idle timeout"
        );
    }

    #[tokio::test]
    async fn stopping_renew_expires_at_the_captured_idle_timeout() {
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(PreviewState::default()));
        let idle = Duration::from_millis(60);
        let session = {
            let mut locked = state.lock().await;
            register_lease(&mut locked, test_watch(), 43100, idle)
        };
        schedule_expiry(state.clone(), session.lease_id.clone(), idle);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!state.lock().await.leases.contains_key(&session.lease_id));
    }

    #[test]
    fn take_expired_lease_leaves_renewed_leases_in_place() {
        let mut state = PreviewState::default();
        let session = register_lease(&mut state, test_watch(), 43100, Duration::from_secs(60));
        assert!(take_expired_lease(&mut state, &session.lease_id, Instant::now()).is_none());
        assert!(state.leases.contains_key(&session.lease_id));
        let later = Instant::now() + Duration::from_secs(61);
        assert!(take_expired_lease(&mut state, &session.lease_id, later).is_some());
        assert!(!state.leases.contains_key(&session.lease_id));
    }
}
