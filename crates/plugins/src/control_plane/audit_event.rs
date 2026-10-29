use std::sync::{Arc, atomic::Ordering};

use sqlx::Row;

use super::*;
use crate::{PluginError, WorkerHostError};

impl InMemoryPluginRegistry {
    pub(super) async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.audit.write().map_err(lock_error)?.push((
            plugin_id.to_owned(),
            PluginAuditEvent {
                event: event.to_owned(),
                evidence: evidence.clone(),
            },
        ));
        Ok(())
    }

    pub(super) async fn list_audit(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<PluginAuditEvent>, PluginError> {
        Ok(self
            .audit
            .read()
            .map_err(lock_error)?
            .iter()
            .filter(|(id, _)| id == plugin_id)
            .map(|(_, event)| event.clone())
            .collect())
    }

    pub(super) async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        let cursor = self.next_event_cursor.fetch_add(1, Ordering::SeqCst) + 1;
        let event = PluginBusEvent {
            cursor,
            topic: topic.to_owned(),
            event_type: event_type.to_owned(),
            payload: payload.clone(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string(),
        };
        self.events_log.write().map_err(lock_error)?.push(event);
        Ok(cursor)
    }

    pub(super) async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        let subscription_key = event_subscription_key(topic, event_type);
        let acked_cursor = self
            .event_offsets
            .read()
            .map_err(lock_error)?
            .get(&(plugin_id.to_owned(), subscription_key))
            .copied()
            .unwrap_or(0);
        let floor_cursor = since_cursor.unwrap_or(acked_cursor);
        let max_items = limit.clamp(1, 500);
        let events_log = self.events_log.read().map_err(lock_error)?;
        let latest_cursor = events_log.last().map(|event| event.cursor).unwrap_or(0);
        let events: Vec<PluginBusEvent> = events_log
            .iter()
            .filter(|event| {
                event.cursor > floor_cursor
                    && topic
                        .filter(|value| !value.is_empty())
                        .is_none_or(|wanted| event.topic == wanted)
                    && event_type
                        .filter(|value| !value.is_empty())
                        .is_none_or(|wanted| event.event_type == wanted)
            })
            .take(max_items)
            .cloned()
            .collect();
        let cursor = events
            .last()
            .map(|event| event.cursor)
            .unwrap_or_else(|| floor_cursor.max(latest_cursor));
        Ok(PluginEventSubscriptionBatch {
            cursor,
            acked_cursor,
            events,
        })
    }

    pub(super) async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        let key = if subscription_key.trim().is_empty() {
            "*:*".to_owned()
        } else {
            subscription_key.trim().to_owned()
        };
        let mut offsets = self.event_offsets.write().map_err(lock_error)?;
        let entry = offsets.entry((plugin_id.to_owned(), key)).or_insert(0);
        if cursor > *entry {
            *entry = cursor;
        }
        Ok(*entry)
    }
}

impl SqlitePluginRegistry {
    pub(super) async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let evidence_json = serde_json::to_string(evidence).map_err(registry_error)?;
        // A bind refusal is evidence even when the install row is gone or
        // never existed — joining on installations would silently drop it.
        sqlx::query(
            "INSERT INTO plugin_audit_v4
                 (plugin_id, publisher, operation_id, event, evidence_json, created_at)
             VALUES (
                 ?,
                 COALESCE((SELECT publisher FROM plugin_installations_v4 WHERE plugin_id = ?), ''),
                 NULL,
                 ?,
                 ?,
                 datetime('now','subsec')
             )",
        )
        .bind(plugin_id)
        .bind(plugin_id)
        .bind(event)
        .bind(evidence_json)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn list_audit(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<PluginAuditEvent>, PluginError> {
        self.ensure_kv_table().await?;
        let rows = sqlx::query(
            "SELECT event, evidence_json FROM plugin_audit_v4
             WHERE plugin_id = ? ORDER BY sequence",
        )
        .bind(plugin_id)
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        rows.into_iter()
            .map(|row| {
                let event: String = row.try_get("event").map_err(registry_error)?;
                let evidence_json: String = row.try_get("evidence_json").map_err(registry_error)?;
                let evidence = serde_json::from_str(&evidence_json).map_err(registry_error)?;
                Ok(PluginAuditEvent { event, evidence })
            })
            .collect()
    }

    pub(super) async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        self.ensure_kv_table().await?;
        let payload_json = serde_json::to_string(payload).map_err(registry_error)?;
        let result = sqlx::query(
            "INSERT INTO plugin_events_log (topic, event_type, payload_json, created_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))",
        )
        .bind(topic)
        .bind(event_type)
        .bind(payload_json)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        u64::try_from(result.last_insert_rowid()).map_err(registry_error)
    }

