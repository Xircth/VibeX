use std::{collections::BTreeMap, path::PathBuf};

use agents::{
    AgentAuthenticationStatus, AgentId, AgentLifecycleState, AgentManagementSnapshot,
    AgentSessionConfigChoice, AgentSessionConfigOption, ComponentProbeState,
    RequiredComponentProbe, SessionBinding, SessionGate, SessionGateError, SessionGateInput,
    SessionLaunchLock, validate_session_defaults,
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
        absolute_acp_program: PathBuf::from("/managed/acp"),
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
