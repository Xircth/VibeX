//! Official consumer of `provider.model.catalog`. Without it the contribution
//! point would ship with nothing exercising it, which ADR-0069 forbids.

use plugins::{ContributionKind, PackageFormat, PluginPackage, PluginSourceKind};

fn bundled() -> PluginPackage {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/plugins/provider-switch");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("ProviderSwitch package")
}

#[test]
fn it_contributes_static_catalogs_without_a_worker() {
    let package = bundled();

    assert_eq!(package.id.as_str(), "vibex.provider-switch");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert!(
        package.warnings.is_empty(),
        "the official catalog must parse cleanly: {:?}",
        package.warnings
    );
    assert!(package.entrypoints.worker.is_none());
    assert!(!package.app.provider_catalogs.is_empty());
    assert!(
        package
            .app
            .provider_catalogs
            .iter()
            .all(|catalog| !catalog.templates.is_empty()),
        "each catalog file must publish templates: {:?}",
        package
            .app
            .provider_catalogs
            .iter()
            .map(|catalog| (catalog.id.as_str(), catalog.templates.len()))
            .collect::<Vec<_>>()
    );
}

#[test]
fn it_never_embeds_secrets() {
    let package = bundled();
    let encoded = serde_json::to_string(&package.app.provider_catalogs).expect("catalogs");
    for needle in ["apiKey", "api_key", "sk-", "Authorization"] {
        assert!(!encoded.contains(needle), "catalog leaked {needle}");
    }
}

#[test]
fn the_host_embed_keeps_catalog_files() {
    let data = tempfile::tempdir().expect("data");
    let roots = utils::assets::materialize_builtin_plugins(data.path()).expect("materialize");
    let root = roots
        .iter()
        .find(|root| {
            PluginPackage::inspect(root, PluginSourceKind::Builtin)
                .ok()
                .is_some_and(|package| package.id.as_str() == "vibex.provider-switch")
        })
        .expect("ProviderSwitch is bundled");
    let package =
        PluginPackage::inspect(root, PluginSourceKind::Builtin).expect("materialized package");
    assert!(
        package.warnings.is_empty(),
        "materialized catalogs must parse: {:?}",
        package.warnings
    );
    assert!(!package.app.provider_catalogs.is_empty());
}

#[test]
fn contribution_kind_key_is_stable() {
    assert_eq!(
        ContributionKind::ProviderCatalog.key(),
        "provider_model_catalog"
    );
}

#[test]
fn the_contract_lists_the_catalog_kind() {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/plugin-contract/catalog/contribution-kinds.v1.json"
    ))
    .expect("kinds catalog");
    let published = catalog["kinds"]
        .as_array()
        .expect("kinds")
        .iter()
        .find(|kind| kind["id"].as_str() == Some("provider.model.catalog"))
        .expect("provider.model.catalog");
    assert_eq!(published["status"].as_str(), Some("ready"));
    assert_eq!(published["handler"].as_bool(), Some(false));
}
