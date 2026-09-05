#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
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
#[cfg(target_os = "linux")]
use crate::isolated::{
    apply_linux_seccomp, build_seccomp_filter, isolated_linux_syscalls, isolated_runtime_kind,
    linux_seccomp_file,
};

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

struct IsolatedLaunch {
    command: Command,
    _retain: Option<std::fs::File>,
}

/// The spawned child plus the streams the protocol loop talks over.
type HostedTransport = (
    HostedChild,
    Box<dyn AsyncWrite + Unpin + Send>,
    Box<dyn AsyncRead + Unpin + Send>,
    Option<tokio::process::ChildStderr>,
);

enum HostedChild {
    // Boxed so the variants stay close in size: a tokio Child is an order of
    // magnitude larger than the AppContainer handle.
    Command(Box<Child>),
    #[cfg(windows)]
    AppContainer(crate::isolated::WindowsAppContainerProcess),
}

impl HostedChild {
    async fn kill(&mut self) -> std::io::Result<()> {
        match self {
            Self::Command(child) => child.kill().await,
            #[cfg(windows)]
            Self::AppContainer(child) => child.kill().await,
        }
    }

    async fn wait(&mut self) -> std::io::Result<()> {
        match self {
            Self::Command(child) => child.wait().await.map(|_| ()),
            #[cfg(windows)]
            Self::AppContainer(child) => child.wait().await,
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
        if package.package_class == "isolated" && !isolated_spawn_supported() {
            return Err(WorkerHostError::new(
                "plugin_class_unsupported",
                "Isolated packages cannot spawn until the sandboxed Worker host is published",
            ));
        }
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
        let (child, stdin, stdout, stderr) = spawn_hosted_worker(
            &program,
            &package_root,
            &entrypoint,
            runtime,
            package.package_class == "isolated",
            grants,
        )?;
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
            self.request_timeout,
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

pub fn record_plugin_crash(plugin_id: &str, message: impl Into<String>) {
    let mut crashes = PLUGIN_CRASHES.lock().unwrap();
    crashes.push(serde_json::json!({
        "pluginId": plugin_id,
        "message": message.into(),
        "atUnixMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    }));
    let overflow = crashes.len().saturating_sub(50);
    if overflow > 0 {
        crashes.drain(0..overflow);
    }
}

pub fn recent_plugin_crashes(plugin_id: &str) -> Vec<serde_json::Value> {
    PLUGIN_CRASHES
        .lock()
        .unwrap()
        .iter()
        .filter(|crash| crash.get("pluginId").and_then(|value| value.as_str()) == Some(plugin_id))
        .cloned()
        .collect()
}

static PLUGIN_CRASHES: std::sync::Mutex<Vec<serde_json::Value>> = std::sync::Mutex::new(Vec::new());

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

pub fn isolated_spawn_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        Path::new("/usr/bin/sandbox-exec").is_file()
    }
    #[cfg(target_os = "linux")]
    {
        Path::new("/usr/bin/bwrap").is_file() || linux_landlock_available()
    }
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        false
    }
}

fn isolated_unsupported() -> WorkerHostError {
    WorkerHostError::new(
        "plugin_class_unsupported",
        "Isolated spawn is not available on this host",
    )
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

fn spawn_hosted_worker(
    program: &Path,
    package_root: &Path,
    entrypoint: &Path,
    runtime: &str,
    isolated: bool,
    grants: &[CapabilityGrant],
) -> Result<HostedTransport, WorkerHostError> {
    #[cfg(windows)]
    if isolated {
        let launched = crate::isolated::spawn_windows_appcontainer(
            program,
            package_root,
            entrypoint,
            grants,
            package_root,
        )?;
        return Ok((
            HostedChild::AppContainer(launched.process),
            Box::new(tokio::fs::File::from_std(launched.stdin)),
            Box::new(tokio::fs::File::from_std(launched.stdout)),
            None,
        ));
    }
    #[cfg(not(windows))]
    let _ = grants;

    let mut launch = if isolated {
        isolated_launch(program, package_root, entrypoint)?
    } else if runtime == "native" {
        IsolatedLaunch {
            command: Command::new(program),
            _retain: None,
        }
    } else if runtime == "python" {
        let mut command = Command::new(program);
        command.arg(entrypoint);
        IsolatedLaunch {
            command,
            _retain: None,
        }
    } else {
        let mut command = Command::new(program);
        command.arg("--max-old-space-size=128").arg(entrypoint);
        IsolatedLaunch {
            command,
            _retain: None,
        }
    };
    launch
        .command
        .current_dir(package_root)
        .env("NO_COLOR", "1")
        .env(
            "VIBEX_PACKAGE_CLASS",
            if isolated { "isolated" } else { "full-trust" },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = launch
        .command
        .spawn()
        .map_err(|error| WorkerHostError::new("worker_spawn_failed", error.to_string()))?;
    drop(launch);
    if isolated {
        confine_isolated_child(&child)?;
    }
    let stdin = child.stdin.take().ok_or_else(|| {
        WorkerHostError::new("worker_transport_failed", "Worker stdin is unavailable")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        WorkerHostError::new("worker_transport_failed", "Worker stdout is unavailable")
    })?;
    let stderr = child.stderr.take();
    Ok((
        HostedChild::Command(Box::new(child)),
        Box::new(stdin),
        Box::new(stdout),
        stderr,
    ))
}

fn isolated_launch(
    node_executable: &Path,
    package_root: &Path,
    entrypoint: &Path,
) -> Result<IsolatedLaunch, WorkerHostError> {
    #[cfg(target_os = "macos")]
    {
        if isolated_spawn_supported() {
            return Ok(IsolatedLaunch {
                command: macos_isolated_command(node_executable, package_root, entrypoint)?,
                _retain: None,
            });
        }
    }
    #[cfg(target_os = "linux")]
    {
        if Path::new("/usr/bin/bwrap").is_file() {
            return linux_isolated_command(node_executable, package_root, entrypoint);
        }
        if linux_landlock_available() {
            return linux_landlock_command(node_executable, package_root, entrypoint);
        }
    }
    let _ = (node_executable, package_root, entrypoint);
    Err(isolated_unsupported())
}

#[cfg_attr(not(test), allow(dead_code))]
fn isolated_command(
    node_executable: &Path,
    package_root: &Path,
    entrypoint: &Path,
) -> Result<Command, WorkerHostError> {
    isolated_launch(node_executable, package_root, entrypoint).map(|launch| launch.command)
}

fn confine_isolated_child(child: &tokio::process::Child) -> Result<(), WorkerHostError> {
    #[cfg(windows)]
    {
        assign_windows_job(child)
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        Ok(())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn isolated_plugin_name(package_root: &Path) -> &str {
    package_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plugin")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn isolated_plugin_data(package_root: &Path) -> PathBuf {
    std::env::temp_dir()
        .join("vibex-isolated-data")
        .join(isolated_plugin_name(package_root))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn runtime_lock_root(runtime_bin: &Path) -> PathBuf {
    match runtime_bin.parent() {
        Some(bin_dir) if bin_dir.file_name().is_some_and(|name| name == "bin") => {
            bin_dir.parent().unwrap_or(bin_dir).to_path_buf()
        }
        Some(parent) => parent.to_path_buf(),
        None => runtime_bin.to_path_buf(),
    }
}

#[cfg(target_os = "macos")]
fn seatbelt_quote(path: &Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn macos_isolated_command(
    runtime_bin: &Path,
    package_root: &Path,
    worker_path: &Path,
) -> Result<Command, WorkerHostError> {
    let runtime_lock = runtime_lock_root(runtime_bin);
    let plugin_tmp = std::env::temp_dir();
    let plugin_data = isolated_plugin_data(package_root);
    std::fs::create_dir_all(&plugin_data)
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    let profile = format!(
        "(version 1)\n\
         (deny default)\n\
         (deny network*)\n\
         (allow process-exec (literal \"{runtime}\") (literal \"{worker}\"))\n\
         (allow process-fork)\n\
         (allow signal (target same-sandbox))\n\
         (allow file-read* (subpath \"{package}\") (subpath \"{runtime_lock}\") (subpath \"/usr/lib\") (subpath \"/System/Library\"))\n\
         (allow file-write* (subpath \"{plugin_data}\") (subpath \"{plugin_tmp}\"))\n\
         (allow sysctl-read)\n",
        runtime = seatbelt_quote(runtime_bin),
        worker = seatbelt_quote(worker_path),
        package = seatbelt_quote(package_root),
        runtime_lock = seatbelt_quote(&runtime_lock),
        plugin_data = seatbelt_quote(&plugin_data),
        plugin_tmp = seatbelt_quote(&plugin_tmp),
    );
    let profile_path = plugin_tmp.join(format!(
        "vibex-isolated-{}.sb",
        isolated_plugin_name(package_root)
    ));
    std::fs::write(&profile_path, profile)
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    let mut command = Command::new("sandbox-exec");
    command.arg("-f").arg(profile_path).arg(runtime_bin);
    if worker_path
        .extension()
        .and_then(|extension| extension.to_str())
        == Some("py")
    {
        command.arg(worker_path);
    } else if runtime_bin.file_name().and_then(|name| name.to_str())
        != worker_path.file_name().and_then(|name| name.to_str())
    {
        command.arg("--max-old-space-size=128").arg(worker_path);
    }
    Ok(command)
}

#[cfg(target_os = "linux")]
fn linux_isolated_command(
    runtime_bin: &Path,
    package_root: &Path,
    worker_path: &Path,
) -> Result<IsolatedLaunch, WorkerHostError> {
    use std::os::unix::io::AsRawFd;

    let plugin_tmp = std::env::temp_dir();
    let plugin_data = isolated_plugin_data(package_root);
    std::fs::create_dir_all(&plugin_data)
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    let kind = isolated_runtime_kind(runtime_bin, worker_path);
    let seccomp = linux_seccomp_file(kind, false)?;
    let seccomp_fd = seccomp.as_raw_fd();
    let mut command = Command::new("/usr/bin/bwrap");
    command
        .arg("--die-with-parent")
        .arg("--unshare-net")
        .arg("--seccomp")
        .arg(seccomp_fd.to_string())
        .arg("--proc")
        .arg("/proc")
        .arg("--dev")
        .arg("/dev");
    for dir in ["/usr/lib", "/lib", "/lib64", "/usr/lib64"] {
        if Path::new(dir).exists() {
            command.arg("--ro-bind").arg(dir).arg(dir);
        }
    }
    command.arg("--ro-bind").arg(package_root).arg(package_root);
    linux_bind_runtime(&mut command, runtime_bin);
    command
        .arg("--bind")
        .arg(&plugin_tmp)
        .arg(&plugin_tmp)
        .arg("--bind")
        .arg(&plugin_data)
        .arg(&plugin_data)
        .arg("--chdir")
        .arg(package_root)
        .arg(runtime_bin);
    append_isolated_runtime_args(&mut command, runtime_bin, worker_path);
    Ok(IsolatedLaunch {
        command,
        _retain: Some(seccomp),
    })
}

#[cfg(target_os = "linux")]
fn append_isolated_runtime_args(command: &mut Command, runtime_bin: &Path, worker_path: &Path) {
    if worker_path.extension().and_then(|ext| ext.to_str()) == Some("py") {
        command.arg(worker_path);
    } else if runtime_bin.file_name() != worker_path.file_name() {
        command.arg("--max-old-space-size=128").arg(worker_path);
    }
}

#[cfg(target_os = "linux")]
fn linux_bind_runtime(command: &mut Command, runtime_bin: &Path) {
    let parent = runtime_bin.parent();
    if parent.is_some_and(|dir| {
        dir == Path::new("/usr/bin")
            || dir == Path::new("/bin")
            || dir == Path::new("/usr/local/bin")
    }) {
        command.arg("--ro-bind").arg(runtime_bin).arg(runtime_bin);
        return;
    }
    let runtime_lock = runtime_lock_root(runtime_bin);
    command
        .arg("--ro-bind")
        .arg(&runtime_lock)
        .arg(&runtime_lock);
}

#[cfg(target_os = "linux")]
fn linux_landlock_available() -> bool {
    apply_linux_landlock(Path::new("/"), Path::new("/"), &std::env::temp_dir(), true).is_ok()
}

#[cfg(target_os = "linux")]
fn linux_landlock_command(
    runtime_bin: &Path,
    package_root: &Path,
    worker_path: &Path,
) -> Result<IsolatedLaunch, WorkerHostError> {
    let plugin_data = isolated_plugin_data(package_root);
    std::fs::create_dir_all(&plugin_data)
        .map_err(|error| WorkerHostError::new("isolated_profile_failed", error.to_string()))?;
    let mut command = Command::new(runtime_bin);
    append_isolated_runtime_args(&mut command, runtime_bin, worker_path);
    let package_root = package_root.to_path_buf();
    let runtime_lock = runtime_lock_root(runtime_bin);
    let plugin_tmp = std::env::temp_dir();
    let kind = isolated_runtime_kind(runtime_bin, worker_path);
    let filters = build_seccomp_filter(&isolated_linux_syscalls(kind, false))?;
    unsafe {
        command.pre_exec(move || {
            apply_linux_landlock(&package_root, &runtime_lock, &plugin_tmp, false)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            apply_linux_seccomp(&filters).map_err(|error| std::io::Error::other(error.to_string()))
        });
    }
    Ok(IsolatedLaunch {
        command,
        _retain: None,
    })
}

#[cfg(target_os = "linux")]
fn apply_linux_landlock(
    package_root: &Path,
    runtime_lock: &Path,
    tmp: &Path,
    probe_only: bool,
) -> Result<(), WorkerHostError> {
    const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
    const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;
    const LANDLOCK_ACCESS_FS_READ: u64 = 1 << 2 | 1 << 3 | 1 << 4 | 1 << 5 | 1 << 6 | 1 << 10;
    const LANDLOCK_ACCESS_FS_WRITE: u64 = 1 << 1 | 1 << 7 | 1 << 8 | 1 << 9;
    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
    }
    #[repr(C)]
    struct PathBeneath {
        allowed_access: u64,
        parent_fd: i32,
    }
    let attr = RulesetAttr {
        handled_access_fs: LANDLOCK_ACCESS_FS_READ | LANDLOCK_ACCESS_FS_WRITE,
        handled_access_net: 1 << 0 | 1 << 1,
    };
    let ruleset = unsafe {
        libc::syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0,
        )
    };
    if ruleset < 0 {
        return Err(WorkerHostError::new(
            "plugin_class_unsupported",
            "Landlock is not available on this kernel",
        ));
    }
    if probe_only {
        unsafe { libc::close(ruleset as i32) };
        return Ok(());
    }
    let _ = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    for (path, access) in [
        (package_root, LANDLOCK_ACCESS_FS_READ),
        (runtime_lock, LANDLOCK_ACCESS_FS_READ),
        (Path::new("/usr/lib"), LANDLOCK_ACCESS_FS_READ),
        (Path::new("/lib"), LANDLOCK_ACCESS_FS_READ),
        (tmp, LANDLOCK_ACCESS_FS_READ | LANDLOCK_ACCESS_FS_WRITE),
    ] {
        if !path.exists() {
            continue;
        }
        let Ok(c_path) = std::ffi::CString::new(path.to_string_lossy().as_bytes()) else {
            continue;
        };
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            continue;
        }
        let beneath = PathBeneath {
            allowed_access: access,
            parent_fd: fd,
        };
        unsafe {
            libc::syscall(
                SYS_LANDLOCK_ADD_RULE,
                ruleset,
                1,
                &beneath as *const PathBeneath,
                0,
            );
            libc::close(fd);
        }
    }
    let restricted = unsafe { libc::syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0) };
    unsafe { libc::close(ruleset as i32) };
    if restricted < 0 {
        return Err(WorkerHostError::new(
            "plugin_class_unsupported",
            "Landlock restrict failed",
        ));
    }
    Ok(())
}

// Not yet reachable: `isolated_launch` has macOS and Linux branches but no
// Windows one, so isolated packages still report `plugin_class_unsupported`
// there even though this AppContainer launcher exists. Wiring it up is a
// product decision about when Windows isolation is considered publishable.
#[cfg(windows)]
#[allow(dead_code)]
fn windows_isolated_command(
    runtime_bin: &Path,
    worker_path: &Path,
) -> Result<Command, WorkerHostError> {
    let mut command = Command::new(runtime_bin);
    if worker_path.extension().and_then(|ext| ext.to_str()) == Some("py") {
        command.arg(worker_path);
    } else if runtime_bin.file_name() != worker_path.file_name() {
        command.arg("--max-old-space-size=128").arg(worker_path);
    }
    Ok(command)
}

#[cfg(windows)]
fn assign_windows_job(child: &tokio::process::Child) -> Result<(), WorkerHostError> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_JOB_MEMORY,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectExtendedLimitInformation, SetInformationJobObject,
            },
            Threading::OpenProcess,
        },
    };
    let Some(pid) = child.id() else {
        return Ok(());
    };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(WorkerHostError::new(
                "plugin_class_unsupported",
                "CreateJobObjectW failed",
            ));
        }
        let mut info = std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.JobMemoryLimit = 256 * 1024 * 1024;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err(WorkerHostError::new(
                "plugin_class_unsupported",
                "SetInformationJobObject failed",
            ));
        }
        let process = OpenProcess(0x1F0FFF, 0, pid);
        if process.is_null() || AssignProcessToJobObject(job, process) == 0 {
            if !process.is_null() {
                CloseHandle(process);
            }
            CloseHandle(job);
            return Err(WorkerHostError::new(
                "plugin_class_unsupported",
                "AssignProcessToJobObject failed",
            ));
        }
        CloseHandle(process);
        // The job handle is deliberately left open: closing it would tear the
        // job down and release the child. It is a raw Copy handle with no Drop,
        // so simply not closing it is what keeps the job alive -- the previous
        // `mem::forget` here was a no-op that only looked load-bearing.
    }
    Ok(())
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
    // Containment is checked against the canonical form, but the result is
    // handed to the runtime as a module specifier. `canonicalize` yields a
    // `\\?\` verbatim path on Windows, which Node cannot resolve: it exits
    // non-zero without writing to stdout, surfacing as "Worker closed stdout".
    Ok(utils::path::normalize_windows_extended_path_prefix(path))
}

#[cfg(test)]
mod isolated_spawn_tests {
    use super::*;

    #[test]
    fn isolated_spawn_supported_is_true_on_macos_when_sandbox_exec_exists() {
        let sandbox_exec = Path::new("/usr/bin/sandbox-exec").is_file();
        #[cfg(target_os = "macos")]
        {
            assert_eq!(isolated_spawn_supported(), sandbox_exec);
            assert!(
                isolated_spawn_supported(),
                "macOS Isolated spawn requires /usr/bin/sandbox-exec"
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = sandbox_exec;
        }
    }

    #[test]
    fn isolated_command_fails_with_plugin_class_unsupported_on_unsupported_os() {
        assert_eq!(isolated_unsupported().code(), "plugin_class_unsupported");
        if isolated_spawn_supported() {
            return;
        }
        let error = isolated_command(
            Path::new("node"),
            Path::new("/tmp"),
            Path::new("/tmp/worker.mjs"),
        )
        .expect_err("unsupported hosts must not wrap Isolated spawn");
        assert_eq!(error.code(), "plugin_class_unsupported");
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
