use std::{
    collections::{BTreeSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines},
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};

use crate::PluginPackage;

const MAX_PROTOCOL_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrant {
    pub capability: String,
    pub scope: Value,
    #[serde(default = "default_grant_trust_tier")]
    pub trust_tier: String,
}

fn default_grant_trust_tier() -> String {
    "sandboxed_worker".to_owned()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerActivation {
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_digest: String,
    pub generation: u64,
    pub handlers: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct WorkerHostError {
    code: &'static str,
    message: String,
}

impl WorkerHostError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn external(code: &'static str, message: impl std::fmt::Display) -> Self {
        Self::new(code, message.to_string())
    }

    pub fn broker(code: &'static str, message: impl std::fmt::Display) -> Self {
        Self::new(code, message.to_string())
    }
}

#[async_trait]
pub trait CapabilityBroker: Send + Sync {
    /// Static provider availability for activation compatibility. A required
    /// permission cannot become active merely because its name is recognized
    /// by the manifest schema.
    fn supports(&self, _capability: &str) -> bool {
        false
    }

    async fn call(
        &self,
        plugin_id: &str,
        generation: u64,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, WorkerHostError>;
}

/// Safe default for activation-only hosts. Capabilities remain unavailable
/// until the application supplies a broker backed by explicit grants.
pub struct DenyCapabilityBroker;

#[async_trait]
impl CapabilityBroker for DenyCapabilityBroker {
    async fn call(
        &self,
        _plugin_id: &str,
        _generation: u64,
        capability: &str,
        _operation: &str,
        _input: Value,
    ) -> Result<Value, WorkerHostError> {
        Err(WorkerHostError::new(
            "capability_denied",
            format!("{capability} has no configured host broker"),
        ))
    }
}

/// Keeps Host RPC calls tied to one activation generation.
///
/// Product plugins are full-trust packages. Capability declarations remain
/// useful documentation for SDK tooling, but they are not an authorization
/// boundary once the package is installed.
pub struct ScopedCapabilityBroker {
    plugin_id: String,
    generation: u64,
    inner: Arc<dyn CapabilityBroker>,
}

impl ScopedCapabilityBroker {
    pub fn new(
        package: &PluginPackage,
        generation: u64,
        _grants: &[CapabilityGrant],
        inner: Arc<dyn CapabilityBroker>,
    ) -> Result<Self, WorkerHostError> {
        Ok(Self {
            plugin_id: package.id.as_str().to_owned(),
            generation,
            inner,
        })
    }

    async fn call(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, WorkerHostError> {
        self.inner
            .call(
                &self.plugin_id,
                self.generation,
                capability,
                operation,
                input,
            )
            .await
    }
}

pub struct WorkerHost {
    activation: WorkerActivation,
    broker: Arc<ScopedCapabilityBroker>,
    process: Mutex<WorkerProcess>,
    request_timeout: Duration,
}

enum HostedChild {
    Command(Child),
}

impl HostedChild {
    async fn kill(&mut self) -> std::io::Result<()> {
        match self {
            Self::Command(child) => child.kill().await,
        }
    }

    async fn wait(&mut self) -> std::io::Result<()> {
        match self {
            Self::Command(child) => child.wait().await.map(|_| ()),
        }
    }
}

struct WorkerProcess {
    child: HostedChild,
    stdin: Box<dyn AsyncWrite + Unpin + Send>,
    stdout: Lines<BufReader<Box<dyn AsyncRead + Unpin + Send>>>,
    sequence: u64,
    terminal_error: Option<String>,
}

impl WorkerHost {
    pub async fn spawn(
        node_executable: &Path,
        package: &PluginPackage,
        generation: u64,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<Self, WorkerHostError> {
        Self::spawn_with_request_timeout(
            node_executable,
            package,
            generation,
            grants,
            broker,
            Duration::from_secs(30),
        )
        .await
    }

    #[doc(hidden)]
    pub async fn spawn_with_request_timeout(
        node_executable: &Path,
        package: &PluginPackage,
        generation: u64,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
        request_timeout: Duration,
    ) -> Result<Self, WorkerHostError> {
        let node_executable = resolve_executable(node_executable)?;
        let package_root = package.content_root().canonicalize().map_err(|error| {
            WorkerHostError::new(
                "worker_package_missing",
                format!("cannot canonicalize package root: {error}"),
            )
        })?;
        let entrypoint = package.entrypoints.worker.as_ref().ok_or_else(|| {
            WorkerHostError::new(
                "worker_entrypoint_missing",
                "package has no Worker entrypoint",
            )
        })?;
        let entrypoint = confined_path(&package_root, entrypoint)?;
        let runtime = package
            .entrypoints
            .worker_runtime
            .as_deref()
            .unwrap_or("node");
        let program = match runtime {
            "native" => entrypoint.clone(),
            "python" => resolve_python_executable(&node_executable).await?,
            _ => node_executable.clone(),
        };
        let plugin_id = package.id.as_str().to_owned();
        let (child, stdin, stdout, stderr) =
            spawn_hosted_worker(&program, &package_root, &entrypoint, runtime)?;
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    record_plugin_log(&plugin_id, "stderr", line);
                }
            });
        }
        let scoped_broker = Arc::new(ScopedCapabilityBroker::new(
            package, generation, grants, broker,
        )?);
        let mut process = WorkerProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            sequence: 0,
            terminal_error: None,
        };
        let granted_capabilities = vec!["*".to_owned()];
        let initialized = exchange(
            &mut process,
            &scoped_broker,
            "initialize",
            json!({
                "protocolRange": ["1.1"],
                "hostVersion": env!("CARGO_PKG_VERSION"),
                "pluginIdentity": {
                    "publisher": package.publisher.clone().unwrap_or_default(),
                    "id": package.id.as_str(),
                },
                "packageVersion": package.version,
                "packageDigest": crate::package_content_digest(&package_root)
                    .unwrap_or_default(),
                "generationId": generation,
                "declaredContributions": [],
                "packageClass": package.package_class,
                "features": [],
                "limits": { "maxFrameBytes": MAX_PROTOCOL_FRAME_BYTES, "requestTimeoutMs": 30000 },
                "runtime": {
                    "id": package.entrypoints.worker_runtime.clone().unwrap_or_else(|| "node".into()),
                    "version": "22.22.3",
                    "target": std::env::consts::ARCH,
                    "digest": "sha256:host",
                }
            }),
            Duration::from_secs(10),
        )
        .await?;
        if initialized.get("protocolVersion").and_then(Value::as_str) != Some("1.1") {
            return Err(WorkerHostError::new(
                "worker_protocol_unsupported",
                "Worker did not negotiate protocol 1.1",
            ));
        }
        let response = exchange(
            &mut process,
            &scoped_broker,
            "activate",
            json!({
                "pluginId": package.id.as_str(),
                "pluginVersion": package.version,
                "generation": generation,
                "packageClass": package.package_class,
                "grantedCapabilities": granted_capabilities,
            }),
            Duration::from_secs(10),
        )
        .await?;
        let handlers = response
            .get("handlers")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                WorkerHostError::new("worker_registration_invalid", "handlers are missing")
            })?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        validate_registrations(package, &handlers)?;
        let package_digest = crate::package_content_digest(&package_root)
            .map_err(|error| WorkerHostError::new("worker_package_invalid", error.to_string()))?;
        Ok(Self {
            activation: WorkerActivation {
                plugin_id: package.id.as_str().to_owned(),
                plugin_version: package.version.clone(),
                package_digest,
                generation,
                handlers,
            },
            broker: scoped_broker,
            process: Mutex::new(process),
            request_timeout,
        })
    }

    pub fn activation(&self) -> &WorkerActivation {
        &self.activation
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.invoke_with_timeout(handler, input, self.request_timeout)
            .await
    }

    pub async fn invoke_with_timeout(
        &self,
        handler: &str,
        input: Value,
        request_timeout: Duration,
    ) -> Result<Value, WorkerHostError> {
        if !self.activation.handlers.iter().any(|item| item == handler) {
            return Err(WorkerHostError::new(
                "handler_not_found",
                format!("handler {handler} is not active"),
            ));
        }
        let mut process = self.process.lock().await;
        if let Some(reason) = &process.terminal_error {
            return Err(WorkerHostError::new("worker_terminal", reason));
        }
        let result = exchange(
            &mut process,
            &self.broker,
            "invoke",
            json!({ "handler": handler, "input": input }),
            request_timeout,
        )
        .await;
        if let Err(error) = &result
            && is_fatal_exchange_error(error)
        {
            record_plugin_crash(&self.activation.plugin_id, error.to_string());
            let reason = error.to_string();
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
            process.terminal_error = Some(reason);
        }
        result
    }

    pub async fn dispose(&self, reason: &str) -> Result<(), WorkerHostError> {
        let mut process = self.process.lock().await;
        if process.terminal_error.is_some() {
            return Ok(());
        }
        let _ = exchange(
            &mut process,
            &self.broker,
            "dispose",
            json!({ "reason": reason }),
            Duration::from_secs(5),
        )
        .await;
        process
            .child
            .kill()
            .await
            .map_err(|error| WorkerHostError::new("worker_terminate_failed", error.to_string()))
    }
}

