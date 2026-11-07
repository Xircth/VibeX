use super::*;

pub(in crate::manager) struct ConfigOverrideSelection {
    pub(in crate::manager) config_id: String,
    pub(in crate::manager) wire_value: SessionConfigOptionValue,
    pub(in crate::manager) event_value: serde_json::Value,
    pub(in crate::manager) already_selected: bool,
}

pub(in crate::manager) fn non_empty_trimmed(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

/// Whether an advertised option IS the agent's model selector. Matches either
/// the `Model` semantic category or the conventional `"model"` option id.
pub(in crate::manager) fn is_model_config_option(option: &AcpSessionConfigOption) -> bool {
    matches!(option.category, Some(SessionConfigOptionCategory::Model))
        || option.id.0.as_ref() == "model"
}

/// Whether the option's OWN advertisement proves `value` is not selectable, so
/// replaying a saved preference for it at connect is a guaranteed error.
///
/// Only non-empty `select` options reject values; an empty select list or a
/// boolean option rejects nothing.
pub(in crate::manager) fn config_option_rejects_value(
    option: &AcpSessionConfigOption,
    value: &str,
) -> bool {
    let SessionConfigKind::Select(select) = &option.kind else {
        return false;
    };
    let mut advertised = match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .iter()
            .map(|o| o.value.0.to_string())
            .collect::<Vec<_>>(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter().map(|o| o.value.0.to_string()))
            .collect::<Vec<_>>(),
        #[allow(unreachable_patterns)]
        _ => Vec::new(),
    };
    if advertised.is_empty() {
        return false;
    }
    advertised.sort_unstable();
    advertised.binary_search(&value.to_string()).is_err()
}

/// `value` without its trailing `[1m]`, matched case-insensitively.
pub(in crate::manager) fn strip_context_lane_suffix(value: &str) -> Option<&str> {
    const SUFFIX: &str = "[1m]";
    let split = value.len().checked_sub(SUFFIX.len())?;
    let (twin, suffix) = (value.get(..split)?, value.get(split..)?);
    (!twin.is_empty() && suffix.eq_ignore_ascii_case(SUFFIX)).then_some(twin)
}

/// The plain twin of a saved model pick whose `[1m]` spelling the model
/// selector no longer lists — `opus[1m]` → `opus`, `sonnet[1m]` → `sonnet` —
/// when the selector lists the twin. Never moves a plain pick onto `[1m]`, and
/// never touches a `[1m]` pick the selector still offers.
pub(in crate::manager) fn heal_retired_context_lane_pick(
    option: &AcpSessionConfigOption,
    value: &str,
) -> Option<String> {
    if !is_model_config_option(option) {
        return None;
    }
    let twin = strip_context_lane_suffix(value)?;
    (config_option_rejects_value(option, value) && !config_option_rejects_value(option, twin))
        .then(|| twin.to_string())
}

/// Whether a model row's description opens with `name` as its own segment, the
/// way Claude Code's CLI writes one: `Fable 5.1 · Most capable for …`.
pub(in crate::manager) fn description_leads_with(description: &str, name: &str) -> bool {
    let description = description.trim_start();
    description
        .get(..name.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(name))
        && description[name.len()..].starts_with(" \u{b7} ")
}

/// The name Claude Code's model catalog gives a concrete model id:
/// `claude-fable-5-1` → `Fable 5.1`, `claude-sonnet-5` → `Sonnet 5`,
/// `claude-haiku-4-5-20251001` → `Haiku 4.5`.
pub(in crate::manager) fn claude_catalog_label(id: &str) -> Option<String> {
    let mut parts = id.strip_prefix("claude-")?.split('-');
    let family = parts
        .next()
        .filter(|family| !family.is_empty() && family.bytes().all(|b| b.is_ascii_lowercase()))?;
    let mut version: Vec<&str> = parts.collect();
    if version
        .last()
        .is_some_and(|part| part.len() == 8 && part.bytes().all(|b| b.is_ascii_digit()))
    {
        version.pop();
    }
    let numeric =
        |part: &&str| (1..=2).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    if version.is_empty() || !version.iter().all(numeric) {
        return None;
    }
    let (initial, tail) = family.split_at(1);
    Some(format!(
        "{}{tail} {}",
        initial.to_ascii_uppercase(),
        version.join(".")
    ))
}

