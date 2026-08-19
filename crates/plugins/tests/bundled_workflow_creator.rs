use plugins::{FileOpenerTarget, PackageFormat, PluginPackage, PluginSourceKind};

#[test]
fn bundled_workflow_creator_uses_only_public_full_stack_extensions() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/plugins/workflow-creator");
    let package =
        PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("Workflow Creator package");

    assert_eq!(package.id.as_str(), "vibex.workflow-creator");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert_eq!(package.skills.len(), 1);
    assert_eq!(package.app.file_openers.len(), 1);
    assert_eq!(
        package.app.file_openers[0].file_name_suffixes,
        [".vibex-workflow.json"]
    );
    assert_eq!(
        package.app.file_openers[0].target,
        FileOpenerTarget::AppSurface
    );
    assert_eq!(
        package.app.surfaces[0].native_renderer.as_deref(),
        Some("workflow.studio")
    );
    assert_eq!(
        package.entrypoints.worker.as_deref(),
        Some("dist/worker.mjs")
    );
    assert!(package.mcp.get("vibex-workflow-mcp").is_some());
}
