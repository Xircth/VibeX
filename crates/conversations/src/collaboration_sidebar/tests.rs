use std::str::FromStr;

use agents::{ConversationEvent, ConversationInputBlock};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use super::*;

async fn setup_test_pool() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    pool
}

async fn seed_dm_session(
    pool: &SqlitePool,
    workspace: Uuid,
    conversation: Uuid,
    name: &str,
) -> String {
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
        .bind(workspace)
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sessions (id, workspace_id, name) VALUES (?, ?, ?)")
        .bind(conversation)
        .bind(workspace)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .unwrap();
    let member_id = identity::member_id_for_conversation(conversation);
    let thread_id = identity::direct_thread_id(&member_id);
    sqlx::query(
        "INSERT INTO collaboration_members (id, name, created_at) VALUES (?, ?, '2026-10-24T00:00:00Z')",
    )
    .bind(&member_id)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collaboration_threads (id, kind, workspace_id, title, created_at) VALUES (?, 'direct', ?, ?, '2026-10-24T00:00:00Z')",
    )
    .bind(&thread_id)
    .bind(workspace.to_string())
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, status, joined_at) VALUES (?, ?, ?, 'active', '2026-10-24T00:00:00Z')",
    )
    .bind(&thread_id)
    .bind(&member_id)
    .bind(conversation.to_string())
    .execute(pool)
    .await
    .unwrap();
    thread_id
}

