//! End-to-End Encryption (E2EE v1) for Host <-> Mobile Companion communication.
//!
//! Uses ephemeral-ephemeral / session ECDH over NIST P-256 (`secp256r1`) with
//! `HKDF-SHA256` key derivation and `AES-256-GCM` authenticated encryption so
//! that cloud relays and untrusted network intermediaries
//! only ever observe opaque AEAD ciphertexts.

use std::{
    collections::HashMap,
    sync::{OnceLock, RwLock},
    time::Instant,
};

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hkdf::Hkdf;
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    agreement::{ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, agree_ephemeral},
    rand::{SecureRandom, SystemRandom},
};
use sha2::Sha256;

pub const HEADER_E2EE: &str = "x-vibex-e2ee";
pub const HEADER_E2EE_CLIENT_PUB: &str = "x-vibex-e2ee-client-pub";
pub const HEADER_E2EE_SERVER_PUB: &str = "x-vibex-e2ee-server-pub";
pub const HEADER_E2EE_SESSION: &str = "x-vibex-e2ee-session";
pub const HEADER_E2EE_AUTH: &str = "x-vibex-e2ee-auth";
pub const E2EE_VERSION: &str = "v1";

pub const HKDF_SALT: &[u8] = b"vibex-e2ee-v1-salt";
pub const HKDF_INFO: &[u8] = b"vibex-e2ee-v1-aes256gcm";

pub const AAD_AUTH: &[u8] = b"vibex-e2ee-auth-v1";
pub const AAD_REQ: &[u8] = b"vibex-e2ee-req-v1";
pub const AAD_RESP: &[u8] = b"vibex-e2ee-resp-v1";
pub const AAD_WS: &[u8] = b"vibex-e2ee-ws-v1";

const MAX_E2EE_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_CACHED_SESSIONS: usize = 512;

#[derive(Clone, Debug)]
pub struct E2eeSession {
    pub session_id: String,
    pub key: [u8; 32],
    pub client_pub_b64: String,
    pub server_pub_b64: String,
    pub active_e2ee: bool,
    pub last_used: Instant,
}

#[derive(Default)]
struct E2eeSessionStore {
    by_session_id: HashMap<String, E2eeSession>,
    by_client_pub: HashMap<String, String>,
}

static SESSION_STORE: OnceLock<RwLock<E2eeSessionStore>> = OnceLock::new();

fn session_store() -> &'static RwLock<E2eeSessionStore> {
    SESSION_STORE.get_or_init(|| RwLock::new(E2eeSessionStore::default()))
}

fn decode_b64_flexible(encoded: &str) -> Option<Vec<u8>> {
    let trimmed = encoded.trim();
    if trimmed.is_empty() {
        return None;
    }
    STANDARD
        .decode(trimmed)
        .or_else(|_| URL_SAFE_NO_PAD.decode(trimmed))
        .ok()
}

pub fn derive_aes256_key(shared_secret: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared_secret);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .expect("32-byte HKDF-SHA256 output is always valid");
    okm
}

pub fn encrypt_payload(
    key: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<String, &'static str> {
    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; 12];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| "failed to generate E2EE nonce")?;

    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "invalid AES-256-GCM key")?;
    let sealing_key = LessSafeKey::new(unbound);

    let mut buffer = Vec::with_capacity(12 + plaintext.len() + 16);
    buffer.extend_from_slice(&nonce_bytes);
    buffer.extend_from_slice(plaintext);

    let tag = sealing_key
        .seal_in_place_separate_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(aad),
            &mut buffer[12..],
        )
        .map_err(|_| "AES-256-GCM encryption failed")?;
    buffer.extend_from_slice(tag.as_ref());

    Ok(STANDARD.encode(&buffer))
}

pub fn decrypt_payload(key: &[u8; 32], aad: &[u8], encoded: &str) -> Result<Vec<u8>, &'static str> {
    let mut raw = decode_b64_flexible(encoded).ok_or("invalid E2EE base64 payload")?;
    if raw.len() < 12 + 16 {
        return Err("E2EE payload too short");
    }
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&raw[..12]);
    let ciphertext_and_tag = &mut raw[12..];

    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "invalid AES-256-GCM key")?;
    let opening_key = LessSafeKey::new(unbound);

    let plaintext = opening_key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(aad),
            ciphertext_and_tag,
        )
        .map_err(|_| "AES-256-GCM authentication failed")?;

    Ok(plaintext.to_vec())
}

