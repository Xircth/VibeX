use super::*;

async fn probe_pool(
    agent_id: &str,
    lifecycle: &str,
    authentication: &str,
    authentication_required: i64,
) -> sqlx::SqlitePool {
    let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
    sqlx::query(
        r#"CREATE TABLE agent_installation (
             agent_id TEXT PRIMARY KEY,
             lifecycle TEXT NOT NULL,
             current_lock_id TEXT
           )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"CREATE TABLE agent_probe (
             agent_id TEXT PRIMARY KEY,
             lifecycle TEXT NOT NULL,
             authentication TEXT NOT NULL,
             detail_json TEXT NOT NULL,
             probed_at TEXT NOT NULL,
             runtime_available INTEGER NOT NULL DEFAULT 0,
             acp_handshake INTEGER NOT NULL DEFAULT 0,
             authentication_required INTEGER NOT NULL DEFAULT 0,
             observation_generation INTEGER NOT NULL DEFAULT 0
           )"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO agent_installation VALUES (?, ?, 'lock-1')")
        .bind(agent_id)
        .bind(lifecycle)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO agent_probe
           VALUES (?, ?, ?, '{}', '2026-08-01T00:00:00Z', 1, 1, ?, 1)"#,
    )
    .bind(agent_id)
    .bind(lifecycle)
    .bind(authentication)
    .bind(authentication_required)
    .execute(&pool)
    .await
    .unwrap();
    pool
}

#[tokio::test]
async fn persisting_api_key_observation_clears_needs_auth() {
    let pool = probe_pool("claude_code", "needs_auth", "not_logged_in", 1).await;
    let agent_id = AgentId::parse("claude_code").unwrap();
    persist_authentication_probe(&pool, &agent_id, AgentAuthenticationStatus::ApiKey)
        .await
        .unwrap();
    let row = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT lifecycle, authentication, authentication_required FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, ("ready".into(), "api_key".into(), false));
}

#[tokio::test]
async fn codebuddy_subscription_preflight_and_probe_do_not_require_static_account_evidence() {
    let pool = probe_pool("codebuddy", "needs_auth", "not_logged_in", 1).await;
    let agent_id = AgentId::parse("codebuddy").unwrap();
    persist_authentication_probe(&pool, &agent_id, AgentAuthenticationStatus::NotLoggedIn)
        .await
        .unwrap();
    let row = sqlx::query_as::<_, (String, String, bool)>(
        "SELECT lifecycle, authentication, authentication_required FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, ("ready".into(), "not_logged_in".into(), false));

    let temp = tempfile::tempdir().unwrap();
    let env = HashMap::from([
        (
            "CODEBUDDY_CONFIG_DIR".to_string(),
            temp.path().display().to_string(),
        ),
        (
            "CODEBUDDY_AUTH_MODE".to_string(),
            "official_subscription".to_string(),
        ),
    ]);
    let item = auth_mode_preflight_item(
        &pool,
        &agent_id,
        &env,
        AgentAuthenticationStatus::NotLoggedIn,
    )
    .await
    .unwrap()
    .expect("codebuddy auth mode preflight item");
    assert_eq!(item.status, "pass");
    assert_eq!(item.version.as_deref(), Some("official_subscription"));

    let api_env = HashMap::from([
        (
            "CODEBUDDY_CONFIG_DIR".to_string(),
            temp.path().display().to_string(),
        ),
        (
            "CODEBUDDY_AUTH_MODE".to_string(),
            "official_api".to_string(),
        ),
    ]);
    let api_item = auth_mode_preflight_item(
        &pool,
        &agent_id,
        &api_env,
        AgentAuthenticationStatus::NotLoggedIn,
    )
    .await
    .unwrap()
    .expect("codebuddy official_api preflight item");
    assert_eq!(api_item.status, "fail");
}

async fn lock_pool(agent_id: &str, components: &[(&str, &Path)]) -> sqlx::SqlitePool {
    use sqlx::{SqlitePool, query};
    let pool = SqlitePool::connect(":memory:").await.unwrap();
    query("CREATE TABLE agent_installation (agent_id TEXT PRIMARY KEY, current_lock_id TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    query(
        "CREATE TABLE agent_install_component (
             lock_id TEXT NOT NULL,
             component_kind TEXT NOT NULL,
             absolute_path TEXT NOT NULL
           )",
    )
    .execute(&pool)
    .await
    .unwrap();
    query("INSERT INTO agent_installation VALUES (?, 'lock-1')")
        .bind(agent_id)
        .execute(&pool)
        .await
        .unwrap();
    for (kind, path) in components {
        query("INSERT INTO agent_install_component VALUES ('lock-1', ?, ?)")
            .bind(*kind)
            .bind(path.display().to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    pool
}

fn two_entry_action() -> agents::ProfileManagementAction {
    agents::ProfileManagementAction {
        id: "login",
        label: "登录",
        description: "登录",
        kind: ProfileManagementActionKind::Login,
        programs: &[
            agents::ProfileManagementProgram {
                program: "dimo-test-agent-cli",
                args: &["cli-login"],
            },
            agents::ProfileManagementProgram {
                program: "dimo-test-agent-acp",
                args: &["--cli", "adapter-login"],
            },
        ],
        url: None,
    }
}

#[tokio::test]
async fn management_action_falls_back_to_the_adapter_entry_point() {
    let temp = tempfile::tempdir().unwrap();
    let adapter = temp.path().join("dimo-test-agent-acp.cmd");
    std::fs::write(&adapter, []).unwrap();
    let pool = lock_pool("dimo_test_agent", &[("acp_adapter", &adapter)]).await;
    let agent_id = AgentId::parse("dimo_test_agent").unwrap();

    let resolved =
        resolve_management_action_program(&pool, &agent_id, &two_entry_action(), &HashMap::new())
            .await
            .expect("the adapter entry point resolves");

    assert_eq!(resolved.path, adapter);
    assert_eq!(resolved.args, vec!["--cli", "adapter-login"]);
}

#[tokio::test]
async fn management_action_prefers_the_standalone_cli_entry_point() {
    let temp = tempfile::tempdir().unwrap();
    let cli = temp.path().join("dimo-test-agent-cli.cmd");
    std::fs::write(&cli, []).unwrap();
    let pool = lock_pool("dimo_test_agent", &[("agent_runtime", &cli)]).await;
    let agent_id = AgentId::parse("dimo_test_agent").unwrap();

    let resolved =
        resolve_management_action_program(&pool, &agent_id, &two_entry_action(), &HashMap::new())
            .await
            .expect("the standalone entry point resolves");

    assert_eq!(resolved.path, cli);
    assert_eq!(resolved.args, vec!["cli-login"]);
}
