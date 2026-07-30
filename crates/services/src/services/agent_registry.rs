//! SQLite adapter for the validated ACP Registry snapshot domain model.

use agents::{RegistryAgentEntry, RegistrySnapshot};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use db::models::agent_management::{
    RegistryEntryRecord, RegistrySnapshotRecord, RegistrySnapshotRepository,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct StoredRegistryMetadata {
    name: String,
    description: String,
    repository: Option<String>,
    website: Option<String>,
    authors: Vec<String>,
    license: Option<String>,
    icon_url: Option<String>,
}

#[derive(Clone)]
pub struct AgentRegistrySnapshotStore {
    repository: RegistrySnapshotRepository,
}

impl AgentRegistrySnapshotStore {
    pub fn new(repository: RegistrySnapshotRepository) -> Self {
        Self { repository }
    }

    pub async fn save(&self, snapshot: &RegistrySnapshot) -> Result<()> {
        let record = RegistrySnapshotRecord {
            id: snapshot.id,
            source_url: snapshot.source_url.clone(),
            fetched_at: snapshot.fetched_at.to_rfc3339(),
            schema_version: snapshot.schema_version.clone(),
            document_json: snapshot.document_json.clone(),
            document_sha256: snapshot.document_sha256.clone(),
            etag: snapshot.etag.clone(),
        };
        let entries = snapshot
            .entries
            .iter()
            .map(|entry| {
                Ok(RegistryEntryRecord {
                    agent_id: entry.agent_id.clone(),
                    registry_id: entry.registry_id.clone(),
                    version: entry.version.clone(),
                    sort_name: entry.name.clone(),
                    metadata_json: serde_json::to_string(&StoredRegistryMetadata {
                        name: entry.name.clone(),
                        description: entry.description.clone(),
                        repository: entry.repository.clone(),
                        website: entry.website.clone(),
                        authors: entry.authors.clone(),
                        license: entry.license.clone(),
                        icon_url: entry.icon_url.clone(),
                    })?,
                    distributions_json: serde_json::to_string(&entry.distributions)?,
                    icon_svg: entry.icon_svg.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        self.repository.replace(&record, &entries).await?;
        Ok(())
    }

    pub async fn load(&self) -> Result<Option<RegistrySnapshot>> {
        let Some((snapshot, entries)) = self.repository.current().await? else {
            return Ok(None);
        };
        let fetched_at = DateTime::parse_from_rfc3339(&snapshot.fetched_at)
            .context("invalid persisted Registry fetched_at")?
            .with_timezone(&Utc);
        let entries = entries
            .into_iter()
            .map(|entry| {
                let metadata: StoredRegistryMetadata = serde_json::from_str(&entry.metadata_json)?;
                Ok(RegistryAgentEntry {
                    agent_id: entry.agent_id,
                    registry_id: entry.registry_id,
                    name: metadata.name,
                    version: entry.version,
                    description: metadata.description,
                    repository: metadata.repository,
                    website: metadata.website,
                    authors: metadata.authors,
                    license: metadata.license,
                    distributions: serde_json::from_str(&entry.distributions_json)?,
                    icon_url: metadata.icon_url,
                    icon_svg: entry.icon_svg,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(RegistrySnapshot {
            id: snapshot.id,
            source_url: snapshot.source_url,
            fetched_at,
            schema_version: snapshot.schema_version,
            document_json: snapshot.document_json,
            document_sha256: snapshot.document_sha256,
            etag: snapshot.etag,
            entries,
        }))
    }
}
