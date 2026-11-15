//! Standard Webhooks (`whsec_`) verifier enforcing pre-JSON payload caps,
//! 5-minute replay windows, and constant-time HMAC-SHA256 verification.

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::{Choice, ConstantTimeEq};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

pub const MAX_WEBHOOK_PAYLOAD_BYTES: usize = 64 * 1024;
pub const WEBHOOK_REPLAY_WINDOW_SECS: i64 = 300;
pub const WEBHOOK_SECRET_PREFIX: &str = "whsec_";

#[derive(Debug, Clone, Copy)]
pub struct StandardWebhookHeaders<'a> {
    pub webhook_id: &'a str,
    pub webhook_timestamp: &'a str,
    pub webhook_signature: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedWebhookPayload {
    pub delivery_id: String,
    pub timestamp: i64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WebhookVerifyError {
    #[error("webhook payload size {size} bytes exceeds maximum {max} bytes")]
    PayloadTooLarge { size: usize, max: usize },
    #[error("missing or empty required header `{0}`")]
    MissingHeader(&'static str),
    #[error("invalid webhook signing secret")]
    InvalidSecret,
    #[error("invalid webhook-timestamp header")]
    InvalidTimestamp,
    #[error("webhook timestamp outside 5-minute replay window (skew {skew_seconds}s)")]
    ReplayWindowExpired { skew_seconds: i64 },
    #[error("invalid webhook-signature format (expected `v1,<base64>`)")]
    InvalidSignatureFormat,
    #[error("webhook HMAC-SHA256 signature verification failed")]
    SignatureMismatch,
    #[error("invalid UTF-8 JSON webhook payload: {0}")]
    InvalidJson(String),
}

/// Computes a Standard Webhooks `v1,<base64>` signature header value.
pub fn sign_standard_webhook(
    secret: &str,
    webhook_id: &str,
    timestamp: i64,
    raw_body: &[u8],
) -> Result<String, WebhookVerifyError> {
    if webhook_id.trim().is_empty() {
        return Err(WebhookVerifyError::MissingHeader("webhook-id"));
    }
    let key_bytes = decode_signing_secret(secret)?;
    let ts_str = timestamp.to_string();
    let digest = compute_hmac_sha256(&key_bytes, webhook_id, &ts_str, raw_body)?;
    Ok(format!("v1,{}", STANDARD.encode(digest)))
}

/// Verifies a Standard Webhooks request in strict security order:
/// 1. Enforce `raw_body.len() <= 64 KiB` BEFORE any parsing.
/// 2. Validate `webhook-id`, `webhook-timestamp`, and 5-minute replay window (`abs(now - ts) <= 300s`).
/// 3. Compute `HMAC-SHA256(secret, "{id}.{timestamp}.{raw_body}")` and compare in constant time.
/// 4. Parse `serde_json::from_slice` ONLY after cryptographic verification succeeds.
pub fn verify_standard_webhook(
    secret: &str,
    headers: StandardWebhookHeaders<'_>,
    raw_body: &[u8],
    now: DateTime<Utc>,
) -> Result<VerifiedWebhookPayload, WebhookVerifyError> {
    if raw_body.len() > MAX_WEBHOOK_PAYLOAD_BYTES {
        return Err(WebhookVerifyError::PayloadTooLarge {
            size: raw_body.len(),
            max: MAX_WEBHOOK_PAYLOAD_BYTES,
        });
    }

    let webhook_id = headers.webhook_id.trim();
    if webhook_id.is_empty() {
        return Err(WebhookVerifyError::MissingHeader("webhook-id"));
    }

    let ts_raw = headers.webhook_timestamp.trim();
    if ts_raw.is_empty() {
        return Err(WebhookVerifyError::MissingHeader("webhook-timestamp"));
    }

    let sig_header = headers.webhook_signature.trim();
    if sig_header.is_empty() {
        return Err(WebhookVerifyError::MissingHeader("webhook-signature"));
    }

    let timestamp = ts_raw
        .parse::<i64>()
        .map_err(|_| WebhookVerifyError::InvalidTimestamp)?;
    let skew_seconds = now.timestamp().saturating_sub(timestamp).abs();
    if skew_seconds > WEBHOOK_REPLAY_WINDOW_SECS {
        return Err(WebhookVerifyError::ReplayWindowExpired { skew_seconds });
    }

    let key_bytes = decode_signing_secret(secret)?;
    let candidate_digests = parse_v1_signatures(sig_header)?;
    let expected_digest = compute_hmac_sha256(&key_bytes, webhook_id, ts_raw, raw_body)?;

    let mut matched = Choice::from(0u8);
    for candidate in &candidate_digests {
        matched |= expected_digest.ct_eq(candidate);
    }

    if !bool::from(matched) {
        return Err(WebhookVerifyError::SignatureMismatch);
    }

    let payload: serde_json::Value = serde_json::from_slice(raw_body)
        .map_err(|err| WebhookVerifyError::InvalidJson(err.to_string()))?;

    Ok(VerifiedWebhookPayload {
        delivery_id: webhook_id.to_string(),
        timestamp,
        payload,
    })
}

fn decode_signing_secret(secret: &str) -> Result<Vec<u8>, WebhookVerifyError> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err(WebhookVerifyError::InvalidSecret);
    }

    if let Some(encoded) = trimmed.strip_prefix(WEBHOOK_SECRET_PREFIX) {
        if encoded.is_empty() {
            return Err(WebhookVerifyError::InvalidSecret);
        }
        let decoded =
            decode_base64_flexible(encoded).map_err(|_| WebhookVerifyError::InvalidSecret)?;
        if decoded.is_empty() {
            return Err(WebhookVerifyError::InvalidSecret);
        }
        Ok(decoded)
    } else {
        Ok(trimmed.as_bytes().to_vec())
    }
}

fn parse_v1_signatures(header: &str) -> Result<Vec<[u8; 32]>, WebhookVerifyError> {
    let mut digests = Vec::new();
    for token in header.split_whitespace() {
        let Some((version, b64_sig)) = token.split_once(',') else {
            continue;
        };
        if version != "v1" {
            continue;
        }
        if b64_sig.is_empty() {
            return Err(WebhookVerifyError::InvalidSignatureFormat);
        }
        let bytes = decode_base64_flexible(b64_sig)
            .map_err(|_| WebhookVerifyError::InvalidSignatureFormat)?;
        let digest: [u8; 32] = bytes
            .try_into()
            .map_err(|_| WebhookVerifyError::InvalidSignatureFormat)?;
        digests.push(digest);
    }

    if digests.is_empty() {
        return Err(WebhookVerifyError::InvalidSignatureFormat);
    }
    Ok(digests)
}

fn decode_base64_flexible(input: &str) -> Result<Vec<u8>, base64::DecodeError> {
    STANDARD
        .decode(input)
        .or_else(|_| STANDARD_NO_PAD.decode(input.trim_end_matches('=')))
}

fn compute_hmac_sha256(
    key: &[u8],
    webhook_id: &str,
    timestamp_str: &str,
    raw_body: &[u8],
) -> Result<[u8; 32], WebhookVerifyError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| WebhookVerifyError::InvalidSecret)?;
    mac.update(webhook_id.as_bytes());
    mac.update(b".");
    mac.update(timestamp_str.as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    Ok(out)
}
