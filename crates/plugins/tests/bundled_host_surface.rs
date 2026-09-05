//! The Batch 2 gate is a public-SDK sample, not a migrated built-in.

use std::sync::Arc;

use plugins::{
    APP_PANEL_SLOT, APP_TAB_SLOT, DenyCapabilityBroker, KANBAN_VIEW_SLOT, PackageFormat,
    PluginPackage, PluginSourceKind, SETTINGS_PAGE_SLOT, WorkerHost,
};
use serde_json::json;

fn bundled() -> PluginPackage {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/host-surface");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("Host surface package")
}

#[test]
fn the_sample_plugin_fills_the_structure_slots() {
    let package = bundled();
    assert_eq!(package.id.as_str(), "vibex.host-surface");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert!(package.warnings.is_empty(), "{:?}", package.warnings);
    assert_eq!(package.app.tabs.len(), 1);
    assert_eq!(package.app.panels.len(), 1);
    assert_eq!(package.app.kanban_views.len(), 1);
    assert_eq!(package.app.composer_actions.len(), 1);
    assert_eq!(package.app.settings_pages.len(), 1);
    assert!(package.permissions.is_empty());
}

#[test]
fn its_surfaces_are_addressable() {
    let package = bundled();
    let slots: Vec<&str> = package
        .app
        .surfaces
        .iter()
        .map(|surface| surface.slot.as_str())
        .collect();
    for slot in [
        APP_PANEL_SLOT,
        APP_TAB_SLOT,
        KANBAN_VIEW_SLOT,
        SETTINGS_PAGE_SLOT,
    ] {
        assert!(slots.contains(&slot), "missing {slot}: {slots:?}");
    }
}

#[tokio::test]
async fn the_sample_worker_activates_with_only_declared_handlers() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let package = bundled();
    let worker = WorkerHost::spawn(&node, &package, 1, &[], Arc::new(DenyCapabilityBroker))
        .await
        .expect("Host surface Worker activates");
    assert_eq!(
        worker.activation().handlers,
        vec!["surface.createSession".to_owned()]
    );
    let result = worker
        .invoke("surface.createSession", json!({}))
        .await
        .expect("declared session handler");
    assert_eq!(result["ready"], true);
    worker.dispose("test complete").await.unwrap();
}
