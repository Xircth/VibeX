use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use db::models::{
    coding_agent_turn::{CodingAgentTurn, CreateCodingAgentTurn},
    execution_process::{
        CreateExecutionProcess, ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus,
    },
    execution_process_logs::ExecutionProcessLogs,
    execution_process_repo_state::CreateExecutionProcessRepoState,
    session::{CreateSession, Session, SessionStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    executors::{
        CodingAgent, SlashCommandKind,
        codex::{AskForApproval, ReasoningEffort, SandboxMode, codex_config_model_context_window},
    },
    logs::{
        ActionType, CommandExitStatus, CommandRunResult, FileChange, NormalizedEntry,
        NormalizedEntryError, NormalizedEntryType, TokenUsageInfo, ToolResult, ToolResultValueType,
        ToolStatus, utils::ConversationPatch,
    },
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use serde_json::{Value, json};
use services::services::{config::DEFAULT_COMMIT_REMINDER_PROMPT, container::ContainerService};
use sqlx::SqlitePool;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{Mutex, oneshot},
    time::Duration,
};
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_agent_working_dir,
};

const CODEX_REQUEST_TIMEOUT_SECS: u64 = 30;
const CODEX_INITIALIZE_TIMEOUT_SECS: u64 = 15;
const ACP_FALLBACK_ENV: &str = "VIBEX_PROVIDER_ACP_FALLBACK";
const CLAUDE_ACP_FALLBACK_ENV: &str = "VIBEX_CLAUDE_ACP_FALLBACK";
const CODEX_ACP_FALLBACK_ENV: &str = "VIBEX_CODEX_ACP_FALLBACK";
const OPENCODE_ACP_FALLBACK_ENV: &str = "VIBEX_OPENCODE_ACP_FALLBACK";
const CLAUDE_PRIMARY_MODEL_ENV: &str = "ANTHROPIC_MODEL";
const CLAUDE_DEFAULT_SONNET_ENV: &str = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const CLAUDE_DEFAULT_OPUS_ENV: &str = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const CLAUDE_DEFAULT_HAIKU_ENV: &str = "ANTHROPIC_DEFAULT_HAIKU_MODEL";

static CODEX_APP_SERVERS: LazyLock<Mutex<HashMap<String, Arc<CodexAppServer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NATIVE_ACTIVE_TURNS: LazyLock<Mutex<HashMap<String, NativeProcessHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CODEX_NATIVE_TURN_SINKS: LazyLock<Mutex<HashMap<String, NativeConversationSink>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CODEX_NATIVE_THREAD_SINKS: LazyLock<Mutex<HashMap<String, NativeConversationSink>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PROVIDER_EVENT_HISTORY: LazyLock<Mutex<HashMap<String, Vec<ProviderRuntimeEvent>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct NativeProcessHandle {
    provider: ProviderId,
    child: Arc<Mutex<Child>>,
}

#[derive(Clone)]
struct NativeConversationSink {
    pool: SqlitePool,
    process_id: Uuid,
    session_id: Uuid,
    msg_store: Arc<MsgStore>,
    state: Arc<Mutex<NativeConversationState>>,
}

#[derive(Default)]
struct NativeConversationState {
    assistant_entries: HashMap<String, NativeAssistantEntryState>,
    active_assistant_entry_id: Option<String>,
    next_entry_index: usize,
    tool_entries: HashMap<String, NativeToolEntryState>,
}

#[derive(Clone)]
struct NativeAssistantEntryState {
    index: usize,
    content: String,
}

#[derive(Clone)]
struct NativeToolEntryState {
    index: usize,
    tool_name: String,
    action_type: ActionType,
    content: String,
}

#[derive(Debug, Clone)]
struct NativeToolUpdate {
    id: String,
    tool_name: Option<String>,
    action_type: Option<ActionType>,
    status: ToolStatus,
    content: Option<String>,
    command_output: Option<String>,
    result: Option<ToolResult>,
}

type CodexPendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct CodexAppServer {
    workspace_id: String,
    workspace_dir: PathBuf,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: CodexPendingRequests,
    next_id: AtomicU64,
}

mod contract;

pub use contract::{
    CapabilitySource, CapabilityState, CapabilityStatus, ProviderCapabilityState, ProviderCommand,
    ProviderHistorySnapshot, ProviderId, ProviderModel, ProviderRuntimeContract,
    ProviderRuntimeDependency, ProviderRuntimeEvent, ProviderRuntimeKind, ProviderRuntimeStatus,
    ProviderSessionSummary, ProviderTurnRequest, provider_capabilities, provider_runtime_contract,
    provider_slash_commands,
};

include!("runtime_config.rs");
include!("claude_sdk.rs");
include!("opencode_sdk.rs");
include!("provider_text.rs");
include!("provider_tools.rs");
include!("token_usage.rs");
include!("native_conversation.rs");
include!("runtime_core.rs");
include!("codex_app_server.rs");
include!("provider_turns.rs");
include!("history_commands.rs");

#[cfg(test)]
mod tests;
