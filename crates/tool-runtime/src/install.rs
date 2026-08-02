use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    CancellationToken, Downloader, InstallationAttempt, InstallationLockStore, ProcessProbe,
    ToolFilesystem, ToolInstallationLock, ToolLease, ToolRequest, ToolRuntimeConfig,
    ToolRuntimeError, types::validate_managed_component,
};

pub struct ToolRuntime {
    config: ToolRuntimeConfig,
    downloader: Arc<dyn Downloader>,
    filesystem: Arc<dyn ToolFilesystem>,
    probe: Arc<dyn ProcessProbe>,
    lock_store: Arc<dyn InstallationLockStore>,
    install_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    lifecycle: Arc<Mutex<Lifecycle>>,
}

#[derive(Default)]
struct Lifecycle {
    versions: HashMap<String, Vec<String>>,
    leases: HashMap<Uuid, (String, String)>,
    deleting_tools: HashSet<String>,
}

struct DeletionGuard {
    lifecycle: Arc<Mutex<Lifecycle>>,
    tool_id: String,
}

impl Drop for DeletionGuard {
    fn drop(&mut self) {
        self.lifecycle
            .lock()
            .expect("tool lifecycle registry poisoned")
            .deleting_tools
            .remove(&self.tool_id);
    }
}

impl ToolRuntime {
    pub fn new(
        config: ToolRuntimeConfig,
        downloader: Arc<dyn Downloader>,
        filesystem: Arc<dyn ToolFilesystem>,
        probe: Arc<dyn ProcessProbe>,
        lock_store: Arc<dyn InstallationLockStore>,
    ) -> Result<Self, ToolRuntimeError> {
        config.validate()?;
        Ok(Self {
            config,
            downloader,
            filesystem,
            probe,
            lock_store,
            install_locks: Mutex::new(HashMap::new()),
            lifecycle: Arc::new(Mutex::new(Lifecycle::default())),
        })
    }

