use std::fs;

use plugins::{
    FileOpenerTarget, PackageFormat, PluginPackage, PluginSourceKind, package_content_digest,
};

fn write(path: &std::path::Path, contents: &str) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    fs::write(path, contents).expect("write fixture");
}

#[test]
fn legacy_persisted_package_without_config_migrates_to_an_empty_object() {
    let root = tempfile::tempdir().expect("package root");
    let package = PluginPackage::for_test(
        "dev.vibex.legacy",
        "Legacy",
        "1.0.0",
        PluginSourceKind::Builtin,
        root.path(),
    );
    let mut persisted = serde_json::to_value(package).expect("serialize package");
    persisted
        .as_object_mut()
        .expect("package object")
        .remove("config");

    let restored: PluginPackage =
        serde_json::from_value(persisted).expect("restore legacy package");

    assert_eq!(restored.config, serde_json::json!({}));
}

#[test]
fn v4_product_package_reads_readme_summary_content_and_mutable_root_config() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.documents","publisher":"dev.vibex","name":"Documents","version":"1.0.0",
          "readme":"README.md",
          "content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object","properties":{"preview":{"type":"boolean"}},"additionalProperties":false}},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "integrations":[{"id":"documents","kind":"content.skill","resource":"contents/skills/documents"}]
        }"#,
    );
    write(
        &root.path().join("README.md"),
        "---\nsummary: Create and review documents in VibeX.\n---\n# Documents\n\nUse the included workflows.\n",
    );
    write(&root.path().join("config.json"), r#"{"preview":true}"#);
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[{"path":"contents/skills/documents/SKILL.md","kind":"skill","title":"Documents"}]}"#,
    );
    write(
        &root.path().join("contents/skills/documents/SKILL.md"),
        "---\nname: documents\ndescription: Work with documents.\n---\n",
    );

    let mut package =
        PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).expect("product package");

    assert_eq!(package.summary, "Create and review documents in VibeX.");
    assert_eq!(package.readme_path, "README.md");
    assert_eq!(package.content_index.items.len(), 1);
    assert_eq!(package.config, serde_json::json!({"preview": true}));

    package
        .write_config(serde_json::json!({"preview": false}))
        .expect("write validated root config");
    assert_eq!(
        fs::read_to_string(root.path().join("config.json")).unwrap(),
        "{\n  \"preview\": false\n}\n"
    );
    assert_eq!(
        package
            .product_detail()
            .expect("read product detail after config edit")
            .config,
        serde_json::json!({"preview": false}),
        "product detail must read the root config.json truth instead of a stale package snapshot"
    );
    assert!(
        package
            .write_config(serde_json::json!({"unknown": true}))
            .is_err()
    );

    let digest = package_content_digest(root.path()).expect("package digest");
    write(&root.path().join("config.json"), r#"{"preview":false}"#);
    assert_eq!(
        package_content_digest(root.path()).expect("digest after config edit"),
        digest,
        "config.json is mutable installation state, not executable package content"
    );

    let candidates = tempfile::tempdir().expect("candidate storage");
    package
        .freeze_execution_root(candidates.path(), &digest)
        .expect("product candidate keeps a validated config without hashing it");
    assert!(package.content_root().join("config.json").is_file());
}

#[test]
fn v4_product_package_requires_a_single_sentence_readme_summary() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.bad-summary","publisher":"dev.vibex","name":"Bad summary","version":"1.0.0",
          "readme":"README.md","content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object"}},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "integrations":[{"id":"documents","kind":"content.skill","resource":"contents/skills/documents"}]
        }"#,
    );
    write(
        &root.path().join("README.md"),
        "# Missing summary frontmatter\n",
    );
    write(&root.path().join("config.json"), "{}");
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[]}"#,
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect_err("summary tag is required");
    assert_eq!(error.code(), "plugin_manifest_invalid");
    assert!(error.to_string().contains("summary"));
}

