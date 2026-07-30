use agent_client_protocol::{
    Client, ConnectionTo,
    schema::{ProtocolVersion, v1::InitializeRequest},
};
use tokio::process::Command;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

mod support;

#[tokio::test]
async fn management_fixture_acp_reports_initialize_and_version() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_management_fixture_acp"))
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn deterministic fixture ACP");
    let stdin = child.stdin.take().expect("fixture stdin");
    let stdout = child.stdout.take().expect("fixture stdout");
    let transport = agent_client_protocol::ByteStreams::new(stdin.compat_write(), stdout.compat());

    let response = Client
        .connect_with(transport, async |connection: ConnectionTo<_>| {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::LATEST))
                .block_task()
                .await
        })
        .await
        .expect("fixture initialize response");

    assert_eq!(response.protocol_version, ProtocolVersion::LATEST);
    let info = response
        .agent_info
        .expect("fixture implementation metadata");
    assert_eq!(info.name, "vibex-management-fixture");
    assert_eq!(info.version, "1.0.0-test");
}

#[tokio::test]
async fn management_boundary_fakes_are_deterministic() {
    use std::{collections::HashMap, path::PathBuf, sync::Mutex};

    use agents::{
        Clock, InstallInvocation, InstallOutput, InstallRunner, NativeFileSystem,
        RegistryFetchResponse, RegistryFetcher,
    };
    use chrono::{TimeZone, Utc};
    use support::management::{
        FakeInstallRunner, FakeRegistryFetcher, FixedClock, MemoryNativeFileSystem,
    };

    let fetcher = FakeRegistryFetcher {
        response: RegistryFetchResponse {
            status: 200,
            body: br#"{"agents":[]}"#.to_vec(),
            etag: Some("fixture-etag".to_string()),
        },
        requests: Mutex::new(Vec::new()),
    };
    let response = fetcher
        .fetch("https://registry.example.test/registry.json", None)
        .await
        .unwrap();
    assert_eq!(response.status, 200);

    let runner = FakeInstallRunner {
        output: InstallOutput {
            status_code: 0,
            stdout: b"installed".to_vec(),
            stderr: Vec::new(),
        },
        invocations: Mutex::new(Vec::new()),
    };
    runner
        .run(InstallInvocation {
            program: PathBuf::from("/fixture/installer"),
            args: vec!["install".to_string()],
            env: HashMap::new(),
            cwd: None,
        })
        .await
        .unwrap();
    assert_eq!(runner.invocations.lock().unwrap().len(), 1);

    let now = Utc.with_ymd_and_hms(2026, 7, 29, 8, 0, 0).unwrap();
    assert_eq!(FixedClock(now).now(), now);

    let filesystem = MemoryNativeFileSystem::default();
    let path = PathBuf::from("/fixture/config.json");
    filesystem.write_atomic(&path, b"{}").await.unwrap();
    assert_eq!(filesystem.read(&path).await.unwrap(), Some(b"{}".to_vec()));
    assert_eq!(filesystem.metadata(&path).await.unwrap().unwrap().length, 2);
}
