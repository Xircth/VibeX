//! The six Host chrome slots plus `host.service` are v4-native: they have no
//! legacy `contributes` shape, so they are parsed straight from the authored
//! `integrations` array. These tests pin that path end to end (ADR-0069).

use std::fs;

use plugins::{
    CONTRIBUTION_ICONS, PluginPackage, PluginSourceKind, SETTINGS_SECTION_SLOT, TIMELINE_CARD_SLOT,
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
              "id":"dev.vibex.chrome","publisher":"dev.vibex","name":"Chrome","version":"1.0.0",
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
        "---\nsummary: Host chrome fixture.\n---\n# Chrome\n",
    );
    write(&root.path().join("config.json"), "{}");
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[]}"#,
    );
    write(&root.path().join("dist/worker.mjs"), "export default {};");
    write(
        &root.path().join("dist/app/index.html"),
        "<!doctype html><main>chrome</main>",
    );
    PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot).expect("product package")
}

const EVERY_CHROME_KIND: &str = r#"[
  {"id":"open-report","kind":"app.command","title":"Open report","subtitle":"Chrome","shortcut":"mod+shift+r","icon":"chart-bar","handler":"openReport"},
  {"id":"toggle-watch","kind":"app.toolbar","slot":"toolbar.main","title":"Toggle watch","icon":"activity","handler":"toggleWatch"},
  {"id":"watch-state","kind":"app.status","slot":"status.main","text":"Idle","icon":"gauge","handler":"watchState","refreshSeconds":15},
  {"id":"summarize","kind":"app.composer.slash","command":"summarize","title":"Summarize thread","description":"Ask for a recap","prompt":"Summarize the conversation so far."},
  {"id":"run-brief","kind":"app.timeline.card","label":"Run brief","handler":"surface.createSession","allowedMethods":["brief.refresh"],"minHeight":260},
  {"id":"chrome-prefs","kind":"app.settings.section","title":"Chrome preferences","handler":"surface.createSession"},
  {"id":"poll-runs","kind":"host.service","handler":"pollRuns","intervalSeconds":60}
]"#;

#[test]
fn every_host_chrome_kind_survives_product_manifest_normalization() {
    let package = product_package(EVERY_CHROME_KIND);
    let app = &package.app;

    assert!(
        package.warnings.is_empty(),
        "valid chrome contributions must not warn: {:?}",
        package.warnings
    );

    let command = app.commands.first().expect("command contribution");
    assert_eq!(command.id, "open-report");
    assert_eq!(command.title, "Open report");
    assert_eq!(command.subtitle.as_deref(), Some("Chrome"));
    assert_eq!(command.shortcut.as_deref(), Some("mod+shift+r"));
    assert_eq!(command.icon.as_deref(), Some("chart-bar"));
    assert_eq!(command.handler, "openReport");

    let toolbar = app.toolbar_items.first().expect("toolbar contribution");
    assert_eq!(toolbar.title, "Toggle watch");
    assert_eq!(toolbar.icon.as_deref(), Some("activity"));

    let status = app.status_items.first().expect("status contribution");
    assert_eq!(status.text.as_deref(), Some("Idle"));
    assert_eq!(status.refresh_seconds, Some(15));

    let slash = app.composer_slash.first().expect("slash contribution");
    assert_eq!(slash.command, "summarize");
    assert_eq!(slash.prompt, "Summarize the conversation so far.");
    assert_eq!(slash.description.as_deref(), Some("Ask for a recap"));

    let card = app.timeline_cards.first().expect("timeline card");
    assert_eq!(card.label, "Run brief");
    assert_eq!(card.allowed_methods, vec!["brief.refresh".to_owned()]);
    assert_eq!(card.min_height, Some(260));

    let section = app.settings_sections.first().expect("settings section");
    assert_eq!(section.title, "Chrome preferences");

    let service = app.host_services.first().expect("host service");
    assert_eq!(service.handler, "pollRuns");
    assert_eq!(service.interval_seconds, 60);
}

#[test]
fn cards_and_sections_become_addressable_app_surfaces() {
    let package = product_package(EVERY_CHROME_KIND);

    let card_surface = package
        .app
        .surfaces
        .iter()
        .find(|surface| surface.slot == TIMELINE_CARD_SLOT)
        .expect("timeline card surface");
    assert_eq!(card_surface.id, "run-brief");
    assert_eq!(card_surface.app_entrypoint, "app");
    assert_eq!(card_surface.handler, "surface.createSession");
    assert_eq!(card_surface.min_height, Some(260));

    let section_surface = package
        .app
        .surfaces
        .iter()
        .find(|surface| surface.slot == SETTINGS_SECTION_SLOT)
        .expect("settings section surface");
    assert_eq!(section_surface.id, "chrome-prefs");
    assert_eq!(section_surface.label, "Chrome preferences");
}

#[test]
fn authors_still_cannot_declare_the_synthesized_slots_directly() {
    let root = tempfile::tempdir().expect("package root");
    write(
        &root.path().join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"dev.vibex.chrome","publisher":"dev.vibex","name":"Chrome","version":"1.0.0",
          "readme":"README.md",
          "content":{"root":"contents","index":".vibex-plugin/content.index.json"},
          "config":{"schema":{"type":"object","additionalProperties":false}},
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "integrations":[{"id":"sneaky","kind":"app.surface","slot":"conversation.timeline.card","appEntrypoint":"app","handler":"surface.createSession"}]
        }"#,
    );
    write(
        &root.path().join("README.md"),
        "---\nsummary: x\n---\n# x\n",
    );
    write(&root.path().join("config.json"), "{}");
    write(
        &root.path().join(".vibex-plugin/content.index.json"),
        r#"{"schemaVersion":1,"items":[]}"#,
    );

    let error = PluginPackage::inspect(root.path(), PluginSourceKind::Snapshot)
        .expect_err("timeline card slot is not an authorable App surface");
    assert!(
        format!("{error:?}").contains("app_surface_slot_unsupported"),
        "unexpected error: {error:?}"
    );
}

