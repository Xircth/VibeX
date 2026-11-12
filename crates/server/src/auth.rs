use std::{
    collections::BTreeSet,
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use application::Principal;
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use hkdf::Hkdf;
use remote_protocol::{
    CHANNEL_BINDING_MAX_SKEW_SECONDS, ChannelBindingClaims, CreateDeviceConnectRequest,
    CreatePairingRequest, DeviceConnectRequestStatus, DeviceCredential, DeviceId,
    DevicePermissionPreset, PAIRING_TTL_DEFAULT_SECONDS, PairingChallenge, PairingId,
    PendingDeviceConnectRequest, PollDeviceConnectResponse, RedeemPairingRequest,
    RevokeDeviceResponse, resolve_pairing_ttl_seconds,
};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

const DEVICE_SCOPES: &[&str] = DevicePermissionPreset::workstation_scopes();

pub(crate) const ADMIN_SCOPES: &[&str] = &[
    "conversation.read",
    "conversation.write",
    "conversation.attach",
    "conversation.permission",
    "conversation.question",
    "conversation.cancel",
    "conversation.steer",
    "application.call",
    "plugin.read",
    "plugin.write",
    "plugin.surface",
    "artifact.read",
    "artifact.preview",
    "automation.read",
    "automation.write",
    "delegation.read",
    "delegation.cancel",
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.approve",
    "workflow.internal",
    "device.pair",
    "device.revoke",
    "notification.summary",
    "offline.read",
    "workspace.terminal",
];

/// Plaintext bearer token accepted only at the composition boundary.
///
/// The server runtime immediately converts this value to a SHA-256 digest and
/// never stores the plaintext in router state.
#[derive(Clone)]
pub struct ServerToken(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("server token must contain at least 32 bytes and 12 distinct byte values")]
pub struct ServerTokenError;

impl ServerToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self::try_new(value).expect("server token must contain at least 32 bytes")
    }

    pub fn try_new(value: impl Into<String>) -> Result<Self, ServerTokenError> {
        let value = value.into();
        let distinct = value.bytes().collect::<BTreeSet<_>>().len();
        if value.len() < 32 || distinct < 12 {
            return Err(ServerTokenError);
        }
        Ok(Self(value))
    }

    pub(crate) fn digest(&self) -> TokenDigest {
        TokenDigest::from_secret(&self.0)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume a newly-issued token so a composition root can display it once.
    pub fn expose_once(self) -> String {
        self.0
    }
}

impl fmt::Debug for ServerToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServerToken([REDACTED])")
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) struct TokenDigest([u8; 32]);

impl TokenDigest {
    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub(crate) fn from_secret(secret: &str) -> Self {
        Self(Sha256::digest(secret.as_bytes()).into())
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn verifies(&self, candidate: &str) -> bool {
        let candidate = Self::from_secret(candidate);
        self.0
            .iter()
            .zip(candidate.0)
            .fold(0_u8, |difference, (expected, actual)| {
                difference | (expected ^ actual)
            })
            == 0
    }
}

/// Opaque, clonable authentication material containing only a token digest.
#[derive(Clone)]
pub struct ServerCredentials {
    pub(crate) token_digest: TokenDigest,
}

impl ServerCredentials {
    pub(crate) fn from_token(token: &ServerToken) -> Self {
        Self {
            token_digest: token.digest(),
        }
    }

    pub(crate) const fn from_digest(token_digest: TokenDigest) -> Self {
        Self { token_digest }
    }
}

impl fmt::Debug for ServerCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServerCredentials([SHA-256])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialKind {
    Server,
    Device,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PairedDeviceRecord {
    pub device_id: DeviceId,
    pub device_name: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub preset: Option<DevicePermissionPreset>,
    #[serde(default)]
    pub client_kind: Option<String>,
    #[serde(default)]
    pub ip_address: Option<String>,
    #[serde(default)]
    pub last_connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_ed25519: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TrustWebRtcDeviceRequest {
    pub device_id: DeviceId,
    pub device_name: String,
    pub public_key_ed25519: String,
    pub preset: DevicePermissionPreset,
}

/// Derives the 4-digit decimal Short Authentication String (SAS) from both
/// peers' Ed25519 public keys and the `session_nonce` via HKDF-SHA256.
pub fn compute_sas_code(
    host_pub_ed25519: &[u8; 32],
    device_pub_ed25519: &[u8; 32],
    session_nonce: &str,
) -> String {
    let mut ikm = [0u8; 64];
    ikm[..32].copy_from_slice(host_pub_ed25519);
    ikm[32..].copy_from_slice(device_pub_ed25519);
    let hk = Hkdf::<Sha256>::new(Some(session_nonce.as_bytes()), &ikm);
    let mut okm = [0u8; 2];
    hk.expand(b"vibex-webrtc-sas-v1", &mut okm)
        .expect("2-byte HKDF expansion never exceeds max length");
    let code = u16::from_be_bytes(okm) % 10_000;
    format!("{code:04}")
}

/// Verifies that the DTLS peer certificate SHA-256 fingerprint from the active
/// WebRTC transport matches the `<dtls_fingerprint>` signed in the signaling offer/answer.
pub fn verify_peer_dtls_fingerprint(
    expected_signed_fingerprint: &str,
    peer_cert_fingerprint: &str,
) -> bool {
    let expected = expected_signed_fingerprint.trim().to_ascii_uppercase();
    let actual = peer_cert_fingerprint.trim().to_ascii_uppercase();
    if expected.is_empty() || expected.len() != actual.len() {
        return false;
    }
    expected
        .bytes()
        .zip(actual.bytes())
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn parse_ed25519_public_key(raw: &str) -> Result<([u8; 32], String), AuthStoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AuthStoreError::InvalidPublicKey);
    }
    let decoded = BASE64
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed))
        .map_err(|_| AuthStoreError::InvalidPublicKey)?;
    let bytes: [u8; 32] = decoded
        .try_into()
        .map_err(|_| AuthStoreError::InvalidPublicKey)?;
    Ok((bytes, BASE64.encode(bytes)))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedCredential {
    pub credential_id: String,
    pub kind: CredentialKind,
    pub subject: String,
    pub device_id: Option<DeviceId>,
    pub scopes: BTreeSet<String>,
}

impl AuthenticatedCredential {
    /// The Host console owner. It can issue any pairing preset; it is not a device.
    pub fn host_console_owner() -> Self {
        Self {
            credential_id: "local-host-owner".to_owned(),
            kind: CredentialKind::Server,
            subject: "server-owner".to_owned(),
            device_id: None,
            scopes: ADMIN_SCOPES
                .iter()
                .map(|scope| (*scope).to_owned())
                .collect(),
        }
    }

    pub fn principal(&self) -> Principal {
        Principal::remote_credential(
            self.subject.clone(),
            self.credential_id.clone(),
            self.device_id.map(|device_id| device_id.to_string()),
            self.scopes.iter().cloned(),
        )
    }

    pub fn allows(&self, scope: &str) -> bool {
        self.scopes.contains(scope)
    }

