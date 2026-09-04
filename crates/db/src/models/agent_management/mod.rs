use std::collections::HashSet;

use api_types::{AgentId, AgentSource, UserAgentDistributionKind};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

pub mod conversation_migration;
pub mod legacy_migration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewInstallationOperation {
    pub agent_id: AgentId,
    pub kind: String,
    pub frozen_plan_json: String,
    pub host_instance_id: String,
    pub resource_claims: Vec<String>,
    pub staging_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationOperationRecord {
    pub id: Uuid,
    pub agent_id: AgentId,
    pub kind: String,
    pub status: String,
    pub frozen_plan_json: String,
    pub host_instance_id: String,
    pub heartbeat_at: Option<String>,
    pub staging_path: Option<String>,
    pub resource_claims: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, FromRow)]
struct InstallationOperationRow {
    id: String,
    agent_id: String,
    operation_kind: String,
    status: String,
    frozen_plan_json: String,
    host_instance_id: String,
    heartbeat_at: Option<String>,
    staging_path: Option<String>,
    resource_claims_json: String,
    created_at: String,
    updated_at: String,
}

impl TryFrom<InstallationOperationRow> for InstallationOperationRecord {
    type Error = AgentManagementRepositoryError;

    fn try_from(row: InstallationOperationRow) -> Result<Self, Self::Error> {
        let raw_agent_id = row.agent_id;
        Ok(Self {
            id: Uuid::parse_str(&row.id)
                .map_err(|_| AgentManagementRepositoryError::InvalidOperationId(row.id))?,
            agent_id: AgentId::parse(&raw_agent_id)
                .map_err(|_| AgentManagementRepositoryError::InvalidAgentId(raw_agent_id))?,
            kind: row.operation_kind,
            status: row.status,
            frozen_plan_json: row.frozen_plan_json,
            host_instance_id: row.host_instance_id,
            heartbeat_at: row.heartbeat_at,
            staging_path: row.staging_path,
            resource_claims: serde_json::from_str(&row.resource_claims_json)
                .map_err(|_| AgentManagementRepositoryError::InvalidResourceClaims)?,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

#[derive(Clone)]
pub struct InstallationOperationRepository {
    pool: SqlitePool,
}

impl InstallationOperationRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn enqueue(
        &self,
        operation: NewInstallationOperation,
    ) -> Result<InstallationOperationRecord, AgentManagementRepositoryError> {
        let id = Uuid::new_v4();
        let claims_json = serde_json::to_string(&operation.resource_claims)
            .map_err(|_| AgentManagementRepositoryError::InvalidResourceClaims)?;
        // This operation reads the current installation before writing the queue rows.
        // In WAL mode a deferred transaction can acquire a read snapshot, lose the writer
        // race to startup warmup, and then fail immediately with SQLITE_BUSY_SNAPSHOT when
        // upgraded. Claim the writer slot up front so SQLite's busy timeout can serialize it.
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            r#"INSERT INTO agent_install_operation
               (id, agent_id, operation_kind, status, frozen_plan_json,
                host_instance_id, staging_path, resource_claims_json)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)"#,
        )
        .bind(id.to_string())
        .bind(operation.agent_id.as_str())
        .bind(&operation.kind)
        .bind(&operation.frozen_plan_json)
        .bind(&operation.host_instance_id)
        .bind(&operation.staging_path)
        .bind(&claims_json)
        .execute(&mut *transaction)
        .await?;
        for resource in &operation.resource_claims {
            sqlx::query(
                r#"INSERT INTO agent_install_resource_lease (resource_key, operation_id)
                   VALUES (?, ?)"#,
            )
            .bind(resource)
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            r#"INSERT INTO agent_installation
               (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
                active_operation, active_operation_id, updated_at)
               VALUES (?, 'external', 'queued', NULL, NULL, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(agent_id) DO UPDATE SET
                 lifecycle = 'queued',
                 active_operation = excluded.active_operation,
                 active_operation_id = excluded.active_operation_id,
                 updated_at = CURRENT_TIMESTAMP"#,
        )
        .bind(operation.agent_id.as_str())
        .bind(&operation.kind)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.find(id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub async fn mark_running(
        &self,
        id: Uuid,
        host_instance_id: &str,
    ) -> Result<(), AgentManagementRepositoryError> {
        sqlx::query(
            r#"UPDATE agent_install_operation
               SET status = 'running',
                   host_instance_id = ?,
                   heartbeat_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'queued'"#,
        )
        .bind(host_instance_id)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_staging_path(
        &self,
        id: Uuid,
        staging_path: &str,
    ) -> Result<(), AgentManagementRepositoryError> {
        sqlx::query(
            r#"UPDATE agent_install_operation
               SET staging_path = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status IN ('queued', 'running')"#,
        )
        .bind(staging_path)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn find(
        &self,
        id: Uuid,
    ) -> Result<Option<InstallationOperationRecord>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, InstallationOperationRow>(
            r#"SELECT id, agent_id, operation_kind, status, frozen_plan_json,
                      host_instance_id, heartbeat_at, staging_path,
                      resource_claims_json, created_at, updated_at
               FROM agent_install_operation WHERE id = ?"#,
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?
        .map(TryInto::try_into)
        .transpose()
    }

    pub async fn active_for_agent(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<InstallationOperationRecord>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, InstallationOperationRow>(
            r#"SELECT id, agent_id, operation_kind, status, frozen_plan_json,
                      host_instance_id, heartbeat_at, staging_path,
                      resource_claims_json, created_at, updated_at
               FROM agent_install_operation
               WHERE agent_id = ? AND status IN ('queued', 'running')
               LIMIT 1"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?
        .map(TryInto::try_into)
        .transpose()
    }

    pub async fn recover_interrupted(
        &self,
        current_host_instance_id: &str,
    ) -> Result<Vec<Uuid>, AgentManagementRepositoryError> {
        let mut transaction = self.pool.begin().await?;
        let ids = sqlx::query_scalar::<_, String>(
            r#"SELECT id FROM agent_install_operation
               WHERE status IN ('queued', 'running') AND host_instance_id <> ?
               ORDER BY created_at, id"#,
        )
        .bind(current_host_instance_id)
        .fetch_all(&mut *transaction)
        .await?;
        for raw_id in &ids {
            sqlx::query(
                r#"UPDATE agent_install_operation
                   SET status = 'interrupted', updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND status IN ('queued', 'running')"#,
            )
            .bind(raw_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query("DELETE FROM agent_install_resource_lease WHERE operation_id = ?")
                .bind(raw_id)
                .execute(&mut *transaction)
                .await?;
            sqlx::query(
                r#"UPDATE agent_installation
                   SET lifecycle = CASE
                         WHEN current_lock_id IS NULL THEN 'interrupted'
                         ELSE 'ready'
                       END,
                       active_operation = NULL,
                       active_operation_id = NULL,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE active_operation_id = ?"#,
            )
            .bind(raw_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        ids.into_iter()
            .map(|id| {
                Uuid::parse_str(&id)
                    .map_err(|_| AgentManagementRepositoryError::InvalidOperationId(id))
            })
            .collect()
    }

    pub async fn finish(
        &self,
        id: Uuid,
        status: &str,
    ) -> Result<(), AgentManagementRepositoryError> {
        if !matches!(status, "succeeded" | "failed" | "cancelled" | "interrupted") {
            return Err(AgentManagementRepositoryError::InvalidOperationStatus(
                status.to_string(),
            ));
        }
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            r#"UPDATE agent_install_operation
               SET status = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status IN ('queued', 'running')"#,
        )
        .bind(status)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM agent_install_resource_lease WHERE operation_id = ?")
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }
}

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
    #[error("invalid persisted installation operation id `{0}`")]
    InvalidOperationId(String),
    #[error("invalid installation operation resource claims")]
    InvalidResourceClaims,
    #[error("invalid installation operation status `{0}`")]
    InvalidOperationStatus(String),
    #[error("reorder must contain every membership exactly once")]
    InvalidReorder,
    #[error("invalid persisted user Agent distribution kind `{0}`")]
    InvalidUserDistributionKind(String),
    #[error("user Agent definition and membership identities must match")]
    UserDefinitionIdentityMismatch,
    #[error("user Agent membership must use the user_definition source")]
    InvalidUserDefinitionSource,
}

fn source_key(source: AgentSource) -> &'static str {
    match source {
        AgentSource::BuiltInProfile => "built_in_profile",
        AgentSource::OfficialRegistry => "official_registry",
        AgentSource::UserDefinition => "user_definition",
        AgentSource::RetiredLegacy => "retired_legacy",
    }
}

fn parse_source(value: &str) -> Result<AgentSource, AgentManagementRepositoryError> {
    match value {
        "built_in_profile" => Ok(AgentSource::BuiltInProfile),
        "official_registry" => Ok(AgentSource::OfficialRegistry),
        "user_definition" => Ok(AgentSource::UserDefinition),
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

fn user_distribution_kind_key(kind: UserAgentDistributionKind) -> &'static str {
    match kind {
        UserAgentDistributionKind::Binary => "binary",
        UserAgentDistributionKind::Npx => "npx",
        UserAgentDistributionKind::Uvx => "uvx",
    }
}

fn parse_user_distribution_kind(
    value: &str,
) -> Result<UserAgentDistributionKind, AgentManagementRepositoryError> {
    match value {
        "binary" => Ok(UserAgentDistributionKind::Binary),
        "npx" => Ok(UserAgentDistributionKind::Npx),
        "uvx" => Ok(UserAgentDistributionKind::Uvx),
        other => Err(AgentManagementRepositoryError::InvalidUserDistributionKind(
            other.to_string(),
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAgentDefinitionRecord {
    pub agent_id: AgentId,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub distribution_kind: UserAgentDistributionKind,
    pub distributions_json: String,
    pub definition_sha256: String,
    pub skills_shared_store: bool,
    pub skills_directory: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, FromRow)]
struct UserAgentDefinitionRow {
    agent_id: String,
    display_name: String,
    description: String,
    version: String,
    distribution_kind: String,
    distributions_json: String,
    definition_sha256: String,
    skills_shared_store: bool,
    skills_directory: Option<String>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<UserAgentDefinitionRow> for UserAgentDefinitionRecord {
    type Error = AgentManagementRepositoryError;

    fn try_from(row: UserAgentDefinitionRow) -> Result<Self, Self::Error> {
        let raw_id = row.agent_id;
        Ok(Self {
            agent_id: AgentId::parse(&raw_id)
                .map_err(|_| AgentManagementRepositoryError::InvalidAgentId(raw_id))?,
            display_name: row.display_name,
            description: row.description,
            version: row.version,
            distribution_kind: parse_user_distribution_kind(&row.distribution_kind)?,
            distributions_json: row.distributions_json,
            definition_sha256: row.definition_sha256,
            skills_shared_store: row.skills_shared_store,
            skills_directory: row.skills_directory,
            created_at: Some(row.created_at),
            updated_at: Some(row.updated_at),
        })
    }
}

#[derive(Clone)]
pub struct UserAgentDefinitionRepository {
    pool: SqlitePool,
}

impl UserAgentDefinitionRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn add_with_membership(
        &self,
        membership: NewAgentMembership,
        definition: UserAgentDefinitionRecord,
    ) -> Result<UserAgentDefinitionRecord, AgentManagementRepositoryError> {
        if membership.agent_id != definition.agent_id {
            return Err(AgentManagementRepositoryError::UserDefinitionIdentityMismatch);
        }
        if membership.source != AgentSource::UserDefinition {
            return Err(AgentManagementRepositoryError::InvalidUserDefinitionSource);
        }
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO agent_membership (
                   agent_id, source, built_in, retired, enabled, position,
                   retained_metadata_json, retained_icon_svg
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(membership.agent_id.as_str())
        .bind(source_key(membership.source))
        .bind(membership.built_in)
        .bind(membership.retired)
        .bind(membership.enabled)
        .bind(membership.position)
        .bind(membership.retained_metadata_json)
        .bind(membership.retained_icon_svg)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO agent_user_definition (
                   agent_id, display_name, description, version,
                   distribution_kind, distributions_json, definition_sha256,
                   skills_shared_store, skills_directory
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(definition.agent_id.as_str())
        .bind(definition.display_name)
        .bind(definition.description)
        .bind(definition.version)
        .bind(user_distribution_kind_key(definition.distribution_kind))
        .bind(definition.distributions_json)
        .bind(definition.definition_sha256)
        .bind(definition.skills_shared_store)
        .bind(definition.skills_directory)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        self.find(&membership.agent_id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub async fn find(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<UserAgentDefinitionRecord>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, UserAgentDefinitionRow>(
            r#"SELECT agent_id, display_name, description, version,
                      distribution_kind, distributions_json, definition_sha256,
                      skills_shared_store, skills_directory,
                      created_at, updated_at
               FROM agent_user_definition WHERE agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?
        .map(TryInto::try_into)
        .transpose()
    }

    pub async fn update(
        &self,
        definition: UserAgentDefinitionRecord,
    ) -> Result<UserAgentDefinitionRecord, AgentManagementRepositoryError> {
        let result = sqlx::query(
            r#"UPDATE agent_user_definition
               SET display_name = ?, description = ?, version = ?,
                   distribution_kind = ?, distributions_json = ?,
                   definition_sha256 = ?, skills_shared_store = ?,
                   skills_directory = ?, updated_at = CURRENT_TIMESTAMP
               WHERE agent_id = ?"#,
        )
        .bind(definition.display_name)
        .bind(definition.description)
        .bind(definition.version)
        .bind(user_distribution_kind_key(definition.distribution_kind))
        .bind(definition.distributions_json)
        .bind(definition.definition_sha256)
        .bind(definition.skills_shared_store)
        .bind(definition.skills_directory)
        .bind(definition.agent_id.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound.into());
        }
        self.find(&definition.agent_id)
            .await?
            .ok_or_else(|| sqlx::Error::RowNotFound.into())
    }

    pub async fn list(
        &self,
    ) -> Result<Vec<UserAgentDefinitionRecord>, AgentManagementRepositoryError> {
        sqlx::query_as::<_, UserAgentDefinitionRow>(
            r#"SELECT agent_id, display_name, description, version,
                      distribution_kind, distributions_json, definition_sha256,
                      skills_shared_store, skills_directory,
                      created_at, updated_at
               FROM agent_user_definition ORDER BY display_name, agent_id"#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
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
    /// Registry-declared version of the bound component (`acp_adapter` or
    /// `combined_runtime`). Not the adapter-backed local Runtime pin.
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
        if lifecycle == "ready" {
            sqlx::query(
                r#"UPDATE agent_diagnostic
                   SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
                   WHERE agent_id = ?
                     AND severity = 'error'
                     AND read_at IS NULL"#,
            )
            .bind(lock.agent_id.as_str())
            .execute(&mut *transaction)
            .await?;
        }
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

    pub async fn latest_error_output(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<String>, AgentManagementRepositoryError> {
        let output = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT redacted_output
               FROM agent_diagnostic
               WHERE agent_id = ?
                 AND severity = 'error'
               ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END,
                        created_at DESC, id DESC
               LIMIT 1"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        Ok(output.flatten().filter(|value| !value.trim().is_empty()))
    }

    pub async fn mark_error_diagnostics_read(
        &self,
        agent_id: &AgentId,
    ) -> Result<(), AgentManagementRepositoryError> {
        sqlx::query(
            r#"UPDATE agent_diagnostic
               SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
               WHERE agent_id = ?
                 AND severity = 'error'
                 AND read_at IS NULL"#,
        )
        .bind(agent_id.as_str())
        .execute(&self.pool)
        .await?;
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

    /// Last-used upsert for one advertised option (CodeG `saveConfigPreference`).
    /// Does not replace the agent's other saved defaults.
    pub async fn upsert(
        &self,
        agent_id: &AgentId,
        option_id: &str,
        value_json: &str,
    ) -> Result<(), AgentManagementRepositoryError> {
        sqlx::query(
            r#"INSERT INTO agent_session_default
                   (agent_id, option_id, value_json, updated_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(agent_id, option_id) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at = excluded.updated_at"#,
        )
        .bind(agent_id.as_str())
        .bind(option_id)
        .bind(value_json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_for_agent(
        &self,
        agent_id: &AgentId,
    ) -> Result<Vec<SessionDefaultRecord>, AgentManagementRepositoryError> {
        Ok(sqlx::query_as::<_, (String, String, String)>(
            r#"SELECT option_id, value_json, updated_at
               FROM agent_session_default
               WHERE agent_id = ?
               ORDER BY option_id"#,
        )
        .bind(agent_id.as_str())
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(option_id, value_json, updated_at)| SessionDefaultRecord {
            option_id,
            value_json,
            updated_at,
        })
        .collect())
    }
}
