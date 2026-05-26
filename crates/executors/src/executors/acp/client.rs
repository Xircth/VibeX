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

fn selected_permission_outcome_for_kind(
    options: &[acp::schema::PermissionOption],
    kind: PermissionOptionKind,
) -> Option<RequestPermissionOutcome> {
    options
        .iter()
        .find(|option| option.kind == kind)
        .map(|option| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                option.option_id.clone(),
            ))
        })
}

fn auto_permission_outcome(options: &[acp::schema::PermissionOption]) -> RequestPermissionOutcome {
    selected_permission_outcome_for_kind(options, PermissionOptionKind::AllowAlways)
        .or_else(|| selected_permission_outcome_for_kind(options, PermissionOptionKind::AllowOnce))
        .or_else(|| {
            options.first().map(|option| {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    option.option_id.clone(),
                ))
            })
        })
        .unwrap_or(RequestPermissionOutcome::Cancelled)
}

fn approval_status_permission_outcome(
    status: &ApprovalStatus,
    options: &[acp::schema::PermissionOption],
) -> Option<RequestPermissionOutcome> {
    match status {
        ApprovalStatus::Approved => {
            selected_permission_outcome_for_kind(options, PermissionOptionKind::AllowOnce)
        }
        ApprovalStatus::Denied { .. } => Some(
            selected_permission_outcome_for_kind(options, PermissionOptionKind::RejectOnce)
                .unwrap_or(RequestPermissionOutcome::Cancelled),
        ),
        ApprovalStatus::TimedOut | ApprovalStatus::Pending => {
            Some(RequestPermissionOutcome::Cancelled)
        }
    }
}

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
            let outcome = auto_permission_outcome(&args.options);
            if let RequestPermissionOutcome::Selected(selected) = &outcome {
                debug!(
                    "Auto-approving permission with option: {}",
                    selected.option_id
                );
            } else {
                warn!("No permission options available, cancelling");
            }

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

        if let ApprovalStatus::Denied { reason } = &status {
            if let Some(feedback) = reason.as_ref() {
                self.enqueue_feedback(feedback.clone()).await;
            }
            if selected_permission_outcome_for_kind(&args.options, PermissionOptionKind::RejectOnce)
                .is_none()
            {
                warn!("No permission options for denial, cancelling");
            }
        }
        if matches!(status, ApprovalStatus::TimedOut) {
            warn!("Approval timed out");
        }
        if matches!(status, ApprovalStatus::Pending) {
            warn!("Approval resolved to Pending");
        }

        let Some(outcome) = approval_status_permission_outcome(&status, &args.options) else {
            tracing::error!("No suitable approval option found, cancelling");
            return Err(acp::Error::invalid_request());
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

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::{
        PermissionOption, PermissionOptionKind, RequestPermissionOutcome,
    };
    use workspace_utils::approvals::ApprovalStatus;

    use super::{approval_status_permission_outcome, auto_permission_outcome};

    fn option(id: &'static str, kind: PermissionOptionKind) -> PermissionOption {
        PermissionOption::new(id, id, kind)
    }

    fn selected_id(outcome: &RequestPermissionOutcome) -> Option<String> {
        match outcome {
            RequestPermissionOutcome::Selected(selected) => Some(selected.option_id.0.to_string()),
            RequestPermissionOutcome::Cancelled => None,
            _ => None,
        }
    }

    #[test]
    fn auto_permission_prefers_allow_always_then_allow_once() {
        let options = vec![
            option("allow-once", PermissionOptionKind::AllowOnce),
            option("allow-always", PermissionOptionKind::AllowAlways),
        ];

        let outcome = auto_permission_outcome(&options);

        assert_eq!(selected_id(&outcome).as_deref(), Some("allow-always"));
    }

    #[test]
    fn auto_permission_falls_back_to_first_option_or_cancelled() {
        let options = vec![option("reject-once", PermissionOptionKind::RejectOnce)];

        let outcome = auto_permission_outcome(&options);

        assert_eq!(selected_id(&outcome).as_deref(), Some("reject-once"));
        assert!(matches!(
            auto_permission_outcome(&[]),
            RequestPermissionOutcome::Cancelled
        ));
    }

    #[test]
    fn approval_status_permission_outcome_maps_approved_and_denied_options() {
        let options = vec![
            option("allow-once", PermissionOptionKind::AllowOnce),
            option("reject-once", PermissionOptionKind::RejectOnce),
        ];

        let approved = approval_status_permission_outcome(&ApprovalStatus::Approved, &options)
            .expect("approved outcome");
        let denied =
            approval_status_permission_outcome(&ApprovalStatus::Denied { reason: None }, &options)
                .expect("denied outcome");

        assert_eq!(selected_id(&approved).as_deref(), Some("allow-once"));
        assert_eq!(selected_id(&denied).as_deref(), Some("reject-once"));
    }

    #[test]
    fn approval_status_permission_outcome_handles_missing_and_cancelled_states() {
        let reject_only = vec![option("reject-once", PermissionOptionKind::RejectOnce)];

        assert!(
            approval_status_permission_outcome(&ApprovalStatus::Approved, &reject_only).is_none()
        );
        assert!(matches!(
            approval_status_permission_outcome(&ApprovalStatus::TimedOut, &reject_only),
            Some(RequestPermissionOutcome::Cancelled)
        ));
        assert!(matches!(
            approval_status_permission_outcome(&ApprovalStatus::Pending, &reject_only),
            Some(RequestPermissionOutcome::Cancelled)
        ));
    }
}
