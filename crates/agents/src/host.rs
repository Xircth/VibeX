use async_trait::async_trait;
use thiserror::Error;

use crate::{
    filesystem::{AgentFileReadRequest, AgentFileWriteRequest},
    ids::{AgentPermissionId, AgentTerminalId},
    permissions::{AgentPermissionRequest, AgentPermissionResponse},
    terminal::{AgentTerminalCreateRequest, AgentTerminalExit, AgentTerminalOutputSnapshot},
};

#[derive(Debug, Error)]
pub enum HostRequestError {
    #[error("host request is unsupported: {0}")]
    Unsupported(&'static str),
    #[error("host request failed: {0}")]
    Failed(String),
}

#[async_trait]
pub trait AgentHost: Send + Sync + 'static {
    async fn request_permission(
        &self,
        request: AgentPermissionRequest,
    ) -> Result<AgentPermissionResponse, HostRequestError>;

    async fn create_terminal(
        &self,
        request: AgentTerminalCreateRequest,
    ) -> Result<AgentTerminalId, HostRequestError>;

    async fn terminal_output(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Result<AgentTerminalOutputSnapshot, HostRequestError>;

    async fn wait_terminal_exit(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Result<Option<AgentTerminalExit>, HostRequestError>;

    async fn kill_terminal(&self, terminal_id: AgentTerminalId) -> Result<(), HostRequestError>;

    async fn read_text_file(
        &self,
        request: AgentFileReadRequest,
    ) -> Result<String, HostRequestError>;

    async fn write_text_file(&self, request: AgentFileWriteRequest)
    -> Result<(), HostRequestError>;

    async fn respond_permission(
        &self,
        permission_id: AgentPermissionId,
        response: AgentPermissionResponse,
    ) -> Result<(), HostRequestError>;
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::{
        AgentPermissionOption, AgentPermissionRequest, AgentPermissionResponse, AgentSessionId,
        AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalExit,
        AgentTerminalOutputSnapshot,
    };

    #[derive(Default)]
    struct RecordingHost {
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl RecordingHost {
        fn record(&self, call: &'static str) {
            self.calls.lock().unwrap().push(call);
        }
    }

    #[async_trait]
    impl AgentHost for RecordingHost {
        async fn request_permission(
            &self,
            request: AgentPermissionRequest,
        ) -> Result<AgentPermissionResponse, HostRequestError> {
            self.record("permission");
            Ok(AgentPermissionResponse::Selected {
                option_id: request.options[0].id.clone(),
            })
        }

        async fn create_terminal(
            &self,
            request: AgentTerminalCreateRequest,
        ) -> Result<AgentTerminalId, HostRequestError> {
            self.record("terminal_create");
            assert_eq!(request.command, "pnpm");
            Ok(AgentTerminalId::new())
        }

        async fn terminal_output(
            &self,
            terminal_id: AgentTerminalId,
        ) -> Result<AgentTerminalOutputSnapshot, HostRequestError> {
            self.record("terminal_output");
            Ok(AgentTerminalOutputSnapshot {
                terminal_id,
                output: "ok".to_string(),
                truncated: false,
                exit: Some(AgentTerminalExit::Code { code: 0 }),
            })
        }

        async fn wait_terminal_exit(
            &self,
            _terminal_id: AgentTerminalId,
        ) -> Result<Option<AgentTerminalExit>, HostRequestError> {
            self.record("terminal_wait");
            Ok(Some(AgentTerminalExit::Code { code: 0 }))
        }

        async fn kill_terminal(
            &self,
            _terminal_id: AgentTerminalId,
        ) -> Result<(), HostRequestError> {
            self.record("terminal_kill");
            Ok(())
        }

        async fn read_text_file(
            &self,
            request: AgentFileReadRequest,
        ) -> Result<String, HostRequestError> {
            self.record("file_read");
            Ok(format!("read:{}", request.path))
        }

        async fn write_text_file(
            &self,
            request: AgentFileWriteRequest,
        ) -> Result<(), HostRequestError> {
            self.record("file_write");
            assert_eq!(request.content, "content");
            Ok(())
        }

        async fn respond_permission(
            &self,
            _permission_id: AgentPermissionId,
            response: AgentPermissionResponse,
        ) -> Result<(), HostRequestError> {
            self.record("permission_response");
            assert!(matches!(response, AgentPermissionResponse::Cancelled));
            Ok(())
        }
    }

    #[tokio::test]
    async fn host_requests_route_permission_terminal_and_files() {
        let host = RecordingHost::default();
        let session_id = AgentSessionId::new();
        let permission = host
            .request_permission(AgentPermissionRequest {
                id: AgentPermissionId::new(),
                session_id,
                title: "Run command".to_string(),
                details: None,
                options: vec![AgentPermissionOption {
                    id: "allow".to_string(),
                    label: "Allow".to_string(),
                    description: None,
                }],
            })
            .await
            .unwrap();
        assert_eq!(
            permission,
            AgentPermissionResponse::Selected {
                option_id: "allow".to_string()
            }
        );

        let terminal_id = host
            .create_terminal(AgentTerminalCreateRequest {
                session_id,
                command: "pnpm".to_string(),
                args: vec!["test".to_string()],
                cwd: None,
                env: vec![AgentTerminalEnvVar {
                    name: "CI".to_string(),
                    value: "1".to_string(),
                }],
                output_byte_limit: None,
            })
            .await
            .unwrap();
        assert_eq!(
            host.terminal_output(terminal_id).await.unwrap().output,
            "ok"
        );
        assert_eq!(
            host.wait_terminal_exit(terminal_id).await.unwrap(),
            Some(AgentTerminalExit::Code { code: 0 })
        );
        host.kill_terminal(terminal_id).await.unwrap();
        assert_eq!(
            host.read_text_file(AgentFileReadRequest {
                session_id,
                path: "src/lib.rs".to_string(),
            })
            .await
            .unwrap(),
            "read:src/lib.rs"
        );
        host.write_text_file(AgentFileWriteRequest {
            session_id,
            path: "src/lib.rs".to_string(),
            content: "content".to_string(),
        })
        .await
        .unwrap();
        host.respond_permission(AgentPermissionId::new(), AgentPermissionResponse::Cancelled)
            .await
            .unwrap();

        assert_eq!(
            host.calls.lock().unwrap().as_slice(),
            [
                "permission",
                "terminal_create",
                "terminal_output",
                "terminal_wait",
                "terminal_kill",
                "file_read",
                "file_write",
                "permission_response"
            ]
        );
    }

    #[test]
    fn host_requests_report_typed_unsupported_errors() {
        let error = HostRequestError::Unsupported("elicitation");
        assert_eq!(
            error.to_string(),
            "host request is unsupported: elicitation"
        );
    }
}
