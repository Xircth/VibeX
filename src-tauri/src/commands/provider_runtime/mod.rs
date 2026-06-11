#[cfg(test)]
use std::path::Path;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, LazyLock, atomic::AtomicU64},
};

#[cfg(test)]
use executors::executors::SlashCommandKind;
#[cfg(test)]
use executors::logs::FileChange;
#[cfg(test)]
use executors::profile::ExecutorProfileId;
use executors::{
    executors::codex::codex_config_model_context_window,
    logs::{ActionType, ToolResult, ToolStatus},
};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use sqlx::SqlitePool;
use tokio::{
    process::{Child, ChildStdin},
    sync::{Mutex, oneshot},
};
use utils::msg_store::MsgStore;
use uuid::Uuid;

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
    process_id: Uuid,
    session_id: Uuid,
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

#[derive(Debug, Default, Clone)]
struct CodexAutoCompactionThreadState {
    is_processing: bool,
    in_flight: bool,
    last_triggered_at_ms: u64,
    last_usage_percent: Option<f64>,
}

struct CodexAppServer {
    workspace_id: String,
    workspace_dir: PathBuf,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: CodexPendingRequests,
    next_id: AtomicU64,
    last_used_at_ms: AtomicU64,
    auto_compaction_thread_state: Arc<Mutex<HashMap<String, CodexAutoCompactionThreadState>>>,
}

mod contract;

pub use contract::{
    CapabilitySource, CapabilityState, CapabilityStatus, ProviderCapabilityState, ProviderCommand,
    ProviderHistorySnapshot, ProviderId, ProviderModel, ProviderRuntimeContract,
    ProviderRuntimeDependency, ProviderRuntimeDependencyStatus, ProviderRuntimeEvent,
    ProviderRuntimeKind, ProviderRuntimeNormalizedEvent, ProviderRuntimeStatus,
    ProviderSessionSummary, ProviderTurnRequest, provider_capabilities, provider_runtime_contract,
    provider_slash_commands,
};

mod runtime_config;
#[cfg(test)]
use runtime_config::{
    ProviderFallbackPolicy, native_commit_reminder_prompt_text,
    native_commit_reminder_status_has_changes, parse_acp_fallback_enabled_value,
};
use runtime_config::{
    acp_fallback_config, apply_native_commit_reminder_to_request,
    apply_profile_defaults_to_request, new_provider_hidden_command, provider_acp_fallback_env,
    provider_executor_config, provider_executor_profile_id, provider_fallback_policy,
    provider_option_bool, provider_option_string, resolve_codex_runtime_options,
    session_executor_matches_provider, should_force_acp_fallback,
    should_hide_provider_slash_command, validate_provider_executor_profile,
};
mod claude_sdk;
use claude_sdk::{
    build_claude_sdk_bridge_args, build_claude_sdk_bridge_input, claude_sdk_bridge_script_path,
    load_claude_sdk_commands, load_claude_sdk_models, repo_root_path,
    write_claude_sdk_bridge_input_file,
};
#[cfg(test)]
use claude_sdk::{
    build_claude_sdk_metadata_args, claude_sdk_metadata_commands, claude_sdk_metadata_models,
    resolve_claude_model_from_env,
};
mod opencode_sdk;
use opencode_sdk::{
    build_opencode_sdk_bridge_args, build_opencode_sdk_bridge_input, load_opencode_sdk_commands,
    load_opencode_sdk_models, opencode_sdk_bridge_script_path,
    write_opencode_sdk_bridge_input_file,
};
#[cfg(test)]
use opencode_sdk::{
    build_opencode_sdk_metadata_args, opencode_sdk_metadata_commands, opencode_sdk_metadata_models,
};
mod provider_text;
use provider_text::{
    append_provider_assistant_text, codex_input_items, codex_runtime_key, codex_turn_from_response,
    codex_turn_status, codex_turn_status_is_complete, codex_turn_status_is_terminal,
    extract_provider_assistant_entry_id, extract_provider_diagnostic_text,
    extract_provider_stream_text, extract_provider_text, extract_text_block_content,
    extract_thread_id, extract_turn_id, is_context_compact_prompt, native_normalized_entry,
    provider_event_is_codex_turn_snapshot, provider_event_is_user_echo, push_native_log_msg,
    push_provider_event, register_native_conversation_sink,
};
mod provider_tools;
use provider_tools::{extract_provider_tool_updates, merge_tool_result, provider_tool_content};
mod token_usage;
#[cfg(test)]
use token_usage::extract_provider_token_usage_info;
use token_usage::{
    extract_provider_error, extract_provider_token_usage_info_with_codex_context_window,
};
mod provider_events;
use provider_events::{
    NormalizedProviderEvent, ProviderDiagnosticLevel, ProviderEventAdapter,
    normalize_provider_runtime_event,
};
mod codex_events;
use codex_events::CodexEventAdapter;
mod claude_events;
use claude_events::ClaudeEventAdapter;
mod opencode_events;
use opencode_events::OpencodeEventAdapter;
mod bridge_runner;
#[cfg(test)]
use bridge_runner::bridge_completion_status_for_test;
use bridge_runner::{BridgeRunSpec, start_bridge_native_turn};
mod runtime_registry;
use runtime_registry::kill_active_native_turn;
#[cfg(test)]
use runtime_registry::{
    active_native_turn_provider, register_active_native_turn_for_test, remove_active_native_turn,
};
mod native_conversation;
#[cfg(test)]
use native_conversation::{
    close_native_assistant_segment, codex_context_compaction_status_text,
    should_skip_provider_text_snapshot, upsert_native_assistant_entry,
};
use native_conversation::{
    complete_codex_native_sink, complete_native_conversation_sink,
    is_codex_context_compaction_completed, push_claude_provider_event_to_conversation,
    push_native_provider_event_to_conversation, push_opencode_provider_event_to_conversation,
    route_codex_event_to_native_conversation,
};
mod runtime_core;
use runtime_core::{
    app_error_from_native, create_native_execution_process, ensure_provider_session,
    load_provider_workspace, probe_native_runtime_with_dependencies, prompt_with_display_images,
    provider_fallback_status, provider_sdk_metadata_failure_error, resolve_native_provider_request,
    resolve_provider_workspace_dir,
};
#[cfg(test)]
use runtime_core::{
    dependency_statuses_for_probe_output_for_test, provider_request_with_resolved_thread_id,
};
mod codex_app_server;
pub use codex_app_server::interrupt_codex_native_execution_process;
#[cfg(test)]
use codex_app_server::{
    CODEX_AUTO_COMPACTION_COOLDOWN_MS, codex_app_server_command_args,
    codex_app_server_idle_for_ms_since, codex_models_from_response, codex_request_turn_id,
    codex_steer_is_allowed, codex_turn_start_error_is_active_turn,
    evaluate_codex_auto_compaction_state, extract_codex_compaction_usage_percent,
};
use codex_app_server::{
    codex_auto_compaction_is_in_flight, codex_response_success, codex_workspace_cwd_param,
    ensure_codex_app_server_for_workspace, load_codex_app_server_models,
    send_codex_app_server_workspace_request, send_codex_request, send_codex_response,
    send_codex_turn_interrupt, start_codex_native_turn, try_steer_active_codex_turn,
};
mod provider_turns;
use provider_turns::{fallback_acp_turn, native_provider_error_event, try_native_provider_turn};
mod history_commands;
#[cfg(test)]
use history_commands::provider_history_retention_marker;
pub use history_commands::*;

#[cfg(test)]
mod tests;
