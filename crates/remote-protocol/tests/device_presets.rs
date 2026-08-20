use remote_protocol::{CreatePairingRequest, DevicePermissionPreset};

#[test]
fn workstation_includes_plugin_write_and_excludes_host_admin() {
    let scopes = DevicePermissionPreset::Workstation.scopes();
    assert!(scopes.contains(&"application.call"));
    assert!(scopes.contains(&"plugin.write"));
    assert!(scopes.contains(&"workflow.run"));
    assert!(!scopes.contains(&"device.pair"));
    assert!(!scopes.contains(&"device.revoke"));
    assert!(!scopes.contains(&"workflow.internal"));
}

#[test]
fn companion_is_a_strict_subset_of_workstation() {
    let workstation = DevicePermissionPreset::Workstation
        .scopes()
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    for scope in DevicePermissionPreset::Companion.scopes() {
        assert!(
            workstation.contains(scope),
            "{scope} must remain pairable on a workstation"
        );
    }
    assert!(
        !DevicePermissionPreset::Companion
            .scopes()
            .contains(&"plugin.write")
    );
    assert!(
        !DevicePermissionPreset::Companion
            .scopes()
            .contains(&"automation.write")
    );
}

#[test]
fn pairing_request_keeps_legacy_scope_only_payloads() {
    let request: CreatePairingRequest = serde_json::from_value(serde_json::json!({
        "requested_scopes": ["conversation.read"]
    }))
    .unwrap();
    assert_eq!(request.preset, None);
    assert_eq!(request.requested_scopes, vec!["conversation.read"]);
    assert_eq!(request.ttl_seconds, None);
}

#[test]
fn pairing_request_accepts_a_named_preset() {
    let request: CreatePairingRequest = serde_json::from_value(serde_json::json!({
        "preset": "companion"
    }))
    .unwrap();
    assert_eq!(request.preset, Some(DevicePermissionPreset::Companion));
    assert!(request.requested_scopes.is_empty());
}
