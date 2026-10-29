
use db::models::{collaboration_identity as identity, session::Session};

use super::*;
use crate::collaboration::test_support::*;

#[tokio::test]
async fn list_conversations_excludes_bodies() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, Some("caller")).await;
    let items = list_conversations(
        &pool,
        ListConversations {
            caller_id: caller,
            since_days: 7,
            project_id: None,
            workspace_id: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    let json = serde_json::to_value(&items).unwrap();
    let encoded = json.to_string();
    assert!(!encoded.contains("messages"));
    assert!(!encoded.contains("persona_prompt"));
    assert!(!encoded.contains("\"content\""));
    assert!(json[0].get("mode_id").is_none());
    assert!(json[0].get("config_values").is_none());
    assert!(json[0].get("title").is_some());
}

#[tokio::test]
async fn list_conversations_defaults_to_caller_workspace() {
    let pool = setup_pool().await;
    let home = Uuid::new_v4();
    let other = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let sibling = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    create_session(&pool, caller, home, Some("home")).await;
    create_session(&pool, sibling, home, Some("sibling")).await;
    create_session(&pool, outsider, other, Some("outsider")).await;
    sqlx::query("UPDATE sessions SET updated_at = datetime('now', '-10 days') WHERE id = ?")
        .bind(sibling)
        .execute(&pool)
        .await
        .unwrap();
    let week = list_conversations(
        &pool,
        ListConversations {
            caller_id: caller,
            since_days: 7,
            project_id: None,
            workspace_id: None,
            limit: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(week.len(), 1);
    assert_eq!(week[0].conversation_id, caller);
    assert_eq!(week[0].workspace_id, home);
    let day = list_conversations(
        &pool,
        ListConversations {
            caller_id: caller,
            since_days: 1,
            project_id: None,
            workspace_id: None,
            limit: Some(100),
        },
    )
    .await
    .unwrap();
    assert!(day.iter().all(|item| item.conversation_id != sibling));
    assert!(day.iter().all(|item| item.conversation_id != outsider));
}

#[tokio::test]
async fn get_session_info_same_bytes_from_both_entrypoints() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let parent = Uuid::new_v4();
    let child = Uuid::new_v4();
    create_session(&pool, parent, workspace, Some("parent")).await;
    create_session(&pool, child, workspace, Some("child")).await;
    sqlx::query("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
        .bind(parent)
        .bind(child)
        .execute(&pool)
        .await
        .unwrap();
    let left = read_session_info_for_delegation(&pool, &child.to_string(), 0).await;
    let right = read_session_info_for_session_product(&pool, &child.to_string(), 0).await;
    assert_eq!(
        serde_json::to_vec(&left).unwrap(),
        serde_json::to_vec(&right).unwrap()
    );
    assert_eq!(left["is_delegation_child"], false);
    sqlx::query("UPDATE sessions SET delegation_call_id = 'call-1' WHERE id = ?")
        .bind(child)
        .execute(&pool)
        .await
        .unwrap();
    let delegated = read_session_info_for_delegation(&pool, &child.to_string(), 0).await;
    assert_eq!(delegated["is_delegation_child"], true);
}

#[tokio::test]
async fn create_from_role_snapshots_persona() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, Some("caller")).await;
    let team = create_team(
        &pool,
        SaveTeam {
            id: None,
            name: "评审组".to_string(),
            summary: Some("评审".to_string()),
        },
    )
    .await
    .unwrap();
    let role = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "评审员".to_string(),
            team_id: Some(team.id.clone()),
            summary: "只看 diff".to_string(),
            persona_prompt: "只评论 diff，不改文件".to_string(),
            agent_id: "codex".to_string(),
            mode_id: Some("plan".to_string()),
            config_values: json!({ "model": "gpt" }),
        },
    )
    .await
    .unwrap();
    let operation_id = Uuid::new_v4();
    let created = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            caller_id: caller,
            operation_id,
            role_id: Some(role.id.clone()),
            agent_id: None,
            title: None,
            prompt: Some("开始".to_string()),
            mode_id: Some("ignored".to_string()),
            config_values: Some(json!({ "model": "ignored" })),
            depth_limit: 8,
            max_active_children: 64,
        },
    )
    .await
    .unwrap();
    assert_eq!(created.conversation_id, operation_id);
    let (name, summary, team_name, role_id, call_id, parent): (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<Uuid>,
    ) = sqlx::query_as(
        r#"SELECT persona.name, persona.summary, persona.team_name, persona.role_id,
                  sessions.delegation_call_id, sessions.parent_session_id
           FROM conversation_personas persona
           JOIN sessions ON sessions.id = ?
           WHERE persona.conversation_id = ?"#,
    )
    .bind(operation_id)
    .bind(operation_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(name, "评审员");
    assert_eq!(summary, "只看 diff");
    assert_eq!(team_name, "评审组");
    assert_eq!(role_id, role.id);
    assert!(call_id.is_none());
    assert_eq!(parent, Some(caller));
    let notice: String = sqlx::query_scalar(
        "SELECT normalized_json FROM conversation_events WHERE conversation_id = ?",
    )
    .bind(operation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(notice.contains("只评论 diff，不改文件"));
    assert!(notice.contains("人设"));
    assert!(notice.contains("host_note"));
    assert!(!notice.contains("announcements_updated"));
    let stored_prompt: String = sqlx::query_scalar(
        "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
    )
    .bind(operation_id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored_prompt, "只评论 diff，不改文件");
    assert_eq!(
        prefix_persona_prompt(&stored_prompt, "请评审当前 diff"),
        "人设\n只评论 diff，不改文件\n\n请评审当前 diff"
    );
}

#[tokio::test]
async fn update_role_does_not_touch_persona() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    let role = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "评审员".to_string(),
            team_id: None,
            summary: "before".to_string(),
            persona_prompt: "prompt".to_string(),
            agent_id: "codex".to_string(),
            mode_id: None,
            config_values: json!({}),
        },
    )
    .await
    .unwrap();
    let created = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            caller_id: caller,
            operation_id: Uuid::new_v4(),
            role_id: Some(role.id.clone()),
            agent_id: None,
            title: None,
            prompt: None,
            mode_id: None,
            config_values: None,
            depth_limit: 8,
            max_active_children: 64,
        },
    )
    .await
    .unwrap();
    update_role(
        &pool,
        &role.id,
        SaveRole {
            id: None,
            name: "评审员".to_string(),
            team_id: None,
            summary: "after".to_string(),
            persona_prompt: "changed".to_string(),
            agent_id: "codex".to_string(),
            mode_id: None,
            config_values: json!({}),
        },
    )
    .await
    .unwrap();
    let summary: String =
        sqlx::query_scalar("SELECT summary FROM conversation_personas WHERE conversation_id = ?")
            .bind(created.conversation_id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(summary, "before");
}

