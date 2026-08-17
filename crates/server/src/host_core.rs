use std::sync::Arc;

use application::{
    ApplicationCore, ApplicationError, CancelConversationTurn, ConversationExecutionPort,
    ConversationSessionExecutionPort, RespondConversationPermission, RespondConversationQuestion,
    SqliteConversationRepository, StartConversationTurn, WorkflowStoreExecutionPort,
};
use async_trait::async_trait;
use conversations::ConversationContext;
use plugins::PluginControlPlane;
use sqlx::SqlitePool;

use crate::{
    ServerApplicationDomains, ServerDomainDependencies,
    automation_runtime::HeadlessAutomationRuntime,
};

struct PluginAwareConversationExecution {
    inner: ConversationSessionExecutionPort,
    plugin_control_plane: Arc<PluginControlPlane>,
}

#[async_trait]
impl ConversationExecutionPort for PluginAwareConversationExecution {
    async fn start_turn(
        &self,
        mut request: StartConversationTurn,
    ) -> Result<conversations::ConversationTurnSnapshot, ApplicationError> {
        let mut action_prompts = Vec::new();
        for invocation in &request.plugin_actions {
            let action = self
                .plugin_control_plane
                .resolve_action(&invocation.plugin_id, &invocation.action_id)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
            action_prompts.extend(action.prompt_blocks.into_iter().map(|block| match block {
                plugins::PromptBlock::Text { text } => text,
            }));
        }
        if !action_prompts.is_empty() {
            let mut prompt = Vec::with_capacity(action_prompts.len() + 1);
            if !request.text.trim().is_empty() {
                prompt.push(request.text);
            }
            prompt.extend(action_prompts);
            request.text = prompt.join("\n");
        }
        self.inner.start_turn(request).await
    }

    async fn respond_permission(
        &self,
        request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        self.inner.respond_permission(request).await
    }

    async fn respond_question(
        &self,
        request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        self.inner.respond_question(request).await
    }

    async fn cancel_turn(&self, request: CancelConversationTurn) -> Result<(), ApplicationError> {
        self.inner.cancel_turn(request).await
    }

    async fn steer(
        &self,
        request: conversations::ConversationSteerInput,
    ) -> Result<conversations::ConversationSteeringReceipt, ApplicationError> {
        self.inner.steer(request).await
    }

    async fn submit_input(
        &self,
        request: conversations::SubmitConversationInput,
    ) -> Result<conversations::ConversationInputSubmission, ApplicationError> {
        for invocation in &request.payload.plugin_actions {
            self.plugin_control_plane
                .resolve_action(&invocation.plugin_id, &invocation.action_id)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        }
        self.inner.submit_input(request).await
    }

    async fn list_inputs(
        &self,
        conversation_id: uuid::Uuid,
    ) -> Result<Vec<conversations::ConversationInputView>, ApplicationError> {
        self.inner.list_inputs(conversation_id).await
    }

    async fn update_input(
        &self,
        request: conversations::UpdateConversationInput,
    ) -> Result<conversations::ConversationInputView, ApplicationError> {
        self.inner.update_input(request).await
    }

    async fn reorder_input(
        &self,
        request: conversations::ReorderConversationInput,
    ) -> Result<conversations::ConversationInputView, ApplicationError> {
        self.inner.reorder_input(request).await
    }

    async fn cancel_input(
        &self,
        request: conversations::CancelConversationInput,
    ) -> Result<conversations::ConversationInputView, ApplicationError> {
        self.inner.cancel_input(request).await
    }

    async fn list_relations(
        &self,
        conversation_id: uuid::Uuid,
    ) -> Result<Vec<conversations::ConversationRelationView>, ApplicationError> {
        self.inner.list_relations(conversation_id).await
    }
}

/// Shared Application Core used by `vibex-server` and the desktop remote listener.
pub fn host_application_core(
    pool: SqlitePool,
    conversations: ConversationContext,
    plugin_control_plane: Arc<PluginControlPlane>,
    preview_host: Arc<dyn plugins::PluginPreviewHost>,
    capability_broker: Arc<plugins::HostCapabilityBroker>,
    app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    preview_proxy: crate::PreviewProxyRegistry,
    automation: HeadlessAutomationRuntime,
    owns_automation_engine: bool,
    deployment: Arc<local_deployment::LocalDeployment>,
    runtime_root: std::path::PathBuf,
    worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
) -> ApplicationCore<SqliteConversationRepository> {
    let domains = Arc::new(ServerApplicationDomains::new(ServerDomainDependencies {
        pool: pool.clone(),
        plugin_control_plane: plugin_control_plane.clone(),
        preview_host,
        capability_broker,
        app_surfaces,
        preview_proxy,
        automation,
        owns_automation_engine,
        conversations: conversations.clone(),
        deployment,
        runtime_root,
        worker_runtime,
    }));
    let execution = Arc::new(PluginAwareConversationExecution {
        inner: ConversationSessionExecutionPort::new(conversations.clone()),
        plugin_control_plane,
    });
    let workflows = Arc::new(WorkflowStoreExecutionPort::with_conversations(
        pool.clone(),
        conversations,
    ));
    ApplicationCore::with_all_ports(
        SqliteConversationRepository::new(pool),
        execution,
        domains,
        workflows,
    )
}
