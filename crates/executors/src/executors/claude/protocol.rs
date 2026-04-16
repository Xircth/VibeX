use std::sync::Arc;

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use super::types::{CLIMessage, ControlRequestType, ControlResponseMessage, ControlResponseType};
use crate::{
    approvals::ExecutorApprovalError,
    executors::{
        ExecutorError,
        claude::{
            client::ClaudeAgentClient,
            types::{Message, PermissionMode, SDKControlRequest, SDKControlRequestType},
        },
    },
};

/// Handles bidirectional control protocol communication
#[derive(Clone)]
pub struct ProtocolPeer {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl ProtocolPeer {
    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(stdin)),
        };

        let reader_peer = peer.clone();
        tokio::spawn(async move {
            if let Err(e) = reader_peer.read_loop(stdout, client, cancel).await {
                tracing::error!("Protocol reader loop error: {}", e);
            }
        });

        peer
    }

    async fn read_loop(
        &self,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
    ) -> Result<(), ExecutorError> {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut interrupt_sent = false;

        loop {
            buffer.clear();
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !interrupt_sent => {
                    interrupt_sent = true;
                    tracing::info!("Cancellation received in read_loop, sending interrupt to Claude");
                    if let Err(e) = self.interrupt().await {
                        tracing::warn!("Failed to send interrupt to Claude: {e}");
                    }
                    // Continue the loop to read Claude's response (it should send a result)
                }
                line_result = reader.read_line(&mut buffer) => {
                    match line_result {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let line = buffer.trim();
                            if line.is_empty() {
                                continue;
                            }
                            client.log_message(line).await?;

                            // Parse and handle control messages
                            match serde_json::from_str::<CLIMessage>(line) {
                                Ok(CLIMessage::ControlRequest {
                                    request_id,
                                    request,
                                }) => {
                                    // Approval / hook callbacks can take a while. Handle them
                                    // off the read loop so stdout keeps draining and assistant
                                    // deltas still reach the renderer in real time.
                                    let peer = self.clone();
                                    let client = client.clone();
                                    tokio::spawn(async move {
                                        peer.handle_control_request(&client, request_id, request)
                                            .await;
                                    });
                                }
                                Ok(CLIMessage::Result(_)) => {
                                    break;
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            tracing::error!("Error reading stdout: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle_control_request(
        &self,
        client: &Arc<ClaudeAgentClient>,
        request_id: String,
        request: ControlRequestType,
    ) {
        match request {
            ControlRequestType::CanUseTool {
                tool_name,
                input,
                permission_suggestions,
                blocked_paths: _,
                tool_use_id,
            } => {
                match client
                    .on_can_use_tool(tool_name, input, permission_suggestions, tool_use_id)
                    .await
                {
                    Ok(result) => {
                        if let Err(e) = self
                            .send_hook_response(
                                request_id,
                                serde_json::to_value(&result).unwrap_or_default(),
                            )
                            .await
                        {
                            tracing::error!("Failed to send permission result: {e}");
                        }
                    }
                    Err(ExecutorError::ExecutorApprovalError(ExecutorApprovalError::Cancelled)) => {
                    }
                    Err(e) => {
                        tracing::error!("Error in on_can_use_tool: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
            ControlRequestType::HookCallback {
                callback_id,
                input,
                tool_use_id,
            } => {
                match client
                    .on_hook_callback(callback_id, input, tool_use_id)
                    .await
                {
                    Ok(hook_output) => {
                        if let Err(e) = self.send_hook_response(request_id, hook_output).await {
                            tracing::error!("Failed to send hook callback result: {e}");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error in on_hook_callback: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
        }
    }

    pub async fn send_hook_response(
        &self,
        request_id: String,
        hook_output: serde_json::Value,
    ) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
            request_id,
            response: Some(hook_output),
        }))
        .await
    }

    /// Send error response to CLI
    async fn send_error(&self, request_id: String, error: String) -> Result<(), ExecutorError> {
        self.send_json(&ControlResponseMessage::new(ControlResponseType::Error {
            request_id,
            error: Some(error),
        }))
        .await
    }

    async fn send_json<T: serde::Serialize>(&self, message: &T) -> Result<(), ExecutorError> {
        let json = serde_json::to_string(message)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn send_user_message(&self, content: String) -> Result<(), ExecutorError> {
        let message = Message::new_user(content);
        self.send_json(&message).await
    }

    pub async fn initialize(&self, hooks: Option<serde_json::Value>) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Initialize {
            hooks,
        }))
        .await
    }
    pub async fn interrupt(&self) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Interrupt {}))
            .await
    }

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(
            SDKControlRequestType::SetPermissionMode { mode },
        ))
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::{process::Stdio, sync::Arc, time::Duration};

    use async_trait::async_trait;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
        sync::Notify,
    };
    use tokio_util::sync::CancellationToken;
    use workspace_utils::{approvals::ApprovalStatus, process::group_spawn_no_window};

    use super::ProtocolPeer;
    use crate::{
        approvals::{ExecutorApprovalError, ExecutorApprovalService},
        env::RepoContext,
        executors::{claude::client::ClaudeAgentClient, codex::client::LogWriter},
        stdout_dup::create_stdout_pipe_writer,
    };

    struct BlockingApprovalService {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl ExecutorApprovalService for BlockingApprovalService {
        async fn request_tool_approval(
            &self,
            _tool_name: &str,
            _tool_input: serde_json::Value,
            _tool_call_id: &str,
            cancel: CancellationToken,
        ) -> Result<ApprovalStatus, ExecutorApprovalError> {
            self.started.notify_one();
            tokio::select! {
                _ = self.release.notified() => Ok(ApprovalStatus::Approved),
                _ = cancel.cancelled() => Err(ExecutorApprovalError::Cancelled),
            }
        }
    }

    #[tokio::test]
    async fn control_requests_do_not_block_following_stdout_messages() {
        #[cfg(unix)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("/bin/sh");
            cmd.args(["-c", "while :; do sleep 3600; done"]);
            cmd
        };

        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("powershell.exe");
            cmd.args([
                "-NoLogo",
                "-NonInteractive",
                "-Command",
                "[System.Threading.Thread]::Sleep([int]::MaxValue)",
            ]);
            cmd
        };

        cmd.kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = group_spawn_no_window(&mut cmd).expect("spawn test process");
        let mut stdout_writer: Box<dyn AsyncWrite + Send + Unpin> =
            Box::new(create_stdout_pipe_writer(&mut child).expect("create stdout pipe"));
        let stdin = child.inner().stdin.take().expect("stdin");
        let stdout = child.inner().stdout.take().expect("stdout");
        let (log_reader, log_writer_stream) = tokio::io::duplex(4096);
        let log_writer = LogWriter::new(log_writer_stream);
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let approvals = Arc::new(BlockingApprovalService {
            started: started.clone(),
            release: release.clone(),
        });
        let cancel = CancellationToken::new();
        let client = ClaudeAgentClient::new(
            log_writer,
            Some(approvals),
            RepoContext::default(),
            String::new(),
            cancel.clone(),
        );

        let _peer = ProtocolPeer::spawn(stdin, stdout, client, cancel.clone());
        let mut reader = BufReader::new(log_reader).lines();

        stdout_writer
            .write_all(
                br#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"echo hi"},"tool_use_id":"tool-1"}}"#,
            )
            .await
            .expect("write control request");
        stdout_writer.write_all(b"\n").await.expect("newline");

        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .expect("approval request should start");

        stdout_writer
            .write_all(br#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"streaming"}]}}"#)
            .await
            .expect("write assistant message");
        stdout_writer.write_all(b"\n").await.expect("newline");

        let first = tokio::time::timeout(Duration::from_secs(1), reader.next_line())
            .await
            .expect("first log line")
            .expect("first line")
            .expect("control request line");
        let second = tokio::time::timeout(Duration::from_secs(1), reader.next_line())
            .await
            .expect("second log line")
            .expect("second line")
            .expect("assistant line");

        assert!(first.contains(r#""type":"control_request""#));
        assert!(second.contains(r#""type":"assistant""#));

        release.notify_waiters();
        cancel.cancel();
    }
}
