use std::{process::Stdio, time::Duration};

use agent_client_protocol::{
    Client, ConnectionTo,
    schema::{ProtocolVersion, v1::InitializeRequest},
};
use tokio::{process::Command, time::timeout};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// Manual release gate for a locally installed ACP executable.
///
/// Example:
/// VIBEX_REAL_ACP_COMMAND=/absolute/path/to/opencode
/// VIBEX_REAL_ACP_ARGS='["acp"]'
/// VIBEX_REAL_ACP_TIMEOUT_SECS=120 # optional for cold package installs
/// cargo test -p agents --test real_acp_probe -- --ignored --nocapture
#[tokio::test]
#[ignore = "requires an explicitly selected local ACP executable"]
async fn installed_agent_completes_a_real_acp_initialize_handshake() {
    let command =
        std::env::var("VIBEX_REAL_ACP_COMMAND").expect("VIBEX_REAL_ACP_COMMAND is required");
    assert!(
        std::path::Path::new(&command).is_absolute(),
        "the release probe must use an absolute executable path"
    );
    let args: Vec<String> = serde_json::from_str(
        &std::env::var("VIBEX_REAL_ACP_ARGS").unwrap_or_else(|_| "[]".to_string()),
    )
    .expect("VIBEX_REAL_ACP_ARGS must be a JSON string array");
    let timeout_seconds = std::env::var("VIBEX_REAL_ACP_TIMEOUT_SECS")
        .map(|value| {
            value
                .parse::<u64>()
                .expect("VIBEX_REAL_ACP_TIMEOUT_SECS must be a positive integer")
        })
        .unwrap_or(20);
    assert!(
        timeout_seconds > 0,
        "VIBEX_REAL_ACP_TIMEOUT_SECS must be positive"
    );

    let mut child = Command::new(&command)
        .args(&args)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn selected ACP executable");
    let stdin = child.stdin.take().expect("ACP stdin");
    let stdout = child.stdout.take().expect("ACP stdout");
    let transport = agent_client_protocol::ByteStreams::new(stdin.compat_write(), stdout.compat());

    let response = timeout(
        Duration::from_secs(timeout_seconds),
        Client.connect_with(transport, async |connection: ConnectionTo<_>| {
            connection
                .send_request(InitializeRequest::new(ProtocolVersion::LATEST))
                .block_task()
                .await
        }),
    )
    .await
    .expect("ACP initialize timed out")
    .expect("ACP initialize failed");

    let info = response
        .agent_info
        .expect("ACP initialize response omitted agent metadata");
    eprintln!(
        "ACP initialize succeeded: command={command}, name={}, version={}",
        info.name, info.version
    );
}
