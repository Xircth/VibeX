use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    #[sea_orm(string_value = "in_progress")]
    InProgress,
    #[sea_orm(string_value = "pending_review")]
    PendingReview,
    #[sea_orm(string_value = "completed")]
    Completed,
    #[sea_orm(string_value = "cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub folder_id: i32,
    pub title: Option<String>,
    pub agent_type: String,
    pub status: ConversationStatus,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub external_id: Option<String>,
    pub parent_id: Option<i32>,
    pub message_count: i32,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::folder::Entity",
        from = "Column::FolderId",
        to = "super::folder::Column::Id"
    )]
    Folder,
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folder.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
