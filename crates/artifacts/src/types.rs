use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tool_runtime::{ToolInstallationLock, ToolLease};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ToolLockEvidence {
    pub id: String,
    pub tool_id: String,
    pub version: String,
    pub target: String,
    pub sha256: String,
    pub executable_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProducerEvidence {
    pub plugin_id: String,
    pub plugin_version: String,
    pub provider_id: String,
    pub tool_lock: ToolLockEvidence,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordArtifact {
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub scope_root: PathBuf,
    pub relative_path: PathBuf,
    pub media_type: String,
    pub producer: ProducerEvidence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub scope_root: PathBuf,
    pub relative_path: PathBuf,
    pub media_type: String,
    pub content_hash: String,
    pub revision: u64,
    pub producer: ProducerEvidence,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactReference {
    pub artifact_id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub relative_path: PathBuf,
    pub media_type: String,
    pub content_hash: String,
    pub revision: u64,
    pub producer: ProducerEvidence,
}

impl From<&ArtifactRecord> for ArtifactReference {
    fn from(record: &ArtifactRecord) -> Self {
        Self {
            artifact_id: record.id,
            conversation_id: record.conversation_id,
            turn_id: record.turn_id,
            workspace_id: record.workspace_id,
            relative_path: record.relative_path.clone(),
            media_type: record.media_type.clone(),
            content_hash: record.content_hash.clone(),
            revision: record.revision,
            producer: record.producer.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtifactEvent {
    RevisionRecorded {
        artifact: Box<ArtifactReference>,
    },
    PreviewOpened {
        preview: ArtifactPreviewReference,
    },
    PreviewClosed {
        preview: ArtifactPreviewReference,
    },
    PreviewFailed {
        operation_id: Uuid,
        conversation_id: Uuid,
        turn_id: Uuid,
        artifact_id: Uuid,
        provider_id: String,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactPreviewReference {
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub artifact_id: Uuid,
    pub provider_id: String,
    pub lease_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OpenPreview {
    pub artifact_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PreviewLease {
    pub id: Uuid,
    pub artifact_id: Uuid,
    pub provider_id: String,
    pub watch_key: String,
    pub loopback_port: u16,
    pub capability_token: String,
    pub expires_at_unix_ms: u64,
    pub reference_count: u32,
    pub docx_fallback_supported: bool,
}

#[derive(Debug)]
pub struct ResolvedToolInstallation {
    pub lock: ToolInstallationLock,
    pub(crate) lease: Option<ToolLease>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRevisionEvent {
    pub artifact_id: Uuid,
    pub revision: u64,
    pub event: ArtifactEvent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingPreviewEvent {
    pub key: String,
    pub event: ArtifactEvent,
}

impl ResolvedToolInstallation {
    pub fn unleased(lock: ToolInstallationLock) -> Self {
        Self { lock, lease: None }
    }

    pub(crate) fn leased(lock: ToolInstallationLock, lease: ToolLease) -> Self {
        Self {
            lock,
            lease: Some(lease),
        }
    }
}