#[test]
fn snapshot_update_preserves_the_root_config_file() {
    let first = tempfile::tempdir().expect("first package");
    let update = tempfile::tempdir().expect("updated package");
    let storage = tempfile::tempdir().expect("installed packages");
    for (root, version) in [(first.path(), "1.0.0"), (update.path(), "1.1.0")] {
        write(
            &root.join(".vibex-plugin/plugin.json"),
            &format!(
                r#"{{
                  "manifestVersion":4,"apiVersion":"1.0",
                  "id":"dev.vibex.config","publisher":"dev.vibex","name":"Config","version":"{version}",
                  "readme":"README.md","content":{{"root":"contents","index":".vibex-plugin/content.index.json"}},
                  "config":{{"schema":{{"type":"object","properties":{{"preview":{{"type":"boolean"}}}},"additionalProperties":false}}}},
                  "engines":{{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"}},
                  "integrations":[{{"id":"config","kind":"content.skill","resource":"contents/skills/config"}}]
                }}"#
            ),
        );
        write(
            &root.join("README.md"),
            "---\nsummary: Preserve settings when this plugin is updated.\n---\n# Config\n",
        );
        write(&root.join("config.json"), r#"{"preview":true}"#);
        write(
            &root.join(".vibex-plugin/content.index.json"),
            r#"{"schemaVersion":1,"items":[{"path":"contents/skills/config/SKILL.md","kind":"skill","title":"Config"}]}"#,
        );
        write(
            &root.join("contents/skills/config/SKILL.md"),
            "---\nname: config\ndescription: Config\n---\n",
        );
    }

    let installed =
        PluginPackage::materialize(first.path(), storage.path(), PluginSourceKind::Snapshot)
            .expect("install first version");
    installed
        .write_config(serde_json::json!({"preview": false}))
        .expect("change user config");

    let updated =
        PluginPackage::materialize(update.path(), storage.path(), PluginSourceKind::Snapshot)
            .expect("install update");

    assert_eq!(updated.version, "1.1.0");
    assert_eq!(updated.config, serde_json::json!({"preview": false}));
}

#[test]
fn marketplace_install_copies_a_temp_package_into_durable_storage() {
    let source = tempfile::tempdir().expect("downloaded package");
    let storage = tempfile::tempdir().expect("installed packages");
    write(
        &source.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"drawio","publisher":"vibex","name":"Drawio","version":"1.0.0",
          "readme":"README.md","content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object","additionalProperties":false}},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "integrations":[{"id":"drawio","kind":"content.skill","resource":"contents/skills/drawio"}]
        }"#,
    );
    write(
        &source.path().join("README.md"),
        "---\nsummary: Preview Drawio diagrams in VibeX.\n---\n# Drawio\n",
    );
    write(&source.path().join("config.json"), "{}");
    write(
        &source.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[{"path":"contents/skills/drawio/SKILL.md","kind":"skill","title":"Drawio"}]}"#,
    );
    write(
        &source.path().join("contents/skills/drawio/SKILL.md"),
        "---\nname: drawio\ndescription: Drawio\n---\n",
    );
    let installed =
        PluginPackage::materialize(source.path(), storage.path(), PluginSourceKind::Marketplace)
            .expect("persist marketplace package");
    drop(source);
    assert!(installed.source.path.join("README.md").is_file());
    assert_eq!(
        installed.source.path,
        storage.path().canonicalize().unwrap().join("drawio")
    );
    installed
        .product_detail()
        .expect("detail still loads after the download temp dir is gone");
}

#[test]
fn snapshot_update_drops_removed_config_fields_and_keeps_valid_values() {
    let first = tempfile::tempdir().expect("first package");
    let update = tempfile::tempdir().expect("updated package");
    let storage = tempfile::tempdir().expect("installed packages");
    let schemas = [
        (
            first.path(),
            "1.0.0",
            r#"{"previewMode":{"type":"string"},"timeout":{"type":"integer"}}"#,
            r#"{"previewMode":"live","timeout":10}"#,
        ),
        (
            update.path(),
            "1.1.0",
            r#"{"timeout":{"type":"integer"}}"#,
            r#"{"timeout":10}"#,
        ),
    ];
    for (root, version, properties, config) in schemas {
        write(
            &root.join(".vibex-plugin/plugin.json"),
            &format!(
                r#"{{
                  "manifestVersion":4,"apiVersion":"1.0",
                  "id":"dev.vibex.config-migrate","publisher":"dev.vibex","name":"Config","version":"{version}",
                  "readme":"README.md","content":{{"root":"contents","index":".vibex-plugin/content.index.json"}},
                  "config":{{"schema":{{"type":"object","properties":{properties},"additionalProperties":false}}}},
                  "engines":{{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"}},
                  "integrations":[{{"id":"config","kind":"content.skill","resource":"contents/skills/config"}}]
                }}"#
            ),
        );
        write(
            &root.join("README.md"),
            "---\nsummary: Keep valid settings when this plugin schema shrinks.\n---\n# Config\n",
        );
        write(&root.join("config.json"), config);
        write(
            &root.join(".vibex-plugin/content.index.json"),
            r#"{"schemaVersion":1,"items":[{"path":"contents/skills/config/SKILL.md","kind":"skill","title":"Config"}]}"#,
        );
        write(
            &root.join("contents/skills/config/SKILL.md"),
            "---\nname: config\ndescription: Config\n---\n",
        );
    }

    let installed =
        PluginPackage::materialize(first.path(), storage.path(), PluginSourceKind::Snapshot)
            .expect("install first version");
    installed
        .write_config(serde_json::json!({"previewMode": "live", "timeout": 7}))
        .expect("change user config");

    let updated =
        PluginPackage::materialize(update.path(), storage.path(), PluginSourceKind::Snapshot)
            .expect("schema shrink must not fail the package update");

    assert_eq!(updated.version, "1.1.0");
    assert_eq!(updated.config, serde_json::json!({"timeout": 7}));
}

