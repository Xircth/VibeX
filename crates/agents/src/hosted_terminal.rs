//! Bridge Codex/Pi self-hosted terminal `_meta` onto the tool-card output
//! stream. Codex AIR streams `_meta.terminal_output_delta`; Pi uses
//! `_meta.terminal_output`. Keys are unnamespaced, so this is gated on
//! AgentKind.

use api_types::AgentKind;
use serde_json::Map;

/// The `_meta` key this adapter streams self-hosted terminal output under.
pub(crate) fn hosted_terminal_output_key(agent_kind: AgentKind) -> Option<&'static str> {
    match agent_kind {
        AgentKind::Pi => Some("terminal_output"),
        AgentKind::Codex => Some("terminal_output_delta"),
        _ => None,
    }
}

/// True when this frame names a self-hosted shell (`_meta.terminal_info`).
/// The opening frame is the one that carries that marker; later frames
/// keep the id on the host's tracked set.
pub(crate) fn hosted_terminal_meta_marks_shell(
    agent_kind: AgentKind,
    meta: Option<&Map<String, serde_json::Value>>,
) -> bool {
    if hosted_terminal_output_key(agent_kind).is_none() {
        return false;
    }
    meta.is_some_and(|meta| meta.get("terminal_info").is_some_and(|v| v.is_object()))
}

/// Incremental output chunk (plus Codex stdin, rendered where it was typed).
pub(crate) fn hosted_terminal_output_delta(
    agent_kind: AgentKind,
    meta: Option<&Map<String, serde_json::Value>>,
) -> Option<String> {
    let key = hosted_terminal_output_key(agent_kind)?;
    let meta = meta?;
    let data = |key: &str| {
        meta.get(key)?
            .get("data")?
            .as_str()
            .filter(|data| !data.is_empty())
    };
    let output = data(key).map(str::to_string);
    let stdin = (agent_kind == AgentKind::Codex)
        .then(|| data("terminal_input"))
        .flatten()
        .map(|input| format!("\n{input}\n"));
    match (output, stdin) {
        (Some(output), Some(stdin)) => Some(output + &stdin),
        (output, stdin) => output.or(stdin),
    }
}

/// `[terminal exited: …]` line for `_meta.terminal_exit`.
pub(crate) fn hosted_terminal_exit_line(
    agent_kind: AgentKind,
    meta: Option<&Map<String, serde_json::Value>>,
) -> Option<String> {
    hosted_terminal_output_key(agent_kind)?;
    let exit = meta?.get("terminal_exit")?.as_object()?;
    let code = exit.get("exit_code").and_then(serde_json::Value::as_i64);
    let signal = exit
        .get("signal")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let formatted = match (code, signal.as_deref()) {
        (Some(code), Some(signal)) => format!("exit code: {code}, signal: {signal}"),
        (Some(code), None) => format!("exit code: {code}"),
        (None, Some(signal)) => format!("signal: {signal}"),
        (None, None) => "finished".to_string(),
    };
    Some(format!("[terminal exited: {formatted}]"))
}

/// Combine this frame's delta and optional exit line into one output chunk.
pub(crate) fn hosted_terminal_frame_chunk(
    agent_kind: AgentKind,
    meta: Option<&Map<String, serde_json::Value>>,
) -> Option<String> {
    let mut chunk = hosted_terminal_output_delta(agent_kind, meta).unwrap_or_default();
    if let Some(exit_line) = hosted_terminal_exit_line(agent_kind, meta) {
        if !chunk.is_empty() && !chunk.ends_with('\n') {
            chunk.push('\n');
        }
        chunk.push_str(&exit_line);
    }
    (!chunk.is_empty()).then_some(chunk)
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};

    use super::*;

    fn obj(value: serde_json::Value) -> Map<String, serde_json::Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn codex_reads_terminal_output_delta_and_stdin() {
        let stdin = obj(json!({
            "terminal_input": {"data": "yes", "terminal_id": "cmd-1"},
        }));
        assert_eq!(
            hosted_terminal_output_delta(AgentKind::Codex, Some(&stdin)).as_deref(),
            Some("\nyes\n")
        );

        let both = obj(json!({
            "terminal_output_delta": {"data": "Continue? ", "terminal_id": "cmd-1"},
            "terminal_input": {"data": "yes", "terminal_id": "cmd-1"},
        }));
        assert_eq!(
            hosted_terminal_output_delta(AgentKind::Codex, Some(&both)).as_deref(),
            Some("Continue? \nyes\n")
        );
        assert_eq!(
            hosted_terminal_output_delta(AgentKind::Pi, Some(&stdin)),
            None
        );
    }

    #[test]
    fn codex_exit_line_uses_snake_case_exit_code() {
        let meta = obj(json!({
            "terminal_exit": {"exit_code": 1, "signal": null, "terminal_id": "cmd-1"},
        }));
        assert_eq!(
            hosted_terminal_exit_line(AgentKind::Codex, Some(&meta)).as_deref(),
            Some("[terminal exited: exit code: 1]")
        );
    }

    #[test]
    fn terminal_info_marks_a_hosted_shell_for_codex_and_pi() {
        let meta = obj(json!({"terminal_info": {"terminal_id": "cmd-1", "cwd": "/w"}}));
        assert!(hosted_terminal_meta_marks_shell(
            AgentKind::Codex,
            Some(&meta)
        ));
        assert!(hosted_terminal_meta_marks_shell(AgentKind::Pi, Some(&meta)));
        assert!(!hosted_terminal_meta_marks_shell(
            AgentKind::ClaudeCode,
            Some(&meta)
        ));
        assert!(!hosted_terminal_meta_marks_shell(AgentKind::Codex, None));
    }

    #[test]
    fn pi_reads_terminal_output_not_delta() {
        let meta = obj(json!({
            "terminal_output": {"data": "ok\n", "terminal_id": "bash-1"},
        }));
        assert_eq!(
            hosted_terminal_output_delta(AgentKind::Pi, Some(&meta)).as_deref(),
            Some("ok\n")
        );
        assert_eq!(
            hosted_terminal_output_delta(AgentKind::Codex, Some(&meta)),
            None
        );
    }
}
