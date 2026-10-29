use serde_json::{Value, json};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::{ConversationListItem, MemberSessionConfig, RoleRecord, TeamRecord};

#[derive(Debug, FromRow)]
pub(crate) struct ListRow {
    pub(crate) conversation_id: Uuid,
    pub(crate) title: Option<String>,
    pub(crate) agent_id: Option<String>,
    pub(crate) status: String,
    pub(crate) updated_at: String,
    pub(crate) parent_id: Option<Uuid>,
    pub(crate) delegation_call_id: Option<String>,
    pub(crate) workspace_id: Uuid,
    pub(crate) turn_in_flight_flag: i64,
    pub(crate) mode_id: Option<String>,
    pub(crate) config_values_json: Option<String>,
}

impl ListRow {
    pub(crate) fn into_item(
        self,
        turn_in_flight: bool,
        delegated: bool,
        mode_id: Option<String>,
        config_values: Option<Value>,
    ) -> ConversationListItem {
        ConversationListItem {
            conversation_id: self.conversation_id,
            title: self.title,
            agent_id: self.agent_id,
            status: self.status,
            updated_at: self.updated_at,
            turn_in_flight,
            parent_id: self.parent_id,
            delegated,
            workspace_id: self.workspace_id,
            mode_id,
            config_values,
        }
    }

    pub(crate) async fn query_by_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
        cutoff: &str,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT s.id AS conversation_id,
                      s.name AS title,
                      s.agent_id,
                      s.status,
                      s.updated_at,
                      s.parent_session_id AS parent_id,
                      s.delegation_call_id,
                      s.workspace_id,
                      EXISTS (
                        SELECT 1 FROM conversation_turns turn
                        WHERE turn.conversation_id = s.id
                          AND turn.status IN ('pending', 'queued', 'running', 'blocked')
                      ) AS turn_in_flight_flag,
                      (
                        SELECT binding.current_mode FROM conversation_agent_bindings binding
                        WHERE binding.conversation_id = s.id
                          AND binding.current_mode IS NOT NULL
                          AND trim(binding.current_mode) != ''
                        ORDER BY binding.created_at DESC LIMIT 1
                      ) AS mode_id,
                      (
                        SELECT binding.config_selection_json FROM conversation_agent_bindings binding
                        WHERE binding.conversation_id = s.id
                          AND binding.config_selection_json IS NOT NULL
                          AND binding.config_selection_json NOT IN ('', '{}')
                        ORDER BY binding.created_at DESC LIMIT 1
                      ) AS config_values_json
               FROM sessions s
               WHERE s.deleted_at IS NULL
                 AND s.status != 'archived'
                 AND s.workspace_id = ?
                 AND datetime(replace(substr(s.updated_at, 1, 19), 'T', ' ')) >= datetime(?)
               ORDER BY s.updated_at DESC
               LIMIT ?"#,
        )
        .bind(workspace_id)
        .bind(cutoff)
        .bind(limit)
        .fetch_all(pool)
        .await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct TeamRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) summary: Option<String>,
}

impl TeamRow {
    pub(crate) fn into_record(self) -> TeamRecord {
        TeamRecord {
            id: self.id,
            name: self.name,
            summary: self.summary,
        }
    }

    pub(crate) async fn count_tx(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_teams")
            .fetch_one(conn)
            .await
    }

    pub(crate) async fn insert_tx(
        conn: &mut SqliteConnection,
        id: &str,
        name: &str,
        summary: Option<&str>,
        stamp: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO collaboration_teams (id, name, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(summary)
        .bind(stamp)
        .bind(stamp)
        .execute(conn)
        .await?;
        Ok(())
    }

    pub(crate) async fn update_by_id(
        pool: &SqlitePool,
        id: &str,
        name: &str,
        summary: Option<&str>,
        stamp: &str,
    ) -> Result<u64, sqlx::Error> {
        let changed = sqlx::query(
            "UPDATE collaboration_teams SET name = ?, summary = ?, updated_at = ? WHERE id = ?",
        )
        .bind(name)
        .bind(summary)
        .bind(stamp)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(changed.rows_affected())
    }

    pub(crate) async fn delete_by_id(
        pool: &SqlitePool,
        id: &str,
        stamp: &str,
    ) -> Result<u64, sqlx::Error> {
        sqlx::query(
            "UPDATE collaboration_roles SET team_id = NULL, updated_at = ? WHERE team_id = ?",
        )
        .bind(stamp)
        .bind(id)
        .execute(pool)
        .await?;
        let changed = sqlx::query("DELETE FROM collaboration_teams WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(changed.rows_affected())
    }

    pub(crate) async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT id, name, summary FROM collaboration_teams ORDER BY created_at, id",
        )
        .fetch_all(pool)
        .await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct RoleRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) team_id: Option<String>,
    pub(crate) summary: String,
    pub(crate) persona_prompt: String,
    pub(crate) agent_id: String,
    pub(crate) mode_id: Option<String>,
    pub(crate) config_values_json: String,
}

