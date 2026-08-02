use application::Principal;

#[test]
fn remote_device_principal_preserves_credential_and_device_identity() {
    let principal = Principal::remote_credential(
        "device:ios",
        "credential-7",
        Some("device-42".to_owned()),
        ["conversation.read".to_owned()],
    );

    assert_eq!(principal.credential_id(), Some("credential-7"));
    assert_eq!(principal.device_id(), Some("device-42"));
}
