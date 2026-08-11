use std::fs;

use plugins::{
    ConflictDecision, FilesystemNativePluginAdapter, NativeEcosystem, NativePluginAdapter,
    OfficialCliNativePluginAdapter, PluginSourceKind, parse_official_plugin_import_commands,
};

fn write(path: &std::path::Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[tokio::test]
async fn discovers_native_plugins_without_copying_them_into_vibex() {
    let native_root = tempfile::tempdir().unwrap();
    let plugin_root = native_root.path().join("shared");
    write(
        &plugin_root.join(".codex-plugin/plugin.json"),
        r#"{"name":"shared","version":"2.0.0"}"#,
    );
    write(
        &plugin_root.join("skills/shared/SKILL.md"),
        "---\nname: shared\ndescription: Shared\n---\n",
    );
    let adapter = FilesystemNativePluginAdapter::codex(native_root.path());

    let discovered = adapter.discover().await.expect("native discovery");

    assert_eq!(discovered.len(), 1);
    assert_eq!(discovered[0].id, "shared");
    assert_eq!(discovered[0].ecosystem, NativeEcosystem::Codex);
    assert_eq!(discovered[0].path, plugin_root.canonicalize().unwrap());
    assert_eq!(discovered[0].enabled, None);
    assert!(adapter.capabilities().discover);
    assert!(adapter.capabilities().install);
    assert!(
        !adapter.capabilities().enable,
        "adapter must not guess native config"
    );
}

#[tokio::test]
async fn imports_to_native_location_and_external_changes_reconcile() {
    let native_root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    write(
        &source.path().join(".claude-plugin/plugin.json"),
        r#"{"name":"writer","version":"1.0.0"}"#,
    );
    write(
        &source.path().join("skills/writer/SKILL.md"),
        "---\nname: writer\ndescription: Writer\n---\n",
    );
    let adapter = FilesystemNativePluginAdapter::claude_code(native_root.path());

    let installed = adapter
        .install(
            source.path(),
            PluginSourceKind::Snapshot,
            ConflictDecision::Reject,
        )
        .await
        .expect("native install");
    assert_eq!(
        installed.path,
        native_root.path().join("writer").canonicalize().unwrap()
    );
    assert!(installed.path.join("skills/writer/SKILL.md").is_file());

    fs::remove_dir_all(&installed.path).expect("external native removal");
    assert!(adapter.discover().await.unwrap().is_empty());
}

#[tokio::test]
async fn unsupported_native_enable_is_explicit() {
    let native_root = tempfile::tempdir().unwrap();
    let adapter = FilesystemNativePluginAdapter::codex(native_root.path());

    let error = adapter
        .set_enabled("shared", true)
        .await
        .expect_err("filesystem discovery has no reliable enable contract");

    assert_eq!(error.code(), "native_operation_unsupported");
}

#[tokio::test]
async fn cache_discovery_is_recursive_and_read_only() {
    let native_root = tempfile::tempdir().unwrap();
    let cached = native_root.path().join("market/plugin/1.0.0");
    write(
        &cached.join(".codex-plugin/plugin.json"),
        r#"{"name":"nested","version":"1.0.0"}"#,
    );
    let adapter = FilesystemNativePluginAdapter::codex(native_root.path()).read_only();

    assert_eq!(adapter.discover().await.unwrap()[0].id, "nested");
    assert!(!adapter.capabilities().install);
    assert!(!adapter.capabilities().uninstall);
    assert_eq!(
        adapter.uninstall("nested").await.unwrap_err().code(),
        "native_operation_unsupported"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn claude_lifecycle_uses_only_official_plugin_commands() {
    use std::os::unix::fs::PermissionsExt as _;

    let fixture = tempfile::tempdir().unwrap();
    let plugin_root = fixture.path().join("frontend");
    fs::create_dir_all(&plugin_root).unwrap();
    let calls = fixture.path().join("calls.log");
    let cli = fixture.path().join("claude");
    write(
        &cli,
        &format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
if [ "$1 $2" = "plugin list" ]; then
  printf '%s\n' '[{{"id":"frontend@official","name":"Frontend","version":"2.0.0","installPath":"{}","enabled":true,"scope":"user"}}]'
fi
"#,
            calls.display(),
            plugin_root.display()
        ),
    );
    let mut permissions = fs::metadata(&cli).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&cli, permissions).unwrap();
    let adapter = OfficialCliNativePluginAdapter::claude_code(&cli);

    let discovered = adapter.discover().await.unwrap();
    assert_eq!(discovered[0].id, "frontend@official");
    assert_eq!(discovered[0].enabled, Some(true));
    assert!(adapter.capabilities().enable);
    assert!(adapter.capabilities().update);
    assert!(adapter.capabilities().uninstall);

    adapter
        .set_enabled("frontend@official", false)
        .await
        .unwrap();
    adapter.update("frontend@official").await.unwrap();
    adapter.uninstall("frontend@official").await.unwrap();

    let invocations = fs::read_to_string(calls).unwrap();
    assert!(invocations.contains("plugin disable frontend@official --scope user"));
    assert!(invocations.contains("plugin update frontend@official --scope user"));
    assert!(invocations.contains("plugin uninstall frontend@official --yes --scope user"));
}

#[test]
fn codex_capabilities_do_not_invent_missing_cli_subcommands() {
    let adapter = OfficialCliNativePluginAdapter::codex("codex");

    assert!(!adapter.capabilities().enable);
    assert!(!adapter.capabilities().update);
    assert!(adapter.capabilities().uninstall);
}

#[test]
fn parses_only_official_plugin_import_commands() {
    let codex = parse_official_plugin_import_commands(
        NativeEcosystem::Codex,
        "codex plugin marketplace add official\ncodex plugin add browser@official",
    )
    .unwrap();
    assert_eq!(codex.len(), 2);
    assert_eq!(codex[1].args, ["plugin", "add", "browser@official"]);

    let claude = parse_official_plugin_import_commands(
        NativeEcosystem::ClaudeCode,
        "claude plugin install frontend@official --scope user",
    )
    .unwrap();
    assert_eq!(claude[0].args[1], "install");
}

#[test]
fn rejects_non_import_and_shell_commands() {
    for command in [
        "claude plugin uninstall frontend@official",
        "claude plugin install frontend@official && rm -rf somewhere",
        "sh -c 'claude plugin install frontend@official'",
    ] {
        let error = parse_official_plugin_import_commands(NativeEcosystem::ClaudeCode, command)
            .unwrap_err();
        assert_eq!(error.code(), "native_command_rejected");
    }
}
