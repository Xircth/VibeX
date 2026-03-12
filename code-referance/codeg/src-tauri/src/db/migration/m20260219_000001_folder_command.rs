use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(FolderCommand::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(FolderCommand::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(FolderCommand::FolderId).integer().not_null())
                    .col(ColumnDef::new(FolderCommand::Name).string().not_null())
                    .col(ColumnDef::new(FolderCommand::Command).string().not_null())
                    .col(
                        ColumnDef::new(FolderCommand::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(FolderCommand::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FolderCommand::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_folder_command_folder")
                            .from(FolderCommand::Table, FolderCommand::FolderId)
                            .to(Folder::Table, Folder::Id)
                            .on_delete(ForeignKeyAction::Cascade)
                            .on_update(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_folder_command_folder_id")
                    .table(FolderCommand::Table)
                    .col(FolderCommand::FolderId)
                    .col(FolderCommand::SortOrder)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(FolderCommand::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum FolderCommand {
    Table,
    Id,
    FolderId,
    Name,
    Command,
    SortOrder,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    Id,
}
