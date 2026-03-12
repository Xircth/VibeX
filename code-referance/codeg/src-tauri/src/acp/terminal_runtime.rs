use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use sacp::schema::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalCommandRequest,
    KillTerminalCommandResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    TerminalExitStatus, TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Mutex;

type TerminalMap = HashMap<String, Arc<TerminalInstance>>;
const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1_000_000;

#[derive(Debug)]
pub enum TerminalRuntimeError {
    InvalidParams(String),
    Internal(String),
}

impl TerminalRuntimeError {
    pub fn into_rpc_error(self) -> sacp::Error {
        match self {
            Self::InvalidParams(message) => sacp::Error::invalid_params().data(message),
            Self::Internal(message) => sacp::util::internal_error(message),
        }
    }
}

#[derive(Debug, Default, Clone)]
struct TerminalSnapshot {
    output: String,
    output_base_offset: u64,
    truncated: bool,
    exit_status: Option<TerminalExitStatus>,
}

struct TerminalInstance {
    session_id: String,
    output_limit: Option<usize>,
    child: Mutex<Option<tokio::process::Child>>,
    snapshot: Mutex<TerminalSnapshot>,
}

impl TerminalInstance {
    fn new(session_id: String, output_limit: Option<u64>, child: tokio::process::Child) -> Self {
        Self {
            session_id,
            output_limit: output_limit.and_then(|v| usize::try_from(v).ok()),
            child: Mutex::new(Some(child)),
            snapshot: Mutex::new(TerminalSnapshot::default()),
        }
    }

    async fn append_output(&self, text: &str) {
        let mut snapshot = self.snapshot.lock().await;
        snapshot.output.push_str(text);
        if let Some(limit) = self.output_limit {
            let removed = enforce_output_limit(&mut snapshot.output, limit);
            if removed > 0 {
                snapshot.truncated = true;
                snapshot.output_base_offset = snapshot
                    .output_base_offset
                    .saturating_add(u64::try_from(removed).unwrap_or(u64::MAX));
            }
        }
    }

    async fn refresh_exit_status(&self) -> Result<(), TerminalRuntimeError> {
        {
            let snapshot = self.snapshot.lock().await;
            if snapshot.exit_status.is_some() {
                return Ok(());
            }
        }

        let maybe_status = {
            let mut child_guard = self.child.lock().await;
            if let Some(child) = child_guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        *child_guard = None;
                        Some(status)
                    }
                    Ok(None) => None,
                    Err(err) => {
                        return Err(TerminalRuntimeError::Internal(format!(
                            "failed to query terminal exit status: {err}"
                        )))
                    }
                }
            } else {
                None
            }
        };

        if let Some(status) = maybe_status {
            let mut snapshot = self.snapshot.lock().await;
            snapshot.exit_status = Some(map_exit_status(status));
        }

        Ok(())
    }

    async fn wait_for_exit(&self) -> Result<TerminalExitStatus, TerminalRuntimeError> {
        self.refresh_exit_status().await?;
        {
            let snapshot = self.snapshot.lock().await;
            if let Some(exit_status) = snapshot.exit_status.clone() {
                return Ok(exit_status);
            }
        }

        let exit_status = {
            let mut child_guard = self.child.lock().await;
            let Some(child) = child_guard.as_mut() else {
                return Err(TerminalRuntimeError::Internal(
                    "terminal process missing while waiting for exit".to_string(),
                ));
            };
            let status = child.wait().await.map_err(|err| {
                TerminalRuntimeError::Internal(format!(
                    "failed waiting for terminal process to exit: {err}"
                ))
            })?;
            *child_guard = None;
            map_exit_status(status)
        };

        let mut snapshot = self.snapshot.lock().await;
        snapshot.exit_status = Some(exit_status.clone());
        Ok(exit_status)
    }

    async fn kill_command(&self) -> Result<(), TerminalRuntimeError> {
        self.refresh_exit_status().await?;
        {
            let snapshot = self.snapshot.lock().await;
            if snapshot.exit_status.is_some() {
                return Ok(());
            }
        }

        let exit_status = {
            let mut child_guard = self.child.lock().await;
            let Some(child) = child_guard.as_mut() else {
                return Ok(());
            };

            if let Some(pid) = child.id() {
                if let Err(err) = kill_tree::tokio::kill_tree(pid).await {
                    eprintln!("[ACP] kill_tree failed for pid {pid}: {err}");
                }
            }

            let status = child.wait().await.map_err(|err| {
                TerminalRuntimeError::Internal(format!(
                    "failed to wait for killed terminal process: {err}"
                ))
            })?;
            *child_guard = None;
            map_exit_status(status)
        };

        let mut snapshot = self.snapshot.lock().await;
        snapshot.exit_status = Some(exit_status);
        Ok(())
    }

    async fn snapshot(&self) -> TerminalSnapshot {
        self.snapshot.lock().await.clone()
    }
}

