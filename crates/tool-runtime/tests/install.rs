use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
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
}

impl FakeFilesystem {
    fn has_files_under(&self, path: &Path) -> bool {
        self.files
            .lock()
            .expect("filesystem lock")
            .keys()
            .any(|candidate| candidate.starts_with(path))
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
}

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

    async fn commit_current(&self, lock: &ToolInstallationLock) -> Result<(), PortError> {
        self.current
            .lock()
            .expect("lock store")
            .insert(lock.tool_id.clone(), lock.clone());
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
