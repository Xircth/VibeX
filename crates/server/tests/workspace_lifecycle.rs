use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use remote_protocol::{CommandResponse, OperationId};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt;

const TOKEN: &str = "web-domain-test-token-with-at-least-32-bytes";

async fn call(app: Router, command: &str, args: serde_json::Value) -> serde_json::Value {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/call/{command}"))
                .header("authorization", format!("Bearer {TOKEN}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": OperationId::new(),
                        "args": args,
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(
        status,
        StatusCode::OK,
        "{command}: {}",
        String::from_utf8_lossy(&body)
    );
    serde_json::from_slice::<CommandResponse<serde_json::Value>>(&body)
        .expect("command envelope")
        .data
}

async fn call_status(app: Router, command: &str, args: serde_json::Value) -> StatusCode {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/call/{command}"))
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::json!({
                    "operation_id": OperationId::new(),
                    "args": args,
                })
                .to_string(),
            ))
            .expect("request"),
    )
    .await
    .expect("response")
    .status()
}

#[tokio::test]
async fn workspace_hooks_preserve_root_mode_and_failures_are_visible_and_retryable() {
    use git::{GitCli, GitService};
    use serde_json::json;
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("data");
    let source = temp.path().join("source");
    let git = GitService::new();
    git.initialize_repo_with_main_branch(&source).unwrap();
    GitCli::new()
        .git(&source, ["config", "user.name", "Test"])
        .unwrap();
    GitCli::new()
        .git(&source, ["config", "user.email", "test@example.com"])
        .unwrap();
    std::fs::write(source.join("README.md"), "source").unwrap();
    git.commit(&source, "seed").unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let mut config = services::services::config::Config::default();
    config.workspace_dir = Some(temp.path().join("managed").to_string_lossy().into_owned());
    services::services::config::save_config_to_file(&config, &data.join("settings.json"))
        .await
        .unwrap();
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(&data).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .unwrap();
    let app = server.runtime().router();
    let project = call(app.clone(), "create_project", json!({"payload": {"name": "Lifecycle", "repositories": [{"display_name": "Source", "git_repo_path": source}]}})).await;
    let project_id = project["id"].as_str().unwrap();
    let repos = call(
        app.clone(),
        "get_project_repositories",
        json!({"id": project_id}),
    )
    .await;
    let repo_id = repos[0]["id"].as_str().unwrap();
    let settings = json!({"create_command":"exit 7", "delete_command":"exit 9", "cleanup_prompt_enabled":true, "cleanup_prompt_threshold":5});
    call(
        app.clone(),
        "update_project_worktree_settings",
        json!({"projectId": project_id,"settings":settings}),
    )
    .await;
    // Opening the project stays in the source directory and never runs hooks.
    let root_session = call(
        app.clone(),
        "create_project_session",
        json!({"payload":{"projectId":project_id}}),
    )
    .await;
    let root = call(
        app.clone(),
        "get_workspace",
        json!({"workspaceId":root_session["workspace_id"]}),
    )
    .await;
    assert_eq!(root["use_worktree"], false);
    assert_eq!(
        std::path::PathBuf::from(root["container_ref"].as_str().unwrap()),
        source
    );
    let request = json!({"payload":{"projectId":project_id,"createWorkspace":true,"repos":[{"repoId":repo_id,"targetBranch":"main"}]}});
    assert_ne!(
        call_status(app.clone(), "create_project_session", request).await,
        StatusCode::OK
    );
    let workspaces = call(
        app.clone(),
        "get_project_workspaces",
        json!({"projectId":project_id}),
    )
    .await;
    let failed = workspaces
        .as_array()
        .unwrap()
        .iter()
        .find(|workspace| workspace["use_worktree"] == true)
        .unwrap();
    let workspace_id = failed["id"].as_str().unwrap();
    let root_path = std::path::PathBuf::from(failed["container_ref"].as_str().unwrap());
    assert_eq!(
        call(
            app.clone(),
            "get_workspace_initialization",
            json!({"workspaceId":workspace_id})
        )
        .await["phase"],
        "failed"
    );
    assert_ne!(
        call_status(
            app.clone(),
            "delete_workspace",
            json!({"workspaceId":workspace_id})
        )
        .await,
        StatusCode::OK
    );
    assert!(root_path.exists());
    assert_eq!(
        call(
            app.clone(),
            "get_workspace",
            json!({"workspaceId":workspace_id})
        )
        .await["id"],
        workspace_id
    );
    call(app.clone(), "update_project_worktree_settings", json!({"projectId":project_id,"settings":{"create_command":"echo ready > ready.txt","delete_command":null,"cleanup_prompt_enabled":false,"cleanup_prompt_threshold":5}})).await;
    call(
        app.clone(),
        "retry_workspace_initialization",
        json!({"workspaceId":workspace_id}),
    )
    .await;
    assert_eq!(
        call(
            app.clone(),
            "get_workspace_initialization",
            json!({"workspaceId":workspace_id})
        )
        .await["phase"],
        "ready"
    );
    let workspace_uuid = uuid::Uuid::parse_str(workspace_id).unwrap();
    let session = db::models::session::Session::create(
        server.pool(),
        &db::models::session::CreateSession {
            executor: None,
            agent_id: None,
            task_id: None,
            name: None,
            initial_prompt: None,
            status: None,
        },
        uuid::Uuid::new_v4(),
        workspace_uuid,
    )
    .await
    .unwrap();
    let turn_id = uuid::Uuid::new_v4();
    db::models::conversation_turn::ConversationTurnRecord::create_pending(
        server.pool(),
        turn_id,
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id: session.id,
            prompt_id: None,
            text_preview: None,
            input_blocks_json: "[]",
        },
    )
    .await
    .unwrap();
    assert_ne!(
        call_status(
            app.clone(),
            "delete_workspace",
            json!({"workspaceId":workspace_id,"deleteBranches":true})
        )
        .await,
        StatusCode::OK
    );
    assert!(root_path.exists());
    assert!(
        git.check_branch_exists(&source, failed["branch"].as_str().unwrap())
            .unwrap()
    );
    db::models::conversation_turn::ConversationTurnRecord::mark_completed(
        server.pool(),
        turn_id,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    call(
        app.clone(),
        "delete_workspace",
        json!({"workspaceId":workspace_id,"deleteBranches":true}),
    )
    .await;
    assert!(!root_path.exists());
    assert!(
        !git.check_branch_exists(&source, failed["branch"].as_str().unwrap())
            .unwrap()
    );
    assert!(source.join("README.md").exists());
}
