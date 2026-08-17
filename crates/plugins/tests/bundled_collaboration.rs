use std::sync::Arc;

use plugins::{
    COLLABORATION_PLUGIN_ID, ConflictDecision, InMemoryPluginRegistry, PluginActivation,
    PluginControlPlane, PluginPackage, PluginSourceKind,
};

#[test]
fn bundled_collaboration_plugin_is_the_official_mcp_gate() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/collaboration");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();

    assert_eq!(package.id.as_str(), COLLABORATION_PLUGIN_ID);
    assert_eq!(package.publisher.as_deref(), Some("vibex"));
    assert_eq!(
        package.summary,
        "让父 Agent 通过 vibex-mcp 把工作委派给其它 Agent。"
    );
    assert!(package.entrypoints.worker.is_none());
    assert_eq!(package.skills.len(), 1);
    assert_eq!(package.skills[0].id, "vibex-collaboration");
}

#[tokio::test]
async fn enabling_collaboration_opens_the_official_mcp_gate() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/collaboration");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    control
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    control.sync_official_product_mcp_gate().await.unwrap();
    assert!(!control.official_product_mcp_gate().allow_vibex_mcp());

    control
        .set_enabled(COLLABORATION_PLUGIN_ID, true)
        .await
        .unwrap();
    assert!(control.official_product_mcp_gate().allow_vibex_mcp());

    control
        .set_enabled(COLLABORATION_PLUGIN_ID, false)
        .await
        .unwrap();
    assert!(!control.official_product_mcp_gate().allow_vibex_mcp());
    assert_eq!(
        control
            .plugin(COLLABORATION_PLUGIN_ID)
            .await
            .unwrap()
            .unwrap()
            .activation,
        PluginActivation::Disabled
    );
}
