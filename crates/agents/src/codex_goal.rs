//! Session goal (`_session/goal` / `_meta.goal` / legacy `_meta.codex.goal`)
//! wire normalization, capability resolution, and synthetic timeline marker
//! projection.

use api_types::AgentKind;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::air_contract::legacy_or_air;

pub const NEUTRAL_GOAL_CONTROL_METHOD: &str = "_session/goal";
pub const LEGACY_GOAL_CONTROL_METHOD: &str = "_codex/session/goal_control";
pub const LEGACY_GOAL_ACTIONS: &[&str] = &["pause", "clear"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GoalControlReceipt {
    pub action: String,
    pub method: String,
    #[serde(default)]
    pub should_interrupt_turn: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexGoalMarker {
    pub tool_name: &'static str,
    pub title: String,
    pub status: String,
    pub objective: String,
    pub input_json: String,
    pub output_json: String,
}

/// Whether `initialize` response `_meta` advertises neutral goal support
/// (`_meta.goal.version >= 1` or `_meta.jetbrains.air.goal.version >= 1`).
pub fn init_advertises_goal(meta: Option<&Map<String, Value>>) -> bool {
    legacy_or_air(meta, "goal")
        .and_then(|goal| goal.get("version"))
        .and_then(Value::as_u64)
        .is_some_and(|version| version >= 1)
}

/// Extract `(controlMethod, actions)` from `initialize` response `_meta` when
/// neutral goal support (`version >= 1`) is advertised.
pub fn goal_advertised_control(
    meta: Option<&Map<String, Value>>,
) -> Option<(Option<String>, Vec<String>)> {
    let goal = legacy_or_air(meta, "goal")?.as_object()?;
    if goal
        .get("version")
        .and_then(Value::as_u64)
        .is_none_or(|version| version < 1)
    {
        return None;
    }
    let method = goal
        .get("controlMethod")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let actions = goal
        .get("actions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((method, actions))
}

/// Resolve the effective `(controlMethod, actions)` for a connection.
///
/// - When `initialize` advertised `_meta.goal`, use its `controlMethod` and
///   `actions` verbatim (even if `actions` is empty).
/// - When unadvertised, only `AgentKind::Codex` falls back to legacy
///   `_codex/session/goal_control` with `["pause", "clear"]`.
/// - Other agents (e.g. Claude before handshake or older versions) get `None`.
pub fn resolve_goal_control(
    agent_kind: Option<AgentKind>,
    advertised: Option<&(Option<String>, Vec<String>)>,
) -> Option<(String, Vec<String>)> {
    if let Some((method, actions)) = advertised {
        return Some((method.clone()?, actions.clone()));
    }
    if agent_kind == Some(AgentKind::Codex) {
        return Some((
            LEGACY_GOAL_CONTROL_METHOD.to_string(),
            LEGACY_GOAL_ACTIONS
                .iter()
                .map(|action| (*action).to_string())
                .collect(),
        ));
    }
    None
}

/// Whether goal control RPCs only mutate goal state out-of-band without
/// stopping or steering the active turn on the adapter side.
///
/// - Codex (`true`): `pause` only flips goal metadata; host must wait for the
///   goal RPC to succeed and then send `session/cancel`. `clear` on an `active`
///   goal must also interrupt/cancel even if host thinks the session is idle.
/// - Claude (`false`): `clear` injects `/goal clear` via adapter steering into
///   the running turn; sending `session/cancel` would abort the turn carrying
///   the clear command and leave the goal armed.
pub fn goal_control_is_out_of_band(agent_kind: Option<AgentKind>) -> bool {
    agent_kind == Some(AgentKind::Codex)
}

/// Extract the raw goal value from `SessionInfoUpdate._meta`.
///
/// When `neutral_channel` is `true` (because `initialize` advertised
/// `_meta.goal` version >= 1), legacy `_meta.codex.goal` is ignored.
pub fn session_info_goal_value(
    meta: Option<&Map<String, Value>>,
    neutral_channel: bool,
) -> Option<&Value> {
    if let Some(goal) = legacy_or_air(meta, "goal") {
        return Some(goal);
    }
    if neutral_channel {
        return None;
    }
    meta?.get("codex")?.get("goal")
}

/// Normalize `ThreadGoalStatus` values to snake_case so legacy camelCase
/// variants (`budgetLimited`, `usageLimited`) and neutral snake_case variants
/// (`budget_limited`, `usage_limited`) share one representation.
pub fn normalize_goal_status(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut out = String::with_capacity(trimmed.len() + 4);
    for (idx, ch) in trimmed.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if idx > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

pub fn normalize_goal_snapshot(goal: &Value) -> Option<Value> {
    if goal.is_null() {
        return None;
    }
    let mut obj = goal.as_object()?.clone();
    let status = obj
        .get("status")
        .and_then(Value::as_str)
        .map(normalize_goal_status)
        .filter(|value| !value.is_empty())?;
    obj.insert("status".to_string(), Value::String(status));
    Some(Value::Object(obj))
}

pub fn goal_marker(goal: &Value) -> Option<CodexGoalMarker> {
    let mut normalized = normalize_goal_snapshot(goal)?;
    let obj = normalized.as_object_mut()?;
    let status = obj.get("status")?.as_str()?.to_string();
    let objective = obj
        .get("objective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    obj.insert("objective".to_string(), Value::String(objective.clone()));
    let (tool_name, title) = match status.as_str() {
        "active" => ("create_goal", format!("Goal: {objective}")),
        "paused" => ("update_goal", format!("Goal paused: {objective}")),
        "completed" => ("update_goal", format!("Goal completed: {objective}")),
        "budget_limited" => ("update_goal", format!("Goal budget reached: {objective}")),
        "usage_limited" => ("update_goal", format!("Goal usage limit: {objective}")),
        other => ("update_goal", format!("Goal ({other}): {objective}")),
    };
    let input_json = if tool_name == "create_goal" {
        serde_json::json!({ "objective": objective }).to_string()
    } else {
        serde_json::json!({ "status": status, "objective": objective }).to_string()
    };
    let output_json = serde_json::json!({ "goal": normalized }).to_string();
    Some(CodexGoalMarker {
        tool_name,
        title,
        status,
        objective,
        input_json,
        output_json,
    })
}

pub fn next_goal_marker(
    previous: Option<&Value>,
    current: Option<&Value>,
) -> Option<CodexGoalMarker> {
    let previous = previous.and_then(normalize_goal_snapshot);
    let current = current.and_then(normalize_goal_snapshot);
    match (previous.as_ref(), current.as_ref()) {
        (None, None) => None,
        (Some(prev), Some(curr)) => {
            let prev_marker = goal_marker(prev)?;
            let curr_marker = goal_marker(curr)?;
            if prev_marker.status == curr_marker.status
                && prev_marker.objective == curr_marker.objective
            {
                None
            } else {
                Some(curr_marker)
            }
        }
        (None, Some(curr)) => goal_marker(curr),
        (Some(prev), None) => {
            let prev_marker = goal_marker(prev)?;
            let objective = prev_marker.objective;
            Some(CodexGoalMarker {
                tool_name: "update_goal",
                title: format!("Goal cleared: {objective}"),
                status: "cleared".to_string(),
                input_json: serde_json::json!({
                    "status": "cleared",
                    "objective": objective,
                })
                .to_string(),
                output_json: serde_json::json!({
                    "goal": {
                        "objective": objective,
                        "status": "cleared",
                    }
                })
                .to_string(),
                objective,
            })
        }
    }
}

/// Update `open_goal` for one live `session_info_update` goal and return the
/// synthetic timeline marker (if any).
pub fn advance_goal_marker(open_goal: &mut Option<Value>, goal: &Value) -> Option<CodexGoalMarker> {
    if goal.is_null() {
        let prev = open_goal.take();
        return next_goal_marker(prev.as_ref(), None);
    }
    let marker = next_goal_marker(open_goal.as_ref(), Some(goal));
    if marker
        .as_ref()
        .is_some_and(|item| item.tool_name == "create_goal")
    {
        *open_goal = normalize_goal_snapshot(goal);
    } else if marker.is_some() {
        *open_goal = None;
    }
    marker
}

pub fn goal_tool_call_id(sequence: u64) -> String {
    format!("codex-goal-{sequence}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn normalizes_camel_and_snake_goal_statuses() {
        assert_eq!(normalize_goal_status("active"), "active");
        assert_eq!(normalize_goal_status("paused"), "paused");
        assert_eq!(normalize_goal_status("completed"), "completed");
        assert_eq!(normalize_goal_status("budgetLimited"), "budget_limited");
        assert_eq!(normalize_goal_status("budget_limited"), "budget_limited");
        assert_eq!(normalize_goal_status("usageLimited"), "usage_limited");
        assert_eq!(normalize_goal_status("usage_limited"), "usage_limited");
    }

    #[test]
    fn init_advertisement_and_control_resolution_follow_codeg_rules() {
        let claude_meta = json!({
            "jetbrains": {
                "air": {
                    "goal": {
                        "version": 1,
                        "controlMethod": "_session/goal",
                        "actions": ["set", "clear"]
                    }
                }
            }
        });
        let map = claude_meta.as_object();
        assert!(init_advertises_goal(map));
        let adv = goal_advertised_control(map);
        assert_eq!(
            adv,
            Some((
                Some("_session/goal".to_string()),
                vec!["set".to_string(), "clear".to_string()]
            ))
        );
        assert_eq!(
            resolve_goal_control(Some(AgentKind::ClaudeCode), adv.as_ref()),
            Some((
                "_session/goal".to_string(),
                vec!["set".to_string(), "clear".to_string()]
            ))
        );

        // Before handshake or when unadvertised, Claude never gets Codex fallback:
        assert_eq!(
            resolve_goal_control(Some(AgentKind::ClaudeCode), None),
            None
        );

        // Unadvertised Codex falls back to legacy method + pause/clear:
        assert_eq!(
            resolve_goal_control(Some(AgentKind::Codex), None),
            Some((
                "_codex/session/goal_control".to_string(),
                vec!["pause".to_string(), "clear".to_string()]
            ))
        );

        // Advertised empty actions preserves empty actions:
        let empty_adv = Some((Some("_session/goal".to_string()), Vec::<String>::new()));
        assert_eq!(
            resolve_goal_control(Some(AgentKind::Codex), empty_adv.as_ref()),
            Some(("_session/goal".to_string(), Vec::new()))
        );
    }

    #[test]
    fn neutral_channel_ignores_legacy_codex_goal_field() {
        let meta = json!({
            "codex": {
                "goal": {
                    "status": "active",
                    "objective": "legacy"
                }
            }
        });
        let map = meta.as_object();
        assert!(session_info_goal_value(map, true).is_none());
        assert!(session_info_goal_value(map, false).is_some());
    }

    #[test]
    fn suppresses_duplicate_progress_snapshots_and_marks_transitions() {
        let first = json!({
            "status": "active",
            "objective": "ship the patch",
            "tokensUsed": 100
        });
        let progress = json!({
            "status": "active",
            "objective": "ship the patch",
            "tokensUsed": 450
        });
        let budget = json!({
            "status": "budgetLimited",
            "objective": "ship the patch",
            "tokensUsed": 1000,
            "tokenBudget": 1000
        });

        let created = next_goal_marker(None, Some(&first)).expect("initial marker");
        assert_eq!(created.tool_name, "create_goal");
        assert_eq!(created.status, "active");

        assert!(next_goal_marker(Some(&first), Some(&progress)).is_none());

        let limited = next_goal_marker(Some(&progress), Some(&budget)).expect("status transition");
        assert_eq!(limited.tool_name, "update_goal");
        assert_eq!(limited.status, "budget_limited");

        let cleared = next_goal_marker(Some(&budget), Some(&Value::Null)).expect("clear marker");
        assert_eq!(cleared.tool_name, "update_goal");
        assert_eq!(cleared.status, "cleared");
        assert_eq!(cleared.title, "Goal cleared: ship the patch");
    }

    #[test]
    fn two_runs_of_same_objective_receive_distinct_tool_call_ids() {
        assert_ne!(goal_tool_call_id(1), goal_tool_call_id(2));
        assert_eq!(goal_tool_call_id(1), "codex-goal-1");
        assert_eq!(goal_tool_call_id(2), "codex-goal-2");
    }
}
