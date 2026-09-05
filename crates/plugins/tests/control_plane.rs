use std::sync::Arc;

use plugins::{
    CapabilityGrant, CapabilityRequest, ConflictDecision, ContributionKind, FileOpenerContribution,
    FileOpenerTarget, ImportDisposition, InMemoryPluginRegistry, PluginActivation,
    PluginControlPlane, PluginPackage, PluginSourceKind, RuntimeInstallation,
    candidate_capability_grants,
};

fn package(id: &str, source: PluginSourceKind, root: &std::path::Path) -> PluginPackage {
    PluginPackage::for_test(id, "Test plugin", "1.0.0", source, root)
}

fn write_linked_package(root: &std::path::Path, body: &str) {
    let skill = root.join("contents/skills/linked/SKILL.md");
    std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.linked","publisher":"dev.vibex","name":"Linked","version":"1.0.0",
          "readme":"README.md",
          "content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object","properties":{},"additionalProperties":false}},
          "engines":{"vibex":">=0.1.3","pluginSdk":"^1.0.0"},
          "integrations":[{"id":"linked","kind":"content.skill","resource":"contents/skills/linked"}]
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[{"path":"contents/skills/linked/SKILL.md","kind":"skill","title":"Linked"}]}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("README.md"),
        "---\nsummary: Linked development plugin.\n---\n# Linked\n",
    )
    .unwrap();
    std::fs::write(root.join("config.json"), "{}\n").unwrap();
    std::fs::write(
        &skill,
        format!("---\nname: linked\ndescription: Linked skill.\n---\n{body}\n"),
    )
    .unwrap();
}

#[test]
fn full_trust_candidates_implicitly_receive_every_declared_host_capability() {
    let root = tempfile::tempdir().unwrap();
    let mut candidate = package(
        "dev.vibex.permissions",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    candidate.permissions = vec![
        CapabilityRequest {
            id: "existing".to_owned(),
            capability: "runtime.execute".to_owned(),
            scope: serde_json::json!({"runtime":"tool","operations":["inspect"]}),
            reason: "Inspect".to_owned(),
            optional: false,
            trust_tier: "trusted_native".to_owned(),
        },
        CapabilityRequest {
            id: "new-export".to_owned(),
            capability: "artifact.preview".to_owned(),
            scope: serde_json::json!({"providers":["report"]}),
            reason: "Preview report".to_owned(),
            optional: false,
            trust_tier: "trusted_native".to_owned(),
        },
    ];
    let published = vec![CapabilityGrant {
        capability: "runtime.execute".to_owned(),
        scope: serde_json::json!({"runtime":"tool","operations":["inspect"]}),
        trust_tier: "trusted_native".to_owned(),
    }];

    let implicit = candidate_capability_grants(&candidate, &published, &[]).unwrap();
    assert_eq!(implicit.len(), 2);
    let ordinary_grant = vec![CapabilityGrant {
        capability: "runtime.execute".to_owned(),
        scope: serde_json::json!({"runtime":"tool","operations":["inspect"]}),
        trust_tier: "sandboxed_worker".to_owned(),
    }];
    let escalation =
        candidate_capability_grants(&candidate, &ordinary_grant, &["new-export".to_owned()])
            .unwrap();
    assert_eq!(escalation.len(), 2);
    let grants =
        candidate_capability_grants(&candidate, &published, &["new-export".to_owned()]).unwrap();
    assert_eq!(grants.len(), 2);
    let unknown =
        candidate_capability_grants(&candidate, &published, &["ambient".to_owned()]).unwrap();
    assert_eq!(unknown.len(), 2);
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
}

#[tokio::test]
async fn refresh_developer_links_replaces_changed_source() {
    let root = tempfile::tempdir().unwrap();
    write_linked_package(root.path(), "original");
    let package = PluginPackage::inspect(root.path(), PluginSourceKind::DeveloperLink).unwrap();
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    control
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    let before = control.plugin("dev.vibex.linked").await.unwrap().unwrap();
    write_linked_package(root.path(), "changed");
    let changed = control.refresh_developer_links().await.unwrap();
    assert_eq!(changed, vec!["dev.vibex.linked".to_string()]);
    let after = control.plugin("dev.vibex.linked").await.unwrap().unwrap();
    assert_ne!(after.package_digest, before.package_digest);
    let unchanged = control.refresh_developer_links().await.unwrap();
    assert!(unchanged.is_empty());
    let skill =
        std::fs::read_to_string(root.path().join("contents/skills/linked/SKILL.md")).unwrap();
    assert!(skill.contains("changed"));
}

#[tokio::test]
async fn reclaim_drops_managed_runtimes_with_no_plugin_refs() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let runtime_root = tempfile::tempdir().unwrap();
    let plugin_root = root.path();
    write_linked_package(plugin_root, "runtime");
    let package = PluginPackage::inspect(plugin_root, PluginSourceKind::Snapshot).unwrap();
    control
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    let artifact = runtime_root.path().join("orphan/bin");
    std::fs::create_dir_all(artifact.parent().unwrap()).unwrap();
    std::fs::write(&artifact, "x").unwrap();
    control
        .record_runtime(
            "dev.vibex.linked",
            RuntimeInstallation {
                id: "orphan".into(),
                version: "1.0.0".into(),
                target: "test-target".into(),
                content_digest: "sha256:orphan".into(),
                executable_path: artifact.clone(),
                ownership: "managed".into(),
                installer: "test".into(),
                probe: Vec::new(),
                referenced_plugins: vec!["dev.vibex.linked".into()],
            },
        )
        .await
        .unwrap();
    control.uninstall("dev.vibex.linked").await.unwrap();
    let reclaimed = control
        .reclaim_unreferenced_runtimes(runtime_root.path())
        .await
        .unwrap();
    assert!(!reclaimed.is_empty());
}