fn is_fatal_exchange_error(error: &WorkerHostError) -> bool {
    matches!(
        error.code(),
        "worker_timeout"
            | "worker_transport_failed"
            | "worker_closed"
            | "worker_frame_too_large"
            | "worker_protocol_invalid"
    )
}

/// One abnormal Worker exit, kept so the plugin detail panel can show evidence
/// after the fact instead of asking the user to reproduce it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCrash {
    pub plugin_id: String,
    pub message: String,
    pub at_unix_ms: u64,
}

pub fn subscribe_worker_crashes() -> tokio::sync::broadcast::Receiver<String> {
    worker_crash_bus().subscribe()
}

fn worker_crash_bus() -> &'static tokio::sync::broadcast::Sender<String> {
    static BUS: std::sync::OnceLock<tokio::sync::broadcast::Sender<String>> =
        std::sync::OnceLock::new();
    BUS.get_or_init(|| tokio::sync::broadcast::channel(64).0)
}

pub fn record_plugin_crash(plugin_id: &str, message: impl Into<String>) {
    let _ = worker_crash_bus().send(plugin_id.to_owned());
    let Ok(mut crashes) = PLUGIN_CRASHES.lock() else {
        return;
    };
    crashes.push(PluginCrash {
        plugin_id: plugin_id.to_owned(),
        message: message.into(),
        at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    });
    let overflow = crashes.len().saturating_sub(MAX_PLUGIN_CRASHES);
    if overflow > 0 {
        crashes.drain(0..overflow);
    }
}

