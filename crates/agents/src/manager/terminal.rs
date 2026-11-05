use super::*;

const MAX_TRACKED_HOSTED_TERMINALS: usize = 64;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn hosted_terminal_output(
        &self,
        id: &str,
        meta: Option<&serde_json::Map<String, serde_json::Value>>,
        status: Option<&str>,
    ) -> Option<String> {
        let kind = self.agent_kind()?;
        let marks = crate::hosted_terminal::hosted_terminal_meta_marks_shell(kind, meta);
        let chunk = crate::hosted_terminal::hosted_terminal_frame_chunk(kind, meta);
        let mut tracked = self.hosted_terminal_output.lock().await;
        if (marks || chunk.is_some())
            && !tracked.contains_key(id)
            && tracked.len() >= MAX_TRACKED_HOSTED_TERMINALS
            && let Some(evict_key) = tracked.keys().next().cloned()
        {
            tracked.remove(&evict_key);
        }
        if marks {
            tracked.entry(id.to_string()).or_default();
        }
        let terminal = matches!(
            status,
            Some("completed" | "failed" | "cancelled" | "canceled" | "error")
        );
        let out = chunk.map(|chunk| {
            let acc = tracked.entry(id.to_string()).or_default();
            if acc.is_empty() {
                *acc = crate::conversation::cap_preview_bytes(chunk);
            } else {
                acc.push_str(&chunk);
                if acc.len() > crate::conversation::MAX_TIMELINE_PREVIEW_BYTES {
                    *acc = crate::conversation::cap_preview_bytes(std::mem::take(acc));
                }
            }
            if terminal {
                std::mem::take(acc)
            } else {
                acc.clone()
            }
        });
        if terminal {
            tracked.remove(id);
        }
        out
    }

    pub(in crate::manager) async fn hosted_terminal_is_tracked(&self, id: &str) -> bool {
        self.hosted_terminal_output.lock().await.contains_key(id)
    }
}

impl AcpClientBridge {
    pub(in crate::manager) async fn create_terminal(
        &self,
        args: agent_client_protocol::schema::v1::CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, acp::Error> {
        let acp_session = args.session_id.0.to_string();
        let Some(session_id) = self.agent_session_for_acp(acp_session.clone()).await else {
            tracing::warn!(
                acp_session = %acp_session,
                "create_terminal for unknown ACP session — rejecting instead of \
                 routing to a phantom session"
            );
            return Err(acp::Error::invalid_params());
        };
        if args.command.trim().is_empty() {
            return Err(acp::Error::invalid_params());
        }
        let cwd = crate::terminal::resolve_terminal_cwd(args.cwd.as_deref(), &self.working_dir)
            .map_err(|_| acp::Error::invalid_params())?;
        let command = args.command.clone();
        let terminal_id = agent_terminal_registry()
            .create_terminal(&AgentTerminalCreateRequest {
                session_id,
                command: args.command,
                args: args.args,
                cwd: cwd.map(|cwd| cwd.display().to_string()),
                env: args
                    .env
                    .into_iter()
                    .map(|var| AgentTerminalEnvVar {
                        name: var.name,
                        value: var.value,
                    })
                    .collect(),
                output_byte_limit: args.output_byte_limit,
            })
            .await
            .map_err(|error| {
                tracing::error!(
                    error = %error,
                    command = %command,
                    "create_terminal spawn failed"
                );
                acp::Error::new(-32603, format!("failed to spawn terminal: {error}"))
            })?;
        Ok(CreateTerminalResponse::new(TerminalId::new(
            terminal_id.to_string(),
        )))
    }

    pub(in crate::manager) async fn kill_terminal(
        &self,
        args: KillTerminalRequest,
    ) -> Result<KillTerminalResponse, acp::Error> {
        let terminal_id = parse_terminal_id(&args.terminal_id)?;
        if !agent_terminal_registry()
            .kill_terminal(terminal_id.into())
            .await
        {
            return Err(acp::Error::invalid_params());
        }
        Ok(KillTerminalResponse::new())
    }
}

pub(in crate::manager) fn parse_terminal_id(id: &TerminalId) -> Result<uuid::Uuid, acp::Error> {
    uuid::Uuid::parse_str(id.0.as_ref()).map_err(|_| acp::Error::invalid_params())
}

pub(in crate::manager) async fn wait_for_terminal_exit_response(
    terminal_id: uuid::Uuid,
) -> Result<WaitForTerminalExitResponse, acp::Error> {
    let exit = agent_terminal_registry()
        .wait_for_exit(terminal_id.into())
        .await
        .ok_or_else(acp::Error::invalid_params)?;
    let mut exit_status = agent_client_protocol::schema::v1::TerminalExitStatus::new();
    if let AgentTerminalExit::Code { code } = exit {
        exit_status = exit_status.exit_code(code as u32);
    }
    Ok(WaitForTerminalExitResponse::new(exit_status))
}
