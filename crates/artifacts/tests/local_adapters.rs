use std::{path::PathBuf, sync::Arc};

use artifacts::{
    ArtifactEvent, ArtifactEventSink, ArtifactService, CurrentToolInstallationResolver,
    LocalArtifactFilesystem, OfficeCliProvider, OfficeProviderConfig, OpenPreview, PortError,
    PreviewProviderRegistry, ProducerEvidence, RecordArtifact, SqliteArtifactRepository,
    SystemClock, TokioOfficeProcessRuntime, TokioTcpReadyProbe, ToolLockEvidence,
};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tool_runtime::{
    CancellationToken, CommandProcessProbe, Downloader, FileInstallationLockStore,
    InstallationLockStore, LocalToolFilesystem, ToolInstallationLock, ToolRuntime,
    ToolRuntimeConfig,
};
use uuid::Uuid;

struct NoopEvents;

struct UnusedDownloader;

#[async_trait]
impl Downloader for UnusedDownloader {
    async fn fetch(&self, _url: &str) -> Result<Vec<u8>, tool_runtime::PortError> {
        Err(tool_runtime::PortError::new("downloader must not be used"))
    }
}

#[async_trait]
impl ArtifactEventSink for NoopEvents {
    async fn append(&self, _event: &ArtifactEvent) -> Result<(), PortError> {
        Ok(())
    }
}

#[tokio::test]
#[cfg(unix)]
async fn sqlite_artifact_and_managed_lock_drive_fake_officecli() {
    use std::os::unix::fs::PermissionsExt;

    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();

    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(workspace.join("slides")).unwrap();
    std::fs::write(workspace.join("slides/demo.pptx"), b"fake pptx").unwrap();
    let managed_root = temp.path().join("managed-tools");
    let executable = managed_root.join("officecli/versions/0.8.0/fake-officecli");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import socket
import sys

port = int(sys.argv[sys.argv.index("--port") + 1])
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen()
print(f"Watch: http://127.0.0.1:{port}", flush=True)
while True:
    connection, _ = server.accept()
    connection.close()
"#,
    )
    .unwrap();
    let executable_bytes = std::fs::read(&executable).unwrap();
    let executable_sha256 = format!("{:x}", Sha256::digest(executable_bytes));
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&executable, permissions).unwrap();
    assert!(executable.is_absolute());

    let lock_store = Arc::new(FileInstallationLockStore::new(managed_root.clone()));
    let lock = ToolInstallationLock {
        schema_version: 1,
        tool_id: "officecli".into(),
        version: "0.8.0".into(),
        target: "test-target".into(),
        source_url: "https://example.invalid/officecli".into(),
        sha256: executable_sha256,
        executable_path: executable.clone(),
        installed_at_unix_ms: 1,
    };
    lock_store
        .commit_current(&lock, &CancellationToken::new())
        .await
        .unwrap();

    let repository = Arc::new(SqliteArtifactRepository::new(pool));
    let base = ArtifactService::new(
        repository.clone(),
        Arc::new(NoopEvents),
        Arc::new(LocalArtifactFilesystem),
    );
    let artifact = base
        .record(RecordArtifact {
            conversation_id: Uuid::new_v4(),
            turn_id: Uuid::new_v4(),
            workspace_id: Some(Uuid::new_v4()),
            scope_root: workspace,
            relative_path: PathBuf::from("slides/demo.pptx"),
            media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                .into(),
            producer: ProducerEvidence {
                plugin_id: "builtin.office".into(),
                plugin_version: "2.0.0".into(),
                provider_id: "officecli".into(),
                tool_lock: ToolLockEvidence {
                    id: format!("{:x}", Sha256::digest(serde_json::to_vec(&lock).unwrap())),
                    tool_id: lock.tool_id.clone(),
                    version: lock.version.clone(),
                    target: lock.target.clone(),
                    sha256: lock.sha256.clone(),
                    executable_path: executable.clone(),
                },
            },
        })
        .await
        .unwrap();

    let newer_executable = managed_root.join("officecli/versions/0.9.0/fake-officecli");
    std::fs::create_dir_all(newer_executable.parent().unwrap()).unwrap();
    std::fs::copy(&executable, &newer_executable).unwrap();
    let newer_lock = ToolInstallationLock {
        version: "0.9.0".into(),
        executable_path: newer_executable,
        installed_at_unix_ms: 2,
        ..lock.clone()
    };
    lock_store
        .commit_current(&newer_lock, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        lock_store
            .load_current("officecli")
            .await
            .unwrap()
            .unwrap()
            .version,
        "0.9.0"
    );

    let provider = Arc::new(OfficeCliProvider::new(
        Arc::new(TokioOfficeProcessRuntime::default()),
        Arc::new(TokioTcpReadyProbe),
        Arc::new(SystemClock),
        OfficeProviderConfig::default(),
    ));
    let runtime = Arc::new(
        ToolRuntime::new(
            ToolRuntimeConfig::new(managed_root),
            Arc::new(UnusedDownloader),
            Arc::new(LocalToolFilesystem),
            Arc::new(CommandProcessProbe),
            lock_store.clone(),
        )
        .unwrap(),
    );
    let service = base.with_previews(
        PreviewProviderRegistry::from_providers([provider]).unwrap(),
        Arc::new(CurrentToolInstallationResolver::new(lock_store, runtime)),
    );

    let lease = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();
    assert_eq!(lease.artifact_id, artifact.id);
    assert_ne!(lease.loopback_port, 0);
    assert_eq!(lease.provider_id, "officecli");
    service.close_preview(lease.id).await.unwrap();
}
