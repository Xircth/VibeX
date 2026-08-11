use std::sync::Arc;

use plugins::{
    ConflictDecision, ImportDisposition, InMemoryPluginRegistry, PluginActivation,
    PluginControlPlane, PluginPackage, PluginSourceKind, RuntimeInstallation,
};

fn package(id: &str, source: PluginSourceKind, root: &std::path::Path) -> PluginPackage {
    PluginPackage::for_test(id, "Test plugin", "1.0.0", source, root)
}

#[tokio::test]
async fn import_is_disabled_and_same_id_requires_an_explicit_decision() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let first_root = tempfile::tempdir().unwrap();
    let second_root = tempfile::tempdir().unwrap();

    let first = package(
        "dev.vibex.same-id",
        PluginSourceKind::Snapshot,
        first_root.path(),
    );
    let imported = control_plane
        .import(first, ConflictDecision::Reject)
        .await
        .expect("first import");
    assert_eq!(imported.disposition, ImportDisposition::Installed);
    assert_eq!(imported.plugin.activation, PluginActivation::Disabled);

    control_plane
        .grant_shell_trust("dev.vibex.same-id")
        .await
        .expect("trust grant");

    let replacement = package(
        "dev.vibex.same-id",
        PluginSourceKind::DeveloperLink,
        second_root.path(),
    );
    let conflict = control_plane
        .preview_import(&replacement)
        .await
        .expect("preview conflict")
        .expect("same id conflicts");
    assert_eq!(
        conflict.installed_source,
        first_root.path().canonicalize().unwrap()
    );
    assert_eq!(
        conflict.incoming_source,
        second_root.path().canonicalize().unwrap()
    );

    let kept = control_plane
        .import(replacement.clone(), ConflictDecision::KeepInstalled)
        .await
        .expect("keep existing");
    assert_eq!(kept.disposition, ImportDisposition::KeptInstalled);
    assert_eq!(
        kept.plugin.source.path,
        first_root.path().canonicalize().unwrap()
    );

    let replaced = control_plane
        .import(replacement, ConflictDecision::Replace)
        .await
        .expect("replace existing");
    assert_eq!(replaced.disposition, ImportDisposition::Replaced);
    assert_eq!(
        replaced.plugin.source.path,
        second_root.path().canonicalize().unwrap()
    );
    assert!(
        replaced.plugin.shell_trusted,
        "trust is keyed only by plugin id"
    );
}

#[tokio::test]
async fn uninstall_revokes_trust_but_retains_global_runtime_inventory() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let package = package("dev.vibex.remove", PluginSourceKind::Snapshot, root.path());

    control_plane
        .import(package, ConflictDecision::Reject)
        .await
        .expect("import plugin");
    control_plane
        .grant_shell_trust("dev.vibex.remove")
        .await
        .expect("trust grant");
    control_plane
        .record_runtime_for_test("example-cli", "1.0.0", "/usr/local/bin/example")
        .await
        .expect("runtime lock");

    control_plane
        .uninstall("dev.vibex.remove")
        .await
        .expect("uninstall");

    assert!(
        control_plane
            .plugin("dev.vibex.remove")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !control_plane
            .is_shell_trusted("dev.vibex.remove")
            .await
            .unwrap()
    );
    assert_eq!(control_plane.runtime_inventory().await.unwrap().len(), 1);
}

#[tokio::test]
async fn runtime_version_conflict_names_every_plugin_that_will_be_removed() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let mut first = package("dev.vibex.first", PluginSourceKind::Snapshot, root.path());
    first.runtimes.push(runtime("shared-cli", "1.0.0"));
    let mut second = package("dev.vibex.second", PluginSourceKind::Snapshot, root.path());
    second.runtimes.push(runtime("shared-cli", "1.0.0"));
    let mut incoming = package(
        "dev.vibex.incoming",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    incoming.runtimes.push(runtime("shared-cli", "2.0.0"));
    for plugin in [first, second, incoming] {
        control_plane
            .import(plugin, ConflictDecision::Reject)
            .await
            .unwrap();
    }
    control_plane
        .record_runtime(RuntimeInstallation {
            id: "shared-cli".to_owned(),
            version: "1.0.0".to_owned(),
            executable_path: "/usr/local/bin/shared".into(),
            installer: "existing".to_owned(),
            probe: vec!["--version".to_owned()],
        })
        .await
        .unwrap();

    let conflict = control_plane
        .preview_runtime_install("dev.vibex.incoming", "shared-cli")
        .await
        .unwrap()
        .unwrap();

    assert_eq!(conflict.current_version, "1.0.0");
    assert_eq!(conflict.target_version, "2.0.0");
    assert_eq!(
        conflict.affected_plugins,
        vec!["dev.vibex.first", "dev.vibex.second"]
    );
}

#[tokio::test]
async fn enabled_portable_action_resolves_from_the_unified_catalog() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let mut plugin = package("dev.vibex.actions", PluginSourceKind::Snapshot, root.path());
    plugin.invocations.push(plugins::InvocationDefinition {
        id: "review".to_owned(),
        label: "Review".to_owned(),
        prompt: "Use the review Skill.".to_owned(),
        skill: Some("test".to_owned()),
        kind: plugins::InvocationKind::Action,
    });
    control_plane
        .import(plugin, ConflictDecision::Reject)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.actions", true)
        .await
        .unwrap();

    let action = control_plane
        .resolve_action("dev.vibex.actions", "review")
        .await
        .unwrap();

    assert_eq!(action.id.as_str(), "review");
    assert_eq!(action.required_skills[0].as_str(), "test");
    assert_eq!(
        action.prompt_blocks,
        vec![plugins::PromptBlock::Text {
            text: "Use the review Skill.".to_owned()
        }]
    );
}

fn runtime(id: &str, version: &str) -> plugins::RuntimeContribution {
    plugins::RuntimeContribution {
        id: id.to_owned(),
        command: "shared".to_owned(),
        version: Some(version.to_owned()),
        probe: vec!["--version".to_owned()],
        install: plugins::RuntimeInstall::Existing,
    }
}
