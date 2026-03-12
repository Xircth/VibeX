use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
    },
    ToolUse {
        tool_use_id: Option<String>,
        tool_name: String,
        input_preview: Option<String>,
    },
    ToolResult {
        tool_use_id: Option<String>,
        output_preview: Option<String>,
        is_error: bool,
    },
    Thinking {
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: Vec<ContentBlock>,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageTurn {
    pub id: String,
    pub role: TurnRole,
    pub blocks: Vec<ContentBlock>,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}
