use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .add_column(
                        ColumnDef::new(Folder::IsOpen)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .drop_column(Folder::IsOpen)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    IsOpen,
}
