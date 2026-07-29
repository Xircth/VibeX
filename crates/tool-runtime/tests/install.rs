use std::{
    collections::HashMap,
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
    CancellationToken, Downloader, InstallationLockStore, PortError, ProcessProbe, ToolFilesystem,
    ToolInstallationLock, ToolRequest, ToolRuntime, ToolRuntimeConfig,
};

struct FakeDownloader {
    bytes: Vec<u8>,
}

#[async_trait]
impl Downloader for FakeDownloader {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, PortError> {
        Ok(self.bytes.clone())
    }
}

#[derive(Default)]
struct FakeFilesystem {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
    cancel_on_rename: Mutex<Option<CancellationToken>>,
}

impl FakeFilesystem {
    fn has_files_under(&self, path: &Path) -> bool {
        self.files
            .lock()
            .expect("filesystem lock")
            .keys()
            .any(|candidate| candidate.starts_with(path))
    }

    fn cancel_during_next_rename(&self, cancellation: CancellationToken) {
        *self.cancel_on_rename.lock().expect("rename cancellation") = Some(cancellation);
    }

    fn seed_file(&self, path: impl Into<PathBuf>, bytes: &[u8]) {
        self.files
            .lock()
            .expect("filesystem lock")
            .insert(path.into(), bytes.to_vec());
    }
}

#[async_trait]
impl ToolFilesystem for FakeFilesystem {
    async fn create_dir_all(&self, _path: &Path) -> Result<(), PortError> {
        Ok(())
    }

    async fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), PortError> {
        self.files
            .lock()
            .expect("filesystem lock")
            .insert(path.to_owned(), bytes.to_vec());
        Ok(())
    }

    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, PortError> {
        self.files
            .lock()
            .expect("filesystem lock")
            .get(path)
            .cloned()
            .ok_or_else(|| PortError::new("missing file"))
    }

    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError> {
        if self
            .files
            .lock()
            .expect("filesystem lock")
            .keys()
            .any(|candidate| candidate == path || candidate.starts_with(path))
        {
            Ok(path.to_owned())
        } else {
            Err(PortError::new("missing file"))
        }
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<(), PortError> {
        let mut files = self.files.lock().expect("filesystem lock");
        let entries = files
            .iter()
            .filter(|(path, _)| path.starts_with(from))
            .map(|(path, bytes)| {
                (
                    to.join(path.strip_prefix(from).expect("prefix")),
                    bytes.clone(),
                )
            })
            .collect::<Vec<_>>();
        files.retain(|path, _| !path.starts_with(from));
        files.extend(entries);
        if let Some(cancellation) = self
            .cancel_on_rename
            .lock()
            .expect("rename cancellation")
            .take()
        {
            cancellation.cancel();
        }
        Ok(())
    }

    async fn remove_dir_all(&self, path: &Path) -> Result<(), PortError> {
        self.files
            .lock()
            .expect("filesystem lock")
            .retain(|candidate, _| !candidate.starts_with(path));
        Ok(())
    }
}

#[derive(Default)]
struct FakeProbe {
    calls: AtomicUsize,
}

#[async_trait]
impl ProcessProbe for FakeProbe {
    async fn probe(&self, _executable: &Path, _args: &[String]) -> Result<(), PortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[derive(Default)]
struct FakeLockStore {
    current: Mutex<HashMap<String, ToolInstallationLock>>,
    cancel_on_commit: Mutex<Option<CancellationToken>>,
}

impl FakeLockStore {
    fn cancel_during_next_commit(&self, cancellation: CancellationToken) {
        *self.cancel_on_commit.lock().expect("commit cancellation") = Some(cancellation);
    }
}

struct BlockingLockStore;

#[async_trait]
impl InstallationLockStore for FakeLockStore {
    async fn load_current(&self, tool_id: &str) -> Result<Option<ToolInstallationLock>, PortError> {
        Ok(self
            .current
            .lock()
            .expect("lock store")
            .get(tool_id)
            .cloned())
    }

    async fn commit_current(
        &self,
        lock: &ToolInstallationLock,
        cancellation: &CancellationToken,
    ) -> Result<(), PortError> {
        if let Some(cancellation) = self
            .cancel_on_commit
            .lock()
            .expect("commit cancellation")
            .take()
        {
            cancellation.cancel();
        }
        if cancellation.is_cancelled() {
            return Err(PortError::new(
                "installation cancelled before current pointer commit",
            ));
        }
        self.current
            .lock()
            .expect("lock store")
            .insert(lock.tool_id.clone(), lock.clone());
        Ok(())
    }
}

#[async_trait]
impl InstallationLockStore for BlockingLockStore {
    async fn acquire_install_lock(
        &self,
        _tool_id: &str,
    ) -> Result<Box<dyn tool_runtime::InstallationLockGuard>, PortError> {
        std::future::pending().await
    }