/// The row a saved CONCRETE Claude model id is now spelled as, when the model
/// selector no longer lists the id itself: the one row whose label (or leading
/// description segment) names that exact model (`claude-fable-5-1` → `fable`
/// labelled `Fable 5.1`).
pub(in crate::manager) fn heal_respelled_model_pick(
    option: &AcpSessionConfigOption,
    value: &str,
) -> Option<String> {
    if !is_model_config_option(option) || !config_option_rejects_value(option, value) {
        return None;
    }
    let SessionConfigKind::Select(select) = &option.kind else {
        return None;
    };
    let rows: Vec<&SessionConfigSelectOption> = match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect(),
        #[allow(unreachable_patterns)]
        _ => Vec::new(),
    };
    let catalog_label = claude_catalog_label(value);
    let names_the_pick = |row: &&SessionConfigSelectOption| {
        let label = row.name.trim();
        if label.eq_ignore_ascii_case(value) {
            return true;
        }
        let Some(catalog) = catalog_label.as_deref() else {
            return false;
        };
        label.eq_ignore_ascii_case(catalog)
            || row
                .description
                .as_deref()
                .is_some_and(|description| description_leads_with(description, catalog))
    };
    let mut matching = rows.into_iter().filter(names_the_pick);
    let row = matching.next()?;
    matching.next().is_none().then(|| row.value.0.to_string())
}

/// Heal a saved Claude model pick across retired `[1m]` context lanes, concrete
/// id re-spellings (`claude-fable-5-1` → `fable`), or both at once
/// (`claude-fable-5-1[1m]` → `fable`).
pub(in crate::manager) fn heal_retired_model_pick(
    option: &AcpSessionConfigOption,
    value: &str,
) -> Option<String> {
    heal_retired_context_lane_pick(option, value)
        .or_else(|| heal_respelled_model_pick(option, value))
        .or_else(|| {
            let twin = strip_context_lane_suffix(value)?;
            if !config_option_rejects_value(option, value) {
                return None;
            }
            heal_respelled_model_pick(option, twin)
        })
}

/// [`heal_retired_model_pick`] over a whole preference set against the session's
/// advertised options. Only applies to `AgentKind::ClaudeCode`; never mutates
/// persisted preferences.
pub(in crate::manager) fn heal_retired_model_picks(
    agent_kind: Option<AgentKind>,
    options: &[AcpSessionConfigOption],
    preferred: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    if agent_kind != Some(AgentKind::ClaudeCode) {
        return preferred.clone();
    }
    preferred
        .iter()
        .map(|(config_id, value_id)| {
            let healed = options
                .iter()
                .find(|o| {
                    o.id.0.as_ref() == config_id.as_str()
                        || (config_id == "model" && is_model_config_option(o))
                })
                .and_then(|o| heal_retired_model_pick(o, value_id));
            match healed {
                Some(twin) => {
                    tracing::info!(
                        "[ACP] preferred config '{config_id}'='{value_id}' is no longer \
                         offered; replaying '{twin}', the spelling the agent lists now"
                    );
                    (config_id.clone(), twin)
                }
                None => (config_id.clone(), value_id.clone()),
            }
        })
        .collect()
}

/// [`config_option_rejects_value`] for the mode channel: whether the session's
/// OWN mode list proves a saved `preferred_mode_id` (such as a withdrawn
/// `bypassPermissions`) cannot be selected. An empty mode list rejects nothing.
pub(in crate::manager) fn session_modes_reject_id(modes: &SessionModeState, mode_id: &str) -> bool {
    !modes.available_modes.is_empty()
        && !modes
            .available_modes
            .iter()
            .any(|mode| mode.id.0.as_ref() == mode_id)
}

