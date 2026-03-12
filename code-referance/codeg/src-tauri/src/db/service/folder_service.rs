use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::db::entities::{folder, folder_opened_conversation};
use crate::db::error::DbError;
use crate::models::agent::AgentType;
use crate::models::{FolderDetail, FolderHistoryEntry, OpenedConversation};

fn to_entry(m: folder::Model) -> FolderHistoryEntry {
    FolderHistoryEntry {
        id: m.id,
        path: m.path,
        name: m.name,
        last_opened_at: m.last_opened_at,
    }
}

fn parse_agent_type(s: &Option<String>) -> Option<AgentType> {
    s.as_deref()
        .and_then(|v| serde_json::from_value(serde_json::Value::String(v.to_string())).ok())
}

fn to_detail(m: folder::Model, opened: Vec<OpenedConversation>) -> FolderDetail {
    let default_agent_type = parse_agent_type(&m.default_agent_type);
    FolderDetail {
        id: m.id,
        name: m.name,
        path: m.path,
        git_branch: m.git_branch,
        parent_branch: m.parent_branch,
        default_agent_type,
        last_opened_at: m.last_opened_at,
        opened_conversations: opened,
    }
}

pub async fn get_folder_by_id(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Option<FolderDetail>, DbError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    match row {
        None => Ok(None),
        Some(folder_model) => {
            let opened = load_opened_conversations(conn, folder_model.id).await?;
            Ok(Some(to_detail(folder_model, opened)))
        }
    }
}

pub async fn add_folder(
    conn: &DatabaseConnection,
    path: &str,
) -> Result<FolderHistoryEntry, DbError> {
    let now = Utc::now();
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let existing = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .one(conn)
        .await?;

    let model = if let Some(row) = existing {
        let mut active = row.into_active_model();
        active.name = Set(name);
        active.last_opened_at = Set(now);
        active.updated_at = Set(now);
        active.deleted_at = Set(None);
        active.is_open = Set(true);
        active.update(conn).await?
    } else {
        let active = folder::ActiveModel {
            id: NotSet,
            name: Set(name),
            path: Set(path.to_string()),
            git_branch: Set(None),
            parent_branch: Set(None),
            default_agent_type: Set(None),
            last_opened_at: Set(now),
            created_at: Set(now),
            updated_at: Set(now),
            deleted_at: Set(None),
            is_open: Set(true),
        };
        active.insert(conn).await?
    };

    Ok(to_entry(model))
}

pub async fn list_folders(conn: &DatabaseConnection) -> Result<Vec<FolderHistoryEntry>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_entry).collect())
}

pub async fn remove_folder(conn: &DatabaseConnection, path: &str) -> Result<(), DbError> {
    let now = Utc::now();
    let row = folder::Entity::find()
        .filter(folder::Column::Path.eq(path))
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.deleted_at = Set(Some(now));
        active.updated_at = Set(now);
        active.update(conn).await?;
    }
    Ok(())
}

pub async fn save_opened_conversations(
    conn: &DatabaseConnection,
    folder_id: i32,
    items: Vec<OpenedConversation>,
) -> Result<(), DbError> {
    // Delete all existing opened conversations for this folder
    folder_opened_conversation::Entity::delete_many()
        .filter(folder_opened_conversation::Column::FolderId.eq(folder_id))
        .exec(conn)
        .await?;

    if items.is_empty() {
        return Ok(());
    }

    // Batch insert with raw SQL for efficiency
    let now = Utc::now();
    let now_str = now.format("%Y-%m-%d %H:%M:%S %:z").to_string();

    let mut values = Vec::with_capacity(items.len());
    for item in &items {
        let agent_str = serde_json::to_value(item.agent_type)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        values.push(format!(
            "({}, {}, {}, {}, {}, '{}', '{}', '{}')",
            folder_id,
            item.conversation_id,
            item.position,
            item.is_active as i32,
            item.is_pinned as i32,
            agent_str,
            now_str,
            now_str,
        ));
    }

    let sql = format!(
        "INSERT INTO folder_opened_conversation (folder_id, conversation_id, position, is_active, is_pinned, agent_type, created_at, updated_at) VALUES {}",
        values.join(", ")
    );

    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;

    Ok(())
}

async fn load_opened_conversations(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Vec<OpenedConversation>, DbError> {
    let rows = folder_opened_conversation::Entity::find()
        .filter(folder_opened_conversation::Column::FolderId.eq(folder_id))
        .order_by_asc(folder_opened_conversation::Column::Position)
        .all(conn)
        .await?;

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let agent_type = parse_agent_type(&Some(r.agent_type))?;
            Some(OpenedConversation {
                conversation_id: r.conversation_id,
                agent_type,
                position: r.position,
                is_active: r.is_active,
                is_pinned: r.is_pinned,
            })
        })
        .collect())
}

pub async fn set_folder_parent_branch(
    conn: &DatabaseConnection,
    folder_id: i32,
    parent_branch: Option<String>,
) -> Result<(), DbError> {
    let row = folder::Entity::find_by_id(folder_id).one(conn).await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.parent_branch = Set(parent_branch);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(())
}

pub async fn set_folder_open(
    conn: &DatabaseConnection,
    folder_id: i32,
    is_open: bool,
) -> Result<(), DbError> {
    let row = folder::Entity::find_by_id(folder_id).one(conn).await?;

    if let Some(row) = row {
        let mut active = row.into_active_model();
        active.is_open = Set(is_open);
        active.updated_at = Set(Utc::now());
        active.update(conn).await?;
    }
    Ok(())
}

pub async fn list_open_folders(
    conn: &DatabaseConnection,
) -> Result<Vec<FolderHistoryEntry>, DbError> {
    let rows = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_entry).collect())
}
