use super::*;

/// Session controls synthesized from a vendor `_meta` extension. The standard
/// ACP response fields remain authoritative when present; this only covers
/// agents that advertise their config through `_meta` instead.
pub(in crate::manager) struct VendorSessionControls {
    pub(in crate::manager) modes: Option<SessionModeState>,
    pub(in crate::manager) config_options: Vec<AcpSessionConfigOption>,
}

pub(in crate::manager) fn current_grok_model_id(
    options: &[AcpSessionConfigOption],
) -> Option<String> {
    options.iter().find_map(|option| {
        if option.category != Some(SessionConfigOptionCategory::Model) {
            return None;
        }
        match &option.kind {
            SessionConfigKind::Select(select) => Some(select.current_value.0.to_string()),
            _ => None,
        }
    })
}

/// Prefer the standard ACP `modes`/`configOptions` fields and only fall back
/// to a vendor `_meta` extension when the agent advertised neither (Grok
/// currently). The returned wire marker tells the apply path which
/// non-standard method (if any) the agent expects for changes.
pub(in crate::manager) fn session_controls_with_vendor_fallback(
    modes: Option<SessionModeState>,
    config_options: Option<Vec<AcpSessionConfigOption>>,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> (
    Option<SessionModeState>,
    Option<Vec<AcpSessionConfigOption>>,
    Option<VendorConfigWire>,
) {
    // Grok often advertises a standard model `configOption` *and* puts effort
    // / permission in `_meta`. Skipping the vendor map whenever any standard
    // field is present drops those extra dimensions from the create-session
    // and workflow summaries.
    match meta.and_then(vendor_session_controls_from_meta) {
        Some(vendor) => (
            merge_session_mode_states(modes, vendor.modes),
            Some(merge_session_config_options(
                config_options.unwrap_or_default(),
                vendor.config_options,
            )),
            Some(VendorConfigWire::XaiSessionConfig),
        ),
        None => (modes, config_options, None),
    }
}

pub(in crate::manager) fn session_controls_with_models_and_vendor_fallback(
    modes: Option<SessionModeState>,
    config_options: Option<Vec<AcpSessionConfigOption>>,
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
    raw_models: Option<&serde_json::Value>,
    agent_id: &str,
) -> (
    Option<SessionModeState>,
    Option<Vec<AcpSessionConfigOption>>,
    Option<VendorConfigWire>,
) {
    let (mut modes, mut config_options, mut vendor_config) =
        session_controls_with_vendor_fallback(modes, config_options, meta);
    // Kiro publishes its catalog only in top-level `models`. Other agents may
    // still send that field (Antigravity 1.4+ keeps variant ids next to a
    // standard family `model` selector). Synthesizing a Kiro wire surface for
    // them would send `session/set_model` with a family id the variant list
    // does not contain.
    if AgentKind::Kiro.matches_id(agent_id) {
        if let Some(kiro_model) = synthesize_kiro_model_option(raw_models) {
            let mut options = config_options.unwrap_or_default();
            if !options.iter().any(|opt| {
                opt.id.0.as_ref() == KIRO_MODEL_OPTION_ID
                    || opt.category.as_ref() == Some(&SessionConfigOptionCategory::Model)
            }) {
                options.push(kiro_model);
            }
            config_options = Some(options);
        }
        if vendor_config.is_none() {
            vendor_config = Some(VendorConfigWire::KiroSessionConfig);
        }
    }
    if AgentKind::Omp.matches_id(agent_id) {
        if let Some(ref mut mode_state) = modes {
            ensure_omp_yolo_session_mode(mode_state);
        }
        if let Some(ref mut options) = config_options {
            ensure_omp_yolo_config_option(options);
        }
    }
    (modes, config_options, vendor_config)
}

pub(in crate::manager) const OMP_YOLO_MODE_ID: &str = "yolo";
pub(in crate::manager) const OMP_YOLO_MODE_NAME: &str = "YOLO";
pub(in crate::manager) const OMP_YOLO_MODE_DESCRIPTION: &str =
    "Auto-approve all tool calls without confirmation";

pub(in crate::manager) fn ensure_omp_yolo_session_mode(modes: &mut SessionModeState) {
    if !modes
        .available_modes
        .iter()
        .any(|mode| mode.id.0.as_ref() == OMP_YOLO_MODE_ID)
    {
        modes.available_modes.push(
            acp::schema::v1::SessionMode::new(OMP_YOLO_MODE_ID, OMP_YOLO_MODE_NAME)
                .description(OMP_YOLO_MODE_DESCRIPTION.to_string()),
        );
    }
}

pub(in crate::manager) fn ensure_omp_yolo_config_option(options: &mut [AcpSessionConfigOption]) {
    let yolo_choice = vendor_select_choice(
        OMP_YOLO_MODE_ID.to_string(),
        OMP_YOLO_MODE_NAME.to_string(),
        Some(OMP_YOLO_MODE_DESCRIPTION.to_string()),
    );
    for option in options {
        if option.category != Some(SessionConfigOptionCategory::Mode)
            && option.id.0.as_ref() != "mode"
        {
            continue;
        }
        if let SessionConfigKind::Select(select) = &mut option.kind {
            match &mut select.options {
                SessionConfigSelectOptions::Ungrouped(choices) => {
                    push_unique_select_choice(choices, yolo_choice.clone());
                }
                SessionConfigSelectOptions::Grouped(groups) => {
                    let exists = groups
                        .iter()
                        .flat_map(|group| group.options.iter())
                        .any(|choice| choice.value.0.as_ref() == OMP_YOLO_MODE_ID);
                    if !exists && let Some(group) = groups.first_mut() {
                        group.options.push(yolo_choice.clone());
                    }
                }
                #[allow(unreachable_patterns)]
                _ => {}
            }
        }
    }
}

/// The model ids a session-establishing answer lists in its raw top-level
/// `models` (`availableModels[].modelId`). Empty when the answer carries no
/// such list; an entry without a non-empty string id is skipped.
pub(in crate::manager) fn session_model_ids(models: Option<&serde_json::Value>) -> Vec<String> {
    models
        .and_then(|models| models.get("availableModels"))
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("modelId")?.as_str())
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a saved model pick the selector no longer lists is one the agent
/// still takes: Google Antigravity's, when the same answer's flat model list
/// ([`session_model_ids`]) names it.
///
/// Antigravity 1.4.0 groups the picker into a family `model` row plus a
/// `thinking_level` select, while the flat `models` list keeps every variant
/// id 1.3.0 listed. Its `set_config_option` still accepts those variant ids
/// and maps them onto family + level.
pub(in crate::manager) fn session_model_list_offers(
    agent_kind: Option<AgentKind>,
    option: &AcpSessionConfigOption,
    value: &str,
    session_model_ids: &[String],
) -> bool {
    agent_kind == Some(AgentKind::Antigravity)
        && is_model_config_option(option)
        && session_model_ids.iter().any(|id| id == value)
}

/// Kiro CLI publishes its models in the session reply's top-level `models`
/// (`{"currentModelId": "auto", "availableModels": [{"modelId", "name", "description"}]}`).
pub(in crate::manager) fn synthesize_kiro_model_option(
    models: Option<&serde_json::Value>,
) -> Option<AcpSessionConfigOption> {
    let models = models?;
    let mut seen = std::collections::HashSet::new();
    let options: Vec<SessionConfigSelectOption> = models
        .get("availableModels")?
        .as_array()?
        .iter()
        .filter_map(|model| {
            let id = model.get("modelId")?.as_str()?.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let name = model
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            let description = model
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            Some(vendor_select_choice(
                id.to_string(),
                name.to_string(),
                description,
            ))
        })
        .collect();
    let first = options.first()?.value.0.to_string();
    let current_value = models
        .get("currentModelId")
        .and_then(serde_json::Value::as_str)
        .filter(|current| options.iter().any(|opt| opt.value.0.as_ref() == *current))
        .map(str::to_string)
        .unwrap_or(first);
    Some(
        AcpSessionConfigOption::select(
            KIRO_MODEL_OPTION_ID,
            "Model",
            current_value,
            SessionConfigSelectOptions::Ungrouped(options),
        )
        .category(SessionConfigOptionCategory::Model),
    )
}

pub(in crate::manager) fn parse_kiro_reasoning(reasoning: &serde_json::Value) -> KiroReasoning {
    let levels: Vec<String> = reasoning
        .get("effortLevels")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .map(str::to_string)
        .collect();
    let current = reasoning
        .get("effort")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string);
    KiroReasoning {
        levels,
        current,
        thinking_toggleable: reasoning.get("support").and_then(serde_json::Value::as_str)
            == Some("toggleable"),
        thinking: reasoning
            .get("thinkingEnabled")
            .and_then(serde_json::Value::as_bool),
    }
}

