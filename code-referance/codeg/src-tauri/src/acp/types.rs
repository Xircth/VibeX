use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptInputBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        #[serde(default)]
        uri: Option<String>,
    },
    Resource {
        uri: String,
        #[serde(default)]
        mime_type: Option<String>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        blob: Option<String>,
    },
    ResourceLink {
        uri: String,
        name: String,
        #[serde(default)]
        mime_type: Option<String>,
        #[serde(default)]
        description: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptCapabilitiesInfo {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

/// Events pushed from Rust backend to frontend via Tauri event system.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpEvent {
    /// Agent returned text content (streaming delta)
    ContentDelta { connection_id: String, text: String },
    /// Agent thinking/reasoning
    Thinking { connection_id: String, text: String },
    /// Agent initiated a tool call
    ToolCall {
        connection_id: String,
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        content: Option<String>,
        raw_input: Option<String>,
        raw_output: Option<String>,
    },
    /// Tool call status/content updated
    ToolCallUpdate {
        connection_id: String,
        tool_call_id: String,
        title: Option<String>,
        status: Option<String>,
        content: Option<String>,
        raw_input: Option<String>,
        raw_output: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        raw_output_append: Option<bool>,
    },
    /// Agent requests permission
    PermissionRequest {
        connection_id: String,
        request_id: String,
        tool_call: serde_json::Value,
        options: Vec<PermissionOptionInfo>,
    },
    /// Turn completed
    TurnComplete {
        connection_id: String,
        session_id: String,
        stop_reason: String,
    },
    /// Session established with agent-assigned session ID
    SessionStarted {
        connection_id: String,
        session_id: String,
    },
    /// Session modes are available for this connection
    SessionModes {
        connection_id: String,
        modes: SessionModeStateInfo,
    },
    /// Session configuration options are available/updated for this connection
    SessionConfigOptions {
        connection_id: String,
        config_options: Vec<SessionConfigOptionInfo>,
    },
    /// Initial selector payloads (modes/config options) have been emitted
    SelectorsReady { connection_id: String },
    /// Prompt capabilities for this connection
    PromptCapabilities {
        connection_id: String,
        prompt_capabilities: PromptCapabilitiesInfo,
    },
    /// Current session mode changed
    ModeChanged {
        connection_id: String,
        mode_id: String,
    },
    /// Agent reported plan update for current turn
    PlanUpdate {
        connection_id: String,
        entries: Vec<PlanEntryInfo>,
    },
    /// Connection status changed
    StatusChanged {
        connection_id: String,
        status: ConnectionStatus,
    },
    /// Error occurred
    Error {
        connection_id: String,
        message: String,
    },
    /// Available slash commands updated
    AvailableCommands {
        connection_id: String,
        commands: Vec<AvailableCommandInfo>,
    },
    /// Session usage/context window updated during conversation
    UsageUpdate {
        connection_id: String,
        used: u64,
        size: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOptionInfo {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionModeInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionModeStateInfo {
    pub current_mode_id: String,
    pub available_modes: Vec<SessionModeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfigSelectOptionInfo {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfigSelectGroupInfo {
    pub group: String,
    pub name: String,
    pub options: Vec<SessionConfigSelectOptionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfigSelectInfo {
    pub current_value: String,
    pub options: Vec<SessionConfigSelectOptionInfo>,
    pub groups: Vec<SessionConfigSelectGroupInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionConfigKindInfo {
    Select(SessionConfigSelectInfo),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfigOptionInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub kind: SessionConfigKindInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanEntryInfo {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connecting,
    Downloading,
    Connected,
    Prompting,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub agent_type: crate::models::agent::AgentType,
    pub status: ConnectionStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct AcpAgentInfo {
    pub agent_type: crate::models::agent::AgentType,
    pub registry_id: String,
    pub registry_version: Option<String>,
    pub name: String,
    pub description: String,
    pub available: bool,
    pub distribution_type: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub installed_version: Option<String>,
    pub env: BTreeMap<String, String>,
    pub config_json: Option<String>,
    pub config_file_path: Option<String>,
    pub opencode_auth_json: Option<String>,
    pub codex_auth_json: Option<String>,
    pub codex_config_toml: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillLayout {
    MarkdownFile,
    SkillDirectory,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSkillLocation {
    pub scope: AgentSkillScope,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSkillItem {
    pub id: String,
    pub name: String,
    pub scope: AgentSkillScope,
    pub layout: AgentSkillLayout,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSkillsListResult {
    pub supported: bool,
    pub message: Option<String>,
    pub locations: Vec<AgentSkillLocation>,
    pub skills: Vec<AgentSkillItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSkillContent {
    pub skill: AgentSkillItem,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableCommandInfo {
    pub name: String,
    pub description: String,
    pub input_hint: Option<String>,
}
