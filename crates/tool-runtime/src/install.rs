use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    CancellationToken, Downloader, InstallationAttempt, InstallationLockStore, ProcessProbe,
    ToolFilesystem, ToolInstallationLock, ToolLease, ToolRequest, ToolRuntimeConfig,
    ToolRuntimeError,
};

pub struct ToolRuntime {
    config: ToolRuntimeConfig,
    downloader: Arc<dyn Downloader>,
    filesystem: Arc<dyn ToolFilesystem>,
    probe: Arc<dyn ProcessProbe>,
    lock_store: Arc<dyn InstallationLockStore>,
    install_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    lifecycle: Mutex<Lifecycle>,
}

#[derive(Default)]
struct Lifecycle {
    versions: HashMap<String, Vec<String>>,
    leases: HashMap<Uuid, (String, String)>,
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
            lifecycle: Mutex::new(Lifecycle::default()),
        })
    }

    pub async fn ensure(
        &self,
        request: &ToolRequest,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease, ToolRuntimeError> {
        request.validate()?;
        let install_lock = self.install_lock(&request.tool_id);
        let _guard = install_lock.lock().await;
        let _persistent_guard = self
            .lock_store
            .acquire_install_lock(&request.tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("acquire persistent install lock", error))?;
        self.reconcile_staging(&request.tool_id).await?;
        if let Some(current) = self
            .lock_store
            .load_current(&request.tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("load current installation", error))?
            && current.version == request.version
            && current.sha256.eq_ignore_ascii_case(&request.sha256)
        {
            let expected_version_dir = self
                .config
                .managed_root
                .join(&request.tool_id)
                .join("versions")
                .join(&request.version);
            if !current.executable_path.is_absolute()
                || !current.executable_path.starts_with(expected_version_dir)
            {
                return Err(ToolRuntimeError::invalid_request(
                    "current tool lock points outside its managed version directory",
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
            return Ok(self.acquire_lease(&current));
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
        let _guard = install_lock.lock().await;
        let _persistent_guard = self
            .lock_store
            .acquire_install_lock(&request.tool_id)
            .await
            .map_err(|error| ToolRuntimeError::port("acquire persistent install lock", error))?;
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
        let (tool_id, version) = {
            let mut lifecycle = self
                .lifecycle
                .lock()
                .expect("tool lifecycle registry poisoned");
            lifecycle
                .leases
                .remove(&lease.lease_id)
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
                        && !lifecycle
                            .leases
                            .values()
                            .any(|(leased_tool, leased_version)| {
                                leased_tool == &tool_id && leased_version == candidate
                            })
                })
                .cloned()
                .collect::<Vec<_>>()
        };

        for removable_version in &removable {
            let version_dir = self
                .config
                .managed_root
                .join(&tool_id)
                .join("versions")
                .join(removable_version);
            self.filesystem
                .remove_dir_all(&version_dir)
                .await
                .map_err(|error| ToolRuntimeError::port("remove unleased tool version", error))?;
        }
        if !removable.is_empty() {
            let mut lifecycle = self
                .lifecycle
                .lock()
                .expect("tool lifecycle registry poisoned");
            if let Some(versions) = lifecycle.versions.get_mut(&tool_id) {
                versions.retain(|version| !removable.contains(version));
            }
        }
        Ok(())
    }

    fn acquire_lease(&self, lock: &ToolInstallationLock) -> ToolLease {
        let lease_id = Uuid::new_v4();
        let mut lifecycle = self
            .lifecycle
            .lock()
            .expect("tool lifecycle registry poisoned");
        let versions = lifecycle.versions.entry(lock.tool_id.clone()).or_default();
        if !versions.contains(&lock.version) {
            versions.push(lock.version.clone());
        }
        lifecycle
            .leases
            .insert(lease_id, (lock.tool_id.clone(), lock.version.clone()));
        ToolLease {
            tool_id: lock.tool_id.clone(),
            version: lock.version.clone(),
            executable_path: PathBuf::from(&lock.executable_path),
            lease_id,
        }
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
        if let Err(error) = self.lock_store.commit_current(&lock).await {
            let _ = self.filesystem.remove_dir_all(&version_dir).await;
            return Err(ToolRuntimeError::port("commit current installation", error));
        }
        Ok(self.acquire_lease(&lock))
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

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
