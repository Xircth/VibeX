use super::*;

pub(in crate::manager) fn merge_session_mode_states(
    standard: Option<SessionModeState>,
    vendor: Option<SessionModeState>,
) -> Option<SessionModeState> {
    match (standard, vendor) {
        (None, vendor) => vendor,
        (standard, None) => standard,
        (Some(standard), Some(vendor)) => {
            let mut modes = standard.available_modes;
            for mode in vendor.available_modes {
                if !modes.iter().any(|existing| existing.id == mode.id) {
                    modes.push(mode);
                }
            }
            Some(SessionModeState::new(standard.current_mode_id, modes))
        }
    }
}

pub(in crate::manager) fn merge_session_config_options(
    standard: Vec<AcpSessionConfigOption>,
    vendor: Vec<AcpSessionConfigOption>,
) -> Vec<AcpSessionConfigOption> {
    let mut options = standard;
    for option in vendor {
        if let Some(existing) = options.iter_mut().find(|existing| {
            existing.id == option.id || session_config_options_overlap(existing, &option)
        }) {
            // Grok advertises standard `reasoning_effort` *and* vendor Low/High
            // Effort. Dropping the vendor list removes `low` and then applying a
            // remembered `reasoning_effort=low` (prompt enhancement / last-used)
            // surfaces as `config_choice_not_found`.
            merge_select_choices(existing, &option);
            continue;
        }
        options.push(option);
    }
    options
}

pub(in crate::manager) fn merge_select_choices(into: &mut AcpSessionConfigOption, from: &AcpSessionConfigOption) {
    let SessionConfigKind::Select(from_select) = &from.kind else {
        return;
    };
    let SessionConfigKind::Select(into_select) = &mut into.kind else {
        return;
    };
    let from_choices = match &from_select.options {
        SessionConfigSelectOptions::Ungrouped(choices) => choices,
        SessionConfigSelectOptions::Grouped(groups) => {
            let SessionConfigSelectOptions::Ungrouped(into_choices) = &mut into_select.options
            else {
                return;
            };
            for choice in groups.iter().flat_map(|group| group.options.iter()) {
                push_unique_select_choice(into_choices, choice.clone());
            }
            return;
        }
        #[allow(unreachable_patterns)]
        _ => return,
    };
    match &mut into_select.options {
        SessionConfigSelectOptions::Ungrouped(into_choices) => {
            for choice in from_choices {
                push_unique_select_choice(into_choices, choice.clone());
            }
        }
        SessionConfigSelectOptions::Grouped(groups) => {
            for choice in from_choices {
                if groups
                    .iter()
                    .flat_map(|group| group.options.iter())
                    .any(|existing| existing.value == choice.value)
                {
                    continue;
                }
                if let Some(group) = groups.first_mut() {
                    group.options.push(choice.clone());
                }
            }
        }
        #[allow(unreachable_patterns)]
        _ => {}
    }
}

pub(in crate::manager) fn push_unique_select_choice(
    choices: &mut Vec<SessionConfigSelectOption>,
    choice: SessionConfigSelectOption,
) {
    if choices
        .iter()
        .any(|existing| existing.value == choice.value)
    {
        return;
    }
    choices.push(choice);
}

pub(in crate::manager) fn session_config_options_overlap(
    left: &AcpSessionConfigOption,
    right: &AcpSessionConfigOption,
) -> bool {
    config_option_is_thought_level(left) && config_option_is_thought_level(right)
}

pub(in crate::manager) fn config_option_is_thought_level(option: &AcpSessionConfigOption) -> bool {
    config_option_matches(option, "thought_level")
}