#[tokio::test]
async fn delete_role_keeps_session() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    let role = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "评审员".to_string(),
            team_id: None,
            summary: "keep".to_string(),
            persona_prompt: "prompt".to_string(),
            agent_id: "codex".to_string(),
            mode_id: None,
            config_values: json!({}),
        },
    )
    .await
    .unwrap();
    let created = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            caller_id: caller,
            operation_id: Uuid::new_v4(),
            role_id: Some(role.id.clone()),
            agent_id: None,
            title: None,
            prompt: None,
            mode_id: None,
            config_values: None,
            depth_limit: 8,
            max_active_children: 64,
        },
    )
    .await
    .unwrap();
    delete_role(&pool, &role.id).await.unwrap();
    let still: Option<Uuid> = sqlx::query_scalar("SELECT id FROM sessions WHERE id = ?")
        .bind(created.conversation_id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert_eq!(still, Some(created.conversation_id));
    let (persona_name, role_id): (String, Option<String>) =
        sqlx::query_as("SELECT name, role_id FROM conversation_personas WHERE conversation_id = ?")
            .bind(created.conversation_id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(persona_name, "评审员");
    assert!(role_id.is_none());
}

#[tokio::test]
async fn spawned_survives_parent_cancel() {
    assert!(!parent_exit_cancels_child(None));
    assert!(!parent_exit_cancels_child(Some("")));
    assert!(!parent_exit_cancels_child(Some("  ")));
    assert!(parent_exit_cancels_child(Some("call-1")));
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let parent = Uuid::new_v4();
    create_session(&pool, parent, workspace, None).await;
    let spawned = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            caller_id: parent,
            operation_id: Uuid::new_v4(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            title: Some("direct".to_string()),
            prompt: None,
            mode_id: None,
            config_values: None,
            depth_limit: 8,
            max_active_children: 64,
        },
    )
    .await
    .unwrap();
    let call_id: Option<String> =
        sqlx::query_scalar("SELECT delegation_call_id FROM sessions WHERE id = ?")
            .bind(spawned.conversation_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!parent_exit_cancels_child(call_id.as_deref()));
    let delegated = Uuid::new_v4();
    Session::create_with_delegation(
        &pool,
        &session(Some("child")),
        delegated,
        workspace,
        parent,
        "tool-1",
        "call-9",
    )
    .await
    .unwrap();
    let delegated_call: Option<String> =
        sqlx::query_scalar("SELECT delegation_call_id FROM sessions WHERE id = ?")
            .bind(delegated)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(parent_exit_cancels_child(delegated_call.as_deref()));
}

#[tokio::test]
async fn depth_limit_rejects_a_grandchild() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    let role = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "评审员".to_string(),
            team_id: None,
            summary: String::new(),
            persona_prompt: String::new(),
            agent_id: "codex".to_string(),
            mode_id: None,
            config_values: json!({}),
        },
    )
    .await
    .unwrap();
    let child = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            depth_limit: 1,
            ..spawned_from(caller, Uuid::new_v4(), Some(role.id.clone()))
        },
    )
    .await
    .unwrap();
    let error = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            depth_limit: 1,
            ..spawned_from(child.conversation_id, Uuid::new_v4(), Some(role.id))
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "limit_exceeded");
}

#[tokio::test]
async fn active_child_limit_releases_after_completion() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    let first = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            agent_id: Some("codex".to_string()),
            max_active_children: 1,
            ..spawned_from(caller, Uuid::new_v4(), None)
        },
    )
    .await
    .unwrap();
    let blocked = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            agent_id: Some("codex".to_string()),
            max_active_children: 1,
            ..spawned_from(caller, Uuid::new_v4(), None)
        },
    )
    .await
    .unwrap_err();
    assert_eq!(blocked.code, "limit_exceeded");
    mark_running(&pool, first.conversation_id).await;
    sqlx::query("UPDATE conversation_turns SET status = 'completed' WHERE conversation_id = ?")
        .bind(first.conversation_id)
        .execute(&pool)
        .await
        .unwrap();
    create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            agent_id: Some("codex".to_string()),
            max_active_children: 1,
            ..spawned_from(caller, Uuid::new_v4(), None)
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn retry_finishes_a_partial_role_session() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    let role = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "评审员".to_string(),
            team_id: None,
            summary: "只看 diff".to_string(),
            persona_prompt: "只评论 diff".to_string(),
            agent_id: "codex".to_string(),
            mode_id: None,
            config_values: json!({}),
        },
    )
    .await
    .unwrap();
    let operation_id = Uuid::new_v4();
    Session::create(&pool, &session(Some("评审员")), operation_id, workspace)
        .await
        .unwrap();
    let created = create_spawned_conversation(
        &pool,
        spawned_from(caller, operation_id, Some(role.id.clone())),
    )
    .await
    .unwrap();
    assert!(created.idempotent_replay);
    let persona: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM conversation_personas WHERE conversation_id = ?")
            .bind(operation_id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(persona, 1);
    let again =
        create_spawned_conversation(&pool, spawned_from(caller, operation_id, Some(role.id)))
            .await
            .unwrap();
    assert!(again.idempotent_replay);
    let changed = create_spawned_conversation(
        &pool,
        CreateSpawnedConversation {
            title: Some("其他".to_string()),
            ..spawned_from(caller, operation_id, None)
        },
    )
    .await
    .unwrap_err();
    assert_eq!(changed.code, "conversation_control_failed");
}

#[tokio::test]
async fn role_cap_100() {
    let pool = setup_pool().await;
    for index in 0..100 {
        create_role(
            &pool,
            SaveRole {
                id: None,
                name: format!("role-{index}"),
                team_id: None,
                summary: String::new(),
                persona_prompt: String::new(),
                agent_id: "codex".to_string(),
                mode_id: None,
                config_values: json!({}),
            },
        )
        .await
        .unwrap();
    }
    let error = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "overflow".to_string(),
            team_id: None,
            summary: String::new(),
            persona_prompt: String::new(),
            agent_id: "codex".to_string(),
            mode_id: None,
            config_values: json!({}),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "limit_exceeded");
}

