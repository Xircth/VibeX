use automation::{
    AutomationDraftInput, AutomationError, ComposerCanonicalInput, PluginActionCatalogPort,
    PluginActionRef, TurnLaunchSpec,
};

fn fixture() -> serde_json::Value {
    serde_json::json!({
        "promptBlocks": [
            { "type": "text", "text": "Create a quarterly presentation" }
        ],
        "displayText": "Create a quarterly presentation",
        "agent": {
            "agentId": "codex",
            "executorProfileId": null
        },
        "modeId": "plan",
        "configValues": [
            { "key": "model", "value": "gpt-5" }
        ],
        "pluginActions": [{
            "pluginId": "vibex.office",
            "action": {
                "id": "create-presentation",
                "label": "Create PPT",
                "requiredSkills": ["slides"],
                "requiredTools": ["officecli"],
                "promptBlocks": [
                    { "type": "text", "text": "Create a quarterly presentation" }
                ],
                "artifactIntent": {
                    "mediaTypes": [
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    ],
                    "provider": "officecli"
                }
            }
        }],
        "skills": ["slides"],
        "workspace": {
            "projectId": "16ef4a10-7a38-4ac0-b439-ddd9747560e1",
            "rootFolder": "/workspace/vibex",
            "branch": "main",
            "isolation": "worktree_per_run"
        },
        "labelSnapshot": "Codex · Create PPT"
    })
}

#[test]
fn turn_launch_spec_matches_composer_input() {
    let composer: ComposerCanonicalInput =
        serde_json::from_value(fixture()).expect("composer fixture");
    let draft: AutomationDraftInput =
        serde_json::from_value(fixture()).expect("automation fixture");

    let from_composer = TurnLaunchSpec::from_composer(composer).expect("composer input is valid");
    let from_automation =
        TurnLaunchSpec::from_automation_draft(draft).expect("automation draft is valid");

    assert_eq!(from_composer, from_automation);
}

struct EmptyPluginCatalog;

impl PluginActionCatalogPort for EmptyPluginCatalog {
    fn contains(&self, _action: &PluginActionRef) -> bool {
        false
    }
}

#[test]
fn unavailable_plugin_action_has_a_stable_error() {
    let composer: ComposerCanonicalInput =
        serde_json::from_value(fixture()).expect("composer fixture");
    let spec = TurnLaunchSpec::from_composer(composer).expect("base spec is valid");

    let error = spec
        .validate_plugin_actions(&EmptyPluginCatalog)
        .expect_err("unknown action must be rejected");

    assert!(matches!(
        error,
        AutomationError::UnavailablePluginAction { .. }
    ));
    assert_eq!(error.code(), "automation_plugin_action_unavailable");
}
