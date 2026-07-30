use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId, PROTOCOL_VERSION};
use serde_json::json;

#[test]
fn command_error_fixture_has_a_stable_envelope() {
    let operation_id =
        OperationId::parse("0195d6f4-8c37-7b28-a982-6a9e60142f52").expect("fixture operation id");
    let error = ErrorEnvelope::new(
        ErrorCode::Conflict,
        "the operation conflicts with current state",
        false,
        operation_id,
    )
    .with_details(json!({
        "resource": "conversation",
        "reason": "turn_in_progress"
    }));

    assert_eq!(PROTOCOL_VERSION, "1.0");
    assert_eq!(
        serde_json::to_value(error).expect("serialize error envelope"),
        json!({
            "code": "conflict",
            "message": "the operation conflicts with current state",
            "retryable": false,
            "operation_id": "0195d6f4-8c37-7b28-a982-6a9e60142f52",
            "details": {
                "resource": "conversation",
                "reason": "turn_in_progress"
            }
        })
    );
}