pub fn lookup_session_by_id(session_id: &str) -> Option<E2eeSession> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut guard = session_store().write().ok()?;
    let session = guard.by_session_id.get_mut(trimmed)?;
    session.last_used = Instant::now();
    Some(session.clone())
}

pub fn get_or_create_session_for_client_pub(client_pub_b64: &str) -> Option<E2eeSession> {
    let clean_pub = client_pub_b64.trim();
    if clean_pub.is_empty() {
        return None;
    }
    if let Ok(mut guard) = session_store().write()
        && let Some(existing_id) = guard.by_client_pub.get(clean_pub).cloned()
        && let Some(session) = guard.by_session_id.get_mut(&existing_id)
    {
        session.last_used = Instant::now();
        return Some(session.clone());
    }

    let client_pub_bytes = decode_b64_flexible(clean_pub)?;
    if client_pub_bytes.len() != 65 || client_pub_bytes[0] != 0x04 {
        return None;
    }

    let rng = SystemRandom::new();
    let server_priv = EphemeralPrivateKey::generate(&ECDH_P256, &rng).ok()?;
    let server_pub = server_priv.compute_public_key().ok()?;
    let server_pub_b64 = STANDARD.encode(server_pub.as_ref());

    let peer_pub = UnparsedPublicKey::new(&ECDH_P256, &client_pub_bytes);
    let key = agree_ephemeral(server_priv, &peer_pub, |shared_secret| {
        derive_aes256_key(shared_secret)
    })
    .ok()?;

    let mut id_bytes = [0u8; 16];
    rng.fill(&mut id_bytes).ok()?;
    let session_id = id_bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    let session = E2eeSession {
        session_id: session_id.clone(),
        key,
        client_pub_b64: clean_pub.to_owned(),
        server_pub_b64,
        active_e2ee: false,
        last_used: Instant::now(),
    };

    if let Ok(mut guard) = session_store().write() {
        if guard.by_session_id.len() >= MAX_CACHED_SESSIONS
            && let Some(oldest_key) = guard
                .by_session_id
                .iter()
                .min_by_key(|(_, v)| v.last_used)
                .map(|(k, _)| k.clone())
            && let Some(removed) = guard.by_session_id.remove(&oldest_key)
        {
            guard.by_client_pub.remove(&removed.client_pub_b64);
        }
        guard
            .by_client_pub
            .insert(clean_pub.to_owned(), session_id.clone());
        guard.by_session_id.insert(session_id, session.clone());
    }

    Some(session)
}

fn ws_session_from_protocols(protocols: &str) -> Option<E2eeSession> {
    protocols
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix("vibex.e2ee."))
        .and_then(lookup_session_by_id)
}

fn attach_handshake_headers(headers: &mut axum::http::HeaderMap, session: &E2eeSession) {
    if let Ok(val) = HeaderValue::from_str(&session.session_id) {
        headers.insert(HEADER_E2EE_SESSION, val);
    }
    if let Ok(val) = HeaderValue::from_str(&session.server_pub_b64) {
        headers.insert(HEADER_E2EE_SERVER_PUB, val);
    }
}

fn precondition_failed_rekey(session: &E2eeSession) -> Response {
    let mut response = (
        StatusCode::PRECONDITION_FAILED,
        "E2EE session key out of sync; re-key using response headers",
    )
        .into_response();
    attach_handshake_headers(response.headers_mut(), session);
    response
}