pub fn recent_plugin_crashes(plugin_id: &str) -> Vec<PluginCrash> {
    let Ok(crashes) = PLUGIN_CRASHES.lock() else {
        return Vec::new();
    };
    crashes
        .iter()
        .filter(|crash| crash.plugin_id == plugin_id)
        .cloned()
        .collect()
}

const MAX_PLUGIN_CRASHES: usize = 50;

static PLUGIN_CRASHES: std::sync::Mutex<Vec<PluginCrash>> = std::sync::Mutex::new(Vec::new());

const MAX_PLUGIN_LOG_LINES: usize = 2000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLogLine {
    pub seq: u64,
    pub plugin_id: String,
    pub stream: String,
    pub text: String,
    pub at_unix_ms: u64,
}

struct PluginLogBuffer {
    seq: u64,
    lines: VecDeque<PluginLogLine>,
}

static PLUGIN_LOGS: std::sync::Mutex<PluginLogBuffer> = std::sync::Mutex::new(PluginLogBuffer {
    seq: 0,
    lines: VecDeque::new(),
});

pub fn record_plugin_log(plugin_id: &str, stream: &str, text: impl Into<String>) {
    let Ok(mut logs) = PLUGIN_LOGS.lock() else {
        return;
    };
    logs.seq += 1;
    let seq = logs.seq;
    logs.lines.push_back(PluginLogLine {
        seq,
        plugin_id: plugin_id.to_owned(),
        stream: stream.to_owned(),
        text: text.into(),
        at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    });
    while logs.lines.len() > MAX_PLUGIN_LOG_LINES {
        logs.lines.pop_front();
    }
}