    pub(super) async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        self.ensure_kv_table().await?;
        let subscription_key = event_subscription_key(topic, event_type);
        let acked_cursor = sqlx::query_scalar::<_, i64>(
            "SELECT acked_cursor FROM plugin_event_subscriptions
             WHERE plugin_id = ? AND subscription_key = ?",
        )
        .bind(plugin_id)
        .bind(&subscription_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
        let floor_cursor = since_cursor.unwrap_or(acked_cursor);
        let max_items = i64::try_from(limit.clamp(1, 500)).unwrap_or(100);
        let latest_cursor =
            sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(cursor) FROM plugin_events_log")
                .fetch_one(&self.pool)
                .await
                .map_err(registry_error)?
                .and_then(|value| u64::try_from(value).ok())
                .unwrap_or(0);
        let topic_filter = topic.filter(|value| !value.is_empty());
        let type_filter = event_type.filter(|value| !value.is_empty());
        let rows = sqlx::query(
            "SELECT cursor, topic, event_type, payload_json, created_at
             FROM plugin_events_log
             WHERE cursor > ?
               AND (? IS NULL OR topic = ?)
               AND (? IS NULL OR event_type = ?)
             ORDER BY cursor ASC
             LIMIT ?",
        )
        .bind(i64::try_from(floor_cursor).unwrap_or(i64::MAX))
        .bind(topic_filter)
        .bind(topic_filter)
        .bind(type_filter)
        .bind(type_filter)
        .bind(max_items)
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        let mut events = Vec::with_capacity(rows.len());
        for row in rows {
            let cursor_i64: i64 = row.try_get("cursor").map_err(registry_error)?;
            let cursor = u64::try_from(cursor_i64).map_err(registry_error)?;
            let topic: String = row.try_get("topic").map_err(registry_error)?;
            let event_type: String = row.try_get("event_type").map_err(registry_error)?;
            let payload_json: String = row.try_get("payload_json").map_err(registry_error)?;
            let payload = serde_json::from_str(&payload_json).map_err(registry_error)?;
            let created_at: String = row.try_get("created_at").map_err(registry_error)?;
            events.push(PluginBusEvent {
                cursor,
                topic,
                event_type,
                payload,
                created_at,
            });
        }
        let cursor = events
            .last()
            .map(|event| event.cursor)
            .unwrap_or_else(|| floor_cursor.max(latest_cursor));
        Ok(PluginEventSubscriptionBatch {
            cursor,
            acked_cursor,
            events,
        })
    }

    pub(super) async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        self.ensure_kv_table().await?;
        let key = if subscription_key.trim().is_empty() {
            "*:*".to_owned()
        } else {
            subscription_key.trim().to_owned()
        };
        let cursor_i64 = i64::try_from(cursor).map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_event_subscriptions
                 (plugin_id, subscription_key, acked_cursor, updated_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))
             ON CONFLICT(plugin_id, subscription_key) DO UPDATE SET
                 acked_cursor = CASE
                     WHEN excluded.acked_cursor > plugin_event_subscriptions.acked_cursor
                     THEN excluded.acked_cursor
                     ELSE plugin_event_subscriptions.acked_cursor
                 END,
                 updated_at = excluded.updated_at",
        )
        .bind(plugin_id)
        .bind(&key)
        .bind(cursor_i64)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        let saved = sqlx::query_scalar::<_, i64>(
            "SELECT acked_cursor FROM plugin_event_subscriptions
             WHERE plugin_id = ? AND subscription_key = ?",
        )
        .bind(plugin_id)
        .bind(&key)
        .fetch_one(&self.pool)
        .await
        .map_err(registry_error)?;
        u64::try_from(saved).map_err(registry_error)
    }
}

