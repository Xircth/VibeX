use remote_protocol::{
    CONNECTION_CODE_LEN, DevicePermissionPreset, PairingChallenge, PairingId,
    PairingInvitationPayload, ReachabilityOrigin, is_connection_code, is_loopback_origin,
    is_public_plaintext_http_origin, issue_connection_code, origin_allows_plaintext_http,
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
    assert!(!is_loopback_origin("http://47.109.140.92:13630"));
}

#[test]
fn invitation_drops_published_plaintext_http_origin() {
    let challenge = PairingChallenge {
        pairing_id: PairingId::from_uuid(
            uuid::Uuid::parse_str("0195d6f4-8c37-7b28-a982-6a9e60142f55").expect("id"),
        ),
        pairing_token: "K7M2NPQX".to_string(),
        expires_at: "2026-08-18T06:00:00Z".to_string(),
        requested_scopes: vec!["conversation.read".to_string()],
    };
    let payload = PairingInvitationPayload::from_challenge(
        "host-stable-1",
        DevicePermissionPreset::Companion,
        &challenge,
        [
            ReachabilityOrigin::published("http://47.109.140.92:13630"),
            ReachabilityOrigin::published("https://gate.example.ts.net"),
            ReachabilityOrigin::lan("http://192.168.1.20:17891"),
        ],
    );
    let invitation = payload.encode();
    assert!(!invitation.contains("http://47.109.140.92:13630"));
    assert!(invitation.contains("https://gate.example.ts.net"));
    assert!(invitation.contains("http://192.168.1.20:17891"));
    assert!(is_connection_code(&payload.pairing_token));
}

#[test]
fn plaintext_http_is_limited_to_loopback_and_private_hosts() {
    assert!(origin_allows_plaintext_http("http://127.0.0.1:17891"));
    assert!(origin_allows_plaintext_http("http://localhost:17891"));
    assert!(origin_allows_plaintext_http("http://[::1]:17891"));
    assert!(origin_allows_plaintext_http("http://192.168.1.20:17891"));
    assert!(origin_allows_plaintext_http("http://10.0.0.8:17891"));
    assert!(origin_allows_plaintext_http("http://172.16.4.2:17891"));
    assert!(origin_allows_plaintext_http("http://studio.local:17891"));
    assert!(origin_allows_plaintext_http("http://100.64.1.8:17891"));
    assert!(!origin_allows_plaintext_http("http://203.0.113.10:443"));
    assert!(!origin_allows_plaintext_http("http://47.109.140.92:13630"));
    assert!(!origin_allows_plaintext_http("http://example.com"));
    assert!(!is_public_plaintext_http_origin("https://example.com"));
    assert!(is_public_plaintext_http_origin("http://203.0.113.10:443"));
    assert!(!is_public_plaintext_http_origin(
        "http://192.168.1.20:17891"
    ));
}
