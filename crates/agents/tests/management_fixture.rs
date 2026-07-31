use std::{collections::BTreeMap, path::PathBuf};

use agent_client_protocol::{
    Agent, Client, ConnectionTo,
    schema::{ProtocolVersion, v1::InitializeRequest},
};
use agents::{
    AcpAuthStatusAdapter, AgentAutoApproveMode, AgentConnectionId, AgentConnectionLaunch,
    AgentConnectionManager, AgentError, AgentId, AgentSessionId, AuthenticationObservationState,
    CompanionInjection, CompanionInjectionContext, InjectedRemoteMcpServer,
    InjectedRemoteMcpTransport, SessionLaunchLock,
};
use tokio::{process::Command, sync::mpsc};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

mod support;

async fn fixture_auth_observation(mode: &str) -> Option<agents::AuthenticationObservation> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_management_fixture_acp"))
        .env("VIBEX_FIXTURE_AUTH_STATUS", mode)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn deterministic fixture ACP");
    let stdin = child.stdin.take().expect("fixture stdin");
    let stdout = child.stdout.take().expect("fixture stdout");
    let transport = agent_client_protocol::ByteStreams::new(stdin.compat_write(), stdout.compat());

    Client
        .connect_with(transport, async |connection: ConnectionTo<Agent>| {
            let (_, raw_capabilities) = AcpAuthStatusAdapter::initialize(
                &connection,
                InitializeRequest::new(ProtocolVersion::LATEST),
            )
            .await?;
            Ok::<_, agent_client_protocol::Error>(
                AcpAuthStatusAdapter::observe_if_advertised(
                    &connection,
                    &raw_capabilities,
                    7,
                    std::time::Duration::from_millis(100),
                )
                .await,
            )
        })
        .await
        .expect("fixture auth observation")
}

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
async fn fixture_covers_auth_status_true_false_and_unsupported() {
    assert_eq!(
        fixture_auth_observation("true").await.unwrap().state,
        AuthenticationObservationState::Authenticated
    );
    assert_eq!(
        fixture_auth_observation("false").await.unwrap().state,
        AuthenticationObservationState::Unauthenticated
    );
    assert!(fixture_auth_observation("unsupported").await.is_none());
}

#[tokio::test]
async fn fixture_covers_auth_status_malformed_and_timeout_as_degraded() {
    let malformed = fixture_auth_observation("malformed").await.unwrap();
    assert_eq!(malformed.state, AuthenticationObservationState::Degraded);
    assert_eq!(
        malformed.diagnostic_code.as_deref(),
        Some("auth_status_rpc_failed")
    );

    let missing_method = fixture_auth_observation("method-not-found").await.unwrap();
    assert_eq!(
        missing_method.state,
        AuthenticationObservationState::Degraded
    );
    assert_eq!(
        missing_method.diagnostic_code.as_deref(),
        Some("auth_status_rpc_failed")
    );

    let timeout = fixture_auth_observation("timeout").await.unwrap();
    assert_eq!(timeout.state, AuthenticationObservationState::Degraded);
    assert_eq!(
        timeout.diagnostic_code.as_deref(),
        Some("auth_status_timeout")
    );
}

#[tokio::test]
async fn session_authentication_required_is_a_semantic_runtime_error() {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let agent_id = AgentId::parse("fixture.auth-required").unwrap();
    let temp = tempfile::tempdir().unwrap();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: SessionLaunchLock {
                agent_id,
                absolute_acp_program: PathBuf::from(env!("CARGO_BIN_EXE_management_fixture_acp")),
                args: Vec::new(),
                env: BTreeMap::from([(
                    "VIBEX_FIXTURE_SESSION_AUTH_REQUIRED".to_string(),
                    "1".to_string(),
                )]),
                runtime_version: "fixture".to_string(),
                acp_version: "fixture".to_string(),
            },
            workspace_id: Uuid::new_v4(),
            working_dir: temp.path().to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: Default::default(),
        })
        .await;
    ready.await.unwrap().unwrap();

    let error = manager
        .prepare_session(connection_id, AgentSessionId::new())
        .await
        .unwrap_err();

    assert!(matches!(error, AgentError::AuthenticationRequired(_)));
    manager.disconnect(connection_id).await.unwrap();
}

async fn fixture_session_manager(
    discovery: bool,
) -> (AgentConnectionManager, AgentConnectionId, tempfile::TempDir) {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let agent_id = AgentId::parse("fixture.session-discovery").unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut env = BTreeMap::new();
    if discovery {
        env.insert(
            "VIBEX_FIXTURE_SESSION_DISCOVERY".to_string(),
            "1".to_string(),
        );
    }
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: SessionLaunchLock {
                agent_id,
                absolute_acp_program: PathBuf::from(env!("CARGO_BIN_EXE_management_fixture_acp")),
                args: Vec::new(),
                env,
                runtime_version: "fixture".to_string(),
                acp_version: "fixture".to_string(),
            },
            workspace_id: Uuid::new_v4(),
            working_dir: temp.path().to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: Default::default(),
        })
        .await;
    ready.await.unwrap().unwrap();
    (manager, connection_id, temp)
}