#[tokio::test]
async fn member_sessions_use_stored_member_config_and_later_edits() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let seed = Uuid::new_v4();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
        .bind(workspace)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    create_session(&pool, seed, workspace, Some("seed")).await;
    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Alex".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: Some("reviewer".to_string()),
            mode_id: Some("plan".to_string()),
            config_values: Some(json!({ "model": "m-1", "approval": "never" })),
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let direct = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let created_session = load_session(&pool, direct).await.unwrap().unwrap();
    assert!(
        created_session
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    );
    let member = identity::binding_of_conversation(&pool, direct)
        .await
        .unwrap()
        .map(|b| b.member_id)
        .unwrap_or_else(|| identity::member_id_for_conversation(direct));
    let stored = load_member_session_config(&pool, &member)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.agent_id.as_deref(), Some("codex"));
    assert_eq!(stored.mode_id.as_deref(), Some("plan"));
    assert_eq!(stored.config_values["model"], "m-1");

    // New group thread: the session is created from the member config.
    let first = space_of(&pool, seed).await;
    identity::ensure_thread_for_seat(&pool, &first, &member)
        .await
        .unwrap();
    let in_first = resolve_session(&pool, &member, &first).await.unwrap();
    assert_ne!(in_first, direct);
    let session = load_session(&pool, in_first).await.unwrap().unwrap();
    assert_eq!(
        session.agent_id.map(|a| a.to_string()).as_deref(),
        Some("codex")
    );
    let (mode, config) = session_controls_of(&pool, in_first).await;
    assert_eq!(mode.as_deref(), Some("plan"));
    assert!(config.unwrap_or_default().contains("m-1"));

    // Edit 1: updating persona_prompt, mode_id, and config_values syncs to both direct and existing group sessions.
    set_member_session_config(
        &pool,
        &member,
        MemberSessionConfig {
            agent_id: Some("codex".to_string()),
            mode_id: Some("code".to_string()),
            config_values: json!({ "model": "m-updated" }),
            persona_prompt: Some("updated reviewer persona".to_string()),
        },
    )
    .await
    .unwrap();
    for existing_conv in [direct, in_first] {
        let prompt: Option<String> = sqlx::query_scalar(
            "SELECT persona_prompt FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(existing_conv.to_string())
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(prompt.as_deref(), Some("updated reviewer persona"));
        let (m, cfg) = session_controls_of(&pool, existing_conv).await;
        assert_eq!(m.as_deref(), Some("code"));
        assert!(cfg.unwrap_or_default().contains("m-updated"));
    }

    // Edit 2: clearing persona_prompt deletes conversation_personas rows for existing sessions and updates controls.
    set_member_session_config(
        &pool,
        &member,
        MemberSessionConfig {
            agent_id: Some("codex".to_string()),
            mode_id: Some("auto".to_string()),
            config_values: json!({ "model": "m-2" }),
            persona_prompt: None,
        },
    )
    .await
    .unwrap();
    for existing_conv in [direct, in_first] {
        let prompt_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_personas WHERE conversation_id = ?",
        )
        .bind(existing_conv.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(prompt_count, 0);
    }
    let second = space_of(&pool, seed).await;
    identity::ensure_thread_for_seat(&pool, &second, &member)
        .await
        .unwrap();
    let in_second = resolve_session(&pool, &member, &second).await.unwrap();
    let (mode, config) = session_controls_of(&pool, in_second).await;
    assert_eq!(mode.as_deref(), Some("auto"));
    assert!(config.unwrap_or_default().contains("m-2"));
    let (old_mode, old_config) = session_controls_of(&pool, in_first).await;
    assert_eq!(old_mode.as_deref(), Some("auto"));
    assert!(old_config.unwrap_or_default().contains("m-2"));
    let (dm_mode, dm_config) = session_controls_of(&pool, direct).await;
    assert_eq!(dm_mode.as_deref(), Some("auto"));
    assert!(dm_config.unwrap_or_default().contains("m-2"));
}

#[tokio::test]
async fn same_member_in_two_spaces_gets_distinct_conversations() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let first = space_of(&pool, a).await;
    let second = space_of(&pool, a).await;
    let in_first = add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(in_first.conversation_id, Some(b.to_string()));
    let in_second = add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let forked = Uuid::parse_str(in_second.conversation_id.as_deref().unwrap()).unwrap();
    assert_ne!(forked, b);
    let forked_session = load_session(&pool, forked)
        .await
        .unwrap()
        .expect("forked session");
    assert_eq!(forked_session.workspace_id, workspace);

    let member = identity::member_id_for_conversation(b);
    assert_eq!(resolve_session(&pool, &member, &first).await.unwrap(), b);
    assert_eq!(
        resolve_session(&pool, &member, &second).await.unwrap(),
        forked
    );
    assert_eq!(
        resolve_member_target(&pool, a, &member, &second)
            .await
            .unwrap(),
        forked
    );
    let other_workspace = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    create_session(&pool, stranger, other_workspace, Some("外人")).await;
    assert_eq!(
        resolve_member_target(&pool, stranger, &member, &second)
            .await
            .unwrap_err()
            .code,
        "not_found"
    );

    let member_a = identity::member_id_for_conversation(a);
    let a_in_second = resolve_session(&pool, &member_a, &second).await.unwrap();
    for (caller, space, text) in [(a, &first, "第一空间"), (a_in_second, &second, "第二空间")]
    {
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(caller),
                space_id: space.clone(),
                content: text.to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
    }
    let payload = |conversation: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
            )
            .bind(conversation)
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    let to_b = payload(b).await;
    let to_forked = payload(forked).await;
    assert_eq!(to_b.len(), 1);
    assert!(to_b[0].contains("第一空间"));
    assert_eq!(to_forked.len(), 1);
    assert!(to_forked[0].contains("第二空间"));
}

#[tokio::test]
async fn resolve_member_target_accepts_space_seat_id_from_add_space_member() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let first = space_of(&pool, a).await;
    let second = space_of(&pool, a).await;
    let in_first = add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let in_second = add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let forked = Uuid::parse_str(in_second.conversation_id.as_deref().unwrap()).unwrap();
    let identity = identity::member_id_for_conversation(b);
    assert_ne!(
        in_first.member_id, identity,
        "space seat id and identity member id are distinct namespaces"
    );
    assert_ne!(in_first.member_id, in_second.member_id);

    assert_eq!(
        resolve_member_target(&pool, a, &in_first.member_id, &first)
            .await
            .unwrap(),
        b
    );
    assert_eq!(
        resolve_member_target(&pool, a, &in_second.member_id, &second)
            .await
            .unwrap(),
        forked
    );
    assert_eq!(
        resolve_member_target(&pool, a, &in_first.member_id, &second)
            .await
            .unwrap(),
        forked
    );
    assert_eq!(
        resolve_member_target(&pool, a, &identity, &first)
            .await
            .unwrap(),
        b
    );

    let listed = list_space_members_detailed(&pool, a, &first).await.unwrap();
    let listed_b = listed["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["nickname"] == "小B")
        .expect("小B in roster");
    assert_eq!(listed_b["member_id"], in_first.member_id);
    assert_eq!(listed_b["identity_member_id"], identity);
    assert_ne!(listed_b["member_id"], listed_b["identity_member_id"]);
    let tool = space_member_tool_value(&pool, &in_first).await.unwrap();
    assert_eq!(tool["member_id"], in_first.member_id);
    assert_eq!(tool["identity_member_id"], identity);
}

