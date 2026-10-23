use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
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
use vibex_plugin_sdk::protocol::{
    FrameCodec, FrameDecode, FrameReassembler, MAX_LOGICAL_MESSAGE_BYTES,
};

use crate::PluginPackage;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantLimits {
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: usize,
    #[serde(default = "default_max_requests_per_minute")]
    pub max_requests_per_minute: u32,
    #[serde(default = "default_max_request_bytes")]
    pub max_request_bytes: usize,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_max_concurrency() -> usize {
    4
}

fn default_max_requests_per_minute() -> u32 {
    120
}

fn default_max_request_bytes() -> usize {
    1_048_576
}

fn default_timeout_ms() -> u64 {
    30_000
}

impl Default for GrantLimits {
    fn default() -> Self {
        Self {
            max_concurrency: default_max_concurrency(),
            max_requests_per_minute: default_max_requests_per_minute(),
            max_request_bytes: default_max_request_bytes(),
            timeout_ms: default_timeout_ms(),
        }
    }
}

impl GrantLimits {
    pub fn from_scope(scope: &Value) -> Self {
        let mut limits = Self::default();
        let source = scope.get("limits").unwrap_or(scope);
        if let Some(val) = source
            .get("maxRequestBytes")
            .or_else(|| source.get("max_request_bytes"))
            .or_else(|| scope.get("maxRequestBytes"))
            .or_else(|| scope.get("max_request_bytes"))
            .and_then(Value::as_u64)
        {
            limits.max_request_bytes = usize::try_from(val).unwrap_or(usize::MAX);
        }
        if let Some(val) = source
            .get("maxConcurrency")
            .or_else(|| source.get("max_concurrency"))
            .and_then(Value::as_u64)
        {
            limits.max_concurrency = usize::try_from(val).unwrap_or(4);
        }
        if let Some(val) = source
            .get("maxRequestsPerMinute")
            .or_else(|| source.get("max_requests_per_minute"))
            .and_then(Value::as_u64)
        {
            limits.max_requests_per_minute = u32::try_from(val).unwrap_or(120);
        }
        if let Some(val) = source
            .get("timeoutMs")
            .or_else(|| source.get("timeout_ms"))
            .and_then(Value::as_u64)
        {
            limits.timeout_ms = val;
        }
        limits
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrant {
    pub capability: String,
    pub scope: Value,
    #[serde(default = "default_grant_trust_tier")]
    pub trust_tier: String,
}

impl CapabilityGrant {
    pub fn limits(&self) -> GrantLimits {
        GrantLimits::from_scope(&self.scope)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilityGrant {
    pub capability: String,
    #[serde(default)]
    pub scope: Value,
    #[serde(default = "default_grant_trust_tier")]
    pub trust_tier: String,
    #[serde(default)]
    pub limits: GrantLimits,
}

impl HostCapabilityGrant {
    pub fn new(capability: impl Into<String>, scope: Value) -> Self {
        let limits = GrantLimits::from_scope(&scope);
        Self {
            capability: capability.into(),
            scope,
            trust_tier: default_grant_trust_tier(),
            limits,
        }
    }

    pub fn with_limits(mut self, limits: GrantLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn with_trust_tier(mut self, trust_tier: impl Into<String>) -> Self {
        self.trust_tier = trust_tier.into();
        self
    }

    pub fn effective_limits(&self) -> GrantLimits {
        if self.limits != GrantLimits::default() {
            self.limits
        } else {
            GrantLimits::from_scope(&self.scope)
        }
    }
}

impl From<CapabilityGrant> for HostCapabilityGrant {
    fn from(grant: CapabilityGrant) -> Self {
        let limits = GrantLimits::from_scope(&grant.scope);
        Self {
            capability: grant.capability,
            scope: grant.scope,
            trust_tier: grant.trust_tier,
            limits,
        }
    }
}

impl From<&CapabilityGrant> for HostCapabilityGrant {
    fn from(grant: &CapabilityGrant) -> Self {
        let limits = GrantLimits::from_scope(&grant.scope);
        Self {
            capability: grant.capability.clone(),
            scope: grant.scope.clone(),
            trust_tier: grant.trust_tier.clone(),
            limits,
        }
    }
}

impl From<HostCapabilityGrant> for CapabilityGrant {
    fn from(grant: HostCapabilityGrant) -> Self {
        Self {
            capability: grant.capability,
            scope: grant.scope,
            trust_tier: grant.trust_tier,
        }
    }
}

fn default_grant_trust_tier() -> String {
    "sandboxed_worker".to_owned()
}

pub type BrokerError = WorkerHostError;

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

    pub fn message(&self) -> &str {
        &self.message
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

enum HostedChild {
    Command(Option<Child>),
}

impl HostedChild {
    fn id(&self) -> Option<u32> {
        match self {
            Self::Command(child) => child.as_ref().and_then(Child::id),
        }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        match self {
            Self::Command(Some(child)) => child.try_wait(),
            Self::Command(None) => Ok(None),
        }
    }

    async fn kill(&mut self) -> std::io::Result<()> {
        match self {
            Self::Command(Some(child)) => child.kill().await,
            Self::Command(None) => Ok(()),
        }
    }

    async fn wait(&mut self) -> std::io::Result<()> {
        match self {
            Self::Command(Some(child)) => child.wait().await.map(|_| ()),
            Self::Command(None) => Ok(()),
        }
    }
}

impl Drop for HostedChild {
    fn drop(&mut self) {
        match self {
            Self::Command(child_opt) => {
                if let Some(mut child) = child_opt.take() {
                    let _ = child.start_kill();
                    if matches!(child.try_wait(), Ok(None))
                        && let Ok(handle) = tokio::runtime::Handle::try_current()
                    {
                        handle.spawn(async move {
                            let _ = child.wait().await;
                        });
                    }
                }
            }
        }
    }
}

struct WorkerProcess {
    child: HostedChild,
    pid: Option<u32>,
    stdin: Box<dyn AsyncWrite + Unpin + Send>,
    stdout: Lines<BufReader<Box<dyn AsyncRead + Unpin + Send>>>,
    sequence: u64,
    terminal_error: Option<String>,
}

#[derive(Clone)]
struct MountedSlotSpec {
    plugin_id: String,
    generation: u64,
    publisher: String,
    plugin_version: String,
    package_digest: String,
    package_class: String,
    worker_runtime: String,
    entrypoint: PathBuf,
    package_root: PathBuf,
    frame_codec: FrameCodec,
    broker: Arc<ScopedCapabilityBroker>,
}

struct SharedNodeProcess {
    node_executable: PathBuf,
    child: HostedChild,
    pid: Option<u32>,
    stdin: Box<dyn AsyncWrite + Unpin + Send>,
    stdout: Lines<BufReader<Box<dyn AsyncRead + Unpin + Send>>>,
    sequence: u64,
    mounted_slots: BTreeSet<(String, u64)>,
    brokers: BTreeMap<(String, u64), Arc<ScopedCapabilityBroker>>,
    slot_specs: BTreeMap<(String, u64), MountedSlotSpec>,
}

/// Multiplexes multiple Tier-2 Node plugin workers inside a single on-demand
/// Node.js OS process. When zero plugin slots are mounted, zero OS processes
/// are running.
#[derive(Default)]
pub struct SharedNodeWorkerHost {
    inner: Mutex<Option<SharedNodeProcess>>,
    pid: std::sync::atomic::AtomicU32,
    running: std::sync::atomic::AtomicBool,
}

impl SharedNodeWorkerHost {
    pub fn new() -> Self {
        Self::default()
    }

    fn sync_status(&self, guard: &mut Option<SharedNodeProcess>) {
        if let Some(process) = guard.as_mut() {
            if matches!(process.child.try_wait(), Ok(Some(_)) | Err(_)) {
                *guard = None;
                self.running.store(false, Ordering::Release);
                self.pid.store(0, Ordering::Release);
                return;
            }
            let is_running = !process.mounted_slots.is_empty();
            self.running.store(is_running, Ordering::Release);
            self.pid.store(
                if is_running {
                    process.pid.unwrap_or(0)
                } else {
                    0
                },
                Ordering::Release,
            );
        } else {
            self.running.store(false, Ordering::Release);
            self.pid.store(0, Ordering::Release);
        }
    }

    pub async fn is_running(&self) -> bool {
        if let Ok(mut guard) = self.inner.try_lock() {
            self.sync_status(&mut guard);
        }
        self.running.load(Ordering::Acquire)
    }

    pub async fn pid(&self) -> Option<u32> {
        if let Ok(mut guard) = self.inner.try_lock() {
            self.sync_status(&mut guard);
        }
        if !self.running.load(Ordering::Acquire) {
            return None;
        }
        let pid = self.pid.load(Ordering::Acquire);
        (pid != 0).then_some(pid)
    }

    pub async fn mounted_slot_count(&self) -> usize {
        self.inner
            .lock()
            .await
            .as_ref()
            .map_or(0, |process| process.mounted_slots.len())
    }

    pub async fn mounted_plugin_ids(&self) -> Vec<String> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|process| {
                process
                    .mounted_slots
                    .iter()
                    .map(|(plugin_id, _)| plugin_id.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn invoke_slot(
        &self,
        plugin_id: &str,
        generation: u64,
        handler: &str,
        input: Value,
        request_timeout: Duration,
    ) -> Result<Value, WorkerHostError> {
        let mut guard = self.inner.lock().await;
        let Some(process) = guard.as_mut() else {
            return Err(WorkerHostError::new(
                "worker_terminal",
                "Shared Node worker process is not running",
            ));
        };
        let slot_key = (plugin_id.to_owned(), generation);
        if !process.mounted_slots.contains(&slot_key) {
            return Err(WorkerHostError::new(
                "worker_terminal",
                "Shared Node worker slot is no longer mounted",
            ));
        }
        let spec = process.slot_specs.get(&slot_key).cloned().ok_or_else(|| {
            WorkerHostError::new(
                "worker_terminal",
                "Shared Node worker slot specification is missing",
            )
        })?;
        exchange_muxed(
            process,
            &spec.broker,
            spec.frame_codec,
            "invoke",
            json!({ "handler": handler, "input": input }),
            request_timeout,
        )
        .await
    }
}

enum WorkerBackend {
    Lightweight,
    Dedicated(Box<Mutex<WorkerProcess>>),
    SharedNode {
        host: Arc<SharedNodeWorkerHost>,
        terminal_error: Mutex<Option<String>>,
    },
}

pub struct WorkerHost {
    activation: WorkerActivation,
    broker: Arc<ScopedCapabilityBroker>,
    backend: WorkerBackend,
    request_timeout: Duration,
    frame_codec: FrameCodec,
    last_activity_ms: AtomicU64,
}

impl WorkerHost {
    /// Creates a zero-process activation handle for Tier-0 / Tier-1 plugins
    /// that do not declare a backend `entrypoints.worker`.
    pub fn spawn_lightweight(
        package: &PluginPackage,
        generation: u64,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<Self, WorkerHostError> {
        let package_root = package
            .content_root()
            .canonicalize()
            .unwrap_or_else(|_| package.content_root().to_path_buf());
        let package_digest = crate::package_content_digest(&package_root)
            .unwrap_or_else(|_| format!("sha256:{}:{generation}", package.id.as_str()));
        let scoped_broker = Arc::new(ScopedCapabilityBroker::new(
            package, generation, grants, broker,
        )?);
        let frame_codec = FrameCodec::new(
            package.entrypoints.worker_max_frame_bytes,
            MAX_LOGICAL_MESSAGE_BYTES,
        );
        Ok(Self {
            activation: WorkerActivation {
                plugin_id: package.id.as_str().to_owned(),
                plugin_version: package.version.clone(),
                package_digest,
                generation,
                handlers: Vec::new(),
            },
            broker: scoped_broker,
            backend: WorkerBackend::Lightweight,
            request_timeout: Duration::from_secs(30),
            frame_codec,
            last_activity_ms: AtomicU64::new(activity_now_ms()),
        })
    }

    pub async fn spawn_in_shared_node(
        shared_host: Arc<SharedNodeWorkerHost>,
        node_executable: &Path,
        package: &PluginPackage,
        generation: u64,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<Self, WorkerHostError> {
        Self::spawn_in_shared_node_with_request_timeout(
            shared_host,
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
    pub async fn spawn_in_shared_node_with_request_timeout(
        shared_host: Arc<SharedNodeWorkerHost>,
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
        let plugin_id = package.id.as_str().to_owned();
        let scoped_broker = Arc::new(ScopedCapabilityBroker::new(
            package, generation, grants, broker,
        )?);
        let frame_codec = FrameCodec::new(
            package.entrypoints.worker_max_frame_bytes,
            MAX_LOGICAL_MESSAGE_BYTES,
        );
        let package_digest = crate::package_content_digest(&package_root)
            .map_err(|error| WorkerHostError::new("worker_package_invalid", error.to_string()))?;

        let slot_spec = MountedSlotSpec {
            plugin_id: plugin_id.clone(),
            generation,
            publisher: package.publisher.clone().unwrap_or_default(),
            plugin_version: package.version.clone(),
            package_digest: package_digest.clone(),
            package_class: package.package_class.clone(),
            worker_runtime: package
                .entrypoints
                .worker_runtime
                .clone()
                .unwrap_or_else(|| "node".into()),
            entrypoint: entrypoint.clone(),
            package_root: package_root.clone(),
            frame_codec,
            broker: scoped_broker.clone(),
        };

        let mut guard = shared_host.inner.lock().await;
        let mut crashed_survivors = Vec::new();
        if let Some(existing) = guard.as_mut()
            && (existing.node_executable != node_executable
                || matches!(existing.child.try_wait(), Ok(Some(_)) | Err(_)))
        {
            crashed_survivors = existing.slot_specs.values().cloned().collect();
            let _ = existing.child.kill().await;
            let _ = existing.child.wait().await;
            *guard = None;
        }
        if guard.is_none() {
            let mut fresh = spawn_fresh_shared_node_process(&node_executable, &package_root)?;
            for survivor in crashed_survivors {
                let _ = remount_survivor_slot(&mut fresh, survivor).await;
            }
            *guard = Some(fresh);
        }

        let process = guard.as_mut().expect("shared node process initialized");
        let slot_key = (plugin_id.clone(), generation);
        process
            .brokers
            .insert(slot_key.clone(), scoped_broker.clone());

        let handshake_result = mount_and_activate_slot_muxed(process, &slot_spec)
            .await
            .and_then(|handlers| {
                validate_registrations(package, &handlers)?;
                Ok(handlers)
            });

        match handshake_result {
            Ok(handlers) => {
                process.mounted_slots.insert(slot_key.clone());
                process.slot_specs.insert(slot_key, slot_spec);
                shared_host.sync_status(&mut guard);
                drop(guard);
                Ok(Self {
                    activation: WorkerActivation {
                        plugin_id,
                        plugin_version: package.version.clone(),
                        package_digest,
                        generation,
                        handlers,
                    },
                    broker: scoped_broker,
                    backend: WorkerBackend::SharedNode {
                        host: shared_host,
                        terminal_error: Mutex::new(None),
                    },
                    request_timeout,
                    frame_codec,
                    last_activity_ms: AtomicU64::new(activity_now_ms()),
                })
            }
            Err(error) => {
                process.brokers.remove(&slot_key);
                process.mounted_slots.remove(&slot_key);
                process.slot_specs.remove(&slot_key);
                let unmounted_cleanly = unmount_slot_muxed_checked(
                    process,
                    &plugin_id,
                    generation,
                    Duration::from_secs(1),
                )
                .await
                .is_ok();
                if process.mounted_slots.is_empty() {
                    let _ = process.child.kill().await;
                    let _ = process.child.wait().await;
                    *guard = None;
                } else if !unmounted_cleanly && is_fatal_exchange_error(&error) {
                    let survivors: Vec<MountedSlotSpec> =
                        process.slot_specs.values().cloned().collect();
                    let _ = process.child.kill().await;
                    let _ = process.child.wait().await;
                    *guard = None;
                    if let Ok(mut fresh) =
                        spawn_fresh_shared_node_process(&node_executable, &package_root)
                    {
                        for survivor in survivors {
                            let _ = remount_survivor_slot(&mut fresh, survivor).await;
                        }
                        if !fresh.mounted_slots.is_empty() {
                            *guard = Some(fresh);
                        }
                    }
                }
                shared_host.sync_status(&mut guard);
                Err(error)
            }
        }
    }

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
        let pid = child.id();
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
        let frame_codec = FrameCodec::new(
            package.entrypoints.worker_max_frame_bytes,
            MAX_LOGICAL_MESSAGE_BYTES,
        );
        let mut process = WorkerProcess {
            child,
            pid,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            sequence: 0,
            terminal_error: None,
        };
        let granted_capabilities = vec!["*".to_owned()];
        let package_digest = crate::package_content_digest(&package_root)
            .map_err(|error| WorkerHostError::new("worker_package_invalid", error.to_string()))?;
        let initialized = exchange(
            &mut process,
            &scoped_broker,
            frame_codec,
            "initialize",
            json!({
                "protocolRange": ["1.1"],
                "hostVersion": env!("CARGO_PKG_VERSION"),
                "pluginIdentity": {
                    "publisher": package.publisher.clone().unwrap_or_default(),
                    "id": package.id.as_str(),
                },
                "packageVersion": package.version,
                "packageDigest": package_digest.clone(),
                "generationId": generation,
                "declaredContributions": [],
                "packageClass": package.package_class,
                "features": [],
                "limits": {
                    "maxFrameBytes": frame_codec.max_frame_bytes(),
                    "maxLogicalMessageBytes": frame_codec.max_logical_bytes(),
                    "requestTimeoutMs": 30000
                },
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
            frame_codec,
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
        Ok(Self {
            activation: WorkerActivation {
                plugin_id: package.id.as_str().to_owned(),
                plugin_version: package.version.clone(),
                package_digest,
                generation,
                handlers,
            },
            broker: scoped_broker,
            backend: WorkerBackend::Dedicated(Box::new(Mutex::new(process))),
            request_timeout,
            frame_codec,
            last_activity_ms: AtomicU64::new(activity_now_ms()),
        })
    }

    pub fn is_dedicated_process(&self) -> bool {
        matches!(self.backend, WorkerBackend::Dedicated(_))
    }

    pub fn is_shared_node_process(&self) -> bool {
        matches!(self.backend, WorkerBackend::SharedNode { .. })
    }

    pub fn is_lightweight(&self) -> bool {
        matches!(self.backend, WorkerBackend::Lightweight)
    }

    pub async fn is_terminal(&self) -> bool {
        match &self.backend {
            WorkerBackend::Lightweight => false,
            WorkerBackend::Dedicated(process) => process.lock().await.terminal_error.is_some(),
            WorkerBackend::SharedNode { terminal_error, .. } => {
                terminal_error.lock().await.is_some()
            }
        }
    }

    pub async fn pid(&self) -> Option<u32> {
        match &self.backend {
            WorkerBackend::Lightweight => None,
            WorkerBackend::Dedicated(process) => process.lock().await.pid,
            WorkerBackend::SharedNode { host, .. } => host.pid().await,
        }
    }

    pub fn idle_elapsed(&self) -> Duration {
        Duration::from_millis(
            activity_now_ms().saturating_sub(self.last_activity_ms.load(Ordering::Relaxed)),
        )
    }

    fn touch_activity(&self) {
        self.last_activity_ms
            .store(activity_now_ms(), Ordering::Relaxed);
    }

    pub fn activation(&self) -> &WorkerActivation {
        &self.activation
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.invoke_with_timeout(handler, input, self.request_timeout)
            .await
    }

    pub async fn invoke_slot(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.invoke(handler, input).await
    }

    pub async fn invoke_with_timeout(
        &self,
        handler: &str,
        input: Value,
        request_timeout: Duration,
    ) -> Result<Value, WorkerHostError> {
        self.touch_activity();
        if !self.activation.handlers.iter().any(|item| item == handler) {
            return Err(WorkerHostError::new(
                "handler_not_found",
                format!("handler {handler} is not active"),
            ));
        }
        match &self.backend {
            WorkerBackend::Lightweight => Err(WorkerHostError::new(
                "handler_not_found",
                format!("handler {handler} is not active on lightweight plugin"),
            )),
            WorkerBackend::Dedicated(process) => {
                let mut process = process.lock().await;
                if let Some(reason) = &process.terminal_error {
                    return Err(WorkerHostError::new("worker_terminal", reason));
                }
                let result = exchange(
                    &mut process,
                    &self.broker,
                    self.frame_codec,
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
            WorkerBackend::SharedNode {
                host,
                terminal_error,
            } => {
                if let Some(reason) = terminal_error.lock().await.as_ref() {
                    return Err(WorkerHostError::new("worker_terminal", reason));
                }
                let mut guard = host.inner.lock().await;
                let Some(process) = guard.as_mut() else {
                    return Err(WorkerHostError::new(
                        "worker_terminal",
                        "Shared Node worker process is not running",
                    ));
                };
                let slot_key = (
                    self.activation.plugin_id.clone(),
                    self.activation.generation,
                );
                if !process.mounted_slots.contains(&slot_key) {
                    return Err(WorkerHostError::new(
                        "worker_terminal",
                        "Shared Node worker slot is no longer mounted",
                    ));
                }
                let result = exchange_muxed(
                    process,
                    &self.broker,
                    self.frame_codec,
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
                    *terminal_error.lock().await = Some(reason);
                    process.mounted_slots.remove(&slot_key);
                    process.brokers.remove(&slot_key);
                    let removed_spec = process.slot_specs.remove(&slot_key);

                    // If this slot timed out asynchronously without killing the shared
                    // Node event loop, unmounting the offending slot succeeds and all
                    // sibling plugins keep running in the same OS process untouched.
                    let event_loop_alive = error.code() == "worker_timeout"
                        && matches!(process.child.try_wait(), Ok(None))
                        && unmount_slot_muxed_checked(
                            process,
                            &self.activation.plugin_id,
                            self.activation.generation,
                            Duration::from_millis(800),
                        )
                        .await
                        .is_ok();

                    if process.mounted_slots.is_empty() {
                        let _ = process.child.kill().await;
                        let _ = process.child.wait().await;
                        *guard = None;
                    } else if !event_loop_alive {
                        let node_exec = process.node_executable.clone();
                        let survivors: Vec<MountedSlotSpec> =
                            process.slot_specs.values().cloned().collect();
                        let fallback_cwd = survivors
                            .first()
                            .map(|spec| spec.package_root.clone())
                            .or_else(|| removed_spec.map(|spec| spec.package_root))
                            .unwrap_or_else(|| PathBuf::from("."));
                        let _ = process.child.kill().await;
                        let _ = process.child.wait().await;
                        *guard = None;
                        if let Ok(mut fresh) =
                            spawn_fresh_shared_node_process(&node_exec, &fallback_cwd)
                        {
                            for survivor in survivors {
                                let _ = remount_survivor_slot(&mut fresh, survivor).await;
                            }
                            if !fresh.mounted_slots.is_empty() {
                                *guard = Some(fresh);
                            }
                        }
                    }
                    host.sync_status(&mut guard);
                }
                result
            }
        }
    }

    pub async fn dispose(&self, reason: &str) -> Result<(), WorkerHostError> {
        match &self.backend {
            WorkerBackend::Lightweight => Ok(()),
            WorkerBackend::Dedicated(process) => {
                let mut process = process.lock().await;
                if process.terminal_error.is_some() {
                    return Ok(());
                }
                let _ = exchange(
                    &mut process,
                    &self.broker,
                    self.frame_codec,
                    "dispose",
                    json!({ "reason": reason }),
                    Duration::from_secs(5),
                )
                .await;
                process.child.kill().await.map_err(|error| {
                    WorkerHostError::new("worker_terminate_failed", error.to_string())
                })?;
                let _ = process.child.wait().await;
                process.terminal_error = Some(format!("disposed: {reason}"));
                Ok(())
            }
            WorkerBackend::SharedNode {
                host,
                terminal_error,
            } => {
                {
                    let mut term = terminal_error.lock().await;
                    if term.is_some() {
                        return Ok(());
                    }
                    *term = Some(format!("disposed: {reason}"));
                }
                let mut guard = host.inner.lock().await;
                let Some(process) = guard.as_mut() else {
                    host.sync_status(&mut guard);
                    return Ok(());
                };
                let slot_key = (
                    self.activation.plugin_id.clone(),
                    self.activation.generation,
                );
                process.slot_specs.remove(&slot_key);
                if process.mounted_slots.remove(&slot_key) {
                    let _ = exchange_muxed(
                        process,
                        &self.broker,
                        self.frame_codec,
                        "dispose",
                        json!({ "reason": reason }),
                        Duration::from_secs(5),
                    )
                    .await;
                    let _ = unmount_slot_muxed(
                        process,
                        &self.activation.plugin_id,
                        self.activation.generation,
                    )
                    .await;
                }
                process.brokers.remove(&slot_key);
                if process.mounted_slots.is_empty() {
                    let _ = process.child.kill().await;
                    let _ = process.child.wait().await;
                    *guard = None;
                }
                host.sync_status(&mut guard);
                Ok(())
            }
        }
    }
}

/// A rejected frame is one consumed line. An image that does not fit, and a
/// chunk sequence the host refuses, fail that call only. Unloading here is
/// what made a split image payload kill the worker.
fn activity_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn is_fatal_exchange_error(error: &WorkerHostError) -> bool {
    matches!(
        error.code(),
        "worker_timeout" | "worker_transport_failed" | "worker_closed"
    )
}

fn worker_frame_error_code(code: &str) -> &'static str {
    match code {
        "frame_too_large" => "worker_frame_too_large",
        "frame_chunk_invalid" => "worker_frame_chunk_invalid",
        "message_too_large" => "worker_message_too_large",
        _ => "worker_protocol_invalid",
    }
}

fn host_frame_error_code(code: &str) -> &'static str {
    match code {
        "message_too_large" => "host_message_too_large",
        _ => "host_frame_too_large",
    }
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

type SpawnedSharedNodeIo = (
    HostedChild,
    Option<u32>,
    Box<dyn AsyncWrite + Unpin + Send>,
    Box<dyn AsyncRead + Unpin + Send>,
    Option<tokio::process::ChildStderr>,
);

const SHARED_NODE_RUNNER_SCRIPT: &str = r#"
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const als = new AsyncLocalStorage();
const realStdin = process.stdin;
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realCwd = process.cwd.bind(process);

const slots = new Map();
const servicesMap = new Map();

function normalizeServiceKey(key) {
  return typeof key === "string" ? key : String(key?.id ?? "");
}

class SharedServiceContainer {
  constructor() {
    this.records = new Map();
    this.listeners = new Map();
    this.globalListeners = new Set();
    this.interceptors = new Map();
    this.pluginOwnedDisposers = new Map();
  }

  provide(key, implementation, ownerPluginId) {
    const id = normalizeServiceKey(key);
    const slot = als.getStore();
    const resolvedOwner =
      ownerPluginId ?? (slot ? slotKey(slot.pluginId, slot.generation) : undefined);
    const record = { id, ownerPluginId: resolvedOwner, value: implementation };
    this.records.set(id, record);
    servicesMap.set(id, implementation);
    this._notify(id);
    return () => {
      if (this.records.get(id) === record) {
        this.records.delete(id);
        servicesMap.delete(id);
        this._notify(id);
      }
    };
  }

  get(key) {
    return this.inject(key);
  }

  inject(keyOrDeps, effect, ownerPluginId) {
    if (!Array.isArray(keyOrDeps)) {
      const id = normalizeServiceKey(keyOrDeps);
      return this.records.get(id)?.value;
    }
    if (typeof effect !== "function") {
      throw new Error(
        "ServiceContainer.inject(deps, effect) requires an effect callback",
      );
    }
    const slot = als.getStore();
    const resolvedOwner =
      ownerPluginId ?? (slot ? slotKey(slot.pluginId, slot.generation) : undefined);
    const depIds = keyOrDeps.map((dep) => normalizeServiceKey(dep));
    let currentCleanup;
    let disposed = false;

    const evaluate = () => {
      if (disposed) return;
      if (typeof currentCleanup === "function") {
        const prev = currentCleanup;
        currentCleanup = undefined;
        try {
          prev();
        } catch {}
      }
      if (depIds.every((id) => this.records.has(id))) {
        const resolved = {};
        for (const id of depIds) {
          resolved[id] = this.records.get(id)?.value;
        }
        Object.defineProperty(resolved, Symbol.iterator, {
          enumerable: false,
          value: function* () {
            for (const id of depIds) {
              yield resolved[id];
            }
          },
        });
        try {
          currentCleanup = effect(resolved);
        } catch {}
      }
    };

    const unsubs = depIds.map((id) => this.onServiceChange(id, evaluate));
    evaluate();

    const disposer = () => {
      if (disposed) return;
      disposed = true;
      for (const unsub of unsubs) unsub();
      if (typeof currentCleanup === "function") {
        const prev = currentCleanup;
        currentCleanup = undefined;
        try {
          prev();
        } catch {}
      }
      if (resolvedOwner) {
        this.pluginOwnedDisposers.get(resolvedOwner)?.delete(disposer);
      }
    };

    if (resolvedOwner) {
      let owned = this.pluginOwnedDisposers.get(resolvedOwner);
      if (!owned) {
        owned = new Set();
        this.pluginOwnedDisposers.set(resolvedOwner, owned);
      }
      owned.add(disposer);
    }
    return disposer;
  }

  require(key) {
    const val = this.get(key);
    if (val === undefined) {
      throw new Error(
        `Required plugin service "${normalizeServiceKey(key)}" is not available`,
      );
    }
    return val;
  }

  has(key) {
    return this.records.has(normalizeServiceKey(key));
  }

  intercept(hookName, fn, order = 0, ownerPluginId) {
    const slot = als.getStore();
    const resolvedOwner =
      ownerPluginId ?? (slot ? slotKey(slot.pluginId, slot.generation) : undefined);
    if (this.records.has(hookName) && fn.length <= 1) {
      const prevRecord = this.records.get(hookName);
      const decoratedValue = fn(prevRecord.value);
      const nextRecord = {
        id: hookName,
        ownerPluginId: resolvedOwner ?? prevRecord.ownerPluginId,
        value: decoratedValue,
      };
      this.records.set(hookName, nextRecord);
      servicesMap.set(hookName, decoratedValue);
      this._notify(hookName);
      const disposer = () => {
        if (this.records.get(hookName) === nextRecord) {
          this.records.set(hookName, prevRecord);
          servicesMap.set(hookName, prevRecord.value);
          this._notify(hookName);
        }
        if (resolvedOwner) {
          this.pluginOwnedDisposers.get(resolvedOwner)?.delete(disposer);
        }
      };
      if (resolvedOwner) {
        let owned = this.pluginOwnedDisposers.get(resolvedOwner);
        if (!owned) {
          owned = new Set();
          this.pluginOwnedDisposers.set(resolvedOwner, owned);
        }
        owned.add(disposer);
      }
      return disposer;
    }
    let list = this.interceptors.get(hookName);
    if (!list) {
      list = [];
      this.interceptors.set(hookName, list);
    }
    const wrappedFn =
      fn.length <= 1
        ? async (payload, next) => {
            const transformed = await fn(payload);
            return await next(transformed);
          }
        : fn;
    const entry = { ownerPluginId: resolvedOwner, order, fn: wrappedFn };
    list.push(entry);
    list.sort((a, b) => a.order - b.order);
    const disposer = () => {
      const current = this.interceptors.get(hookName);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx !== -1) current.splice(idx, 1);
      if (current.length === 0) this.interceptors.delete(hookName);
      if (resolvedOwner) {
        this.pluginOwnedDisposers.get(resolvedOwner)?.delete(disposer);
      }
    };
    if (resolvedOwner) {
      let owned = this.pluginOwnedDisposers.get(resolvedOwner);
      if (!owned) {
        owned = new Set();
        this.pluginOwnedDisposers.set(resolvedOwner, owned);
      }
      owned.add(disposer);
    }
    return disposer;
  }

  async runWaterfall(
    hookName,
    initialPayload,
    terminal = (payload) => payload,
    perHookTimeoutMs = 1500,
  ) {
    const chain = [...(this.interceptors.get(hookName) ?? [])];
    const dispatch = async (index, currentPayload) => {
      if (index >= chain.length) {
        return await terminal(currentPayload);
      }
      const current = chain[index];
      let nextCalled = false;
      const invokeHook = current.fn(currentPayload, async (nextPayload) => {
        nextCalled = true;
        return await dispatch(index + 1, nextPayload);
      });
      let timeoutHandle;
      const timeoutFallback = new Promise((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          if (!nextCalled) {
            dispatch(index + 1, currentPayload).then(resolve, reject);
          }
        }, perHookTimeoutMs);
      });
      try {
        return await Promise.race([invokeHook, timeoutFallback]);
      } catch {
        if (!nextCalled) {
          return await dispatch(index + 1, currentPayload);
        }
        throw new Error(`Waterfall hook "${hookName}" failed after next()`);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    };
    return await dispatch(0, initialPayload);
  }

  onServiceChange(key, listener) {
    const id = normalizeServiceKey(key);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  subscribe(listener) {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  disposeByPlugin(pluginId, generation) {
    let removedCount = 0;
    const targetKey =
      generation !== undefined && generation !== null
        ? slotKey(pluginId, generation)
        : null;
    const matchesOwner = (owner) => {
      if (!owner) return false;
      if (targetKey !== null) {
        return owner === targetKey;
      }
      return (
        owner === pluginId ||
        (typeof owner === "string" && owner.startsWith(`${pluginId}#`))
      );
    };
    for (const [ownerKey, owned] of Array.from(this.pluginOwnedDisposers.entries())) {
      if (!matchesOwner(ownerKey)) continue;
      this.pluginOwnedDisposers.delete(ownerKey);
      for (const disposer of Array.from(owned)) {
        try {
          disposer();
        } catch {}
        removedCount += 1;
      }
    }
    for (const [hookName, entries] of this.interceptors.entries()) {
      const before = entries.length;
      const filtered = entries.filter((e) => !matchesOwner(e.ownerPluginId));
      removedCount += before - filtered.length;
      if (filtered.length === 0) this.interceptors.delete(hookName);
      else if (filtered.length !== before) this.interceptors.set(hookName, filtered);
    }
    const removedIds = [];
    for (const [id, record] of this.records.entries()) {
      if (matchesOwner(record.ownerPluginId)) {
        this.records.delete(id);
        servicesMap.delete(id);
        removedIds.push(id);
        removedCount += 1;
      }
    }
    for (const id of removedIds) {
      this._notify(id);
    }
    return removedCount;
  }

  disposePlugin(pluginId, generation) {
    return this.disposeByPlugin(pluginId, generation);
  }

  clear() {
    for (const disposers of this.pluginOwnedDisposers.values()) {
      for (const d of Array.from(disposers)) {
        try {
          d();
        } catch {}
      }
    }
    this.pluginOwnedDisposers.clear();
    this.interceptors.clear();
    const ids = Array.from(this.records.keys());
    this.records.clear();
    servicesMap.clear();
    for (const id of ids) this._notify(id);
  }

  _notify(id) {
    const set = this.listeners.get(id);
    if (set) {
      for (const l of Array.from(set)) {
        try {
          l();
        } catch {}
      }
    }
    for (const l of Array.from(this.globalListeners)) {
      try {
        l();
      } catch {}
    }
  }
}

const sharedServiceContainer = new SharedServiceContainer();
globalThis[Symbol.for("vibex.plugin-sdk.serviceContainer")] = sharedServiceContainer;
globalThis.__VIBEX_SHARED_PLUGIN_HOST__ = {
  slots,
  services: servicesMap,
  serviceContainer: sharedServiceContainer,
};

function createScopedServices(pluginId) {
  return {
    provide(key, implementation) {
      return sharedServiceContainer.provide(key, implementation, pluginId);
    },
    get(key) {
      return sharedServiceContainer.get(key);
    },
    inject(keyOrDeps, effect) {
      if (Array.isArray(keyOrDeps)) {
        return sharedServiceContainer.inject(keyOrDeps, effect, pluginId);
      }
      return sharedServiceContainer.inject(keyOrDeps);
    },
    require(key) {
      return sharedServiceContainer.require(key);
    },
    has(key) {
      return sharedServiceContainer.has(key);
    },
    intercept(hookName, fn, order = 0) {
      return sharedServiceContainer.intercept(hookName, fn, order, pluginId);
    },
    runWaterfall(hookName, initialPayload, terminal, perHookTimeoutMs) {
      return sharedServiceContainer.runWaterfall(
        hookName,
        initialPayload,
        terminal,
        perHookTimeoutMs,
      );
    },
    subscribe(listener) {
      return sharedServiceContainer.subscribe(listener);
    },
  };
}

function slotKey(pluginId, generation) {
  return `${pluginId}#${generation}`;
}

function sendMux(payload) {
  realStdoutWrite(`${JSON.stringify({ __mux: 1, ...payload })}\n`);
}

Object.defineProperty(process, "stdin", {
  configurable: true,
  enumerable: true,
  get() {
    const slot = als.getStore();
    return slot ? slot.stdin : realStdin;
  },
});

process.cwd = function () {
  const slot = als.getStore();
  return slot && slot.cwd ? slot.cwd : realCwd();
};

process.stdout.write = function (chunk, encoding, cb) {
  const slot = als.getStore();
  if (slot) {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encoding === "string" ? encoding : "utf8",
          );
    slot.stdoutBuffer += text;
    let idx;
    while ((idx = slot.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = slot.stdoutBuffer.slice(0, idx).replace(/\r$/, "");
      slot.stdoutBuffer = slot.stdoutBuffer.slice(idx + 1);
      if (line.length > 0) {
        sendMux({
          pluginId: slot.pluginId,
          generation: slot.generation,
          line,
        });
      }
    }
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }
  return realStdoutWrite(chunk, encoding, cb);
};

process.stderr.write = function (chunk, encoding, cb) {
  const slot = als.getStore();
  if (slot) {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encoding === "string" ? encoding : "utf8",
          );
    slot.stderrBuffer += text;
    let idx;
    while ((idx = slot.stderrBuffer.indexOf("\n")) !== -1) {
      const line = slot.stderrBuffer.slice(0, idx).replace(/\r$/, "");
      slot.stderrBuffer = slot.stderrBuffer.slice(idx + 1);
      if (line.length > 0) {
        sendMux({
          pluginId: slot.pluginId,
          generation: slot.generation,
          stderr: line,
        });
      }
    }
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }
  return realStderrWrite(chunk, encoding, cb);
};

process.on("unhandledRejection", (reason) => {
  const slot = als.getStore();
  const text = reason instanceof Error ? reason.stack || reason.message : String(reason);
  if (slot) {
    sendMux({
      pluginId: slot.pluginId,
      generation: slot.generation,
      stderr: `UnhandledRejection: ${text}`,
    });
  } else {
    realStderrWrite(`UnhandledRejection: ${text}\n`);
  }
});

process.on("uncaughtException", (err) => {
  const slot = als.getStore();
  const text = err instanceof Error ? err.stack || err.message : String(err);
  if (slot) {
    sendMux({
      pluginId: slot.pluginId,
      generation: slot.generation,
      stderr: `UncaughtException: ${text}`,
    });
  } else {
    realStderrWrite(`UncaughtException: ${text}\n`);
  }
});

function waitForSlotReady(slot, importPromise) {
  return new Promise((resolve, reject) => {
    if (
      slot.stdin.listenerCount("data") > 0 ||
      slot.stdin.listenerCount("readable") > 0
    ) {
      setImmediate(() => resolve({ mode: "stdio" }));
      return;
    }
    const onNewListener = (event) => {
      if (event === "data" || event === "readable") {
        slot.stdin.removeListener("newListener", onNewListener);
        setImmediate(() => resolve({ mode: "stdio" }));
      }
    };
    slot.stdin.on("newListener", onNewListener);
    importPromise.then(
      (mod) => {
        slot.stdin.removeListener("newListener", onNewListener);
        resolve({ mode: "module", mod });
      },
      (err) => {
        slot.stdin.removeListener("newListener", onNewListener);
        reject(err);
      },
    );
  });
}

function attachExportedWorkerLoop(slot, mod) {
  if (
    slot.stdin.listenerCount("data") > 0 ||
    slot.stdin.listenerCount("readable") > 0
  ) {
    return;
  }
  const def = mod?.default ?? mod?.worker ?? mod;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handlers = new Map();
  const disposables = [];
  const controller = new AbortController();
  const scopedServices = createScopedServices(slotKey(slot.pluginId, slot.generation));
  let workerDisposed = false;
  let hostPending = new Map();
  let hostSeq = 0;
  let workerEnv = null;
  let maxFrameBytes = 32 * 1024 * 1024;
  let maxLogicalBytes = 64 * 1024 * 1024;
  const chunkStreams = new Map();

  const runDisposeSequence = async () => {
    if (workerDisposed) return;
    workerDisposed = true;
    controller.abort();
    for (const d of [...disposables].reverse()) {
      try {
        if (typeof d === "function") await d();
        else if (typeof d?.dispose === "function") await d.dispose();
      } catch {}
    }
    disposables.length = 0;
    handlers.clear();
    sharedServiceContainer.disposeByPlugin(slot.pluginId, slot.generation);
  };
  slot.disposeWorker = runDisposeSequence;

  const send = (obj) => {
    const raw = JSON.stringify(obj);
    const byteLen = Buffer.byteLength(raw, "utf8");
    if (byteLen > maxLogicalBytes) {
      process.stdout.write(`${JSON.stringify({ id: obj.id ?? "unknown", ok: false, error: { code: "message_too_large", message: "Logical message exceeded limit" } })}\n`);
      return;
    }
    const maxChunkData = Math.max(64, maxFrameBytes - 256);
    if (byteLen <= maxFrameBytes) {
      process.stdout.write(`${raw}\n`);
      return;
    }
    const streamId = String(obj.id ?? `stream:${++hostSeq}`);
    const parts = [];
    for (let offset = 0; offset < raw.length; offset += maxChunkData) {
      parts.push(raw.slice(offset, offset + maxChunkData));
    }
    for (let index = 0; index < parts.length; index += 1) {
      process.stdout.write(`${JSON.stringify({
        id: `chunk:${streamId}:${index}`,
        method: "frame.chunk",
        params: { streamId, index, count: parts.length, data: parts[index] },
      })}\n`);
    }
  };

  const host = {
    call(capability, operation, input = null) {
      const id = `host:${++hostSeq}`;
      return new Promise((resolve, reject) => {
        hostPending.set(id, { resolve, reject });
        send({
          id,
          method: "host.call",
          params: { capability, operation, input },
        });
      });
    },
  };

  const log = {
    debug: (m, f) => process.stderr.write(`${JSON.stringify({ level: "debug", message: m, fields: f ?? null })}\n`),
    info: (m, f) => process.stderr.write(`${JSON.stringify({ level: "info", message: m, fields: f ?? null })}\n`),
    warn: (m, f) => process.stderr.write(`${JSON.stringify({ level: "warn", message: m, fields: f ?? null })}\n`),
    error: (m, f) => process.stderr.write(`${JSON.stringify({ level: "error", message: m, fields: f ?? null })}\n`),
  };

  (async () => {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
        send({ id: "unknown", ok: false, error: { code: "worker_frame_too_large", message: "Protocol frame exceeded limit" } });
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ id: "unknown", ok: false, error: { code: "protocol_invalid", message: "Invalid JSON" } });
        continue;
      }
      if (msg?.method === "frame.chunk") {
        const p = msg.params ?? {};
        const entry = chunkStreams.get(p.streamId) ?? { count: p.count, parts: [] };
        if (entry.count !== p.count || p.index !== entry.parts.length) {
          chunkStreams.delete(p.streamId);
          send({ id: "unknown", ok: false, error: { code: "worker_frame_chunk_invalid", message: "Invalid frame.chunk sequence" } });
          continue;
        }
        entry.parts.push(String(p.data ?? ""));
        if (entry.parts.length < entry.count) {
          chunkStreams.set(p.streamId, entry);
          continue;
        }
        chunkStreams.delete(p.streamId);
        try {
          msg = JSON.parse(entry.parts.join(""));
        } catch {
          send({ id: "unknown", ok: false, error: { code: "protocol_invalid", message: "Invalid reassembled JSON" } });
          continue;
        }
      }
      if ("ok" in msg && hostPending.has(msg.id)) {
        const pending = hostPending.get(msg.id);
        hostPending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(Object.assign(new Error(msg.error?.message ?? "Host call failed"), { code: msg.error?.code ?? "host_failed" }));
        continue;
      }
      try {
        if (msg.method === "initialize") {
          const advertised = msg.params?.limits;
          if (typeof advertised?.maxFrameBytes === "number" && advertised.maxFrameBytes > 0) {
            maxFrameBytes = advertised.maxFrameBytes;
          }
          if (typeof advertised?.maxLogicalMessageBytes === "number" && advertised.maxLogicalMessageBytes > 0) {
            maxLogicalBytes = advertised.maxLogicalMessageBytes;
          }
          send({
            id: msg.id,
            ok: true,
            result: {
              protocolVersion: "1.1",
              sdkVersion: "1.0.0",
              registrations: [],
              requestedFeatures: [],
            },
          });
        } else if (msg.method === "activate") {
          workerEnv = {
            context: msg.params,
            host,
            services: scopedServices,
            log,
            signal: controller.signal,
          };
          const registrar = {
            handle(id, fn) {
              handlers.set(id, fn);
            },
            onDispose(d) {
              disposables.push(d);
            },
          };
          if (typeof def?.setup === "function") {
            const ret = await def.setup(registrar, workerEnv);
            if (ret) disposables.push(ret);
          } else if (def?.handlers && typeof def.handlers === "object") {
            for (const [id, fn] of Object.entries(def.handlers)) {
              if (typeof fn === "function") handlers.set(id, fn);
            }
          }
          send({
            id: msg.id,
            ok: true,
            result: { handlers: [...handlers.keys()].sort() },
          });
        } else if (msg.method === "invoke") {
          const fn = handlers.get(msg.params?.handler);
          if (!fn) {
            send({
              id: msg.id,
              ok: false,
              error: { code: "handler_not_found", message: `Handler ${msg.params?.handler} not registered` },
            });
            continue;
          }
          Promise.resolve(fn(msg.params?.input, workerEnv))
            .then((result) => send({ id: msg.id, ok: true, result: result ?? null }))
            .catch((err) => {
              const code = err?.code || "worker_failed";
              const message = err instanceof Error ? err.message : String(err);
              send({ id: msg.id, ok: false, error: { code, message } });
            });
        } else if (msg.method === "dispose" || msg.method === "plugin.unload") {
          await runDisposeSequence();
          send({ id: msg.id, ok: true, result: null });
        } else if (msg.method === "ping") {
          send({ id: msg.id, ok: true, result: { apiVersion: "1.0" } });
        }
      } catch (err) {
        const code = err?.code || "worker_failed";
        const message = err instanceof Error ? err.message : String(err);
        send({ id: msg.id, ok: false, error: { code, message } });
      }
    }
  })().catch(() => {});
}

let mountCounter = 0;
const hostInput = createInterface({ input: realStdin, crlfDelay: Infinity });
for await (const rawLine of hostInput) {
  if (!rawLine.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    continue;
  }
  if (!msg || msg.__mux !== 1) continue;

  if (msg.action === "mount") {
    const key = slotKey(msg.pluginId, msg.generation);
    const existing = slots.get(key);
    if (existing) {
      existing.disposed = true;
      try {
        await existing.disposeWorker?.();
      } catch {}
      sharedServiceContainer.disposeByPlugin(existing.pluginId, existing.generation);
      try {
        existing.stdin.end();
      } catch {}
      slots.delete(key);
    }
    const slot = {
      pluginId: msg.pluginId,
      generation: msg.generation,
      cwd: msg.cwd,
      entrypoint: msg.entrypoint,
      stdin: new PassThrough(),
      stdoutBuffer: "",
      stderrBuffer: "",
      disposed: false,
      disposeWorker: null,
    };
    slots.set(key, slot);
    try {
      const entryUrl = `${pathToFileURL(msg.entrypoint).href}?vibexGen=${msg.generation}&m=${++mountCounter}`;
      const importPromise = als.run(slot, () => import(entryUrl));
      importPromise.catch((err) => {
        const text = err instanceof Error ? err.stack || err.message : String(err);
        sendMux({
          pluginId: slot.pluginId,
          generation: slot.generation,
          stderr: text,
        });
      });
      const ready = await waitForSlotReady(slot, importPromise);
      if (ready.mode === "module") {
        als.run(slot, () => attachExportedWorkerLoop(slot, ready.mod));
        await new Promise((r) => setImmediate(r));
      }
      sendMux({
        pluginId: slot.pluginId,
        generation: slot.generation,
        control: "mounted",
        ok: true,
      });
    } catch (err) {
      slots.delete(key);
      sharedServiceContainer.disposeByPlugin(msg.pluginId, msg.generation);
      const text = err instanceof Error ? err.message : String(err);
      sendMux({
        pluginId: msg.pluginId,
        generation: msg.generation,
        control: "mounted",
        ok: false,
        error: text,
      });
    }
    continue;
  }

  if (
    msg.action === "unmount" ||
    msg.action === "plugin.unload" ||
    msg.method === "plugin.unload"
  ) {
    const key = slotKey(msg.pluginId, msg.generation);
    const slot = slots.get(key);
    if (slot) {
      try {
        await slot.disposeWorker?.();
      } catch {}
      sharedServiceContainer.disposeByPlugin(slot.pluginId, slot.generation);
      if (slot.stderrBuffer.trim().length > 0) {
        sendMux({
          pluginId: slot.pluginId,
          generation: slot.generation,
          stderr: slot.stderrBuffer.replace(/\r$/, ""),
        });
        slot.stderrBuffer = "";
      }
      slot.disposed = true;
      try {
        slot.stdin.end();
      } catch {}
      slots.delete(key);
    } else if (msg.pluginId) {
      sharedServiceContainer.disposeByPlugin(msg.pluginId, msg.generation);
    }
    sendMux({
      pluginId: msg.pluginId,
      generation: msg.generation,
      control: "unmounted",
      ok: true,
    });
    continue;
  }

  if (typeof msg.line === "string") {
    const key = slotKey(msg.pluginId, msg.generation);
    const slot = slots.get(key);
    if (slot && !slot.disposed) {
      als.run(slot, () => {
        slot.stdin.write(`${msg.line}\n`);
      });
    }
  }
}
"#;

fn spawn_fresh_shared_node_process(
    node_executable: &Path,
    initial_cwd: &Path,
) -> Result<SharedNodeProcess, WorkerHostError> {
    let (child, pid, stdin, stdout, stderr) =
        spawn_shared_node_runner(node_executable, initial_cwd)?;
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                record_plugin_log("shared-node-runner", "stderr", line);
            }
        });
    }
    Ok(SharedNodeProcess {
        node_executable: node_executable.to_path_buf(),
        child,
        pid,
        stdin,
        stdout: BufReader::new(stdout).lines(),
        sequence: 0,
        mounted_slots: BTreeSet::new(),
        brokers: BTreeMap::new(),
        slot_specs: BTreeMap::new(),
    })
}

async fn mount_and_activate_slot_muxed(
    process: &mut SharedNodeProcess,
    spec: &MountedSlotSpec,
) -> Result<Vec<String>, WorkerHostError> {
    mount_slot_muxed(
        process,
        &spec.plugin_id,
        spec.generation,
        &worker_process_path(&spec.entrypoint),
        &worker_process_path(&spec.package_root),
        Duration::from_secs(10),
    )
    .await?;

    let initialized = exchange_muxed(
        process,
        &spec.broker,
        spec.frame_codec,
        "initialize",
        json!({
            "protocolRange": ["1.1"],
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "pluginIdentity": {
                "publisher": spec.publisher,
                "id": spec.plugin_id,
            },
            "packageVersion": spec.plugin_version,
            "packageDigest": spec.package_digest,
            "generationId": spec.generation,
            "declaredContributions": [],
            "packageClass": spec.package_class,
            "features": [],
            "limits": {
                "maxFrameBytes": spec.frame_codec.max_frame_bytes(),
                "maxLogicalMessageBytes": spec.frame_codec.max_logical_bytes(),
                "requestTimeoutMs": 30000
            },
            "runtime": {
                "id": spec.worker_runtime,
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
    let response = exchange_muxed(
        process,
        &spec.broker,
        spec.frame_codec,
        "activate",
        json!({
            "pluginId": spec.plugin_id,
            "pluginVersion": spec.plugin_version,
            "generation": spec.generation,
            "packageClass": spec.package_class,
            "grantedCapabilities": ["*"],
        }),
        Duration::from_secs(10),
    )
    .await?;
    let handlers = response
        .get("handlers")
        .and_then(Value::as_array)
        .ok_or_else(|| WorkerHostError::new("worker_registration_invalid", "handlers are missing"))?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(handlers)
}

async fn remount_survivor_slot(
    process: &mut SharedNodeProcess,
    spec: MountedSlotSpec,
) -> Result<(), WorkerHostError> {
    let slot_key = (spec.plugin_id.clone(), spec.generation);
    process
        .brokers
        .insert(slot_key.clone(), spec.broker.clone());
    match mount_and_activate_slot_muxed(process, &spec).await {
        Ok(_) => {
            process.mounted_slots.insert(slot_key.clone());
            process.slot_specs.insert(slot_key, spec);
            Ok(())
        }
        Err(error) => {
            process.brokers.remove(&slot_key);
            let _ = unmount_slot_muxed(process, &spec.plugin_id, spec.generation).await;
            Err(error)
        }
    }
}

fn spawn_shared_node_runner(
    node_executable: &Path,
    initial_cwd: &Path,
) -> Result<SpawnedSharedNodeIo, WorkerHostError> {
    let program = worker_process_path(node_executable);
    let cwd = worker_process_path(initial_cwd);
    let mut command = Command::new(&program);
    command
        .arg("--max-old-space-size=256")
        .arg("--input-type=module")
        .arg("-e")
        .arg(SHARED_NODE_RUNNER_SCRIPT)
        .current_dir(&cwd)
        .env("NO_COLOR", "1")
        .env("VIBEX_PACKAGE_CLASS", "full-trust")
        .env("VIBEX_HOST_DATA_DIR", utils::assets::host_data_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    utils::process::configure_tokio_command_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| WorkerHostError::new("worker_spawn_failed", error.to_string()))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| {
        WorkerHostError::new(
            "worker_transport_failed",
            "Shared Node stdin is unavailable",
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        WorkerHostError::new(
            "worker_transport_failed",
            "Shared Node stdout is unavailable",
        )
    })?;
    let stderr = child.stderr.take();
    Ok((
        HostedChild::Command(Some(child)),
        pid,
        Box::new(stdin),
        Box::new(stdout),
        stderr,
    ))
}

async fn write_raw_json_line(
    stdin: &mut (dyn AsyncWrite + Unpin + Send),
    value: &Value,
) -> Result<(), WorkerHostError> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))
}

async fn mount_slot_muxed(
    process: &mut SharedNodeProcess,
    plugin_id: &str,
    generation: u64,
    entrypoint: &Path,
    cwd: &Path,
    deadline: Duration,
) -> Result<(), WorkerHostError> {
    write_raw_json_line(
        &mut process.stdin,
        &json!({
            "__mux": 1,
            "action": "mount",
            "pluginId": plugin_id,
            "generation": generation,
            "entrypoint": entrypoint.to_string_lossy(),
            "cwd": cwd.to_string_lossy(),
        }),
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
            let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(stderr_line) = envelope.get("stderr").and_then(Value::as_str) {
                let target_plugin = envelope
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .unwrap_or(plugin_id);
                record_plugin_log(target_plugin, "stderr", stderr_line);
                continue;
            }
            if envelope.get("control").and_then(Value::as_str) == Some("mounted")
                && envelope.get("pluginId").and_then(Value::as_str) == Some(plugin_id)
                && envelope.get("generation").and_then(Value::as_u64) == Some(generation)
            {
                if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
                    return Ok(());
                }
                let detail = envelope
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to mount plugin worker in shared Node runner");
                return Err(WorkerHostError::new("worker_spawn_failed", detail));
            }
        }
    })
    .await
    .map_err(|_| WorkerHostError::new("worker_timeout", "Worker mount timed out"))?
}

async fn unmount_slot_muxed_checked(
    process: &mut SharedNodeProcess,
    plugin_id: &str,
    generation: u64,
    deadline: Duration,
) -> Result<(), WorkerHostError> {
    write_raw_json_line(
        &mut process.stdin,
        &json!({
            "__mux": 1,
            "action": "plugin.unload",
            "pluginId": plugin_id,
            "generation": generation,
        }),
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
            let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(stderr_line) = envelope.get("stderr").and_then(Value::as_str) {
                let target_plugin = envelope
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .unwrap_or(plugin_id);
                record_plugin_log(target_plugin, "stderr", stderr_line);
                continue;
            }
            if envelope.get("control").and_then(Value::as_str) == Some("unmounted")
                && envelope.get("pluginId").and_then(Value::as_str) == Some(plugin_id)
                && envelope.get("generation").and_then(Value::as_u64) == Some(generation)
            {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| WorkerHostError::new("worker_timeout", "Worker unmount timed out"))?
}

async fn unmount_slot_muxed(
    process: &mut SharedNodeProcess,
    plugin_id: &str,
    generation: u64,
) -> Result<(), WorkerHostError> {
    let _ =
        unmount_slot_muxed_checked(process, plugin_id, generation, Duration::from_secs(2)).await;
    Ok(())
}

async fn write_message_muxed(
    stdin: &mut (dyn AsyncWrite + Unpin + Send),
    plugin_id: &str,
    generation: u64,
    message: &Value,
    codec: FrameCodec,
) -> Result<(), WorkerHostError> {
    let frames = codec
        .encode(message)
        .map_err(|error| WorkerHostError::new(host_frame_error_code(error.code), error.message))?;
    for frame in frames {
        let frame_str = String::from_utf8(frame)
            .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))?;
        write_raw_json_line(
            stdin,
            &json!({
                "__mux": 1,
                "pluginId": plugin_id,
                "generation": generation,
                "line": frame_str,
            }),
        )
        .await?;
    }
    Ok(())
}

async fn exchange_muxed(
    process: &mut SharedNodeProcess,
    broker: &ScopedCapabilityBroker,
    codec: FrameCodec,
    method: &str,
    params: Value,
    deadline: Duration,
) -> Result<Value, WorkerHostError> {
    let plugin_id = broker.plugin_id.as_str();
    let generation = broker.generation;
    process.sequence = process.sequence.saturating_add(1);
    let current_sequence = process.sequence;
    let request_id = format!("host:{current_sequence}");
    write_message_muxed(
        &mut process.stdin,
        plugin_id,
        generation,
        &json!({ "id": request_id, "method": method, "params": params }),
        codec,
    )
    .await?;
    let mut frames = FrameReassembler::new(codec);
    timeout(deadline, async {
        loop {
            let raw_line = process
                .stdout
                .next_line()
                .await
                .map_err(|error| {
                    WorkerHostError::new("worker_transport_failed", error.to_string())
                })?
                .ok_or_else(|| WorkerHostError::new("worker_closed", "Worker closed stdout"))?;
            let envelope: Value = serde_json::from_str(&raw_line).map_err(|error| {
                WorkerHostError::new("worker_protocol_invalid", error.to_string())
            })?;
            if let Some(stderr_line) = envelope.get("stderr").and_then(Value::as_str) {
                let target_plugin = envelope
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .unwrap_or(plugin_id);
                record_plugin_log(target_plugin, "stderr", stderr_line);
                continue;
            }
            if envelope.get("control").is_some() {
                continue;
            }
            let env_plugin_id = envelope.get("pluginId").and_then(Value::as_str);
            let env_generation = envelope.get("generation").and_then(Value::as_u64);
            let Some(inner_line) = envelope.get("line").and_then(Value::as_str) else {
                continue;
            };
            if env_plugin_id != Some(plugin_id) || env_generation != Some(generation) {
                if let (Some(other_id), Some(other_gen)) = (env_plugin_id, env_generation)
                    && let Ok(other_msg) = serde_json::from_str::<Value>(inner_line)
                    && other_msg.get("method").and_then(Value::as_str) == Some("host.call")
                    && let Some(other_broker) = process
                        .brokers
                        .get(&(other_id.to_owned(), other_gen))
                        .cloned()
                {
                    dispatch_host_call_muxed(process, &other_broker, codec, &other_msg).await?;
                }
                continue;
            }
            let message = match frames.push_line(inner_line) {
                Ok(FrameDecode::NeedMore) => continue,
                Ok(FrameDecode::Message(message)) => message,
                Err(error) => {
                    return Err(WorkerHostError::new(
                        worker_frame_error_code(error.code),
                        error.message,
                    ));
                }
            };
            if let Some(msg_method) = message.get("method").and_then(Value::as_str) {
                if msg_method == "host.call" {
                    dispatch_host_call_muxed(process, broker, codec, &message).await?;
                    continue;
                }
                if msg_method == "worker.log" {
                    if let Some(text) = message.pointer("/params/message").and_then(Value::as_str) {
                        record_plugin_log(plugin_id, "stdout", text);
                    }
                    continue;
                }
                if message.get("id").is_none() {
                    continue;
                }
            }
            let resp_id = message.get("id").and_then(Value::as_str);
            if resp_id != Some(&request_id) {
                if let Some(stale_seq) = resp_id
                    .and_then(|id| id.strip_prefix("host:"))
                    .and_then(|num| num.parse::<u64>().ok())
                    && stale_seq < current_sequence
                {
                    continue;
                }
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

async fn dispatch_host_call_muxed(
    process: &mut SharedNodeProcess,
    broker: &ScopedCapabilityBroker,
    codec: FrameCodec,
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
    write_message_muxed(
        &mut process.stdin,
        &broker.plugin_id,
        broker.generation,
        &response,
        codec,
    )
    .await
}

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
        HostedChild::Command(Some(child)),
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
    utils::process::configure_tokio_command_no_window(&mut command);
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
    codec: FrameCodec,
    method: &str,
    params: Value,
    deadline: Duration,
) -> Result<Value, WorkerHostError> {
    process.sequence = process.sequence.saturating_add(1);
    let request_id = format!("host:{}", process.sequence);
    write_message(
        &mut process.stdin,
        &json!({ "id": request_id, "method": method, "params": params }),
        codec,
    )
    .await?;
    let mut frames = FrameReassembler::new(codec);
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
            let message = match frames.push_line(&line) {
                Ok(FrameDecode::NeedMore) => continue,
                Ok(FrameDecode::Message(message)) => message,
                Err(error) => {
                    return Err(WorkerHostError::new(
                        worker_frame_error_code(error.code),
                        error.message,
                    ));
                }
            };
            if message.get("method").and_then(Value::as_str) == Some("host.call") {
                dispatch_host_call(process, broker, codec, &message).await?;
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
    codec: FrameCodec,
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
    write_message(&mut process.stdin, &response, codec).await
}

async fn write_message(
    stdin: &mut (dyn AsyncWrite + Unpin + Send),
    message: &Value,
    codec: FrameCodec,
) -> Result<(), WorkerHostError> {
    let frames = codec
        .encode(message)
        .map_err(|error| WorkerHostError::new(host_frame_error_code(error.code), error.message))?;
    for mut frame in frames {
        frame.push(b'\n');
        stdin
            .write_all(&frame)
            .await
            .map_err(|error| WorkerHostError::new("worker_transport_failed", error.to_string()))?;
    }
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

    #[tokio::test]
    async fn write_message_accepts_frames_larger_than_one_mib() {
        let mut sink = Vec::new();
        let payload = "x".repeat(2 * 1024 * 1024);
        write_message(
            &mut sink,
            &json!({ "id": "req:1", "ok": true, "result": payload }),
            FrameCodec::protocol(),
        )
        .await
        .expect("frames above 1 MiB should be accepted up to the default frame");
        assert!(sink.len() > 2 * 1024 * 1024);
    }

    #[tokio::test]
    async fn write_message_uses_the_worker_frame_limit() {
        let mut sink = Vec::new();
        let payload = "x".repeat(300);
        let codec = FrameCodec::new(180, 64 * 1024);
        write_message(
            &mut sink,
            &json!({ "id": "1", "ok": true, "result": payload }),
            codec,
        )
        .await
        .expect("payload above the worker frame splits into chunks");
        let text = String::from_utf8(sink).expect("utf8 frames");
        let lines: Vec<_> = text.lines().filter(|line| !line.is_empty()).collect();
        assert!(lines.len() > 1);
        assert!(lines.iter().all(|line| line.len() <= 180));
    }

    #[test]
    fn an_illegal_chunk_does_not_unload_the_worker() {
        assert!(!is_fatal_exchange_error(&WorkerHostError::new(
            "worker_protocol_invalid",
            "Worker response ID did not match the request",
        )));
        assert!(!is_fatal_exchange_error(&WorkerHostError::new(
            "worker_frame_too_large",
            "Worker protocol frame exceeded the limit",
        )));
        assert!(!is_fatal_exchange_error(&WorkerHostError::new(
            "worker_frame_chunk_invalid",
            "Chunk index or count does not match the sequence",
        )));
        assert!(is_fatal_exchange_error(&WorkerHostError::new(
            "worker_closed",
            "Worker closed stdout",
        )));
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

    #[test]
    fn shared_node_runner_scopes_services_by_generation_during_hot_reload() {
        assert!(
            SHARED_NODE_RUNNER_SCRIPT
                .contains("createScopedServices(slotKey(slot.pluginId, slot.generation))"),
            "scoped services must key ownership by (pluginId, generation)"
        );
        assert!(
            SHARED_NODE_RUNNER_SCRIPT.contains("disposeByPlugin(pluginId, generation)"),
            "service disposal must accept generation so hot-reload does not wipe newer generation services"
        );
        assert!(
            SHARED_NODE_RUNNER_SCRIPT
                .contains("sharedServiceContainer.disposeByPlugin(slot.pluginId, slot.generation)"),
            "unmounting a slot must dispose only that slot's generation"
        );
    }
}
