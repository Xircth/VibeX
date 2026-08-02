use std::{
    collections::BTreeSet,
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use application::Principal;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use remote_protocol::{
    CreatePairingRequest, DeviceCredential, DeviceId, PairingChallenge, PairingId,
    RedeemPairingRequest, RevokeDeviceResponse,
};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

const PAIRING_TTL_SECONDS: i64 = 5 * 60;
const DEVICE_SCOPES: &[&str] = &[
    "conversation.read",
    "conversation.write",
    "conversation.attach",
    "conversation.permission",
    "conversation.question",
    "conversation.cancel",
    "plugin.read",
    "artifact.read",
    "artifact.preview",
    "automation.read",
    "automation.write",
    "delegation.read",
    "delegation.cancel",
    "notification.summary",
    "offline.read",
];

pub(crate) const ADMIN_SCOPES: &[&str] = &[
    "conversation.read",
    "conversation.write",
    "conversation.attach",
    "conversation.permission",
    "conversation.question",
    "conversation.cancel",
    "application.call",
    "plugin.read",
    "plugin.write",
    "artifact.read",
    "artifact.preview",
    "automation.read",
    "automation.write",
    "delegation.read",
    "delegation.cancel",
    "device.pair",
    "device.revoke",
    "notification.summary",
    "offline.read",
];

/// Plaintext bearer token accepted only at the composition boundary.
///
/// The server runtime immediately converts this value to a SHA-256 digest and
/// never stores the plaintext in router state.
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

#[derive(Clone)]
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedCredential {
    pub credential_id: String,
    pub kind: CredentialKind,
    pub subject: String,
    pub device_id: Option<DeviceId>,
    pub scopes: BTreeSet<String>,
}

impl AuthenticatedCredential {
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
    #[error("device credential was not found")]
    DeviceNotFound,
    #[error("credential lacks the required scope")]
    Forbidden,
    #[error("device pairing is unavailable for this server composition")]
    PairingUnavailable,
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
            pairing_ttl_seconds: PAIRING_TTL_SECONDS,
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
        if let Some(row) = sqlx::query(
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

        let Some(row) = sqlx::query(
            "SELECT id, device_name, scopes_json
             FROM server_device_credentials
             WHERE token_hash = ? AND revoked_at_unix IS NULL
             LIMIT 1",
        )
        .bind(digest.as_bytes().as_slice())
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let id: String = row.try_get("id")?;
        let device_id = id
            .parse()
            .map_err(|error| sqlx::Error::Protocol(format!("invalid device id: {error}")))?;
        Ok(Some(AuthenticatedCredential {
            credential_id: id,
            kind: CredentialKind::Device,
            subject: format!("device:{}", row.try_get::<String, _>("device_name")?),
            device_id: Some(device_id),
            scopes: parse_scopes(row.try_get("scopes_json")?)?,
        }))
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
        let scopes = normalize_device_scopes(&creator.scopes, request.requested_scopes)?;
        let pairing_id = PairingId::new();
        let pairing_token = format!(
            "vbx_pair_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let digest = TokenDigest::from_secret(&pairing_token);
        let created_at = self.now();
        let expires_at = created_at.saturating_add(self.pairing_ttl_seconds);
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
        let digest = TokenDigest::from_secret(&request.pairing_token);
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
            sqlx::query(
                "INSERT INTO server_device_credentials
                 (id, token_hash, device_name, scopes_json, created_at_unix)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(device_id.to_string())
            .bind(device_digest.as_bytes().as_slice())
            .bind(device_name)
            .bind(serde_json::to_string(&scopes).expect("scopes serialize"))
            .bind(now)
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