#[tokio::test]
async fn list_space_views_expose_space_lead_nickname() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    let in_space = add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();

    let before = list_space_members_detailed(&pool, a, &space).await.unwrap();
    assert!(before["lead_member_id"].is_null() || before.get("lead_member_id").is_none());
    assert!(before["lead_nickname"].is_null() || before.get("lead_nickname").is_none());
    for row in before["members"].as_array().unwrap() {
        assert_eq!(row["is_lead"], false);
    }

    set_space_lead(&pool, &space, Some(&in_space.member_id))
        .await
        .unwrap();

    let members_view = list_space_members_detailed(&pool, a, &space).await.unwrap();
    assert_eq!(members_view["lead_member_id"], in_space.member_id);
    assert_eq!(members_view["lead_nickname"], "小B");
    let listed_b = members_view["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["nickname"] == "小B")
        .expect("小B in roster");
    assert_eq!(listed_b["is_lead"], true);
    let listed_a = members_view["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["nickname"] == "小A")
        .expect("小A in roster");
    assert_eq!(listed_a["is_lead"], false);

    let spaces_view = list_collaboration_spaces_for_caller(&pool, a)
        .await
        .unwrap();
    let space_item = spaces_view["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["space_id"] == space)
        .expect("space in caller list");
    assert_eq!(space_item["lead_member_id"], in_space.member_id);
    assert_eq!(space_item["lead_nickname"], "小B");
    let listed_b = space_item["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["nickname"] == "小B")
        .expect("小B in space overview");
    assert_eq!(listed_b["is_lead"], true);
}

#[tokio::test]
async fn agent_created_space_seats_creator_through_member_identity() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let first = space_of(&pool, a).await;
    // `a` is now bound to `first`; creating a second space must not share
    // the same conversation across both spaces.
    let second = space_of(&pool, a).await;
    let member = identity::member_id_for_conversation(a);
    assert_eq!(resolve_session(&pool, &member, &first).await.unwrap(), a);
    let seat_in_second = resolve_session(&pool, &member, &second).await.unwrap();
    assert_ne!(seat_in_second, a);
    let seated: Vec<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM collaboration_space_members WHERE space_id = ? AND kind = 'agent'",
    )
    .bind(&second)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(seated, vec![seat_in_second.to_string()]);
    let shared: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_space_members WHERE conversation_id = ? AND kind = 'agent'",
    )
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(shared, 1, "creator conversation must sit in one space only");

    // The creator acts in the new space through its per-thread seat.
    add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let posted = post_as(&pool, Some(seat_in_second), &second, "@所有人 大家好", &[]).await;
    assert_eq!(posted.receipts.len(), 1);
    assert!(inputs_of(&pool, seat_in_second).await.is_empty());
    assert!(inputs_of(&pool, a).await.is_empty());
}

#[tokio::test]
async fn member_memory_crosses_groups_but_private_chat_never_reaches_a_group() {
    use crate::member_memory::{self as memory, FactScope, FirstSentencesSummarizer};
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let group1 = space_of(&pool, a).await;
    let group2 = space_of(&pool, a).await;
    add_space_member(&pool, a, &group1, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let b_in_group2 = Uuid::parse_str(
        add_space_member(&pool, a, &group2, b, "小B", Uuid::new_v4())
            .await
            .unwrap()
            .conversation_id
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    let member_b = identity::member_id_for_conversation(b);
    assert_eq!(
        identity::binding_of_conversation(&pool, b_in_group2)
            .await
            .unwrap()
            .unwrap()
            .member_id,
        member_b,
        "one member, two group threads"
    );
    // 小B's private chat with the user.
    let private_conv = Uuid::new_v4();
    create_session(&pool, private_conv, workspace, Some("小B")).await;
    let direct = identity::direct_thread_id(&member_b);
    sqlx::query(
        "INSERT INTO collaboration_threads (id, kind, title, created_at) VALUES (?, 'direct', '', '2026-10-24T00:00:00Z')",
    )
    .bind(&direct)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, joined_at) VALUES (?, ?, ?, '2026-10-24T00:00:00Z')",
    )
    .bind(&direct)
    .bind(&member_b)
    .bind(private_conv.to_string())
    .execute(&pool)
    .await
    .unwrap();

    // Short-term: one line per turn, deterministic, idempotent per turn.
    let turn1 = Uuid::new_v4();
    let reply = "我在群里把登录接口的分页 bug 修好了。还补了两条回归测试。第三句不该出现。";
    let summarizer = FirstSentencesSummarizer;
    assert!(
        memory::record_activity(&pool, b, Some(turn1), reply, &summarizer)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        memory::record_activity(&pool, b, Some(turn1), reply, &summarizer)
            .await
            .unwrap()
            .is_none()
    );
    memory::record_activity(
        &pool,
        private_conv,
        Some(Uuid::new_v4()),
        "私聊里帮用户查了工资单密码。",
        &summarizer,
    )
    .await
    .unwrap();
    // Long-term facts in every scope.
    memory::tool_write(&pool, b, "群1约定：分页参数叫 page_size", None)
        .await
        .unwrap();
    let forced = memory::tool_write(&pool, private_conv, "用户的生日是五月一日", Some("global"))
        .await
        .unwrap();
    assert_eq!(forced.scope, "private", "private chat writes stay private");
    memory::create_fact(
        &pool,
        &member_b,
        "项目统一使用 pnpm 管理依赖",
        &FactScope::Global,
        None,
        "user",
    )
    .await
    .unwrap();

    // Acceptance: asked in group 2 what it did in group 1.
    let context = persona_prompt_text_for_turn(&pool, b_in_group2, Some("你在群1做了什么？"))
        .await
        .unwrap()
        .unwrap();
    assert!(context.contains("[成员记忆]"));
    assert!(
        context.contains("把登录接口的分页 bug 修好了。还补了两条回归测试。"),
        "{context}"
    );
    assert!(!context.contains("第三句"));
    assert!(
        !context.contains("工资单"),
        "private activity leaked: {context}"
    );
    assert!(
        !context.contains("私聊里") && !context.contains("私聊记忆"),
        "not even a placeholder: {context}"
    );
    assert!(!context.contains("生日"), "private fact leaked: {context}");
    assert!(
        !context.contains("page_size"),
        "group-1 thread fact stays in group 1"
    );
    let pnpm = persona_prompt_text_for_turn(&pool, b_in_group2, Some("用 pnpm 还是 npm"))
        .await
        .unwrap()
        .unwrap();
    assert!(
        pnpm.contains("项目统一使用 pnpm"),
        "global fact is retrieved by relevance"
    );
    let in_group1 = persona_prompt_text_for_turn(&pool, b, Some("分页参数 page_size"))
        .await
        .unwrap()
        .unwrap();
    assert!(in_group1.contains("page_size"));
    assert!(!in_group1.contains("工资单") && !in_group1.contains("生日"));
    // Tools are scoped the same way.
    let found = memory::tool_search(&pool, b_in_group2, "工资单 生日", 10)
        .await
        .unwrap();
    assert_eq!(found["facts"].as_array().unwrap().len(), 0);
    assert_eq!(found["activity"].as_array().unwrap().len(), 0);
    // In the private chat itself everything is available.
    let private = persona_prompt_text_for_turn(&pool, private_conv, Some("生日"))
        .await
        .unwrap()
        .unwrap();
    assert!(private.contains("工资单") && private.contains("生日") && private.contains("分页 bug"));
    // Host view lists everything; group view filters.
    assert_eq!(
        memory::list_activity(&pool, &member_b, true, 50)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        memory::list_activity(&pool, &member_b, false, 50)
            .await
            .unwrap()
            .len(),
        1
    );

    // Distillation never promotes private activity out of `private`.
    assert_eq!(
        memory::distill_member_memory(&pool, &EchoDistiller)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        memory::distill_member_memory(&pool, &EchoDistiller)
            .await
            .unwrap(),
        0
    );
    let distilled: Vec<_> = memory::list_facts(&pool, &member_b, None)
        .await
        .unwrap()
        .into_iter()
        .filter(|f| f.origin == "distilled")
        .collect();
    let scope_of = |needle: &str| {
        distilled
            .iter()
            .find(|f| f.content.contains(needle))
            .unwrap()
            .scope
            .clone()
    };
    assert_eq!(scope_of("工资单"), "private");
    assert_eq!(scope_of("分页 bug"), "global");
    // Update / delete are member-scoped.
    let id = forced.id;
    assert!(
        memory::update_fact(&pool, "someone-else", id, Some("x"), None)
            .await
            .is_err()
    );
    let updated = memory::update_fact(&pool, &member_b, id, Some("用户生日：5月1日"), None)
        .await
        .unwrap();
    assert_eq!(updated.scope, "private");
    assert!(
        !memory::delete_fact(&pool, "someone-else", id)
            .await
            .unwrap()
    );
    assert!(memory::delete_fact(&pool, &member_b, id).await.unwrap());
}

