use std::collections::HashSet;

use api_types::{AgentId, AgentSource};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub mod conversation_migration;
pub mod legacy_migration;

#[derive(Debug, thiserror::Error)]
pub enum AgentManagementRepositoryError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("invalid persisted Agent identity `{0}`")]
    InvalidAgentId(String),
    #[error("invalid persisted Agent source `{0}`")]
    InvalidSource(String),
    #[error("invalid persisted Registry snapshot id `{0}`")]
    InvalidSnapshotId(String),
    #[error("reorder must contain every membership exactly once")]
    InvalidReorder,
}

fn source_key(source: AgentSource) -> &'static str {
    match source {
        AgentSource::BuiltInProfile => "built_in_profile",
        AgentSource::OfficialRegistry => "official_registry",
        AgentSource::RetiredLegacy => "retired_legacy",
    }
}

fn parse_source(value: &str) -> Result<AgentSource, AgentManagementRepositoryError> {
    match value {
        "built_in_profile" => Ok(AgentSource::BuiltInProfile),
        "official_registry" => Ok(AgentSource::OfficialRegistry),
        "retired_legacy" => Ok(AgentSource::RetiredLegacy),
        other => Err(AgentManagementRepositoryError::InvalidSource(
            other.to_string(),
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMembership {
    pub agent_id: AgentId,
    pub source: AgentSource,
    pub built_in: bool,
    pub retired: bool,
    pub enabled: bool,
    pub position: i64,
    pub retained_metadata_json: Option<String>,
    pub retained_icon_svg: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAgentMembership {
    pub agent_id: AgentId,
    pub source: AgentSource,
    pub built_in: bool,
    pub retired: bool,
    pub enabled: bool,
    pub position: i64,
    pub retained_metadata_json: Option<String>,
    pub retained_icon_svg: Option<String>,
}

#[derive(Debug, FromRow)]
struct AgentMembershipRow {
    agent_id: String,
    source: String,
    built_in: bool,
    retired: bool,
    enabled: bool,
    position: i64,
    retained_metadata_json: Option<String>,
    retained_icon_svg: Option<String>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<AgentMembershipRow> for AgentMembership {
    type Error = AgentManagementRepositoryError;

    fn try_from(row: AgentMembershipRow) -> Result<Self, Self::Error> {
        let raw_id = row.agent_id;
        Ok(Self {
            agent_id: AgentId::parse(&raw_id)
                .map_err(|_| AgentManagementRepositoryError::InvalidAgentId(raw_id))?,
            source: parse_source(&row.source)?,
            built_in: row.built_in,
            retired: row.retired,
            enabled: row.enabled,
            position: row.position,
            retained_metadata_json: row.retained_metadata_json,
            retained_icon_svg: row.retained_icon_svg,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

#[derive(Clone)]
pub struct AgentMembershipRepository {
    pool: SqlitePool,
}

impl AgentMembershipRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn add(
        &self,
        membership: NewAgentMembership,
    ) -> Result<AgentMembership, AgentManagementRepositoryError> {
        sqlx::query(
            r#"INSERT INTO agent_membership (
                   agent_id, source, built_in, retired, enabled, position,
                   retained_metadata_json, retained_icon_svg
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(agent_id) DO UPDATE SET
                   source = excluded.source,
                   built_in = excluded.built_in,
                   retired = excluded.retired,
                   enabled = excluded.enabled,
                   position = excluded.position,
                   retained_metadata_json = excluded.retained_metadata_json,
                   retained_icon_svg = excluded.retained_icon_svg,
                   updated_at = CURRENT_TIMESTAMP"#,
        )
        .bind(membership.agent_id.as_str())
        .bind(source_key(membership.source))
        .bind(membership.built_in)
        .bind(membership.retired)
        .bind(membership.enabled)
        .bind(membership.position)
        .bind(membership.retained_metadata_json)
        .bind(membership.retained_icon_svg)
        .execute(&self.pool)
        .await?;
        self.find(&membership.agent_id)
            .await?
            .ok_or(sqlx::Error::RowNotFound.into())
    }

    pub async fn find(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<AgentMembership>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, AgentMembershipRow>(
            r#"SELECT agent_id, source, built_in, retired, enabled, position,
                      retained_metadata_json, retained_icon_svg, created_at, updated_at
               FROM agent_membership WHERE agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?
        .map(TryInto::try_into)
        .transpose()
    }

    pub async fn list(&self) -> Result<Vec<AgentMembership>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, AgentMembershipRow>(
            r#"SELECT agent_id, source, built_in, retired, enabled, position,
                      retained_metadata_json, retained_icon_svg, created_at, updated_at
               FROM agent_membership ORDER BY position ASC, agent_id ASC"#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
    }

    pub async fn reorder(&self, order: &[AgentId]) -> Result<(), AgentManagementRepositoryError> {
        let unique = order.iter().map(AgentId::as_str).collect::<HashSet<_>>();
        let existing = sqlx::query_scalar::<_, String>("SELECT agent_id FROM agent_membership")
            .fetch_all(&self.pool)
            .await?;
        if unique.len() != order.len()
            || existing.len() != order.len()
            || existing.iter().any(|id| !unique.contains(id.as_str()))
        {
            return Err(AgentManagementRepositoryError::InvalidReorder);
        }

        let mut transaction = self.pool.begin().await?;
        for (position, agent_id) in order.iter().enumerate() {
            sqlx::query(
                "UPDATE agent_membership SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            )
            .bind(position as i64)
            .bind(agent_id.as_str())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrySnapshotRecord {
    pub id: Uuid,
    pub source_url: String,
    pub fetched_at: String,
    pub schema_version: String,
    pub document_json: String,
    pub document_sha256: String,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryEntryRecord {
    pub agent_id: AgentId,
    pub registry_id: String,
    pub version: String,
    pub sort_name: String,
    pub metadata_json: String,
    pub distributions_json: String,
    pub icon_svg: Option<String>,
}

#[derive(Debug, FromRow)]
struct RegistrySnapshotRow {
    id: String,
    source_url: String,
    fetched_at: String,
    schema_version: String,
    document_json: String,
    document_sha256: String,
    etag: Option<String>,
}

#[derive(Debug, FromRow)]
struct RegistryEntryRow {
    agent_id: String,
    registry_id: String,
    version: String,
    sort_name: String,
    metadata_json: String,
    distributions_json: String,
    icon_svg: Option<String>,
}

#[derive(Clone)]
pub struct RegistrySnapshotRepository {
    pool: SqlitePool,
}

impl RegistrySnapshotRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn current(
        &self,
    ) -> Result<
        Option<(RegistrySnapshotRecord, Vec<RegistryEntryRecord>)>,
        AgentManagementRepositoryError,
    > {
        let Some(row) = sqlx::query_as::<_, RegistrySnapshotRow>(
            r#"SELECT id, source_url, fetched_at, schema_version, document_json,
                      document_sha256, etag
               FROM agent_registry_snapshot
               LIMIT 1"#,
        )
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let snapshot_id = Uuid::parse_str(&row.id)
            .map_err(|_| AgentManagementRepositoryError::InvalidSnapshotId(row.id.clone()))?;
        let entry_rows = sqlx::query_as::<_, RegistryEntryRow>(
            r#"SELECT agent_id, registry_id, version, sort_name, metadata_json,
                      distributions_json, icon_svg
               FROM agent_registry_entry
               WHERE snapshot_id = ?
               ORDER BY sort_name COLLATE NOCASE ASC, agent_id ASC"#,
        )
        .bind(snapshot_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        let entries = entry_rows
            .into_iter()
            .map(|entry| {
                let raw_agent_id = entry.agent_id;
                Ok(RegistryEntryRecord {
                    agent_id: AgentId::parse(&raw_agent_id).map_err(|_| {
                        AgentManagementRepositoryError::InvalidAgentId(raw_agent_id)
                    })?,
                    registry_id: entry.registry_id,
                    version: entry.version,
                    sort_name: entry.sort_name,
                    metadata_json: entry.metadata_json,
                    distributions_json: entry.distributions_json,
                    icon_svg: entry.icon_svg,
                })
            })
            .collect::<Result<Vec<_>, AgentManagementRepositoryError>>()?;
        Ok(Some((
            RegistrySnapshotRecord {
                id: snapshot_id,
                source_url: row.source_url,
                fetched_at: row.fetched_at,
                schema_version: row.schema_version,
                document_json: row.document_json,
                document_sha256: row.document_sha256,
                etag: row.etag,
            },
            entries,
        )))
    }

    pub async fn replace(
        &self,
        snapshot: &RegistrySnapshotRecord,
        entries: &[RegistryEntryRecord],
    ) -> Result<(), AgentManagementRepositoryError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM agent_registry_snapshot")
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            r#"INSERT INTO agent_registry_snapshot
               (id, source_url, fetched_at, schema_version, document_json, document_sha256, etag)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(snapshot.id.to_string())
        .bind(&snapshot.source_url)
        .bind(&snapshot.fetched_at)
        .bind(&snapshot.schema_version)
        .bind(&snapshot.document_json)
        .bind(&snapshot.document_sha256)
        .bind(&snapshot.etag)
        .execute(&mut *transaction)
        .await?;
        for entry in entries {
            sqlx::query(
                r#"INSERT INTO agent_registry_entry
                   (snapshot_id, agent_id, registry_id, version, sort_name,
                    metadata_json, distributions_json, icon_svg)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(snapshot.id.to_string())
            .bind(entry.agent_id.as_str())
            .bind(&entry.registry_id)
            .bind(&entry.version)
            .bind(&entry.sort_name)
            .bind(&entry.metadata_json)
            .bind(&entry.distributions_json)
            .bind(&entry.icon_svg)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallLockRecord {
    pub id: Uuid,
    pub agent_id: AgentId,
    pub registry_version: String,
    pub platform: String,
    pub distribution_kind: String,
    pub resolved_json: String,
    pub created_at: String,
}

#[derive(Clone)]
pub struct InstallationRepository {
    pool: SqlitePool,
}

impl InstallationRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn set_current_lock(
        &self,
        lock: &InstallLockRecord,
        ownership: &str,
        lifecycle: &str,
    ) -> Result<(), AgentManagementRepositoryError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO agent_install_lock
               (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(lock.id.to_string())
        .bind(lock.agent_id.as_str())
        .bind(&lock.registry_version)
        .bind(&lock.platform)
        .bind(&lock.distribution_kind)
        .bind(&lock.resolved_json)
        .bind(&lock.created_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO agent_installation
               (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id, updated_at)
               VALUES (?, ?, ?, ?, NULL, ?)
               ON CONFLICT(agent_id) DO UPDATE SET
                   ownership = excluded.ownership,
                   lifecycle = excluded.lifecycle,
                   rollback_lock_id = agent_installation.current_lock_id,
                   current_lock_id = excluded.current_lock_id,
                   updated_at = excluded.updated_at"#,
        )
        .bind(lock.agent_id.as_str())
        .bind(ownership)
        .bind(lifecycle)
        .bind(lock.id.to_string())
        .bind(&lock.created_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticRecord {
    pub id: Uuid,
    pub agent_id: AgentId,
    pub operation_kind: String,
    pub severity: String,
    pub message: String,
    pub redacted_output: Option<String>,
    pub created_at: String,
}

#[derive(Clone)]
pub struct DiagnosticRepository {
    pool: SqlitePool,
}

impl DiagnosticRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn append_bounded(
        &self,
        diagnostic: &DiagnosticRecord,
    ) -> Result<(), AgentManagementRepositoryError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO agent_diagnostic
               (id, agent_id, operation_kind, severity, message, redacted_output, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(diagnostic.id.to_string())
        .bind(diagnostic.agent_id.as_str())
        .bind(&diagnostic.operation_kind)
        .bind(&diagnostic.severity)
        .bind(&diagnostic.message)
        .bind(&diagnostic.redacted_output)
        .bind(&diagnostic.created_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"DELETE FROM agent_diagnostic
               WHERE agent_id = ? AND id NOT IN (
                   SELECT id FROM agent_diagnostic
                   WHERE agent_id = ?
                   ORDER BY created_at DESC, id DESC
                   LIMIT 20
               )"#,
        )
        .bind(diagnostic.agent_id.as_str())
        .bind(diagnostic.agent_id.as_str())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDefaultRecord {
    pub option_id: String,
    pub value_json: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct SessionDefaultRepository {
    pool: SqlitePool,
}

impl SessionDefaultRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn replace_for_agent(
        &self,
        agent_id: &AgentId,
        defaults: &[SessionDefaultRecord],
    ) -> Result<(), AgentManagementRepositoryError> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM agent_session_default WHERE agent_id = ?")
            .bind(agent_id.as_str())
            .execute(&mut *transaction)
            .await?;
        for default in defaults {
            sqlx::query(
                r#"INSERT INTO agent_session_default
                   (agent_id, option_id, value_json, updated_at)
                   VALUES (?, ?, ?, ?)"#,
            )
            .bind(agent_id.as_str())
            .bind(&default.option_id)
            .bind(&default.value_json)
            .bind(&default.updated_at)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }
}
