use std::{collections::BTreeMap, path::PathBuf};

use agents::{
    AgentAuthenticationStatus, AgentId, AgentLifecycleState, AgentManagementSnapshot,
    AgentSessionConfigChoice, AgentSessionConfigOption, ComponentProbeState,
    RequiredComponentProbe, SessionBinding, SessionGate, SessionGateError, SessionGateInput,
    SessionLaunchLock, resolve_session_defaults, validate_session_defaults,
};

fn snapshot(id: &str, lifecycle: AgentLifecycleState, enabled: bool) -> AgentManagementSnapshot {
    AgentManagementSnapshot {
        agent_id: AgentId::parse(id).unwrap(),
        enabled,
        lifecycle,
        authentication: AgentAuthenticationStatus::ApiKey,
        required_components: vec![RequiredComponentProbe {
            component_id: "runtime".to_string(),
            state: ComponentProbeState::Verified,
        }],
    }
}

fn lock(id: &str) -> SessionLaunchLock {
    SessionLaunchLock {
        agent_id: AgentId::parse(id).unwrap(),
        // The gate requires a host-absolute program path, and a leading `/` is
        // only rooted on Windows rather than absolute.
        absolute_acp_program: if cfg!(windows) {
            PathBuf::from(r"C:\managed\acp.exe")
        } else {
            PathBuf::from("/managed/acp")
        },
        args: vec!["serve".to_string()],
        env: BTreeMap::new(),
        runtime_version: "2.0.0".to_string(),
        acp_version: "1.1.0".to_string(),
    }
}

#[test]
fn session_gate_rejects_disabled_not_ready_and_retired_agents() {
    let gate = SessionGate;
    for (lifecycle, enabled, expected) in [
        (
            AgentLifecycleState::Ready,
            false,
            SessionGateError::Disabled,
        ),
        (
            AgentLifecycleState::NeedsAuth,
            true,
            SessionGateError::NotReady(AgentLifecycleState::NeedsAuth),
        ),
        (
            AgentLifecycleState::NeedsRepair,
            true,
            SessionGateError::NotReady(AgentLifecycleState::NeedsRepair),
        ),
        (
            AgentLifecycleState::PlatformUnsupported,
            true,
            SessionGateError::NotReady(AgentLifecycleState::PlatformUnsupported),
        ),
        (
            AgentLifecycleState::Retired,
            true,
            SessionGateError::Retired,
        ),
    ] {
        assert_eq!(
            gate.authorize(SessionGateInput {
                snapshot: snapshot("codex", lifecycle, enabled),
                current_lock: Some(lock("codex")),
                requested_defaults: BTreeMap::new(),
                advertised_option_ids: Vec::new(),
                existing_binding: None,
                explicit_rebind: false,
            })
            .unwrap_err(),
            expected
        );
    }

    let authorized = gate
        .authorize(SessionGateInput {
            snapshot: snapshot("codex", AgentLifecycleState::Ready, true),
            current_lock: Some(lock("codex")),
            requested_defaults: BTreeMap::from([
                ("model".to_string(), serde_json::json!("gpt-5")),
                ("stale".to_string(), serde_json::json!(true)),
            ]),
            advertised_option_ids: vec!["model".to_string()],
            existing_binding: None,
            explicit_rebind: false,
        })
        .unwrap();
    assert!(authorized.absolute_acp_program.is_absolute());
    assert_eq!(authorized.defaults.len(), 1);
    assert_eq!(authorized.stale_default_ids, ["stale"]);
    assert_eq!(authorized.runtime_version, "2.0.0");
    assert_eq!(authorized.acp_version, "1.1.0");

    let other = SessionBinding {
        agent_id: AgentId::parse("claude_code").unwrap(),
        event_boundary_sequence: 41,
    };
    let input = SessionGateInput {
        snapshot: snapshot("codex", AgentLifecycleState::Ready, true),
        current_lock: Some(lock("codex")),
        requested_defaults: BTreeMap::new(),
        advertised_option_ids: Vec::new(),
        existing_binding: Some(other),
        explicit_rebind: false,
    };
    assert_eq!(
        gate.authorize(input.clone()).unwrap_err(),
        SessionGateError::ExplicitRebindRequired
    );
    let rebound = gate
        .authorize(SessionGateInput {
            explicit_rebind: true,
            ..input
        })
        .unwrap();
    assert_eq!(rebound.rebind_event_boundary_sequence, Some(42));
}

#[test]
fn session_gate_rejects_needs_repair_even_without_an_installation_lock() {
    let error = SessionGate
        .authorize(SessionGateInput {
            snapshot: snapshot("claude_code", AgentLifecycleState::NeedsRepair, true),
            current_lock: None,
            requested_defaults: BTreeMap::new(),
            advertised_option_ids: Vec::new(),
            existing_binding: None,
            explicit_rebind: false,
        })
        .unwrap_err();
    assert_eq!(
        error,
        SessionGateError::NotReady(AgentLifecycleState::NeedsRepair)
    );
    assert!(!error.to_string().contains("Installation lock"));
    assert!(error.to_string().contains("Repair or reinstall"));
}

#[test]
fn session_launch_rejection_includes_the_stored_diagnostic_excerpt() {
    let output = concat!(
        "npm view dist.integrity failed: npm error code ECONNREFUSED\n",
        "npm error syscall connect\n",
        "npm error     at ClientRequest.<anonymous> (minipass-fetch/lib/index.js:130:14)\n",
        "npm error If you are behind a proxy, please make sure that the\n",
        "npm error 'proxy' config is set properly.  See: 'npm help config'\n",
    );
    let message = agents::session_launch_rejection_message(
        &SessionGateError::NotReady(AgentLifecycleState::NeedsRepair),
        Some(output),
    );
    assert!(message.contains("Repair or reinstall it in Settings."));
    assert!(message.contains("ECONNREFUSED"));
    assert!(message.contains("proxy"));
    assert!(!message.contains("minipass-fetch"));
    assert!(!message.contains("Installation lock"));
}

#[test]
fn session_defaults_keep_only_current_raw_acp_values() {
    let defaults = BTreeMap::from([
        ("model".to_string(), serde_json::json!("removed-model")),
        ("fast".to_string(), serde_json::json!(true)),
        ("missing".to_string(), serde_json::json!("old")),
    ]);
    let options = vec![
        AgentSessionConfigOption {
            key: "model".to_string(),
            label: "Model".to_string(),
            description: None,
            category: Some("model".to_string()),
            value: Some(serde_json::json!("current-model")),
            choices: vec![AgentSessionConfigChoice {
                value: serde_json::json!("current-model"),
                label: "Current".to_string(),
                description: None,
            }],
            dependency: None,
        },
        AgentSessionConfigOption {
            key: "fast".to_string(),
            label: "Fast".to_string(),
            description: None,
            category: Some("model_config".to_string()),
            value: Some(serde_json::json!(false)),
            choices: Vec::new(),
            dependency: None,
        },
    ];

    let validation = validate_session_defaults(defaults, &options);

    assert_eq!(
        validation.valid,
        BTreeMap::from([("fast".to_string(), serde_json::json!(true))])
    );
    assert_eq!(validation.stale_ids, ["missing", "model"]);
}

#[test]
fn resolve_session_defaults_keeps_all_ids_stale_without_a_catalog() {
    let requested = BTreeMap::from([("model".to_string(), serde_json::json!("opus"))]);
    let validation = resolve_session_defaults(requested, vec!["broken".to_string()], None);

    assert!(validation.valid.is_empty());
    assert_eq!(validation.stale_ids, ["broken", "model"]);
}