pub async fn e2ee_middleware(mut request: Request, next: Next) -> Response {
    let requested_session_id = request
        .headers()
        .get(HEADER_E2EE_SESSION)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let client_pub_b64 = request
        .headers()
        .get(HEADER_E2EE_CLIENT_PUB)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let ws_protocol_session = request
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(ws_session_from_protocols);

    let mut session = requested_session_id
        .as_deref()
        .and_then(lookup_session_by_id)
        .or(ws_protocol_session)
        .or_else(|| {
            client_pub_b64
                .as_deref()
                .and_then(get_or_create_session_for_client_pub)
        });

    let request_is_e2ee = request
        .headers()
        .get(HEADER_E2EE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case(E2EE_VERSION));

    if request_is_e2ee {
        let Some(active_session) = session.as_mut() else {
            return (
                StatusCode::PRECONDITION_FAILED,
                "E2EE session not established; provide x-vibex-e2ee-client-pub",
            )
                .into_response();
        };
        active_session.active_e2ee = true;

        // If the client specified a session ID from before a Host restart and it didn't match,
        // trigger an immediate 412 re-key with the new server public key.
        if let Some(req_id) = requested_session_id.as_deref()
            && req_id != active_session.session_id
        {
            return precondition_failed_rekey(active_session);
        }

        if let Some(enc_auth) = request
            .headers()
            .get(HEADER_E2EE_AUTH)
            .and_then(|v| v.to_str().ok())
            .map(ToOwned::to_owned)
        {
            let Ok(decrypted_auth) = decrypt_payload(&active_session.key, AAD_AUTH, &enc_auth)
            else {
                return precondition_failed_rekey(active_session);
            };
            let Ok(auth_str) = String::from_utf8(decrypted_auth) else {
                return precondition_failed_rekey(active_session);
            };
            let normalized = if auth_str.starts_with("Bearer ") || auth_str.starts_with("bearer ") {
                auth_str
            } else {
                format!("Bearer {}", auth_str.trim())
            };
            if let Ok(header_val) = HeaderValue::from_str(&normalized) {
                request
                    .headers_mut()
                    .insert(header::AUTHORIZATION, header_val);
            }
        }

        let (mut parts, body) = request.into_parts();
        let Ok(body_bytes) = axum::body::to_bytes(body, MAX_E2EE_BODY_BYTES).await else {
            return (StatusCode::PAYLOAD_TOO_LARGE, "E2EE request body too large").into_response();
        };

        if !body_bytes.is_empty() {
            let Ok(encoded_str) = std::str::from_utf8(&body_bytes) else {
                return precondition_failed_rekey(active_session);
            };
            let Ok(plaintext_bytes) =
                decrypt_payload(&active_session.key, AAD_REQ, encoded_str.trim())
            else {
                return precondition_failed_rekey(active_session);
            };
            parts.headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            parts.headers.remove(header::CONTENT_LENGTH);
            request = Request::from_parts(parts, Body::from(plaintext_bytes));
        } else {
            request = Request::from_parts(parts, Body::empty());
        }
    } else if let Some(active_session) = session.as_mut()
        && request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|p| p.contains("vibex.e2ee."))
    {
        active_session.active_e2ee = true;
    }

    if let Some(ref active_session) = session {
        request.extensions_mut().insert(active_session.clone());
    }

    let mut response = next.run(request).await;

    if let Some(ref active_session) = session {
        attach_handshake_headers(response.headers_mut(), active_session);

        let is_ws_upgrade = response.status() == StatusCode::SWITCHING_PROTOCOLS;
        let is_sse = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.contains("text/event-stream"));

        if request_is_e2ee && !is_ws_upgrade && !is_sse {
            let (mut parts, body) = response.into_parts();
            if let Ok(resp_bytes) = axum::body::to_bytes(body, MAX_E2EE_BODY_BYTES).await {
                if !resp_bytes.is_empty()
                    && let Ok(encrypted_b64) =
                        encrypt_payload(&active_session.key, AAD_RESP, &resp_bytes)
                {
                    parts
                        .headers
                        .insert(HEADER_E2EE, HeaderValue::from_static(E2EE_VERSION));
                    parts.headers.insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/plain; charset=utf-8"),
                    );
                    parts.headers.remove(header::CONTENT_LENGTH);
                    return Response::from_parts(parts, Body::from(encrypted_b64));
                }
                return Response::from_parts(parts, Body::from(resp_bytes));
            }
            return Response::from_parts(parts, Body::empty());
        }
    }

    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdh_p256_handshake_and_aes256gcm_roundtrip_succeeds() {
        let rng = SystemRandom::new();
        let client_priv = EphemeralPrivateKey::generate(&ECDH_P256, &rng).expect("client key");
        let client_pub = client_priv.compute_public_key().expect("client pub");
        let client_pub_b64 = STANDARD.encode(client_pub.as_ref());

        let server_session =
            get_or_create_session_for_client_pub(&client_pub_b64).expect("server session");
        let server_pub_bytes = STANDARD
            .decode(&server_session.server_pub_b64)
            .expect("server pub decode");

        let client_key = agree_ephemeral(
            client_priv,
            &UnparsedPublicKey::new(&ECDH_P256, &server_pub_bytes),
            |shared_secret| derive_aes256_key(shared_secret),
        )
        .expect("client agree");

        assert_eq!(client_key, server_session.key);

        let message = br#"{"operation_id":"op-1","args":{"prompt":"hello end-to-end encryption"}}"#;
        let encrypted =
            encrypt_payload(&client_key, AAD_REQ, message).expect("client encrypts request");
        let decrypted = decrypt_payload(&server_session.key, AAD_REQ, &encrypted)
            .expect("server decrypts request");
        assert_eq!(decrypted, message);

        // Wrong AAD must fail authentication
        assert!(decrypt_payload(&server_session.key, AAD_RESP, &encrypted).is_err());
    }

    #[tokio::test]
    async fn e2ee_middleware_decrypts_request_and_encrypts_response() {
        use axum::{
            Json, Router,
            body::Body,
            http::{Request, StatusCode, header},
            middleware,
            routing::{get, post},
        };
        use tower::ServiceExt;

        let app = Router::new()
            .route(
                "/health",
                get(|| async { Json(serde_json::json!({"status": "ok", "e2ee": true})) }),
            )
            .route(
                "/api/v1/echo",
                post(|headers: axum::http::HeaderMap, body: String| async move {
                    let auth = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_owned();
                    Json(serde_json::json!({
                        "auth": auth,
                        "received": serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default(),
                    }))
                }),
            )
            .layer(middleware::from_fn(e2ee_middleware));

        let rng = SystemRandom::new();
        let client_priv = EphemeralPrivateKey::generate(&ECDH_P256, &rng).expect("client key");
        let client_pub = client_priv.compute_public_key().expect("client pub");
        let client_pub_b64 = STANDARD.encode(client_pub.as_ref());

        // 1. Handshake on /health
        let health_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header(HEADER_E2EE_CLIENT_PUB, &client_pub_b64)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("health response");
        assert_eq!(health_resp.status(), StatusCode::OK);
        let session_id = health_resp
            .headers()
            .get(HEADER_E2EE_SESSION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let server_pub_b64 = health_resp
            .headers()
            .get(HEADER_E2EE_SERVER_PUB)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();

        let server_pub_bytes = STANDARD.decode(&server_pub_b64).expect("decode server pub");
        let client_key = agree_ephemeral(
            client_priv,
            &UnparsedPublicKey::new(&ECDH_P256, &server_pub_bytes),
            |shared_secret| derive_aes256_key(shared_secret),
        )
        .expect("derive client key");

        // 2. Encrypted POST request with encrypted Authorization header
        let encrypted_auth =
            encrypt_payload(&client_key, AAD_AUTH, b"Bearer secret-companion-token").unwrap();
        let encrypted_body =
            encrypt_payload(&client_key, AAD_REQ, br#"{"hello":"world"}"#).unwrap();

        let echo_resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/echo")
                    .header(HEADER_E2EE, E2EE_VERSION)
                    .header(HEADER_E2EE_SESSION, &session_id)
                    .header(HEADER_E2EE_CLIENT_PUB, &client_pub_b64)
                    .header(HEADER_E2EE_AUTH, &encrypted_auth)
                    .header(header::AUTHORIZATION, "Bearer e2ee")
                    .body(Body::from(encrypted_body))
                    .unwrap(),
            )
            .await
            .expect("echo response");

        assert_eq!(echo_resp.status(), StatusCode::OK);
        assert_eq!(
            echo_resp
                .headers()
                .get(HEADER_E2EE)
                .unwrap()
                .to_str()
                .unwrap(),
            E2EE_VERSION
        );
        let resp_cipher_bytes = axum::body::to_bytes(echo_resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let resp_cipher_str = std::str::from_utf8(&resp_cipher_bytes).unwrap();
        let decrypted_resp =
            decrypt_payload(&client_key, AAD_RESP, resp_cipher_str).expect("decrypt response");
        let json_resp: serde_json::Value = serde_json::from_slice(&decrypted_resp).unwrap();
        assert_eq!(json_resp["auth"], "Bearer secret-companion-token");
        assert_eq!(json_resp["received"]["hello"], "world");
    }
}
