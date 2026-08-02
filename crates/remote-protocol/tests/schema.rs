use remote_protocol::{PROTOCOL_VERSION, protocol_schema_bundle, write_protocol_schema_artifacts};

#[test]
fn protocol_schema_bundle_is_versioned_and_keeps_remote_events_open() {
    let bundle = protocol_schema_bundle();

    assert_eq!(bundle.protocol_version, PROTOCOL_VERSION);
    assert_eq!(
        bundle.json_schema["$id"],
        "https://schemas.vibex.dev/remote-protocol/v1/schema.json"
    );
    assert_eq!(bundle.openapi["openapi"], "3.1.0");
    assert_eq!(
        bundle.openapi["info"]["version"],
        serde_json::Value::String(PROTOCOL_VERSION.to_owned())
    );

    let remote_event = &bundle.json_schema["$defs"]["RemoteEvent"];
    assert_eq!(remote_event["type"], "object");
    assert_eq!(remote_event["properties"]["kind"]["type"], "string");
    assert_eq!(remote_event["properties"]["payload"], true);
    assert_ne!(remote_event["additionalProperties"], false);
    assert!(
        bundle.json_schema["$defs"]
            .get("TerminalNotificationSummary")
            .is_some()
    );
    assert!(
        bundle.json_schema["$defs"]
            .get("OfflineConversationCache")
            .is_some()
    );
    assert_eq!(
        bundle.json_schema["$defs"]["OfflineConversationCache"]["properties"]["read_only"]["const"],
        true
    );
    assert!(bundle.openapi["paths"].get("/auth/pairings").is_some());
    assert!(
        bundle.openapi["paths"]
            .get("/auth/pairings/redeem")
            .is_some()
    );
    assert!(
        bundle.openapi["paths"]
            .get("/auth/devices/{device_id}")
            .is_some()
    );
    assert!(
        !serde_json::to_string(&bundle.openapi)
            .expect("serialize OpenAPI")
            .contains("#/$defs/"),
        "OpenAPI component references must use #/components/schemas"
    );
}

#[test]
fn protocol_schema_artifacts_are_written_from_the_public_bundle() {
    let output = tempfile::tempdir().expect("temporary output");

    write_protocol_schema_artifacts(output.path()).expect("write schema artifacts");

    let schema: serde_json::Value = serde_json::from_slice(
        &std::fs::read(output.path().join("schema.json")).expect("schema file"),
    )
    .expect("valid schema JSON");
    let openapi: serde_json::Value = serde_json::from_slice(
        &std::fs::read(output.path().join("openapi.json")).expect("OpenAPI file"),
    )
    .expect("valid OpenAPI JSON");
    assert_eq!(
        schema["$id"],
        "https://schemas.vibex.dev/remote-protocol/v1/schema.json"
    );
    assert_eq!(openapi["info"]["version"], PROTOCOL_VERSION);
}
