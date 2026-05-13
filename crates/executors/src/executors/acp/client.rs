use std::sync::Arc;

use acp::schema::{
    AgentNotification, AgentRequest, ClientResponse, CreateTerminalResponse, KillTerminalRequest,
    KillTerminalResponse, PermissionOptionKind, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, SessionUpdate, TerminalId, TerminalOutputResponse,
    WaitForTerminalExitResponse,
};
use agent_client_protocol::{self as acp};
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use workspace_utils::approvals::ApprovalStatus;

use crate::{
    approvals::{ExecutorApprovalError, ExecutorApprovalService},
    executors::acp::{AcpEvent, ApprovalResponse, acp_terminal_registry},
};

/// ACP client that handles agent-client protocol communication
#[derive(Clone)]
pub struct AcpClient {
    event_tx: mpsc::UnboundedSender<AcpEvent>,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    feedback_queue: Arc<Mutex<Vec<String>>>,
    cancel: CancellationToken,
}

impl AcpClient {
    /// Create a new ACP client
    pub fn new(
        event_tx: mpsc::UnboundedSender<AcpEvent>,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            event_tx,
            approvals,
            feedback_queue: Arc::new(Mutex::new(Vec::new())),
            cancel,
        }
    }

    pub fn record_user_prompt_event(&self, prompt: &str) {
        self.send_event(AcpEvent::User(prompt.to_string()));
    }

    /// Send an event to the event channel
    fn send_event(&self, event: AcpEvent) {
        if let Err(e) = self.event_tx.send(event) {
            warn!("Failed to send ACP event: {}", e);
        }
    }

    /// Queue a user feedback message to be sent after a denial.
    pub async fn enqueue_feedback(&self, message: String) {
        let trimmed = message.trim().to_string();
        if !trimmed.is_empty() {
            let mut q = self.feedback_queue.lock().await;
            q.push(trimmed);
        }
    }

    /// Drain and return queued feedback messages.
    pub async fn drain_feedback(&self) -> Vec<String> {
        let mut q = self.feedback_queue.lock().await;
        q.drain(..).collect()
    }
}

impl AcpClient {
    fn parse_terminal_id(id: &TerminalId) -> Result<uuid::Uuid, acp::Error> {
        uuid::Uuid::parse_str(id.0.as_ref()).map_err(|_| acp::Error::invalid_params())
    }

    pub async fn handle_agent_request(
        &self,
        request: AgentRequest,
    ) -> Result<ClientResponse, acp::Error> {
        match request {
            AgentRequest::RequestPermissionRequest(args) => Ok(
                ClientResponse::RequestPermissionResponse(self.request_permission(args).await?),
            ),
            AgentRequest::WriteTextFileRequest(_) => Err(acp::Error::method_not_found()),
            AgentRequest::ReadTextFileRequest(_) => Err(acp::Error::method_not_found()),
            AgentRequest::CreateTerminalRequest(args) => Ok(
                ClientResponse::CreateTerminalResponse(self.create_terminal(args).await?),
            ),
            AgentRequest::TerminalOutputRequest(args) => {
                let terminal_id = Self::parse_terminal_id(&args.terminal_id)?;

                let snapshot = acp_terminal_registry()
                    .snapshot_output(terminal_id)
                    .await
                    .ok_or_else(acp::Error::invalid_params)?;

                let mut response = TerminalOutputResponse::new(snapshot.output, snapshot.truncated);
                if let Some(exit_status) = snapshot.exit_status {
                    response = response.exit_status(exit_status);
                }
                Ok(ClientResponse::TerminalOutputResponse(response))
            }
            AgentRequest::ReleaseTerminalRequest(args) => {
                let terminal_id = Self::parse_terminal_id(&args.terminal_id)?;

                if !acp_terminal_registry().release_terminal(terminal_id).await {
                    return Err(acp::Error::invalid_params());
                }

                Ok(ClientResponse::ReleaseTerminalResponse(
                    ReleaseTerminalResponse::new(),
                ))
            }
            AgentRequest::WaitForTerminalExitRequest(args) => {
                let terminal_id = Self::parse_terminal_id(&args.terminal_id)?;

                let exit_status = acp_terminal_registry()
                    .wait_for_exit(terminal_id)
                    .await
                    .ok_or_else(acp::Error::invalid_params)?;

                Ok(ClientResponse::WaitForTerminalExitResponse(
                    WaitForTerminalExitResponse::new(exit_status),
                ))
            }
            AgentRequest::KillTerminalRequest(args) => Ok(ClientResponse::KillTerminalResponse(
                self.kill_terminal(args).await?,
            )),
            AgentRequest::ExtMethodRequest(_) => Err(acp::Error::method_not_found()),
            _ => Err(acp::Error::method_not_found()),
        }
    }

