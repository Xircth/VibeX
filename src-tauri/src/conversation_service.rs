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
use db::models::{repo::Repo, workspace::Workspace};
use sqlx::SqlitePool;

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
}

#[async_trait::async_trait]
impl conversations::ConversationHost for AppConversationHost {
    fn resolve_working_dir(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
    ) -> Option<String> {
        conversations::resolve_workspace_agent_working_dir(workspace, container_ref, repos)
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
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError> {
        conversations::workspace_prompt_blocks(working_dir, text, images).await
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
}