#[tokio::test]
async fn member_can_rename_self() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let renamed = set_space_identity(&pool, a, &space, "评审A", Uuid::new_v4())
        .await
        .unwrap();
    assert_eq!(renamed.nickname, "评审A");
}

#[tokio::test]
async fn proposer_nickname_then_rename() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let first = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "旧称呼".to_string(),
            summary: Some("旧称呼".to_string()),
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    set_space_identity(&pool, b, &space, "评审B", Uuid::new_v4())
        .await
        .unwrap();
    let missing = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "找不到".to_string(),
            summary: None,
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, "not_found");
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "新称呼".to_string(),
            summary: None,
            to: vec!["评审B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let old: String =
        sqlx::query_scalar("SELECT envelope_json FROM collaboration_space_messages WHERE id = ?")
            .bind(first.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(old.contains("小B"));
    assert!(!old.contains("评审B"));
}

#[tokio::test]
async fn set_space_identity_replays_and_rejects_non_member_or_conflict() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let other_workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    let foreign = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, outsider, workspace, Some("路人")).await;
    create_session(&pool, foreign, other_workspace, Some("外区")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();

    let rename_op = Uuid::new_v4();
    let first = set_space_identity(&pool, b, &space, "审校B", rename_op)
        .await
        .unwrap();
    assert_eq!(first.nickname, "审校B");

    let replay = set_space_identity(&pool, b, &space, "审校B", rename_op)
        .await
        .unwrap();
    assert_eq!(replay, first);

    let mismatch = set_space_identity(&pool, b, &space, "别的名字", rename_op)
        .await
        .unwrap_err();
    assert_eq!(mismatch.code, "conversation_control_failed");

    let taken = set_space_identity(&pool, b, &space, "小A", Uuid::new_v4())
        .await
        .unwrap_err();
    assert_eq!(taken.code, "nickname_taken");

    let outside = set_space_identity(&pool, outsider, &space, "路人甲", Uuid::new_v4())
        .await
        .unwrap_err();
    assert_eq!(outside.code, "not_found");

    let cross_workspace = set_space_identity(&pool, foreign, &space, "外区甲", Uuid::new_v4())
        .await
        .unwrap_err();
    assert_eq!(cross_workspace.code, "not_found");
}

#[tokio::test]
async fn member_sessions_on_one_repo_default_to_isolated() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let first = space_of(&pool, a).await;
    let second = space_of(&pool, a).await;
    add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let forked = Uuid::parse_str(
        add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap()
            .conversation_id
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    let primary = plan_member_write(&pool, b).await.unwrap().unwrap();
    assert_eq!(primary.access, MemberWriteAccess::WriteIsolated);
    assert!(primary.primary);
    assert_eq!(primary.siblings, vec![forked]);
    assert!(!primary.needs_isolated_workspace());
    let extra = plan_member_write(&pool, forked).await.unwrap().unwrap();
    assert!(!extra.primary);
    assert!(extra.needs_isolated_workspace());
    let isolated = Uuid::new_v4();
    record_member_session_workspace(&pool, &extra, forked, isolated, &json!({}))
        .await
        .unwrap();
    let extra = plan_member_write(&pool, forked).await.unwrap().unwrap();
    assert_eq!(extra.isolated_workspace_id, Some(isolated));
    assert!(!extra.needs_isolated_workspace());
    // Isolated sessions never wait for each other.
    mark_running(&pool, b).await;
    assert!(try_acquire_member_write(&pool, forked).await.unwrap());
    // A conversation without a member identity has no plan.
    let loose = Uuid::new_v4();
    create_session(&pool, loose, workspace, Some("散")).await;
    assert!(plan_member_write(&pool, loose).await.unwrap().is_none());
}