    /// Resolve a public capability through the shared authorization policy.
    ///
    /// Capabilities normally use the same identifier as their required scope.
    /// `preview.proxy` is a transport description of `artifact.preview`, not a
    /// second privilege, so it deliberately shares that scope.
    pub fn grants_capability(&self, capability: &str) -> bool {
        let required_scope = match capability {
            "preview.proxy" => "artifact.preview",
            "file.read" | "file.write" | "git.read" | "git.write" | "terminal"
            | "workspace.read" | "workspace.write" | "project.write" | "session.write"
            | "agent.read" | "agent.write" => "application.call",
            scope => scope,
        };
        self.allows(required_scope)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthStoreError {
    #[error("authentication store failed")]
    Database(#[from] sqlx::Error),
    #[error("requested device scope is not allowed")]
    InvalidScope,
    #[error("pairing token is invalid")]
    InvalidPairing,
    #[error("pairing token has expired")]
    PairingExpired,
    #[error("pairing token was already redeemed")]
    PairingRedeemed,
    #[error("device name is invalid")]
    InvalidDeviceName,
    #[error("device Ed25519 public key is invalid")]
    InvalidPublicKey,
    #[error("channel binding signature is invalid")]
    InvalidChannelBindingSignature,
    #[error("channel binding recipient host_id does not match")]
    ChannelBindingRecipientMismatch,
    #[error("channel binding timestamp is outside the allowed 60s window")]
    ChannelBindingTimestampSkew,
    #[error("channel binding session_nonce was already used")]
    ChannelBindingReplay,
    #[error("device credential was not found")]
    DeviceNotFound,
    #[error("credential lacks the required scope")]
    Forbidden,
    #[error("device pairing is unavailable for this server composition")]
    PairingUnavailable,
    #[error("another mobile device ({existing_device_name}) is already connected to this computer")]
    MobileDeviceConflict {
        existing_device_id: DeviceId,
        existing_device_name: String,
    },
}

pub trait AuthClock: Send + Sync {
    fn unix_seconds(&self) -> i64;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemAuthClock;

impl AuthClock for SystemAuthClock {
    fn unix_seconds(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs() as i64)
    }
}

#[async_trait]
pub trait ServerAuth: Send + Sync {
    async fn authenticate(
        &self,
        candidate: &str,
    ) -> Result<Option<AuthenticatedCredential>, AuthStoreError>;

    async fn is_active(&self, credential: &AuthenticatedCredential)
    -> Result<bool, AuthStoreError>;

    async fn create_pairing(
        &self,
        creator: &AuthenticatedCredential,
        request: CreatePairingRequest,
    ) -> Result<PairingChallenge, AuthStoreError>;

    async fn redeem_pairing(
        &self,
        request: RedeemPairingRequest,
    ) -> Result<DeviceCredential, AuthStoreError>;

    async fn revoke_device(
        &self,
        actor: &AuthenticatedCredential,
        device_id: DeviceId,
    ) -> Result<RevokeDeviceResponse, AuthStoreError>;

    async fn list_devices(
        &self,
        actor: &AuthenticatedCredential,
    ) -> Result<Vec<PairedDeviceRecord>, AuthStoreError>;

    async fn record_device_connection(
        &self,
        _device_id: DeviceId,
        _client_kind: Option<&str>,
        _ip_address: Option<&str>,
    ) -> Result<(), AuthStoreError> {
        Ok(())
    }

    async fn create_connect_request(
        &self,
        _host_id: &str,
        _request: CreateDeviceConnectRequest,
        _ip_address: Option<&str>,
        _account_display_name: Option<&str>,
    ) -> Result<PollDeviceConnectResponse, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn poll_connect_request(
        &self,
        _host_id: &str,
        _request_id: PairingId,
    ) -> Result<PollDeviceConnectResponse, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn list_connect_requests(
        &self,
        _actor: &AuthenticatedCredential,
    ) -> Result<Vec<PendingDeviceConnectRequest>, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn respond_connect_request(
        &self,
        _actor: &AuthenticatedCredential,
        _request_id: PairingId,
        _approve: bool,
    ) -> Result<(), AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }
}

pub(crate) struct StaticServerAuth {
    credentials: ServerCredentials,
    credential: AuthenticatedCredential,
}

impl StaticServerAuth {
    pub(crate) fn new(credentials: ServerCredentials) -> Self {
        Self {
            credentials,
            credential: AuthenticatedCredential {
                credential_id: "static-server-token".to_owned(),
                kind: CredentialKind::Server,
                subject: "server-token".to_owned(),
                device_id: None,
                scopes: ADMIN_SCOPES
                    .iter()
                    .map(|scope| (*scope).to_owned())
                    .collect(),
            },
        }
    }
}

#[async_trait]
impl ServerAuth for StaticServerAuth {
    async fn authenticate(
        &self,
        candidate: &str,
    ) -> Result<Option<AuthenticatedCredential>, AuthStoreError> {
        Ok(self
            .credentials
            .token_digest
            .verifies(candidate)
            .then(|| self.credential.clone()))
    }

    async fn is_active(
        &self,
        credential: &AuthenticatedCredential,
    ) -> Result<bool, AuthStoreError> {
        Ok(credential == &self.credential)
    }

    async fn create_pairing(
        &self,
        _creator: &AuthenticatedCredential,
        _request: CreatePairingRequest,
    ) -> Result<PairingChallenge, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn redeem_pairing(
        &self,
        _request: RedeemPairingRequest,
    ) -> Result<DeviceCredential, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn revoke_device(
        &self,
        _actor: &AuthenticatedCredential,
        _device_id: DeviceId,
    ) -> Result<RevokeDeviceResponse, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn list_devices(
        &self,
        _actor: &AuthenticatedCredential,
    ) -> Result<Vec<PairedDeviceRecord>, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }
}

#[derive(Clone)]
pub struct SqliteServerAuth {
    pool: SqlitePool,
    clock: Arc<dyn AuthClock>,
    pairing_ttl_seconds: i64,
}

impl SqliteServerAuth {
    pub fn new(pool: SqlitePool) -> Self {
        Self::with_clock(pool, Arc::new(SystemAuthClock))
    }

    pub fn with_clock(pool: SqlitePool, clock: Arc<dyn AuthClock>) -> Self {
        Self {
            pool,
            clock,
            pairing_ttl_seconds: PAIRING_TTL_DEFAULT_SECONDS,
        }
    }

    fn now(&self) -> i64 {
        self.clock.unix_seconds()
    }
}

#[async_trait]
impl ServerAuth for SqliteServerAuth {
    async fn authenticate(
        &self,
        candidate: &str,
    ) -> Result<Option<AuthenticatedCredential>, AuthStoreError> {
        let digest = TokenDigest::from_secret(candidate);
        let prefer_device = candidate.starts_with("vbx_device_");

        if !prefer_device
            && let Some(row) = sqlx::query(
                "SELECT lower(hex(id)) AS id_key, scopes_json
                 FROM server_access_tokens
                 WHERE token_hash = ? AND revoked_at IS NULL
                 LIMIT 1",
            )
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&self.pool)
            .await?
        {
            return Ok(Some(AuthenticatedCredential {
                credential_id: row.try_get("id_key")?,
                kind: CredentialKind::Server,
                subject: "server-token".to_owned(),
                device_id: None,
                scopes: parse_scopes(row.try_get("scopes_json")?)?,
            }));
        }

        if let Some(row) = sqlx::query(
            "SELECT id, device_name, scopes_json
             FROM server_device_credentials
             WHERE token_hash = ? AND revoked_at_unix IS NULL
             LIMIT 1",
        )
        .bind(digest.as_bytes().as_slice())
        .fetch_optional(&self.pool)
        .await?
        {
            let id: String = row.try_get("id")?;
            let device_id = id
                .parse()
                .map_err(|error| sqlx::Error::Protocol(format!("invalid device id: {error}")))?;
            return Ok(Some(AuthenticatedCredential {
                credential_id: id,
                kind: CredentialKind::Device,
                subject: format!("device:{}", row.try_get::<String, _>("device_name")?),
                device_id: Some(device_id),
                scopes: parse_scopes(row.try_get("scopes_json")?)?,
            }));
        }

