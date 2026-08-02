use plugins::{ManifestSource, PluginMembership, PluginService, PromptBlock};

#[test]
fn import_office_action_manifest() {
    let service = PluginService::new();
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json");

    let imported = service
        .import_manifest(manifest, ManifestSource::Bundled)
        .expect("the bundled Office manifest should import");

    assert_eq!(imported.id.as_str(), "vibex.office.presentation");
    assert_eq!(imported.membership, PluginMembership::Builtin);
    assert_eq!(imported.dependencies.len(), 1);
    assert_eq!(imported.dependencies[0].id.as_str(), "officecli");
    assert_eq!(imported.skills.len(), 1);
    assert_eq!(imported.skills[0].id.as_str(), "office-pptx");
    assert_eq!(imported.actions.len(), 1);
    assert_eq!(imported.actions[0].id.as_str(), "create-presentation");
    assert_eq!(
        imported.actions[0].prompt_blocks,
        vec![PromptBlock::Text {
            text: "请先澄清目标受众和演示目标，然后创建 PPTX。".to_string(),
        }]
    );
}

#[test]
fn rejects_unknown_manifest_major() {
    let service = PluginService::new();
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json")
        .replace("vibex-plugin/v2", "vibex-plugin/v3");

    let error = service
        .import_manifest(&manifest, ManifestSource::Bundled)
        .expect_err("an unknown schema major must fail closed");

    assert_eq!(error.code(), "plugin_manifest_major_unsupported");
}

#[test]
fn rejects_legacy_install_commands_as_malicious_manifest_fields() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let marker = temporary.path().join("manifest-command-ran");
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json").replace(
        "\"name\": \"Office Presentation\",",
        &format!(
            "\"name\": \"Office Presentation\",\n  \"install_command\": \"touch {}\",",
            marker.display()
        ),
    );

    let error = PluginService::new()
        .import_manifest(&manifest, ManifestSource::External)
        .expect_err("Plugin v2 must reject executable legacy fields");

    assert_eq!(error.code(), "plugin_manifest_invalid");
    assert!(!marker.exists());
}

#[test]
fn imports_optional_metadata_and_console_binding() {
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json").replace(
        "\"name\": \"Office Presentation\",",
        "\"name\": \"Office Presentation\",\n  \
             \"description\": \"Create verified presentations\",\n  \
             \"author\": \"VibeX\",\n  \
             \"icon\": \"presentation\",\n  \
             \"console\": { \"url\": \"http://127.0.0.1:{{port}}/\" },",
    );

    let imported = PluginService::new()
        .import_manifest(&manifest, ManifestSource::Bundled)
        .expect("optional metadata and console binding should import");

    assert_eq!(
        imported.description.as_deref(),
        Some("Create verified presentations")
    );
    assert_eq!(imported.author.as_deref(), Some("VibeX"));
    assert_eq!(
        imported.console.expect("console binding").url,
        "http://127.0.0.1:{{port}}/"
    );
}

#[test]
fn rejects_unknown_provider_binding() {
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json")
        .replace("officecli", "unknown-provider");

    let error = PluginService::new()
        .import_manifest(&manifest, ManifestSource::Bundled)
        .expect_err("declaring a same-name tool does not register a provider type");

    assert_eq!(error.code(), "plugin_provider_unknown");
}

#[test]
fn imports_action_without_artifact_provider_binding() {
    let mut manifest: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/office-presentation.vibex-plugin.json"
    ))
    .expect("fixture JSON");
    manifest["actions"][0]
        .as_object_mut()
        .expect("action object")
        .remove("artifactIntent");

    let imported = PluginService::new()
        .import_manifest(&manifest.to_string(), ManifestSource::Bundled)
        .expect("artifact provider binding is optional");

    assert!(imported.actions[0].artifact_intent.is_none());
}
