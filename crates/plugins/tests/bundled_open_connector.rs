//! Open Connector is an official Host-bundled plugin: inspect must stay
//! clean so the Host never needs a plugin-id branch.

use plugins::{PackageFormat, PluginPackage, PluginSourceKind};

fn bundled() -> PluginPackage {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/plugins/open-connector");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("Open Connector package")
}

#[test]
fn bundled_open_connector_is_an_official_worker_http_plugin() {
    let package = bundled();
    assert_eq!(package.id.as_str(), "vibex.open-connector");
    assert_eq!(package.publisher.as_deref(), Some("vibex"));
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert!(
        package.warnings.is_empty(),
        "the package must parse cleanly: {:?}",
        package.warnings
    );
    assert!(package.entrypoints.worker.is_some());
    assert!(
        package.app.tabs.iter().any(|tab| tab.id == "console"),
        "console tab missing: {:?}",
        package.app.tabs
    );
    assert!(
        package
            .app
            .surfaces
            .iter()
            .any(|surface| surface.slot == "plugin.detail.panel"),
        "detail panel missing: {:?}",
        package.app.surfaces
    );
    let mcp = package
        .mcp
        .get("mcp")
        .or_else(|| {
            package
                .mcp
                .get("mcpServers")
                .and_then(|value| value.get("mcp"))
        })
        .unwrap_or(&package.mcp);
    assert_eq!(
        mcp.pointer("/managedRuntime/kind")
            .and_then(|value| value.as_str()),
        Some("workerHttp")
    );
    assert!(
        mcp.get("tools")
            .and_then(|value| value.as_array())
            .is_some_and(|tools| !tools.is_empty()),
        "declared MCP tools missing: {mcp}"
    );
}

#[test]
fn bundled_open_connector_has_no_app_tab_remote_dev_overlay() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/plugins/open-connector");
    assert!(
        !root.join(".vibex-plugin/dev-remote.json").is_file(),
        "packaged official plugins must not ship a plugin-dev remote overlay"
    );
}
