use std::fs;

use plugins::{PackageFormat, PluginPackage, PluginSourceKind};

fn write(path: &std::path::Path, contents: &str) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    fs::write(path, contents).expect("write fixture");
}

#[test]
fn portable_package_auto_discovers_skills_and_preserves_unknown_fields() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "$schema": "vibex-plugin/v3",
          "id": "dev.vibex.example",
          "name": "Example",
          "version": "1.2.3",
          "publisherNote": "kept for future hosts",
          "runtimes": [{"id":"example-cli","command":"example","install":{"type":"unknown-manager"}}]
        }"#,
    );
    write(
        &root.path().join("skills/example/SKILL.md"),
        "---\nname: example\ndescription: Example skill\n---\nUse example-cli.\n",
    );

    let package = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect("tolerant package should import");

    assert_eq!(package.id.as_str(), "dev.vibex.example");
    assert_eq!(package.skills.len(), 1);
    assert_eq!(package.skills[0].path, "skills/example/SKILL.md");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert_eq!(package.extensions["publisherNote"], "kept for future hosts");
    assert_eq!(
        package.runtimes.len(),
        0,
        "invalid optional runtime is isolated"
    );
    assert!(package.warnings.iter().any(|warning| {
        warning.code == "runtime_unsupported"
            && warning.contribution.as_deref() == Some("example-cli")
    }));
}

#[test]
fn co_located_manifests_are_one_package_with_format_badges() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{"id":"dev.vibex.shared","name":"Shared","version":"1.0.0"}"#,
    );
    write(
        &root.path().join(".codex-plugin/plugin.json"),
        r#"{"name":"shared","version":"1.0.0"}"#,
    );
    write(
        &root.path().join(".claude-plugin/plugin.json"),
        r#"{"name":"shared","version":"1.0.0"}"#,
    );
    write(
        &root.path().join("skills/shared/SKILL.md"),
        "---\nname: shared\ndescription: Shared skill\n---\n",
    );

    let package = PluginPackage::inspect(root.path(), PluginSourceKind::DeveloperLink)
        .expect("multi-format package");

    assert_eq!(
        package.formats,
        vec![
            PackageFormat::VibeX,
            PackageFormat::Codex,
            PackageFormat::ClaudeCode
        ]
    );
    assert_eq!(package.source.kind, PluginSourceKind::DeveloperLink);
    assert_eq!(package.source.path, root.path().canonicalize().unwrap());
}

#[test]
fn portable_package_requires_a_skill() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{"id":"dev.vibex.empty","name":"Empty","version":"1.0.0"}"#,
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect_err("portable plugins are skill-first");

    assert_eq!(error.code(), "plugin_skill_required");
}

#[test]
fn snapshot_materialization_is_stable_and_developer_link_stays_external() {
    let source = tempfile::tempdir().unwrap();
    let storage = tempfile::tempdir().unwrap();
    write(
        &source.path().join(".vibex-plugin/plugin.json"),
        r#"{"id":"dev.vibex.snapshot","name":"Snapshot","version":"1.0.0"}"#,
    );
    write(
        &source.path().join("skills/snapshot/SKILL.md"),
        "---\nname: snapshot\ndescription: Snapshot\n---\n",
    );

    let snapshot =
        PluginPackage::materialize(source.path(), storage.path(), PluginSourceKind::Snapshot)
            .expect("materialize snapshot");
    let linked = PluginPackage::materialize(
        source.path(),
        storage.path(),
        PluginSourceKind::DeveloperLink,
    )
    .expect("inspect developer link");

    assert_eq!(
        snapshot.source.path,
        storage
            .path()
            .join("dev.vibex.snapshot")
            .canonicalize()
            .unwrap()
    );
    assert!(
        snapshot
            .source
            .path
            .join("skills/snapshot/SKILL.md")
            .is_file()
    );
    assert_eq!(linked.source.path, source.path().canonicalize().unwrap());
}

#[test]
fn actions_and_commands_share_one_invocation_definition() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "id":"dev.vibex.invoke","name":"Invoke","version":"1.0.0",
          "actions":[{"id":"review","label":"Review","skill":"review","prompt":"Review with the Skill."}],
          "commands":[{"id":"review","label":"Review command","promptBlocks":[{"type":"text","text":"Run review."}]}]
        }"#,
    );
    write(
        &root.path().join("skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review\n---\n",
    );

    let package = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap();

    assert_eq!(package.invocations.len(), 2);
    assert_eq!(package.invocations[0].id, "review");
    assert_eq!(package.invocations[0].prompt, "Review with the Skill.");
    assert_eq!(package.invocations[0].skill.as_deref(), Some("review"));
    assert_eq!(package.invocations[1].prompt, "Run review.");
}