#[test]
fn developer_link_executes_an_immutable_content_addressed_candidate() {
    let source = tempfile::tempdir().expect("linked package source");
    let storage = tempfile::tempdir().expect("candidate storage");
    write(
        &source.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "id":"dev.vibex.frozen",
          "publisher":"dev.vibex",
          "name":"Frozen",
          "version":"1.0.0"
        }"#,
    );
    write(
        &source.path().join("skills/frozen/SKILL.md"),
        "---\nname: frozen\ndescription: Frozen candidate\n---\noriginal\n",
    );
    let mut package = PluginPackage::inspect(source.path(), PluginSourceKind::DeveloperLink)
        .expect("inspect linked package");
    let digest = package_content_digest(source.path()).expect("source digest");

    package
        .freeze_execution_root(storage.path(), &digest)
        .expect("freeze candidate");
    let frozen_root = package.content_root().to_path_buf();
    write(
        &source.path().join("skills/frozen/SKILL.md"),
        "---\nname: frozen\ndescription: Mutated source\n---\nchanged\n",
    );

    assert_ne!(package_content_digest(source.path()).unwrap(), digest);
    assert_eq!(package_content_digest(&frozen_root).unwrap(), digest);
    assert_eq!(package.source.path, source.path().canonicalize().unwrap());
    assert_ne!(package.content_root(), package.source.path);
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
fn portable_package_requires_at_least_one_contribution() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{"id":"dev.vibex.empty","name":"Empty","version":"1.0.0"}"#,
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect_err("empty packages do not extend the product");

    assert_eq!(error.code(), "plugin_contribution_required");
}

#[test]
fn v4_rejects_an_orphan_file_opener_without_a_preview_provider() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "$schema":"vibex-plugin/v4",
          "manifestVersion":4,
          "apiVersion":"1.0",
          "id":"dev.vibex.markdown-preview",
          "publisher":"dev.vibex",
          "name":"Markdown Preview",
          "version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "contributes":{
            "app.fileOpeners":[{
                "id":"preview",
                "kindVersion":1,
                "label":"Markdown Preview",
                "extensions":["md","mdx"],
                "mediaTypes":["text/markdown"],
                "priority":50,
                "previewProvider":"preview.open"
              }]
          }
        }"#,
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect_err("file openers must reference a published preview provider");
    assert!(error.to_string().contains("missing contribution"));
}

#[test]
fn product_package_can_bind_a_file_opener_to_a_generic_artifact_editor_surface() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.diagram-editor","publisher":"dev.vibex","name":"Diagram editor","version":"1.0.0",
          "readme":"README.md","content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object","additionalProperties":false}},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{
            "worker":{"path":"dist/worker.mjs","runtime":"node","protocol":"1.1"},
            "app":{"root":"dist/app","document":"index.html","protocol":"1.0"}
          },
          "integrations":[
            {"id":"diagram-files","kind":"file.opener","label":"Diagram","extensions":["drawio"],"priority":100,"editorSurface":"diagram-editor"},
            {"id":"diagram-editor","kind":"app.surface","label":"Diagram editor","slot":"artifact.editor","appEntrypoint":"app","handler":"surface.createSession"}
          ]
        }"#,
    );
    write(
        &root.path().join("README.md"),
        "---\nsummary: Edit diagrams in their VibeX file tabs.\n---\n# Diagram editor\n",
    );
    write(&root.path().join("config.json"), "{}");
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[]}"#,
    );
    write(&root.path().join("dist/worker.mjs"), "export default {};");
    write(
        &root.path().join("dist/app/index.html"),
        "<!doctype html><main>editor</main>",
    );

    let package = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect("generic artifact editor package");

    assert_eq!(package.app.file_openers.len(), 1);
    assert_eq!(
        package.app.file_openers[0].target,
        FileOpenerTarget::AppSurface
    );
    assert_eq!(package.app.file_openers[0].handler, "diagram-editor");
    assert_eq!(package.app.surfaces[0].slot, "artifact.editor");
}

