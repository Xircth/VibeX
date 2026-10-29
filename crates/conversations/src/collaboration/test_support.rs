//! Shared fixtures for collaboration module tests.

use std::str::FromStr;

use agents::AgentId;
use db::models::{
    collaboration_identity as identity,
    session::{CreateSession, Session},
};
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

use super::*;

pub(crate) async fn setup_pool() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect memory db");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("disable foreign keys");
    pool
}

pub(crate) fn session(name: Option<&str>) -> CreateSession {
    CreateSession {
        executor: None,
        agent_id: Some(AgentId::parse("codex").expect("agent")),
        task_id: None,
        name: name.map(str::to_string),
        initial_prompt: None,
        status: None,
    }
}

pub(crate) async fn create_session(
    pool: &SqlitePool,
    id: Uuid,
    workspace: Uuid,
    name: Option<&str>,
) {
    Session::create(pool, &session(name), id, workspace)
        .await
        .expect("create session");
}

pub(crate) async fn input_count(pool: &SqlitePool, conversation: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM conversation_inputs WHERE conversation_id = ?")
        .bind(conversation)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(crate) async fn mark_running(pool: &SqlitePool, conversation: Uuid) -> Uuid {
    let turn = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO conversation_turns
           (id, conversation_id, ordinal, role, status, input_blocks_json)
           VALUES (?, ?, 1, 'user_prompt', 'running', '[]')"#,
    )
    .bind(turn)
    .bind(conversation)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE sessions SET active_turn_id = ? WHERE id = ?")
        .bind(turn)
        .bind(conversation)
        .execute(pool)
        .await
        .unwrap();
    turn
}

pub(crate) fn send_for(
    caller: Uuid,
    target: Uuid,
    policy: CompanionWritePolicy,
) -> SendSessionInput {
    SendSessionInput {
        caller_id: caller,
        conversation_id: target,
        operation_id: Uuid::new_v4(),
        text: "hello".to_string(),
        policy,
        steer: false,
        steer_supported: false,
        expected_turn_id: None,
        delay_seconds: None,
        deliver_at: None,
        delay_cap_hours: 24,
    }
}

pub(crate) fn spawned_from(
    caller: Uuid,
    operation_id: Uuid,
    role_id: Option<String>,
) -> CreateSpawnedConversation {
    CreateSpawnedConversation {
        caller_id: caller,
        operation_id,
        role_id,
        agent_id: None,
        title: None,
        prompt: None,
        mode_id: None,
        config_values: None,
        depth_limit: 8,
        max_active_children: 64,
    }
}

pub(crate) async fn space_of(pool: &SqlitePool, caller: Uuid) -> String {
    let was_bot = identity::binding_of_conversation(pool, caller)
        .await
        .unwrap()
        .is_some();
    let space_id = create_collaboration_space(pool, caller, "评审工作", Uuid::new_v4())
        .await
        .unwrap()
        .space_id;
    if !was_bot {
        let session = load_session(pool, caller).await.unwrap().unwrap();
        let nickname = session
            .name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("发起者")
            .to_string();
        add_space_member(pool, caller, &space_id, caller, &nickname, Uuid::new_v4())
            .await
            .unwrap();
    }
    space_id
}

pub(crate) async fn session_controls_of(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> (Option<String>, Option<String>) {
    sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT current_mode, config_selection_json FROM conversation_agent_bindings
         WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .unwrap()
    .unwrap_or((None, None))
}

pub(crate) async fn post_as(
    pool: &SqlitePool,
    caller: Option<Uuid>,
    space: &str,
    text: &str,
    to: &[&str],
) -> SpacePostResult {
    post_to_space(
        pool,
        PostToSpace {
            caller_id: caller,
            space_id: space.to_string(),
            content: text.to_string(),
            summary: None,
            to: to.iter().map(|name| name.to_string()).collect(),
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap()
}

pub(crate) async fn inputs_of(pool: &SqlitePool, conversation: Uuid) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ? ORDER BY sort_key",
    )
    .bind(conversation)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Test provisioner: real `git worktree add` per isolated session.
pub(crate) struct GitWorktreeProvisioner {
    pub(crate) repo: std::path::PathBuf,
    pub(crate) dirs: std::sync::Mutex<std::collections::HashMap<Uuid, std::path::PathBuf>>,
    pub(crate) calls: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl IsolatedWorkspaceProvisioner for GitWorktreeProvisioner {
    async fn provision(
        &self,
        _plan: &MemberWritePlan,
        conversation_id: Uuid,
        isolated: Uuid,
    ) -> Result<Option<(Uuid, Value)>, String> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = self.repo.with_file_name(format!("wt-{isolated}"));
        git(
            &self.repo,
            &[
                "worktree",
                "add",
                "-b",
                &format!("member/{conversation_id}"),
                dir.to_str().unwrap(),
            ],
        );
        self.dirs.lock().unwrap().insert(isolated, dir);
        Ok(Some((
            isolated,
            json!({ "branch": format!("member/{conversation_id}") }),
        )))
    }
}

pub(crate) fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub(crate) struct EchoDistiller;

#[async_trait::async_trait]
impl crate::member_memory::FactDistiller for EchoDistiller {
    async fn distill(
        &self,
        _member_id: &str,
        activity: &[crate::member_memory::ActivityEntry],
    ) -> Vec<crate::member_memory::DistilledFact> {
        activity
            .iter()
            .map(|entry| crate::member_memory::DistilledFact {
                content: format!("distilled: {}", entry.summary),
                global: true,
                thread_id: Some(entry.thread_id.clone()),
            })
            .collect()
    }
}
