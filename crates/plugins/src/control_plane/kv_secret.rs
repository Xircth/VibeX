use super::*;
use crate::PluginError;

fn secret_stream_byte(plugin_id: &str, secret_key: &str, nonce: &[u8], counter: usize) -> u8 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"vibex.plugin_secrets.v1:");
    hasher.update(plugin_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(secret_key.as_bytes());
    hasher.update([0u8]);
    hasher.update(nonce);
    hasher.update((counter / 32).to_le_bytes());
    let digest = hasher.finalize();
    digest[counter % 32]
}

fn secret_auth_tag(plugin_id: &str, secret_key: &str, nonce: &[u8], ciphertext: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"vibex.plugin_secrets.mac.v1:");
    hasher.update(plugin_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(secret_key.as_bytes());
    hasher.update([0u8]);
    hasher.update(nonce);
    hasher.update(ciphertext);
    hasher.finalize().into()
}

pub(crate) fn encrypt_plugin_secret(
    plugin_id: &str,
    secret_key: &str,
    plaintext: &str,
) -> Result<String, PluginError> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let mut nonce_hasher = Sha256::new();
    nonce_hasher.update(uuid::Uuid::new_v4().as_bytes());
    nonce_hasher.update(plugin_id.as_bytes());
    nonce_hasher.update(secret_key.as_bytes());
    let nonce_full = nonce_hasher.finalize();
    let nonce = &nonce_full[..16];
    let plain_bytes = plaintext.as_bytes();
    let mut cipher_bytes = Vec::with_capacity(plain_bytes.len());
    for (idx, byte) in plain_bytes.iter().enumerate() {
        cipher_bytes.push(*byte ^ secret_stream_byte(plugin_id, secret_key, nonce, idx));
    }
    let tag = secret_auth_tag(plugin_id, secret_key, nonce, &cipher_bytes);
    let mut envelope = Vec::with_capacity(1 + 16 + 32 + cipher_bytes.len());
    envelope.push(1u8);
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(&tag);
    envelope.extend_from_slice(&cipher_bytes);
    Ok(base64::engine::general_purpose::STANDARD.encode(envelope))
}

pub(crate) fn decrypt_plugin_secret(
    plugin_id: &str,
    secret_key: &str,
    encoded: &str,
) -> Result<String, PluginError> {
    use base64::Engine as _;
    let envelope = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(registry_error)?;
    if envelope.len() < 1 + 16 + 32 || envelope[0] != 1u8 {
        return Err(PluginError::registry("invalid plugin secret envelope"));
    }
    let nonce = &envelope[1..17];
    let tag = &envelope[17..49];
    let cipher_bytes = &envelope[49..];
    let expected_tag = secret_auth_tag(plugin_id, secret_key, nonce, cipher_bytes);
    if tag != expected_tag.as_slice() {
        return Err(PluginError::registry(
            "plugin secret authentication tag mismatch",
        ));
    }
    let mut plain_bytes = Vec::with_capacity(cipher_bytes.len());
    for (idx, byte) in cipher_bytes.iter().enumerate() {
        plain_bytes.push(*byte ^ secret_stream_byte(plugin_id, secret_key, nonce, idx));
    }
    String::from_utf8(plain_bytes).map_err(registry_error)
}

