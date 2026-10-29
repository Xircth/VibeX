use super::*;

pub(in crate::manager) fn records_acp_jsonl(_agent_id: &str) -> bool {
    true
}

pub(in crate::manager) fn jsonl_agent_dir(agent_id: &str) -> String {
    let raw = crate::AgentKind::from_lenient(agent_id)
        .map(|kind| kind.as_str().to_string())
        .unwrap_or_else(|| agent_id.to_string());
    if crate::acp_transcript::safe_component(&raw) {
        raw
    } else {
        "session".to_string()
    }
}

/// Whether a `session/update` carries conversation transcript content (as opposed to
/// session control state). Only transcript content is replayed by `session/load` and
/// `session/resume`, and only it must be gated during session establishment.
pub(in crate::manager) fn is_session_transcript_update(update: &SessionUpdate) -> bool {
    matches!(
        update,
        SessionUpdate::AgentMessageChunk(_)
            | SessionUpdate::AgentThoughtChunk(_)
            | SessionUpdate::UserMessageChunk(_)
            | SessionUpdate::ToolCall(_)
            | SessionUpdate::ToolCallUpdate(_)
            | SessionUpdate::Plan(_)
    )
}