/// Prepare saved session preferences for connect-time replay:
/// 1. Drop a preferred mode if `session_modes_reject_id` (or the unified mode
///    config option) rejects it.
/// 2. Heal retired Claude model picks (`heal_retired_model_picks`) in memory.
/// 3. Order model selections first, and drop any config preference that the
///    advertised option still rejects via `config_option_rejects_value`,
///    unless Antigravity's flat model list still offers that value.
pub(in crate::manager) fn prepare_preferred_controls_for_replay(
    agent_kind: Option<AgentKind>,
    modes: Option<&SessionModeState>,
    options: &[AcpSessionConfigOption],
    preferred_mode: Option<&str>,
    preferred_config: &[AgentSessionConfigOverride],
    session_model_ids: &[String],
) -> (
    Option<String>,
    Vec<AgentSessionConfigOverride>,
    BTreeMap<String, String>,
) {
    let mode_to_apply = preferred_mode
        .and_then(non_empty_trimmed)
        .filter(|pref_mode| {
            let rejected_by_modes = modes.is_some_and(|m| session_modes_reject_id(m, pref_mode));
            let rejected_by_option = options
                .iter()
                .find(|o| matches!(o.category, Some(SessionConfigOptionCategory::Mode)))
                .is_some_and(|o| config_option_rejects_value(o, pref_mode));
            if rejected_by_modes || rejected_by_option {
                tracing::info!(
                    "[ACP] skipping preferred mode '{pref_mode}' on connect: \
                     the agent no longer offers that mode"
                );
                false
            } else {
                true
            }
        })
        .map(str::to_string);

    let mut raw_config_map = BTreeMap::new();
    for item in preferred_config {
        if let (Some(k), Some(v)) = (non_empty_trimmed(&item.key), non_empty_trimmed(&item.value)) {
            raw_config_map.insert(k.to_string(), v.to_string());
        }
    }
    let healed_map = heal_retired_model_picks(agent_kind, options, &raw_config_map);
    let healed_overrides = preferred_config
        .iter()
        .filter_map(|item| {
            let key = non_empty_trimmed(&item.key)?;
            let value = healed_map.get(key)?;
            Some(AgentSessionConfigOverride {
                key: key.to_string(),
                value: value.clone(),
            })
        })
        .collect::<Vec<_>>();

    let mut filtered_overrides = Vec::new();
    for item in ordered_session_config_overrides(options, healed_overrides) {
        if item.key == "mode"
            && modes.is_some_and(|m| session_modes_reject_id(m, item.value.as_str()))
        {
            tracing::info!(
                "[ACP] skipping preferred config 'mode'='{}' on connect: \
                 the agent no longer offers that mode",
                item.value
            );
            continue;
        }
        let advertised = options
            .iter()
            .find(|o| o.id.0.as_ref() == item.key.as_str() || config_option_matches(o, &item.key));
        if let Some(option) =
            advertised.filter(|o| config_option_rejects_value(o, item.value.as_str()))
        {
            if !session_model_list_offers(
                agent_kind,
                option,
                item.value.as_str(),
                session_model_ids,
            ) {
                tracing::info!(
                    "[ACP] skipping preferred config '{}'='{}' on connect: \
                     the agent no longer offers that value",
                    item.key,
                    item.value
                );
                continue;
            }
            tracing::info!(
                "[ACP] preferred config '{}'='{}' is no longer a row of \
                 its selector; replaying it as saved, since the agent's session model \
                 list still offers it",
                item.key,
                item.value
            );
        }
        filtered_overrides.push(item);
    }

    let preferred_map = preferred_controls_map(
        mode_to_apply.as_deref(),
        filtered_overrides
            .iter()
            .map(|item| (item.key.as_str(), item.value.as_str())),
    );
    (mode_to_apply, filtered_overrides, preferred_map)
}

/// Apply a model selection before options that may depend on it. The category
/// comes from the Agent's ACP session-config advertisement; `sort_by_key` is
/// stable, so unrelated selections retain their caller-provided order.
pub(in crate::manager) fn ordered_session_config_overrides(
    options: &[AcpSessionConfigOption],
    mut overrides: Vec<AgentSessionConfigOverride>,
) -> Vec<AgentSessionConfigOverride> {
    overrides.sort_by_key(|override_item| {
        let is_model = options.iter().any(|option| {
            is_model_config_option(option) && config_option_matches(option, &override_item.key)
        }) || override_item.key.eq_ignore_ascii_case("model");
        u8::from(!is_model)
    });
    overrides
}

/// Effective auto-approve mode for a permission decision. ACP session modes
/// are Agent-owned semantics: for example Claude Code's `auto` asks its model
/// classifier to decide. They must never silently upgrade VibeX's independent
/// auto-approval policy.
pub(in crate::manager) async fn effective_auto_approve_mode(
    configured: AgentAutoApproveMode,
    session_controls: &RwLock<HashMap<AgentSessionId, SessionControlState>>,
    session_id: AgentSessionId,
) -> AgentAutoApproveMode {
    if session_controls
        .read()
        .await
        .get(&session_id)
        .is_some_and(|state| state.omp_yolo_mode)
    {
        return AgentAutoApproveMode::Yolo;
    }
    configured
}

