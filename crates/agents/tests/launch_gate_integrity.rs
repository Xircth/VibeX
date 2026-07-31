use std::{collections::BTreeMap, fs, path::PathBuf};

use agents::{AgentId, LaunchComponentEvidence, LaunchGate, LaunchGateError, SessionLaunchLock};
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[tokio::test]
async fn launch_gate_integrity_rejects_tampered_components_before_spawn() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = temp.path().join("runtime");
    let acp = temp.path().join("acp");
    fs::write(&runtime, b"trusted runtime").unwrap();
    fs::write(&acp, b"trusted acp").unwrap();

    let lock = SessionLaunchLock {
        agent_id: AgentId::parse("vendor.fixture").unwrap(),
        absolute_acp_program: acp.clone(),
        args: Vec::new(),
        env: BTreeMap::new(),
        runtime_version: "1.0.0".to_string(),
        acp_version: "1.0.0".to_string(),
    };
    let components = vec![
        LaunchComponentEvidence {
            component_kind: "agent_runtime".to_string(),
            absolute_path: runtime.clone(),
            expected_sha256: digest(b"trusted runtime"),
        },
        LaunchComponentEvidence {
            component_kind: "acp_adapter".to_string(),
            absolute_path: acp,
            expected_sha256: digest(b"trusted acp"),
        },
    ];

    LaunchGate::verify(lock.clone(), &components).await.unwrap();
    fs::write(&runtime, b"tampered runtime").unwrap();

    let error = LaunchGate::verify(lock, &components).await.unwrap_err();
    assert!(matches!(
        error,
        LaunchGateError::HashMismatch {
            component_kind,
            ..
        } if component_kind == "agent_runtime"
    ));
}

#[tokio::test]
async fn launch_gate_integrity_rejects_missing_or_relative_components() {
    let lock = SessionLaunchLock {
        agent_id: AgentId::parse("vendor.fixture").unwrap(),
        absolute_acp_program: PathBuf::from("/fixture/acp"),
        args: Vec::new(),
        env: BTreeMap::new(),
        runtime_version: "1.0.0".to_string(),
        acp_version: "1.0.0".to_string(),
    };

    let missing = LaunchComponentEvidence {
        component_kind: "acp_adapter".to_string(),
        absolute_path: PathBuf::from("/definitely/missing/vibex-acp"),
        expected_sha256: digest(b"trusted"),
    };
    assert!(matches!(
        LaunchGate::verify(lock.clone(), &[missing]).await,
        Err(LaunchGateError::Missing { .. })
    ));

    let relative = LaunchComponentEvidence {
        component_kind: "agent_runtime".to_string(),
        absolute_path: PathBuf::from("relative/runtime"),
        expected_sha256: digest(b"trusted"),
    };
    assert!(matches!(
        LaunchGate::verify(lock, &[relative]).await,
        Err(LaunchGateError::NonAbsolutePath { .. })
    ));
}