async fn fixture_additional_directories_manager(
    advertised: bool,
) -> (AgentConnectionManager, AgentConnectionId, tempfile::TempDir) {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let agent_id = AgentId::parse("fixture.additional-directories").unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mode = if advertised { "advertised" } else { "absent" };
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: SessionLaunchLock {
                agent_id,
                absolute_acp_program: PathBuf::from(env!("CARGO_BIN_EXE_management_fixture_acp")),
                args: Vec::new(),
                env: BTreeMap::from([(
                    "VIBEX_FIXTURE_ADDITIONAL_DIRECTORIES".to_string(),
                    mode.to_string(),
                )]),
                runtime_version: "fixture".to_string(),
                acp_version: "fixture".to_string(),
            },
            workspace_id: Uuid::new_v4(),
            working_dir: temp.path().to_path_buf(),
            additional_directories: vec![PathBuf::from("/fixture/linked-repo")],
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: Default::default(),
        })
        .await;
    ready.await.unwrap().unwrap();
    (manager, connection_id, temp)
}

#[derive(Debug)]
struct FixtureRemoteMcpInjector;

impl agents::DelegationInjector for FixtureRemoteMcpInjector {
    fn companion(&self, _context: CompanionInjectionContext<'_>) -> CompanionInjection {
        CompanionInjection::Unsupported {
            code: "fixture_companion_disabled",
        }
    }

    fn remote_servers(&self) -> Vec<InjectedRemoteMcpServer> {
        vec![InjectedRemoteMcpServer {
            name: "fixture-http".to_string(),
            transport: InjectedRemoteMcpTransport::Http,
            url: "https://mcp.example.test".to_string(),
            headers: vec![("X-Fixture".to_string(), "present".to_string())],
        }]
    }
}

#[tokio::test]
async fn http_mcp_follows_advertised_capability() {
    for advertised in [true, false] {
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let manager = AgentConnectionManager::new(event_tx);
        manager.install_delegation_injector(std::sync::Arc::new(FixtureRemoteMcpInjector));
        let connection_id = AgentConnectionId::new();
        let agent_id = AgentId::parse("fixture.http-mcp").unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mode = if advertised { "advertised" } else { "absent" };
        let (_snapshot, ready) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_id: agent_id.clone(),
                launch_lock: SessionLaunchLock {
                    agent_id,
                    absolute_acp_program: PathBuf::from(env!(
                        "CARGO_BIN_EXE_management_fixture_acp"
                    )),
                    args: Vec::new(),
                    env: BTreeMap::from([("VIBEX_FIXTURE_MCP_HTTP".to_string(), mode.to_string())]),
                    runtime_version: "fixture".to_string(),
                    acp_version: "fixture".to_string(),
                },
                workspace_id: Uuid::new_v4(),
                working_dir: temp.path().to_path_buf(),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: Default::default(),
            })
            .await;
        ready.await.unwrap().unwrap();
        manager
            .prepare_session(connection_id, AgentSessionId::new())
            .await
            .unwrap();
        manager.disconnect(connection_id).await.unwrap();
    }
}

#[tokio::test]
async fn session_additional_directories_follow_advertised_capability() {
    for advertised in [true, false] {
        let (manager, connection_id, _temp) =
            fixture_additional_directories_manager(advertised).await;
        manager
            .prepare_session(connection_id, AgentSessionId::new())
            .await
            .unwrap();
        manager.disconnect(connection_id).await.unwrap();
    }
}

#[tokio::test]
async fn session_list_and_delete_follow_advertised_capabilities() {
    let (manager, connection_id, _temp) = fixture_session_manager(true).await;
    let page = manager
        .list_sessions(connection_id, None, None)
        .await
        .unwrap();
    assert_eq!(page.sessions[0].acp_session_id, "fixture-listed-session");
    assert_eq!(page.sessions[0].additional_directories, ["/fixture/shared"]);
    assert_eq!(page.sessions[0].meta.as_ref().unwrap()["source"], "fixture");
    manager
        .delete_session(connection_id, "fixture-listed-session")
        .await
        .unwrap();
    manager.disconnect(connection_id).await.unwrap();

    let (manager, connection_id, _temp) = fixture_session_manager(false).await;
    assert!(
        manager
            .list_sessions(connection_id, None, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("does not support session/list")
    );
    assert!(
        manager
            .delete_session(connection_id, "fixture-listed-session")
            .await
            .unwrap_err()
            .to_string()
            .contains("does not support session/delete")
    );
    manager.disconnect(connection_id).await.unwrap();
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
