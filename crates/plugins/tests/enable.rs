use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use plugins::{
    Architecture, DependencyState, EnableOperationKind, ManagedTool, ManifestSource,
    OperatingSystem, Platform, PluginActivation, PluginReadiness, PluginRuntimeError,
    PluginService, ProviderState, SkillAvailabilityPort, SkillState, ToolRuntimePort,
};

struct FakeToolRuntime {
    result: Result<ManagedTool, PluginRuntimeError>,
}

#[async_trait]
impl ToolRuntimePort for FakeToolRuntime {
    async fn ensure(
        &self,
        _tool: &plugins::ResolvedToolDistribution,
    ) -> Result<ManagedTool, PluginRuntimeError> {
        self.result.clone()
    }

    async fn check_provider(
        &self,
        _provider_id: &str,
        _tool: &ManagedTool,
    ) -> Result<(), PluginRuntimeError> {
        Ok(())
    }
}

struct ToolOnlyRuntime;
struct AvailableSkills;

#[async_trait]
impl SkillAvailabilityPort for AvailableSkills {
    async fn check_skill(
        &self,
        _skill: &plugins::SkillDeclaration,
    ) -> Result<(), PluginRuntimeError> {
        Ok(())
    }
}

#[async_trait]
impl ToolRuntimePort for ToolOnlyRuntime {
    async fn ensure(
        &self,
        _tool: &plugins::ResolvedToolDistribution,
    ) -> Result<ManagedTool, PluginRuntimeError> {
        Ok(ManagedTool {
            version: "0.8.0".to_string(),
            executable_path: PathBuf::from("/managed-tools/officecli/versions/0.8.0/officecli"),
        })
    }
}

fn platform() -> Platform {
    Platform::new(OperatingSystem::MacOs, Architecture::Arm64)
}

#[tokio::test]
async fn enabling_builtin_resolves_dependencies() {
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json");
    let service = PluginService::with_runtime_and_capabilities(
        platform(),
        Arc::new(FakeToolRuntime {
            result: Ok(ManagedTool {
                version: "0.8.0".to_string(),
                executable_path: PathBuf::from("/managed-tools/officecli/versions/0.8.0/officecli"),
            }),
        }),
        Arc::new(AvailableSkills),
        ["officecli"],
    );
    service
        .import_manifest(manifest, ManifestSource::Bundled)
        .expect("import Office plugin");

    let enabled = service
        .enable("vibex.office.presentation")
        .await
        .expect("enable Office plugin");

    assert_eq!(enabled.operation.kind, EnableOperationKind::Installing);
    assert_eq!(enabled.plugin.activation, PluginActivation::Enabled);
    assert!(matches!(
        enabled.plugin.dependencies["officecli"],
        DependencyState::Ready { .. }
    ));
    assert_eq!(enabled.plugin.skills["office-pptx"], SkillState::Ready);
    assert_eq!(enabled.plugin.providers["officecli"], ProviderState::Ready);
    assert_eq!(enabled.plugin.readiness, PluginReadiness::Ready);

    let failed_service = PluginService::with_runtime_and_capabilities(
        platform(),
        Arc::new(FakeToolRuntime {
            result: Err(PluginRuntimeError::new(
                "tool_digest_mismatch",
                "OfficeCLI hash mismatch",
            )),
        }),
        Arc::new(AvailableSkills),
        ["officecli"],
    );
    failed_service
        .import_manifest(manifest, ManifestSource::Bundled)
        .expect("import Office plugin");
    let failed = failed_service
        .enable("vibex.office.presentation")
        .await
        .expect("enable records dependency failure");

    assert_eq!(failed.plugin.activation, PluginActivation::Enabled);
    assert!(matches!(
        failed.plugin.dependencies["officecli"],
        DependencyState::Failed { ref code, .. } if code == "tool_digest_mismatch"
    ));
    assert_eq!(
        failed.plugin.providers["officecli"],
        ProviderState::Unavailable
    );
    assert!(matches!(
        failed.plugin.readiness,
        PluginReadiness::NotReady { .. }
    ));
}

#[tokio::test]
async fn installed_tool_does_not_imply_provider_health() {
    let service = PluginService::with_runtime(platform(), Arc::new(ToolOnlyRuntime));
    service
        .import_manifest(
            include_str!("fixtures/office-presentation.vibex-plugin.json"),
            ManifestSource::Bundled,
        )
        .expect("import Office plugin");

    let enabled = service
        .enable("vibex.office.presentation")
        .await
        .expect("enable Office plugin");

    assert!(matches!(
        enabled.plugin.dependencies["officecli"],
        DependencyState::Ready { .. }
    ));
    assert_eq!(
        enabled.plugin.providers["officecli"],
        ProviderState::Unavailable
    );
    assert!(matches!(
        enabled.plugin.readiness,
        PluginReadiness::NotReady { .. }
    ));
}

#[tokio::test]
async fn declared_bundled_skill_does_not_imply_availability() {
    let service = PluginService::with_runtime(platform(), Arc::new(ToolOnlyRuntime));
    service
        .import_manifest(
            include_str!("fixtures/office-presentation.vibex-plugin.json"),
            ManifestSource::Bundled,
        )
        .expect("import Office plugin");

    let enabled = service
        .enable("vibex.office.presentation")
        .await
        .expect("enable Office plugin");

    assert_eq!(enabled.plugin.skills["office-pptx"], SkillState::Missing);
}
