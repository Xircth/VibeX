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
    ConversationServiceError, ConversationSessionService, ConversationStartTurnInput,
};
use conversations::{ConversationLivePipeline, ConversationRowProjectors};
use db::models::{conversation_event::ConversationEventRecord, repo::Repo, workspace::Workspace};
use sqlx::SqlitePool;

/// src-tauri-coupled host operations for the conversation turn lifecycle. Implements
/// [`conversations::ConversationHost`] so the orchestration core stays decoupled from
/// `AppState` and the command layer.
pub struct AppConversationHost {
    pub official_mcp: Arc<plugins::OfficialMcpRuntime>,
}

/// Desktop projection publisher injected at the conversation-core commit boundary.
/// Awaiting this publisher makes a committed user event visible before the core can
/// dispatch the causally-later Agent prompt.
///
/// The fold/lock/batch work is the shared [`ConversationLivePipeline`]; this type only
/// pins it to the desktop transport ([`crate::events::TauriEventSink`]) and the app's
/// write connection.
pub struct AppConversationEventPublisher {
    pipeline: ConversationLivePipeline,
}

impl AppConversationEventPublisher {
    pub fn new(
        deployment: Arc<dyn deployment::Deployment>,
        row_projectors: ConversationRowProjectors,
    ) -> Self {
        Self {
            pipeline: ConversationLivePipeline::new(
                deployment.db().pool.clone(),
                row_projectors,
                Arc::new(crate::events::TauriEventSink),
            ),
        }
    }
}

#[async_trait::async_trait]
impl conversations::ConversationEventPublisher for AppConversationEventPublisher {
    async fn publish(&self, record: &ConversationEventRecord) {
        self.pipeline.publish(record).await;
    }

    async fn publish_unpersisted(&self, record: &ConversationEventRecord) {
        self.pipeline.publish_unpersisted(record).await;
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
        conversations::resolve_agent_runtime_launch_settings(pool, agent_id).await
    }

    fn product_mcp_server_names(&self) -> Vec<String> {
        self.official_mcp.product_mcp_names()
    }
}
