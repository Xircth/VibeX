use super::*;

pub(in crate::manager) const DEFAULT_HANDSHAKE_TIMEOUT_SECS: u64 = 60;
pub(in crate::manager) const DEFAULT_SESSION_PREP_TIMEOUT_SECS: u64 = 60;
pub(in crate::manager) const DEFAULT_PROMPT_IDLE_TIMEOUT_SECS: u64 = 600;
pub(in crate::manager) const HANDSHAKE_TIMEOUT_ENV: &str = "VIBEX_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS";
pub(in crate::manager) const SESSION_PREP_TIMEOUT_ENV: &str = "VIBEX_ACP_SESSION_PREP_TIMEOUT_SECS";
pub(in crate::manager) const FULL_GATE_FIXTURE_PROMPT: &str = "__vibex_agent_full_gate_fixture__";
// Prompt idle watchdog. Unset uses `DEFAULT_PROMPT_IDLE_TIMEOUT_SECS` so a
// silent in-flight turn cannot sit on "生成中" forever. `0` disables it.
// Every inbound ACP request/notification refreshes the clock, and permission,
// elicitation, and live-terminal waits are exempt.
pub(in crate::manager) const PROMPT_IDLE_TIMEOUT_ENV: &str = "VIBEX_PROMPT_IDLE_TIMEOUT_SECS";

// ACP cancellation is complete when the agent answers the outstanding
// `session/prompt` (normally with `StopReason::Cancelled`), not when the
// `session/cancel` notification is written. Returning at notification time leaves
// the agent generating into a Turn that the Host already settled, and its later
// `session/update`s land on whatever Turn comes next. Wait for the acknowledgement,
// but bounded — an agent that never answers must not wedge the connection.
pub(in crate::manager) const CANCEL_ACKNOWLEDGEMENT_TIMEOUT: Duration = Duration::from_secs(10);
// `run_prompt` owns `cmd_rx` for the whole turn. A Disconnect sent while that
// future is parked on cancel-ack (or a replaced/wedged sender) would otherwise
// wait forever, and 继续 after stop would hang on "会话加载异常，正在连接…".
pub(in crate::manager) const DISCONNECT_JOIN_TIMEOUT: Duration = Duration::from_secs(8);
pub(in crate::manager) const AUTH_STATUS_TIMEOUT_SECS: u64 = 5;
pub(in crate::manager) const MAX_CONTENT_META_BYTES: usize = 16 * 1024;
pub(in crate::manager) const CONNECTION_CLOSED_TURN_MESSAGE: &str =
    "Agent connection closed before the turn completed.";
/// Stdout EOF is only a death hint. Codeg never kills a Prompting connection on
/// a pipe stall; wait this long for the child or protocol loop to settle first.
pub(in crate::manager) const STDOUT_EOF_EXIT_GRACE: Duration = Duration::from_millis(750);
pub(in crate::manager) const CHILD_EXIT_DRAIN_GRACE: Duration = Duration::from_millis(50);

/// How the ACP child/stdio watch ended relative to the protocol loop.
#[derive(Debug)]
pub(in crate::manager) enum AcpProcessStop<T, E> {
    Connection(Result<T, E>),
    ChildExited(std::io::Result<ExitStatus>),
    StdoutClosed,
}

/// Drive the ACP connection until it returns, the child exits, or stdout EOF.
///
/// `agent-client-protocol` treats a clean stdin/stdout EOF as success and does
/// not fail outstanding `session/prompt` futures. When the child has actually
/// exited, that death must win over a quiet `Ok(())` or the turn stays at
/// "生成中". Stdout EOF alone is not proof of death — a duplex write error or
/// a brief pipe stall would otherwise kill a still-Prompting agent, which is
/// the opposite of Codeg (Codeg never kills a Prompting connection).
pub(in crate::manager) async fn wait_for_acp_or_process_death<T, E>(
    acp: impl Future<Output = Result<T, E>>,
    child_exited: impl Future<Output = std::io::Result<ExitStatus>>,
    stdout_closed: impl Future<Output = ()>,
) -> AcpProcessStop<T, E> {
    tokio::pin!(acp);
    tokio::pin!(child_exited);
    tokio::pin!(stdout_closed);
    tokio::select! {
        biased;
        status = &mut child_exited => {
            tokio::select! {
                biased;
                result = &mut acp => AcpProcessStop::Connection(result),
                () = async {
                    let _ = tokio::time::timeout(CHILD_EXIT_DRAIN_GRACE, &mut stdout_closed).await;
                    tokio::task::yield_now().await;
                } => {
                    tokio::select! {
                        biased;
                        result = &mut acp => AcpProcessStop::Connection(result),
                        () = tokio::time::sleep(CHILD_EXIT_DRAIN_GRACE) => {
                            AcpProcessStop::ChildExited(status)
                        }
                    }
                }
            }
        }
        result = &mut acp => AcpProcessStop::Connection(result),
        () = &mut stdout_closed => {
            tokio::select! {
                biased;
                result = &mut acp => AcpProcessStop::Connection(result),
                status = &mut child_exited => {
                    tokio::select! {
                        biased;
                        result = &mut acp => AcpProcessStop::Connection(result),
                        () = tokio::time::sleep(CHILD_EXIT_DRAIN_GRACE) => {
                            AcpProcessStop::ChildExited(status)
                        }
                    }
                }
                () = tokio::time::sleep(STDOUT_EOF_EXIT_GRACE) => {
                    AcpProcessStop::StdoutClosed
                }
            }
        }
    }
}

