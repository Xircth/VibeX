use agents::{
    AgentId, AgentKind, AgentSessionConfigOverride, AgentSessionControlsSnapshot,
    SessionControlPreferences,
};
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use sqlx::SqlitePool;

/// What a freshly established session still needs in order to match the
/// conversation's remembered selection.
#[derive(Debug, Default, PartialEq, Eq)]
pub(in crate::service) struct SessionControlReplayPlan {
    pub(in crate::service) mode: Option<String>,
    pub(in crate::service) config_overrides: Vec<AgentSessionConfigOverride>,
}

/// Diff the remembered selection against what the session currently advertises.
///
/// Only genuine differences are replayed. Re-sending a value the session already
/// holds is not free: some agents rebuild dependent config options on every
/// `session/set_config_option`, so a redundant replay on each session establishment
/// would churn the very controls it is meant to preserve.
pub(in crate::service) fn session_control_replay_plan(
    remembered_mode: Option<String>,
    remembered_config: Vec<AgentSessionConfigOverride>,
    current: &AgentSessionControlsSnapshot,
) -> SessionControlReplayPlan {
    SessionControlReplayPlan {
        mode: remembered_mode.filter(|mode| current.current_mode.as_deref() != Some(mode.as_str())),
        config_overrides: remembered_config
            .into_iter()
            .filter(|selection| {
                !current.config_options.iter().any(|option| {
                    option.key == selection.key
                        && option.value.as_ref().and_then(|value| value.as_str())
                            == Some(selection.value.as_str())
                })
            })
            .collect(),
    }
}

/// Conversation selection wins per key over the agent's last-used / settings
/// defaults (CodeG `getSavedPrefsForConnect`).
pub(in crate::service) fn session_control_preferences(
    binding: Option<&ConversationAgentBindingRecord>,
    agent_defaults: &[(String, serde_json::Value)],
) -> SessionControlPreferences {
    let mut config = Vec::new();
    for (key, value) in agent_defaults {
        if key == "mode" {
            continue;
        }
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        if value.is_empty() {
            continue;
        }
        config.push(AgentSessionConfigOverride {
            key: key.clone(),
            value,
        });
    }
    for override_item in binding_config_selection(binding) {
        if let Some(existing) = config
            .iter_mut()
            .find(|existing| existing.key == override_item.key)
        {
            existing.value = override_item.value;
        } else {
            config.push(override_item);
        }
    }
    let mode = binding_mode_selection(binding).or_else(|| {
        agent_defaults.iter().find_map(|(key, value)| {
            (key == "mode")
                .then(|| value.as_str().map(str::to_string))
                .flatten()
        })
    });
    SessionControlPreferences {
        mode,
        config,
        wants_prompt_suggestions: false,
    }
}

pub(in crate::service) async fn session_wants_prompt_suggestions(
    pool: &SqlitePool,
    session: &Session,
) -> bool {
    if session.parent_session_id.is_some() || session.delegation_call_id.is_some() {
        return false;
    }
    let is_non_composer_child: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1
           FROM conversation_relations
           WHERE child_conversation_id = ?
             AND (kind IN ('delegation', 'workflow_step') OR visibility = 'hidden')
           LIMIT 1"#,
    )
    .bind(session.id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    is_non_composer_child.is_none()
}

pub(in crate::service) fn binding_mode_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Option<String> {
    binding
        .and_then(|binding| binding.current_mode.clone())
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
}

pub(in crate::service) fn binding_config_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Vec<AgentSessionConfigOverride> {
    binding
        .and_then(|binding| {
            let trimmed = binding.config_selection_json.trim();
            if trimmed.is_empty() {
                return None;
            }
            match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(trimmed) {
                Ok(map) => Some(map),
                Err(error) => {
                    tracing::warn!(
                        binding_id = %binding.id,
                        conversation_id = %binding.conversation_id,
                        %error,
                        "invalid config_selection_json on conversation binding; ignoring"
                    );
                    None
                }
            }
        })
        .map(|selection| {
            selection
                .into_iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| AgentSessionConfigOverride {
                        key,
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(in crate::service) fn apply_preferences_to_controls_snapshot(
    controls: &mut AgentSessionControlsSnapshot,
    preferences: &SessionControlPreferences,
) {
    if let Some(mode) = preferences
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        && controls.modes.iter().any(|candidate| candidate.id == mode)
    {
        controls.current_mode = Some(mode.to_string());
    }
    for override_item in &preferences.config {
        let key = override_item.key.trim();
        let val = override_item.value.trim();
        if key.is_empty() || val.is_empty() {
            continue;
        }
        if let Some(opt) = controls.config_options.iter_mut().find(|o| o.key == key) {
            let valid =
                opt.choices.is_empty() || opt.choices.iter().any(|choice| choice.value == val);
            if valid {
                opt.value = Some(serde_json::Value::String(val.to_string()));
            }
        }
    }
}

pub(in crate::service) fn is_placeholder_acp_session_id(id: &str) -> bool {
    agents::is_placeholder_acp_session_id(id)
}

pub(in crate::service) fn resolve_agent_id_from_executor(
    executor: Option<&str>,
) -> Option<AgentId> {
    let raw = executor?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("agent") {
        return None;
    }
    AgentKind::from_lenient(raw)
        .and_then(|kind| AgentId::parse(kind.as_str()).ok())
        .or_else(|| AgentId::parse(raw).ok())
}
