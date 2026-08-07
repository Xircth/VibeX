use remote_protocol::{CapabilityId, ServerCapabilities};
use serde_json::json;

#[test]
fn capabilities_fixture_is_versioned_and_forward_compatible() {
    let fixture = json!({
        "server_version": "0.1.3",
        "protocol_version": "1.0",
        "minimum_client_version": "0.1.0",
        "capabilities": [
            "conversation.read",
            "conversation.attach",
            "future.capability"
        ]
    });

    let capabilities: ServerCapabilities =
        serde_json::from_value(fixture.clone()).expect("deserialize capabilities");

    assert!(capabilities.supports(&CapabilityId::new("conversation.attach")));
    assert!(capabilities.supports(&CapabilityId::new("future.capability")));
    assert_eq!(
        serde_json::to_value(capabilities).expect("serialize capabilities"),
        fixture
    );
}