impl RoleRow {
    pub(crate) fn into_record(self) -> RoleRecord {
        RoleRecord {
            id: self.id,
            name: self.name,
            team_id: self.team_id,
            summary: self.summary,
            persona_prompt: self.persona_prompt,
            agent_id: self.agent_id,
            mode_id: self.mode_id,
            config_values: serde_json::from_str(&self.config_values_json)
                .unwrap_or_else(|_| json!({})),
        }
    }

    pub(crate) async fn count_tx(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_roles")
            .fetch_one(conn)
            .await
    }

    pub(crate) async fn insert_tx(
        conn: &mut SqliteConnection,
        row: &Self,
        stamp: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO collaboration_roles
               (id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&row.id)
        .bind(&row.name)
        .bind(row.team_id.as_deref())
        .bind(&row.summary)
        .bind(&row.persona_prompt)
        .bind(&row.agent_id)
        .bind(row.mode_id.as_deref())
        .bind(&row.config_values_json)
        .bind(stamp)
        .bind(stamp)
        .execute(conn)
        .await?;
        Ok(())
    }

    pub(crate) async fn update_by_id(
        pool: &SqlitePool,
        row: &Self,
        stamp: &str,
    ) -> Result<u64, sqlx::Error> {
        let changed = sqlx::query(
            r#"UPDATE collaboration_roles
               SET name = ?, team_id = ?, summary = ?, persona_prompt = ?, agent_id = ?,
                   mode_id = ?, config_values_json = ?, updated_at = ?
               WHERE id = ?"#,
        )
        .bind(&row.name)
        .bind(row.team_id.as_deref())
        .bind(&row.summary)
        .bind(&row.persona_prompt)
        .bind(&row.agent_id)
        .bind(row.mode_id.as_deref())
        .bind(&row.config_values_json)
        .bind(stamp)
        .bind(&row.id)
        .execute(pool)
        .await?;
        Ok(changed.rows_affected())
    }

    pub(crate) async fn delete_by_id(pool: &SqlitePool, id: &str) -> Result<u64, sqlx::Error> {
        sqlx::query("UPDATE conversation_personas SET role_id = NULL WHERE role_id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        sqlx::query("UPDATE collaboration_members SET role_id = NULL WHERE role_id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        let changed = sqlx::query("DELETE FROM collaboration_roles WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(changed.rows_affected())
    }

    pub(crate) async fn find_by_id(
        pool: &SqlitePool,
        id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values_json
               FROM collaboration_roles WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub(crate) async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values_json
               FROM collaboration_roles ORDER BY created_at, id"#,
        )
        .fetch_all(pool)
        .await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct StoredCreateOperation {
    pub(crate) caller_id: String,
    pub(crate) request_json: String,
}

impl StoredCreateOperation {
    pub(crate) async fn find_by_id(
        pool: &SqlitePool,
        operation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT caller_id, request_json FROM collaboration_create_operations
               WHERE operation_id = ?"#,
        )
        .bind(operation_id.to_string())
        .fetch_optional(pool)
        .await
    }

    pub(crate) async fn insert(
        pool: &SqlitePool,
        operation_id: Uuid,
        caller_id: Uuid,
        request_json: &str,
        stamp: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO collaboration_create_operations
               (operation_id, caller_id, request_json, conversation_id, created_at)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(operation_id.to_string())
        .bind(caller_id.to_string())
        .bind(request_json)
        .bind(operation_id.to_string())
        .bind(stamp)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct SpaceRow {
    pub(crate) workspace_id: String,
}

impl SpaceRow {
    pub(crate) async fn find_by_id(
        pool: &SqlitePool,
        space_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT workspace_id FROM collaboration_spaces WHERE id = ?")
            .bind(space_id)
            .fetch_optional(pool)
            .await
    }
}

#[derive(Debug, FromRow)]
pub(crate) struct MemberSessionConfigRow {
    pub(crate) agent_id: Option<String>,
    pub(crate) mode_id: Option<String>,
    pub(crate) config_values: Option<String>,
    pub(crate) persona_prompt: Option<String>,
}

impl MemberSessionConfigRow {
    pub(crate) fn into_config(self) -> MemberSessionConfig {
        MemberSessionConfig {
            agent_id: self.agent_id,
            mode_id: self.mode_id,
            config_values: self
                .config_values
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_else(|| json!({})),
            persona_prompt: self.persona_prompt,
        }
    }

    pub(crate) async fn find_by_member_id(
        pool: &SqlitePool,
        member_id: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            "SELECT agent AS agent_id, mode_id, config_values, persona_prompt FROM collaboration_members WHERE id = ?",
        )
        .bind(member_id)
        .fetch_optional(pool)
        .await
    }
}