#[tokio::test]
async fn two_sessions_of_one_member_write_one_repo_concurrently_without_conflict() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let first = space_of(&pool, a).await;
    let second = space_of(&pool, a).await;
    add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let forked = Uuid::parse_str(
        add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap()
            .conversation_id
            .as_deref()
            .unwrap(),
    )
    .unwrap();

    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("shared.txt"), "base\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    let provisioner = GitWorktreeProvisioner {
        repo: repo.clone(),
        dirs: Default::default(),
        calls: Default::default(),
    };

    // Both sessions dispatch a turn at the same time.
    let (primary_ws, forked_ws) = tokio::join!(
        execution_workspace_id(&pool, b, workspace, &provisioner),
        execution_workspace_id(&pool, forked, workspace, &provisioner),
    );
    let (primary_ws, forked_ws) = (primary_ws.unwrap(), forked_ws.unwrap());
    assert_eq!(primary_ws, workspace, "primary keeps the native checkout");
    assert_eq!(forked_ws, member_worktree_workspace_id(forked));
    let dir_of = |id: Uuid| {
        if id == workspace {
            repo.clone()
        } else {
            provisioner.dirs.lock().unwrap()[&id].clone()
        }
    };
    let (primary_dir, forked_dir) = (dir_of(primary_ws), dir_of(forked_ws));
    assert_ne!(primary_dir, forked_dir);

    // Concurrent writes to the same file in the same repo.
    let writes = [
        (primary_dir.clone(), "from primary\n"),
        (forked_dir.clone(), "from fork\n"),
    ]
    .map(|(dir, text)| {
        std::thread::spawn(move || {
            std::fs::write(dir.join("shared.txt"), text).unwrap();
            git(&dir, &["commit", "-qam", text.trim()]);
        })
    });
    for write in writes {
        write.join().unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(primary_dir.join("shared.txt")).unwrap(),
        "from primary\n"
    );
    assert_eq!(
        std::fs::read_to_string(forked_dir.join("shared.txt")).unwrap(),
        "from fork\n"
    );
    assert!(git(&repo, &["status", "--porcelain"]).trim().is_empty());
    assert!(
        git(&forked_dir, &["status", "--porcelain"])
            .trim()
            .is_empty()
    );

    // Later turns reuse the recorded worktree; the session row is untouched.
    let again = execution_workspace_id(&pool, forked, workspace, &provisioner)
        .await
        .unwrap();
    assert_eq!(again, forked_ws);
    assert_eq!(
        provisioner.calls.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let plan = plan_member_write(&pool, forked).await.unwrap().unwrap();
    assert_eq!(
        plan.workspace_id, workspace,
        "collaboration still sees the session workspace"
    );
    assert_eq!(plan.isolated_workspace_id, Some(forked_ws));
}