    pub async fn ensure(
        &self,
        request: &ToolRequest,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease, ToolRuntimeError> {
        request.validate()?;
        let install_lock = self.install_lock(&request.tool_id);
        let _guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(ToolRuntimeError::cancelled(&request.tool_id, &request.version));
            }
            guard = install_lock.lock() => guard,
        };
        let _persistent_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(ToolRuntimeError::cancelled(&request.tool_id, &request.version));
            }
            result = self.lock_store.acquire_install_lock(&request.tool_id) => {
                result.map_err(|error| {
                    ToolRuntimeError::port("acquire persistent install lock", error)
                })?
            }
        };
        self.reconcile_staging(&request.tool_id).await?;
        if let Some(current) = self
            .lock_store
            .load_current(&request.tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("load current installation", error))?
            && current.version == request.version
            && current.sha256.eq_ignore_ascii_case(&request.sha256)
        {
            let expected_executable = self
                .config
                .managed_root
                .join(&request.tool_id)
                .join("versions")
                .join(&request.version)
                .join(&request.executable_name);
            if current.schema_version != 1
                || current.tool_id != request.tool_id
                || current.target != request.target
                || current.source_url != request.url
                || current.installed_at_unix_ms == 0
                || !current.executable_path.is_absolute()
                || current.executable_path != expected_executable
            {
                return Err(ToolRuntimeError::invalid_request(
                    "current tool lock identity does not match the requested distribution",
                ));
            }
            let current_bytes = self
                .filesystem
                .read_file(&current.executable_path)
                .await
                .map_err(|error| ToolRuntimeError::port("read current tool", error))?;
            let actual_sha256 = sha256(&current_bytes);
            if !actual_sha256.eq_ignore_ascii_case(&request.sha256) {
                return Err(ToolRuntimeError::digest_mismatch(
                    &request.tool_id,
                    &request.sha256,
                    &actual_sha256,
                ));
            }
            return self.acquire_lease(&current);
        }

        self.install(request, cancellation).await
    }

    pub async fn upgrade(
        &self,
        request: &ToolRequest,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease, ToolRuntimeError> {
        request.validate()?;
        let install_lock = self.install_lock(&request.tool_id);
        let _guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(ToolRuntimeError::cancelled(&request.tool_id, &request.version));
            }
            guard = install_lock.lock() => guard,
        };
        let _persistent_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(ToolRuntimeError::cancelled(&request.tool_id, &request.version));
            }
            result = self.lock_store.acquire_install_lock(&request.tool_id) => {
                result.map_err(|error| {
                    ToolRuntimeError::port("acquire persistent install lock", error)
                })?
            }
        };
        self.reconcile_staging(&request.tool_id).await?;
        self.install(request, cancellation).await
    }

    async fn reconcile_staging(&self, tool_id: &str) -> Result<(), ToolRuntimeError> {
        self.filesystem
            .remove_dir_all(&self.config.managed_root.join(tool_id).join("staging"))
            .await
            .map_err(|error| ToolRuntimeError::port("reconcile abandoned staging", error))
    }

    fn install_lock(&self, tool_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.install_locks
            .lock()
            .expect("tool install lock registry poisoned")
            .entry(tool_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub async fn release(&self, lease: ToolLease) -> Result<(), ToolRuntimeError> {
        let tool_id = lease.tool_id.clone();
        let install_lock = self.install_lock(&tool_id);
        let install_guard = install_lock.lock_owned().await;
        let persistent_guard = self
            .lock_store
            .acquire_install_lock(&tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("acquire persistent install lock", error))?;
        let deletion = self.begin_deletion(&tool_id)?;
        self.release_locked(lease, install_guard, persistent_guard, deletion)
            .await
    }

    async fn release_locked(
        &self,
        lease: ToolLease,
        install_guard: tokio::sync::OwnedMutexGuard<()>,
        persistent_guard: Box<dyn crate::InstallationLockGuard>,
        deletion: DeletionGuard,
    ) -> Result<(), ToolRuntimeError> {
        let (tool_id, version) = {
            let lifecycle = self
                .lifecycle
                .lock()
                .expect("tool lifecycle registry poisoned");
            lifecycle
                .leases
                .get(&lease.lease_id)
                .cloned()
                .ok_or_else(ToolRuntimeError::invalid_lease)?
        };
        if tool_id != lease.tool_id || version != lease.version {
            return Err(ToolRuntimeError::invalid_lease());
        }

        let current = self
            .lock_store
            .load_current(&tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("load current installation", error))?;
        let current_version = current.as_ref().map(|lock| lock.version.as_str());
        let removable = {
            let lifecycle = self
                .lifecycle
                .lock()
                .expect("tool lifecycle registry poisoned");
            let versions = lifecycle
                .versions
                .get(&tool_id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let rollback = versions
                .iter()
                .rev()
                .find(|candidate| Some(candidate.as_str()) != current_version)
                .map(String::as_str);
            versions
                .iter()
                .filter(|candidate| {
                    let candidate = candidate.as_str();
                    Some(candidate) != current_version
                        && Some(candidate) != rollback
                        && !lifecycle.leases.iter().any(
                            |(lease_id, (leased_tool, leased_version))| {
                                *lease_id != lease.lease_id
                                    && leased_tool == &tool_id
                                    && leased_version == candidate
                            },
                        )
                })
                .cloned()
                .collect::<Vec<_>>()
        };

        let filesystem = self.filesystem.clone();
        let managed_root = self.config.managed_root.clone();
        let lifecycle = self.lifecycle.clone();
        let cleanup = tokio::spawn(async move {
            let _install_guard = install_guard;
            let _persistent_guard = persistent_guard;
            let _deletion = deletion;
            for removable_version in &removable {
                let version_dir = managed_root
                    .join(&tool_id)
                    .join("versions")
                    .join(removable_version);
                filesystem
                    .remove_dir_all(&version_dir)
                    .await
                    .map_err(|error| {
                        ToolRuntimeError::port("remove unleased tool version", error)
                    })?;
            }
            let mut lifecycle = lifecycle.lock().expect("tool lifecycle registry poisoned");
            if !removable.is_empty()
                && let Some(versions) = lifecycle.versions.get_mut(&tool_id)
            {
                versions.retain(|version| !removable.contains(version));
            }
            lifecycle.leases.remove(&lease.lease_id);
            Ok(())
        });
        cleanup.await.map_err(supervised_deletion_join)?
    }

    /// Pins an already verified, versioned installation for a consumer such
    /// as a long-running artifact preview.
    pub fn lease_installed(
        &self,
        lock: &ToolInstallationLock,
    ) -> Result<ToolLease, ToolRuntimeError> {
        validate_managed_component("tool id", &lock.tool_id, false)?;
        validate_managed_component("tool version", &lock.version, true)?;
        let expected_version_dir = self
            .config
            .managed_root
            .join(&lock.tool_id)
            .join("versions")
            .join(&lock.version);
        if lock.schema_version != 1
            || !lock.executable_path.is_absolute()
            || lock.executable_path.parent() != Some(expected_version_dir.as_path())
        {
            return Err(ToolRuntimeError::invalid_request(
                "installed tool lock is outside its exact managed version directory",
            ));
        }
        self.acquire_lease(lock)
    }

    pub async fn uninstall(&self, tool_id: &str) -> Result<(), ToolRuntimeError> {
        validate_managed_component("tool id", tool_id, false)?;
        let install_lock = self.install_lock(tool_id);
        let install_guard = install_lock.lock_owned().await;
        let persistent_guard = self
            .lock_store
            .acquire_install_lock(tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("acquire persistent install lock", error))?;
        let deletion = self.begin_deletion(tool_id)?;
        self.uninstall_locked(tool_id, install_guard, persistent_guard, deletion)
            .await
    }

    async fn uninstall_locked(
        &self,
        tool_id: &str,
        install_guard: tokio::sync::OwnedMutexGuard<()>,
        persistent_guard: Box<dyn crate::InstallationLockGuard>,
        deletion: DeletionGuard,
    ) -> Result<(), ToolRuntimeError> {
        let has_active_lease = self
            .lifecycle
            .lock()
            .expect("tool lifecycle registry poisoned")
            .leases
            .values()
            .any(|(leased_tool, _)| leased_tool == tool_id);
        if has_active_lease {
            return Err(ToolRuntimeError::invalid_request(format!(
                "tool `{tool_id}` still has active leases"
            )));
        }
        let filesystem = self.filesystem.clone();
        let tool_dir = self.config.managed_root.join(tool_id);
        let lifecycle = self.lifecycle.clone();
        let tool_id = tool_id.to_owned();
        let cleanup = tokio::spawn(async move {
            let _install_guard = install_guard;
            let _persistent_guard = persistent_guard;
            let _deletion = deletion;
            filesystem
                .remove_dir_all(&tool_dir)
                .await
                .map_err(|error| ToolRuntimeError::port("remove managed tool", error))?;
            lifecycle
                .lock()
                .expect("tool lifecycle registry poisoned")
                .versions
                .remove(&tool_id);
            Ok(())
        });
        cleanup.await.map_err(supervised_deletion_join)?
    }

    fn begin_deletion(&self, tool_id: &str) -> Result<DeletionGuard, ToolRuntimeError> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .expect("tool lifecycle registry poisoned");
        if !lifecycle.deleting_tools.insert(tool_id.to_owned()) {
            return Err(ToolRuntimeError::invalid_request(format!(
                "tool `{tool_id}` is already being modified"
            )));
        }
        Ok(DeletionGuard {
            lifecycle: self.lifecycle.clone(),
            tool_id: tool_id.to_owned(),
        })
    }

    fn acquire_lease(&self, lock: &ToolInstallationLock) -> Result<ToolLease, ToolRuntimeError> {
        let lease_id = Uuid::new_v4();
        let mut lifecycle = self
            .lifecycle
            .lock()
            .expect("tool lifecycle registry poisoned");
        if lifecycle.deleting_tools.contains(&lock.tool_id) {
            return Err(ToolRuntimeError::invalid_request(format!(
                "tool `{}` is being modified",
                lock.tool_id
            )));
        }
        let versions = lifecycle.versions.entry(lock.tool_id.clone()).or_default();
        if !versions.contains(&lock.version) {
            versions.push(lock.version.clone());
        }
        lifecycle
            .leases
            .insert(lease_id, (lock.tool_id.clone(), lock.version.clone()));
        Ok(ToolLease {
            tool_id: lock.tool_id.clone(),
            version: lock.version.clone(),
            executable_path: PathBuf::from(&lock.executable_path),
            lease_id,
        })
    }

    async fn install(
        &self,
        request: &ToolRequest,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease, ToolRuntimeError> {
        if cancellation.is_cancelled() {
            return Err(ToolRuntimeError::cancelled(
                &request.tool_id,
                &request.version,
            ));
        }
        let attempt = InstallationAttempt {
            id: Uuid::new_v4(),
            tool_id: request.tool_id.clone(),
            version: request.version.clone(),
            staging_dir: PathBuf::new(),
            started_at_unix_ms: unix_time_ms(),
        };
        let staging_dir = self
            .config
            .managed_root
            .join(&request.tool_id)
            .join("staging")
            .join(attempt.id.to_string());
        let attempt = InstallationAttempt {
            staging_dir: staging_dir.clone(),
            ..attempt
        };
        let staging_executable = staging_dir.join(&request.executable_name);
        self.filesystem
            .create_dir_all(&staging_dir)
            .await
            .map_err(|error| ToolRuntimeError::port("create staging directory", error))?;
        let attempt_json = serde_json::to_vec_pretty(&attempt).map_err(|error| {
            ToolRuntimeError::invalid_request(format!("serialize installation attempt: {error}"))
        })?;
        self.filesystem
            .write_file(
                &staging_dir.join("installation-attempt.json"),
                &attempt_json,
            )
            .await
            .map_err(|error| ToolRuntimeError::port("persist installation attempt", error))?;

        let result = self
            .install_from_staging(request, cancellation, &attempt, &staging_executable)
            .await;
        if result.is_err() {
            let _ = self.filesystem.remove_dir_all(&staging_dir).await;
        }
        result
    }

    async fn install_from_staging(
        &self,
        request: &ToolRequest,
        cancellation: &CancellationToken,
        attempt: &InstallationAttempt,
        staging_executable: &std::path::Path,
    ) -> Result<ToolLease, ToolRuntimeError> {
        let bytes = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(ToolRuntimeError::cancelled(
                    &request.tool_id,
                    &request.version,
                ));
            }
            result = self.downloader.fetch(&request.url) => {
                result.map_err(|error| ToolRuntimeError::port("download tool", error))?
            }
        };
        if cancellation.is_cancelled() {
            return Err(ToolRuntimeError::cancelled(
                &request.tool_id,
                &request.version,
            ));
        }
        self.filesystem
            .write_file(staging_executable, &bytes)
            .await
            .map_err(|error| ToolRuntimeError::port("write staged tool", error))?;
        self.filesystem
            .set_executable(staging_executable)
            .await
            .map_err(|error| ToolRuntimeError::port("mark staged tool executable", error))?;

        let actual_sha256 = sha256(&bytes);
        if !actual_sha256.eq_ignore_ascii_case(&request.sha256) {
            return Err(ToolRuntimeError::digest_mismatch(
                &request.tool_id,
                &request.sha256,
                &actual_sha256,
            ));
        }
        if cancellation.is_cancelled() {
            return Err(ToolRuntimeError::cancelled(
                &request.tool_id,
                &request.version,
            ));
        }

        let canonical_executable = self
            .filesystem
            .canonicalize(staging_executable)
            .await
            .map_err(|error| ToolRuntimeError::port("canonicalize staged tool", error))?;
        let canonical_staging_dir = self
            .filesystem
            .canonicalize(&attempt.staging_dir)
            .await
            .map_err(|error| ToolRuntimeError::port("canonicalize staging directory", error))?;
        if !canonical_executable.is_absolute()
            || !canonical_staging_dir.is_absolute()
            || !canonical_executable.starts_with(&canonical_staging_dir)
        {
            return Err(ToolRuntimeError::invalid_request(
                "probe executable escaped the absolute staging directory",
            ));
        }
        self.probe
            .probe(&canonical_executable, &request.probe_args)
            .await
            .map_err(|error| {
                ToolRuntimeError::probe_failed(&request.tool_id, &request.version, error)
            })?;
        if cancellation.is_cancelled() {
            return Err(ToolRuntimeError::cancelled(
                &request.tool_id,
                &request.version,
            ));
        }

        let version_dir = self
            .config
            .managed_root
            .join(&request.tool_id)
            .join("versions")
            .join(&request.version);
        let versions_dir = version_dir
            .parent()
            .expect("version directory always has a parent");
        self.filesystem
            .create_dir_all(versions_dir)
            .await
            .map_err(|error| ToolRuntimeError::port("create versions directory", error))?;
        self.filesystem
            .rename(&attempt.staging_dir, &version_dir)
            .await
            .map_err(|error| ToolRuntimeError::port("commit tool version", error))?;
        if cancellation.is_cancelled() {
            let _ = self.filesystem.remove_dir_all(&version_dir).await;
            return Err(ToolRuntimeError::cancelled(
                &request.tool_id,
                &request.version,
            ));
        }
        let lock = ToolInstallationLock {
            schema_version: 1,
            tool_id: request.tool_id.clone(),
            version: request.version.clone(),
            target: request.target.clone(),
            source_url: request.url.clone(),
            sha256: actual_sha256,
            executable_path: version_dir.join(&request.executable_name),
            installed_at_unix_ms: unix_time_ms(),
        };
        if let Err(error) = self.lock_store.commit_current(&lock, cancellation).await {
            let _ = self.filesystem.remove_dir_all(&version_dir).await;
            if cancellation.is_cancelled() {
                return Err(ToolRuntimeError::cancelled(
                    &request.tool_id,
                    &request.version,
                ));
            }
            return Err(ToolRuntimeError::port("commit current installation", error));
        }
        self.acquire_lease(&lock)
    }
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn supervised_deletion_join(error: tokio::task::JoinError) -> ToolRuntimeError {
    ToolRuntimeError::port(
        "join supervised tool deletion",
        crate::PortError::new(error.to_string()),
    )
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
