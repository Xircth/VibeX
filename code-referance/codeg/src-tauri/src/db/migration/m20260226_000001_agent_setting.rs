use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(AgentSetting::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(AgentSetting::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(AgentSetting::AgentType)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(AgentSetting::RegistryId).string().not_null())
                    .col(
                        ColumnDef::new(AgentSetting::Enabled)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(
                        ColumnDef::new(AgentSetting::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(AgentSetting::InstalledVersion)
                            .string()
                            .null(),
                    )
                    .col(ColumnDef::new(AgentSetting::EnvJson).text().null())
                    .col(
                        ColumnDef::new(AgentSetting::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AgentSetting::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_agent_setting_sort_order")
                    .table(AgentSetting::Table)
                    .col(AgentSetting::SortOrder)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(AgentSetting::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum AgentSetting {
    Table,
    Id,
    AgentType,
    RegistryId,
    Enabled,
    SortOrder,
    InstalledVersion,
    EnvJson,
    CreatedAt,
    UpdatedAt,
}
