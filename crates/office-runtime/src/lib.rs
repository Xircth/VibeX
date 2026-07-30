use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use agents::conversation::{
    ConversationArtifactPreviewReference, ConversationArtifactReference, ConversationEvent,
};
use artifacts::{
    ArtifactEvent, ArtifactEventSink, ArtifactRecord, ArtifactRepository, ArtifactService,
    ArtifactServiceError, ArtifactToolProvider, CurrentToolInstallationResolver,
    LocalArtifactFilesystem, OfficeCliProvider, OfficeProviderConfig, OpenPreview, PortError,
    PreviewProviderRegistry, ProducerEvidence, RecordArtifact, SqliteArtifactRepository,
    SystemClock, TokioOfficeProcessRuntime, TokioTcpReadyProbe, ToolLockEvidence,
};
use async_trait::async_trait;
use conversations::ConversationEventAppender;
use db::models::conversation_event::AppendConversationEvent;
use plugins::{
    ManagedTool, ManifestSource, Platform, PluginAction, PluginActivation, PluginManifest,
    PluginReadiness, PluginRuntimeError, PluginService, ResolvedToolDistribution,
    SkillAvailabilityPort, SkillDeclaration, ToolDependencyResolver, ToolRuntimeAdapter,
    ToolRuntimePort,
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tool_runtime::{
    CancellationToken, FileInstallationLockStore, HttpDownloader, InstallationLockStore,
    LocalToolFilesystem, ProcessProbe, ToolInstallationLock, ToolRequest, ToolRuntime,
    ToolRuntimeConfig,
};
use uuid::Uuid;

const OFFICE_MANIFEST: &str =
    include_str!("../../../assets/plugins/office/manifest.vibex-plugin.json");
const OFFICE_SKILLS: [(&str, &str); 3] = [
    (
        "office-pptx",
        include_str!("../../../assets/plugins/office/skills/office-pptx/SKILL.md"),
    ),
    (
        "office-docx",
        include_str!("../../../assets/plugins/office/skills/office-docx/SKILL.md"),
    ),
    (
        "office-xlsx",
        include_str!("../../../assets/plugins/office/skills/office-xlsx/SKILL.md"),
    ),
];

struct OfficePluginRuntime {
    inner: Arc<ToolRuntimeAdapter>,
}

#[async_trait]
impl ToolRuntimePort for OfficePluginRuntime {
    async fn ensure(
        &self,
        tool: &ResolvedToolDistribution,
    ) -> Result<ManagedTool, PluginRuntimeError> {
        self.inner.ensure(tool).await
    }

    async fn check_provider(
        &self,
        provider_id: &str,
        tool: &ManagedTool,
    ) -> Result<(), PluginRuntimeError> {
        if provider_id != "officecli"
            || !tool.executable_path.is_absolute()
            || tokio::fs::metadata(&tool.executable_path).await.is_err()
        {
            return Err(PluginRuntimeError::new(
                "provider_unavailable",
                "OfficeCLI provider requires its exact managed executable",
            ));
        }
        Ok(())
    }
}

struct EmbeddedOfficeSkills;

#[async_trait]
impl SkillAvailabilityPort for EmbeddedOfficeSkills {
    async fn check_skill(&self, skill: &SkillDeclaration) -> Result<(), PluginRuntimeError> {
        match OFFICE_SKILLS
            .iter()
            .find(|(id, _)| *id == skill.id.as_str())
        {
            Some((_, source)) if !source.trim().is_empty() => Ok(()),
            _ => Err(PluginRuntimeError::new(
                "skill_missing",
                format!(
                    "bundled Office skill `{}` is not embedded",
                    skill.id.as_str()
                ),
            )),
        }
    }
}

pub struct OfficeRuntime {
    pool: SqlitePool,
    artifacts: ArtifactService,
    compatibility_artifacts: ArtifactService,
    provider: Arc<OfficeCliProvider>,
    locks: Arc<FileInstallationLockStore>,
    tools: Arc<ToolRuntime>,
    plugin_runtime: Arc<ToolRuntimeAdapter>,
    preview_leases: Mutex<HashMap<PathBuf, Vec<Uuid>>>,
    install_cancellations: Arc<StdMutex<HashMap<String, CancellationToken>>>,
    tool_mutation: Mutex<()>,
    managed_root: PathBuf,
    plugins: PluginService,
    office_manifest: PluginManifest,
    restore_enabled_on_startup: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct OfficeRuntimeError {
    code: &'static str,
    message: String,
}

impl OfficeRuntimeError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl OfficeRuntime {
    pub async fn new(pool: SqlitePool, managed_root: PathBuf) -> anyhow::Result<Self> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let locks = Arc::new(FileInstallationLockStore::new(managed_root.clone()));
        let tools = Arc::new(ToolRuntime::new(
            ToolRuntimeConfig::new(managed_root.clone()),
            Arc::new(HttpDownloader::new(
                reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(15))
                    .timeout(Duration::from_secs(10 * 60))
                    .build()?,
            )),
            Arc::new(LocalToolFilesystem),
            Arc::new(OfficeCliProbe),
            locks.clone(),
        )?);
        let plugin_runtime = Arc::new(ToolRuntimeAdapter::new(tools.clone()));
        let plugin_service = PluginService::with_runtime_and_capabilities(
            Platform::host(),
            Arc::new(OfficePluginRuntime {
                inner: plugin_runtime.clone(),
            }),
            Arc::new(EmbeddedOfficeSkills),
            ["officecli"],
        );
        let office_manifest =
            plugin_service.import_manifest(OFFICE_MANIFEST, ManifestSource::Bundled)?;
        sqlx::query(
            "INSERT INTO plugin_v2_registry \
             (plugin_id, schema_version, name, normalized_manifest_json, source, membership, \
              legacy_plugin_id, created_at, updated_at) \
             VALUES (?,2,?,?,'bundled','builtin',NULL,datetime('now','subsec'),datetime('now','subsec')) \
             ON CONFLICT(plugin_id) DO UPDATE SET \
              name=excluded.name, normalized_manifest_json=excluded.normalized_manifest_json, \
              updated_at=datetime('now','subsec')",
        )
        .bind(office_manifest.id.as_str())
        .bind(&office_manifest.name)
        .bind(OFFICE_MANIFEST)
        .execute(&pool)
        .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO plugin_v2_activation \
             (plugin_id, enabled, updated_at) VALUES (?,0,datetime('now','subsec'))",
        )
        .bind(office_manifest.id.as_str())
        .execute(&pool)
        .await?;
        let restore_enabled: bool = sqlx::query_scalar::<_, i64>(
            "SELECT enabled FROM plugin_v2_activation WHERE plugin_id = ?",
        )
        .bind(office_manifest.id.as_str())
        .fetch_one(&pool)
        .await?
            != 0;
        for skill in &office_manifest.skills {
            if !OFFICE_SKILLS.iter().any(|(id, _)| *id == skill.id.as_str()) {
                anyhow::bail!(
                    "bundled Office skill `{}` has no embedded source",
                    skill.id.as_str()
                );
            }
        }
        let provider = Arc::new(OfficeCliProvider::new(
            Arc::new(TokioOfficeProcessRuntime::default()),
            Arc::new(TokioTcpReadyProbe),
            Arc::new(SystemClock),
            OfficeProviderConfig::default(),
        ));
        let tools_resolver = Arc::new(CurrentToolInstallationResolver::new(
            locks.clone(),
            tools.clone(),
        ));
        let artifacts = ArtifactService::new(
            Arc::new(SqliteArtifactRepository::new(pool.clone())),
            Arc::new(ConversationArtifactEventSink { pool: pool.clone() }),
            Arc::new(LocalArtifactFilesystem),
        )
        .with_previews(
            PreviewProviderRegistry::from_providers([provider.clone()])
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
            tools_resolver.clone(),
        );
        let compatibility_artifacts = ArtifactService::new(
            Arc::new(CompatibilityArtifactRepository::default()),
            Arc::new(CompatibilityArtifactEventSink),
            Arc::new(LocalArtifactFilesystem),
        )
        .with_previews(
            PreviewProviderRegistry::from_providers([provider.clone()])
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
            tools_resolver,
        );
        let runtime = Self {
            pool,
            artifacts,
            compatibility_artifacts,
            provider,
            locks,
            tools,
            plugin_runtime,
            preview_leases: Mutex::new(HashMap::new()),
            install_cancellations: Arc::new(StdMutex::new(HashMap::new())),
            tool_mutation: Mutex::new(()),
            managed_root,
            plugins: plugin_service,
            office_manifest,
            restore_enabled_on_startup: restore_enabled,
        };
        Ok(runtime)
    }

    pub async fn detect(&self) -> Result<Option<ToolInstallationLock>, OfficeRuntimeError> {
        let request = office_tool_request()?;
        let Some(lock) = self
            .locks
            .load_current("officecli")
            .await
            .map_err(|error| OfficeRuntimeError::new("IO", error.to_string()))?
        else {
            return Ok(None);
        };
        let expected_executable = self
            .managed_root
            .join(&request.tool_id)
            .join("versions")
            .join(&request.version)
            .join(&request.executable_name);
        if lock.schema_version != 1
            || lock.tool_id != request.tool_id
            || lock.version != request.version
            || lock.target != request.target
            || lock.source_url != request.url
            || !lock.sha256.eq_ignore_ascii_case(&request.sha256)
            || lock.executable_path != expected_executable
            || !lock.executable_path.is_absolute()
            || lock.installed_at_unix_ms == 0
        {
            return Err(OfficeRuntimeError::new(
                "LOCK_INVALID",
                "managed OfficeCLI lock does not match the bundled distribution identity",
            ));
        }
        let bytes = tokio::fs::read(&lock.executable_path)
            .await
            .map_err(|error| OfficeRuntimeError::new("IO", error.to_string()))?;
        let actual = format!("{:x}", Sha256::digest(bytes));
        if !actual.eq_ignore_ascii_case(&request.sha256) {
            return Err(OfficeRuntimeError::new(
                "HASH_MISMATCH",
                "managed OfficeCLI binary does not match its installation lock",
            ));
        }
        Ok(Some(lock))
    }

    pub async fn install(&self, task_id: &str) -> Result<ToolInstallationLock, OfficeRuntimeError> {
        let request = office_tool_request()?;
        let cancellation = CancellationToken::new();
        {
            let mut cancellations = self
                .install_cancellations
                .lock()
                .expect("Office install cancellation registry poisoned");
            if cancellations.contains_key(task_id) {
                return Err(OfficeRuntimeError::new(
                    "INSTALL_IN_PROGRESS",
                    format!("OfficeCLI install task `{task_id}` is already running"),
                ));
            }
            cancellations.insert(task_id.to_owned(), cancellation.clone());
        }
        let _registration =
            InstallCancellationRegistration::new(task_id, self.install_cancellations.clone());
        let _mutation = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(OfficeRuntimeError::new(
                    "CANCELLED",
                    "OfficeCLI installation was cancelled while waiting for another tool mutation",
                ));
            }
            guard = self.tool_mutation.lock() => guard,
        };
        let result = self.tools.ensure(&request, &cancellation).await;
        let lease = result.map_err(|error| {
            OfficeRuntimeError::new(
                match error.code() {
                    "tool_install_cancelled" => "CANCELLED",
                    "tool_digest_mismatch" => "HASH_MISMATCH",
                    "tool_probe_failed" => "PROBE_FAILED",
                    _ => "INSTALL_FAILED",
                },
                error.to_string(),
            )
        })?;
        self.tools
            .release(lease)
            .await
            .map_err(|error| OfficeRuntimeError::new("INSTALL_FAILED", error.to_string()))?;
        let lock = self.detect().await?.ok_or_else(|| {
            OfficeRuntimeError::new("INSTALL_FAILED", "installation lock missing")
        })?;
        self.plugin_runtime
            .release_all()
            .await
            .map_err(|error| OfficeRuntimeError::new("INSTALL_FAILED", error.to_string()))?;
        let enabled = self
            .plugins
            .enable(self.office_manifest.id.as_str())
            .await
            .map_err(|error| OfficeRuntimeError::new("INSTALL_FAILED", error.to_string()))?;
        if enabled.plugin.readiness != PluginReadiness::Ready {
            return Err(OfficeRuntimeError::new(
                "INSTALL_FAILED",
                "bundled Office plugin did not reach ready state",
            ));
        }
        self.persist_enabled(true).await?;
        Ok(lock)
    }

    pub async fn cancel_install(&self, task_id: &str) -> bool {
        let token = self
            .install_cancellations
            .lock()
            .expect("Office install cancellation registry poisoned")
            .get(task_id)
            .cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn start_compatibility_preview(
        &self,
        file_path: &str,
    ) -> Result<u16, OfficeRuntimeError> {
        let raw = Path::new(file_path);
        if !raw.is_absolute()
            || raw
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(OfficeRuntimeError::new(
                "PATH_OUTSIDE_SCOPE",
                "Office preview requires an absolute path without parent traversal",
            ));
        }
        let canonical = tokio::fs::canonicalize(raw)
            .await
            .map_err(|error| OfficeRuntimeError::new("IO", error.to_string()))?;
        let extension = canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase);
        let media_type = match extension.as_deref() {
            Some("pptx") => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Some("docx") => {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
            Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            _ => {
                return Err(OfficeRuntimeError::new(
                    "NOT_OFFICE",
                    "not a supported Office file",
                ));
            }
        };
        let lock = self.detect().await?.ok_or_else(|| {
            OfficeRuntimeError::new("NOT_INSTALLED", "OfficeCLI is not installed")
        })?;
        let scope_root = canonical
            .parent()
            .ok_or_else(|| OfficeRuntimeError::new("PATH_OUTSIDE_SCOPE", "file has no parent"))?
            .to_path_buf();
        let relative_path = canonical
            .file_name()
            .map(PathBuf::from)
            .ok_or_else(|| OfficeRuntimeError::new("PATH_OUTSIDE_SCOPE", "file has no name"))?;
        let artifact = self
            .compatibility_artifacts
            .record(RecordArtifact {
                // The legacy desktop file-preview command has no Conversation
                // context. Nil ids mark this compatibility-only record; canonical
                // Conversation journeys pass real ids through ArtifactService.
                conversation_id: Uuid::nil(),
                turn_id: Uuid::nil(),
                workspace_id: None,
                scope_root,
                relative_path,
                media_type: media_type.into(),
                producer: ProducerEvidence {
                    plugin_id: "vibex.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock: lock_evidence(&lock),
                },
            })
            .await
            .map_err(map_artifact_error)?;
        let lease = self
            .compatibility_artifacts
            .open_preview(OpenPreview {
                artifact_id: artifact.id,
            })
            .await
            .map_err(map_artifact_error)?;
        self.preview_leases
            .lock()
            .await
            .entry(canonical)
            .or_default()
            .push(lease.id);
        Ok(lease.loopback_port)
    }

    pub async fn stop_compatibility_preview(
        &self,
        file_path: &str,
    ) -> Result<(), OfficeRuntimeError> {
        let raw = PathBuf::from(file_path);
        let canonical = tokio::fs::canonicalize(&raw).await.unwrap_or(raw);
        let lease = {
            let mut leases = self.preview_leases.lock().await;
            let lease = leases.get_mut(&canonical).and_then(Vec::pop);
            if leases.get(&canonical).is_some_and(Vec::is_empty) {
                leases.remove(&canonical);
            }
            lease
        };
        if let Some(lease) = lease {
            match self.compatibility_artifacts.close_preview(lease).await {
                Ok(()) | Err(ArtifactServiceError::PreviewLeaseNotFound(_)) => {}
                Err(error) => {
                    self.preview_leases
                        .lock()
                        .await
                        .entry(canonical)
                        .or_default()
                        .push(lease);
                    return Err(map_artifact_error(error));
                }
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<usize, OfficeRuntimeError> {
        let leases = {
            let by_path = self.preview_leases.lock().await;
            by_path
                .iter()
                .flat_map(|(path, leases)| {
                    leases
                        .iter()
                        .copied()
                        .map(|lease| (path.clone(), lease))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
        };
        let count = leases.len();
        for (path, lease) in leases {
            match self.compatibility_artifacts.close_preview(lease).await {
                Ok(()) | Err(ArtifactServiceError::PreviewLeaseNotFound(_)) => {}
                Err(error) => return Err(map_artifact_error(error)),
            }
            let mut by_path = self.preview_leases.lock().await;
            if let Some(path_leases) = by_path.get_mut(&path) {
                path_leases.retain(|candidate| *candidate != lease);
                if path_leases.is_empty() {
                    by_path.remove(&path);
                }
            }
        }
        let canonical = self
            .artifacts
            .shutdown_previews()
            .await
            .map_err(map_artifact_error)?;
        Ok(count + canonical)
    }

    pub async fn reap_idle(&self) -> usize {
        match self.provider.reap_idle().await {
            Ok(report) => {
                let reaped_lease_ids = report
                    .leases
                    .iter()
                    .map(|lease| lease.lease_id)
                    .collect::<std::collections::HashSet<_>>();
                if let Err(error) = self
                    .artifacts
                    .apply_reap_report("officecli", report.clone())
                    .await
                {
                    tracing::warn!("Canonical Office preview reap failed: {error}");
                }
                if let Err(error) = self
                    .compatibility_artifacts
                    .apply_reap_report("officecli", report.clone())
                    .await
                {
                    tracing::warn!("Compatibility Office preview reap failed: {error}");
                }
                let mut by_path = self.preview_leases.lock().await;
                by_path.retain(|_, leases| {
                    leases.retain(|lease| !reaped_lease_ids.contains(lease));
                    !leases.is_empty()
                });
                report.processes_reaped
            }
            Err(error) => {
                tracing::warn!("Office preview idle cleanup failed: {error}");
                0
            }
        }
    }

    pub async fn flush_artifact_events(&self) -> usize {
        match self.artifacts.flush_pending_revision_events(100).await {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!("Artifact event outbox flush failed: {error}");
                0
            }
        }
    }

    pub fn artifact_service(&self) -> ArtifactService {
        self.artifacts.clone()
    }

    pub fn artifact_service_ref(&self) -> &ArtifactService {
        &self.artifacts
    }

    pub fn bundled_plugin(&self) -> &PluginManifest {
        &self.office_manifest
    }

    pub fn plugin_service(&self) -> &PluginService {
        &self.plugins
    }

    pub fn should_restore_enabled_on_startup(&self) -> bool {
        self.restore_enabled_on_startup
    }

    pub async fn restore_enabled_on_startup(&self) -> Result<(), OfficeRuntimeError> {
        if self.restore_enabled_on_startup {
            self.install("startup-restore-office-plugin").await?;
        }
        Ok(())
    }

    pub fn bundled_plugin_snapshot(&self) -> Result<plugins::PluginSnapshot, plugins::PluginError> {
        self.plugins.snapshot(self.office_manifest.id.as_str())
    }

    pub fn bundled_skill_source(&self, skill_id: &str) -> Option<&'static str> {
        OFFICE_SKILLS
            .iter()
            .find_map(|(id, source)| (*id == skill_id).then_some(*source))
    }

    pub fn resolve_bundled_action(
        &self,
        action_id: &str,
    ) -> Result<PluginAction, OfficeRuntimeError> {
        let snapshot = self
            .plugins
            .snapshot(self.office_manifest.id.as_str())
            .map_err(|error| OfficeRuntimeError::new("PLUGIN_NOT_READY", error.to_string()))?;
        if snapshot.activation != PluginActivation::Enabled
            || snapshot.readiness != PluginReadiness::Ready
        {
            return Err(OfficeRuntimeError::new(
                "PLUGIN_NOT_READY",
                "bundled Office plugin must be enabled and ready before action dispatch",
            ));
        }
        self.office_manifest
            .actions
            .iter()
            .find(|action| action.id.as_str() == action_id)
            .cloned()
            .ok_or_else(|| {
                OfficeRuntimeError::new(
                    "ACTION_NOT_FOUND",
                    format!("unknown bundled Office action `{action_id}`"),
                )
            })
    }

    pub async fn set_bundled_enabled(
        &self,
        enabled: bool,
        operation_id: &str,
    ) -> Result<(), OfficeRuntimeError> {
        if enabled {
            self.install(operation_id).await?;
            return Ok(());
        }

        let _mutation = self.tool_mutation.lock().await;
        self.shutdown().await?;
        self.plugins
            .disable(self.office_manifest.id.as_str())
            .map_err(|error| OfficeRuntimeError::new("DISABLE_FAILED", error.to_string()))?;
        self.persist_enabled(false).await
    }

    pub async fn uninstall(&self) -> Result<(), OfficeRuntimeError> {
        let _mutation = self.tool_mutation.lock().await;
        self.shutdown().await?;
        self.plugins
            .disable(self.office_manifest.id.as_str())
            .map_err(|error| OfficeRuntimeError::new("UNINSTALL_FAILED", error.to_string()))?;
        self.persist_enabled(false).await?;
        self.plugin_runtime
            .release_all()
            .await
            .map_err(|error| OfficeRuntimeError::new("UNINSTALL_FAILED", error.to_string()))?;
        self.tools
            .uninstall("officecli")
            .await
            .map_err(|error| OfficeRuntimeError::new("UNINSTALL_FAILED", error.to_string()))
    }

    async fn persist_enabled(&self, enabled: bool) -> Result<(), OfficeRuntimeError> {
        sqlx::query(
            "UPDATE plugin_v2_activation \
             SET enabled = ?, updated_at = datetime('now','subsec') WHERE plugin_id = ?",
        )
        .bind(enabled)
        .bind(self.office_manifest.id.as_str())
        .execute(&self.pool)
        .await
        .map(|_| ())
        .map_err(|error| OfficeRuntimeError::new("PERSIST_FAILED", error.to_string()))
    }
}

struct InstallCancellationRegistration {
    task_id: String,
    cancellations: Arc<StdMutex<HashMap<String, CancellationToken>>>,
}

impl InstallCancellationRegistration {
    fn new(
        task_id: &str,
        cancellations: Arc<StdMutex<HashMap<String, CancellationToken>>>,
    ) -> Self {
        Self {
            task_id: task_id.to_owned(),
            cancellations,
        }
    }
}

impl Drop for InstallCancellationRegistration {
    fn drop(&mut self) {
        self.cancellations
            .lock()
            .expect("Office install cancellation registry poisoned")
            .remove(&self.task_id);
    }
}

fn office_tool_request() -> Result<ToolRequest, OfficeRuntimeError> {
    let manifest = PluginService::new()
        .import_manifest(OFFICE_MANIFEST, ManifestSource::Bundled)
        .map_err(|error| OfficeRuntimeError::new("MANIFEST_INVALID", error.to_string()))?;
    let dependency = manifest.dependencies.first().ok_or_else(|| {
        OfficeRuntimeError::new("MANIFEST_INVALID", "OfficeCLI dependency missing")
    })?;
    let resolved = ToolDependencyResolver::new(Platform::host())
        .resolve(dependency)
        .map_err(|error| OfficeRuntimeError::new("PLATFORM_UNSUPPORTED", error.to_string()))?;
    let executable_name = if resolved.target.contains("windows") {
        "officecli.exe"
    } else {
        "officecli"
    };
    Ok(ToolRequest {
        tool_id: resolved.id.as_str().to_owned(),
        version: resolved.version,
        target: resolved.target,
        url: resolved.url,
        sha256: resolved.sha256,
        executable_name: executable_name.into(),
        probe_args: resolved.probe,
    })
}

fn lock_evidence(lock: &ToolInstallationLock) -> ToolLockEvidence {
    let serialized = serde_json::to_vec(lock).expect("tool lock serializes");
    ToolLockEvidence {
        id: format!("{:x}", Sha256::digest(serialized)),
        tool_id: lock.tool_id.clone(),
        version: lock.version.clone(),
        target: lock.target.clone(),
        sha256: lock.sha256.clone(),
        executable_path: lock.executable_path.clone(),
    }
}

fn map_artifact_error(error: ArtifactServiceError) -> OfficeRuntimeError {
    match error {
        ArtifactServiceError::ToolUnresolved(_) => {
            OfficeRuntimeError::new("NOT_INSTALLED", error.to_string())
        }
        ArtifactServiceError::ProcessLimitReached => {
            OfficeRuntimeError::new("TOO_MANY", error.to_string())
        }
        ArtifactServiceError::PathOutsideScope(_) => {
            OfficeRuntimeError::new("PATH_OUTSIDE_SCOPE", error.to_string())
        }
        ArtifactServiceError::Preview(message) => OfficeRuntimeError::new("START_FAILED", message),
        ArtifactServiceError::Port(port) if port.to_string().contains("timed out") => {
            OfficeRuntimeError::new("PORT_TIMEOUT", port.to_string())
        }
        other => OfficeRuntimeError::new("START_FAILED", other.to_string()),
    }
}

struct ConversationArtifactEventSink {
    pool: SqlitePool,
}

#[async_trait]
impl ArtifactEventSink for ConversationArtifactEventSink {
    async fn append(&self, event: &ArtifactEvent) -> Result<(), PortError> {
        let (conversation_id, turn_id, event, idempotency_key) = match event {
            ArtifactEvent::RevisionRecorded { artifact } => {
                if artifact.conversation_id.is_nil() {
                    return Ok(());
                }
                (
                    artifact.conversation_id,
                    artifact.turn_id,
                    ConversationEvent::ArtifactRevisionRecorded {
                        artifact: ConversationArtifactReference {
                            artifact_id: artifact.artifact_id,
                            workspace_id: artifact.workspace_id,
                            relative_path: artifact.relative_path.to_string_lossy().into_owned(),
                            media_type: artifact.media_type.clone(),
                            content_hash: artifact.content_hash.clone(),
                            revision: artifact.revision,
                            plugin_id: artifact.producer.plugin_id.clone(),
                            plugin_version: artifact.producer.plugin_version.clone(),
                            provider_id: artifact.producer.provider_id.clone(),
                            tool_lock_id: artifact.producer.tool_lock.id.clone(),
                        },
                    },
                    format!(
                        "artifact:{}:revision:{}",
                        artifact.artifact_id, artifact.revision
                    ),
                )
            }
            ArtifactEvent::PreviewOpened { preview } => {
                if preview.conversation_id.is_nil() {
                    return Ok(());
                }
                (
                    preview.conversation_id,
                    preview.turn_id,
                    ConversationEvent::ArtifactPreviewOpened {
                        preview: ConversationArtifactPreviewReference {
                            artifact_id: preview.artifact_id,
                            provider_id: preview.provider_id.clone(),
                            lease_id: preview.lease_id,
                        },
                    },
                    format!("artifact-preview:{}:opened", preview.lease_id),
                )
            }
            ArtifactEvent::PreviewClosed { preview } => {
                if preview.conversation_id.is_nil() {
                    return Ok(());
                }
                (
                    preview.conversation_id,
                    preview.turn_id,
                    ConversationEvent::ArtifactPreviewClosed {
                        preview: ConversationArtifactPreviewReference {
                            artifact_id: preview.artifact_id,
                            provider_id: preview.provider_id.clone(),
                            lease_id: preview.lease_id,
                        },
                    },
                    format!("artifact-preview:{}:closed", preview.lease_id),
                )
            }
            ArtifactEvent::PreviewFailed {
                operation_id,
                conversation_id,
                turn_id,
                artifact_id,
                provider_id,
                message,
            } => {
                if conversation_id.is_nil() {
                    return Ok(());
                }
                (
                    *conversation_id,
                    *turn_id,
                    ConversationEvent::ArtifactPreviewFailed {
                        artifact_id: *artifact_id,
                        provider_id: provider_id.clone(),
                        message: message.clone(),
                    },
                    format!("artifact-preview:{artifact_id}:operation:{operation_id}:failed"),
                )
            }
        };
        let value = serde_json::to_value(&event).map_err(port_error)?;
        let event_kind = value["kind"]
            .as_str()
            .ok_or_else(|| PortError::new("artifact event kind is missing"))?
            .to_owned();
        let normalized_json = serde_json::to_string(&event).map_err(port_error)?;
        ConversationEventAppender::append(
            &self.pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "host",
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&idempotency_key),
            },
        )
        .await
        .map_err(port_error)?;
        Ok(())
    }
}