pub(in crate::manager) fn kiro_thinking_option(
    reasoning: &KiroReasoning,
) -> Option<AcpSessionConfigOption> {
    if !reasoning.thinking_toggleable {
        return None;
    }
    let current_value = match reasoning.thinking {
        Some(true) => "on",
        Some(false) => "off",
        None => KIRO_DEFAULT_VALUE,
    };
    let choices = vec![
        SessionConfigSelectOption::new("on", "on"),
        SessionConfigSelectOption::new("off", "off"),
    ];
    Some(
        AcpSessionConfigOption::select(
            KIRO_THINKING_OPTION_ID,
            "Thinking",
            current_value,
            SessionConfigSelectOptions::Ungrouped(choices),
        )
        .description(Some("Shows reasoning before answering".to_string()))
        .category(SessionConfigOptionCategory::ThoughtLevel),
    )
}

pub(in crate::manager) fn kiro_effort_option(
    reasoning: &KiroReasoning,
) -> Option<AcpSessionConfigOption> {
    if reasoning.levels.is_empty() {
        return None;
    }
    let current_value = reasoning
        .current
        .clone()
        .filter(|current| reasoning.levels.contains(current))
        .unwrap_or_else(|| KIRO_DEFAULT_VALUE.to_string());
    let choices = reasoning
        .levels
        .iter()
        .map(|level| SessionConfigSelectOption::new(level.clone(), level.clone()))
        .collect();
    Some(
        AcpSessionConfigOption::select(
            KIRO_EFFORT_OPTION_ID,
            "Reasoning effort",
            current_value,
            SessionConfigSelectOptions::Ungrouped(choices),
        )
        .category(SessionConfigOptionCategory::ThoughtLevel),
    )
}

