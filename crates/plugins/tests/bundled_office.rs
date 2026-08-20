use std::sync::Arc;

use async_trait::async_trait;
use plugins::{
    ActivationManager, CapabilityBroker, ContributionKind, DenyCapabilityBroker, PackageFormat,
    PluginPackage, PluginSourceKind, WorkerHost, WorkerHostError,
};
use serde_json::{Value, json};

#[test]
fn bundled_office_manifest_covers_pptx_docx_and_xlsx_actions() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let manifest = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();

    assert_eq!(manifest.id.as_str(), "vibex.office");
    assert_eq!(manifest.publisher.as_deref(), Some("vibex"));
    assert_eq!(manifest.manifest_version, 4);
    assert_eq!(
        manifest.summary,
        "在 VibeX 中创建、编辑、分析和预览 DOCX、XLSX 与 PPTX 文件。"
    );
    assert_eq!(manifest.content_index.items.len(), 9);
    assert_eq!(manifest.config["idleTimeoutMinutes"], 10);
    assert_eq!(manifest.runtimes[0].id, "officecli");
    assert_eq!(manifest.invocations.len(), 12);
    assert_eq!(manifest.skills.len(), 3);
    assert_eq!(manifest.app.file_openers.len(), 1);
    assert_eq!(manifest.app.preview_providers.len(), 1);
    let embedded_skills = [
        (
            "office-pptx",
            include_str!("../../../assets/plugins/office/contents/skills/office-pptx/SKILL.md"),
        ),
        (
            "office-docx",
            include_str!("../../../assets/plugins/office/contents/skills/office-docx/SKILL.md"),
        ),
        (
            "office-xlsx",
            include_str!("../../../assets/plugins/office/contents/skills/office-xlsx/SKILL.md"),
        ),
    ];
    for skill in &manifest.skills {
        let source = embedded_skills
            .iter()
            .find_map(|(id, source)| (*id == skill.id).then_some(*source))
            .expect("every declared bundled skill is embedded");
        assert!(source.starts_with("---\n"));
    }
    let manifest_text = serde_json::to_string(&manifest.manifest).unwrap();
    for suffix in [
        "presentationml.presentation",
        "wordprocessingml.document",
        "spreadsheetml.sheet",
    ] {
        assert!(manifest_text.contains(suffix));
    }
    let _public_kind = ContributionKind::PreviewProvider;
}

#[test]
fn office_package_update_keeps_valid_config_and_drops_removed_fields() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();

    let adopted = package
        .adopt_installed_config(&json!({
            "previewMode": "live",
            "editable": true,
            "idleTimeoutMinutes": 7
        }))
        .expect("builtin rematerialize must adopt the previous Office config");
    assert_eq!(adopted, json!({ "idleTimeoutMinutes": 7 }));
    assert!(
        package
            .write_config(json!({ "previewMode": "live" }))
            .is_err(),
        "authoring still rejects fields the current schema does not declare"
    );
}

#[tokio::test]
async fn full_trust_worker_activation_does_not_require_a_permission_provider() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();
    let worker = WorkerHost::spawn(&node, &package, 1, &[], Arc::new(DenyCapabilityBroker))
        .await
        .expect("full-trust packages activate independently of optional Host APIs");
    worker.dispose("test complete").await.unwrap();
}

#[test]
fn bundled_office_is_a_full_stack_portable_package() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package =
        PluginPackage::inspect(&root, PluginSourceKind::Builtin).expect("portable Office package");

    assert_eq!(package.id.as_str(), "vibex.office");
    assert_eq!(package.formats, vec![PackageFormat::VibeX]);
    assert_eq!(package.skills.len(), 3);
    assert_eq!(package.runtimes[0].command, "officecli");
    assert_eq!(
        package.entrypoints.worker.as_deref(),
        Some("dist/worker.mjs")
    );
}

struct EchoBroker;

#[async_trait]
impl CapabilityBroker for EchoBroker {
    fn supports(&self, _capability: &str) -> bool {
        true
    }

