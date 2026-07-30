use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::{ServerCredentials, ServerToken, auth::TokenDigest};

pub struct ProvisionedToken {
    pub credentials: ServerCredentials,
    /// Present only when the store generated a new token. Callers may display
    /// it once; it cannot be recovered from the persisted digest.
    pub issued_token: Option<ServerToken>,
}

#[derive(Clone)]
pub struct SqliteTokenHashStore {
    pool: SqlitePool,
}

impl SqliteTokenHashStore {
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn provision(
        &self,
        supplied: Option<ServerToken>,
    ) -> Result<ProvisionedToken, sqlx::Error> {
        if let Some(token) = supplied {
            let credentials = ServerCredentials::from_token(&token);
            self.rotate(&credentials).await?;
            return Ok(ProvisionedToken {
                credentials,
                issued_token: None,
            });
        }

        if let Some(credentials) = self.active_credentials().await? {
            return Ok(ProvisionedToken {
                credentials,
                issued_token: None,
            });
        }

        let token = ServerToken::new(format!(
            "vbx_{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        ));
        let credentials = ServerCredentials::from_token(&token);
        self.rotate(&credentials).await?;
        Ok(ProvisionedToken {
            credentials,
            issued_token: Some(token),
        })
    }

    async fn active_credentials(&self) -> Result<Option<ServerCredentials>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT token_hash
             FROM server_access_tokens
             WHERE revoked_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let bytes: Vec<u8> = row.try_get("token_hash")?;
            let digest: [u8; 32] = bytes.try_into().map_err(|_| {
                sqlx::Error::Protocol("stored server token hash is not SHA-256".to_string())
            })?;
            Ok(ServerCredentials::from_digest(TokenDigest::from_bytes(
                digest,
            )))
        })
        .transpose()
    }

    async fn rotate(&self, credentials: &ServerCredentials) -> Result<(), sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE server_access_tokens
             SET revoked_at = CURRENT_TIMESTAMP
             WHERE revoked_at IS NULL",
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO server_access_tokens
             (id, token_hash, scopes_json, created_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        )
        .bind(Uuid::new_v4())
        .bind(credentials.token_digest.as_bytes().as_slice())
        .bind(
            r#"["conversation.read","conversation.write","application.call","plugin.read","plugin.write","artifact.read","artifact.preview","automation.read","automation.write","delegation.read","delegation.cancel"]"#,
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await
    }
}