    pub async fn handle_agent_notification(
        &self,
        notification: AgentNotification,
    ) -> Result<(), acp::Error> {
        match notification {
            AgentNotification::SessionNotification(args) => self.session_notification(args).await,
            AgentNotification::ExtNotification(_) => Ok(()),
            _ => Ok(()),
        }
    }

    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, acp::Error> {
        self.send_event(AcpEvent::RequestPermission(args.clone()));

        if self.approvals.is_none() {
            // Auto-approve with best available option when no approval service is configured
            let chosen_option = args
                .options
                .iter()
                .find(|o| matches!(o.kind, PermissionOptionKind::AllowAlways))
                .or_else(|| {
                    args.options
                        .iter()
                        .find(|o| matches!(o.kind, PermissionOptionKind::AllowOnce))
                })
                .or_else(|| args.options.first());

            let outcome = if let Some(opt) = chosen_option {
                debug!("Auto-approving permission with option: {}", opt.option_id);
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    opt.option_id.clone(),
                ))
            } else {
                warn!("No permission options available, cancelling");
                RequestPermissionOutcome::Cancelled
            };

            return Ok(RequestPermissionResponse::new(outcome));
        }

        let tool_call_id = args.tool_call.tool_call_id.0.to_string();
        let approval_service = self
            .approvals
            .as_ref()
            .ok_or(ExecutorApprovalError::ServiceUnavailable)
            .map_err(|_| acp::Error::invalid_request())?;

        let status = match approval_service
            .request_tool_approval(
                args.tool_call.fields.title.as_deref().unwrap_or("tool"),
                serde_json::json!({ "tool_call": args.tool_call }),
                &tool_call_id,
                self.cancel.clone(),
            )
            .await
        {
            Ok(s) => s,
            Err(ExecutorApprovalError::Cancelled) => {
                debug!("ACP approval cancelled for tool_call_id={}", tool_call_id);
                return Ok(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ));
            }
            Err(err) => {
                tracing::error!(
                    "ACP approval failed for tool_call_id={}: {err}",
                    tool_call_id
                );
                return Err(acp::Error::internal_error());
            }
        };

        // Map our ApprovalStatus to ACP outcome
        let outcome = match &status {
            ApprovalStatus::Approved => {
                let chosen = args
                    .options
                    .iter()
                    .find(|o| matches!(o.kind, PermissionOptionKind::AllowOnce));
                if let Some(opt) = chosen {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        opt.option_id.clone(),
                    ))
                } else {
                    tracing::error!("No suitable approval option found, cancelling");
                    return Err(acp::Error::invalid_request());
                }
            }
            ApprovalStatus::Denied { reason } => {
                // If user provided a reason, queue it to send after denial
                if let Some(feedback) = reason.as_ref() {
                    self.enqueue_feedback(feedback.clone()).await;
                }
                let chosen = args
                    .options
                    .iter()
                    .find(|o| matches!(o.kind, PermissionOptionKind::RejectOnce));
                if let Some(opt) = chosen {
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        opt.option_id.clone(),
                    ))
                } else {
                    warn!("No permission options for denial, cancelling");
                    RequestPermissionOutcome::Cancelled
                }
            }
            ApprovalStatus::TimedOut => {
                warn!("Approval timed out");
                RequestPermissionOutcome::Cancelled
            }
            ApprovalStatus::Pending => {
                // This should not occur after waiter resolves
                warn!("Approval resolved to Pending");
                RequestPermissionOutcome::Cancelled
            }
        };

        self.send_event(AcpEvent::ApprovalResponse(ApprovalResponse {
            tool_call_id: tool_call_id.clone(),
            status: status.clone(),
        }));

        Ok(RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(&self, args: SessionNotification) -> Result<(), acp::Error> {
        // Convert to typed events
        let event = match args.update {
            SessionUpdate::AgentMessageChunk(chunk) => Some(AcpEvent::Message(chunk.content)),
            SessionUpdate::AgentThoughtChunk(chunk) => Some(AcpEvent::Thought(chunk.content)),
            SessionUpdate::ToolCall(tc) => Some(AcpEvent::ToolCall(tc)),
            SessionUpdate::ToolCallUpdate(update) => Some(AcpEvent::ToolUpdate(update)),
            SessionUpdate::Plan(plan) => Some(AcpEvent::Plan(plan)),
            SessionUpdate::UsageUpdate(update) => Some(AcpEvent::Usage {
                used: update.used,
                size: update.size,
            }),
            _ => Some(AcpEvent::Other(args)),
        };

        if let Some(event) = event {
            self.send_event(event);
        }

        Ok(())
    }

    async fn create_terminal(
        &self,
        args: acp::schema::CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, acp::Error> {
        let terminal_id = acp_terminal_registry()
            .create_terminal(&args)
            .await
            .map_err(|err| {
                tracing::error!("Failed to create ACP terminal: {err}");
                acp::Error::internal_error()
            })?;

        Ok(CreateTerminalResponse::new(TerminalId::new(
            terminal_id.to_string(),
        )))
    }

    async fn kill_terminal(
        &self,
        args: KillTerminalRequest,
    ) -> Result<KillTerminalResponse, acp::Error> {
        let terminal_id = Self::parse_terminal_id(&args.terminal_id)?;

        if !acp_terminal_registry().kill_terminal(terminal_id).await {
            return Err(acp::Error::invalid_params());
        }

        Ok(KillTerminalResponse::new())
    }
}