/// Parse grok's `_meta["x.ai/sessionConfig"]` extension
/// (`{options: [{id, category, label, description?, selected}]}`).
///
/// Grok's `mode` category is reasoning effort (`xhigh` / `high` / `medium` /
/// `low`), not ACP session permission modes. Emit it as a `thought_level`
/// config option so the shared summary shows Model · 高 instead of hiding it
/// behind a Mode row. Permission options stay ACP session modes so the
/// existing bypass-permissions safety gate still applies. Effort changes are
/// applied with `session/set_mode`; model changes use `session/set_model`.
pub(in crate::manager) fn vendor_session_controls_from_meta(
    meta: &serde_json::Map<String, serde_json::Value>,
) -> Option<VendorSessionControls> {
    let session_config = meta.get("x.ai/sessionConfig")?.as_object()?;
    let options = session_config.get("options")?.as_array()?;
    if options.is_empty() {
        return None;
    }

    let mut model_options: Vec<SessionConfigSelectOption> = Vec::new();
    let mut selected_model: Option<String> = None;
    let mut effort_options: Vec<SessionConfigSelectOption> = Vec::new();
    let mut selected_effort: Option<String> = None;
    let mut permission_modes: Vec<acp::schema::v1::SessionMode> = Vec::new();
    let mut selected_permission: Option<String> = None;

    for raw in options {
        let Some(option) = raw.as_object() else {
            continue;
        };
        let Some(id) = option
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
        else {
            continue;
        };
        let label = option
            .get("label")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| id.clone());
        let description = option
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string);
        let selected = option
            .get("selected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let category = option.get("category").and_then(serde_json::Value::as_str);
        match classify_vendor_session_option(category, &id, &label) {
            VendorSessionOptionKind::Model => {
                model_options.push(vendor_select_choice(id.clone(), label, description));
                if selected {
                    selected_model = Some(id);
                }
            }
            VendorSessionOptionKind::Effort => {
                effort_options.push(vendor_select_choice(id.clone(), label, description));
                if selected {
                    selected_effort = Some(id);
                }
            }
            VendorSessionOptionKind::Permission => {
                let mut mode = acp::schema::v1::SessionMode::new(id.clone(), label);
                if let Some(description) = description {
                    mode = mode.description(description);
                }
                permission_modes.push(mode);
                if selected {
                    selected_permission = Some(id);
                }
            }
            VendorSessionOptionKind::Unknown => {}
        }
    }

    let mut config_options = Vec::new();
    if !model_options.is_empty() {
        let current = selected_model.unwrap_or_else(|| model_options[0].value.0.to_string());
        config_options.push(
            AcpSessionConfigOption::select(
                "model",
                "Model",
                current,
                SessionConfigSelectOptions::Ungrouped(model_options),
            )
            .category(SessionConfigOptionCategory::Model),
        );
    }
    if !effort_options.is_empty() {
        let current = selected_effort.unwrap_or_else(|| effort_options[0].value.0.to_string());
        config_options.push(
            AcpSessionConfigOption::select(
                "effort",
                "推理强度",
                current,
                SessionConfigSelectOptions::Ungrouped(effort_options),
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        );
    }
    let modes = if permission_modes.is_empty() {
        None
    } else {
        let current = selected_permission.unwrap_or_else(|| permission_modes[0].id.0.to_string());
        Some(SessionModeState::new(current, permission_modes))
    };
    if config_options.is_empty() && modes.is_none() {
        return None;
    }
    Some(VendorSessionControls {
        modes,
        config_options,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) enum VendorSessionOptionKind {
    Model,
    Effort,
    Permission,
    Unknown,
}

pub(in crate::manager) fn classify_vendor_session_option(
    category: Option<&str>,
    id: &str,
    label: &str,
) -> VendorSessionOptionKind {
    // Inspect each field on its own. Concatenating `mode` + `low` produces
    // `modelow`, which contains `model` and would steal Grok's Low Effort
    // choice into the Model selector.
    let category = normalize_config_token(category.unwrap_or_default());
    let id = normalize_config_token(id);
    let label = normalize_config_token(label);
    if vendor_token_contains_any(&[&category, &id, &label], "model") {
        return VendorSessionOptionKind::Model;
    }
    if vendor_token_contains_any(&[&category, &id, &label], "permission")
        || vendor_token_contains_any(&[&category, &id, &label], "approval")
        || matches!(
            id.as_str(),
            "default" | "acceptedits" | "auto" | "dontask" | "bypasspermissions" | "plan"
        )
    {
        return VendorSessionOptionKind::Permission;
    }
    if matches!(
        category.as_str(),
        "mode" | "effort" | "thought" | "thoughtlevel" | "reasoning"
    ) || vendor_token_contains_any(&[&category, &id, &label], "effort")
        || vendor_token_contains_any(&[&category, &id, &label], "thought")
        || vendor_token_contains_any(&[&category, &id, &label], "reason")
        || matches!(
            id.as_str(),
            "ultra" | "max" | "xhigh" | "high" | "medium" | "low" | "minimal"
        )
    {
        return VendorSessionOptionKind::Effort;
    }
    VendorSessionOptionKind::Unknown
}

pub(in crate::manager) fn vendor_token_contains_any(tokens: &[&str], needle: &str) -> bool {
    tokens.iter().any(|token| token.contains(needle))
}

pub(in crate::manager) fn vendor_select_choice(
    id: String,
    label: String,
    description: Option<String>,
) -> SessionConfigSelectOption {
    let mut choice = SessionConfigSelectOption::new(id, label);
    if let Some(description) = description {
        choice = choice.description(description);
    }
    choice
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn agent_session_modes_from_acp(
    state: SessionModeState,
) -> (Vec<AgentSessionMode>, Option<String>) {
    let current = Some(state.current_mode_id.0.to_string());
    let modes = state
        .available_modes
        .into_iter()
        .map(|mode| AgentSessionMode {
            id: mode.id.0.to_string(),
            label: mode.name,
            description: mode.description,
        })
        .collect();
    (modes, current)
}

pub(crate) fn agent_session_config_options_from_acp(
    options: Vec<AcpSessionConfigOption>,
) -> Vec<AgentSessionConfigOption> {
    options
        .into_iter()
        .map(agent_session_config_option_from_acp)
        .collect()
}

pub(in crate::manager) fn agent_session_config_option_from_acp(
    option: AcpSessionConfigOption,
) -> AgentSessionConfigOption {
    let (value, choices) = match option.kind {
        SessionConfigKind::Select(select) => (
            Some(serde_json::Value::String(
                select.current_value.0.to_string(),
            )),
            agent_session_config_choices_from_acp(select.options),
        ),
        SessionConfigKind::Boolean(boolean) => (
            Some(serde_json::Value::Bool(boolean.current_value)),
            vec![
                AgentSessionConfigChoice {
                    value: serde_json::Value::Bool(false),
                    label: "Off".to_string(),
                    description: None,
                },
                AgentSessionConfigChoice {
                    value: serde_json::Value::Bool(true),
                    label: "On".to_string(),
                    description: None,
                },
            ],
        ),
        #[allow(unreachable_patterns)]
        _ => (None, Vec::new()),
    };

    AgentSessionConfigOption {
        key: option.id.0.to_string(),
        label: option.name,
        description: option.description,
        // Serialized form of the ACP category enum ("mode" / "model" / …).
        category: option.category.as_ref().and_then(|category| {
            serde_json::to_value(category)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
        }),
        value,
        choices,
        dependency: None,
    }
}

pub(in crate::manager) fn agent_session_config_choices_from_acp(
    options: SessionConfigSelectOptions,
) -> Vec<AgentSessionConfigChoice> {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .into_iter()
            .map(agent_session_config_choice_from_acp)
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .into_iter()
            .flat_map(|group| group.options.into_iter())
            .map(agent_session_config_choice_from_acp)
            .collect(),
        #[allow(unreachable_patterns)]
        _ => Vec::new(),
    }
}

pub(in crate::manager) fn agent_session_config_choice_from_acp(
    option: SessionConfigSelectOption,
) -> AgentSessionConfigChoice {
    AgentSessionConfigChoice {
        value: serde_json::Value::String(option.value.0.to_string()),
        label: option.name,
        description: option.description,
    }
}

pub(in crate::manager) fn agent_available_commands_from_acp(
    commands: Vec<AcpAvailableCommand>,
) -> Vec<AgentAvailableCommand> {
    commands
        .into_iter()
        .map(|command| AgentAvailableCommand {
            name: command.name,
            description: Some(command.description),
            input_schema: command
                .input
                .and_then(|input| serde_json::to_value(input).ok()),
        })
        .collect()
}

pub(in crate::manager) fn agent_permission_option_kind(kind: PermissionOptionKind) -> AgentPermissionOptionKind {
    match kind {
        PermissionOptionKind::AllowOnce => AgentPermissionOptionKind::AllowOnce,
        PermissionOptionKind::AllowAlways => AgentPermissionOptionKind::AllowAlways,
        PermissionOptionKind::RejectOnce => AgentPermissionOptionKind::RejectOnce,
        PermissionOptionKind::RejectAlways => AgentPermissionOptionKind::RejectAlways,
        #[allow(unreachable_patterns)]
        _ => AgentPermissionOptionKind::Unknown,
    }
}

pub(in crate::manager) fn permission_response_outcome(response: AgentPermissionResponse) -> RequestPermissionOutcome {
    match response {
        AgentPermissionResponse::Selected { option_id, .. } => {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        }
        AgentPermissionResponse::Cancelled => RequestPermissionOutcome::Cancelled,
    }
}

pub(in crate::manager) fn elicitation_response_action(response: AgentElicitationResponse) -> ElicitationAction {
    match response {
        AgentElicitationResponse::Accept { content } => {
            // The wire type only admits primitive values; anything else the UI
            // slipped in is dropped rather than failing the whole answer.
            let validated = content
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(key, value)| {
                            serde_json::from_value::<ElicitationContentValue>(value.clone())
                                .ok()
                                .map(|value| (key.clone(), value))
                        })
                        .collect::<std::collections::BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            ElicitationAction::Accept(ElicitationAcceptAction::new().content(validated))
        }
        AgentElicitationResponse::Decline => ElicitationAction::Decline,
        AgentElicitationResponse::Cancel => ElicitationAction::Cancel,
    }
}