pub(in crate::manager) fn kiro_thinking_value(value: &str) -> Option<bool> {
    match value {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

pub(in crate::manager) fn place_kiro_reasoning_selectors(
    options: &mut Vec<AcpSessionConfigOption>,
    reasoning: &KiroReasoning,
) {
    options.retain(|opt| {
        opt.id.0.as_ref() != KIRO_THINKING_OPTION_ID && opt.id.0.as_ref() != KIRO_EFFORT_OPTION_ID
    });
    let at = options
        .iter()
        .position(|opt| opt.id.0.as_ref() == KIRO_MODEL_OPTION_ID)
        .map_or(options.len(), |pos| pos + 1);
    options.splice(
        at..at,
        [
            kiro_thinking_option(reasoning),
            kiro_effort_option(reasoning),
        ]
        .into_iter()
        .flatten(),
    );
}

pub(in crate::manager) fn kiro_available_commands(
    params: &serde_json::Value,
) -> Vec<AgentAvailableCommand> {
    const TUI_ONLY: &[&str] = &["reply", "paste", "voice", "quit", "prompts", "rewind"];
    let mut seen = std::collections::HashSet::new();
    let mut available = Vec::new();
    if let Some(commands) = params.get("commands").and_then(serde_json::Value::as_array) {
        for command in commands {
            let Some(raw) = command
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
            else {
                continue;
            };
            let name = raw.strip_prefix('/').unwrap_or(raw).trim();
            let meta = command.get("meta");
            let local = meta
                .and_then(|m| m.get("local"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if name.is_empty()
                || !seen.insert(name.to_string())
                || local
                || TUI_ONLY.contains(&name)
                || name.starts_with('$')
            {
                continue;
            }
            let input_hint = meta
                .and_then(|m| m.get("hint"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|hint| !hint.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    let subcommands: Vec<&str> = meta?
                        .get("subcommands")?
                        .as_array()?
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .collect();
                    (!subcommands.is_empty()).then(|| subcommands.join(" | "))
                });
            let description = command
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|desc| !desc.is_empty())
                .map(str::to_string);
            available.push(AgentAvailableCommand {
                name: name.to_string(),
                description,
                input_schema: input_hint.map(|hint| serde_json::json!({ "hint": hint })),
            });
        }
    }
    if let Some(prompts) = params.get("prompts").and_then(serde_json::Value::as_array) {
        for prompt in prompts {
            let Some(raw) = prompt
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
            else {
                continue;
            };
            let name = raw.strip_prefix('/').unwrap_or(raw).trim();
            if name.is_empty() || !seen.insert(name.to_string()) || name.starts_with('$') {
                continue;
            }
            let description = prompt
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|desc| !desc.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| kiro_prompt_source_label(prompt));
            let input_hint = kiro_prompt_input_hint(prompt);
            available.push(AgentAvailableCommand {
                name: name.to_string(),
                description: Some(description),
                input_schema: input_hint.map(|hint| serde_json::json!({ "hint": hint })),
            });
        }
    }
    available
}

pub(in crate::manager) fn kiro_prompt_source_label(prompt: &serde_json::Value) -> String {
    match prompt.get("serverName").and_then(serde_json::Value::as_str) {
        Some(server) if server.starts_with("skill:") => "Skill".to_string(),
        Some("local") | None => "Prompt".to_string(),
        Some(server) => format!("MCP prompt ({server})"),
    }
}

pub(in crate::manager) fn kiro_prompt_input_hint(prompt: &serde_json::Value) -> Option<String> {
    let names: Vec<String> = prompt
        .get("arguments")?
        .as_array()?
        .iter()
        .filter_map(|arg| {
            let name = arg.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let required = arg.get("required").and_then(serde_json::Value::as_bool) == Some(true);
            Some(if required {
                format!("<{name}>")
            } else {
                format!("[{name}]")
            })
        })
        .collect();
    match names.as_slice() {
        [] => None,
        [only] if only == "[args]" => None,
        _ => Some(names.join(" ")),
    }
}
