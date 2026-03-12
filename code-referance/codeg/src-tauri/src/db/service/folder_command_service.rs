use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set, Statement,
};

use crate::db::entities::folder_command;
use crate::db::error::DbError;
use crate::models::FolderCommandInfo;

fn to_info(m: folder_command::Model) -> FolderCommandInfo {
    FolderCommandInfo {
        id: m.id,
        folder_id: m.folder_id,
        name: m.name,
        command: m.command,
        sort_order: m.sort_order,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

pub async fn list_by_folder(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<Vec<FolderCommandInfo>, DbError> {
    let rows = folder_command::Entity::find()
        .filter(folder_command::Column::FolderId.eq(folder_id))
        .order_by_asc(folder_command::Column::SortOrder)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_info).collect())
}

pub async fn create(
    conn: &DatabaseConnection,
    folder_id: i32,
    name: &str,
    command: &str,
) -> Result<FolderCommandInfo, DbError> {
    let now = Utc::now();

    // Get next sort_order
    let max_order = folder_command::Entity::find()
        .filter(folder_command::Column::FolderId.eq(folder_id))
        .order_by_desc(folder_command::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(-1);

    let active = folder_command::ActiveModel {
        id: NotSet,
        folder_id: Set(folder_id),
        name: Set(name.to_string()),
        command: Set(command.to_string()),
        sort_order: Set(max_order + 1),
        created_at: Set(now),
        updated_at: Set(now),
    };

    let model = active.insert(conn).await?;
    Ok(to_info(model))
}

pub async fn create_many(
    conn: &DatabaseConnection,
    folder_id: i32,
    items: &[(String, String)],
) -> Result<(), DbError> {
    if items.is_empty() {
        return Ok(());
    }

    let now = Utc::now();

    let max_order = folder_command::Entity::find()
        .filter(folder_command::Column::FolderId.eq(folder_id))
        .order_by_desc(folder_command::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(-1);

    let active_models = items
        .iter()
        .enumerate()
        .map(|(idx, (name, command))| folder_command::ActiveModel {
            id: NotSet,
            folder_id: Set(folder_id),
            name: Set(name.clone()),
            command: Set(command.clone()),
            sort_order: Set(max_order + idx as i32 + 1),
            created_at: Set(now),
            updated_at: Set(now),
        })
        .collect::<Vec<_>>();

    folder_command::Entity::insert_many(active_models)
        .exec(conn)
        .await?;

    Ok(())
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    name: Option<String>,
    command: Option<String>,
    sort_order: Option<i32>,
) -> Result<FolderCommandInfo, DbError> {
    let row = folder_command::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::Migration(format!("FolderCommand {} not found", id)))?;

    let mut active = row.into_active_model();
    if let Some(n) = name {
        active.name = Set(n);
    }
    if let Some(c) = command {
        active.command = Set(c);
    }
    if let Some(s) = sort_order {
        active.sort_order = Set(s);
    }
    active.updated_at = Set(Utc::now());

    let model = active.update(conn).await?;
    Ok(to_info(model))
}

pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    folder_command::Entity::delete_by_id(id).exec(conn).await?;
    Ok(())
}

pub async fn reorder(
    conn: &DatabaseConnection,
    folder_id: i32,
    ids: Vec<i32>,
) -> Result<(), DbError> {
    if ids.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let now_str = now.format("%Y-%m-%d %H:%M:%S %:z").to_string();
    let case_expr = ids
        .iter()
        .enumerate()
        .map(|(idx, id)| format!("WHEN {} THEN {}", id, idx))
        .collect::<Vec<_>>()
        .join(" ");
    let id_list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "UPDATE folder_command SET sort_order = CASE id {case_expr} END, updated_at = '{now_str}' WHERE folder_id = {folder_id} AND id IN ({id_list})"
    );
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;

    Ok(())
}
