use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use remote_protocol::{
    BULK_BUFFERED_HIGH_WATER_BYTES, BULK_BUFFERED_LOW_THRESHOLD_BYTES, BulkChannelFrame,
    ChannelBindingClaims, CommandRequest, CommandResponse, ControlChannelFrame,
    CreatePairingRequest, DeviceCredential, DeviceId, DevicePermissionPreset, OperationId,
    RedeemPairingRequest, SignalingResumeCursor, SubscriptionClientMessage, SubscriptionId,
    SubscriptionRequest, SubscriptionResource, SubscriptionServerMessage,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::json;
use server::{
    AuthClock, AuthStoreError, AuthenticatedCredential, ServerAuth, ServerConfig, ServerRuntime,
    SqliteIdempotencyLedger, SqliteServerAuth, TransportSession, TrustWebRtcDeviceRequest,
    compute_sas_code, verify_peer_dtls_fingerprint,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

#[derive(Clone, Default)]
struct ManualClock {
    now: Arc<AtomicI64>,
}

impl ManualClock {
    fn new(initial: i64) -> Self {
        Self {
            now: Arc::new(AtomicI64::new(initial)),
        }
    }

    fn set(&self, unix_seconds: i64) {
        self.now.store(unix_seconds, Ordering::SeqCst);
    }
}

impl AuthClock for ManualClock {
    fn unix_seconds(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

async fn test_auth_with_clock(clock: ManualClock) -> SqliteServerAuth {
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("sqlite memory pool");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("disable foreign keys after migrations");
    SqliteServerAuth::with_clock(pool, Arc::new(clock))
}

fn generate_ed25519_keypair() -> (Ed25519KeyPair, [u8; 32], String) {
    let rng = SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate ed25519 pkcs8");
    let keypair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse ed25519 keypair");
    let mut pub_bytes = [0u8; 32];
    pub_bytes.copy_from_slice(keypair.public_key().as_ref());
    let pub_b64 = BASE64.encode(pub_bytes);
    (keypair, pub_bytes, pub_b64)
}

#[tokio::test]
async fn ed25519_channel_binding_verifies_signature_and_blocks_replay_skew_and_fingerprint_mismatch()
 {
    let clock = ManualClock::new(1_762_660_000);
    let auth = test_auth_with_clock(clock.clone()).await;
    let owner = AuthenticatedCredential::host_console_owner();

    let (phone_kp, _phone_pub_bytes, phone_pub_b64) = generate_ed25519_keypair();
    let device_id = DeviceId::new();

    let record = auth
        .trust_webrtc_device(
            &owner,
            TrustWebRtcDeviceRequest {
                device_id,
                device_name: "Honor DIO-AN00".to_owned(),
                public_key_ed25519: phone_pub_b64.clone(),
                preset: DevicePermissionPreset::Companion,
            },
        )
        .await
        .expect("trust webrtc device");
    assert_eq!(record.device_id, device_id);
    assert_eq!(
        record.public_key_ed25519.as_deref(),
        Some(phone_pub_b64.as_str())
    );

    let claims = ChannelBindingClaims {
        session_nonce: "nonce-001".to_owned(),
        sender_device_id: device_id.to_string(),
        recipient_device_id: "host-macbook-pro".to_owned(),
        unix_timestamp: 1_762_660_010,
        dtls_fingerprint:
            "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
                .to_owned(),
    };
    let sig = phone_kp.sign(claims.signing_input().as_bytes());
    let sig_b64 = BASE64.encode(sig.as_ref());

    // 1. Valid signature & fresh nonce succeeds
    let credential = auth
        .authenticate_channel_binding("host-macbook-pro", &claims, &sig_b64)
        .await
        .expect("channel binding auth succeeds");
    assert_eq!(credential.device_id, Some(device_id));
    assert!(credential.allows("conversation.read"));
    assert!(credential.allows("conversation.write"));
    assert!(!credential.allows("plugin.write"));

    // 2. Replaying the exact same session_nonce is rejected
    let replay_err = auth
        .authenticate_channel_binding("host-macbook-pro", &claims, &sig_b64)
        .await
        .expect_err("replay must be rejected");
    assert!(matches!(replay_err, AuthStoreError::ChannelBindingReplay));

    // 3. Timestamp outside ±60s window is rejected
    let stale_claims = ChannelBindingClaims {
        session_nonce: "nonce-002".to_owned(),
        unix_timestamp: 1_762_660_000 - 65,
        ..claims.clone()
    };
    let stale_sig = BASE64.encode(
        phone_kp
            .sign(stale_claims.signing_input().as_bytes())
            .as_ref(),
    );
    let skew_err = auth
        .authenticate_channel_binding("host-macbook-pro", &stale_claims, &stale_sig)
        .await
        .expect_err("stale timestamp must be rejected");
    assert!(matches!(
        skew_err,
        AuthStoreError::ChannelBindingTimestampSkew
    ));

    // 4. Wrong recipient host_id is rejected
    let wrong_host_claims = ChannelBindingClaims {
        session_nonce: "nonce-003".to_owned(),
        ..claims.clone()
    };
    let wrong_host_sig = BASE64.encode(
        phone_kp
            .sign(wrong_host_claims.signing_input().as_bytes())
            .as_ref(),
    );
    let recipient_err = auth
        .authenticate_channel_binding("other-host", &wrong_host_claims, &wrong_host_sig)
        .await
        .expect_err("wrong recipient must be rejected");
    assert!(matches!(
        recipient_err,
        AuthStoreError::ChannelBindingRecipientMismatch
    ));

    // 5. DTLS peer certificate fingerprint check binds the data channel to the signed SDP fingerprint
    assert!(verify_peer_dtls_fingerprint(
        &claims.dtls_fingerprint,
        "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
    ));
    assert!(!verify_peer_dtls_fingerprint(
        &claims.dtls_fingerprint,
        "FF:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
    ));
}

#[tokio::test]
async fn sas_verification_code_and_offline_revocation_sync_close_trust_loop() {
    let clock = ManualClock::new(1_762_660_000);
    let auth = test_auth_with_clock(clock).await;
    let owner = AuthenticatedCredential::host_console_owner();

    let (_host_kp, host_pub_bytes, _host_pub_b64) = generate_ed25519_keypair();
    let (phone_kp, phone_pub_bytes, phone_pub_b64) = generate_ed25519_keypair();

    // SAS code is deterministic 4-digit decimal string
    let sas_host = compute_sas_code(&host_pub_bytes, &phone_pub_bytes, "nonce-sas-42");
    let sas_phone = compute_sas_code(&host_pub_bytes, &phone_pub_bytes, "nonce-sas-42");
    let sas_diff = compute_sas_code(&host_pub_bytes, &phone_pub_bytes, "nonce-sas-43");
    assert_eq!(sas_host.len(), 4);
    assert!(sas_host.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(sas_host, sas_phone);
    assert_ne!(sas_host, sas_diff);

    // Redeem a LAN/QR pairing that also supplies an Ed25519 public key
    let challenge = auth
        .create_pairing(
            &owner,
            CreatePairingRequest {
                preset: Some(DevicePermissionPreset::Companion),
                requested_scopes: Vec::new(),
                ttl_seconds: None,
            },
        )
        .await
        .expect("create pairing");
    let credential = auth
        .redeem_pairing(RedeemPairingRequest {
            pairing_token: challenge.pairing_token,
            device_name: "iPhone 17 Pro".to_owned(),
            public_key_ed25519: Some(phone_pub_b64),
            client_kind: None,
            replace_existing_mobile: false,
        })
        .await
        .expect("redeem pairing with ed25519 key");

    // Offline revocation sync revokes the device before accepting inbound requests
    let synced = auth
        .sync_revoked_devices(&owner, &[credential.device_id])
        .await
        .expect("sync revoked devices");
    assert_eq!(synced, 1);

    // Both bearer token and WebRTC channel binding are now rejected
    assert!(
        auth.authenticate(&credential.access_token)
            .await
            .expect("authenticate bearer")
            .is_none()
    );

    let claims = ChannelBindingClaims {
        session_nonce: "nonce-after-revoke".to_owned(),
        sender_device_id: credential.device_id.to_string(),
        recipient_device_id: "host-1".to_owned(),
        unix_timestamp: 1_762_660_005,
        dtls_fingerprint: "AA:BB".to_owned(),
    };
    let sig_b64 = BASE64.encode(phone_kp.sign(claims.signing_input().as_bytes()).as_ref());
    let err = auth
        .authenticate_channel_binding("host-1", &claims, &sig_b64)
        .await
        .expect_err("revoked device must fail channel binding");
    assert!(matches!(err, AuthStoreError::DeviceNotFound));
}

#[tokio::test]
async fn idempotency_ledger_and_transport_session_deduplicate_retries_replay_events_and_enforce_bulk_backpressure()
 {
    use application::{ApplicationCore, SqliteConversationRepository};
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    let clock = ManualClock::new(1_762_660_000);
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("sqlite memory pool");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("disable foreign keys after migrations");

    let auth = Arc::new(SqliteServerAuth::with_clock(
        pool.clone(),
        Arc::new(clock.clone()),
    ));
    let owner = AuthenticatedCredential::host_console_owner();
    let challenge = auth
        .create_pairing(
            &owner,
            CreatePairingRequest {
                preset: Some(DevicePermissionPreset::Companion),
                requested_scopes: Vec::new(),
                ttl_seconds: None,
            },
        )
        .await
        .expect("issue pairing");
    let device: DeviceCredential = auth
        .redeem_pairing(RedeemPairingRequest {
            pairing_token: challenge.pairing_token,
            device_name: "Pixel 9 Pro".to_owned(),
            public_key_ed25519: None,
            client_kind: None,
            replace_existing_mobile: false,
        })
        .await
        .expect("redeem pairing");
    let credential = auth
        .authenticate(&device.access_token)
        .await
        .expect("auth")
        .expect("active device credential");

    let core = Arc::new(ApplicationCore::new(SqliteConversationRepository::new(
        pool.clone(),
    )));
    let ledger = SqliteIdempotencyLedger::with_clock(pool.clone(), Arc::new(clock.clone()));
    let mut session = TransportSession::new(
        credential.clone(),
        Arc::clone(&auth) as Arc<dyn ServerAuth>,
        Arc::clone(&core),
        ledger.clone(),
    );

    // 1. Scenario S7: Send `conversation_create` with same `operation_id` twice over WebRTC control channel
    let workspace_id = uuid::Uuid::new_v4();
    let create_op = OperationId::new();
    let create_args = json!({
        "workspaceId": workspace_id,
        "agentId": "claude-code",
        "title": "WebRTC Retry Test"
    });
    let create_frame = ControlChannelFrame::RpcRequest {
        operation_id: create_op,
        command: "conversation_create".to_owned(),
        args: create_args.clone(),
    };
    let first_frames = session
        .handle_control_frame(create_frame.clone())
        .await
        .expect("first create call");
    let first_id = match &first_frames[0] {
        ControlChannelFrame::RpcResponse {
            operation_id,
            status: 200,
            data,
        } => {
            assert_eq!(*operation_id, create_op);
            data["id"].as_str().expect("conversation id").to_owned()
        }
        other => panic!("unexpected frame: {other:?}"),
    };

    // Retry the exact same operation_id (simulating reconnect after packet loss)
    let retry_frames = session
        .handle_control_frame(create_frame)
        .await
        .expect("retry create call");
    let retry_id = match &retry_frames[0] {
        ControlChannelFrame::RpcResponse {
            operation_id,
            status: 200,
            data,
        } => {
            assert_eq!(*operation_id, create_op);
            data["id"].as_str().expect("conversation id").to_owned()
        }
        other => panic!("unexpected retry frame: {other:?}"),
    };
    assert_eq!(
        first_id, retry_id,
        "idempotency ledger must replay the exact same created conversation without creating a duplicate"
    );
    assert_eq!(session.telemetry().idempotency_hit_count, 1);

    // Also verify HTTP `/api/v1/call/conversation_create` shares the same idempotency ledger
    let runtime = ServerRuntime::from_auth_with_preview_proxy(
        ServerConfig::default(),
        Arc::clone(&auth) as Arc<dyn ServerAuth>,
        ApplicationCore::new(SqliteConversationRepository::new(pool.clone())),
        server::PreviewProxyRegistry::default(),
    )
    .with_idempotency_ledger(ledger.clone());
    let app = runtime.router();
    let http_retry = app
        .oneshot(
            Request::post("/api/v1/call/conversation_create")
                .header("authorization", format!("Bearer {}", device.access_token))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&CommandRequest {
                        operation_id: create_op,
                        args: create_args,
                    })
                    .expect("serialize request"),
                ))
                .expect("http request"),
        )
        .await
        .expect("http response");
    assert_eq!(http_retry.status(), StatusCode::OK);
    let http_body: CommandResponse<serde_json::Value> = serde_json::from_slice(
        &to_bytes(http_retry.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json response");
    assert_eq!(http_body.data["id"].as_str(), Some(first_id.as_str()));

    // 2. Scenario S6 & S8: Subscribe via `sub_client` (`attach`) and verify Signaling Piggyback
    let conv_id = remote_protocol::ConversationId::parse(&first_id).expect("parse conv id");
    let sub_id = SubscriptionId::new();
    let attach_frames = session
        .handle_control_frame(ControlChannelFrame::SubClient {
            payload: SubscriptionClientMessage::Attach {
                request: SubscriptionRequest {
                    subscription_id: sub_id,
                    resource: SubscriptionResource::Conversation {
                        conversation_id: conv_id,
                        after_sequence: 0,
                    },
                },
            },
        })
        .await
        .expect("attach conversation");
    assert!(attach_frames.iter().any(|frame| matches!(
        frame,
        ControlChannelFrame::SubServer {
            payload: SubscriptionServerMessage::Ready { subscription_id }
        } if *subscription_id == sub_id
    )));
    assert!(attach_frames.iter().any(|frame| matches!(
        frame,
        ControlChannelFrame::SubServer {
            payload: SubscriptionServerMessage::Live { subscription_id, .. }
        } if *subscription_id == sub_id
    )));

    // Signaling Piggyback for foreground resume returns events when <= 32KB
    let piggyback = session
        .build_signaling_piggyback(&SignalingResumeCursor {
            conversation_id: conv_id,
            after_sequence: 0,
        })
        .await
        .expect("build piggyback")
        .expect("piggyback fits in 32KB");
    assert_eq!(piggyback.conversation_id, conv_id);

    // 3. Scenario S9: Bulk channel chunking + 128KB high-water backpressure + mid-flight `bulk_cancel`
    let bulk_op = OperationId::new();
    let large_diff = vec![b'+'; 100 * 1024]; // 100 KB payload -> 4 chunks of 32KB/32KB/32KB/4KB
    session.enqueue_bulk_payload(bulk_op, "text/x-patch", &large_diff);

    // Simulate bufferedAmount = 120KB: draining one 32KB chunk pushes bufferedAmount > 128KB high-water mark, pausing further chunks
    let mut simulated_buffered = 120 * 1024;
    let drained_before_pause = session.drain_bulk_frames(&mut simulated_buffered);
    assert_eq!(
        drained_before_pause.len(),
        2, // BulkStart + first BulkChunk, then paused because simulated_buffered > BULK_BUFFERED_HIGH_WATER_BYTES
        "must pause bulk writes as soon as buffered_amount exceeds 128KB"
    );
    assert!(simulated_buffered > BULK_BUFFERED_HIGH_WATER_BYTES);

    // Control channel Ping still executes with zero head-of-line delay while bulk channel is paused
    let pong = session
        .handle_control_frame(ControlChannelFrame::Ping {
            timestamp_ms: 123_456,
        })
        .await
        .expect("control ping during bulk backpressure");
    assert_eq!(
        pong,
        vec![ControlChannelFrame::Pong {
            timestamp_ms: 123_456
        }]
    );

    // Cancel the remaining bulk transfer mid-flight (`bulk_cancel`)
    session.handle_bulk_frame(BulkChannelFrame::BulkCancel {
        operation_id: bulk_op,
    });
    simulated_buffered = BULK_BUFFERED_LOW_THRESHOLD_BYTES / 2;
    let drained_after_cancel = session.drain_bulk_frames(&mut simulated_buffered);
    assert!(
        drained_after_cancel.is_empty(),
        "bulk_cancel must drop remaining queued chunks for that operation_id"
    );

    // 4. Scenario S10: Revoking the device immediately rejects subsequent control frames
    clock.set(1_762_660_100);
    auth.revoke_device(&owner, device.device_id)
        .await
        .expect("revoke device");
    let revoked_resp = session
        .handle_control_frame(ControlChannelFrame::RpcRequest {
            operation_id: OperationId::new(),
            command: "conversation_list".to_owned(),
            args: json!({}),
        })
        .await
        .expect("revoked device returns error frame");
    assert!(matches!(
        &revoked_resp[0],
        ControlChannelFrame::RpcError { status: 401, .. }
    ));
}

#[tokio::test]
async fn mobile_zero_config_connect_request_triggers_host_prompt_and_approves_with_ed25519_key() {
    use application::{ApplicationCore, SqliteConversationRepository};
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use remote_protocol::{
        CreateDeviceConnectRequest, DeviceConnectRequestStatus, PendingDeviceConnectRequest,
        PollDeviceConnectResponse,
    };
    use tower::ServiceExt;

    let clock = ManualClock::new(1_762_660_000);
    let auth = Arc::new(test_auth_with_clock(clock.clone()).await);
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("sqlite memory pool");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let runtime = ServerRuntime::from_auth_with_preview_proxy(
        ServerConfig::default().with_host_identity("host-desktop-1", Vec::new()),
        Arc::clone(&auth) as Arc<dyn ServerAuth>,
        ApplicationCore::new(SqliteConversationRepository::new(pool)),
        server::PreviewProxyRegistry::default(),
    );

    let rng = SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("ed25519 keygen");
    let keypair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse keypair");
    let pubkey_b64 = BASE64.encode(keypair.public_key().as_ref());

    // 1. Mobile sends POST /api/v1/auth/connect-requests on first-time launch
    let create_resp = runtime
        .router()
        .oneshot(
            Request::post("/api/v1/auth/connect-requests")
                .header("content-type", "application/json")
                .header("x-forwarded-for", "192.168.1.88")
                .body(Body::from(
                    serde_json::to_vec(&CreateDeviceConnectRequest {
                        device_name: "iPhone 16 Pro".to_owned(),
                        client_kind: Some("mobile".to_owned()),
                        public_key_ed25519: Some(pubkey_b64.clone()),
                        session_nonce: Some("first-connect-nonce".to_owned()),
                        replace_existing_mobile: false,
                    })
                    .expect("serialize"),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(create_resp.status(), StatusCode::CREATED);
    let created: PollDeviceConnectResponse = serde_json::from_slice(
        &to_bytes(create_resp.into_body(), 16 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(created.status, DeviceConnectRequestStatus::Pending);
    assert_eq!(created.sas_code.len(), 4);
    assert!(created.credential.is_none());

    // 2. Desktop Host lists pending connect requests (for red-box banner prompt)
    let owner = AuthenticatedCredential::host_console_owner();
    let pending: Vec<PendingDeviceConnectRequest> = auth
        .list_connect_requests(&owner)
        .await
        .expect("list pending requests");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request_id, created.request_id);
    assert_eq!(pending[0].device_name, "iPhone 16 Pro");
    assert_eq!(pending[0].ip_address.as_deref(), Some("192.168.1.88"));
    assert_eq!(pending[0].sas_code, created.sas_code);

    // 3. User clicks "连接" on Desktop red-box banner -> approves request
    auth.respond_connect_request(&owner, created.request_id, true)
        .await
        .expect("approve connect request");
    assert!(
        auth.list_connect_requests(&owner)
            .await
            .expect("list after approve")
            .is_empty(),
        "approved request must no longer appear in pending banner list"
    );

    // 4. Mobile polls GET /api/v1/auth/connect-requests/{id} and receives one-time DeviceCredential
    let poll_resp = runtime
        .router()
        .oneshot(
            Request::get(format!(
                "/api/v1/auth/connect-requests/{}",
                created.request_id
            ))
            .body(Body::empty())
            .expect("poll request"),
        )
        .await
        .expect("poll response");
    assert_eq!(poll_resp.status(), StatusCode::OK);
    let approved: PollDeviceConnectResponse = serde_json::from_slice(
        &to_bytes(poll_resp.into_body(), 16 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(approved.status, DeviceConnectRequestStatus::Approved);
    let credential = approved
        .credential
        .expect("one-time credential must be returned");
    assert!(credential.access_token.starts_with("vbx_device_"));

    // Subsequent poll sees Approved but credential is None (one-time delivery)
    let second_poll = auth
        .poll_connect_request("host-desktop-1", created.request_id)
        .await
        .expect("second poll");
    assert_eq!(second_poll.status, DeviceConnectRequestStatus::Approved);
    assert!(second_poll.credential.is_none());

    // And the device is registered with its Ed25519 key in paired devices list
    let paired = auth.list_devices(&owner).await.expect("paired devices");
    assert_eq!(paired.len(), 1);
    assert_eq!(paired[0].device_id, credential.device_id);
    assert_eq!(
        paired[0].public_key_ed25519.as_deref(),
        Some(pubkey_b64.as_str())
    );
}
