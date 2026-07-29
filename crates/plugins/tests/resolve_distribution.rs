use plugins::{
    Architecture, ManifestSource, OperatingSystem, Platform, PluginService, ToolDependencyResolver,
};

#[test]
fn resolves_exact_tool_distribution() {
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json");
    let imported = PluginService::new()
        .import_manifest(manifest, ManifestSource::Bundled)
        .expect("fixture should import");
    let dependency = &imported.dependencies[0];

    let resolver =
        ToolDependencyResolver::new(Platform::new(OperatingSystem::MacOs, Architecture::Arm64));
    let resolved = resolver
        .resolve(dependency)
        .expect("macOS arm64 has an exact distribution");

    assert_eq!(resolved.target, "aarch64-apple-darwin");
    assert_eq!(resolved.version, "0.8.0");
    assert_eq!(
        resolved.sha256,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );

    let unsupported =
        ToolDependencyResolver::new(Platform::new(OperatingSystem::Windows, Architecture::Arm64))
            .resolve(dependency)
            .expect_err("an undeclared platform must fail closed");
    assert_eq!(unsupported.code(), "tool_platform_unsupported");

    let latest_manifest = manifest.replace("\"0.8.0\"", "\"latest\"");
    let latest = PluginService::new()
        .import_manifest(&latest_manifest, ManifestSource::Bundled)
        .expect("version policy belongs to deterministic resolution");
    let error = resolver
        .resolve(&latest.dependencies[0])
        .expect_err("floating versions are not deterministic");
    assert_eq!(error.code(), "tool_version_not_exact");
}