        if prefer_device
            && let Some(row) = sqlx::query(
                "SELECT lower(hex(id)) AS id_key, scopes_json
                 FROM server_access_tokens
                 WHERE token_hash = ? AND revoked_at IS NULL
                 LIMIT 1",
            )
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&self.pool)
            .await?
        {
            return Ok(Some(AuthenticatedCredential {
                credential_id: row.try_get("id_key")?,
                kind: CredentialKind::Server,
                subject: "server-token".to_owned(),
                device_id: None,
                scopes: parse_scopes(row.try_get("scopes_json")?)?,
            }));
        }

        Ok(None)
    }

    async fn is_active(
        &self,
        credential: &AuthenticatedCredential,
    ) -> Result<bool, AuthStoreError> {
        let query = match credential.kind {
            CredentialKind::Server => {
                "SELECT EXISTS(
                    SELECT 1 FROM server_access_tokens
                    WHERE lower(hex(id)) = ? AND revoked_at IS NULL
                ) AS active"
            }
            CredentialKind::Device => {
                "SELECT EXISTS(
                    SELECT 1 FROM server_device_credentials
                    WHERE id = ? AND revoked_at_unix IS NULL
                ) AS active"
            }
        };
        let active: i64 = sqlx::query(query)
            .bind(&credential.credential_id)
            .fetch_one(&self.pool)
            .await?
            .try_get("active")?;
        Ok(active == 1)
    }

    async fn create_pairing(
        &self,
        creator: &AuthenticatedCredential,
        request: CreatePairingRequest,
    ) -> Result<PairingChallenge, AuthStoreError> {
        if !creator.allows("device.pair") {
            return Err(AuthStoreError::Forbidden);
        }
        let ttl_seconds = match request.ttl_seconds {
            Some(seconds) if seconds == resolve_pairing_ttl_seconds(Some(seconds)) => seconds,
            _ => self.pairing_ttl_seconds,
        };
        let scopes = resolve_pairing_scopes(&creator.scopes, request)?;
        let pairing_id = PairingId::new();
        let pairing_token = remote_protocol::issue_connection_code();
        let digest = TokenDigest::from_secret(&pairing_token);
        let created_at = self.now();
        let expires_at = created_at.saturating_add(ttl_seconds);
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO server_pairing_challenges
             (id, token_hash, scopes_json, created_by_token_id, created_at_unix, expires_at_unix)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(pairing_id.to_string())
        .bind(digest.as_bytes().as_slice())
        .bind(serde_json::to_string(&scopes).expect("scopes serialize"))
        .bind(&creator.credential_id)
        .bind(created_at)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO server_auth_audit_events
             (id, event_kind, actor_credential_id, actor_device_id, target_id, outcome,
              occurred_at_unix)
             VALUES (?, 'pairing_created', ?, ?, ?, 'succeeded', ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&creator.credential_id)
        .bind(creator.device_id.map(|device_id| device_id.to_string()))
        .bind(pairing_id.to_string())
        .bind(created_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(PairingChallenge {
            pairing_id,
            pairing_token,
            expires_at: unix_timestamp(expires_at),
            requested_scopes: scopes,
        })
    }

    async fn redeem_pairing(
        &self,
        request: RedeemPairingRequest,
    ) -> Result<DeviceCredential, AuthStoreError> {
        let device_name = request.device_name.trim();
        if device_name.is_empty() || device_name.len() > 128 {
            return Err(AuthStoreError::InvalidDeviceName);
        }
        let digest = TokenDigest::from_secret(&remote_protocol::canonical_pairing_token(
            &request.pairing_token,
        ));
        let now = self.now();
        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result = async {
            let Some(row) = sqlx::query(
                "SELECT id, scopes_json, expires_at_unix, redeemed_at_unix
                 FROM server_pairing_challenges
                 WHERE token_hash = ?
                 LIMIT 1",
            )
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut *connection)
            .await?
            else {
                return Err(AuthStoreError::InvalidPairing);
            };
            if row.try_get::<Option<i64>, _>("redeemed_at_unix")?.is_some() {
                return Err(AuthStoreError::PairingRedeemed);
            }
            if row.try_get::<i64, _>("expires_at_unix")? <= now {
                return Err(AuthStoreError::PairingExpired);
            }
            let pairing_id: String = row.try_get("id")?;
            let scopes: Vec<String> =
                serde_json::from_str(row.try_get("scopes_json")?).map_err(|error| {
                    sqlx::Error::Protocol(format!("invalid pairing scopes: {error}"))
                })?;
            let preset = infer_preset(&scopes);
            let client_kind = request
                .client_kind
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| infer_client_kind(device_name, preset, None, false));
            let canonical_pubkey = match request.public_key_ed25519.as_deref() {
                Some(raw) => Some(parse_ed25519_public_key(raw)?.1),
                None => None,
            };

            if client_kind == "mobile"
                && !request.replace_existing_mobile
                && let Some((existing_device_id, existing_device_name)) =
                    find_conflicting_mobile_device(
                        &mut connection,
                        device_name,
                        canonical_pubkey.as_deref(),
                    )
                    .await?
            {
                return Err(AuthStoreError::MobileDeviceConflict {
                    existing_device_id,
                    existing_device_name,
                });
            }

            let claimed = sqlx::query(
                "UPDATE server_pairing_challenges
                 SET redeemed_at_unix = ?
                 WHERE id = ? AND redeemed_at_unix IS NULL AND expires_at_unix > ?",
            )
            .bind(now)
            .bind(&pairing_id)
            .bind(now)
            .execute(&mut *connection)
            .await?;
            if claimed.rows_affected() != 1 {
                return Err(AuthStoreError::PairingRedeemed);
            }

            let device_id = DeviceId::new();
            let access_token = format!(
                "vbx_device_{}{}",
                Uuid::new_v4().simple(),
                Uuid::new_v4().simple()
            );
            let device_digest = TokenDigest::from_secret(&access_token);
            if client_kind == "mobile" {
                revoke_all_active_mobile_devices(&mut connection, now).await?;
            } else if let Some(ref pubkey) = canonical_pubkey {
                sqlx::query(
                    "UPDATE server_device_credentials
                     SET revoked_at_unix = ?
                     WHERE public_key_ed25519 = ? AND revoked_at_unix IS NULL",
                )
                .bind(now)
                .bind(pubkey)
                .execute(&mut *connection)
                .await?;
            }
            sqlx::query(
                "INSERT INTO server_device_credentials
                 (id, token_hash, device_name, scopes_json, created_at_unix, client_kind,
                  last_connected_at_unix, public_key_ed25519)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(device_id.to_string())
            .bind(device_digest.as_bytes().as_slice())
            .bind(device_name)
            .bind(serde_json::to_string(&scopes).expect("scopes serialize"))
            .bind(now)
            .bind(&client_kind)
            .bind(now)
            .bind(canonical_pubkey)
            .execute(&mut *connection)
            .await?;
            sqlx::query(
                "INSERT INTO server_auth_audit_events
                 (id, event_kind, actor_credential_id, actor_device_id, target_id, outcome,
                  occurred_at_unix)
                 VALUES (?, 'pairing_redeemed', NULL, NULL, ?, 'succeeded', ?)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(device_id.to_string())
            .bind(now)
            .execute(&mut *connection)
            .await?;
            Ok(DeviceCredential {
                device_id,
                access_token,
                scopes,
            })
        }
        .await;
        match result {
            Ok(credential) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(credential)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    async fn revoke_device(
        &self,
        actor: &AuthenticatedCredential,
        device_id: DeviceId,
    ) -> Result<RevokeDeviceResponse, AuthStoreError> {
        if !actor.allows("device.revoke") {
            return Err(AuthStoreError::Forbidden);
        }
        let now = self.now();
        let mut transaction = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE server_device_credentials
             SET revoked_at_unix = ?
             WHERE id = ? AND revoked_at_unix IS NULL",
        )
        .bind(now)
        .bind(device_id.to_string())
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(AuthStoreError::DeviceNotFound);
        }
        sqlx::query(
            "INSERT INTO server_auth_audit_events
             (id, event_kind, actor_credential_id, actor_device_id, target_id, outcome,
              occurred_at_unix)
             VALUES (?, 'device_revoked', ?, ?, ?, 'succeeded', ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&actor.credential_id)
        .bind(actor.device_id.map(|device_id| device_id.to_string()))
        .bind(device_id.to_string())
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(RevokeDeviceResponse {
            device_id,
            revoked: true,
        })
    }

    async fn list_devices(
        &self,
        actor: &AuthenticatedCredential,
    ) -> Result<Vec<PairedDeviceRecord>, AuthStoreError> {
        if !actor.allows("device.pair") && !actor.allows("device.revoke") {
            return Err(AuthStoreError::Forbidden);
        }
        let rows = sqlx::query(
            "SELECT id, device_name, scopes_json, created_at_unix,
                    client_kind, last_ip, last_connected_at_unix, public_key_ed25519
             FROM server_device_credentials
             WHERE revoked_at_unix IS NULL
             ORDER BY COALESCE(last_connected_at_unix, created_at_unix) DESC, created_at_unix DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut devices = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let device_id = id
                .parse()
                .map_err(|error| sqlx::Error::Protocol(format!("invalid device id: {error}")))?;
            let scopes: Vec<String> =
                serde_json::from_str(row.try_get("scopes_json")?).map_err(|error| {
                    sqlx::Error::Protocol(format!("invalid device scopes: {error}"))
                })?;
            let device_name: String = row.try_get("device_name")?;
            let created_at_unix: i64 = row.try_get("created_at_unix")?;
            let preset = infer_preset(&scopes);
            let stored_client_kind: Option<String> = row.try_get("client_kind").ok().flatten();
            let client_kind = stored_client_kind
                .filter(|value| !value.trim().is_empty())
                .or_else(|| Some(infer_client_kind(&device_name, preset, None, false)));
            let ip_address: Option<String> = row
                .try_get::<Option<String>, _>("last_ip")
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty());
            let last_connected_at_unix: Option<i64> =
                row.try_get("last_connected_at_unix").ok().flatten();
            let public_key_ed25519: Option<String> = row
                .try_get::<Option<String>, _>("public_key_ed25519")
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty());
            devices.push(PairedDeviceRecord {
                device_id,
                device_name,
                created_at: unix_timestamp(created_at_unix),
                preset,
                scopes,
                client_kind,
                ip_address,
                last_connected_at: Some(unix_timestamp(
                    last_connected_at_unix.unwrap_or(created_at_unix),
                )),
                public_key_ed25519,
            });
        }
        Ok(devices)
    }

    async fn record_device_connection(
        &self,
        device_id: DeviceId,
        client_kind: Option<&str>,
        ip_address: Option<&str>,
    ) -> Result<(), AuthStoreError> {
        let now = self.now();
        sqlx::query(
            "UPDATE server_device_credentials
             SET client_kind = COALESCE(?, client_kind),
                 last_ip = COALESCE(?, last_ip),
                 last_connected_at_unix = ?
             WHERE id = ? AND revoked_at_unix IS NULL",
        )
        .bind(client_kind)
        .bind(ip_address)
        .bind(now)
        .bind(device_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn create_connect_request(
        &self,
        host_id: &str,
        request: CreateDeviceConnectRequest,
        ip_address: Option<&str>,
        account_display_name: Option<&str>,
    ) -> Result<PollDeviceConnectResponse, AuthStoreError> {
        let device_name = request.device_name.trim();
        if device_name.is_empty() || device_name.len() > 128 {
            return Err(AuthStoreError::InvalidDeviceName);
        }
        let parsed_pubkey = match request
            .public_key_ed25519
            .as_deref()
            .filter(|v| !v.trim().is_empty())
        {
            Some(raw) => Some(parse_ed25519_public_key(raw)?),
            None => None,
        };
        let client_kind = request
            .client_kind
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                infer_client_kind(
                    device_name,
                    Some(DevicePermissionPreset::Companion),
                    None,
                    false,
                )
            });

        let now = self.now();
        let expires_at = now.saturating_add(180);
        let host_name = utils::net::local_hostname();
        let incoming_pk = parsed_pubkey.as_ref().map(|(_, pk)| pk.as_str());

        if client_kind == "mobile" {
            let mut conn = self.pool.acquire().await?;
            if request.replace_existing_mobile {
                revoke_all_active_mobile_devices(&mut conn, now).await?;
            } else if let Some((existing_device_id, existing_device_name)) =
                find_conflicting_mobile_device(&mut conn, device_name, incoming_pk).await?
            {
                return Err(AuthStoreError::MobileDeviceConflict {
                    existing_device_id,
                    existing_device_name,
                });
            }
        }

        let existing_pending = if let Some((_, ref canonical_pk)) = parsed_pubkey {
            sqlx::query(
                "SELECT id, sas_code
                 FROM server_device_connect_requests
                 WHERE public_key_ed25519 = ? AND status = 'pending' AND expires_at_unix > ?
                 ORDER BY created_at_unix DESC
                 LIMIT 1",
            )
            .bind(canonical_pk)
            .bind(now)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT id, sas_code
                 FROM server_device_connect_requests
                 WHERE public_key_ed25519 IS NULL AND device_name = ? AND status = 'pending' AND expires_at_unix > ?
                 ORDER BY created_at_unix DESC
                 LIMIT 1",
            )
            .bind(device_name)
            .bind(now)
            .fetch_optional(&self.pool)
            .await?
        };

        if let Some(existing) = existing_pending {
            let id_str: String = existing.try_get("id")?;
            let sas_code: String = existing.try_get("sas_code")?;
            if let Ok(request_id) = id_str.parse::<PairingId>() {
                sqlx::query(
                    "UPDATE server_device_connect_requests
                     SET device_name = ?, ip_address = COALESCE(?, ip_address), expires_at_unix = ?,
    account_display_name = ?
       WHERE id = ?",
                )
                .bind(device_name)
                .bind(ip_address)
                .bind(expires_at)
                .bind(account_display_name)
                .bind(&id_str)
                .execute(&self.pool)
                .await?;
                return Ok(PollDeviceConnectResponse {
                    request_id,
                    host_id: host_id.to_owned(),
                    host_name,
                    sas_code,
                    status: DeviceConnectRequestStatus::Pending,
                    expires_at: unix_timestamp(expires_at),
                    credential: None,
                });
            }
        }

        let request_id = PairingId::new();
        let request_id_str = request_id.to_string();
        let host_bytes: [u8; 32] = Sha256::digest(host_id.as_bytes()).into();
        let device_bytes: [u8; 32] = match parsed_pubkey {
            Some((bytes, _)) => bytes,
            None => Sha256::digest(device_name.as_bytes()).into(),
        };
        let nonce = request
            .session_nonce
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&request_id_str);
        let sas_code = compute_sas_code(&host_bytes, &device_bytes, nonce);
        let canonical_pubkey = parsed_pubkey.map(|(_, pk)| pk);

        sqlx::query(
            "INSERT INTO server_device_connect_requests
             (id, device_name, client_kind, ip_address, public_key_ed25519, sas_code,
              status, created_at_unix, expires_at_unix, account_display_name)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        )
        .bind(&request_id_str)
        .bind(device_name)
        .bind(&client_kind)
        .bind(ip_address)
        .bind(canonical_pubkey)
        .bind(&sas_code)
        .bind(now)
        .bind(expires_at)
        .bind(account_display_name)
        .execute(&self.pool)
        .await?;

        Ok(PollDeviceConnectResponse {
            request_id,
            host_id: host_id.to_owned(),
            host_name,
            sas_code,
            status: DeviceConnectRequestStatus::Pending,
            expires_at: unix_timestamp(expires_at),
            credential: None,
        })
    }

    async fn poll_connect_request(
        &self,
        host_id: &str,
        request_id: PairingId,
    ) -> Result<PollDeviceConnectResponse, AuthStoreError> {
        let now = self.now();
        let id_str = request_id.to_string();
        let Some(row) = sqlx::query(
            "SELECT sas_code, status, issued_credential_json, expires_at_unix
             FROM server_device_connect_requests
             WHERE id = ?
             LIMIT 1",
        )
        .bind(&id_str)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Err(AuthStoreError::InvalidPairing);
        };

        let sas_code: String = row.try_get("sas_code")?;
        let raw_status: String = row.try_get("status")?;
        let expires_at_unix: i64 = row.try_get("expires_at_unix")?;
        let issued_json: Option<String> = row.try_get("issued_credential_json")?;

        let status = match raw_status.as_str() {
            "approved" => DeviceConnectRequestStatus::Approved,
            "rejected" => DeviceConnectRequestStatus::Rejected,
            _ if expires_at_unix <= now => DeviceConnectRequestStatus::Expired,
            _ => DeviceConnectRequestStatus::Pending,
        };

        let credential = if status == DeviceConnectRequestStatus::Approved {
            if let Some(json_str) = issued_json {
                let parsed = serde_json::from_str::<DeviceCredential>(&json_str).ok();
                if parsed.is_some() {
                    sqlx::query(
                        "UPDATE server_device_connect_requests
                         SET issued_credential_json = NULL
                         WHERE id = ?",
                    )
                    .bind(&id_str)
                    .execute(&self.pool)
                    .await?;
                }
                parsed
            } else {
                None
            }
        } else {
            None
        };

        Ok(PollDeviceConnectResponse {
            request_id,
            host_id: host_id.to_owned(),
            host_name: utils::net::local_hostname(),
            sas_code,
            status,
            expires_at: unix_timestamp(expires_at_unix),
            credential,
        })
    }

    async fn list_connect_requests(
        &self,
        actor: &AuthenticatedCredential,
    ) -> Result<Vec<PendingDeviceConnectRequest>, AuthStoreError> {
        if !actor.allows("device.pair") {
            return Err(AuthStoreError::Forbidden);
        }
        let now = self.now();
        let rows = sqlx::query(
            "SELECT id, device_name, client_kind, ip_address, sas_code, created_at_unix, expires_at_unix,
      account_display_name
      FROM server_device_connect_requests
             WHERE status = 'pending' AND expires_at_unix > ?
             ORDER BY created_at_unix DESC",
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await?;

        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let id_str: String = row.try_get("id")?;
            let Ok(request_id) = id_str.parse::<PairingId>() else {
                continue;
            };
            let created_at_unix: i64 = row.try_get("created_at_unix")?;
            let expires_at_unix: i64 = row.try_get("expires_at_unix")?;
            items.push(PendingDeviceConnectRequest {
                request_id,
                device_name: row.try_get("device_name")?,
                client_kind: row.try_get("client_kind")?,
                ip_address: row
                    .try_get::<Option<String>, _>("ip_address")
                    .ok()
                    .flatten()
                    .filter(|v| !v.trim().is_empty()),
                sas_code: row.try_get("sas_code")?,
                created_at: unix_timestamp(created_at_unix),
                expires_at: unix_timestamp(expires_at_unix),
                account_display_name: row.try_get("account_display_name")?,
            });
        }
        Ok(items)
    }

    async fn respond_connect_request(
        &self,
        actor: &AuthenticatedCredential,
        request_id: PairingId,
        approve: bool,
    ) -> Result<(), AuthStoreError> {
        if !actor.allows("device.pair") {
            return Err(AuthStoreError::Forbidden);
        }
        let now = self.now();
        let id_str = request_id.to_string();

        if !approve {
            let updated = sqlx::query(
                "UPDATE server_device_connect_requests
                 SET status = 'rejected', responded_at_unix = ?
                 WHERE id = ? AND status = 'pending'",
            )
            .bind(now)
            .bind(&id_str)
            .execute(&self.pool)
            .await?;
            if updated.rows_affected() == 0 {
                return Err(AuthStoreError::InvalidPairing);
            }
            return Ok(());
        }

        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await?;
        let result: Result<(), AuthStoreError> = async {
            let Some(row) = sqlx::query(
                "SELECT device_name, client_kind, ip_address, public_key_ed25519, status, expires_at_unix
                 FROM server_device_connect_requests
                 WHERE id = ?
                 LIMIT 1",
            )
            .bind(&id_str)
            .fetch_optional(&mut *connection)
            .await?
            else {
                return Err(AuthStoreError::InvalidPairing);
            };

            let status: String = row.try_get("status")?;
            let expires_at_unix: i64 = row.try_get("expires_at_unix")?;
            if status != "pending" {
                return Err(AuthStoreError::PairingRedeemed);
            }
            if expires_at_unix <= now {
                return Err(AuthStoreError::PairingExpired);
            }

            let device_name: String = row.try_get("device_name")?;
            let client_kind: String = row.try_get("client_kind")?;
            let ip_address: Option<String> = row.try_get("ip_address")?;
            let public_key_ed25519: Option<String> = row.try_get("public_key_ed25519")?;

            let preset = if client_kind == "mobile" {
                DevicePermissionPreset::Companion
            } else {
                DevicePermissionPreset::Workstation
            };
            let scopes = resolve_pairing_scopes(
                &actor.scopes,
                CreatePairingRequest {
                    preset: Some(preset),
                    requested_scopes: Vec::new(),
                    ttl_seconds: None,
                },
            )?;
            let device_id = DeviceId::new();
            let access_token = format!(
                "vbx_device_{}{}",
                Uuid::new_v4().simple(),
                Uuid::new_v4().simple()
            );
            let device_digest = TokenDigest::from_secret(&access_token);

            if client_kind == "mobile" {
                revoke_all_active_mobile_devices(&mut connection, now).await?;
            } else if let Some(ref pubkey) = public_key_ed25519 {
                sqlx::query(
                    "UPDATE server_device_credentials
                     SET revoked_at_unix = ?
                     WHERE public_key_ed25519 = ? AND revoked_at_unix IS NULL",
                )
                .bind(now)
                .bind(pubkey)
                .execute(&mut *connection)
                .await?;
            }

            sqlx::query(
                "INSERT INTO server_device_credentials
                 (id, token_hash, device_name, scopes_json, created_at_unix, client_kind,
                  last_ip, last_connected_at_unix, public_key_ed25519)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(device_id.to_string())
            .bind(device_digest.as_bytes().as_slice())
            .bind(&device_name)
            .bind(serde_json::to_string(&scopes).expect("scopes serialize"))
            .bind(now)
            .bind(&client_kind)
            .bind(ip_address)
            .bind(now)
            .bind(&public_key_ed25519)
            .execute(&mut *connection)
            .await?;

            let credential = DeviceCredential {
                device_id,
                access_token,
                scopes,
            };
            let credential_json =
                serde_json::to_string(&credential).expect("credential serializes");

            let claimed = sqlx::query(
                "UPDATE server_device_connect_requests
                 SET status = 'approved', issued_credential_json = ?, responded_at_unix = ?
                 WHERE id = ? AND status = 'pending'",
            )
            .bind(credential_json)
            .bind(now)
            .bind(&id_str)
            .execute(&mut *connection)
            .await?;
            if claimed.rows_affected() != 1 {
                return Err(AuthStoreError::PairingRedeemed);
            }

            sqlx::query(
                "INSERT INTO server_auth_audit_events
                 (id, event_kind, actor_credential_id, actor_device_id, target_id, outcome,
                  occurred_at_unix)
                 VALUES (?, 'pairing_redeemed', ?, ?, ?, 'succeeded', ?)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&actor.credential_id)
            .bind(actor.device_id.map(|id| id.to_string()))
            .bind(device_id.to_string())
            .bind(now)
            .execute(&mut *connection)
            .await?;

            Ok(())
        }
        .await;

        match result {
            Ok(()) => {
                sqlx::query("COMMIT").execute(&mut *connection).await?;
                Ok(())
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }
}

impl SqliteServerAuth {
    /// Persists a WebRTC device after the user approves the SAS prompt on the Host.
    pub async fn trust_webrtc_device(
        &self,
        actor: &AuthenticatedCredential,
        request: TrustWebRtcDeviceRequest,
    ) -> Result<PairedDeviceRecord, AuthStoreError> {
        if !actor.allows("device.pair") {
            return Err(AuthStoreError::Forbidden);
        }
        let device_name = request.device_name.trim();
        if device_name.is_empty() || device_name.len() > 128 {
            return Err(AuthStoreError::InvalidDeviceName);
        }
        let (_, canonical_pubkey) = parse_ed25519_public_key(&request.public_key_ed25519)?;
        let scopes = resolve_pairing_scopes(
            &actor.scopes,
            CreatePairingRequest {
                preset: Some(request.preset),
                requested_scopes: Vec::new(),
                ttl_seconds: None,
            },
        )?;
        let now = self.now();
        let synthetic_token = format!(
            "vbx_device_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let token_digest = TokenDigest::from_secret(&synthetic_token);
        let client_kind = infer_client_kind(device_name, Some(request.preset), None, false);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO server_device_credentials
             (id, token_hash, device_name, scopes_json, created_at_unix, client_kind,
              last_connected_at_unix, public_key_ed25519)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 device_name = excluded.device_name,
                 scopes_json = excluded.scopes_json,
                 client_kind = excluded.client_kind,
                 last_connected_at_unix = excluded.last_connected_at_unix,
                 public_key_ed25519 = excluded.public_key_ed25519,
                 revoked_at_unix = NULL",
        )
        .bind(request.device_id.to_string())
        .bind(token_digest.as_bytes().as_slice())
        .bind(device_name)
        .bind(serde_json::to_string(&scopes).expect("scopes serialize"))
        .bind(now)
        .bind(&client_kind)
        .bind(now)
        .bind(&canonical_pubkey)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO server_auth_audit_events
             (id, event_kind, actor_credential_id, actor_device_id, target_id, outcome,
              occurred_at_unix)
             VALUES (?, 'pairing_redeemed', ?, ?, ?, 'succeeded', ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&actor.credential_id)
        .bind(actor.device_id.map(|id| id.to_string()))
        .bind(request.device_id.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(PairedDeviceRecord {
            device_id: request.device_id,
            device_name: device_name.to_owned(),
            scopes,
            created_at: unix_timestamp(now),
            preset: Some(request.preset),
            client_kind: Some(client_kind),
            ip_address: None,
            last_connected_at: Some(unix_timestamp(now)),
            public_key_ed25519: Some(canonical_pubkey),
        })
    }

    /// Authenticates a WebRTC signaling offer/answer using its Ed25519-signed
    /// [`ChannelBindingClaims`], enforcing recipient match, `±60s` timestamp
    /// window, and replay protection on `session_nonce`.
    pub async fn authenticate_channel_binding(
        &self,
        local_host_id: &str,
        claims: &ChannelBindingClaims,
        signature_base64: &str,
    ) -> Result<AuthenticatedCredential, AuthStoreError> {
        if claims.recipient_device_id != local_host_id {
            return Err(AuthStoreError::ChannelBindingRecipientMismatch);
        }
        let now = self.now();
        if (now - claims.unix_timestamp).abs() > CHANNEL_BINDING_MAX_SKEW_SECONDS {
            return Err(AuthStoreError::ChannelBindingTimestampSkew);
        }
        let signature_bytes = BASE64
            .decode(signature_base64.trim())
            .or_else(|_| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(signature_base64.trim())
            })
            .map_err(|_| AuthStoreError::InvalidChannelBindingSignature)?;

        let Some(row) = sqlx::query(
            "SELECT id, device_name, scopes_json, public_key_ed25519
             FROM server_device_credentials
             WHERE id = ? AND revoked_at_unix IS NULL AND public_key_ed25519 IS NOT NULL
             LIMIT 1",
        )
        .bind(&claims.sender_device_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Err(AuthStoreError::DeviceNotFound);
        };

        let stored_pubkey: String = row.try_get("public_key_ed25519")?;
        let (pubkey_bytes, _) = parse_ed25519_public_key(&stored_pubkey)?;
        let verifier = UnparsedPublicKey::new(&ED25519, pubkey_bytes);
        verifier
            .verify(claims.signing_input().as_bytes(), &signature_bytes)
            .map_err(|_| AuthStoreError::InvalidChannelBindingSignature)?;

        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM webrtc_signaling_nonces WHERE expires_at_unix <= ?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO webrtc_signaling_nonces
             (session_nonce, sender_device_id, expires_at_unix)
             VALUES (?, ?, ?)",
        )
        .bind(&claims.session_nonce)
        .bind(&claims.sender_device_id)
        .bind(now.saturating_add(CHANNEL_BINDING_MAX_SKEW_SECONDS * 2))
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err(AuthStoreError::ChannelBindingReplay);
        }
        tx.commit().await?;

        let id: String = row.try_get("id")?;
        let device_id: DeviceId = id
            .parse()
            .map_err(|error| sqlx::Error::Protocol(format!("invalid device id: {error}")))?;
        let device_name: String = row.try_get("device_name")?;
        let scopes = parse_scopes(row.try_get("scopes_json")?)?;
        let _ = self
            .record_device_connection(device_id, None, Some("webrtc"))
            .await;

        Ok(AuthenticatedCredential {
            credential_id: id,
            kind: CredentialKind::Device,
            subject: format!("device:{device_name}"),
            device_id: Some(device_id),
            scopes,
        })
    }

    /// Synchronizes a list of revoked device IDs pulled from the Cloud directory
    /// upon Host startup before accepting inbound connections (Section 5.4 Step 3).
    pub async fn sync_revoked_devices(
        &self,
        actor: &AuthenticatedCredential,
        revoked_device_ids: &[DeviceId],
    ) -> Result<usize, AuthStoreError> {
        if !actor.allows("device.revoke") {
            return Err(AuthStoreError::Forbidden);
        }
        if revoked_device_ids.is_empty() {
            return Ok(0);
        }
        let now = self.now();
        let mut tx = self.pool.begin().await?;
        let mut count = 0_usize;
        for device_id in revoked_device_ids {
            let updated = sqlx::query(
                "UPDATE server_device_credentials
                 SET revoked_at_unix = ?
                 WHERE id = ? AND revoked_at_unix IS NULL",
            )
            .bind(now)
            .bind(device_id.to_string())
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() == 1 {
                count += 1;
                sqlx::query(
                    "INSERT INTO server_auth_audit_events
                     (id, event_kind, actor_credential_id, actor_device_id, target_id, outcome,
                      occurred_at_unix)
                     VALUES (?, 'device_revoked', ?, ?, ?, 'succeeded', ?)",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(&actor.credential_id)
                .bind(actor.device_id.map(|id| id.to_string()))
                .bind(device_id.to_string())
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(count)
    }
}

pub(crate) fn infer_client_kind(
    device_name: &str,
    preset: Option<DevicePermissionPreset>,
    user_agent: Option<&str>,
    has_origin: bool,
) -> String {
    let lower_name = device_name.to_ascii_lowercase();
    let lower_ua = user_agent.unwrap_or_default().to_ascii_lowercase();
    if lower_name.contains("web")
        || lower_name.contains("browser")
        || lower_name.contains("chrome")
        || lower_name.contains("safari")
        || lower_name.contains("edge")
        || lower_name.contains("firefox")
    {
        return "web".to_owned();
    }
    if lower_name.contains("iphone")
        || lower_name.contains("ipad")
        || lower_name.contains("android")
        || lower_name.contains("pixel")
        || lower_name.contains("mobile")
        || lower_name.contains("honor")
        || lower_name.contains("huawei")
        || lower_name.contains("xiaomi")
        || lower_name.contains("redmi")
        || lower_name.contains("oppo")
        || lower_name.contains("vivo")
        || lower_name.contains("oneplus")
        || lower_name.contains("samsung")
        || lower_name.contains("galaxy")
        || lower_name.contains("an00")
        || lower_name.contains("al00")
        || lower_name.starts_with("dio-")
        || preset == Some(DevicePermissionPreset::Companion)
    {
        return "mobile".to_owned();
    }
    if lower_name.contains("vibex (")
        || lower_name.contains("workstation")
        || lower_name.contains("desktop")
        || lower_name.contains("windows")
        || lower_name.contains("mac")
        || lower_name.contains("linux")
    {
        return "desktop".to_owned();
    }
    if has_origin
        && (lower_ua.contains("mozilla/")
            || lower_ua.contains("applewebkit")
            || lower_ua.contains("chrome/")
            || lower_ua.contains("safari/")
            || lower_ua.contains("firefox/"))
    {
        return "web".to_owned();
    }
    if lower_ua.contains("android") || lower_ua.contains("iphone") || lower_ua.contains("ipad") {
        return "mobile".to_owned();
    }
    "desktop".to_owned()
}

fn is_mobile_device_record(
    device_name: &str,
    stored_client_kind: Option<&str>,
    scopes_json: &str,
) -> bool {
    if let Some(kind) = stored_client_kind.map(str::trim).filter(|v| !v.is_empty()) {
        if kind.eq_ignore_ascii_case("mobile") {
            return true;
        }
        if kind.eq_ignore_ascii_case("web") {
            return false;
        }
    }
    let scopes: Vec<String> = serde_json::from_str(scopes_json).unwrap_or_default();
    let preset = infer_preset(&scopes);
    infer_client_kind(device_name, preset, None, false) == "mobile"
}

async fn find_conflicting_mobile_device(
    connection: &mut sqlx::SqliteConnection,
    incoming_device_name: &str,
    incoming_pubkey: Option<&str>,
) -> Result<Option<(DeviceId, String)>, AuthStoreError> {
    let rows = sqlx::query(
        "SELECT id, device_name, scopes_json, client_kind, public_key_ed25519
         FROM server_device_credentials
         WHERE revoked_at_unix IS NULL
         ORDER BY COALESCE(last_connected_at_unix, created_at_unix) DESC, created_at_unix DESC",
    )
    .fetch_all(&mut *connection)
    .await?;

    let incoming_name_trimmed = incoming_device_name.trim();
    for row in rows {
        let id_str: String = row.try_get("id")?;
        let existing_name: String = row.try_get("device_name")?;
        let scopes_json: String = row.try_get("scopes_json")?;
        let stored_kind: Option<String> = row.try_get("client_kind").ok().flatten();
        let existing_pk: Option<String> = row
            .try_get::<Option<String>, _>("public_key_ed25519")
            .ok()
            .flatten()
            .filter(|v| !v.trim().is_empty());

        if !is_mobile_device_record(&existing_name, stored_kind.as_deref(), &scopes_json) {
            continue;
        }
        let same_pubkey = match (incoming_pubkey, existing_pk.as_deref()) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
        let same_name = existing_name
            .trim()
            .eq_ignore_ascii_case(incoming_name_trimmed);
        if same_pubkey || same_name {
            continue;
        }
        if let Ok(device_id) = id_str.parse::<DeviceId>() {
            return Ok(Some((device_id, existing_name)));
        }
    }
    Ok(None)
}

async fn revoke_all_active_mobile_devices(
    connection: &mut sqlx::SqliteConnection,
    now: i64,
) -> Result<(), AuthStoreError> {
    let rows = sqlx::query(
        "SELECT id, device_name, scopes_json, client_kind
         FROM server_device_credentials
         WHERE revoked_at_unix IS NULL",
    )
    .fetch_all(&mut *connection)
    .await?;

    for row in rows {
        let id_str: String = row.try_get("id")?;
        let existing_name: String = row.try_get("device_name")?;
        let scopes_json: String = row.try_get("scopes_json")?;
        let stored_kind: Option<String> = row.try_get("client_kind").ok().flatten();
        if is_mobile_device_record(&existing_name, stored_kind.as_deref(), &scopes_json) {
            sqlx::query(
                "UPDATE server_device_credentials
                 SET revoked_at_unix = ?
                 WHERE id = ? AND revoked_at_unix IS NULL",
            )
            .bind(now)
            .bind(&id_str)
            .execute(&mut *connection)
            .await?;
        }
    }
    Ok(())
}

fn resolve_pairing_scopes(
    creator_scopes: &BTreeSet<String>,
    request: CreatePairingRequest,
) -> Result<Vec<String>, AuthStoreError> {
    let requested = match request.preset {
        Some(preset) if request.requested_scopes.is_empty() => preset
            .scopes()
            .iter()
            .map(|scope| (*scope).to_owned())
            .collect(),
        Some(preset) => {
            let allowed = preset.scopes().iter().copied().collect::<BTreeSet<_>>();
            if request
                .requested_scopes
                .iter()
                .any(|scope| !allowed.contains(scope.as_str()))
            {
                return Err(AuthStoreError::InvalidScope);
            }
            request.requested_scopes
        }
        None => request.requested_scopes,
    };
    normalize_device_scopes(creator_scopes, requested)
}

fn normalize_device_scopes(
    creator_scopes: &BTreeSet<String>,
    requested: Vec<String>,
) -> Result<Vec<String>, AuthStoreError> {
    if requested.is_empty() {
        return Err(AuthStoreError::InvalidScope);
    }
    let allowed = DEVICE_SCOPES.iter().copied().collect::<BTreeSet<_>>();
    let normalized = requested.into_iter().collect::<BTreeSet<_>>();
    if normalized
        .iter()
        .any(|scope| !allowed.contains(scope.as_str()) || !creator_scopes.contains(scope))
    {
        return Err(AuthStoreError::InvalidScope);
    }
    Ok(normalized.into_iter().collect())
}

fn parse_scopes(scopes_json: String) -> Result<BTreeSet<String>, sqlx::Error> {
    serde_json::from_str::<Vec<String>>(&scopes_json)
        .map(|scopes| scopes.into_iter().collect())
        .map_err(|error| sqlx::Error::Protocol(format!("invalid credential scopes: {error}")))
}

fn unix_timestamp(seconds: i64) -> String {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

pub(crate) fn infer_preset(scopes: &[String]) -> Option<DevicePermissionPreset> {
    let set = scopes.iter().map(String::as_str).collect::<BTreeSet<_>>();
    for preset in [
        DevicePermissionPreset::Companion,
        DevicePermissionPreset::Workstation,
    ] {
        let expected = preset.scopes().iter().copied().collect::<BTreeSet<_>>();
        if set == expected {
            return Some(preset);
        }
    }
    None
}

#[cfg(test)]
mod host_console_pairing_tests {
    use std::str::FromStr;

    use chrono::{DateTime, Utc};
    use remote_protocol::{CreatePairingRequest, DevicePermissionPreset, RedeemPairingRequest};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        AuthStoreError, AuthenticatedCredential, CredentialKind, ServerAuth, SqliteServerAuth,
    };

    async fn auth() -> SqliteServerAuth {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::from_str("sqlite::memory:")
                    .expect("sqlite options")
                    .foreign_keys(false),
            )
            .await
            .expect("memory database");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("migrations");
        SqliteServerAuth::new(pool)
    }

    #[tokio::test]
    async fn host_console_owner_can_issue_companion_and_workstation_pairings() {
        let auth = auth().await;
        let owner = AuthenticatedCredential::host_console_owner();
        for preset in [
            DevicePermissionPreset::Companion,
            DevicePermissionPreset::Workstation,
        ] {
            let challenge = auth
                .create_pairing(
                    &owner,
                    CreatePairingRequest {
                        preset: Some(preset),
                        requested_scopes: Vec::new(),
                        ttl_seconds: None,
                    },
                )
                .await
                .expect("host console owner can issue pairing");
            assert_eq!(challenge.requested_scopes.len(), preset.scopes().len());
        }
    }

    #[tokio::test]
    async fn a_device_pair_only_identity_cannot_issue_a_workstation_preset() {
        let auth = auth().await;
        let limited = AuthenticatedCredential {
            credential_id: "local-host-owner".to_owned(),
            kind: CredentialKind::Server,
            subject: "server-owner".to_owned(),
            device_id: None,
            scopes: ["device.pair".to_owned()].into_iter().collect(),
        };
        let result = auth
            .create_pairing(
                &limited,
                CreatePairingRequest {
                    preset: Some(DevicePermissionPreset::Workstation),
                    requested_scopes: Vec::new(),
                    ttl_seconds: None,
                },
            )
            .await;
        assert!(matches!(result, Err(AuthStoreError::InvalidScope)));
    }

    #[tokio::test]
    async fn host_console_lists_and_revokes_paired_devices() {
        let auth = auth().await;
        let owner = AuthenticatedCredential::host_console_owner();
        assert!(
            auth.list_devices(&owner)
                .await
                .expect("list empty")
                .is_empty()
        );

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
        let credential = auth
            .redeem_pairing(RedeemPairingRequest {
                pairing_token: challenge.pairing_token,
                device_name: "Pixel 9".to_owned(),
                public_key_ed25519: None,
                client_kind: None,
                replace_existing_mobile: false,
            })
            .await
            .expect("redeem pairing");

        let devices = auth.list_devices(&owner).await.expect("list paired");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, credential.device_id);
        assert_eq!(devices[0].device_name, "Pixel 9");
        assert_eq!(devices[0].preset, Some(DevicePermissionPreset::Companion));
        assert_eq!(devices[0].client_kind.as_deref(), Some("mobile"));
        assert!(devices[0].last_connected_at.is_some());

        auth.record_device_connection(credential.device_id, Some("web"), Some("127.0.0.1"))
            .await
            .expect("record connection");
        let updated = auth.list_devices(&owner).await.expect("list updated");
        assert_eq!(updated[0].client_kind.as_deref(), Some("web"));
        assert_eq!(updated[0].ip_address.as_deref(), Some("127.0.0.1"));

        auth.revoke_device(&owner, credential.device_id)
            .await
            .expect("revoke");
        assert!(
            auth.list_devices(&owner)
                .await
                .expect("list after revoke")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn pairing_ttl_honors_an_allowed_choice() {
        let auth = auth().await;
        let owner = AuthenticatedCredential::host_console_owner();
        let before = Utc::now().timestamp();
        let challenge = auth
            .create_pairing(
                &owner,
                CreatePairingRequest {
                    preset: Some(DevicePermissionPreset::Companion),
                    requested_scopes: Vec::new(),
                    ttl_seconds: Some(900),
                },
            )
            .await
            .expect("issue pairing");
        let expires = DateTime::parse_from_rfc3339(&challenge.expires_at)
            .expect("expires_at")
            .timestamp();
        let elapsed = expires - before;
        assert!(
            (890..=910).contains(&elapsed),
            "expected ~900s ttl, got {elapsed}"
        );
    }

    #[tokio::test]
    async fn pairing_ttl_defaults_to_thirty_minutes_and_honors_a_week() {
        let auth = auth().await;
        let owner = AuthenticatedCredential::host_console_owner();
        let before = Utc::now().timestamp();
        let default_challenge = auth
            .create_pairing(
                &owner,
                CreatePairingRequest {
                    preset: Some(DevicePermissionPreset::Companion),
                    requested_scopes: Vec::new(),
                    ttl_seconds: None,
                },
            )
            .await
            .expect("issue default pairing");
        let default_expires = DateTime::parse_from_rfc3339(&default_challenge.expires_at)
            .expect("expires_at")
            .timestamp();
        let default_elapsed = default_expires - before;
        assert!(
            (1790..=1810).contains(&default_elapsed),
            "expected ~1800s default ttl, got {default_elapsed}"
        );

        let week = 7 * 24 * 60 * 60;
        let long_lived = auth
            .create_pairing(
                &owner,
                CreatePairingRequest {
                    preset: Some(DevicePermissionPreset::Companion),
                    requested_scopes: Vec::new(),
                    ttl_seconds: Some(week),
                },
            )
            .await
            .expect("issue long-lived pairing");
        let long_expires = DateTime::parse_from_rfc3339(&long_lived.expires_at)
            .expect("expires_at")
            .timestamp();
        let long_elapsed = long_expires - before;
        assert!(
            (week - 10..=week + 10).contains(&long_elapsed),
            "expected ~7d ttl, got {long_elapsed}"
        );
    }

    #[tokio::test]
    async fn connect_requests_carry_the_verified_account_to_the_host_console() {
        let auth = auth().await;
        let owner = AuthenticatedCredential::host_console_owner();
        let request = |name: &str| remote_protocol::CreateDeviceConnectRequest {
            device_name: name.to_owned(),
            client_kind: Some("mobile".to_owned()),
            ..Default::default()
        };
        auth.create_connect_request("host-1", request("Alice iPhone"), None, Some("Alice"))
            .await
            .expect("account request");
        auth.create_connect_request("host-1", request("Bob iPhone"), None, None)
            .await
            .expect("plain request");

        let pending = auth.list_connect_requests(&owner).await.expect("list");
        let account_of = |name: &str| {
            pending
                .iter()
                .find(|item| item.device_name == name)
                .map(|item| item.account_display_name.clone())
        };
        assert_eq!(account_of("Alice iPhone"), Some(Some("Alice".to_owned())));
        assert_eq!(account_of("Bob iPhone"), Some(None));
    }
}
