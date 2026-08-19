use std::sync::Arc;

use plugins::{
    ConflictDecision, InMemoryPluginRegistry, PluginControlPlane, PluginPackage, PluginSourceKind,
    SESSION_FEAT_ALL, SESSION_FEAT_ASK,
};

fn inspect(dir: &str) -> PluginPackage {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/plugins");
    PluginPackage::inspect(&root.join(dir), PluginSourceKind::Builtin).unwrap()
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