pub fn recent_plugin_logs(plugin_id: &str, after: u64) -> Vec<PluginLogLine> {
    let Ok(logs) = PLUGIN_LOGS.lock() else {
        return Vec::new();
    };
    logs.lines
        .iter()
        .filter(|line| line.plugin_id == plugin_id && line.seq > after)
        .cloned()
        .collect()
}

async fn resolve_python_executable(node_executable: &Path) -> Result<PathBuf, WorkerHostError> {
    let data_root = node_executable
        .ancestors()
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name == "worker-runtimes")
        })
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| {
            node_executable
                .parent()
                .unwrap_or(Path::new("."))
                .to_path_buf()
        });
    crate::PluginWorkerRuntimeProvider::new(data_root)
        .resolve_python()
        .await
        .map_err(|error| WorkerHostError::new("worker_runtime_missing", error.to_string()))
}

type SpawnedWorkerIo = (
    HostedChild,
    Box<dyn AsyncWrite + Unpin + Send>,
    Box<dyn AsyncRead + Unpin + Send>,
    Option<tokio::process::ChildStderr>,
);

fn spawn_hosted_worker(
    program: &Path,
    package_root: &Path,
    entrypoint: &Path,
    runtime: &str,
) -> Result<SpawnedWorkerIo, WorkerHostError> {
    let mut command = hosted_worker_command(program, package_root, entrypoint, runtime);
    let mut child = command
        .spawn()
        .map_err(|error| WorkerHostError::new("worker_spawn_failed", error.to_string()))?;
    let stdin = child.stdin.take().ok_or_else(|| {
        WorkerHostError::new("worker_transport_failed", "Worker stdin is unavailable")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        WorkerHostError::new("worker_transport_failed", "Worker stdout is unavailable")
    })?;
    let stderr = child.stderr.take();
    Ok((
        HostedChild::Command(child),
        Box::new(stdin),
        Box::new(stdout),
        stderr,
    ))
}

