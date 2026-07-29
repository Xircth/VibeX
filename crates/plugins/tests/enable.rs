use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use plugins::{
    Architecture, DependencyState, EnableOperationKind, ManagedTool, ManifestSource,
    OperatingSystem, Platform, PluginActivation, PluginReadiness, PluginRuntimeError,
    PluginService, ProviderState, SkillState, ToolRuntimePort,
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
}

fn platform() -> Platform {
    Platform::new(OperatingSystem::MacOs, Architecture::Arm64)
}

#[tokio::test]
async fn enabling_builtin_resolves_dependencies() {
    let manifest = include_str!("fixtures/office-presentation.vibex-plugin.json");
    let service = PluginService::with_runtime(
        platform(),
        Arc::new(FakeToolRuntime {
            result: Ok(ManagedTool {
                version: "0.8.0".to_string(),
                executable_path: PathBuf::from("/managed-tools/officecli/versions/0.8.0/officecli"),
            }),
        }),
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

    let failed_service = PluginService::with_runtime(
        platform(),
        Arc::new(FakeToolRuntime {
            result: Err(PluginRuntimeError::new(
                "tool_digest_mismatch",
                "OfficeCLI hash mismatch",
            )),
        }),
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
