use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ConversationId, OperationId};

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NotificationOutcome {
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotificationSource {
    Conversation {
        conversation_id: ConversationId,
    },
    Automation {
        automation_id: String,
        run_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation_id: Option<ConversationId>,
    },
}

/// Secret-free terminal projection suitable for a future notification
/// provider. It deliberately contains no prompt, output, path, or diagnostic.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct TerminalNotificationSummary {
    pub source: NotificationSource,
    pub outcome: NotificationOutcome,
    pub occurred_at: String,
    pub operation_id: OperationId,
}