#[test]
fn v4_rejects_shell_installers_before_install_or_trust_prompts() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.shell","publisher":"dev.vibex","name":"Shell","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "runtimes":[{"id":"unsafe","command":"unsafe","install":{"type":"shell","command":"curl example | sh"}}]
        }"#,
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect_err("v4 packages must not execute arbitrary installer shells");
    assert_eq!(error.code(), "plugin_manifest_invalid");
}

#[test]
fn v4_fails_closed_for_unknown_permissions_and_invalid_entrypoints() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.closed","publisher":"dev.vibex","name":"Closed","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{"worker":{"path":"missing.mjs"}},
          "permissions":[{"id":"root","capability":"host.root","scope":{},"reason":"no"}],
          "contributes":{"agent.skills":[{"id":"skill","kindVersion":1,"path":"skills/skill"}]}
        }"#,
    );
    write(
        &root.path().join("skills/skill/SKILL.md"),
        "---\nname: skill\ndescription: Skill\n---\n",
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap_err();
    assert_eq!(error.code(), "plugin_manifest_invalid");
}

#[test]
fn v4_accepts_legacy_trust_tier_metadata_under_full_trust() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.native","publisher":"dev.vibex","name":"Native","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "permissions":[{
            "id":"run","capability":"runtime.execute","scope":{"runtime":"tool"},
            "reason":"Run tool","trustTier":"sandboxed_worker"
          }],
          "contributes":{"agent.skills":[{"id":"skill","kindVersion":1,"path":"skills/skill"}]}
        }"#,
    );
    write(
        &root.path().join("skills/skill/SKILL.md"),
        "---\nname: skill\ndescription: Skill\n---\n",
    );

    let package = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap();

    assert_eq!(package.permissions.len(), 1);
    assert_eq!(package.permissions[0].capability, "runtime.execute");
}

#[test]
fn v4_rejects_unknown_manifest_fields_before_install() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.unknown","publisher":"dev.vibex","name":"Unknown","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "app.unknownSurface":{},
          "contributes":{"agent.skills":[{"id":"skill","kindVersion":1,"path":"skills/skill"}]}
        }"#,
    );
    write(
        &root.path().join("skills/skill/SKILL.md"),
        "---\nname: skill\ndescription: Skill\n---\n",
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap_err();
    assert_eq!(error.code(), "plugin_manifest_invalid");
    assert!(error.to_string().contains("unknown v4 manifest field"));
}

#[test]
fn v4_rejects_unknown_contribution_fields_before_install() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.unknown-contribution","publisher":"dev.vibex",
          "name":"Unknown contribution","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "contributes":{"agent.skills":[{
            "id":"skill","kindVersion":1,"path":"skills/skill","ambientAuthority":true
          }]}
        }"#,
    );
    write(
        &root.path().join("skills/skill/SKILL.md"),
        "---\nname: skill\ndescription: Skill\n---\n",
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap_err();
    assert!(error.to_string().contains("unknown v4 agent.skills field"));
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

#[test]
fn v4_rejects_plugin_kind_dependencies_with_a_stable_code() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.dep","publisher":"dev.vibex","name":"Dep","version":"1.0.0",
          "readme":"README.md",
          "content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "dependencies":[{"kind":"plugin","id":"dev.vibex.other"}],
          "integrations":[{"id":"documents","kind":"content.skill","resource":"contents/skills/documents"}]
        }"#,
    );
    write(
        &root.path().join("README.md"),
        "---\nsummary: Dep\n---\n# Dep\n",
    );
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[{"path":"contents/skills/documents/SKILL.md","kind":"skill","title":"Documents"}]}"#,
    );
    write(
        &root.path().join("contents/skills/documents/SKILL.md"),
        "---\nname: documents\ndescription: Documents\n---\n",
    );
    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap_err();
    assert_eq!(error.code(), "dependency_kind_unsupported");
}

#[test]
fn v4_rejects_conversation_timeline_card_slot_with_a_stable_code() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.card","publisher":"dev.vibex","name":"Card","version":"1.0.0",
          "readme":"README.md",
          "content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{"app":{"root":"app","document":"index.html","protocol":"1.0"}},
          "integrations":[{
            "id":"card",
            "kind":"app.surface",
            "slot":"conversation.timeline.card",
            "appEntrypoint":"app",
            "handler":"surface.createSession"
          }]
        }"#,
    );
    write(
        &root.path().join("README.md"),
        "---\nsummary: Card\n---\n# Card\n",
    );
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[]}"#,
    );
    write(&root.path().join("app/index.html"), "<main></main>");
    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).unwrap_err();
    assert_eq!(error.code(), "app_surface_slot_unsupported");
}
