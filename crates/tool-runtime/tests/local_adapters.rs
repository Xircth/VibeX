use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tool_runtime::{
    CancellationToken, Downloader, FileInstallationLockStore, InstallationLockStore,
    LocalToolFilesystem, PortError, ProcessProbe, ToolRequest, ToolRuntime, ToolRuntimeConfig,
};

struct StaticDownloader(Vec<u8>);

#[async_trait]
impl Downloader for StaticDownloader {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, PortError> {
        Ok(self.0.clone())
    }
}

#[derive(Default)]
struct RecordingProbe {
    path: Mutex<Option<PathBuf>>,
}

#[async_trait]
impl ProcessProbe for RecordingProbe {
    async fn probe(&self, executable: &Path, _args: &[String]) -> Result<(), PortError> {
        *self.path.lock().expect("probe path") = Some(executable.to_owned());
        Ok(())
    }
}

#[tokio::test]
async fn persists_versioned_installation_lock() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let managed_root = temporary.path().join("managed-tools");
    let lock_store = Arc::new(FileInstallationLockStore::new(managed_root.clone()));
    let probe = Arc::new(RecordingProbe::default());
    let bytes = b"verified tool".to_vec();
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(managed_root.clone()),
        Arc::new(StaticDownloader(bytes.clone())),
        Arc::new(LocalToolFilesystem),
        probe.clone(),
        lock_store.clone(),
    )
    .expect("absolute managed root");
    let request = ToolRequest {
        tool_id: "officecli".to_string(),
        version: "0.8.0".to_string(),
        target: "aarch64-apple-darwin".to_string(),
        url: "fixture://officecli".to_string(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        executable_name: "officecli".to_string(),
        probe_args: vec!["--version".to_string()],
    };

    let lease = runtime
        .ensure(&request, &CancellationToken::new())
        .await
        .expect("verified install");
    let current = lock_store
        .load_current("officecli")
        .await
        .expect("load current")
        .expect("current lock");

    assert!(lease.executable_path.is_absolute());
    assert!(lease.executable_path.exists());
    assert_eq!(current.executable_path, lease.executable_path);
    assert_eq!(current.source_url, "fixture://officecli");
    assert!(current.installed_at_unix_ms > 0);
    assert!(
        managed_root
            .join("officecli/versions/0.8.0/installation-lock.json")
            .exists()
    );
    assert!(managed_root.join("officecli/current.json").exists());
    assert!(
        probe
            .path
            .lock()
            .expect("probe path")
            .as_ref()
            .expect("probe called")
            .is_absolute()
    );
}
