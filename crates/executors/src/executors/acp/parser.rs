use agent_client_protocol::schema::{SessionNotification, SessionUpdate};

use super::AcpEvent;

pub(super) fn parse_event_line(line: &str) -> Option<AcpEvent> {
    let trimmed = line.trim();

    if let Ok(acp_event) = serde_json::from_str::<AcpEvent>(trimmed) {
        return Some(acp_event);
    }

    tracing::debug!("Failed to parse ACP raw log {trimmed}");

    None
}

pub(super) fn parse_execute_command(title: &str, raw_input: Option<&serde_json::Value>) -> String {
    if let Some(command) = raw_input.and_then(|value| {
        value
            .as_object()
            .and_then(|object| object.get("command").and_then(|value| value.as_str()))
    }) {
        return command.to_string();
    }

    if let Some((command, _)) = title.split_once(" [current working directory ") {
        command.trim().to_string()
    } else if let Some((command, _)) = title.split_once(" (") {
        command.trim().to_string()
    } else {
        title.trim().to_string()
    }
}

impl TryFrom<SessionNotification> for AcpEvent {
    type Error = ();

    fn try_from(notification: SessionNotification) -> Result<Self, ()> {
        let event = match notification.update {
            SessionUpdate::AgentMessageChunk(chunk) => AcpEvent::Message(chunk.content),
            SessionUpdate::AgentThoughtChunk(chunk) => AcpEvent::Thought(chunk.content),
            SessionUpdate::ToolCall(tc) => AcpEvent::ToolCall(tc),
            SessionUpdate::ToolCallUpdate(update) => AcpEvent::ToolUpdate(update),
            SessionUpdate::Plan(plan) => AcpEvent::Plan(plan),
            SessionUpdate::UsageUpdate(update) => AcpEvent::Usage {
                used: update.used,
                size: update.size,
            },
            SessionUpdate::AvailableCommandsUpdate(update) => {
                AcpEvent::AvailableCommands(update.available_commands)
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                AcpEvent::CurrentMode(update.current_mode_id)
            }
            _ => return Err(()),
        };
        Ok(event)
    }
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::{ContentBlock, TextContent};
    use serde_json::json;

    use super::{parse_event_line, parse_execute_command};
    use crate::executors::acp::AcpEvent;

    #[test]
    fn parse_event_line_accepts_trimmed_serialized_acp_event() {
        let line = format!(
            "  {}  ",
            AcpEvent::Message(ContentBlock::Text(TextContent::new("hello")))
        );

        let parsed = parse_event_line(&line).expect("parsed event");

        let AcpEvent::Message(ContentBlock::Text(text)) = parsed else {
            panic!("expected message event");
        };
        assert_eq!(text.text, "hello");
    }

    #[test]
    fn parse_event_line_rejects_non_event_lines() {
        assert!(parse_event_line("not json").is_none());
    }

    #[test]
    fn parse_execute_command_prefers_raw_input_command() {
        let command = parse_execute_command(
            "ignored title",
            Some(&json!({ "command": "cargo test -p executors" })),
        );

        assert_eq!(command, "cargo test -p executors");
    }

    #[test]
    fn parse_execute_command_strips_known_title_suffixes() {
        assert_eq!(
            parse_execute_command("pnpm run check [current working directory C:/repo]", None),
            "pnpm run check"
        );
        assert_eq!(
            parse_execute_command("cargo check (running in C:/repo)", None),
            "cargo check"
        );
    }
}