pub(in crate::manager) fn find_config_override_selection(
    options: &[AcpSessionConfigOption],
    key: &str,
    value: &serde_json::Value,
) -> Option<ConfigOverrideSelection> {
    find_config_override_selection_for_agent(options, None, key, value, &[])
}

pub(in crate::manager) fn find_config_override_selection_for_agent(
    options: &[AcpSessionConfigOption],
    agent_kind: Option<AgentKind>,
    key: &str,
    value: &serde_json::Value,
    session_model_ids: &[String],
) -> Option<ConfigOverrideSelection> {
    for option in options {
        if !config_option_matches(option, key) {
            continue;
        }
        match &option.kind {
            SessionConfigKind::Select(select) => {
                let requested = value.as_str()?;
                let healed = if agent_kind == Some(AgentKind::ClaudeCode)
                    && is_model_config_option(option)
                {
                    heal_retired_model_pick(option, requested)
                } else {
                    None
                };
                let effective = healed.as_deref().unwrap_or(requested);
                // A variant id the selector no longer lists must be sent as
                // saved when the same answer's flat model list still names it.
                // Checking this before `find_select_choice` stops
                // `gemini-4-argon-high` being substring-matched onto the
                // family row `gemini-4-argon`.
                if session_model_list_offers(agent_kind, option, effective, session_model_ids) {
                    return Some(ConfigOverrideSelection {
                        config_id: option.id.0.to_string(),
                        wire_value: SessionConfigOptionValue::value_id(effective.to_string()),
                        event_value: serde_json::Value::String(effective.to_string()),
                        already_selected: select.current_value.0.as_ref() == effective,
                    });
                }
                // For Claude Code's model selector, once healing has run, a value
                // that the non-empty select still rejects must be dropped rather
                // than fuzzy-matched onto a different model row.
                if agent_kind == Some(AgentKind::ClaudeCode)
                    && is_model_config_option(option)
                    && config_option_rejects_value(option, effective)
                {
                    continue;
                }
                if let Some(choice) = find_select_choice(select, key, effective) {
                    let value_id = choice.value.0.to_string();
                    return Some(ConfigOverrideSelection {
                        config_id: option.id.0.to_string(),
                        wire_value: SessionConfigOptionValue::value_id(value_id.clone()),
                        event_value: serde_json::Value::String(value_id),
                        already_selected: select.current_value == choice.value,
                    });
                }
            }
            SessionConfigKind::Boolean(boolean) => {
                let requested = value
                    .as_bool()
                    .or_else(|| value.as_str().and_then(|value| value.parse::<bool>().ok()))?;
                return Some(ConfigOverrideSelection {
                    config_id: option.id.0.to_string(),
                    wire_value: SessionConfigOptionValue::boolean(requested),
                    event_value: serde_json::Value::Bool(requested),
                    already_selected: boolean.current_value == requested,
                });
            }
            #[allow(unreachable_patterns)]
            _ => continue,
        }
    }
    None
}

pub(in crate::manager) fn advertised_option_is_mode(
    options: &[AcpSessionConfigOption],
    config_id: &str,
) -> bool {
    options.iter().any(|option| {
        option.id.0.as_ref() == config_id
            && matches!(option.category, Some(SessionConfigOptionCategory::Mode))
    })
}

pub(in crate::manager) fn config_options_have_mode_category(
    options: &[AcpSessionConfigOption],
) -> bool {
    options
        .iter()
        .any(|option| matches!(option.category, Some(SessionConfigOptionCategory::Mode)))
}

pub(in crate::manager) fn unify_session_config_options(
    modes: Option<SessionModeState>,
    mut config_options: Vec<AcpSessionConfigOption>,
    keep_legacy_modes: bool,
) -> (Vec<AcpSessionConfigOption>, bool) {
    if config_options_have_mode_category(&config_options) {
        return (config_options, false);
    }
    // Standard ACP treats advertised config options as exclusive of legacy
    // Session Modes. Vendor adapters may keep both dimensions.
    if !config_options.is_empty() && !keep_legacy_modes {
        return (config_options, false);
    }
    let Some(modes) = modes.filter(|modes| !modes.available_modes.is_empty()) else {
        return (config_options, false);
    };
    config_options.insert(0, config_option_from_session_modes(&modes));
    (config_options, true)
}

