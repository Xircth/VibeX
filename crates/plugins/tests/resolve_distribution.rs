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

#[test]
fn malicious_distribution_urls_fail_closed() {
    let source = include_str!("fixtures/office-presentation.vibex-plugin.json");
    let resolver =
        ToolDependencyResolver::new(Platform::new(OperatingSystem::MacOs, Architecture::Arm64));

    for malicious in [
        "file:///etc/passwd",
        "http://169.254.169.254/latest/meta-data/",
        "https://user:password@downloads.example.invalid/officecli",
        "https://localhost./officecli",
        "https://metadata.internal/latest",
        "https://downloads.vibex.dev/officecli?token=release-secret",
        "https://downloads.vibex.dev/officecli#release-secret",
    ] {
        let manifest = source.replace(
            "https://downloads.vibex.dev/officecli/0.8.0/aarch64-apple-darwin/officecli",
            malicious,
        );
        let imported = PluginService::new()
            .import_manifest(&manifest, ManifestSource::External)
            .expect("URL policy is enforced at deterministic resolution");
        let error = resolver
            .resolve(&imported.dependencies[0])
            .expect_err("malicious distribution URL must fail closed");
        assert_eq!(error.code(), "tool_distribution_invalid");
    }
}
