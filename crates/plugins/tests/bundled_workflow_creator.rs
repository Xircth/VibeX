use plugins::{PluginPackage, PluginSourceKind, WORKFLOW_CREATOR_PLUGIN_ID};

#[test]
fn bundled_workflow_creator_is_the_official_workflow_mcp_gate() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/plugins/workflow-creator");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();
    assert_eq!(package.id.as_str(), WORKFLOW_CREATOR_PLUGIN_ID);
    assert_eq!(package.publisher.as_deref(), Some("vibex"));
    assert!(package.entrypoints.worker.is_none());
}