#[test]
fn malformed_chrome_contributions_warn_instead_of_publishing() {
    let package = product_package(
        r#"[
          {"id":"keeper","kind":"app.composer.slash","command":"keeper","title":"Keeper","prompt":"Keep going."},
          {"id":"bad-icon","kind":"app.command","title":"Bad icon","icon":"not-a-real-icon","handler":"run"},
          {"id":"bad-slot","kind":"app.toolbar","slot":"toolbar.secondary","title":"Bad slot","handler":"run"},
          {"id":"bad-refresh","kind":"app.status","slot":"status.main","handler":"run","refreshSeconds":1},
          {"id":"bad-slash","kind":"app.composer.slash","command":"Summarize It","title":"Bad","prompt":"x"},
          {"id":"bad-card","kind":"app.timeline.card","handler":"notTheSurfaceEntry"},
          {"id":"bad-service","kind":"host.service","handler":"tick","intervalSeconds":1}
        ]"#,
    );

    assert!(package.app.commands.is_empty());
    assert!(package.app.toolbar_items.is_empty());
    assert!(package.app.status_items.is_empty());
    assert!(package.app.timeline_cards.is_empty());
    assert!(package.app.host_services.is_empty());
    assert_eq!(
        package
            .app
            .composer_slash
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["keeper"],
        "one bad sibling must not drop the valid contribution"
    );

    let codes = package
        .warnings
        .iter()
        .map(|warning| warning.code.as_str())
        .collect::<Vec<_>>();
    for expected in [
        "app_command_invalid",
        "app_toolbar_invalid",
        "app_status_invalid",
        "app_composer_slash_invalid",
        "app_timeline_card_invalid",
        "host_service_invalid",
    ] {
        assert!(codes.contains(&expected), "missing {expected} in {codes:?}");
    }
}

#[test]
fn slash_command_defaults_to_the_contribution_id() {
    let package = product_package(
        r#"[{"id":"recap","kind":"app.composer.slash","title":"Recap","prompt":"Recap this."}]"#,
    );
    assert_eq!(package.app.composer_slash[0].command, "recap");
}

#[test]
fn a_declared_hook_warns_because_no_host_runs_hooks() {
    let package = product_package(
        r#"[
  {"id":"start","kind":"content.hook","path":"contents/hooks/start.json"},
  {"id":"keeper","kind":"app.command","title":"Keeper","handler":"keep"}
]"#,
    );

    assert!(
        package
            .warnings
            .iter()
            .any(|warning| warning.code == "hook_contribution_unsupported"),
        "a hook that can never fire must say so: {:?}",
        package.warnings
    );
    assert_eq!(
        package.app.commands.len(),
        1,
        "a valid sibling contribution still publishes"
    );
}

#[test]
fn provider_import_sources_survive_normalization() {
    // Naming no agents is how the second source says "any agent".
    let package = product_package(
        r#"[
  {"id":"cc-switch","kind":"provider.model.importSource","label":"CC Switch","handler":"import.ccSwitch","icon":"plug","agents":["claude","codex"],"description":"Reads a CC Switch config"},
  {"id":"any-agent","kind":"provider.model.importSource","label":"Anywhere","handler":"import.anywhere"}
]"#,
    );

    let sources = &package.app.provider_import_sources;
    assert_eq!(sources.len(), 2, "{:?}", package.warnings);
    assert_eq!(sources[0].label, "CC Switch");
    assert_eq!(sources[0].agents, vec!["claude", "codex"]);
    assert_eq!(sources[0].icon.as_deref(), Some("plug"));
    assert!(
        sources[1].agents.is_empty(),
        "an omitted agent list must stay empty rather than defaulting to something"
    );
}

#[test]
fn a_provider_import_source_without_a_handler_warns_instead_of_publishing() {
    // A valid sibling keeps the package installable, so the assertion is about
    // the two bad entries rather than about the package being rejected wholesale.
    let package = product_package(
        r#"[
  {"id":"poll-runs","kind":"host.service","handler":"pollRuns","intervalSeconds":60},
  {"id":"broken","kind":"provider.model.importSource","label":"No handler"},
  {"id":"bad-agents","kind":"provider.model.importSource","label":"Bad agents","handler":"import.x","agents":"claude"}
]"#,
    );

    assert!(
        package.app.provider_import_sources.is_empty(),
        "malformed sources must not reach the catalog"
    );
    assert_eq!(package.warnings.len(), 2, "{:?}", package.warnings);
}

#[test]
fn the_icon_set_matches_the_published_contract() {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/plugin-contract/catalog/icons.v1.json"
    ))
    .expect("icon catalog");
    let published = catalog["icons"]
        .as_array()
        .expect("icons array")
        .iter()
        .map(|icon| icon.as_str().expect("icon name"))
        .collect::<Vec<_>>();
    assert_eq!(
        published, CONTRIBUTION_ICONS,
        "Rust icon set drifted from @vibex/plugin-contract/catalog/icons"
    );
}

#[test]
fn host_service_interval_defaults_when_unset() {
    let package = product_package(r#"[{"id":"tick","kind":"host.service","handler":"tick"}]"#);
    assert_eq!(package.app.host_services[0].interval_seconds, 30);
}
