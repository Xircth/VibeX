use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
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

struct CountingDownloader {
    calls: AtomicUsize,
    bytes: Vec<u8>,
}

#[async_trait]
impl Downloader for CountingDownloader {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, PortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(20)).await;
        Ok(self.bytes.clone())
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

#[tokio::test]
async fn rejects_tampered_current_before_returning_lease() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let managed_root = temporary.path().join("managed-tools");
    let lock_store = Arc::new(FileInstallationLockStore::new(managed_root.clone()));
    let bytes = b"verified tool".to_vec();
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(managed_root),
        Arc::new(StaticDownloader(bytes.clone())),
        Arc::new(LocalToolFilesystem),
        Arc::new(RecordingProbe::default()),
        lock_store,
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
        .expect("initial verified install");
    tokio::fs::write(&lease.executable_path, b"tampered")
        .await
        .expect("replace installed binary");

    let error = runtime
        .ensure(&request, &CancellationToken::new())
        .await
        .expect_err("a replaced current binary must not receive a lease");

    assert_eq!(error.code(), "tool_digest_mismatch");
}

#[tokio::test]
async fn rejects_current_lock_with_mismatched_identity() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let managed_root = temporary.path().join("managed-tools");
    let lock_store = Arc::new(FileInstallationLockStore::new(managed_root.clone()));
    let bytes = b"verified tool".to_vec();
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(managed_root.clone()),
        Arc::new(StaticDownloader(bytes.clone())),
        Arc::new(LocalToolFilesystem),
        Arc::new(RecordingProbe::default()),
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
    runtime
        .ensure(&request, &CancellationToken::new())
        .await
        .expect("initial verified install");
    let mut current = lock_store
        .load_current("officecli")
        .await
        .expect("load current")
        .expect("current lock");
    current.tool_id = "another-tool".to_string();
    tokio::fs::write(
        managed_root.join("officecli/current.json"),
        serde_json::to_vec_pretty(&current).expect("serialize tampered lock"),
    )
    .await
    .expect("tamper current identity");

    let error = runtime
        .ensure(&request, &CancellationToken::new())
        .await
        .expect_err("a mismatched current identity must not receive a lease");

    assert_eq!(error.code(), "tool_request_invalid");
}

#[tokio::test]
async fn concurrent_runtimes_share_persistent_install_lock() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let managed_root = temporary.path().join("managed-tools");
    let bytes = b"verified tool".to_vec();
    let downloader = Arc::new(CountingDownloader {
        calls: AtomicUsize::new(0),
        bytes: bytes.clone(),
    });
    let first = ToolRuntime::new(
        ToolRuntimeConfig::new(managed_root.clone()),
        downloader.clone(),
        Arc::new(LocalToolFilesystem),
        Arc::new(RecordingProbe::default()),
        Arc::new(FileInstallationLockStore::new(managed_root.clone())),
    )
    .expect("first runtime");
    let second = ToolRuntime::new(
        ToolRuntimeConfig::new(managed_root.clone()),
        downloader.clone(),
        Arc::new(LocalToolFilesystem),
        Arc::new(RecordingProbe::default()),
        Arc::new(FileInstallationLockStore::new(managed_root)),
    )
    .expect("second runtime");
    let request = ToolRequest {
        tool_id: "officecli".to_string(),
        version: "0.8.0".to_string(),
        target: "aarch64-apple-darwin".to_string(),
        url: "fixture://officecli".to_string(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        executable_name: "officecli".to_string(),
        probe_args: vec!["--version".to_string()],
    };
    let cancellation = CancellationToken::new();

    let (first_result, second_result) = tokio::join!(
        first.ensure(&request, &cancellation),
        second.ensure(&request, &cancellation)
    );

    first_result.expect("first ensure");
    second_result.expect("second ensure");
    assert_eq!(downloader.calls.load(Ordering::SeqCst), 1);
}