impl PluginControlPlane {
    pub fn watch_worker_crashes(self: &std::sync::Arc<Self>) {
        let plane = std::sync::Arc::clone(self);
        tokio::spawn(async move {
            let mut crashes = crate::subscribe_worker_crashes();
            loop {
                match crashes.recv().await {
                    Ok(plugin_id) => {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let recent_crashes = crate::recent_plugin_crashes(&plugin_id)
                            .into_iter()
                            .filter(|crash| now_ms.saturating_sub(crash.at_unix_ms) <= 60_000)
                            .count();
                        if recent_crashes >= 3 {
                            if let Err(error) = plane
                                .quarantine_plugin(
                                    &plugin_id,
                                    "Quarantined after repeated worker crashes",
                                )
                                .await
                            {
                                tracing::warn!(
                                    plugin_id = %plugin_id,
                                    %error,
                                    "failed to quarantine plugin after repeated Worker crashes"
                                );
                            }
                        } else {
                            plane.host_services.stop(&plugin_id);
                            let _ = plane.activations.deactivate(&plugin_id).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.registry.record_audit(plugin_id, event, evidence).await
    }

    pub async fn audit_events(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<PluginAuditEvent>, PluginError> {
        self.registry.list_audit(plugin_id).await
    }

    pub async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        self.registry
            .publish_event(topic, event_type, payload)
            .await
    }

    pub async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        self.registry
            .events_subscribe(plugin_id, topic, event_type, since_cursor, limit)
            .await
    }

    pub async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        self.registry
            .events_ack(plugin_id, subscription_key, cursor)
            .await
    }

    pub fn register_command_handler(
        &self,
        plugin_id: impl Into<String>,
        command_name: impl Into<String>,
        handler: Arc<dyn PluginCommandHandler>,
    ) -> Result<(), PluginError> {
        self.command_handlers
            .write()
            .map_err(lock_error)?
            .insert((plugin_id.into(), command_name.into()), handler);
        Ok(())
    }

    pub fn register_command_fn<F, Fut>(
        &self,
        plugin_id: impl Into<String>,
        command_name: impl Into<String>,
        handler: F,
    ) -> Result<(), PluginError>
    where
        F: Fn(String, String, serde_json::Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<serde_json::Value, WorkerHostError>>
            + Send
            + 'static,
    {
        self.register_command_handler(
            plugin_id,
            command_name,
            Arc::new(FnPluginCommandHandler(handler)),
        )
    }

    pub fn unregister_command_handlers(&self, plugin_id: &str) -> Result<(), PluginError> {
        self.command_handlers
            .write()
            .map_err(lock_error)?
            .retain(|(owner, _), _| owner != plugin_id);
        Ok(())
    }

    pub fn has_command_handler(&self, plugin_id: &str, command_name: &str) -> bool {
        self.command_handlers.read().ok().is_some_and(|handlers| {
            handlers.contains_key(&(plugin_id.to_owned(), command_name.to_owned()))
                || handlers.contains_key(&(plugin_id.to_owned(), "*".to_owned()))
                || handlers.contains_key(&("*".to_owned(), "*".to_owned()))
        })
    }

    /// Resolves a dynamic command identifier (`<plugin_id>.<command_name>` or
    /// `<plugin_id>:<command_name>`) against the installed plugin catalog,
    /// registered Rust handlers, and locked System Bundle manifests.
    pub async fn resolve_dynamic_command_target(
        &self,
        qualified_command: &str,
    ) -> Result<Option<(String, String)>, PluginError> {
        let trimmed = qualified_command.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if let Some((plugin_id, command_name)) = trimmed.split_once(':') {
            let plugin_id = plugin_id.trim();
            let command_name = command_name.trim();
            if !plugin_id.is_empty() && !command_name.is_empty() {
                return Ok(Some((plugin_id.to_owned(), command_name.to_owned())));
            }
        }
        let mut candidate_ids: BTreeSet<String> = self
            .registry
            .list_plugins()
            .await?
            .into_iter()
            .map(|plugin| plugin.id().to_owned())
            .collect();
        for manifest in system_bundle_plugin_manifests() {
            candidate_ids.insert(manifest.id.to_owned());
        }
        if let Ok(handlers) = self.command_handlers.read() {
            for (plugin_id, _) in handlers.keys() {
                if plugin_id != "*" {
                    candidate_ids.insert(plugin_id.clone());
                }
            }
        }
        let mut best_match: Option<(String, String)> = None;
        for plugin_id in candidate_ids {
            if let Some(rest) = trimmed.strip_prefix(&plugin_id)
                && let Some(command_name) = rest.strip_prefix('.')
                && !command_name.is_empty()
            {
                let replace = best_match
                    .as_ref()
                    .is_none_or(|(current_id, _)| plugin_id.len() > current_id.len());
                if replace {
                    best_match = Some((plugin_id, command_name.to_owned()));
                }
            }
        }
        if best_match.is_none()
            && let Some(rest) = trimmed.strip_prefix("vibex.")
            && let Some((slug, command_name)) = rest.split_once('.')
            && !slug.is_empty()
            && !command_name.is_empty()
        {
            return Ok(Some((format!("vibex.{slug}"), command_name.to_owned())));
        }
        Ok(best_match)
    }

    /// Routes a dynamic plugin RPC command after verifying the target plugin is
    /// in an active generation (or is a locked System Bundle foundation plugin).
    /// Dispatches to a registered Rust `PluginCommandHandler` if present, or
    /// forwards to the plugin's active Worker slot (Tier 2 `SharedNodeWorkerHost`
    /// or Tier 3 Dedicated/Sidecar).
    pub async fn invoke_plugin_command(
        &self,
        plugin_id: &str,
        command_name: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerHostError> {
        let plugin_id = plugin_id.trim();
        let command_name = command_name.trim();
        if plugin_id.is_empty() || command_name.is_empty() {
            return Err(WorkerHostError::external(
                "invalid_plugin_command",
                "pluginId and command are required",
            ));
        }
        let installed = self
            .registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        if let Some(plugin) = installed {
            let is_live = self
                .plugin_is_live(plugin_id)
                .await
                .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
            if plugin.activation != PluginActivation::Enabled || !is_live {
                return Err(WorkerHostError::external(
                    "plugin_not_active",
                    format!("Plugin `{plugin_id}` does not have an active generation"),
                ));
            }
        } else if !is_system_bundle_plugin_id(plugin_id)
            && !self.has_command_handler(plugin_id, command_name)
        {
            return Err(WorkerHostError::external(
                "plugin_not_found",
                format!("Plugin `{plugin_id}` is not installed"),
            ));
        }

        let rust_handler = self.command_handlers.read().ok().and_then(|handlers| {
            handlers
                .get(&(plugin_id.to_owned(), command_name.to_owned()))
                .cloned()
                .or_else(|| {
                    handlers
                        .get(&(plugin_id.to_owned(), "*".to_owned()))
                        .cloned()
                })
                .or_else(|| handlers.get(&("*".to_owned(), "*".to_owned())).cloned())
        });
        if let Some(handler) = rust_handler {
            return handler.handle(plugin_id, command_name, input).await;
        }

        if let Some(lease) = self.activation_lease(plugin_id).await
            && !lease.is_lightweight()
        {
            return lease
                .invoke_with_timeout(command_name, input, std::time::Duration::from_secs(30))
                .await;
        }

        Err(WorkerHostError::external(
            "plugin_command_not_found",
            format!("Plugin `{plugin_id}` does not expose command `{command_name}`"),
        ))
    }

    pub async fn quarantine_plugin(
        &self,
        plugin_id: &str,
        reason: &str,
    ) -> Result<(), PluginError> {
        let _ = self.withdraw_with_dependents(plugin_id).await;
        self.registry.quarantine_plugin(plugin_id, reason).await?;
        let _ = self
            .registry
            .record_audit(
                plugin_id,
                "quarantined",
                &serde_json::json!({ "reason": reason }),
            )
            .await;
        self.refresh_live_projections().await
    }

    pub async fn quarantine_reason(&self, plugin_id: &str) -> Result<Option<String>, PluginError> {
        self.registry.quarantine_reason(plugin_id).await
    }

    /// Updates the persisted package configuration in the registry and pushes a
    /// live `config.volatile-update` notification to the active Worker slot (if
    /// one is currently running) without rebuilding the plugin generation.
    pub async fn notify_config_updated(
        &self,
        plugin_id: &str,
        config: serde_json::Value,
    ) -> Result<bool, PluginError> {
        if let Some(mut installed) = self.registry.plugin(plugin_id).await? {
            installed.package.config = config.clone();
            self.registry.put_plugin(installed).await?;
        }
        match self.activations.update_config(plugin_id, config).await {
            Ok(updated) => Ok(updated),
            Err(error) => {
                tracing::warn!(
                    plugin_id = %plugin_id,
                    %error,
                    "failed to push volatile config update to active plugin worker"
                );
                Ok(false)
            }
        }
    }
}