pub(in crate::manager) fn config_option_from_session_modes(
    modes: &SessionModeState,
) -> AcpSessionConfigOption {
    let choices = modes
        .available_modes
        .iter()
        .map(|mode| {
            vendor_select_choice(
                mode.id.0.to_string(),
                mode.name.clone(),
                mode.description.clone(),
            )
        })
        .collect();
    AcpSessionConfigOption::select(
        "mode",
        "Mode",
        modes.current_mode_id.0.to_string(),
        SessionConfigSelectOptions::Ungrouped(choices),
    )
    .category(SessionConfigOptionCategory::Mode)
}

pub(in crate::manager) fn session_modes_from_config_options(
    options: &[AcpSessionConfigOption],
) -> (Vec<AgentSessionMode>, Option<String>) {
    let Some(option) = options
        .iter()
        .find(|option| matches!(option.category, Some(SessionConfigOptionCategory::Mode)))
    else {
        return (Vec::new(), None);
    };
    let mapped = agent_session_config_option_from_acp(option.clone());
    let current = mapped
        .value
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let modes = mapped
        .choices
        .into_iter()
        .filter_map(|choice| {
            let id = choice.value.as_str()?.to_string();
            if id.is_empty() {
                return None;
            }
            Some(AgentSessionMode {
                id,
                label: choice.label,
                description: choice.description,
            })
        })
        .collect();
    (modes, current)
}

pub(in crate::manager) fn apply_grok_catalog_to_stored_options(
    options: &mut [AcpSessionConfigOption],
    catalog: &GrokModelCatalog,
) -> bool {
    let Some(option) = options
        .iter_mut()
        .find(|option| option.category == Some(SessionConfigOptionCategory::Model))
    else {
        return false;
    };
    let SessionConfigKind::Select(select) = &mut option.kind else {
        return false;
    };
    let current = select.current_value.0.to_string();
    let rows = select_option_rows(&select.options);
    let current_label = rows
        .iter()
        .find(|(id, _)| id == &current)
        .map(|(_, name)| name.as_str())
        .unwrap_or(current.as_str());
    let next = fold_grok_catalog_model_choices(&current, current_label, catalog);
    if next == rows {
        return false;
    }
    select.options = SessionConfigSelectOptions::Ungrouped(
        next.into_iter()
            .map(|(id, name)| SessionConfigSelectOption::new(id, name))
            .collect(),
    );
    true
}

pub(in crate::manager) fn select_option_rows(
    options: &SessionConfigSelectOptions,
) -> Vec<(String, String)> {
    match options {
        SessionConfigSelectOptions::Ungrouped(choices) => choices
            .iter()
            .map(|choice| (choice.value.0.to_string(), choice.name.clone()))
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .map(|choice| (choice.value.0.to_string(), choice.name.clone()))
            .collect(),
        #[allow(unreachable_patterns)]
        _ => Vec::new(),
    }
}

pub(in crate::manager) fn apply_current_mode_to_config_options(
    options: &mut [AcpSessionConfigOption],
    mode_id: &str,
) {
    for option in options {
        if !matches!(option.category, Some(SessionConfigOptionCategory::Mode)) {
            continue;
        }
        if let SessionConfigKind::Select(select) = &mut option.kind {
            select.current_value = SessionConfigValueId::new(mode_id);
        }
    }
}

pub(in crate::manager) fn advertised_option_is_thought_level(
    options: &[AcpSessionConfigOption],
    config_id: &str,
) -> bool {
    options.iter().any(|option| {
        option.id.0.as_ref() == config_id && config_option_matches(option, "thought_level")
    })
}

pub(in crate::manager) fn config_option_matches(
    option: &AcpSessionConfigOption,
    key: &str,
) -> bool {
    let key = normalize_config_token(key);
    let id = normalize_config_token(option.id.0.as_ref());
    let name = normalize_config_token(&option.name);
    let category = option.category.as_ref();

    match key.as_str() {
        "model" => {
            matches!(category, Some(SessionConfigOptionCategory::Model))
                || id.contains("model")
                || name.contains("model")
        }
        "reasoning" | "reasoningeffort" | "thoughteffort" | "thoughtlevel" | "thinkinglevel"
        | "thinking" | "effort" => {
            matches!(category, Some(SessionConfigOptionCategory::ThoughtLevel))
                || id.contains("reason")
                || name.contains("reason")
                || id.contains("thought")
                || name.contains("thought")
                || id.contains("effort")
                || name.contains("effort")
        }
        "sandbox" => id.contains("sandbox") || name.contains("sandbox"),
        "fast" | "fastmode" => id.contains("fast") || name.contains("fast"),
        "approval" | "approvalpolicy" | "permission" | "permissionmode" => {
            id.contains("approval")
                || name.contains("approval")
                || id.contains("permission")
                || name.contains("permission")
        }
        "mode" => {
            matches!(category, Some(SessionConfigOptionCategory::Mode))
                || id.contains("mode")
                || name.contains("mode")
        }
        _ => id == key || name == key,
    }
}

