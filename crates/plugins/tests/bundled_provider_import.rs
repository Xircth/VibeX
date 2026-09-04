//! Official consumer of `provider.model.importSource`. Without it the
//! contribution point would ship with nothing exercising it, which ADR-0069
//! forbids.

use plugins::{CONTRIBUTION_ICONS, PackageFormat, PluginPackage, PluginSourceKind};

fn bundled() -> PluginPackage {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/plugins/provider-import");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("Provider import package")
}

#[test]
fn it_contributes_exactly_one_import_source() {
    let package = bundled();

    assert_eq!(package.id.as_str(), "vibex.provider-import");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert!(
        package.warnings.is_empty(),
        "the official import source must parse cleanly: {:?}",
        package.warnings
    );

    let sources = &package.app.provider_import_sources;
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].id, "environment");
    assert_eq!(sources[0].handler, "import.environment");
    assert!(
        sources[0]
            .icon
            .as_deref()
            .is_some_and(|icon| CONTRIBUTION_ICONS.contains(&icon)),
        "icon must come from the published catalog"
    );
}

#[test]
fn it_offers_the_source_to_every_agent() {
    let package = bundled();
    assert!(
        package.app.provider_import_sources[0].agents.is_empty(),
        "an empty agent filter means the source is offered everywhere; \
         narrowing it would hide the only official consumer from most users"
    );
}

#[test]
fn it_needs_a_worker_but_no_privileged_capability() {
    let package = bundled();
    assert_eq!(
        package.entrypoints.worker.as_deref(),
        Some("dist/worker.mjs")
    );
    assert!(
        package.permissions.is_empty(),
        "must be reproducible by any author: {:?}",
        package.permissions
    );
}
