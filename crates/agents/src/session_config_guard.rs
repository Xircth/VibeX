//! Codeg-aligned session-control arbitration.
//!
//! `session/set_config_option` is advisory: the agent answers with the list it
//! adopted, and a later `config_option_update` is indistinguishable from a user
//! pick. Until the first prompt, establishment-time confirmed values are
//! re-asserted once if the agent re-pins them. Grok's process-wide
//! `_x.ai/models/update` refreshes the model list and never moves this session's
//! current model.

use std::collections::BTreeMap;

use crate::AgentSessionConfigOption;

pub const GROK_MODELS_UPDATE_METHOD: &str = "_x.ai/models/update";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigOptionRejection {
    pub config_id: String,
    pub option_name: String,
    pub requested: String,
    pub actual: String,
    pub requested_value: String,
    pub actual_value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokCatalogModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GrokModelCatalog {
    pub models: Vec<GrokCatalogModel>,
}

pub fn select_currents(options: &[AgentSessionConfigOption]) -> BTreeMap<String, String> {
    options
        .iter()
        .filter_map(|option| {
            let current = option_current(option)?;
            Some((option.key.clone(), current))
        })
        .collect()
}

pub fn preferred_controls_map<'a>(
    mode: Option<&str>,
    config: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Some(mode) = mode.map(str::trim).filter(|mode| !mode.is_empty()) {
        map.insert("mode".to_string(), mode.to_string());
    }
    for (key, value) in config {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        map.insert(key.to_string(), value.to_string());
    }
    map
}

pub fn asserted_from_preferred(
    preferred: &BTreeMap<String, String>,
    settled: &[AgentSessionConfigOption],
) -> BTreeMap<String, String> {
    let settled = select_currents(settled);
    preferred
        .iter()
        .filter(|(config_id, value)| settled.get(*config_id) == Some(*value))
        .map(|(config_id, value)| (config_id.clone(), value.clone()))
        .collect()
}

/// Compare a push against establishment-time confirmed values. Each drifted
/// id is removed from the ledger so it is re-asserted at most once. Model
/// options are returned first so effort hanging off a model switch is not
/// spent before the model is restored.
pub fn take_asserted_config_drift(
    asserted: &mut BTreeMap<String, String>,
    pushed: &[AgentSessionConfigOption],
) -> Vec<(String, String)> {
    if asserted.is_empty() {
        return Vec::new();
    }
    let pushed_values = select_currents(pushed);
    let drifted: BTreeMap<String, String> = asserted
        .iter()
        .filter(|(config_id, asserted_value)| {
            pushed_values
                .get(*config_id)
                .is_some_and(|pushed| pushed != *asserted_value)
        })
        .map(|(config_id, value)| (config_id.clone(), value.clone()))
        .collect();
    for config_id in drifted.keys() {
        asserted.remove(config_id);
    }
    order_model_first(pushed, &drifted)
}

pub fn config_option_rejection(
    updated: &[AgentSessionConfigOption],
    config_id: &str,
    requested: &str,
) -> Option<ConfigOptionRejection> {
    let option = updated.iter().find(|option| option.key == config_id)?;
    let actual_value = option_current(option)?;
    if actual_value == requested {
        return None;
    }
    Some(ConfigOptionRejection {
        config_id: config_id.to_string(),
        option_name: option.label.clone(),
        requested: choice_label(option, requested),
        actual: choice_label(option, &actual_value),
        requested_value: requested.to_string(),
        actual_value,
    })
}

/// Grok announces its catalog without a session id. `currentModelId` is the
/// process-wide pick, not a switch of this session, so it is not read.
pub fn parse_grok_model_catalog(params: &serde_json::Value) -> Option<GrokModelCatalog> {
    let entries = params.get("availableModels")?.as_array()?;
    let mut models = Vec::new();
    for entry in entries {
        let Some(id) = entry
            .get("modelId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if models.iter().any(|model: &GrokCatalogModel| model.id == id) {
            continue;
        }
        let name = entry
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(id);
        models.push(GrokCatalogModel {
            id: id.to_string(),
            name: name.to_string(),
        });
    }
    (!models.is_empty()).then_some(GrokModelCatalog { models })
}