pub struct TerminalRuntime {
    terminals: Mutex<TerminalMap>,
}

#[derive(Debug, Clone)]
pub struct TerminalOutputDelta {
    pub output: String,
    pub next_offset: u64,
    pub had_gap: bool,
    pub truncated: bool,
    pub exit_status: Option<TerminalExitStatus>,
}

impl TerminalRuntime {
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
        }
    }

    pub async fn create_terminal(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, TerminalRuntimeError> {
        if let Some(cwd) = request.cwd.as_ref() {
            if !cwd.is_absolute() {
                return Err(TerminalRuntimeError::InvalidParams(
                    "terminal/create requires an absolute cwd when provided".to_string(),
                ));
            }
        }

        let output_byte_limit = request
            .output_byte_limit
            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);
        if output_byte_limit == 0 {
            return Err(TerminalRuntimeError::InvalidParams(
                "terminal/create outputByteLimit must be greater than 0".to_string(),
            ));
        }

        let mut command = crate::process::tokio_command(&request.command);
        command
            .args(&request.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());

        if let Some(cwd) = request.cwd.as_ref() {
            command.current_dir(cwd);
        }

        for env_var in &request.env {
            command.env(&env_var.name, &env_var.value);
        }

        let mut child = command.spawn().map_err(|err| {
            TerminalRuntimeError::Internal(format!(
                "failed to spawn terminal command {}: {err}",
                request.command
            ))
        })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let terminal_id = format!("term_{}", uuid::Uuid::new_v4().simple());
        let terminal = Arc::new(TerminalInstance::new(
            request.session_id.to_string(),
            Some(output_byte_limit),
            child,
        ));

        if let Some(reader) = stdout {
            let terminal_ref = terminal.clone();
            tokio::spawn(async move {
                read_stream(reader, terminal_ref).await;
            });
        }

        if let Some(reader) = stderr {
            let terminal_ref = terminal.clone();
            tokio::spawn(async move {
                read_stream(reader, terminal_ref).await;
            });
        }

        self.terminals
            .lock()
            .await
            .insert(terminal_id.clone(), terminal);

        Ok(CreateTerminalResponse::new(terminal_id))
    }

    pub async fn terminal_output(
        &self,
        request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, TerminalRuntimeError> {
        let terminal = self
            .find_terminal(
                &request.terminal_id.to_string(),
                &request.session_id.to_string(),
            )
            .await?;

        terminal.refresh_exit_status().await?;
        let snapshot = terminal.snapshot().await;

        Ok(
            TerminalOutputResponse::new(snapshot.output, snapshot.truncated)
                .exit_status(snapshot.exit_status),
        )
    }

    pub async fn terminal_output_delta(
        &self,
        session_id: &str,
        terminal_id: &str,
        from_offset: Option<u64>,
    ) -> Result<TerminalOutputDelta, TerminalRuntimeError> {
        let terminal = self.find_terminal(terminal_id, session_id).await?;
        terminal.refresh_exit_status().await?;
        let snapshot = terminal.snapshot().await;

        let output_len = u64::try_from(snapshot.output.len()).unwrap_or(u64::MAX);
        let base_offset = snapshot.output_base_offset;
        let end_offset = base_offset.saturating_add(output_len);
        let requested_offset = from_offset.unwrap_or(base_offset);
        let had_gap = from_offset
            .map(|offset| offset < base_offset)
            .unwrap_or(false);
        let start_offset = requested_offset.clamp(base_offset, end_offset);
        let start_index = usize::try_from(start_offset.saturating_sub(base_offset)).unwrap_or(0);
        let output = snapshot.output[start_index..].to_string();

        Ok(TerminalOutputDelta {
            output,
            next_offset: end_offset,
            had_gap,
            truncated: snapshot.truncated,
            exit_status: snapshot.exit_status,
        })
    }

    pub async fn wait_for_terminal_exit(
        &self,
        request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, TerminalRuntimeError> {
        let terminal = self
            .find_terminal(
                &request.terminal_id.to_string(),
                &request.session_id.to_string(),
            )
            .await?;
        let exit_status = terminal.wait_for_exit().await?;
        Ok(WaitForTerminalExitResponse::new(exit_status))
    }

    pub async fn kill_terminal(
        &self,
        request: KillTerminalCommandRequest,
    ) -> Result<KillTerminalCommandResponse, TerminalRuntimeError> {
        let terminal = self
            .find_terminal(
                &request.terminal_id.to_string(),
                &request.session_id.to_string(),
            )
            .await?;
        terminal.kill_command().await?;
        Ok(KillTerminalCommandResponse::new())
    }

    pub async fn release_terminal(
        &self,
        request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, TerminalRuntimeError> {
        let terminal_id = request.terminal_id.to_string();
        let session_id = request.session_id.to_string();
        let terminal = {
            let mut terminals = self.terminals.lock().await;
            let Some(existing) = terminals.get(&terminal_id) else {
                return Err(TerminalRuntimeError::InvalidParams(format!(
                    "terminal {terminal_id} not found"
                )));
            };
            if existing.session_id != session_id {
                return Err(TerminalRuntimeError::InvalidParams(format!(
                    "terminal {terminal_id} does not belong to session {session_id}"
                )));
            }
            terminals.remove(&terminal_id).expect("terminal exists")
        };

        terminal.kill_command().await?;
        Ok(ReleaseTerminalResponse::new())
    }

    pub async fn release_all_for_session(&self, session_id: &str) {
        let removed = {
            let mut terminals = self.terminals.lock().await;
            let ids: Vec<String> = terminals
                .iter()
                .filter(|(_, term)| term.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();

            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(term) = terminals.remove(&id) {
                    removed.push(term);
                }
            }
            removed
        };

        for terminal in removed {
            if let Err(err) = terminal.kill_command().await {
                eprintln!("[ACP] Failed to release terminal during cleanup: {err:?}");
            }
        }
    }

    async fn find_terminal(
        &self,
        terminal_id: &str,
        session_id: &str,
    ) -> Result<Arc<TerminalInstance>, TerminalRuntimeError> {
        let terminal = {
            let terminals = self.terminals.lock().await;
            terminals.get(terminal_id).cloned()
        }
        .ok_or_else(|| {
            TerminalRuntimeError::InvalidParams(format!("terminal {terminal_id} not found"))
        })?;

        if terminal.session_id != session_id {
            return Err(TerminalRuntimeError::InvalidParams(format!(
                "terminal {terminal_id} does not belong to session {session_id}"
            )));
        }

        Ok(terminal)
    }
}

async fn read_stream<R>(mut reader: R, terminal: Arc<TerminalInstance>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4096];
    let mut pending = Vec::<u8>::new();
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                if !pending.is_empty() {
                    let text = String::from_utf8_lossy(&pending).to_string();
                    terminal.append_output(&text).await;
                    pending.clear();
                }
                break;
            }
            Ok(size) => {
                pending.extend_from_slice(&buffer[..size]);
                let decoded = decode_available_utf8(&mut pending);
                if !decoded.is_empty() {
                    terminal.append_output(&decoded).await;
                }
            }
            Err(_) => break,
        }
    }
}

