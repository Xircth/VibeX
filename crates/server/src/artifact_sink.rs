use artifacts::{ArtifactEvent, ArtifactEventSink, PortError};
use async_trait::async_trait;
use conversations::ConversationEventAppender;
use db::models::conversation_event::AppendConversationEvent;
use sqlx::SqlitePool;
use uuid::Uuid;

#[derive(Clone)]
pub struct ServerArtifactEventSink {
    pool: SqlitePool,
}

impl ServerArtifactEventSink {
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ArtifactEventSink for ServerArtifactEventSink {
    async fn append(&self, event: &ArtifactEvent) -> Result<(), PortError> {
        let (conversation_id, turn_id, event, idempotency_key) = match event {
            ArtifactEvent::RevisionRecorded { artifact } => {
                if artifact.conversation_id.is_nil() {
                    return Ok(());
                }
                (
                    artifact.conversation_id,
                    artifact.turn_id,
                    agents::ConversationEvent::ArtifactRevisionRecorded {
                        artifact: agents::conversation::ConversationArtifactReference {
                            artifact_id: artifact.artifact_id,
                            workspace_id: artifact.workspace_id,
                            relative_path: artifact.relative_path.to_string_lossy().into_owned(),
                            media_type: artifact.media_type.clone(),
                            content_hash: artifact.content_hash.clone(),
                            revision: artifact.revision,
                            plugin_id: artifact.producer.plugin_id.clone(),
                            plugin_version: artifact.producer.plugin_version.clone(),
                            provider_id: artifact.producer.provider_id.clone(),
                            tool_lock_id: artifact.producer.tool_lock.id.clone(),
                        },
                    },
                    format!(
                        "artifact:{}:revision:{}",
                        artifact.artifact_id, artifact.revision
                    ),
                )
            }
            ArtifactEvent::PreviewOpened { preview } => (
                preview.conversation_id,
                preview.turn_id,
                agents::ConversationEvent::ArtifactPreviewOpened {
                    preview: agents::conversation::ConversationArtifactPreviewReference {
                        artifact_id: preview.artifact_id,
                        provider_id: preview.provider_id.clone(),
                        lease_id: preview.lease_id,
                    },
                },
                format!("artifact-preview:{}:opened", preview.lease_id),
            ),
            ArtifactEvent::PreviewClosed { preview } => (
                preview.conversation_id,
                preview.turn_id,
                agents::ConversationEvent::ArtifactPreviewClosed {
                    preview: agents::conversation::ConversationArtifactPreviewReference {
                        artifact_id: preview.artifact_id,
                        provider_id: preview.provider_id.clone(),
                        lease_id: preview.lease_id,
                    },
                },
                format!("artifact-preview:{}:closed", preview.lease_id),
            ),
            ArtifactEvent::PreviewFailed {
                operation_id,
                conversation_id,
                turn_id,
                artifact_id,
                provider_id,
                message,
            } => (
                *conversation_id,
                *turn_id,
                agents::ConversationEvent::ArtifactPreviewFailed {
                    artifact_id: *artifact_id,
                    provider_id: provider_id.clone(),
                    message: message.clone(),
                },
                format!("artifact-preview:{artifact_id}:operation:{operation_id}:failed"),
            ),
        };
        if conversation_id.is_nil() {
            return Ok(());
        }
        let value =
            serde_json::to_value(&event).map_err(|error| PortError::new(error.to_string()))?;
        let event_kind = value["kind"]
            .as_str()
            .ok_or_else(|| PortError::new("artifact event kind is missing"))?;
        let normalized_json =
            serde_json::to_string(&event).map_err(|error| PortError::new(error.to_string()))?;
        ConversationEventAppender::append(
            &self.pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "host",
                event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&idempotency_key),
            },
        )
        .await
        .map_err(|error| PortError::new(error.to_string()))?;
        Ok(())
    }
}