impl InMemoryPluginRegistry {
    pub(super) async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(self
            .kv_store
            .read()
            .map_err(lock_error)?
            .get(&(plugin_id.to_owned(), key.to_owned()))
            .cloned())
    }

    pub(super) async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.kv_store
            .write()
            .map_err(lock_error)?
            .insert((plugin_id.to_owned(), key.to_owned()), value.clone());
        Ok(())
    }

    pub(super) async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
        self.kv_store
            .write()
            .map_err(lock_error)?
            .remove(&(plugin_id.to_owned(), key.to_owned()));
        Ok(())
    }

    pub(super) async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError> {
        let prefix = prefix.unwrap_or("");
        Ok(self
            .kv_store
            .read()
            .map_err(lock_error)?
            .keys()
            .filter(|(owner, key)| owner == plugin_id && key.starts_with(prefix))
            .map(|(_, key)| key.clone())
            .collect())
    }

    pub(super) async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
        let mut store = self.kv_store.write().map_err(lock_error)?;
        let before = store.len();
        store.retain(|(owner, _), _| owner != plugin_id);
        Ok((before.saturating_sub(store.len())) as u64)
    }

    pub(super) async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        let stored = self
            .secrets_store
            .read()
            .map_err(lock_error)?
            .get(&(plugin_id.to_owned(), secret_key.to_owned()))
            .cloned();
        stored
            .map(|ciphertext| decrypt_plugin_secret(plugin_id, secret_key, &ciphertext))
            .transpose()
    }

    pub(super) async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        let ciphertext = encrypt_plugin_secret(plugin_id, secret_key, value)?;
        self.secrets_store
            .write()
            .map_err(lock_error)?
            .insert((plugin_id.to_owned(), secret_key.to_owned()), ciphertext);
        Ok(())
    }

    pub(super) async fn secret_delete(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<bool, PluginError> {
        Ok(self
            .secrets_store
            .write()
            .map_err(lock_error)?
            .remove(&(plugin_id.to_owned(), secret_key.to_owned()))
            .is_some())
    }
}

