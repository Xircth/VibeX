use agents::{
    AcpAuthStatusAdapter, AuthenticationMethod, AuthenticationObservationState,
    AuthenticationSource,
};

#[test]
fn auth_status_adapter_uses_only_negotiated_official_draft_shape() {
    assert!(AcpAuthStatusAdapter::is_advertised(&serde_json::json!({
        "auth": {"status": true}
    })));
    assert!(!AcpAuthStatusAdapter::is_advertised(&serde_json::json!({
        "auth": {}
    })));
    assert!(!AcpAuthStatusAdapter::is_advertised(&serde_json::json!({})));

    let observation = AcpAuthStatusAdapter::decode_response(
        &serde_json::json!({
            "authenticated": true,
            "message": "Credentials are configured",
            "futureField": {"safe": "ignore"}
        }),
        7,
    )
    .unwrap();
    assert_eq!(
        observation.state,
        AuthenticationObservationState::Authenticated
    );
    assert_eq!(observation.method, AuthenticationMethod::Unknown);
    assert_eq!(observation.source, AuthenticationSource::AcpAuthStatus);
    assert_eq!(observation.capability_generation, 7);
    assert_eq!(observation.draft_revision, "2026-07-21");

    let unauthenticated =
        AcpAuthStatusAdapter::decode_response(&serde_json::json!({"authenticated": false}), 8)
            .unwrap();
    assert_eq!(
        unauthenticated.state,
        AuthenticationObservationState::Unauthenticated
    );
}

#[test]
fn auth_status_adapter_rejects_missing_or_malformed_required_field() {
    assert!(AcpAuthStatusAdapter::decode_response(&serde_json::json!({}), 1).is_err());
    assert!(
        AcpAuthStatusAdapter::decode_response(&serde_json::json!({"authenticated": "yes"}), 1)
            .is_err()
    );
}
