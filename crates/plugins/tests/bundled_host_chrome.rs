//! ADR-0069 requires every contribution point to ship with an official
//! consumer. `vibex.host-chrome` is that consumer for the six chrome slots and
//! `host.service`; if one of them stops parsing, this fails before a user ever
//! sees an empty toolbar.

use plugins::{
    CONTRIBUTION_ICONS, PackageFormat, PluginPackage, PluginSourceKind, SETTINGS_SECTION_SLOT,
    TIMELINE_CARD_SLOT,
};

fn bundled() -> PluginPackage {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/host-chrome");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("Host chrome package")
}

#[test]
fn the_reference_plugin_fills_every_chrome_slot() {
    let package = bundled();

    assert_eq!(package.id.as_str(), "vibex.host-chrome");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert!(
        package.warnings.is_empty(),
        "the reference plugin must parse cleanly: {:?}",
        package.warnings
    );

    let app = &package.app;
    assert_eq!(app.commands.len(), 1, "app.command");
    assert_eq!(app.toolbar_items.len(), 1, "app.toolbar");
    assert_eq!(app.status_items.len(), 1, "app.status");
    assert_eq!(app.composer_slash.len(), 1, "app.composer.slash");
    assert_eq!(app.timeline_cards.len(), 1, "app.timeline.card");
    assert_eq!(app.settings_sections.len(), 1, "app.settings.section");
    assert_eq!(app.host_services.len(), 1, "host.service");
}

#[test]
fn its_cards_and_sections_are_addressable_surfaces() {
    let package = bundled();
    let slots: Vec<&str> = package
        .app
        .surfaces
        .iter()
        .map(|surface| surface.slot.as_str())
        .collect();

    assert!(
        slots.contains(&TIMELINE_CARD_SLOT),
        "timeline card must synthesize a surface: {slots:?}"
    );
    assert!(
        slots.contains(&SETTINGS_SECTION_SLOT),
        "settings section must synthesize a surface: {slots:?}"
    );
}

#[test]
fn it_names_icons_from_the_shared_catalog_rather_than_shipping_markup() {
    let package = bundled();
    let icons = package
        .app
        .commands
        .iter()
        .filter_map(|item| item.icon.as_deref())
        .chain(
            package
                .app
                .toolbar_items
                .iter()
                .filter_map(|item| item.icon.as_deref()),
        )
        .chain(
            package
                .app
                .status_items
                .iter()
                .filter_map(|item| item.icon.as_deref()),
        );
    for icon in icons {
        assert!(
            CONTRIBUTION_ICONS.contains(&icon),
            "`{icon}` is not in the published icon catalog"
        );
    }
}

#[test]
fn its_status_item_refreshes_so_the_polling_path_has_a_consumer() {
    let package = bundled();
    assert_eq!(
        package.app.status_items[0].refresh_seconds,
        Some(30),
        "the status bar refresh loop needs an official consumer too"
    );
}

#[test]
fn it_asks_for_no_privileged_capability() {
    let package = bundled();
    assert!(
        package.permissions.is_empty(),
        "the reference plugin must be reproducible by any author: {:?}",
        package.permissions
    );
}
