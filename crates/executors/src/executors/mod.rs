use command_group::AsyncGroupChild;
use futures_io::Error as FuturesIoError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum_macros::Display;
use thiserror::Error;
use ts_rs::TS;

use crate::command::CommandBuildError;
#[cfg(feature = "qa-mode")]
use crate::executors::qa_mock::QaMockExecutor;

pub mod claude;
pub mod codex;
pub mod opencode;
#[cfg(feature = "qa-mode")]
pub mod qa_mock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct SlashCommandDescription {
    /// Command name without the leading slash, e.g. `help` for `/help`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SlashCommandKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SlashCommandKind {
    Command,
    Skill,
}

#[derive(Debug, Error)]
pub enum ExecutorError {
    #[error("Follow-up is not supported: {0}")]
    FollowUpNotSupported(String),
    #[error(transparent)]
    SpawnError(#[from] FuturesIoError),
    #[error("Unknown executor type: {0}")]
    UnknownExecutorType(String),
    #[error("I/O error: {0}")]
    Io(std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    ExecutorApprovalError(#[from] crate::approvals::ExecutorApprovalError),
    #[error(transparent)]
    CommandBuild(#[from] CommandBuildError),
    #[error("Executable `{program}` not found in PATH")]
    ExecutableNotFound { program: String },
    #[error("Setup helper not supported")]
    SetupHelperNotSupported,
    #[error("Auth required: {0}")]
    AuthRequired(String),
    #[error("Unsupported executor configuration for ACP migration: {0}")]
    UnsupportedExecutorConfig(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, Display)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE")]
pub enum CodingAgent {
    ClaudeCode(claude::ClaudeCode),
    Codex(codex::Codex),
    Opencode(opencode::Opencode),
    #[cfg(feature = "qa-mode")]
    QaMock(QaMockExecutor),
}

/// Stable agent identity used as the executor key in profiles, sessions, and
/// the DB `executor` column.
///
/// The stable agent identity. Re-exported from [`api_types::AgentKind`] — the single
/// system-wide identity enum (ADR-0002, 批次D2). Kept under the historical
/// `AgentKind` name during the staged migration; call sites move to `AgentKind`
/// crate-by-crate. Serde/Display/sqlx now emit the canonical snake_case key
/// (`claude_code`, `opencode`, …) instead of the former SCREAMING_SNAKE; reads stay
/// lenient, so old persisted `CLAUDE_CODE`/kebab payloads still parse (ADR-0002).
pub use api_types::AgentKind;

impl From<&CodingAgent> for AgentKind {
    fn from(agent: &CodingAgent) -> Self {
        match agent {
            CodingAgent::ClaudeCode(_) => AgentKind::ClaudeCode,
            CodingAgent::Codex(_) => AgentKind::Codex,
            CodingAgent::Opencode(_) => AgentKind::Opencode,
            #[cfg(feature = "qa-mode")]
            CodingAgent::QaMock(_) => AgentKind::QaMock,
        }
    }
}

/// Result communicated through the exit signal.
#[derive(Debug, Clone, Copy)]
pub enum ExecutorExitResult {
    /// Process completed successfully (exit code 0).
    Success,
    /// Process should be marked as failed (non-zero exit).
    Failure,
}

/// Optional exit notification from an executor.
/// When this receiver resolves, the container should gracefully stop the process
/// and mark it according to the result.
pub type ExecutorExitSignal = tokio::sync::oneshot::Receiver<ExecutorExitResult>;

/// Cancellation token for requesting graceful shutdown of an executor.
/// When cancelled, the executor should attempt to cancel gracefully before being killed.
pub type CancellationToken = tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct SpawnedChild {
    pub child: AsyncGroupChild,
    /// Executor -> Container: signals when executor wants to exit.
    pub exit_signal: Option<ExecutorExitSignal>,
    /// Container -> Executor: signals when container wants to cancel the execution.
    pub cancel: Option<CancellationToken>,
}

impl From<AsyncGroupChild> for SpawnedChild {
    fn from(child: AsyncGroupChild) -> Self {
        Self {
            child,
            exit_signal: None,
            cancel: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema)]
#[serde(transparent)]
#[schemars(
    title = "Append Prompt",
    description = "Extra text appended to the prompt",
    extend("format" = "textarea")
)]
#[derive(Default)]
pub struct AppendPrompt(pub Option<String>);

impl AppendPrompt {
    pub fn get(&self) -> Option<String> {
        self.0.clone()
    }

    pub fn combine_prompt(&self, prompt: &str) -> String {
        match self {
            AppendPrompt(Some(value)) => format!("{prompt}{value}"),
            AppendPrompt(None) => prompt.to_string(),
        }
    }
}