/// Map a connection/process stop onto a host error.
///
/// A clean `Ok` from the protocol loop is only success when no turn is still
/// bound. If the child died and ACP reported success on the same EOF, the
/// in-flight prompt must fail immediately — on every platform.
pub(in crate::manager) fn resolve_acp_process_stop<T, E: std::fmt::Display>(
    stop: AcpProcessStop<T, E>,
    prompt_in_flight: bool,
    stderr: Option<String>,
) -> AgentResult<T> {
    match stop {
        AcpProcessStop::Connection(Ok(_)) if prompt_in_flight => Err(connection_closed_error(
            "ACP connection ended while a turn was still in progress",
            stderr,
        )),
        AcpProcessStop::Connection(result) => {
            result.map_err(|error| AgentError::Runtime(format!("ACP connection failed: {error}")))
        }
        AcpProcessStop::ChildExited(status) => Err(connection_closed_error(
            format_child_exit_detail(status),
            stderr,
        )),
        AcpProcessStop::StdoutClosed => Err(connection_closed_error(
            "ACP agent closed stdout before the connection finished",
            stderr,
        )),
    }
}

pub(in crate::manager) fn connection_closed_error(
    detail: impl Into<String>,
    stderr: Option<String>,
) -> AgentError {
    let detail = detail.into();
    AgentError::ConnectionClosed(match stderr.filter(|text| !text.is_empty()) {
        Some(stderr) => format!("{detail}. Recent stderr: {stderr}"),
        None => detail,
    })
}

pub(in crate::manager) fn format_child_exit_detail(status: std::io::Result<ExitStatus>) -> String {
    match status {
        Ok(status) => format!("ACP agent process exited ({status})"),
        Err(error) => format!("failed to wait for ACP agent process: {error}"),
    }
}

/// Warmup and idle ACP deaths must not look like a failed in-flight turn.
pub(in crate::manager) fn agent_error_is_in_flight_turn_failure(
    code: &str,
    session_id: Option<AgentSessionId>,
    prompt_id: Option<AgentPromptId>,
) -> bool {
    if code == "agent_not_installed" {
        return false;
    }
    if code == "connection_closed" && (session_id.is_none() || prompt_id.is_none()) {
        return false;
    }
    true
}

pub(in crate::manager) fn turn_error_event_from_connection_failure(
    error: &AgentError,
) -> AgentErrorEvent {
    if error.is_connection_death() {
        AgentErrorEvent {
            message: CONNECTION_CLOSED_TURN_MESSAGE.to_string(),
            code: Some("connection_closed".to_string()),
            raw: Some(serde_json::json!({ "detail": error.to_string() })),
        }
    } else {
        AgentErrorEvent {
            message: error.to_string(),
            code: Some(
                error
                    .turn_failure_code()
                    .unwrap_or("internal_error")
                    .to_string(),
            ),
            raw: None,
        }
    }
}

pub(in crate::manager) fn handshake_timeout() -> Duration {
    handshake_timeout_from_env_value(std::env::var(HANDSHAKE_TIMEOUT_ENV).ok().as_deref())
}

pub(in crate::manager) fn handshake_timeout_from_env_value(value: Option<&str>) -> Duration {
    positive_timeout_secs(value).unwrap_or(Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS))
}

pub(in crate::manager) fn session_prep_timeout() -> Duration {
    session_prep_timeout_from_env_value(std::env::var(SESSION_PREP_TIMEOUT_ENV).ok().as_deref())
}

pub(in crate::manager) fn session_prep_timeout_from_env_value(value: Option<&str>) -> Duration {
    positive_timeout_secs(value).unwrap_or(Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS))
}

pub(in crate::manager) fn positive_timeout_secs(value: Option<&str>) -> Option<Duration> {
    value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
}

pub(in crate::manager) fn prompt_idle_timeout() -> Option<Duration> {
    prompt_idle_timeout_from_env(std::env::var(PROMPT_IDLE_TIMEOUT_ENV).ok().as_deref())
}

pub(in crate::manager) fn prompt_idle_timeout_from_env(value: Option<&str>) -> Option<Duration> {
    match value {
        Some(value) if !value.trim().is_empty() => prompt_idle_timeout_from_env_value(Some(value)),
        _ => Some(Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS)),
    }
}

pub(in crate::manager) fn prompt_idle_timeout_from_env_value(
    value: Option<&str>,
) -> Option<Duration> {
    positive_timeout_secs(value)
}

pub(in crate::manager) fn prompt_idle_watchdog_blocked(
    pending_permission: bool,
    pending_elicitation: bool,
    running_terminal: bool,
) -> bool {
    pending_permission || pending_elicitation || running_terminal
}

pub(in crate::manager) fn format_handshake_timeout_error(
    timeout: Duration,
    stderr: Option<String>,
) -> String {
    let seconds = timeout.as_secs().max(1);
    match stderr {
        Some(stderr) => {
            format!("ACP handshake timed out after {seconds}s. Recent stderr: {stderr}")
        }
        None => format!("ACP handshake timed out after {seconds}s. No stderr captured."),
    }
}

pub(in crate::manager) fn format_session_prep_timeout_error(timeout: Duration) -> String {
    let seconds = timeout.as_secs().max(1);
    format!("ACP session preparation timed out after {seconds}s")
}

pub(in crate::manager) async fn await_command_result<T>(
    result_rx: oneshot::Receiver<AgentResult<T>>,
    timeout: Duration,
    closed_message: &'static str,
    timeout_message: String,
) -> AgentResult<T> {
    match tokio::time::timeout(timeout, result_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(AgentError::Runtime(closed_message.into())),
        Err(_) => Err(AgentError::Runtime(timeout_message)),
    }
}
