use std::path::Path;

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use remote_protocol::{CommandResponse, OperationId};
use server::{HeadlessServer, ServerBootstrapConfig, ServerToken};
use tempfile::TempDir;
use tower::ServiceExt;

const TOKEN: &str = "native-engine-adoption-test-token-32b";

struct PathGuard {
    original: Option<std::ffi::OsString>,
}

impl PathGuard {
    fn prepend(dir: &Path) -> Self {
        let original = std::env::var_os("PATH");
        let mut entries = vec![dir.to_path_buf()];
        if let Some(ref current) = original {
            entries.extend(std::env::split_paths(current));
        }
        let joined = std::env::join_paths(entries).expect("join PATH");
        unsafe { std::env::set_var("PATH", &joined) };
        Self { original }
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        unsafe {
            match self.original.take() {
                Some(value) => std::env::set_var("PATH", value),
                None => std::env::remove_var("PATH"),
            }
        }
    }
}

fn write_fake_cli(dir: &Path, name: &str, version_line: &str) {
    #[cfg(windows)]
    {
        let path = dir.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off\r\necho {version_line}\r\n"))
            .expect("write fake windows cli");
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho \"{version_line}\"\n"))
            .expect("write fake unix cli");
        let mut perms = std::fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod +x");
    }
}

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
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice::<CommandResponse<serde_json::Value>>(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command envelope")
    .data
}

#[test]
fn claude_code_and_codex_adopt_on_discovery_preflight_and_enable_without_resurrecting_uninstalled()
{
    // Debug Host bootstrap exceeds the default Windows test-thread stack.
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime")
                .block_on(native_engine_adoption_journey());
        })
        .expect("spawn test thread")
        .join()
        .expect("join test thread");
}

async fn native_engine_adoption_journey() {
    let _ = utils::shell::refresh_process_path().await;
    let bin_dir = TempDir::new().expect("bin dir");
    write_fake_cli(bin_dir.path(), "claude", "2.1.325 (Claude Code)");
    write_fake_cli(bin_dir.path(), "codex", "codex-cli 0.169.0");
    let _path_guard = PathGuard::prepend(bin_dir.path());

    let data_dir = TempDir::new().expect("data dir");
    let server = HeadlessServer::bootstrap(
        ServerBootstrapConfig::new(data_dir.path()).with_token(ServerToken::new(TOKEN)),
    )
    .await
    .expect("headless server");
    let app = server.runtime().router();

    // 1. Wait for startup local runtime discovery to finish.
    let mut completed = false;
    for _ in 0..250 {
        let progress = call(
            app.clone(),
            "agent_management_discovery_progress",
            serde_json::json!({}),
        )
        .await;
        if progress["phase"] == "complete" {
            completed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(completed, "local runtime discovery should finish promptly");

    for agent_id in ["claude_code", "codex"] {
        let detail = call(
            app.clone(),
            "agent_management_detail",
            serde_json::json!({ "agentId": agent_id }),
        )
        .await;
        assert_eq!(detail["enabled"], serde_json::json!(true), "{agent_id}");
        assert_ne!(
            detail["lifecycle"],
            serde_json::json!("uninstalled"),
            "{agent_id} should auto-adopt during startup discovery"
        );
        assert!(
            detail["runtime_version"]
                .as_str()
                .is_some_and(|v| !v.is_empty()),
            "{agent_id} should expose runtime_version"
        );
        assert!(
            detail["local_runtime"]["path"]
                .as_str()
                .is_some_and(|v| !v.is_empty()),
            "{agent_id} should expose local_runtime overlay"
        );
    }

    // 2. Simulate the exact bug state: enabled = 1, CLI present on disk,
    //    but agent_installation was never persisted (lifecycle = uninstalled).
    //    Running preflight must adopt and clear `uninstalled`.
    sqlx::query("DELETE FROM agent_installation WHERE agent_id IN ('claude_code', 'codex')")
        .execute(server.pool())
        .await
        .expect("clear installation");
    sqlx::query("DELETE FROM agent_install_component WHERE lock_id IN (SELECT id FROM agent_install_lock WHERE agent_id IN ('claude_code', 'codex'))")
        .execute(server.pool())
        .await
        .expect("clear component");
    sqlx::query("DELETE FROM agent_install_lock WHERE agent_id IN ('claude_code', 'codex')")
        .execute(server.pool())
        .await
        .expect("clear lock");

    for agent_id in ["claude_code", "codex"] {
        let before = call(
            app.clone(),
            "agent_management_detail",
            serde_json::json!({ "agentId": agent_id }),
        )
        .await;
        assert_eq!(before["lifecycle"], serde_json::json!("uninstalled"));

        let report = call(
            app.clone(),
            "agent_management_preflight",
            serde_json::json!({ "agentId": agent_id }),
        )
        .await;
        let acp_item = report["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["id"] == "acp")
            .expect("acp preflight item");
        assert_eq!(acp_item["status"], serde_json::json!("pass"), "{agent_id}");

        let after = call(
            app.clone(),
            "agent_management_detail",
            serde_json::json!({ "agentId": agent_id }),
        )
        .await;
        assert_ne!(
            after["lifecycle"],
            serde_json::json!("uninstalled"),
            "{agent_id} preflight must adopt enabled native engine"
        );
        assert!(
            after["runtime_version"]
                .as_str()
                .is_some_and(|v| !v.is_empty()),
            "{agent_id} after preflight should have runtime_version"
        );
    }

    // 3. Explicit Disable & Uninstall sets enabled = 0 and deletes installation;
    //    subsequent preflight MUST NOT resurrect installation while disabled.
    for agent_id in ["claude_code", "codex"] {
        let _ = call(
            app.clone(),
            "agent_management_uninstall",
            serde_json::json!({ "agentId": agent_id, "clearData": false }),
        )
        .await;
        let _ = call(
            app.clone(),
            "agent_management_preflight",
            serde_json::json!({ "agentId": agent_id }),
        )
        .await;
        let disabled = call(
            app.clone(),
            "agent_management_detail",
            serde_json::json!({ "agentId": agent_id }),
        )
        .await;
        assert_eq!(disabled["enabled"], serde_json::json!(false), "{agent_id}");
        assert_eq!(
            disabled["lifecycle"],
            serde_json::json!("uninstalled"),
            "{agent_id} must stay uninstalled while disabled"
        );

        // 4. Re-enabling must immediately adopt back out of uninstalled.
        let enabled = call(
            app.clone(),
            "agent_management_set_enabled",
            serde_json::json!({ "agentId": agent_id, "enabled": true }),
        )
        .await;
        assert_eq!(enabled["enabled"], serde_json::json!(true), "{agent_id}");
        assert_ne!(
            enabled["lifecycle"],
            serde_json::json!("uninstalled"),
            "{agent_id} re-enable must immediately adopt"
        );
        assert!(
            enabled["runtime_version"]
                .as_str()
                .is_some_and(|v| !v.is_empty()),
            "{agent_id} re-enable must populate runtime_version"
        );
    }
}
