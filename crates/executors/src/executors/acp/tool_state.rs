use std::path::{Path, PathBuf};

use agent_client_protocol::schema::{
    ToolCall, ToolCallContent, ToolCallId, ToolCallStatus, ToolKind,
};

#[derive(Debug, Clone)]
pub(super) struct PartialToolCallData {
    pub index: usize,
    pub id: ToolCallId,
    pub kind: ToolKind,
    pub title: String,
    pub status: ToolCallStatus,
    pub path: Option<PathBuf>,
    pub content: Vec<ToolCallContent>,
    pub raw_input: Option<serde_json::Value>,
    pub raw_output: Option<serde_json::Value>,
}

impl PartialToolCallData {
    pub fn extend(&mut self, tc: &ToolCall, worktree_path: &Path) {
        self.id = tc.tool_call_id.clone();
        if tc.kind != Default::default() {
            self.kind = tc.kind;
        }
        if !tc.title.is_empty() {
            self.title = tc.title.clone();
        }
        if tc.status != Default::default() {
            self.status = tc.status;
        }
        if !tc.locations.is_empty() {
            self.path = tc.locations.first().map(|location| {
                PathBuf::from(workspace_utils::path::make_path_relative(
                    &location.path.to_string_lossy(),
                    &worktree_path.to_string_lossy(),
                ))
            });
        }
        if !tc.content.is_empty() {
            self.content = tc.content.clone();
        }
        if tc.raw_input.is_some() {
            self.raw_input = tc.raw_input.clone();
        }
        if tc.raw_output.is_some() {
            self.raw_output = tc.raw_output.clone();
        }
    }
}

impl Default for PartialToolCallData {
    fn default() -> Self {
        Self {
            id: ToolCallId::new(""),
            index: 0,
            kind: ToolKind::default(),
            title: String::new(),
            status: Default::default(),
            path: None,
            content: Vec::new(),
            raw_input: None,
            raw_output: None,
        }
    }
}