    async fn call(
        &self,
        plugin_id: &str,
        generation: u64,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, WorkerHostError> {
        Ok(json!({
            "pluginId": plugin_id,
            "generation": generation,
            "capability": capability,
            "operation": operation,
            "input": input,
        }))
    }
}

#[tokio::test]
async fn bundled_office_worker_activates_through_the_public_protocol() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();
    let worker = WorkerHost::spawn(&node, &package, 7, &[], Arc::new(EchoBroker))
        .await
        .expect("Office Worker candidate activates");
    assert_eq!(worker.activation().generation, 7);
    let result = worker
        .invoke(
            "office-preview",
            json!({
                "artifactHandle": "host-issued-test-handle",
                "providerId": "office-preview"
            }),
        )
        .await
        .expect("declared preview handler invokes the Broker");
    assert_eq!(result["capability"], "artifact.preview");
    assert_eq!(result["operation"], "open");
    worker.dispose("test complete").await.unwrap();
}

#[tokio::test]
async fn office_action_resolves_skill_runtime_and_artifact_intent() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();
    let runtime = package.runtimes[0].clone();
    let control =
        plugins::PluginControlPlane::new(Arc::new(plugins::InMemoryPluginRegistry::default()));
    control
        .import(package, plugins::ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .record_runtime(
            "vibex.office",
            plugins::RuntimeInstallation {
                id: runtime.id.clone(),
                version: runtime.version.clone().unwrap(),
                target: runtime.target.clone(),
                content_digest: runtime.content_digest.clone(),
                executable_path: "/verified/officecli".into(),
                ownership: "managed".to_owned(),
                installer: "binary".to_owned(),
                probe: runtime.probe.clone(),
                referenced_plugins: vec![],
            },
        )
        .await
        .unwrap();
    control
        .activate_and_enable(&node, "vibex.office", &[], Arc::new(EchoBroker))
        .await
        .unwrap();

    let action = control
        .resolve_action("vibex.office", "create-document")
        .await
        .unwrap();
    assert_eq!(action.required_skills[0].as_str(), "office-docx");
    assert_eq!(action.required_tools[0].as_str(), "officecli");
    assert_eq!(action.artifact_intent.unwrap().provider, "office-preview");
    assert!(action.prompt_blocks.iter().any(|block| matches!(
        block,
        plugins::PromptBlock::Text { text } if text.contains("/verified/officecli")
            && text.contains("office-docx/SKILL.md")
    )));
}

#[tokio::test]
async fn failed_office_candidate_keeps_the_previous_generation_active() {
    let Some(node) = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    }) else {
        return;
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins/office");
    let package = PluginPackage::inspect(&root, PluginSourceKind::Builtin).unwrap();
    let grants = [];
    let manager = ActivationManager::default();
    let active = manager
        .activate_candidate(&node, &package, &grants, Arc::new(EchoBroker))
        .await
        .unwrap();
    let candidate_root = tempfile::tempdir().unwrap();
    std::fs::write(
        candidate_root.path().join("bad.mjs"),
        "import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const m=JSON.parse(l);const result=m.method==='initialize'?{protocolVersion:'1.1',sdkVersion:'1.0.0',registrations:['undeclared-handler'],requestedFeatures:[]}:{handlers:['undeclared-handler']};console.log(JSON.stringify({id:m.id,ok:true,result}));}",
    )
    .unwrap();
    let mut bad = package.clone();
    bad.source.path = candidate_root.path().to_path_buf();
    bad.entrypoints.worker = Some("bad.mjs".to_owned());
    let error = manager
        .activate_candidate(&node, &bad, &grants, Arc::new(EchoBroker))
        .await
        .expect_err("undeclared candidate registration must fail");
    assert_eq!(error.code(), "handler_undeclared");
    let lease = manager.lease("vibex.office").await.unwrap();
    assert_eq!(lease.activation().generation, active.generation);
    assert_eq!(
        lease
            .invoke(
                "office-preview",
                json!({
                    "artifactHandle": "still-active-handle",
                    "providerId": "office-preview"
                }),
            )
            .await
            .unwrap()["generation"],
        active.generation
    );
    manager.deactivate("vibex.office").await.unwrap();
}