fn map_exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status).map(|s| s.to_string());
    #[cfg(not(unix))]
    let signal: Option<String> = None;

    let exit_code = status.code().and_then(|code| u32::try_from(code).ok());
    TerminalExitStatus::new()
        .exit_code(exit_code)
        .signal(signal)
}

fn enforce_output_limit(output: &mut String, limit: usize) -> usize {
    if output.len() <= limit {
        return 0;
    }

    let mut start = output.len().saturating_sub(limit);
    while start < output.len() && !output.is_char_boundary(start) {
        start += 1;
    }

    output.drain(..start);
    start
}

fn decode_available_utf8(pending: &mut Vec<u8>) -> String {
    let mut output = String::new();
    let mut consumed = 0usize;
    let mut remaining = pending.as_slice();

    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                output.push_str(text);
                consumed = consumed.saturating_add(remaining.len());
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    if let Ok(text) = std::str::from_utf8(&remaining[..valid_up_to]) {
                        output.push_str(text);
                    }
                    consumed = consumed.saturating_add(valid_up_to);
                    remaining = &remaining[valid_up_to..];
                }

                match err.error_len() {
                    Some(invalid_len) => {
                        output.push_str(&String::from_utf8_lossy(&remaining[..invalid_len]));
                        consumed = consumed.saturating_add(invalid_len);
                        remaining = &remaining[invalid_len..];
                    }
                    None => break, // keep partial UTF-8 sequence for next chunk
                }
            }
        }
    }

    if consumed > 0 {
        pending.drain(..consumed);
    }
    output
}
