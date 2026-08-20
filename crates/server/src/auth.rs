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
    CreatePairingRequest, DeviceCredential, DeviceId, DevicePermissionPreset, PairingChallenge,
    PairingId, RedeemPairingRequest, RevokeDeviceResponse,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

const PAIRING_TTL_SECONDS: i64 = 5 * 60;
const PAIRING_TTL_CHOICES: &[i64] = &[300, 900, 1800, 3600];

fn resolve_pairing_ttl(requested: Option<i64>, default: i64) -> i64 {
    requested
        .filter(|seconds| PAIRING_TTL_CHOICES.contains(seconds))
        .unwrap_or(default)
}
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

    async fn list_devices(
        &self,
        actor: &AuthenticatedCredential,
    ) -> Result<Vec<PairedDeviceRecord>, AuthStoreError>;
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
        let ttl_seconds = resolve_pairing_ttl(request.ttl_seconds, self.pairing_ttl_seconds);
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

    async fn list_devices(
        &self,
        actor: &AuthenticatedCredential,
    ) -> Result<Vec<PairedDeviceRecord>, AuthStoreError> {
        if !actor.allows("device.pair") && !actor.allows("device.revoke") {
            return Err(AuthStoreError::Forbidden);
        }
        let rows = sqlx::query(
            "SELECT id, device_name, scopes_json, created_at_unix
             FROM server_device_credentials
             WHERE revoked_at_unix IS NULL
             ORDER BY created_at_unix DESC",
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
            devices.push(PairedDeviceRecord {
                device_id,
                device_name: row.try_get("device_name")?,
                created_at: unix_timestamp(row.try_get("created_at_unix")?),
                preset: infer_preset(&scopes),
                scopes,
            });
        }
        Ok(devices)
    }
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

fn infer_preset(scopes: &[String]) -> Option<DevicePermissionPreset> {
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
            })
            .await
            .expect("redeem pairing");

        let devices = auth.list_devices(&owner).await.expect("list paired");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, credential.device_id);
        assert_eq!(devices[0].device_name, "Pixel 9");
        assert_eq!(devices[0].preset, Some(DevicePermissionPreset::Companion));

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
}
