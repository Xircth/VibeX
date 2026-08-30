use std::sync::Arc;

use plugins::{
    ConflictDecision, InMemoryPluginRegistry, PluginControlPlane, PluginPackage, PluginSourceKind,
    SESSION_FEAT_ALL, SESSION_FEAT_ASK,
};

fn inspect(dir: &str) -> PluginPackage {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins");
    PluginPackage::inspect(&root.join(dir), PluginSourceKind::Builtin).unwrap()
}

#[tokio::test]
async fn replaced_collaboration_builtin_is_retired_into_multi_agent() {
    let retired_root = tempfile::tempdir().unwrap();
    let successor_root = tempfile::tempdir().unwrap();
    let mut retired = PluginPackage::for_test(
        "vibex.collaboration",
        "VibeX Collaboration",
        "1.0.0",
        PluginSourceKind::Builtin,
        retired_root.path(),
    );
    retired.description = Some("让父 Agent 通过 vibex-mcp 把工作委派给其它 Agent。".into());
    retired.config = serde_json::json!({ "depthLimit": 3 });
    let mut successor = inspect("multi-agent");
    successor.source.path = successor_root.path().to_path_buf();
    std::fs::write(
        successor_root.path().join("config.json"),
        successor.config.to_string(),
    )
    .unwrap();

    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    control
        .import(retired, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .import(successor, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .set_enabled("vibex.collaboration", true)
        .await
        .unwrap();

    control.retire_replaced_builtins().await.unwrap();

    assert!(
        control
            .plugin("vibex.collaboration")
            .await
            .unwrap()
            .is_none()
    );
    let successor = control.plugin("vibex.multi-agent").await.unwrap().unwrap();
    assert_eq!(successor.activation, plugins::PluginActivation::Enabled);
    assert_eq!(successor.config["depthLimit"], 3);
}

#[test]
fn bundled_multi_agent_plugin_is_the_delegation_gate() {
    let package = inspect("multi-agent");
    assert_eq!(package.id.as_str(), "vibex.multi-agent");
    assert_eq!(package.publisher.as_deref(), Some("vibex"));
    assert_eq!(package.summary, "让父 Agent 把子任务委托给其它 Agent。");
    assert!(package.entrypoints.worker.is_none());
    assert_eq!(package.skills.len(), 1);
    assert_eq!(package.skills[0].id, "vibex-multi-agent");
    let schema = package
        .config_schema
        .as_ref()
        .expect("multi-agent config schema");
    let agent_defaults = schema
        .pointer("/properties/agentDefaults")
        .expect("agentDefaults schema");
    assert_eq!(agent_defaults["type"], "object");
    assert_eq!(
        agent_defaults
            .pointer("/additionalProperties/properties/modeId/type")
            .unwrap(),
        "string"
    );
}

#[test]
fn bundled_session_enhance_plugin_carries_four_tool_switches() {
    let package = inspect("session-enhance");
    assert_eq!(package.id.as_str(), "vibex.session-enhance");
    let detail = package.product_detail().unwrap();
    assert_eq!(detail.config["feedback"], true);
    assert_eq!(detail.config["question"], true);
    assert_eq!(detail.config["sessionInfo"], true);
    assert_eq!(detail.config["sessionControl"], true);
}

#[tokio::test]
async fn enabling_each_plugin_opens_only_its_mcp_gate() {
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    control
        .import(inspect("multi-agent"), ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .import(inspect("session-enhance"), ConflictDecision::Reject)
        .await
        .unwrap();
    control.sync_official_product_mcp_gate().await.unwrap();
    let gate = control.official_product_mcp_gate();
    assert!(!gate.allow_delegation_mcp());
    assert!(!gate.allow_session_mcp());

    control
        .set_enabled("vibex.multi-agent", true)
        .await
        .unwrap();
    assert!(gate.allow_delegation_mcp());
    assert!(!gate.allow_session_mcp());

    control
        .set_enabled("vibex.session-enhance", true)
        .await
        .unwrap();
    assert!(gate.allow_session_mcp());
    assert_eq!(gate.session_features(), SESSION_FEAT_ALL);

    gate.set_session_features(SESSION_FEAT_ASK);
    assert_eq!(gate.session_features(), SESSION_FEAT_ASK);

    control
        .set_enabled("vibex.multi-agent", false)
        .await
        .unwrap();
    assert!(!gate.allow_delegation_mcp());
    assert!(gate.allow_session_mcp());
}

#[test]
fn bundled_plugin_development_is_skill_only() {
    let package = inspect("plugin-development");
    assert_eq!(package.id.as_str(), "vibex.plugin-development");
    assert_eq!(package.publisher.as_deref(), Some("vibex"));
    assert_eq!(
        package.summary,
        "让 Agent 在本机用当前 Host 的 SDK 与 CLI 开发、校验、链接并发布插件。"
    );
    assert_eq!(package.skills.len(), 1);
    assert!(
        package
            .mcp
            .as_object()
            .is_none_or(|object| object.is_empty())
    );
}