pub(in crate::manager) fn find_select_choice<'a>(
    select: &'a agent_client_protocol::schema::v1::SessionConfigSelect,
    key: &str,
    value: &str,
) -> Option<&'a SessionConfigSelectOption> {
    let aliases = config_value_aliases(key, value);
    let options = match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect::<Vec<_>>(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect::<Vec<_>>(),
        #[allow(unreachable_patterns)]
        _ => return None,
    };

    // Resolve exact raw wire ID first (so `sonnet[1m]` vs `sonnet` never
    // collides under alphanumeric normalization), then exact normalized IDs/names,
    // and finally compatibility aliases.
    options
        .iter()
        .copied()
        .find(|option| option.value.0.as_ref() == value)
        .or_else(|| {
            options
                .iter()
                .copied()
                .find(|option| select_choice_matches_exact(option, &aliases))
        })
        .or_else(|| {
            options
                .into_iter()
                .find(|option| select_choice_matches(option, &aliases))
        })
}

pub(in crate::manager) fn select_choice_matches_exact(
    option: &SessionConfigSelectOption,
    aliases: &[String],
) -> bool {
    select_choice_values(option)
        .iter()
        .any(|value| aliases.iter().any(|alias| value == alias))
}

pub(in crate::manager) fn select_choice_matches(
    option: &SessionConfigSelectOption,
    aliases: &[String],
) -> bool {
    select_choice_values(option).iter().any(|value| {
        aliases.iter().any(|alias| {
            let meaningful_alias = alias.len() > 3;
            let meaningful_value = value.len() > 3;
            (meaningful_alias && value.contains(alias))
                || (meaningful_value && alias.contains(value))
        })
    })
}

pub(in crate::manager) fn select_choice_values(option: &SessionConfigSelectOption) -> Vec<String> {
    let mut values = vec![
        normalize_config_token(option.value.0.as_ref()),
        normalize_config_token(&option.name),
    ];
    if let Some(description) = &option.description {
        values.push(normalize_config_token(description));
    }
    values
}

pub(in crate::manager) fn config_value_aliases(key: &str, value: &str) -> Vec<String> {
    let key = normalize_config_token(key);
    let value = normalize_config_token(value);
    let mut aliases = vec![value.clone()];

    match (key.as_str(), value.as_str()) {
        ("approval" | "approvalpolicy" | "permission" | "permissionmode", "ask") => {
            aliases.extend(
                [
                    "manual",
                    "confirm",
                    "approval",
                    "approvals",
                    "onrequest",
                    "unlesstrusted",
                ]
                .into_iter()
                .map(str::to_string),
            );
        }
        ("approval" | "approvalpolicy" | "permission" | "permissionmode", "auto") => {
            aliases.extend(
                [
                    "allow",
                    "always",
                    "never",
                    "skip",
                    "autoapprove",
                    "dangerfullaccess",
                    "dangerouslyskippermissions",
                ]
                .into_iter()
                .map(str::to_string),
            );
        }
        (
            "reasoning" | "reasoningeffort" | "thoughteffort" | "thoughtlevel" | "thinkinglevel"
            | "thinking" | "effort",
            "xhigh",
        ) => {
            aliases.push("extrahigh".to_string());
        }
        ("fast" | "fastmode", "true") => {
            aliases.extend(["enabled", "on", "fast"].into_iter().map(str::to_string));
        }
        ("fast" | "fastmode", "false") => {
            aliases.extend(
                ["disabled", "off", "normal"]
                    .into_iter()
                    .map(str::to_string),
            );
        }
        _ => {}
    }

    aliases.sort();
    aliases.dedup();
    aliases
}

pub(in crate::manager) fn normalize_config_token(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}
