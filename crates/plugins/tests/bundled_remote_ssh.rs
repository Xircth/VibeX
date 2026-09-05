//! Remote SSH is the first official consumer of `provider.remote.provisioner`
//! and the `remote.*` host.call family. Parsing must stay clean so the Host
//! never needs a plugin-id branch.

use plugins::{ContributionKind, PackageFormat, PluginPackage, PluginSourceKind};

fn bundled() -> PluginPackage {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/remote-ssh");
    PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("Remote SSH package")
}

#[test]
fn the_package_declares_a_detail_panel_and_an_ssh_provisioner() {
    let package = bundled();
    assert_eq!(package.id.as_str(), "vibex.remote-ssh");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert!(
        package.warnings.is_empty(),
        "the package must parse cleanly: {:?}",
        package.warnings
    );
    assert_eq!(package.app.remote_provisioners.len(), 1);
    assert_eq!(package.app.remote_provisioners[0].provision_kind, "ssh");
    assert_eq!(
        package.app.remote_provisioners[0].handler,
        "provision.ensure"
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
}

#[test]
fn the_contract_lists_the_provisioner_kind() {
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
    assert!(
        published.contains(&"provider.remote.provisioner"),
        "missing provider.remote.provisioner in {published:?}"
    );
}

#[test]
fn contribution_kind_key_is_stable() {
    assert_eq!(
        ContributionKind::RemoteProvisioner.key(),
        "remote_provisioner"
    );
}
