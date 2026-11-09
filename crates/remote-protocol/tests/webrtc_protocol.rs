use remote_protocol::{
    BULK_CHANNEL_LABEL, BULK_CHUNK_MAX_BYTES, BulkChannelFrame, CONTROL_CHANNEL_LABEL,
    ChannelBindingClaims, CommandResponse, ControlChannelFrame, ConversationId, ErrorCode,
    ErrorEnvelope, OperationId, RedeemPairingRequest, RemoteEvent, SubscriptionClientMessage,
    SubscriptionId, SubscriptionRequest, SubscriptionResource, SubscriptionServerMessage,
    extract_sdp_sha256_fingerprint,
};
use serde_json::json;
use uuid::Uuid;

#[test]
fn channel_binding_claims_format_canonical_signing_input_and_extract_sdp_fingerprint() {
    let sdp = concat!(
        "v=0\r\n",
        "o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n",
        "s=-\r\n",
        "t=0 0\r\n",
        "a=fingerprint:sha-256 aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99\r\n",
    );
    let fingerprint = extract_sdp_sha256_fingerprint(sdp).expect("extract sha-256 fingerprint");
    assert_eq!(
        fingerprint,
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
    );

    let claims = ChannelBindingClaims {
        session_nonce: "nonce-01930c8a".to_owned(),
        sender_device_id: "dev-phone-1".to_owned(),
        recipient_device_id: "host-mac-1".to_owned(),
        unix_timestamp: 1_762_660_000,
        dtls_fingerprint: fingerprint.clone(),
    };
    assert_eq!(
        claims.signing_input(),
        format!("vibex-webrtc-v1|nonce-01930c8a|dev-phone-1|host-mac-1|1762660000|{fingerprint}")
    );
}

#[test]
fn control_channel_frames_round_trip_spec_envelopes() {
    assert_eq!(CONTROL_CHANNEL_LABEL, "vibex.control.v1");
    assert_eq!(BULK_CHANNEL_LABEL, "vibex.bulk.v1");

    let op_id = OperationId::from_uuid(
        Uuid::parse_str("01930c8a-7b12-7000-8000-000000000001").expect("uuid"),
    );
    let req_frame = ControlChannelFrame::RpcRequest {
        operation_id: op_id,
        command: "conversation_input_submit".to_owned(),
        args: json!({
            "request": {
                "conversationId": "c8b6d31f-0000-4000-8000-000000000000",
                "payload": {
                    "agentId": "claude_code",
                    "workspaceId": "w1",
                    "text": "帮我检查一下单元测试"
                }
            }
        }),
    };
    let serialized = serde_json::to_value(&req_frame).expect("serialize rpc_request");
    assert_eq!(serialized["frame"], "rpc_request");
    assert_eq!(
        serialized["operation_id"],
        "01930c8a-7b12-7000-8000-000000000001"
    );
    assert_eq!(serialized["command"], "conversation_input_submit");
    let decoded: ControlChannelFrame =
        serde_json::from_value(serialized).expect("deserialize rpc_request");
    assert_eq!(decoded, req_frame);

    let resp_frame = ControlChannelFrame::from_command_response(
        200,
        CommandResponse::new(op_id, json!({ "accepted": true })),
    );
    let resp_json = serde_json::to_value(&resp_frame).expect("serialize rpc_response");
    assert_eq!(resp_json["frame"], "rpc_response");
    assert_eq!(resp_json["status"], 200);
    assert_eq!(resp_json["data"]["accepted"], true);

    let err_frame = ControlChannelFrame::RpcError {
        operation_id: op_id,
        status: 409,
        error: ErrorEnvelope::new(
            ErrorCode::Conflict,
            "turn has already completed",
            false,
            op_id,
        ),
    };
    let err_json = serde_json::to_value(&err_frame).expect("serialize rpc_error");
    assert_eq!(err_json["frame"], "rpc_error");
    assert_eq!(err_json["status"], 409);

    let sub_id = SubscriptionId::from_uuid(
        Uuid::parse_str("01930c8a-7b12-7000-8000-000000000010").expect("sub uuid"),
    );
    let conv_id = ConversationId::parse("c8b6d31f-0000-4000-8000-000000000000").expect("conv id");
    let sub_client = ControlChannelFrame::SubClient {
        payload: SubscriptionClientMessage::Attach {
            request: SubscriptionRequest {
                subscription_id: sub_id,
                resource: SubscriptionResource::Conversation {
                    conversation_id: conv_id,
                    after_sequence: 142,
                },
            },
        },
    };
    let sub_client_json = serde_json::to_value(&sub_client).expect("serialize sub_client");
    assert_eq!(sub_client_json["frame"], "sub_client");
    assert_eq!(sub_client_json["payload"]["type"], "attach");
    assert_eq!(sub_client_json["payload"]["request"]["after_sequence"], 142);

    let sub_server = ControlChannelFrame::SubServer {
        payload: SubscriptionServerMessage::Event {
            subscription_id: sub_id,
            event: RemoteEvent {
                sequence: 143,
                kind: "assistant_text_delta".to_owned(),
                payload: json!({ "delta": "hello" }),
            },
        },
    };
    let sub_server_json = serde_json::to_value(&sub_server).expect("serialize sub_server");
    assert_eq!(sub_server_json["frame"], "sub_server");
    assert_eq!(sub_server_json["payload"]["type"], "event");
    assert_eq!(sub_server_json["payload"]["event"]["sequence"], 143);
}

#[test]
fn bulk_channel_splits_payload_into_bounded_chunks_and_supports_cancel() {
    let op_id = OperationId::new();
    let payload = vec![b'x'; BULK_CHUNK_MAX_BYTES * 2 + 123];
    let frames =
        BulkChannelFrame::chunk_payload(op_id, "application/json", &payload, BULK_CHUNK_MAX_BYTES);
    assert_eq!(frames.len(), 5); // start + 3 chunks + end
    assert!(matches!(
        frames.first(),
        Some(BulkChannelFrame::BulkStart {
            total_bytes,
            total_chunks: 3,
            ..
        }) if *total_bytes == payload.len()
    ));
    assert!(matches!(
        frames.last(),
        Some(BulkChannelFrame::BulkEnd { .. })
    ));

    let cancel = BulkChannelFrame::BulkCancel {
        operation_id: op_id,
    };
    let cancel_json = serde_json::to_value(&cancel).expect("serialize bulk_cancel");
    assert_eq!(cancel_json["frame"], "bulk_cancel");
}

#[test]
fn redeem_pairing_request_accepts_optional_ed25519_public_key() {
    let without_key: RedeemPairingRequest = serde_json::from_value(json!({
        "pairing_token": "ABCD-EFGH",
        "device_name": "Pixel 9"
    }))
    .expect("deserialize without key");
    assert_eq!(without_key.public_key_ed25519, None);

    let with_key: RedeemPairingRequest = serde_json::from_value(json!({
        "pairing_token": "ABCD-EFGH",
        "device_name": "Pixel 9",
        "public_key_ed25519": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    }))
    .expect("deserialize with key");
    assert_eq!(
        with_key.public_key_ed25519.as_deref(),
        Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    );
}