    async fn load_current(
        &self,
        _tool_id: &str,
    ) -> Result<Option<ToolInstallationLock>, PortError> {
        Ok(None)
    }

    async fn commit_current(
        &self,
        _lock: &ToolInstallationLock,
        _cancellation: &CancellationToken,
    ) -> Result<(), PortError> {
        Ok(())
    }
}

#[tokio::test]
async fn rejects_digest_mismatch_before_probe() {
    let probe = Arc::new(FakeProbe::default());
    let lock_store = Arc::new(FakeLockStore::default());
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        Arc::new(FakeDownloader {
            bytes: b"tampered binary".to_vec(),
        }),
        Arc::new(FakeFilesystem::default()),
        probe.clone(),
        lock_store.clone(),
    )
    .expect("absolute managed root");
    let request = ToolRequest {
        tool_id: "officecli".to_string(),
        version: "0.8.0".to_string(),
        target: "aarch64-apple-darwin".to_string(),
        url: "https://downloads.vibex.dev/officecli".to_string(),
        sha256: "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
        executable_name: "officecli".to_string(),
        probe_args: vec!["--version".to_string()],
    };

    let error = runtime
        .ensure(&request, &CancellationToken::new())
        .await
        .expect_err("digest mismatch must reject the install");

    assert_eq!(error.code(), "tool_digest_mismatch");
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
    assert!(
        lock_store
            .load_current("officecli")
            .await
            .expect("lock lookup")
            .is_none()
    );
}

struct CatalogDownloader {
    artifacts: HashMap<String, Vec<u8>>,
}

struct CountingDownloader {
    calls: AtomicUsize,
    bytes: Vec<u8>,
}

#[async_trait]
impl Downloader for CountingDownloader {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, PortError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(self.bytes.clone())
    }
}

#[async_trait]
impl Downloader for CatalogDownloader {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, PortError> {
        self.artifacts
            .get(url)
            .cloned()
            .ok_or_else(|| PortError::new(format!("missing fixture artifact `{url}`")))
    }
}

#[derive(Default)]
struct SelectiveProbe;

#[async_trait]
impl ProcessProbe for SelectiveProbe {
    async fn probe(&self, executable: &Path, args: &[String]) -> Result<(), PortError> {
        assert!(executable.is_absolute(), "probe paths must be absolute");
        if args.iter().any(|arg| arg == "--reject") {
            Err(PortError::new("probe rejected artifact"))
        } else {
            Ok(())
        }
    }
}

fn request(version: &str, bytes: &[u8], probe_args: &[&str]) -> ToolRequest {
    ToolRequest {
        tool_id: "officecli".to_string(),
        version: version.to_string(),
        target: "aarch64-apple-darwin".to_string(),
        url: format!("fixture://officecli/{version}"),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        executable_name: "officecli".to_string(),
        probe_args: probe_args.iter().map(|arg| (*arg).to_string()).collect(),
    }
}

