use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{DevicePermissionPreset, PairingChallenge, PairingId};

/// One reachable origin for a Host, never a Host identity by itself.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct ReachabilityOrigin {
    pub origin: String,
    pub kind: String,
}

impl ReachabilityOrigin {
    pub fn lan(origin: impl Into<String>) -> Self {
        Self {
            origin: origin.into(),
            kind: "lan".to_string(),
        }
    }

    pub fn published(origin: impl Into<String>) -> Self {
        Self {
            origin: origin.into(),
            kind: "published".to_string(),
        }
    }
}

/// Payload inside a `vibex-pairing:` invitation. Long-lived credentials must
/// never appear here.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PairingInvitationPayload {
    pub version: u32,
    pub host_id: String,
    pub preset: String,
    pub expires_at: String,
    pub pairing_id: String,
    pub pairing_token: String,
    pub reachability: Vec<ReachabilityOrigin>,
}

impl PairingInvitationPayload {
    pub const VERSION: u32 = 1;

    pub fn from_challenge(
        host_id: impl Into<String>,
        preset: DevicePermissionPreset,
        challenge: &PairingChallenge,
        reachability: impl IntoIterator<Item = ReachabilityOrigin>,
    ) -> Self {
        Self {
            version: Self::VERSION,
            host_id: host_id.into(),
            preset: preset.as_str().to_string(),
            expires_at: challenge.expires_at.clone(),
            pairing_id: challenge.pairing_id.to_string(),
            pairing_token: challenge.pairing_token.clone(),
            reachability: reachability
                .into_iter()
                .filter(|item| {
                    !is_loopback_origin(&item.origin)
                        && !is_public_plaintext_http_origin(&item.origin)
                })
                .collect(),
        }
    }

    pub fn encode(&self) -> String {
        format!(
            "vibex-pairing:{}",
            serde_json::to_string(self).expect("pairing invitation serializes")
        )
    }
}

/// Host-console issuance: the redeemable challenge plus the scannable text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssuedPairingInvitation {
    pub host_id: String,
    pub pairing_id: PairingId,
    pub pairing_token: String,
    pub expires_at: String,
    pub requested_scopes: Vec<String>,
    pub preset: String,
    pub reachability: Vec<ReachabilityOrigin>,
    pub invitation: String,
    pub connection_code: String,
}

impl IssuedPairingInvitation {
    pub fn from_payload(challenge: PairingChallenge, payload: PairingInvitationPayload) -> Self {
        Self {
            host_id: payload.host_id.clone(),
            pairing_id: challenge.pairing_id,
            pairing_token: challenge.pairing_token.clone(),
            expires_at: challenge.expires_at,
            requested_scopes: challenge.requested_scopes,
            preset: payload.preset.clone(),
            reachability: payload.reachability.clone(),
            invitation: payload.encode(),
            connection_code: challenge.pairing_token,
        }
    }
}

/// Eight-character Host console code for manual pairing. Unambiguous alphabet.
pub const CONNECTION_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CONNECTION_CODE_LEN: usize = 8;

pub fn issue_connection_code() -> String {
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(CONNECTION_CODE_LEN)
        .map(|byte| {
            CONNECTION_CODE_ALPHABET[(*byte as usize) % CONNECTION_CODE_ALPHABET.len()] as char
        })
        .collect()
}

pub fn is_connection_code(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() == CONNECTION_CODE_LEN
        && trimmed
            .bytes()
            .all(|byte| CONNECTION_CODE_ALPHABET.contains(&byte.to_ascii_uppercase()))
}

pub fn is_loopback_origin(origin: &str) -> bool {
    let Some((_, host)) = origin_scheme_and_host(origin) else {
        let lowered = origin.to_ascii_lowercase();
        return lowered.contains("127.0.0.1")
            || lowered.contains("localhost")
            || lowered.contains("[::1]");
    };
    host_is_loopback(&host)
}

/// Public HTTP origins cannot carry device credentials. Loopback, RFC1918,
/// link-local, unique-local, CGNAT/tailnet, and `.local` mDNS may use HTTP.
pub fn origin_allows_plaintext_http(origin: &str) -> bool {
    let Some((scheme, host)) = origin_scheme_and_host(origin) else {
        return false;
    };
    scheme == "http" && host_is_private_or_loopback(&host)
}

pub fn is_public_plaintext_http_origin(origin: &str) -> bool {
    let Some((scheme, host)) = origin_scheme_and_host(origin) else {
        return false;
    };
    scheme == "http" && !host_is_private_or_loopback(&host)
}

fn origin_scheme_and_host(origin: &str) -> Option<(&'static str, String)> {
    let origin = origin.trim();
    let (scheme, rest) = if let Some(rest) = origin.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = origin.strip_prefix("http://") {
        ("http", rest)
    } else {
        return None;
    };
    let hostport = rest.split('/').next().unwrap_or(rest);
    let host = if let Some(rest) = hostport.strip_prefix('[') {
        let end = rest.find(']')?;
        rest[..end].to_string()
    } else {
        match hostport.rsplit_once(':') {
            Some((host, port)) if port.bytes().all(|byte| byte.is_ascii_digit()) => {
                host.to_string()
            }
            _ => hostport.to_string(),
        }
    };
    if host.is_empty() {
        None
    } else {
        Some((scheme, host))
    }
}

fn host_is_loopback(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();
    if lowered == "localhost" || lowered.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = lowered.parse::<std::net::Ipv4Addr>() {
        return ip.is_loopback();
    }
    if let Ok(ip) = lowered.parse::<std::net::Ipv6Addr>() {
        return ip.is_loopback();
    }
    false
}

fn host_is_private_or_loopback(host: &str) -> bool {
    if host_is_loopback(host) {
        return true;
    }
    let lowered = host.to_ascii_lowercase();
    if lowered.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = lowered.parse::<std::net::Ipv4Addr>() {
        return ip.is_private() || ip.is_link_local() || is_cgnat_v4(ip);
    }
    if let Ok(ip) = lowered.parse::<std::net::Ipv6Addr>() {
        return ip.is_unique_local() || ip.is_unicast_link_local();
    }
    false
}

fn is_cgnat_v4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && octets[1] & 0xc0 == 64
}
