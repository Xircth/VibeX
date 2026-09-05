use conversations::{
    ConversationBundleError, export_conversation_bundle as export_core,
    import_conversation_bundle as import_core,
};
pub use conversations::{
    ConversationExportResult, ConversationForkContinuity, ConversationForkResult,
    ConversationImportResult,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppError;

impl From<ConversationBundleError> for AppError {
    fn from(error: ConversationBundleError) -> Self {
        match error {
            ConversationBundleError::NotFound(message) => AppError::NotFound(message),
            ConversationBundleError::BadRequest(message) => AppError::BadRequest(message),
            ConversationBundleError::Conflict(message) => AppError::Conflict(message),
            ConversationBundleError::Internal(message) => AppError::Internal(message),
        }
    }
}

pub async fn export_conversation_bundle(
    pool: &SqlitePool,
    conversation_id: Uuid,
    destination_path: Option<&str>,
) -> Result<ConversationExportResult, AppError> {
    Ok(export_core(
        pool,
        conversation_id,
        destination_path,
        env!("CARGO_PKG_VERSION"),
    )
    .await?)
}

pub async fn import_conversation_bundle(
    pool: &SqlitePool,
    bundle: agents::conversation::ConversationBundlePayload,
    workspace_id: Uuid,
) -> Result<ConversationImportResult, AppError> {
    Ok(import_core(pool, bundle, workspace_id).await?)
}