#[tokio::test]
async fn upgrade_is_atomic() {
    let filesystem = Arc::new(FakeFilesystem::default());
    let lock_store = Arc::new(FakeLockStore::default());
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        Arc::new(CatalogDownloader {
            artifacts: HashMap::from([
                ("fixture://officecli/1.0.0".to_string(), b"v1".to_vec()),
                ("fixture://officecli/2.0.0".to_string(), b"v2".to_vec()),
            ]),
        }),
        filesystem.clone(),
        Arc::new(SelectiveProbe),
        lock_store.clone(),
    )
    .expect("absolute managed root");

    runtime
        .ensure(
            &request("1.0.0", b"v1", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("v1 install");

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = runtime
        .upgrade(&request("2.0.0", b"v2", &["--version"]), &cancelled)
        .await
        .expect_err("cancelled upgrade");
    assert_eq!(error.code(), "tool_install_cancelled");
    assert_eq!(
        lock_store
            .load_current("officecli")
            .await
            .expect("current after cancellation")
            .expect("v1 remains current")
            .version,
        "1.0.0"
    );
    assert!(!filesystem.has_files_under(Path::new("/managed-tools/officecli/staging")));

    let error = runtime
        .upgrade(
            &request("2.0.0", b"v2", &["--reject"]),
            &CancellationToken::new(),
        )
        .await
        .expect_err("failed probe must reject upgrade");
    assert_eq!(error.code(), "tool_probe_failed");
    assert_eq!(
        lock_store
            .load_current("officecli")
            .await
            .expect("current after failed probe")
            .expect("v1 remains current")
            .version,
        "1.0.0"
    );
    assert!(!filesystem.has_files_under(Path::new("/managed-tools/officecli/staging")));

    let lease = runtime
        .upgrade(
            &request("2.0.0", b"v2", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("verified v2 upgrade");
    assert_eq!(lease.version, "2.0.0");
    assert_eq!(
        lock_store
            .load_current("officecli")
            .await
            .expect("current after upgrade")
            .expect("v2 is current")
            .version,
        "2.0.0"
    );
    assert!(filesystem.has_files_under(Path::new("/managed-tools/officecli/versions/1.0.0")));
}

#[tokio::test]
async fn concurrent_ensure_uses_single_install_attempt() {
    let downloader = Arc::new(CountingDownloader {
        calls: AtomicUsize::new(0),
        bytes: b"v1".to_vec(),
    });
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        downloader.clone(),
        Arc::new(FakeFilesystem::default()),
        Arc::new(SelectiveProbe),
        Arc::new(FakeLockStore::default()),
    )
    .expect("absolute managed root");
    let request = request("1.0.0", b"v1", &["--version"]);
    let cancellation = CancellationToken::new();

    let (first, second) = tokio::join!(
        runtime.ensure(&request, &cancellation),
        runtime.ensure(&request, &cancellation)
    );

    first.expect("first ensure");
    second.expect("second ensure");
    assert_eq!(downloader.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancellation_interrupts_waiting_for_install_lock() {
    let runtime = Arc::new(
        ToolRuntime::new(
            ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
            Arc::new(FakeDownloader {
                bytes: b"v1".to_vec(),
            }),
            Arc::new(FakeFilesystem::default()),
            Arc::new(SelectiveProbe),
            Arc::new(BlockingLockStore),
        )
        .expect("absolute managed root"),
    );
    let cancellation = CancellationToken::new();
    let task = {
        let runtime = runtime.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            runtime
                .ensure(&request("1.0.0", b"v1", &["--version"]), &cancellation)
                .await
        })
    };
    tokio::task::yield_now().await;
    cancellation.cancel();

    let error = tokio::time::timeout(Duration::from_millis(100), task)
        .await
        .expect("lock wait must be cancellable")
        .expect("ensure task")
        .expect_err("cancelled lock wait");

    assert_eq!(error.code(), "tool_install_cancelled");
}

#[tokio::test]
async fn cancellation_at_current_commit_keeps_previous_version() {
    let lock_store = Arc::new(FakeLockStore::default());
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        Arc::new(CatalogDownloader {
            artifacts: HashMap::from([
                ("fixture://officecli/1.0.0".to_string(), b"v1".to_vec()),
                ("fixture://officecli/2.0.0".to_string(), b"v2".to_vec()),
            ]),
        }),
        Arc::new(FakeFilesystem::default()),
        Arc::new(SelectiveProbe),
        lock_store.clone(),
    )
    .expect("absolute managed root");
    runtime
        .ensure(
            &request("1.0.0", b"v1", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("v1 install");
    let cancellation = CancellationToken::new();
    lock_store.cancel_during_next_commit(cancellation.clone());

    let error = runtime
        .upgrade(&request("2.0.0", b"v2", &["--version"]), &cancellation)
        .await
        .expect_err("cancellation at the commit boundary must reject v2");

    assert_eq!(error.code(), "tool_install_cancelled");
    assert_eq!(
        lock_store
            .load_current("officecli")
            .await
            .expect("current after cancellation")
            .expect("v1 remains current")
            .version,
        "1.0.0"
    );
}

#[tokio::test]
async fn release_delays_cleanup_for_active_lease() {
    let filesystem = Arc::new(FakeFilesystem::default());
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        Arc::new(CatalogDownloader {
            artifacts: HashMap::from([
                ("fixture://officecli/1.0.0".to_string(), b"v1".to_vec()),
                ("fixture://officecli/2.0.0".to_string(), b"v2".to_vec()),
                ("fixture://officecli/3.0.0".to_string(), b"v3".to_vec()),
            ]),
        }),
        filesystem.clone(),
        Arc::new(SelectiveProbe),
        Arc::new(FakeLockStore::default()),
    )
    .expect("absolute managed root");

    let v1_lease = runtime
        .ensure(
            &request("1.0.0", b"v1", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("v1 install");
    runtime
        .upgrade(
            &request("2.0.0", b"v2", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("v2 upgrade");
    runtime
        .upgrade(
            &request("3.0.0", b"v3", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("v3 upgrade");

    assert!(filesystem.has_files_under(Path::new("/managed-tools/officecli/versions/1.0.0")));
    runtime.release(v1_lease).await.expect("release v1 lease");

    assert!(!filesystem.has_files_under(Path::new("/managed-tools/officecli/versions/1.0.0")));
    assert!(filesystem.has_files_under(Path::new("/managed-tools/officecli/versions/2.0.0")));
    assert!(filesystem.has_files_under(Path::new("/managed-tools/officecli/versions/3.0.0")));
}

#[tokio::test]
async fn rejects_managed_path_escape_before_download() {
    let downloader = Arc::new(CountingDownloader {
        calls: AtomicUsize::new(0),
        bytes: b"v1".to_vec(),
    });
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        downloader.clone(),
        Arc::new(FakeFilesystem::default()),
        Arc::new(SelectiveProbe),
        Arc::new(FakeLockStore::default()),
    )
    .expect("absolute managed root");
    let mut request = request("1.0.0", b"v1", &["--version"]);
    request.tool_id = "../outside-managed-root".to_string();

    let error = runtime
        .ensure(&request, &CancellationToken::new())
        .await
        .expect_err("tool ids must not escape the managed root");

    assert_eq!(error.code(), "tool_request_invalid");
    assert_eq!(downloader.calls.load(Ordering::SeqCst), 0);
}

struct BlockingDownloader {
    started: tokio::sync::Notify,
}

#[async_trait]
impl Downloader for BlockingDownloader {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, PortError> {
        self.started.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancellation_interrupts_download_and_cleans_staging() {
    let downloader = Arc::new(BlockingDownloader {
        started: tokio::sync::Notify::new(),
    });
    let filesystem = Arc::new(FakeFilesystem::default());
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        downloader.clone(),
        filesystem.clone(),
        Arc::new(SelectiveProbe),
        Arc::new(FakeLockStore::default()),
    )
    .expect("absolute managed root");
    let cancellation = CancellationToken::new();
    let request = request("1.0.0", b"never-returned", &["--version"]);
    let install = runtime.ensure(&request, &cancellation);
    tokio::pin!(install);

    tokio::select! {
        () = downloader.started.notified() => {}
        result = &mut install => panic!("download unexpectedly completed: {result:?}"),
    }
    cancellation.cancel();
    let error = tokio::time::timeout(Duration::from_millis(100), &mut install)
        .await
        .expect("cancellation should interrupt a pending download")
        .expect_err("cancelled install");

    assert_eq!(error.code(), "tool_install_cancelled");
    assert!(!filesystem.has_files_under(Path::new("/managed-tools/officecli/staging")));
}

#[tokio::test]
async fn cancellation_during_rename_does_not_switch_current() {
    let filesystem = Arc::new(FakeFilesystem::default());
    let lock_store = Arc::new(FakeLockStore::default());
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        Arc::new(CatalogDownloader {
            artifacts: HashMap::from([
                ("fixture://officecli/1.0.0".to_string(), b"v1".to_vec()),
                ("fixture://officecli/2.0.0".to_string(), b"v2".to_vec()),
            ]),
        }),
        filesystem.clone(),
        Arc::new(SelectiveProbe),
        lock_store.clone(),
    )
    .expect("absolute managed root");
    runtime
        .ensure(
            &request("1.0.0", b"v1", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("v1 install");
    let cancellation = CancellationToken::new();
    filesystem.cancel_during_next_rename(cancellation.clone());

    let error = runtime
        .upgrade(&request("2.0.0", b"v2", &["--version"]), &cancellation)
        .await
        .expect_err("rename-window cancellation");

    assert_eq!(error.code(), "tool_install_cancelled");
    assert_eq!(
        lock_store
            .load_current("officecli")
            .await
            .expect("current lookup")
            .expect("v1 remains current")
            .version,
        "1.0.0"
    );
    assert!(!filesystem.has_files_under(Path::new("/managed-tools/officecli/versions/2.0.0")));
}

#[tokio::test]
async fn next_install_reconciles_abandoned_staging_attempt() {
    let filesystem = Arc::new(FakeFilesystem::default());
    filesystem.seed_file(
        "/managed-tools/officecli/staging/abandoned/installation-attempt.json",
        b"abandoned",
    );
    let runtime = ToolRuntime::new(
        ToolRuntimeConfig::new(PathBuf::from("/managed-tools")),
        Arc::new(CatalogDownloader {
            artifacts: HashMap::from([("fixture://officecli/1.0.0".to_string(), b"v1".to_vec())]),
        }),
        filesystem.clone(),
        Arc::new(SelectiveProbe),
        Arc::new(FakeLockStore::default()),
    )
    .expect("absolute managed root");

    runtime
        .ensure(
            &request("1.0.0", b"v1", &["--version"]),
            &CancellationToken::new(),
        )
        .await
        .expect("fresh install after reconciliation");

    assert!(!filesystem.has_files_under(Path::new("/managed-tools/officecli/staging")));
}
