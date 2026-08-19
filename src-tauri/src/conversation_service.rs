//! Shell wiring for the event-sourced conversation core.
//!
//! The turn-lifecycle orchestration lives in `crates/conversations`
//! (`ConversationSessionService`), decoupled from `AppState` via
//! [`conversations::ConversationHost`] + [`conversations::ConversationContext`]. This
//! module re-exports the core types so existing `crate::conversation_service::X`
//! referrers keep working, and provides [`AppConversationHost`] — the src-tauri-coupled
//! host implementation (workspace path resolution, prompt-block building, agent launch
//! settings) injected into the core.

use std::sync::Arc;

use agents::AgentContentBlock;
pub use conversations::{
    ConversationContext, ConversationRuntimeState, ConversationServiceError,
    ConversationSessionService, ConversationStartTurnInput, ConversationTurnSnapshot,
    finalize_checkpoint_file_changes,
};
use db::models::{conversation_event::ConversationEventRecord, repo::Repo, workspace::Workspace};
use sqlx::SqlitePool;
use tauri::AppHandle;

fn app_err_to_service(error: crate::error::AppError) -> ConversationServiceError {
    match error {
        crate::error::AppError::NotFound(message) => ConversationServiceError::NotFound(message),
        crate::error::AppError::BadRequest(message) => {
            ConversationServiceError::BadRequest(message)
        }
        crate::error::AppError::Conflict(message) => ConversationServiceError::Conflict(message),
        crate::error::AppError::Internal(message) => ConversationServiceError::Internal(message),
    }
}

/// src-tauri-coupled host operations for the conversation turn lifecycle. Implements
/// [`conversations::ConversationHost`] so the orchestration core stays decoupled from
/// `AppState` and the command layer.
pub struct AppConversationHost {
    pub deployment: Arc<dyn deployment::Deployment>,
    pub official_mcp: Arc<plugins::OfficialProductMcpGate>,
}

/// Desktop projection publisher injected at the conversation-core commit boundary.
/// Awaiting this publisher makes a committed user event visible before the core can
/// dispatch the causally-later Agent prompt.
pub struct AppConversationEventPublisher {
    pub app_handle: AppHandle,
    pub deployment: Arc<dyn deployment::Deployment>,
    pub row_projectors: crate::events::ConversationRowProjectors,
}

#[async_trait::async_trait]
impl conversations::ConversationEventPublisher for AppConversationEventPublisher {
    async fn publish(&self, record: &ConversationEventRecord) {
        crate::events::emit_conversation_row_ops_after(
            &self.app_handle,
            &self.row_projectors,
            &self.deployment.db().pool,
            record.conversation_id,
            record.sequence - 1,
        )
        .await;
    }
}

#[async_trait::async_trait]
impl conversations::ConversationHost for AppConversationHost {
    fn resolve_working_dir(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
    ) -> Option<String> {
        Some(conversations::resolve_absolute_workspace_agent_working_dir(
            workspace,
            container_ref,
            repos,
        ))
    }

    fn resolve_additional_directories(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
        working_dir: &str,
    ) -> Vec<std::path::PathBuf> {
        crate::workspace_paths::resolve_workspace_additional_directories(
            workspace,
            container_ref,
            repos,
            working_dir,
        )
    }

    async fn build_prompt_blocks(
        &self,
        working_dir: &str,
        text: String,
        images: &[String],
        file_refs: &[agents::ConversationFileRef],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        conversations::workspace_prompt_blocks(working_dir, text, images, file_refs).await
    }

    async fn launch_settings(
        &self,
        pool: &SqlitePool,
        agent_id: &agents::AgentId,
    ) -> Result<conversations::AgentRuntimeLaunchSettings, ConversationServiceError> {
        crate::commands::agents::agent_runtime_launch_settings_for_session_from_pool(pool, agent_id)
            .await
            .map_err(app_err_to_service)
    }

    fn product_mcp_server_names(&self) -> Vec<String> {
        self.official_mcp.product_mcp_names()
    }
}