#[tokio::test]
async fn write_serialized_member_sessions_take_turns() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let first = space_of(&pool, a).await;
    let second = space_of(&pool, a).await;
    add_space_member(&pool, a, &first, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let forked = Uuid::parse_str(
        add_space_member(&pool, a, &second, b, "小B", Uuid::new_v4())
            .await
            .unwrap()
            .conversation_id
            .as_deref()
            .unwrap(),
    )
    .unwrap();
    let member = identity::member_id_for_conversation(b);
    set_member_write_access(&pool, &member, MemberWriteAccess::WriteSerialized)
        .await
        .unwrap();
    assert!(
        set_member_write_access(&pool, "ghost", MemberWriteAccess::WriteSerialized)
            .await
            .is_err()
    );
    assert!(
        !plan_member_write(&pool, forked)
            .await
            .unwrap()
            .unwrap()
            .needs_isolated_workspace()
    );

    // b's first-space session takes the lease and is busy.
    assert!(try_acquire_member_write(&pool, b).await.unwrap());
    let turn = mark_running(&pool, b).await;
    // A delivery to the same member's other session waits.
    let member_a = identity::member_id_for_conversation(a);
    let a_in_second = resolve_session(&pool, &member_a, &second).await.unwrap();
    let posted = post_as(&pool, Some(a_in_second), &second, "@小B 第二空间的活", &[]).await;
    let deferred = posted
        .receipts
        .iter()
        .find(|r| r.conversation_id == forked)
        .unwrap();
    assert_eq!(
        deferred.error_code.as_deref(),
        Some("write_serialized_busy")
    );
    assert!(inputs_of(&pool, forked).await.is_empty());

    // b finishes; the sweeper retry delivers the deferred message.
    sqlx::query("UPDATE sessions SET active_turn_id = NULL WHERE id = ?")
        .bind(b)
        .execute(&pool)
        .await
        .unwrap();
    let _ = turn;
    assert_eq!(
        redeliver_deferred(&pool, &DeliveryContext::default())
            .await
            .unwrap(),
        1
    );
    assert_eq!(inputs_of(&pool, forked).await.len(), 1);
    assert_eq!(
        redeliver_deferred(&pool, &DeliveryContext::default())
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn direct_chat_identity_context_and_defensive_list_messages() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "私聊助手".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: Some("负责协助用户排查问题".to_string()),
            mode_id: None,
            config_values: Some(json!({ "avatar": "bot-1", "color": "#ff5500" })),
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let dm_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let identity_mid = identity::member_id_for_conversation(dm_conv);

    // Verify avatar and color were written to collaboration_members
    let (avatar, color): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT avatar, color FROM collaboration_members WHERE id = ?")
            .bind(&identity_mid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(avatar.as_deref(), Some("bot-1"));
    assert_eq!(color.as_deref(), Some("#ff5500"));

    // Direct chat context injects [协作空间私聊身份] and uses implicit speak
    let dm_context = persona_prompt_text(&pool, dm_conv).await.unwrap().unwrap();
    assert!(dm_context.contains("[协作空间私聊身份]"), "{dm_context}");
    assert!(dm_context.contains("私聊助手"), "{dm_context}");
    assert!(dm_context.contains("一对一私聊"), "{dm_context}");
    assert!(dm_context.contains("post_space_message"), "{dm_context}");
    assert!(dm_context.contains("ask_user_question"), "{dm_context}");
    assert!(!dm_context.contains("以 `@User ` 开头"), "{dm_context}");
    assert!(
        dm_context.contains(&identity::direct_thread_id(&identity_mid)),
        "{dm_context}"
    );
    assert!(dm_context.contains("memory_search"), "{dm_context}");
    assert!(
        !dm_context.contains("所属协作空间：未定空间"),
        "{dm_context}"
    );
    assert!(!dm_context.contains("[协作空间成员身份]"), "{dm_context}");

    let prefixed = prefix_persona_prompt(&dm_context, "你好");
    assert!(!prefixed.starts_with("人设\n[协作空间私聊身份]"));

    // Defensive check: calling list_space_messages on unassigned or direct returns friendly error
    let unassigned = unassigned_space_id(workspace);
    let direct_tid = identity::direct_thread_id(&identity_mid);
    for sid in [&unassigned, &direct_tid] {
        let err = list_space_messages(&pool, sid, None, None, MessageAudience::Agent)
            .await
            .unwrap_err();
        assert_eq!(err.code, "invalid_space_for_direct_chat");
        assert!(err.message.contains("一对一私聊"), "{}", err.message);
        assert!(
            err.message.contains("read_space_messages") || err.message.contains("普通文本"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("以 `@User ` 开头"), "{}", err.message);
    }

    // User adds a note to the direct assistant's collection (direct:<member_id>)
    let user_item = add_to_space_collection(
        &pool,
        AddSpaceCollectionItem {
            caller_id: None,
            space_id: direct_tid.clone(),
            content: Some("# 个人助手资料\n请遵循规范 A".to_string()),
            source_path: None,
            base64_data: None,
            file_name: Some("guide.md".to_string()),
            note: Some("个人收藏规范".to_string()),
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    // Direct assistant can list and read its own direct:<member_id> collection via MCP (MessageAudience::Agent)
    let listed_by_dm = list_space_collection(
        &pool,
        &direct_tid,
        Some(dm_conv),
        None,
        MessageAudience::Agent,
    )
    .await
    .unwrap();
    assert_eq!(listed_by_dm.len(), 1);
    assert_eq!(listed_by_dm[0].id, user_item.id);

    let read_by_dm = read_space_collection_item(
        &pool,
        &direct_tid,
        &user_item.id,
        Some(dm_conv),
        MessageAudience::Agent,
    )
    .await
    .unwrap();
    assert_eq!(read_by_dm.id, user_item.id);
    assert_eq!(read_by_dm.read_receipts.len(), 1);
    assert_eq!(read_by_dm.read_receipts[0].reader_nickname, "私聊助手");

    // Another unrelated agent cannot read this private assistant's collection
    let outsider = Uuid::new_v4();
    create_session(&pool, outsider, workspace, Some("路人")).await;
    let denied = list_space_collection(
        &pool,
        &direct_tid,
        Some(outsider),
        None,
        MessageAudience::Agent,
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, "not_a_member");

    let _ = std::fs::remove_file(&user_item.file_path);
}

#[tokio::test]
async fn rename_syncs_member_name_and_direct_thread_title() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "旧名字".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let dm_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let identity_mid = identity::member_id_for_conversation(dm_conv);
    let direct_tid = identity::direct_thread_id(&identity_mid);
    let unassigned = unassigned_space_id(workspace);

    // Rename via direct:<member_id>
    set_space_identity(&pool, dm_conv, &direct_tid, "新名字", Uuid::new_v4())
        .await
        .unwrap();

    let member_name: String =
        sqlx::query_scalar("SELECT name FROM collaboration_members WHERE id = ?")
            .bind(&identity_mid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(member_name, "新名字");

    let thread_title: String =
        sqlx::query_scalar("SELECT title FROM collaboration_threads WHERE id = ?")
            .bind(&direct_tid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(thread_title, "新名字");

    let unassigned_nick: String = sqlx::query_scalar(
        "SELECT nickname FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&unassigned)
    .bind(dm_conv.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unassigned_nick, "新名字");
}

#[tokio::test]
async fn move_and_batch_delete_clean_up_group_and_direct_lifecycle() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    let created_a = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "助手A".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let dm_a = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
    let mid_a = identity::member_id_for_conversation(dm_a);

    let created_b = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "助手B".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let dm_b = Uuid::parse_str(created_b.conversation_id.as_deref().unwrap()).unwrap();
    let _mid_b = identity::member_id_for_conversation(dm_b);

    let space = create_workspace_space(&pool, workspace, "项目群", Uuid::new_v4())
        .await
        .unwrap()
        .space_id;
    let seat_a = host_add_space_member(&pool, &space, dm_a, "助手A", Uuid::new_v4())
        .await
        .unwrap();
    let group_conv_a = Uuid::parse_str(seat_a.conversation_id.as_deref().unwrap()).unwrap();
    assert_ne!(group_conv_a, dm_a);

    let seat_b = host_add_space_member(&pool, &space, dm_b, "助手B", Uuid::new_v4())
        .await
        .unwrap();
    let group_conv_b = Uuid::parse_str(seat_b.conversation_id.as_deref().unwrap()).unwrap();
    assert_ne!(group_conv_b, dm_b);

    // 1. Remove member A from group -> move to unassigned:<workspace>
    let unassigned = unassigned_space_id(workspace);
    host_move_space_member(
        &pool,
        &space,
        &unassigned,
        group_conv_a,
        Some("助手A"),
        Uuid::new_v4(),
    )
    .await
    .unwrap();

    // Group thread should only have member B left
    let group_tm_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
    )
    .bind(&space)
    .bind(&mid_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        group_tm_count, 0,
        "removed member must be unbound from group thread"
    );

    // Unassigned should not have duplicate seats for A
    let unassigned_seats_a: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_space_members WHERE space_id = ? AND nickname LIKE '助手A%'",
    )
    .bind(&unassigned)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        unassigned_seats_a, 1,
        "must not duplicate seat in unassigned"
    );

    // 2. Delete group space -> cleans up threads, thread_members, cards, handoffs, and does not duplicate B in unassigned
    let del_space = host_batch_delete_space_items(
        &pool,
        workspace,
        vec![space.clone()],
        Vec::new(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert_eq!(del_space.deleted_space_ids, vec![space.clone()]);
    assert!(del_space.archived_conversation_ids.contains(&group_conv_b));
    assert!(del_space.unassigned_conversation_ids.is_empty());

    let space_thread_exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM collaboration_threads WHERE id = ?")
            .bind(&space)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(space_thread_exists.is_none());

    // 3. Delete direct chat member A -> cleans up direct:<mid_a> and collaboration_members
    host_batch_delete_space_items(
        &pool,
        workspace,
        Vec::new(),
        vec![BatchDeleteMemberTarget {
            space_id: unassigned.clone(),
            conversation_id: dm_a,
        }],
        Uuid::new_v4(),
    )
    .await
    .unwrap();

    let direct_thread_a: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM collaboration_threads WHERE id = ?")
            .bind(identity::direct_thread_id(&mid_a))
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(direct_thread_a.is_none());
    let member_row_a: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM collaboration_members WHERE id = ?")
            .bind(&mid_a)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(member_row_a.is_none());
}

#[tokio::test]
async fn ordinary_session_creates_space_and_adds_member_without_self_contamination() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let orchestrator = Uuid::new_v4();
    let bot = Uuid::new_v4();
    create_session(&pool, orchestrator, workspace, Some("普通主会话")).await;
    create_session(&pool, bot, workspace, Some("评审Bot")).await;

    let created = create_collaboration_space(&pool, orchestrator, "架构评审群", Uuid::new_v4())
        .await
        .unwrap();
    let space_id = created.space_id;

    // 1. Orchestrator must NOT be in collaboration_space_members
    let members = list_space_members(&pool, &space_id, MessageAudience::Agent)
        .await
        .unwrap();
    assert!(
        members
            .iter()
            .all(|m| m.conversation_id.as_deref() != Some(orchestrator.to_string().as_str())),
        "ordinary orchestrator session must not be added to collaboration_space_members"
    );
    assert!(
        identity::binding_of_conversation(&pool, orchestrator)
            .await
            .unwrap()
            .is_none(),
        "ordinary orchestrator session must not have thread member binding"
    );

    // 2. persona_prompt_text_for_turn on orchestrator must NOT contain [协作空间成员身份]
    let prompt = persona_prompt_text_for_turn(&pool, orchestrator, Some("你好"))
        .await
        .unwrap();
    assert!(
        prompt
            .as_deref()
            .is_none_or(|p| !p.contains("[协作空间成员身份]") && !p.contains("[协作空间私聊身份]")),
        "ordinary session prompt was contaminated: {prompt:?}"
    );

    // 3. Orchestrator in same workspace can call add_space_member to add another Bot session
    let added = add_space_member(
        &pool,
        orchestrator,
        &space_id,
        bot,
        "评审Bot",
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert_eq!(added.nickname, "评审Bot");
    assert_eq!(added.conversation_id, Some(bot.to_string()));
}

#[tokio::test]
async fn ordinary_session_memory_write_returns_not_a_member_without_creating_member() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let ordinary = Uuid::new_v4();
    create_session(&pool, ordinary, workspace, Some("普通会话")).await;

    let err = crate::member_memory::tool_write(&pool, ordinary, "记住一条普通会话偏好", None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "not_a_member");

    let search_err = crate::member_memory::tool_search(&pool, ordinary, "偏好", 5)
        .await
        .unwrap_err();
    assert_eq!(search_err.code, "not_a_member");

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_members")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "ordinary session must not create collaboration_members row"
    );
}

#[tokio::test]
async fn supplementary_fixes_role_orphan_collection_cleanup_and_sidebar_rename() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
    .bind(workspace)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();

    let role = create_role(
        &pool,
        SaveRole {
            id: None,
            name: "架构师角色".to_string(),
            team_id: None,
            summary: "架构评审".to_string(),
            persona_prompt: "负责系统架构设计".to_string(),
            agent_id: "codex".to_string(),
            mode_id: Some("plan".to_string()),
            config_values: json!({ "model": "gpt-5" }),
        },
    )
    .await
    .unwrap();

    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "初始助手".to_string(),
            role_id: Some(role.id.clone()),
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let dm_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member_id = identity::member_id_for_conversation(dm_conv);
    let direct_tid = identity::direct_thread_id(&member_id);

    // 1. sidebar::update_member_profile syncs name, direct thread title, and space member nickname
    crate::collaboration_sidebar::update_member_profile(
        &pool,
        &member_id,
        Some("改名后助手"),
        Some("bot-2"),
        Some("#00aa88"),
    )
    .await
    .unwrap();

    let (m_name, t_title, sm_nick): (String, String, String) = sqlx::query_as(
        r#"SELECT m.name, t.title, sm.nickname
           FROM collaboration_members m
           JOIN collaboration_threads t ON t.id = ?
           JOIN collaboration_space_members sm ON sm.conversation_id = ?
           WHERE m.id = ?"#,
    )
    .bind(&direct_tid)
    .bind(dm_conv.to_string())
    .bind(&member_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(m_name, "改名后助手");
    assert_eq!(t_title, "改名后助手");
    assert_eq!(sm_nick, "改名后助手");

    // 2. delete_role clears collaboration_members.role_id
    delete_role(&pool, &role.id).await.unwrap();
    let remaining_role_id: Option<String> =
        sqlx::query_scalar("SELECT role_id FROM collaboration_members WHERE id = ?")
            .bind(&member_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        remaining_role_id.is_none(),
        "delete_role must clear collaboration_members.role_id"
    );

    // 3. Collection files & DB records are cleaned up when deleting group space and direct assistant
    let space = create_workspace_space(&pool, workspace, "测试收藏清理群", Uuid::new_v4())
        .await
        .unwrap()
        .space_id;
    let group_item = add_to_space_collection(
        &pool,
        AddSpaceCollectionItem {
            caller_id: None,
            space_id: space.clone(),
            content: Some("group collection file".to_string()),
            source_path: None,
            base64_data: None,
            file_name: Some("group-note.md".to_string()),
            note: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let group_file_path = std::path::PathBuf::from(&group_item.file_path);
    assert!(group_file_path.exists());

    let dm_item = add_to_space_collection(
        &pool,
        AddSpaceCollectionItem {
            caller_id: None,
            space_id: direct_tid.clone(),
            content: Some("direct collection file".to_string()),
            source_path: None,
            base64_data: None,
            file_name: Some("dm-note.md".to_string()),
            note: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let dm_file_path = std::path::PathBuf::from(&dm_item.file_path);
    assert!(dm_file_path.exists());

    // Delete group space -> cleans up group collection DB rows and physical file
    host_batch_delete_space_items(
        &pool,
        workspace,
        vec![space.clone()],
        Vec::new(),
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(
        !group_file_path.exists(),
        "group collection physical file must be deleted"
    );
    let group_col_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_space_collection_items WHERE space_id = ?",
    )
    .bind(&space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(group_col_count, 0);

    // Delete direct assistant -> cleans up direct:<member_id> collection DB rows and physical file
    let unassigned = unassigned_space_id(workspace);
    host_batch_delete_space_items(
        &pool,
        workspace,
        Vec::new(),
        vec![BatchDeleteMemberTarget {
            space_id: unassigned,
            conversation_id: dm_conv,
        }],
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert!(
        !dm_file_path.exists(),
        "direct chat collection physical file must be deleted"
    );
    let dm_col_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_space_collection_items WHERE space_id = ?",
    )
    .bind(&direct_tid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dm_col_count, 0);
}

#[tokio::test]
async fn conversation_is_space_session_for_hidden_member_seats() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
        .bind(workspace)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    let ordinary = Uuid::new_v4();
    create_session(&pool, ordinary, workspace, Some("ordinary")).await;
    assert!(
        !conversation_is_space_session(&pool, ordinary)
            .await
            .unwrap()
    );

    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "小A".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let hidden = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    assert!(conversation_is_space_session(&pool, hidden).await.unwrap());
}
