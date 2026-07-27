use browser_runtime::{
    BrowserEvent, BrowserIntent, BrowserPermissionKind, BrowserProfile, BrowserTabId,
};
use serde_json::json;

#[test]
fn workspace_profile_round_trips_the_frontend_camel_case_contract() {
    let payload = json!({
        "kind": "workspace",
        "workspaceId": "workspace-1",
    });

    let profile: BrowserProfile =
        serde_json::from_value(payload.clone()).expect("frontend profile should deserialize");

    assert_eq!(
        profile,
        BrowserProfile::Workspace {
            workspace_id: "workspace-1".to_string(),
        }
    );
    assert_eq!(serde_json::to_value(profile).unwrap(), payload);
}

#[test]
fn browser_intent_accepts_camel_case_variant_fields() {
    let intent: BrowserIntent = serde_json::from_value(json!({
        "type": "resolvePermission",
        "requestId": 42,
        "allow": true,
    }))
    .expect("frontend intent should deserialize");

    assert_eq!(
        intent,
        BrowserIntent::ResolvePermission {
            request_id: 42,
            allow: true,
        }
    );
}

#[test]
fn browser_event_serializes_camel_case_variant_fields() {
    let event = BrowserEvent::PermissionRequested {
        tab_id: BrowserTabId::from("browser-tab-1"),
        request_id: 42,
        origin: "https://example.test".to_string(),
        kind: BrowserPermissionKind::Media,
        requested_permissions: 3,
    };

    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "permissionRequested",
            "tabId": "browser-tab-1",
            "requestId": 42,
            "origin": "https://example.test",
            "kind": "media",
            "requestedPermissions": 3,
        })
    );
}