fn hosted_worker_command(
    program: &Path,
    package_root: &Path,
    entrypoint: &Path,
    runtime: &str,
) -> Command {
    let program = worker_process_path(program);
    let package_root = worker_process_path(package_root);
    let entrypoint = worker_process_path(entrypoint);
    let mut command = Command::new(&program);
    if runtime == "python" {
        command.arg(&entrypoint);
    } else if runtime != "native" {
        command.arg("--max-old-space-size=128").arg(&entrypoint);
    }
    command
        .current_dir(&package_root)
        .env("NO_COLOR", "1")
        .env("VIBEX_PACKAGE_CLASS", "full-trust")
        .env("VIBEX_HOST_DATA_DIR", utils::assets::host_data_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Confine with `canonicalize()` (verbatim `\\?\` on Windows), then convert
/// before Node/Python argv or `current_dir`. Node 22.22.3 treats
/// `\\?\C:\...worker.mjs` as `C:` and exits with EISDIR, which the Host
/// surfaces as "Worker closed stdout".
fn worker_process_path(path: &Path) -> PathBuf {
    utils::path::normalize_windows_extended_path_prefix(path)
}

fn resolve_executable(executable: &Path) -> Result<PathBuf, WorkerHostError> {
    if executable.is_absolute() {
        return executable
            .canonicalize()
            .map_err(|error| WorkerHostError::new("worker_runtime_missing", error.to_string()));
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
        .ok_or_else(|| {
            WorkerHostError::new(
                "worker_runtime_missing",
                format!("{} was not found on PATH", executable.display()),
            )
        })
}

async fn exchange(
    process: &mut WorkerProcess,
    broker: &ScopedCapabilityBroker,
    method: &str,
    params: Value,
    deadline: Duration,
) -> Result<Value, WorkerHostError> {
    process.sequence = process.sequence.saturating_add(1);
    let request_id = format!("host:{}", process.sequence);
    write_message(
        &mut process.stdin,
        &json!({ "id": request_id, "method": method, "params": params }),
    )
    .await?;
    timeout(deadline, async {
        loop {
            let line = process
                .stdout
                .next_line()
                .await
                .map_err(|error| {
                    WorkerHostError::new("worker_transport_failed", error.to_string())
                })?
                .ok_or_else(|| WorkerHostError::new("worker_closed", "Worker closed stdout"))?;
            if line.len() > MAX_PROTOCOL_FRAME_BYTES {
                return Err(WorkerHostError::new(
                    "worker_frame_too_large",
                    "Worker protocol frame exceeded the limit",
                ));
            }
            let message: Value = serde_json::from_str(&line).map_err(|error| {
                WorkerHostError::new("worker_protocol_invalid", error.to_string())
            })?;
            if message.get("method").and_then(Value::as_str) == Some("host.call") {
                dispatch_host_call(process, broker, &message).await?;
                continue;
            }
            if message.get("id").and_then(Value::as_str) != Some(&request_id) {
                return Err(WorkerHostError::new(
                    "worker_protocol_invalid",
                    "Worker response ID did not match the request",
                ));
            }
            if message.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            let code = message
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("worker_failed");
            let detail = message
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Worker request failed");
            return Err(WorkerHostError::new(
                "worker_request_failed",
                format!("{code}: {detail}"),
            ));
        }
    })
    .await
    .map_err(|_| WorkerHostError::new("worker_timeout", "Worker request timed out"))?
}

async fn dispatch_host_call(
    process: &mut WorkerProcess,
    broker: &ScopedCapabilityBroker,
    message: &Value,
) -> Result<(), WorkerHostError> {
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| WorkerHostError::new("worker_protocol_invalid", "host.call has no ID"))?;
    let capability = message
        .pointer("/params/capability")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            WorkerHostError::new("worker_protocol_invalid", "host.call has no capability")
        })?;
    let operation = message
        .pointer("/params/operation")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            WorkerHostError::new("worker_protocol_invalid", "host.call has no operation")
        })?;
    let input = message
        .pointer("/params/input")
        .cloned()
        .unwrap_or(Value::Null);
    let response = match broker.call(capability, operation, input).await {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(error) => json!({
            "id": id,
            "ok": false,
            "error": { "code": error.code(), "message": error.to_string() }
        }),
    };
    write_message(&mut process.stdin, &response).await
}

async fn write_message(
    stdin: &mut (dyn AsyncWrite + Unpin + Send),
    message: &Value,
) -> Result<(), WorkerHostError> {
    let mut data = serde_json::to_vec(message)
        .map_err(|error| WorkerHostError::new("worker_protocol_invalid", error.to_string()))?;
    if data.len() > MAX_PROTOCOL_FRAME_BYTES {
        return Err(WorkerHostError::new(
            "host_frame_too_large",
            "Host protocol frame exceeded the limit",
        ));
    }
    data.push(b'\n');
    stdin
        .write_all(&data)
        .await
        .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))
}

fn validate_registrations(
    package: &PluginPackage,
    handlers: &[String],
) -> Result<(), WorkerHostError> {
    let declared = package
        .invocations
        .iter()
        .filter_map(|invocation| invocation.handler.as_deref())
        .chain(
            package
                .app
                .preview_providers
                .iter()
                .map(|provider| provider.handler.as_str()),
        )
        .chain(package.app.surfaces.iter().flat_map(|surface| {
            std::iter::once(surface.handler.as_str())
                .chain(surface.allowed_methods.iter().map(String::as_str))
        }))
        .chain(
            package
                .app
                .remote_provisioners
                .iter()
                .map(|item| item.handler.as_str()),
        )
        .chain(
            package
                .app
                .commands
                .iter()
                .map(|item| item.handler.as_str()),
        )
        .chain(
            package
                .app
                .toolbar_items
                .iter()
                .map(|item| item.handler.as_str()),
        )
        .chain(
            package
                .app
                .status_items
                .iter()
                .map(|item| item.handler.as_str()),
        )
        .chain(
            package
                .app
                .host_services
                .iter()
                .map(|item| item.handler.as_str()),
        )
        .chain(
            package
                .app
                .provider_import_sources
                .iter()
                .map(|item| item.handler.as_str()),
        )
        .collect::<BTreeSet<_>>();
    let actual = handlers.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if let Some(undeclared) = actual.difference(&declared).next() {
        return Err(WorkerHostError::new(
            "handler_undeclared",
            format!("Worker registered undeclared handler {undeclared}"),
        ));
    }
    if let Some(missing) = declared.difference(&actual).next() {
        return Err(WorkerHostError::new(
            "handler_required_missing",
            format!("Worker did not register required handler {missing}"),
        ));
    }
    Ok(())
}

fn confined_path(root: &Path, relative: &str) -> Result<PathBuf, WorkerHostError> {
    let root = root
        .canonicalize()
        .map_err(|error| WorkerHostError::new("package_root_invalid", error.to_string()))?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| WorkerHostError::new("worker_entrypoint_missing", error.to_string()))?;
    if !path.starts_with(&root) {
        return Err(WorkerHostError::new(
            "worker_entrypoint_escape",
            "Worker entrypoint escapes package root",
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod worker_host_tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn node_worker_command_strips_windows_verbatim_entrypoint() {
        let command = hosted_worker_command(
            Path::new(r"\\?\C:\vibex\plugins\worker-runtimes\node.exe"),
            Path::new(r"\\?\C:\Users\user\AppData\Roaming\vibex\plugin"),
            Path::new(r"\\?\C:\Users\user\AppData\Roaming\vibex\plugin\dist\worker.mjs"),
            "node",
        );
        let command = command.as_std();
        assert_eq!(
            command.get_program(),
            OsStr::new(r"C:\vibex\plugins\worker-runtimes\node.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("--max-old-space-size=128"),
                OsStr::new(r"C:\Users\user\AppData\Roaming\vibex\plugin\dist\worker.mjs"),
            ]
        );
        assert_eq!(
            command.get_current_dir().map(Path::as_os_str),
            Some(OsStr::new(r"C:\Users\user\AppData\Roaming\vibex\plugin"))
        );
    }

    #[test]
    fn node_worker_command_strips_windows_unc_verbatim_entrypoint() {
        let command = hosted_worker_command(
            Path::new(r"\\?\UNC\server\share\runtimes\node.exe"),
            Path::new(r"\\?\UNC\server\share\plugin"),
            Path::new(r"\\?\UNC\server\share\plugin\dist\worker.mjs"),
            "node",
        );
        let command = command.as_std();
        assert_eq!(
            command.get_program(),
            OsStr::new(r"\\server\share\runtimes\node.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("--max-old-space-size=128"),
                OsStr::new(r"\\server\share\plugin\dist\worker.mjs"),
            ]
        );
        assert_eq!(
            command.get_current_dir().map(Path::as_os_str),
            Some(OsStr::new(r"\\server\share\plugin"))
        );
    }

    #[test]
    fn python_worker_command_strips_windows_verbatim_script_path() {
        let command = hosted_worker_command(
            Path::new(r"\\?\C:\vibex\python.exe"),
            Path::new(r"\\?\C:\vibex\plugin"),
            Path::new(r"\\?\C:\vibex\plugin\worker.py"),
            "python",
        );
        let command = command.as_std();
        assert_eq!(command.get_program(), OsStr::new(r"C:\vibex\python.exe"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new(r"C:\vibex\plugin\worker.py")]
        );
    }

    #[test]
    fn a_worker_crash_is_kept_for_the_diagnostics_panel() {
        record_plugin_crash("demo.crash", "worker exited 2");
        let crashes = recent_plugin_crashes("demo.crash");
        assert!(
            crashes
                .iter()
                .any(|crash| crash.message == "worker exited 2"),
            "{crashes:?}"
        );
        assert!(
            recent_plugin_crashes("demo.other").is_empty(),
            "crashes must not leak across plugins"
        );
    }

    #[test]
    fn plugin_logs_are_filtered_by_id_and_sequence() {
        record_plugin_log("demo.one", "stderr", "first");
        record_plugin_log("demo.two", "stderr", "other");
        record_plugin_log("demo.one", "stderr", "second");
        let first = recent_plugin_logs("demo.one", 0);
        assert!(first.iter().any(|line| line.text == "first"));
        let last_seq = first.last().map(|line| line.seq).unwrap_or(0);
        record_plugin_log("demo.one", "stderr", "third");
        let next = recent_plugin_logs("demo.one", last_seq);
        assert_eq!(next.last().map(|line| line.text.as_str()), Some("third"));
        assert!(
            recent_plugin_logs("demo.two", 0)
                .iter()
                .any(|line| line.text == "other")
        );
    }
}