fn port_error(error: impl std::fmt::Display) -> PortError {
    PortError::new(error.to_string())
}

#[derive(Default)]
struct CompatibilityArtifactRepository {
    records: Mutex<Vec<ArtifactRecord>>,
}

#[async_trait]
impl ArtifactRepository for CompatibilityArtifactRepository {
    async fn latest_for_path(
        &self,
        conversation_id: Uuid,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .records
            .lock()
            .await
            .iter()
            .filter(|record| {
                record.conversation_id == conversation_id
                    && record.scope_root == scope_root
                    && record.relative_path == relative_path
            })
            .max_by_key(|record| record.revision)
            .cloned())
    }

    async fn commit_revision(
        &self,
        record: &ArtifactRecord,
        _event: &ArtifactEvent,
    ) -> Result<(), PortError> {
        self.records.lock().await.push(record.clone());
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .records
            .lock()
            .await
            .iter()
            .filter(|record| record.id == artifact_id)
            .max_by_key(|record| record.revision)
            .cloned())
    }
}

struct CompatibilityArtifactEventSink;

#[async_trait]
impl ArtifactEventSink for CompatibilityArtifactEventSink {
    async fn append(&self, _event: &ArtifactEvent) -> Result<(), PortError> {
        Ok(())
    }
}

struct OfficeCliProbe;