#[tokio::test]
async fn long_streaming_dm_preserves_all_turns_and_sidebar_state() {
    let pool = setup_test_pool().await;
    let workspace = Uuid::new_v4();
    let conversation = Uuid::new_v4();
    let thread_id = seed_dm_session(&pool, workspace, conversation, "Bot").await;

    // 10 turns where each reply has 500 streaming deltas = 5,010 events (> 4,000 old scan cap).
    let mut seq = 0_i64;
    let mut tx = pool.begin().await.unwrap();
    for turn in 1..=10 {
        seq += 1;
        let user_json = serde_json::to_string(&ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: format!("user turn {turn}"),
            }],
            workflow_refs: Vec::new(),
        })
        .unwrap();
        sqlx::query(
            r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, ?, 'user', 'user_turn_created', ?, ?)"#,
        )
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(seq)
        .bind(user_json)
        .bind(format!("2026-10-24T00:{turn:02}:00.000Z"))
        .execute(&mut *tx)
        .await
        .unwrap();

        for chunk in 1..=500 {
            seq += 1;
            let delta_json = serde_json::to_string(&ConversationEvent::AssistantTextDelta {
                text: if chunk == 1 {
                    format!("reply {turn}: ")
                } else {
                    "x".to_string()
                },
                message_id: None,
            })
            .unwrap();
            sqlx::query(
                r#"INSERT INTO conversation_events
                   (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
                   VALUES (?, ?, ?, 'acp', 'assistant_text_delta', ?, ?)"#,
            )
            .bind(Uuid::new_v4())
            .bind(conversation)
            .bind(seq)
            .bind(delta_json)
            .bind(format!("2026-10-24T00:{turn:02}:30.000Z"))
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();

    let history = list_dm_messages(&pool, conversation, None, Some(200))
        .await
        .unwrap();
    assert_eq!(
        history.len(),
        20,
        "all 10 user + 10 agent messages must be preserved"
    );
    assert_eq!(history[0].text, "user turn 1");
    assert!(history[1].text.starts_with("reply 1: "));
    assert_eq!(history[18].text, "user turn 10");
    assert!(history[19].text.starts_with("reply 10: "));

    // First sidebar load baselines read mark at tail (0 unread) and extracts full last message preview.
    let sidebar = list_sidebar(&pool, workspace).await.unwrap();
    assert_eq!(sidebar.len(), 1);
    assert_eq!(sidebar[0].thread_id, thread_id);
    assert_eq!(sidebar[0].unread_count, 0);
    let last = sidebar[0].last_message.as_ref().expect("last message");
    assert_eq!(last.seq, Some(history[19].seq));
    assert!(
        last.preview
            .as_deref()
            .unwrap_or_default()
            .starts_with("reply 10: "),
        "preview must start from the beginning of turn 10's reply: {:?}",
        last.preview
    );

    // Mark unread moves cursor before tail -> 1 unread message.
    mark_thread_unread(&pool, &thread_id).await.unwrap();
    let sidebar = list_sidebar(&pool, workspace).await.unwrap();
    assert_eq!(sidebar[0].unread_count, 1);

    // Mark read clears unread count.
    mark_thread_read(&pool, &thread_id, None).await.unwrap();
    let sidebar = list_sidebar(&pool, workspace).await.unwrap();
    assert_eq!(sidebar[0].unread_count, 0);
}

#[tokio::test]
async fn dm_streaming_draft_streams_live_step_and_continues_after_mid_turn_tool_step() {
    let pool = crate::collaboration::test_support::setup_pool().await;
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created = crate::collaboration::host_create_space_member(
        &pool,
        crate::collaboration::HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Lander".to_string(),
            role_id: None,
            agent_id: Some("codex".to_string()),
            team_id: None,
            persona_prompt: Some("主管 Bot".to_string()),
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let conversation_id = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member_id = identity_member_of_conversation(&pool, &conversation_id.to_string())
        .await
        .unwrap()
        .unwrap();
    let thread_id = format!("direct:{member_id}");

    crate::collaboration::post_direct_message(
        &pool,
        crate::collaboration::PostDirectMessage {
            thread_id: thread_id.clone(),
            content: "创建一个新Bot，名叫Hailer，帮我做邮件管理".to_string(),
            summary: None,
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    // Step 0 streaming before tool call:
    crate::collaboration::reset_space_turn_streaming_step(conversation_id);
    crate::collaboration::append_space_turn_streaming_text(
        conversation_id,
        "我先查看一下 vibex-bot 规范和 manage_bot 工具参数",
        false,
    );
    crate::collaboration::append_space_turn_streaming_text(
        conversation_id,
        "，接着为你创建专门负责邮件管理的 Bot「Hailer」。",
        false,
    );

    let messages_step0 = list_dm_messages(&pool, conversation_id, None, Some(50))
        .await
        .unwrap();
    assert_eq!(messages_step0.len(), 2);
    assert_eq!(messages_step0[1].streaming, Some(true));
    assert_eq!(
        messages_step0[1].text,
        "我先查看一下 vibex-bot 规范和 manage_bot 工具参数，接着为你创建专门负责邮件管理的 Bot「Hailer」。"
    );
    assert!(messages_step0[1].seq > messages_step0[0].seq);

    // ToolCallUpsert bubbles mid-turn step 0 and advances streaming step to step 1:
    let step0_text = messages_step0[1].text.clone();
    crate::collaboration::advance_space_turn_streaming_step(conversation_id);
    crate::collaboration::on_space_turn_tool_call(
        &pool,
        conversation_id,
        &step0_text,
        &crate::collaboration::DeliveryContext::default(),
    )
    .await
    .unwrap();

    let messages_after_tool = list_dm_messages(&pool, conversation_id, None, Some(50))
        .await
        .unwrap();
    assert_eq!(messages_after_tool.len(), 2);
    assert_eq!(messages_after_tool[1].streaming, None);
    assert_eq!(messages_after_tool[1].text, step0_text);

    // Step 1 streaming after tool call:
    crate::collaboration::append_space_turn_streaming_text(
        conversation_id,
        "已经为你创建好负责邮件管理的 Bot「Hailer」了！",
        false,
    );
    let messages_step1 = list_dm_messages(&pool, conversation_id, None, Some(50))
        .await
        .unwrap();
    assert_eq!(
        messages_step1.len(),
        3,
        "both mid-turn persisted bubble and step 1 streaming draft must be returned"
    );
    assert_eq!(messages_step1[1].streaming, None);
    assert_eq!(messages_step1[1].text, step0_text);
    assert_eq!(messages_step1[2].streaming, Some(true));
    assert_eq!(
        messages_step1[2].text,
        "已经为你创建好负责邮件管理的 Bot「Hailer」了！"
    );
    assert!(messages_step1[2].id.ends_with(":1"));

    crate::collaboration::reset_space_turn_streaming_step(conversation_id);
}

#[tokio::test]
async fn enrich_space_members_batch_resolves_group_seats_and_supervisor_in_batch() {
    let pool = crate::collaboration::test_support::setup_pool().await;
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();

    let space = crate::collaboration::create_workspace_space(
        &pool,
        workspace,
        "Perf Group",
        Uuid::new_v4(),
    )
    .await
    .unwrap();

    let bot_a = crate::collaboration::host_create_space_member(
        &pool,
        crate::collaboration::HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: Some(space.space_id.clone()),
            nickname: "Alpha".to_string(),
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
    let bot_b = crate::collaboration::host_create_space_member(
        &pool,
        crate::collaboration::HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: Some(space.space_id.clone()),
            nickname: "Beta".to_string(),
            role_id: None,
            agent_id: Some("claude_code".to_string()),
            team_id: None,
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    set_workspace_supervisor(&pool, workspace, bot_a.conversation_id.as_deref())
        .await
        .unwrap();

    let raw_members = crate::collaboration::list_space_members(
        &pool,
        &space.space_id,
        crate::collaboration::MessageAudience::User,
    )
    .await
    .unwrap();
    let enriched_first = enrich_space_members_batch(&pool, &space.space_id, raw_members)
        .await
        .unwrap();

    let raw_members_again = crate::collaboration::list_space_members(
        &pool,
        &space.space_id,
        crate::collaboration::MessageAudience::User,
    )
    .await
    .unwrap();
    let enriched_second = enrich_space_members_batch(&pool, &space.space_id, raw_members_again)
        .await
        .unwrap();
    assert_eq!(enriched_first, enriched_second);

    let alpha = enriched_second
        .iter()
        .find(|v| v.get("nickname").and_then(|s| s.as_str()) == Some("Alpha"))
        .expect("Alpha member");
    let beta = enriched_second
        .iter()
        .find(|v| v.get("nickname").and_then(|s| s.as_str()) == Some("Beta"))
        .expect("Beta member");
    assert!(
        alpha
            .get("identity_member_id")
            .and_then(|v| v.as_str())
            .is_some()
    );
    assert_eq!(
        alpha.get("is_supervisor").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert!(
        beta.get("identity_member_id")
            .and_then(|v| v.as_str())
            .is_some()
    );
    assert_eq!(
        beta.get("is_supervisor").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_ne!(
        alpha.get("identity_member_id"),
        beta.get("identity_member_id")
    );
    let _ = bot_b;
}

#[tokio::test]
async fn dm_post_cutover_tail_window_truncates_and_merges_with_pre_cutover() {
    let pool = setup_test_pool().await;
    let workspace = Uuid::new_v4();
    let conversation = Uuid::new_v4();
    let thread_id = seed_dm_session(&pool, workspace, conversation, "Bot").await;

    let mut seq = 0_i64;
    for turn in 1..=3 {
        seq += 1;
        let user_json = serde_json::to_string(&ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: format!("pre user {turn}"),
            }],
            workflow_refs: Vec::new(),
        })
        .unwrap();
        sqlx::query(
            r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, ?, 'user', 'user_turn_created', ?, ?)"#,
        )
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(seq)
        .bind(user_json)
        .bind(format!("2026-10-24T00:0{turn}:00.000Z"))
        .execute(&pool)
        .await
        .unwrap();

        seq += 1;
        let delta_json = serde_json::to_string(&ConversationEvent::AssistantTextDelta {
            text: format!("pre reply {turn}"),
            message_id: None,
        })
        .unwrap();
        sqlx::query(
            r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, ?, 'acp', 'assistant_text_delta', ?, ?)"#,
        )
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(seq)
        .bind(delta_json)
        .bind(format!("2026-10-24T00:0{turn}:30.000Z"))
        .execute(&pool)
        .await
        .unwrap();
    }

    // Cutover at seq = 6, then insert 4 post-cutover space messages (seq 7..=10).
    sqlx::query(
        "UPDATE collaboration_threads SET space_cutover_seq = ?, space_cutover_at = '2026-10-24T00:04:00.000Z' WHERE id = ?",
    )
    .bind(seq)
    .bind(&thread_id)
    .execute(&pool)
    .await
    .unwrap();

    for idx in 1..=4 {
        let post_seq = seq + idx;
        let origin = if idx % 2 == 1 { "user" } else { "agent" };
        let msg_id = Uuid::new_v4().to_string();
        let envelope = json!({
            "content": format!("post msg {idx}"),
            "sender": if origin == "user" { "Person" } else { "Bot" },
        });
        sqlx::query(
            r#"INSERT INTO collaboration_space_messages
               (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0)"#,
        )
        .bind(&msg_id)
        .bind(&thread_id)
        .bind(post_seq)
        .bind(envelope.to_string())
        .bind(format!("2026-10-24T00:1{idx}:00.000Z"))
        .bind(origin)
        .bind(&msg_id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Case 1: limit = 3 (smaller than post-cutover count 4) -> only tail 3 post-cutover messages returned.
    let tail_three = list_dm_messages(&pool, conversation, None, Some(3))
        .await
        .unwrap();
    assert_eq!(tail_three.len(), 3);
    assert_eq!(tail_three[0].text, "post msg 2");
    assert_eq!(tail_three[1].text, "post msg 3");
    assert_eq!(tail_three[2].text, "post msg 4");

    // Case 2: limit = 6 (spans 2 pre-cutover + 4 post-cutover messages).
    let tail_six = list_dm_messages(&pool, conversation, None, Some(6))
        .await
        .unwrap();
    assert_eq!(tail_six.len(), 6);
    assert_eq!(tail_six[0].text, "pre user 3");
    assert_eq!(tail_six[1].text, "pre reply 3");
    assert_eq!(tail_six[2].text, "post msg 1");
    assert_eq!(tail_six[5].text, "post msg 4");
}

#[tokio::test]
async fn list_sidebar_op_returns_supervisor_member_id_and_promotes_space_member() {
    let pool = setup_test_pool().await;
    let workspace = Uuid::new_v4();
    let space_id = Uuid::new_v4().to_string();
    let seat_member_id = Uuid::new_v4().to_string();
    let conversation = Uuid::new_v4();

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
    sqlx::query(
        "INSERT INTO collaboration_spaces (id, workspace_id, name, created_at) VALUES (?, ?, 'Team', '2026-10-24T00:00:00.000Z')",
    )
    .bind(&space_id)
    .bind(workspace.to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO collaboration_space_members
           (space_id, member_id, conversation_id, nickname, kind, visible_to_agents)
           VALUES (?, ?, ?, 'LeadBot', 'agent', 1)"#,
    )
    .bind(&space_id)
    .bind(&seat_member_id)
    .bind(conversation.to_string())
    .execute(&pool)
    .await
    .unwrap();

    let supervisor_id = set_workspace_supervisor(&pool, workspace, Some(&seat_member_id))
        .await
        .unwrap()
        .expect("supervisor_member_id returned");

    let (sidebar_res, _) = execute_sidebar_op(
        &pool,
        "thread.listSidebar",
        &json!({ "workspaceId": workspace.to_string() }),
    )
    .await
    .unwrap();

    assert_eq!(
        sidebar_res
            .get("supervisor_member_id")
            .and_then(|v| v.as_str()),
        Some(supervisor_id.as_str())
    );
    assert_eq!(
        sidebar_res
            .get("supervisorMemberId")
            .and_then(|v| v.as_str()),
        Some(supervisor_id.as_str())
    );
}
