//! Batch 2 structure surfaces parse from the authored integrations array.

use std::fs;

use plugins::{
    APP_PANEL_SLOT, APP_TAB_SLOT, KANBAN_VIEW_SLOT, PluginPackage, PluginSourceKind,
    SETTINGS_PAGE_SLOT,
};

fn write(path: &std::path::Path, contents: &str) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    fs::write(path, contents).expect("write fixture");
}

fn product_package(integrations: &str) -> PluginPackage {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        &format!(
            r#"{{
              "manifestVersion":4,"apiVersion":"1.0",
              "id":"dev.vibex.surface","publisher":"dev.vibex","name":"Surface","version":"1.0.0",
              "readme":"README.md",
              "content":{{"root":"contents","index":".vibex-plugin/content.index.json"}},
              "config":{{"schema":{{"type":"object","additionalProperties":false}}}},
              "engines":{{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"}},
              "entrypoints":{{
                "worker":{{"path":"dist/worker.mjs","runtime":"node","protocol":"1.1"}},
                "app":{{"root":"dist/app","document":"index.html","protocol":"1.0"}}
              }},
              "integrations":{integrations}
            }}"#
        ),
    );
    write(
        &root.path().join("README.md"),
        "---\nsummary: Host surface fixture.\n---\n# Surface\n",
    );
    write(&root.path().join("config.json"), "{}");
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[]}"#,
    );
    write(&root.path().join("dist/worker.mjs"), "export default {};");
    write(
        &root.path().join("dist/app/index.html"),
        "<!doctype html><main>surface</main>",
    );
    PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).expect("product package")
}

const EVERY_STRUCTURE_KIND: &str = r#"[
  {"id":"notes","kind":"app.panel","title":"Notes","icon":"bookmark","handler":"surface.createSession","defaultPosition":"left","hidesBottomDock":false,"remote":{"name":"notes","entry":"dist/remoteEntry.js","module":"./view"}},
  {"id":"inbox","kind":"app.tab","title":"Inbox","icon":"bell","handler":"surface.createSession"},
  {"id":"heatmap","kind":"app.kanban.view","title":"Heatmap","icon":"gauge","handler":"surface.createSession","hidesBottomDock":true},
  {"id":"tuning","kind":"app.settings.page","title":"Tuning","icon":"settings","handler":"surface.createSession"},
  {"id":"polish","kind":"app.composer.action","title":"Polish draft","icon":"sparkles","prompt":"Tighten this draft."}
]"#;

#[test]
fn every_structure_kind_survives_product_manifest_normalization() {
    let package = product_package(EVERY_STRUCTURE_KIND);
    assert!(
        package.warnings.is_empty(),
        "valid structure contributions must not warn: {:?}",
        package.warnings
    );

    let panel = package.app.panels.first().expect("panel");
    assert_eq!(panel.id, "notes");
    assert_eq!(panel.default_position, "left");
    assert_eq!(
        panel.remote.as_ref().map(|remote| remote.name.as_str()),
        Some("notes")
    );

    assert_eq!(package.app.tabs[0].title, "Inbox");
    assert!(package.app.tabs[0].hides_bottom_dock);
    assert_eq!(package.app.kanban_views[0].title, "Heatmap");
    assert_eq!(package.app.settings_pages[0].title, "Tuning");
    assert_eq!(
        package.app.composer_actions[0].prompt.as_deref(),
        Some("Tighten this draft.")
    );
}

#[test]
fn structure_kinds_synthesize_addressable_surfaces() {
    let package = product_package(EVERY_STRUCTURE_KIND);
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

#[test]
fn the_contract_lists_every_structure_kind() {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/plugin-contract/catalog/contribution-kinds.v1.json"
    ))
    .expect("kinds catalog");
    let published: Vec<&str> = catalog["kinds"]
        .as_array()
        .expect("kinds")
        .iter()
        .filter_map(|kind| kind["id"].as_str())
        .collect();
    for kind in [
        "app.panel",
        "app.tab",
        "app.kanban.view",
        "app.settings.page",
        "app.composer.action",
    ] {
        assert!(published.contains(&kind), "missing {kind} in {published:?}");
    }
    let settings_page = catalog["kinds"]
        .as_array()
        .expect("kinds")
        .iter()
        .find(|kind| kind["id"] == "app.settings.page")
        .expect("settings.page");
    assert_eq!(settings_page["status"], "preview");
}

#[test]
fn a_panel_with_a_bad_position_is_dropped() {
    let package = product_package(
        r#"[
          {"id":"ok","kind":"app.composer.action","title":"Ok","prompt":"Stay."},
          {"id":"bad","kind":"app.panel","title":"Bad","handler":"surface.createSession","defaultPosition":"right"}
        ]"#,
    );
    assert!(package.app.panels.is_empty());
    assert!(
        package
            .warnings
            .iter()
            .any(|warning| warning.code == "app_panel_invalid"),
        "{:?}",
        package.warnings
    );
}

#[test]
fn a_composer_action_needs_a_handler_or_prompt() {
    let package = product_package(
        r#"[
          {"id":"ok","kind":"app.tab","title":"Inbox","icon":"bell","handler":"surface.createSession"},
          {"id":"empty","kind":"app.composer.action","title":"Empty"}
        ]"#,
    );
    assert!(package.app.composer_actions.is_empty());
    assert!(
        package
            .warnings
            .iter()
            .any(|warning| warning.code == "app_composer_action_invalid"),
        "{:?}",
        package.warnings
    );
}

#[test]
fn unknown_icons_are_dropped_rather_than_rendered() {
    let package = product_package(
        r#"[
          {"id":"ok","kind":"app.composer.action","title":"Ok","prompt":"Stay."},
          {"id":"inbox","kind":"app.tab","title":"Inbox","icon":"not-a-real-icon","handler":"surface.createSession"}
        ]"#,
    );
    assert!(package.app.tabs.is_empty());
}