#[async_trait]
impl ProcessProbe for OfficeCliProbe {
    async fn probe(
        &self,
        executable: &Path,
        args: &[String],
    ) -> Result<(), tool_runtime::PortError> {
        if !executable.is_absolute() {
            return Err(tool_runtime::PortError::new(
                "OfficeCLI probe path must be absolute",
            ));
        }
        let status = tokio::process::Command::new(executable)
            .args(args)
            .env("OFFICECLI_SKIP_UPDATE", "1")
            .kill_on_drop(true)
            .status()
            .await
            .map_err(|error| tool_runtime::PortError::new(error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(tool_runtime::PortError::new(format!(
                "OfficeCLI probe exited with {status}"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OfficeRuntime;

    #[tokio::test]
    async fn uninstall_persists_disabled_in_the_v2_registry() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let managed = tempfile::tempdir().expect("managed root");
        let runtime = OfficeRuntime::new(pool.clone(), managed.path().to_path_buf())
            .await
            .expect("create Office runtime");

        runtime
            .persist_enabled(true)
            .await
            .expect("persist enabled");
        let enabled: i64 =
            sqlx::query_scalar("SELECT enabled FROM plugin_v2_activation WHERE plugin_id = ?")
                .bind(runtime.office_manifest.id.as_str())
                .fetch_one(&pool)
                .await
                .expect("load activation");
        assert_eq!(enabled, 1);

        runtime.uninstall().await.expect("uninstall");
        let enabled: i64 =
            sqlx::query_scalar("SELECT enabled FROM plugin_v2_activation WHERE plugin_id = ?")
                .bind(runtime.office_manifest.id.as_str())
                .fetch_one(&pool)
                .await
                .expect("reload activation");
        assert_eq!(enabled, 0);
    }

    #[tokio::test]
    async fn enabled_startup_restore_is_deferred_and_cannot_block_construction() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        let managed = tempfile::tempdir().expect("managed root");
        let first = OfficeRuntime::new(pool.clone(), managed.path().to_path_buf())
            .await
            .expect("create first runtime");
        first.persist_enabled(true).await.expect("persist enabled");
        drop(first);

        let restored = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            OfficeRuntime::new(pool, managed.path().to_path_buf()),
        )
        .await
        .expect("runtime construction must not perform network installation")
        .expect("create restored runtime");
        assert!(restored.should_restore_enabled_on_startup());
        assert_eq!(
            restored
                .bundled_plugin_snapshot()
                .expect("plugin snapshot")
                .activation,
            plugins::PluginActivation::Disabled
        );
    }
}