#[tokio::test]
async fn replacement_cannot_take_over_another_publishers_plugin_id() {
    let root = tempfile::tempdir().unwrap();
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control = PluginControlPlane::new(registry);
    let mut original = PluginPackage::for_test(
        "dev.vibex.identity",
        "Identity",
        "1.0.0",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    original.publisher = Some("dev.vibex".into());
    control
        .import(original, ConflictDecision::Reject)
        .await
        .unwrap();

    let mut takeover = PluginPackage::for_test(
        "dev.vibex.identity",
        "Identity",
        "2.0.0",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    takeover.publisher = Some("evil.example".into());
    let error = control
        .import(takeover, ConflictDecision::Replace)
        .await
        .expect_err("publisher identity must be immutable");
    assert_eq!(error.code(), "plugin_id_conflict");
}

#[tokio::test]
async fn uninstall_removes_membership_but_retains_runtime_artifacts() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let package = package("dev.vibex.remove", PluginSourceKind::Snapshot, root.path());

    control_plane
        .import(package, ConflictDecision::Reject)
        .await
        .expect("import plugin");
    control_plane
        .record_runtime_for_test(
            "dev.vibex.remove",
            "example-cli",
            "1.0.0",
            "/usr/local/bin/example",
        )
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
    assert_eq!(control_plane.runtime_inventory().await.unwrap().len(), 1);
}

#[tokio::test]
async fn same_runtime_id_can_lock_multiple_versions_without_displacing_plugins() {
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
        .record_runtime(
            "dev.vibex.first",
            RuntimeInstallation {
                id: "shared-cli".to_owned(),
                version: "1.0.0".to_owned(),
                target: "test-target".to_owned(),
                content_digest: "sha256:shared-1".to_owned(),
                executable_path: "/usr/local/bin/shared".into(),
                ownership: "managed".to_owned(),
                installer: "existing".to_owned(),
                probe: vec!["--version".to_owned()],
                referenced_plugins: vec![],
            },
        )
        .await
        .unwrap();
    control_plane
        .record_runtime(
            "dev.vibex.incoming",
            RuntimeInstallation {
                id: "shared-cli".to_owned(),
                version: "2.0.0".to_owned(),
                target: "test-target".to_owned(),
                content_digest: "sha256:shared-2".to_owned(),
                executable_path: "/opt/vibex/shared/2/shared".into(),
                ownership: "managed".to_owned(),
                installer: "binary".to_owned(),
                probe: vec!["--version".to_owned()],
                referenced_plugins: vec![],
            },
        )
        .await
        .unwrap();

    let inventory = control_plane.runtime_inventory().await.unwrap();
    assert_eq!(inventory.len(), 2);
    assert_eq!(inventory[0].version, "1.0.0");
    assert_eq!(inventory[1].version, "2.0.0");
    assert_eq!(inventory[0].referenced_plugins, vec!["dev.vibex.first"]);
    assert_eq!(inventory[1].referenced_plugins, vec!["dev.vibex.incoming"]);
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
        required_skills: vec!["test".to_owned()],
        required_runtimes: Vec::new(),
        handler: None,
        artifact_intent: None,
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
    assert_eq!(action.prompt_blocks.len(), 2);
    assert_eq!(
        action.prompt_blocks[0],
        plugins::PromptBlock::Text {
            text: "Use the review Skill.".to_owned()
        }
    );
    let plugins::PromptBlock::Text { text } = &action.prompt_blocks[1];
    // The resolved path is native, so compare on the logical suffix.
    assert!(
        text.replace('\\', "/").contains("skills/test/SKILL.md"),
        "{text}"
    );
    assert!(!text.contains(r"\\?\"), "verbatim prefix leaked: {text}");
}

#[tokio::test]
async fn activation_publishes_one_atomic_generation_for_app_and_agent_contributions() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let mut plugin = package(
        "dev.vibex.full-stack",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    plugin.app.file_openers.push(FileOpenerContribution {
        id: "preview".to_owned(),
        label: "Document preview".to_owned(),
        extensions: vec!["docx".to_owned()],
        file_name_suffixes: Vec::new(),
        media_types: vec![
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_owned(),
        ],
        priority: 100,
        handler: "document.openPreview".to_owned(),
        target: FileOpenerTarget::PreviewProvider,
    });
    control_plane
        .import(plugin, ConflictDecision::Reject)
        .await
        .unwrap();

    let disabled = control_plane.contributions().await.unwrap();
    assert!(disabled.items.is_empty());

    control_plane
        .set_enabled("dev.vibex.full-stack", true)
        .await
        .unwrap();
    let active = control_plane.contributions().await.unwrap();

    assert!(active.generation > disabled.generation);
    assert_eq!(
        active
            .items
            .iter()
            .filter(|item| item.plugin_id == "dev.vibex.full-stack")
            .map(|item| item.kind)
            .collect::<Vec<_>>(),
        [ContributionKind::Skill, ContributionKind::FileOpener]
    );
    assert!(
        active
            .items
            .iter()
            .all(|item| item.generation == active.generation)
    );

    let unchanged = control_plane.contributions().await.unwrap();
    assert_eq!(unchanged.generation, active.generation);
}

#[tokio::test]
async fn file_opener_resolution_is_deterministic_and_disappears_when_disabled() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let mut plugin = package("dev.vibex.preview", PluginSourceKind::Snapshot, root.path());
    plugin.skills.clear();
    plugin.app.file_openers.push(FileOpenerContribution {
        id: "office".to_owned(),
        label: "Office preview".to_owned(),
        extensions: vec!["docx".to_owned()],
        file_name_suffixes: Vec::new(),
        media_types: Vec::new(),
        priority: 90,
        handler: "office.openPreview".to_owned(),
        target: FileOpenerTarget::PreviewProvider,
    });
    control_plane
        .import(plugin, ConflictDecision::Reject)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.preview", true)
        .await
        .unwrap();

    let resolved = control_plane
        .resolve_file_opener(Some("DOCX"), None)
        .await
        .unwrap()
        .expect("enabled provider");
    assert_eq!(resolved.plugin_id, "dev.vibex.preview");
    assert_eq!(resolved.handler, "office.openPreview");

    control_plane
        .set_enabled("dev.vibex.preview", false)
        .await
        .unwrap();
    assert!(
        control_plane
            .resolve_file_opener(Some("docx"), None)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn file_opener_can_match_a_compound_filename_without_hijacking_json() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let mut plugin = package(
        "dev.vibex.workflow",
        PluginSourceKind::Snapshot,
        root.path(),
    );
    plugin.skills.clear();
    plugin.app.file_openers.push(FileOpenerContribution {
        id: "workflow".to_owned(),
        label: "Workflow Studio".to_owned(),
        extensions: Vec::new(),
        file_name_suffixes: vec![".vibex-workflow.json".to_owned()],
        media_types: Vec::new(),
        priority: 100,
        handler: "workflow.open".to_owned(),
        target: FileOpenerTarget::AppSurface,
    });
    control_plane
        .import(plugin, ConflictDecision::Reject)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.workflow", true)
        .await
        .unwrap();

    assert!(
        control_plane
            .resolve_file_opener(Some("json"), None)
            .await
            .unwrap()
            .is_none()
    );
    let resolved = control_plane
        .resolve_file_opener_for_file(Some("release.vibex-workflow.json"), Some("json"), None)
        .await
        .unwrap()
        .expect("compound Workflow suffix");
    assert_eq!(resolved.handler, "workflow.open");
}

fn with_required_plugin(mut package: PluginPackage, dependency_id: &str) -> PluginPackage {
    package.manifest.as_object_mut().unwrap().insert(
        "depends".to_owned(),
        serde_json::json!([{
            "kind": "plugin",
            "publisher": "dev.vibex.test",
            "id": dependency_id,
            "versionRange": "*",
            "required": true
        }]),
    );
    package
}

#[tokio::test]
async fn disable_withdraws_contributions_before_the_generation_is_gone() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let root = tempfile::tempdir().unwrap();
    let mut plugin = package("dev.vibex.preview", PluginSourceKind::Snapshot, root.path());
    plugin.skills.clear();
    plugin.app.file_openers.push(FileOpenerContribution {
        id: "office".to_owned(),
        label: "Office preview".to_owned(),
        extensions: vec!["docx".to_owned()],
        file_name_suffixes: Vec::new(),
        media_types: Vec::new(),
        priority: 90,
        handler: "office.openPreview".to_owned(),
        target: FileOpenerTarget::PreviewProvider,
    });
    control_plane
        .import(plugin, ConflictDecision::Reject)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.preview", true)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.preview", false)
        .await
        .unwrap();

    assert!(
        control_plane
            .contributions()
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(
        control_plane
            .plugin("dev.vibex.preview")
            .await
            .unwrap()
            .unwrap()
            .activation,
        PluginActivation::Disabled
    );
}

#[tokio::test]
async fn losing_a_required_plugin_unreads_dependents_without_clearing_enable_intent() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let base_root = tempfile::tempdir().unwrap();
    let child_root = tempfile::tempdir().unwrap();
    let base = package(
        "dev.vibex.base",
        PluginSourceKind::Snapshot,
        base_root.path(),
    );
    let child = with_required_plugin(
        package(
            "dev.vibex.child",
            PluginSourceKind::Snapshot,
            child_root.path(),
        ),
        "dev.vibex.base",
    );
    control_plane
        .import(base, ConflictDecision::Reject)
        .await
        .unwrap();
    control_plane
        .import(child, ConflictDecision::Reject)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.base", true)
        .await
        .unwrap();
    control_plane
        .set_enabled("dev.vibex.child", true)
        .await
        .unwrap();
    assert!(
        control_plane
            .contributions()
            .await
            .unwrap()
            .items
            .iter()
            .any(|item| item.plugin_id == "dev.vibex.child")
    );

    control_plane
        .set_enabled("dev.vibex.base", false)
        .await
        .unwrap();

    let child = control_plane
        .plugin("dev.vibex.child")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(child.activation, PluginActivation::Enabled);
    assert!(
        control_plane
            .contributions()
            .await
            .unwrap()
            .items
            .iter()
            .all(|item| item.plugin_id != "dev.vibex.child")
    );
    assert!(
        control_plane
            .resolve_action("dev.vibex.child", "missing")
            .await
            .is_err()
    );

    control_plane
        .set_enabled("dev.vibex.base", true)
        .await
        .unwrap();
    assert!(
        control_plane
            .contributions()
            .await
            .unwrap()
            .items
            .iter()
            .any(|item| item.plugin_id == "dev.vibex.child"),
        "enabled dependents remount when the required plugin is live again"
    );
}

#[tokio::test]
async fn enabling_a_plugin_fails_closed_when_its_required_plugin_is_not_ready() {
    let registry = Arc::new(InMemoryPluginRegistry::default());
    let control_plane = PluginControlPlane::new(registry);
    let base_root = tempfile::tempdir().unwrap();
    let child_root = tempfile::tempdir().unwrap();
    control_plane
        .import(
            package(
                "dev.vibex.base",
                PluginSourceKind::Snapshot,
                base_root.path(),
            ),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();
    control_plane
        .import(
            with_required_plugin(
                package(
                    "dev.vibex.child",
                    PluginSourceKind::Snapshot,
                    child_root.path(),
                ),
                "dev.vibex.base",
            ),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();

    let error = control_plane
        .set_enabled("dev.vibex.child", true)
        .await
        .expect_err("child cannot go live before its dependency");
    assert_eq!(error.code(), "dependency_unsatisfied");
    assert_eq!(
        control_plane
            .plugin("dev.vibex.child")
            .await
            .unwrap()
            .unwrap()
            .activation,
        PluginActivation::Disabled
    );
}

fn runtime(id: &str, version: &str) -> plugins::RuntimeContribution {
    plugins::RuntimeContribution {
        id: id.to_owned(),
        command: "shared".to_owned(),
        version: Some(version.to_owned()),
        target: "test-target".to_owned(),
        content_digest: format!("sha256:{id}-{version}"),
        probe: vec!["--version".to_owned()],
        install: plugins::RuntimeInstall::Existing,
    }
}