/// Refresh the model choice list. The session's current model is kept even
/// when the catalog names a different `currentModelId` or omits this session's
/// model.
pub fn fold_grok_catalog_model_choices(
    current: &str,
    current_label: &str,
    catalog: &GrokModelCatalog,
) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = catalog
        .models
        .iter()
        .map(|model| (model.id.clone(), model.name.clone()))
        .collect();
    if !rows.iter().any(|(id, _)| id == current) {
        rows.insert(0, (current.to_string(), current_label.to_string()));
    }
    rows
}

fn option_current(option: &AgentSessionConfigOption) -> Option<String> {
    option
        .value
        .as_ref()
        .and_then(|value| match value {
            serde_json::Value::String(text) => Some(text.clone()),
            serde_json::Value::Bool(flag) => Some(flag.to_string()),
            serde_json::Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
}

fn choice_label(option: &AgentSessionConfigOption, value: &str) -> String {
    option
        .choices
        .iter()
        .find(|choice| {
            choice
                .value
                .as_str()
                .is_some_and(|choice_value| choice_value == value)
        })
        .map(|choice| choice.label.clone())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| value.to_string())
}

fn order_model_first(
    options: &[AgentSessionConfigOption],
    drifted: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    let mut ordered: Vec<(String, String)> = options
        .iter()
        .filter_map(|option| {
            drifted
                .get(&option.key)
                .map(|value| (option.key.clone(), value.clone()))
        })
        .collect();
    for (config_id, value) in drifted {
        if !ordered.iter().any(|(id, _)| id == config_id) {
            ordered.push((config_id.clone(), value.clone()));
        }
    }
    ordered.sort_by_key(|(config_id, _)| {
        let is_model = options
            .iter()
            .any(|option| option.key == *config_id && option.category.as_deref() == Some("model"))
            || config_id == "model";
        u8::from(!is_model)
    });
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AgentSessionConfigChoice;

    fn select_option(
        key: &str,
        category: &str,
        current: &str,
        choices: &[(&str, &str)],
    ) -> AgentSessionConfigOption {
        AgentSessionConfigOption {
            key: key.to_string(),
            label: key.to_string(),
            description: None,
            category: Some(category.to_string()),
            value: Some(serde_json::Value::String(current.to_string())),
            choices: choices
                .iter()
                .map(|(value, label)| AgentSessionConfigChoice {
                    value: serde_json::json!(value),
                    label: (*label).to_string(),
                    description: None,
                })
                .collect(),
            dependency: None,
        }
    }

    #[test]
    fn preferred_map_keeps_mode_and_non_empty_config_keys() {
        let map = preferred_controls_map(
            Some("agent-full-access"),
            [("model", "grok-4.7"), ("effort", "")],
        );
        assert_eq!(
            map.get("mode").map(String::as_str),
            Some("agent-full-access")
        );
        assert_eq!(map.get("model").map(String::as_str), Some("grok-4.7"));
        assert!(!map.contains_key("effort"));
        assert!(preferred_controls_map(Some("  "), []).is_empty());
    }

    #[test]
    fn asserted_ledger_keeps_only_values_the_agent_confirmed() {
        let mut preferred = BTreeMap::new();
        preferred.insert("model".into(), "grok-4.7".into());
        preferred.insert("mode".into(), "agent-full-access".into());
        preferred.insert("effort".into(), "high".into());
        let settled = vec![
            select_option(
                "model",
                "model",
                "grok-4.7",
                &[("grok-4.6", "Grok 4.6"), ("grok-4.7", "Grok 4.7")],
            ),
            select_option(
                "mode",
                "mode",
                "agent",
                &[
                    ("agent", "Approve for me"),
                    ("agent-full-access", "Agent (full access)"),
                ],
            ),
        ];
        let asserted = asserted_from_preferred(&preferred, &settled);
        assert_eq!(asserted.get("model").map(String::as_str), Some("grok-4.7"));
        assert!(!asserted.contains_key("mode"));
        assert!(!asserted.contains_key("effort"));
    }

    #[test]
    fn a_push_that_reverts_establishment_values_is_reasserted_once_model_first() {
        let mut asserted = BTreeMap::new();
        asserted.insert("model".into(), "grok-4.7".into());
        asserted.insert("effort".into(), "high".into());
        let pushed = vec![
            select_option(
                "effort",
                "thought_level",
                "low",
                &[("low", "Low"), ("high", "High")],
            ),
            select_option(
                "model",
                "model",
                "grok-4.6",
                &[("grok-4.6", "Grok 4.6"), ("grok-4.7", "Grok 4.7")],
            ),
        ];
        let drift = take_asserted_config_drift(&mut asserted, &pushed);
        assert_eq!(
            drift,
            vec![
                ("model".into(), "grok-4.7".into()),
                ("effort".into(), "high".into()),
            ]
        );
        assert!(asserted.is_empty());
        assert!(take_asserted_config_drift(&mut asserted, &pushed).is_empty());
    }

    #[test]
    fn an_agreeing_push_does_not_spend_the_ledger() {
        let mut asserted = BTreeMap::new();
        asserted.insert("mode".into(), "agent-full-access".into());
        let pushed = vec![select_option(
            "mode",
            "mode",
            "agent-full-access",
            &[
                ("agent", "Approve for me"),
                ("agent-full-access", "Agent (full access)"),
            ],
        )];
        assert!(take_asserted_config_drift(&mut asserted, &pushed).is_empty());
        assert_eq!(
            asserted.get("mode").map(String::as_str),
            Some("agent-full-access")
        );
    }

    #[test]
    fn a_clamped_set_config_answer_is_a_rejection() {
        let updated = vec![select_option(
            "mode",
            "mode",
            "agent",
            &[
                ("agent", "Approve for me"),
                ("agent-full-access", "Agent (full access)"),
            ],
        )];
        let rejection = config_option_rejection(&updated, "mode", "agent-full-access")
            .expect("Codex answering agent for full access is a rejection");
        assert_eq!(rejection.config_id, "mode");
        assert_eq!(rejection.requested, "Agent (full access)");
        assert_eq!(rejection.actual, "Approve for me");
        assert_eq!(rejection.requested_value, "agent-full-access");
        assert_eq!(rejection.actual_value, "agent");
        assert!(config_option_rejection(&updated, "mode", "agent").is_none());
    }

    #[test]
    fn grok_catalog_broadcast_does_not_move_this_session_current_model() {
        let catalog = parse_grok_model_catalog(&serde_json::json!({
            "currentModelId": "grok-4.6",
            "availableModels": [
                {"modelId": "grok-4.6", "name": "Grok 4.6"},
                {"modelId": "grok-4.7", "name": "Grok 4.7"},
                {"modelId": "grok-4.5", "name": "Grok 4.5"}
            ]
        }))
        .expect("usable catalog");
        assert_eq!(
            catalog
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["grok-4.6", "grok-4.7", "grok-4.5"]
        );
        let choices = fold_grok_catalog_model_choices("grok-4.7", "Grok 4.7", &catalog);
        assert_eq!(
            choices,
            vec![
                ("grok-4.6".into(), "Grok 4.6".into()),
                ("grok-4.7".into(), "Grok 4.7".into()),
                ("grok-4.5".into(), "Grok 4.5".into()),
            ]
        );
        let kept = fold_grok_catalog_model_choices(
            "grok-4.7",
            "Grok 4.7",
            &GrokModelCatalog {
                models: vec![GrokCatalogModel {
                    id: "grok-4.6".into(),
                    name: "Grok 4.6".into(),
                }],
            },
        );
        assert_eq!(kept[0], ("grok-4.7".into(), "Grok 4.7".into()));
        assert!(
            parse_grok_model_catalog(&serde_json::json!({"currentModelId": "grok-4.6"})).is_none()
        );
    }
}
