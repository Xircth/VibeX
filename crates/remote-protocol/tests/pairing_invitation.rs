use remote_protocol::{
    CONNECTION_CODE_LEN, DevicePermissionPreset, PairingChallenge, PairingId,
    PairingInvitationPayload, ReachabilityOrigin, is_connection_code, is_loopback_origin,
    issue_connection_code,
};

#[test]
fn invitation_encodes_host_identity_and_drops_loopback() {
    let challenge = PairingChallenge {
        pairing_id: PairingId::from_uuid(
            uuid::Uuid::parse_str("0195d6f4-8c37-7b28-a982-6a9e60142f55").expect("id"),
        ),
        pairing_token: "vbx_pair_once".to_string(),
        expires_at: "2026-08-18T06:00:00Z".to_string(),
        requested_scopes: vec!["conversation.read".to_string()],
    };
    let payload = PairingInvitationPayload::from_challenge(
        "host-stable-1",
        DevicePermissionPreset::Companion,
        &challenge,
        [
            ReachabilityOrigin::lan("http://127.0.0.1:17891"),
            ReachabilityOrigin::lan("http://192.168.1.20:17891"),
        ],
    );
    let invitation = payload.encode();

    assert!(invitation.starts_with("vibex-pairing:"));
    assert!(invitation.contains("\"host_id\":\"host-stable-1\""));
    assert!(invitation.contains("http://192.168.1.20:17891"));
    assert!(!invitation.contains("127.0.0.1"));
    assert!(!invitation.contains("vbx_device_"));
    assert!(!invitation.contains("localhost"));
}

#[test]
fn connection_code_is_eight_unambiguous_characters() {
    let code = issue_connection_code();
    assert_eq!(code.len(), CONNECTION_CODE_LEN);
    assert!(is_connection_code(&code));
    assert!(!is_connection_code("vbx_pair_secret"));
}

#[test]
fn loopback_origin_detection_covers_ipv4_and_localhost() {
    assert!(is_loopback_origin("http://127.0.0.1:17891"));
    assert!(is_loopback_origin("http://localhost:17891"));
    assert!(!is_loopback_origin("http://192.168.1.8:17891"));
}