impl SqlitePluginRegistry {
    pub(super) async fn ensure_kv_table(&self) -> Result<(), PluginError> {
        if self
            .kv_table_initialized
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        self.kv_table_ready
            .get_or_try_init(|| async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_kv_storage (
                        plugin_id  TEXT NOT NULL,
                        key        TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                        PRIMARY KEY (plugin_id, key)
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_secrets_storage (
                        plugin_id      TEXT NOT NULL,
                        secret_key     TEXT NOT NULL,
                        ciphertext_b64 TEXT NOT NULL,
                        updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                        PRIMARY KEY (plugin_id, secret_key)
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_events_log (
                        cursor       INTEGER PRIMARY KEY AUTOINCREMENT,
                        topic        TEXT NOT NULL,
                        event_type   TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_event_subscriptions (
                        plugin_id        TEXT NOT NULL,
                        subscription_key TEXT NOT NULL,
                        acked_cursor     INTEGER NOT NULL DEFAULT 0,
                        updated_at       TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                        PRIMARY KEY (plugin_id, subscription_key)
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_installations_v4 (
                        plugin_id              TEXT PRIMARY KEY,
                        publisher              TEXT NOT NULL,
                        current_package_digest TEXT NOT NULL,
                        rollback_package_digest TEXT,
                        data_retention         TEXT NOT NULL DEFAULT 'retain'
                            CHECK (data_retention IN ('retain','delete_on_uninstall')),
                        installed_at           TEXT NOT NULL,
                        updated_at             TEXT NOT NULL
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_audit_v4 (
                        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
                        plugin_id     TEXT,
                        publisher     TEXT,
                        operation_id  TEXT,
                        event         TEXT NOT NULL,
                        evidence_json TEXT NOT NULL,
                        created_at    TEXT NOT NULL
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                let _ = sqlx::query(
                    "ALTER TABLE plugin_activation_intents_v4
                     ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1))",
                )
                .execute(&self.pool)
                .await;
                let _ = sqlx::query(
                    "ALTER TABLE plugin_activation_intents_v4
                     ADD COLUMN quarantine_reason TEXT",
                )
                .execute(&self.pool)
                .await;
                self.kv_table_initialized
                    .store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })
            .await
            .copied()
    }

    pub(super) async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError> {
        self.ensure_kv_table().await?;
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT value_json FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?",
        )
        .bind(plugin_id)
        .bind(key)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        raw.map(|json_str| serde_json::from_str(&json_str).map_err(registry_error))
            .transpose()
    }

    pub(super) async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let json_str = serde_json::to_string(value).map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_kv_storage (plugin_id, key, value_json, updated_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))
             ON CONFLICT(plugin_id, key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
        )
        .bind(plugin_id)
        .bind(key)
        .bind(json_str)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        sqlx::query("DELETE FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
            .bind(plugin_id)
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError> {
        self.ensure_kv_table().await?;
        match prefix.filter(|p| !p.is_empty()) {
            Some(prefix) => {
                let pattern = format!(
                    "{}%",
                    prefix
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                );
                sqlx::query_scalar(
                    "SELECT key FROM plugin_kv_storage
                     WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\'
                     ORDER BY key ASC",
                )
                .bind(plugin_id)
                .bind(pattern)
                .fetch_all(&self.pool)
                .await
                .map_err(registry_error)
            }
            None => sqlx::query_scalar(
                "SELECT key FROM plugin_kv_storage WHERE plugin_id = ? ORDER BY key ASC",
            )
            .bind(plugin_id)
            .fetch_all(&self.pool)
            .await
            .map_err(registry_error),
        }
    }

    pub(super) async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
        self.ensure_kv_table().await?;
        let result = sqlx::query("DELETE FROM plugin_kv_storage WHERE plugin_id = ?")
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        Ok(result.rows_affected())
    }

    pub(super) async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        self.ensure_kv_table().await?;
        let ciphertext: Option<String> = sqlx::query_scalar(
            "SELECT ciphertext_b64 FROM plugin_secrets_storage
             WHERE plugin_id = ? AND secret_key = ?",
        )
        .bind(plugin_id)
        .bind(secret_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        ciphertext
            .map(|value| decrypt_plugin_secret(plugin_id, secret_key, &value))
            .transpose()
    }

    pub(super) async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let ciphertext = encrypt_plugin_secret(plugin_id, secret_key, value)?;
        sqlx::query(
            "INSERT INTO plugin_secrets_storage (plugin_id, secret_key, ciphertext_b64, updated_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))
             ON CONFLICT(plugin_id, secret_key) DO UPDATE SET
               ciphertext_b64 = excluded.ciphertext_b64,
               updated_at = excluded.updated_at",
        )
        .bind(plugin_id)
        .bind(secret_key)
        .bind(ciphertext)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn secret_delete(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<bool, PluginError> {
        self.ensure_kv_table().await?;
        let result = sqlx::query(
            "DELETE FROM plugin_secrets_storage WHERE plugin_id = ? AND secret_key = ?",
        )
        .bind(plugin_id)
        .bind(secret_key)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(result.rows_affected() > 0)
    }
}

impl PluginControlPlane {
    pub async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError> {
        self.registry.kv_get(plugin_id, key).await
    }

    pub async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.registry.kv_put(plugin_id, key, value).await
    }

    pub async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
        self.registry.kv_delete(plugin_id, key).await
    }

    pub async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError> {
        self.registry.kv_list_keys(plugin_id, prefix).await
    }

    pub async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
        self.registry.kv_clear(plugin_id).await
    }

    pub async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        self.registry.secret_get(plugin_id, secret_key).await
    }

    pub async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        self.registry.secret_put(plugin_id, secret_key, value).await
    }

    pub async fn secret_delete(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<bool, PluginError> {
        self.registry.secret_delete(plugin_id, secret_key).await
    }

    pub async fn grant_permissions(
        &self,
        plugin_id: &str,
        _permission_ids: &[String],
    ) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.registry
            .replace_declared_grants(plugin_id, &plugin.permissions)
            .await
    }

    pub async fn grant_declared_permissions(&self, plugin_id: &str) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.grant_permissions(
            plugin_id,
            &plugin
                .permissions
                .iter()
                .map(|permission| permission.id.clone())
                .collect::<Vec<_>>(),
        )
        .await
    }

    pub async fn capability_grants(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<crate::CapabilityGrant>, PluginError> {
        self.registry.capability_grants(plugin_id).await
    }
}
