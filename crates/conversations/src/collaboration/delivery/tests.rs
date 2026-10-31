use db::models::collaboration_identity as identity;

use super::*;
use crate::collaboration::test_support::*;

#[tokio::test]
async fn workspace_policy_allows_sibling() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let sibling = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    create_session(&pool, sibling, workspace, None).await;
    let receipt = send_session_input(
        &pool,
        send_for(caller, sibling, CompanionWritePolicy::SameWorkspace),
    )
    .await
    .unwrap();
    assert_eq!(receipt.delivered, "queued");
    assert_eq!(input_count(&pool, sibling).await, 1);
}

struct RecordingDispatcher {
    turn_id: Uuid,
}

#[async_trait]
impl IdleTurnDispatcher for RecordingDispatcher {
    async fn start_if_idle(&self, _conversation_id: Uuid) -> Result<Option<Uuid>, String> {
        Ok(Some(self.turn_id))
    }
}

#[tokio::test]
async fn idle_send_dispatches_only_through_the_dispatcher() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    let turn_id = Uuid::new_v4();
    let receipt = send_session_input_with(
        &pool,
        send_for(caller, caller, CompanionWritePolicy::SameWorkspace),
        &DeliveryContext {
            publisher: None,
            dispatcher: Some(Arc::new(RecordingDispatcher { turn_id })),
            interruptor: None,
            space_changed: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(receipt.delivered, "dispatched");
    assert_eq!(receipt.turn_id, Some(turn_id));
    assert!(!receipt.idempotent_replay);
}

#[tokio::test]
async fn same_operation_with_different_text_conflicts() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
    send_session_input(&pool, request.clone()).await.unwrap();
    request.text = "different".to_string();
    let error = send_session_input(&pool, request).await.unwrap_err();
    assert_eq!(error.code, "conversation_control_failed");
    assert!(error.message.contains("different content"));
    assert_eq!(input_count(&pool, caller).await, 1);
}

#[tokio::test]
async fn digest_fold_records_the_new_operation() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    let first = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
    let first_receipt = send_session_input(&pool, first.clone()).await.unwrap();
    let mut second = first.clone();
    second.operation_id = Uuid::new_v4();
    let replay = send_session_input(&pool, second.clone()).await.unwrap();
    assert!(replay.idempotent_replay);
    assert_eq!(replay.input_id, first_receipt.input_id);
    assert_eq!(input_count(&pool, caller).await, 1);
    let aliases: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_send_claim WHERE conversation_id = ? AND counts = 0",
    )
    .bind(caller.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(aliases, 1);
    let stored: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_send_claim WHERE operation_id = ?")
            .bind(second.operation_id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 1);
}

#[tokio::test]
async fn hourly_cap_counts_only_new_submits() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    for index in 0..60 {
        sqlx::query(
            r#"INSERT INTO collaboration_send_claim
               (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
                counts, created_at)
               VALUES (?, ?, ?, '{}', '{}', 1, ?)"#,
        )
        .bind(caller.to_string())
        .bind(format!("op-{index}"))
        .bind(format!("digest-{index}"))
        .bind(now_stamp())
        .execute(&pool)
        .await
        .unwrap();
    }
    let error = send_session_input(
        &pool,
        send_for(caller, caller, CompanionWritePolicy::SameWorkspace),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "limit_exceeded");
    assert_eq!(input_count(&pool, caller).await, 0);
}

#[tokio::test]
async fn ancestor_policy_rejects_sibling() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let sibling = Uuid::new_v4();
    create_session(&pool, caller, workspace, None).await;
    create_session(&pool, sibling, workspace, None).await;
    let error = send_session_input(
        &pool,
        send_for(caller, sibling, CompanionWritePolicy::AncestorTree),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "out_of_scope");
    assert_eq!(input_count(&pool, sibling).await, 0);
}

#[tokio::test]
async fn cross_workspace_is_not_found() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    let target = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    create_session(&pool, target, Uuid::new_v4(), Some("SECRET_TITLE")).await;
    let error = send_session_input(
        &pool,
        send_for(caller, target, CompanionWritePolicy::SameWorkspace),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "not_found");
    assert!(!error.message.contains("SECRET_TITLE"));
    assert!(!error.to_json().to_string().contains("SECRET_TITLE"));
}

#[tokio::test]
async fn self_submit_queues_behind_inflight() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    mark_running(&pool, caller).await;
    let receipt = send_session_input(
        &pool,
        send_for(caller, caller, CompanionWritePolicy::AncestorTree),
    )
    .await
    .unwrap();
    assert_eq!(receipt.delivered, "queued");
    let status: String =
        sqlx::query_scalar("SELECT status FROM conversation_turns WHERE conversation_id = ?")
            .bind(caller)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "running");
    assert_eq!(input_count(&pool, caller).await, 1);
}

#[tokio::test]
async fn steer_unsupported_does_not_queue() {
    let pool = setup_pool().await;
    let caller = Uuid::new_v4();
    create_session(&pool, caller, Uuid::new_v4(), None).await;
    let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
    request.steer = true;
    request.steer_supported = false;
    request.expected_turn_id = Some(Uuid::new_v4());
    let error = send_session_input(&pool, request).await.unwrap_err();
    assert_eq!(error.code, "steer_unsupported");
    assert_eq!(input_count(&pool, caller).await, 0);
}

#[tokio::test]
async fn space_mention_submits_same_text_to_each() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space,
            content: "请评审当前 diff。关注 auth.ts 的错误处理。".to_string(),
            summary: Some("请评审当前 diff".to_string()),
            to: vec!["小B".to_string(), "小C".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    assert_eq!(posted.receipts.len(), 2);
    let initial_texts: Vec<String> = sqlx::query_scalar(
        "SELECT payload_json FROM conversation_inputs WHERE conversation_id IN (?, ?)",
    )
    .bind(b)
    .bind(c)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        initial_texts.len(),
        1,
        "a two-target group post opens a sequential round and wakes only the current ordinal"
    );
    let woken = posted
        .receipts
        .iter()
        .find(|receipt| receipt.input_id.is_some())
        .expect("current ordinal is woken");
    mark_processing(&pool, &posted.message_id, woken.conversation_id).await;
    finalize_space_turn_deliveries(
        &pool,
        woken.conversation_id,
        "评审完成。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    let texts: Vec<String> = sqlx::query_scalar(
        "SELECT payload_json FROM conversation_inputs WHERE conversation_id IN (?, ?)",
    )
    .bind(b)
    .bind(c)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(texts.len(), 2);
    let payloads: Vec<Value> = texts
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect();
    for payload in &payloads {
        assert_eq!(
            payload["displayText"].as_str(),
            Some("请评审当前 diff。关注 auth.ts 的错误处理。")
        );
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("请评审当前 diff"));
        assert!(text.contains("auth.ts"));
        assert!(
            text.contains("[Group chat \"评审工作\" · from 小A"),
            "{text}"
        );
        assert!(text.contains("[Space") && text.contains("[PASS]"), "{text}");
    }
    let joined = texts.join("\n");
    assert!(joined.contains("Bot「小B」"), "{joined}");
    assert!(joined.contains("Bot「小C」"), "{joined}");
}

#[tokio::test]
async fn member_post_to_own_direct_thread_lists_in_dm() {
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
            nickname: "Builder".to_string(),
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread = identity::direct_thread_id(&member);
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(conversation),
            space_id: thread,
            content: "@User 你好，我是 Builder 👋 需要我做什么？".to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .expect("post_to_space on the private chat");
    assert!(posted.seq >= 1);
    let messages =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    let greeting = messages
        .iter()
        .find(|message| message.origin == "agent" && message.text.contains("我是 Builder"))
        .expect("private-chat IM must list the post_to_space greeting");
    assert!(greeting.text.contains("需要我做什么"));
}

#[tokio::test]
async fn creating_a_bot_lists_hidden_bootstrap_and_greeting_once() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Builder".to_string(),
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread = identity::direct_thread_id(&member);
    let bootstrap = format!(
        "{}\n你是用户刚创建的助手。立刻 post_to_space 问好。\n{}",
        crate::collaboration_sidebar::PRIVATE_BOOTSTRAP_PREFIX,
        "</vibex-private-bootstrap>"
    );
    let (posted, _, _) = post_direct_message_with(
        &pool,
        PostDirectMessage {
            thread_id: thread.clone(),
            content: bootstrap,
            summary: None,
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    mark_processing(&pool, &posted.message_id, conversation).await;
    let greeting = "你好，我是 Builder 👋 需要我做什么？";
    let now = now_stamp();
    let acp_json = serde_json::to_string(&agents::ConversationEvent::AssistantTextDelta {
        text: greeting.to_string(),
        message_id: Some("acp-greeting".to_string()),
    })
    .unwrap();
    sqlx::query(
            r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM conversation_events WHERE conversation_id = ?), 'acp', 'assistant_text_delta', ?, ?)"#,
        )
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(conversation)
        .bind(acp_json)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(conversation),
            space_id: thread,
            content: greeting.to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    finalize_space_turn_deliveries(&pool, conversation, greeting, &DeliveryContext::default())
        .await
        .unwrap();

    let messages =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    let visible: Vec<&str> = messages
        .iter()
        .map(|message| message.text.as_str())
        .filter(|text| !text.trim().is_empty())
        .collect();
    assert!(
        visible
            .iter()
            .all(|text| !text.contains(crate::collaboration_sidebar::PRIVATE_BOOTSTRAP_PREFIX)),
        "bootstrap prompt must stay off the IM: {visible:?}"
    );
    let greetings: Vec<&str> = visible
        .iter()
        .copied()
        .filter(|text| text.contains("我是 Builder"))
        .collect();
    assert_eq!(
        greetings,
        vec![greeting],
        "first greeting must appear once in the IM: {visible:?}"
    );
}

#[tokio::test]
async fn first_turn_acp_then_space_post_does_not_duplicate_greeting() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Builder".to_string(),
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread = identity::direct_thread_id(&member);
    let greeting = "你好，我是 Builder 👋 需要我做什么？";
    let now = now_stamp();
    let bootstrap = format!(
        "[协作空间消息]\n{}\n你是用户刚创建的助手。立刻 post_to_space 问好。\n{}",
        crate::collaboration_sidebar::PRIVATE_BOOTSTRAP_PREFIX,
        "</vibex-private-bootstrap>"
    );
    let user_json = serde_json::to_string(&agents::ConversationEvent::UserTurnCreated {
        blocks: vec![agents::ConversationInputBlock::Text { text: bootstrap }],
        workflow_refs: Vec::new(),
    })
    .unwrap();
    sqlx::query(
        r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, 1, 'user', 'user_turn_created', ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(user_json)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    let acp_json = serde_json::to_string(&agents::ConversationEvent::AssistantTextDelta {
        text: greeting.to_string(),
        message_id: Some("acp-greeting".to_string()),
    })
    .unwrap();
    sqlx::query(
        r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, 2, 'acp', 'assistant_text_delta', ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(acp_json)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(conversation),
            space_id: thread,
            content: greeting.to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    let messages =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    let visible: Vec<&str> = messages
        .iter()
        .map(|message| message.text.as_str())
        .filter(|text| !text.trim().is_empty())
        .collect();
    assert!(
        visible
            .iter()
            .all(|text| !text.contains(crate::collaboration_sidebar::PRIVATE_BOOTSTRAP_PREFIX)),
        "packed bootstrap prompt must stay off the IM: {visible:?}"
    );
    let greetings: Vec<&str> = visible
        .iter()
        .copied()
        .filter(|text| text.contains("我是 Builder"))
        .collect();
    assert_eq!(
        greetings,
        vec![greeting],
        "ACP greeting then space post must list once: {visible:?}"
    );
}

#[tokio::test]
async fn late_cutover_event_and_space_greeting_lists_once() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Builder".to_string(),
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread = identity::direct_thread_id(&member);
    sqlx::query(
        r#"UPDATE collaboration_threads
               SET space_cutover_seq = NULL, space_cutover_at = NULL
               WHERE id = ?"#,
    )
    .bind(&thread)
    .execute(&pool)
    .await
    .unwrap();
    let greeting = "你好，我是 Builder 👋 需要我做什么？";
    let now = now_stamp();
    let user_json = serde_json::to_string(&agents::ConversationEvent::UserTurnCreated {
        blocks: vec![agents::ConversationInputBlock::Text {
            text: "你好".to_string(),
        }],
        workflow_refs: Vec::new(),
    })
    .unwrap();
    sqlx::query(
        r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, 1, 'user', 'user_turn_created', ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(user_json)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    let acp_json = serde_json::to_string(&agents::ConversationEvent::AssistantTextDelta {
        text: greeting.to_string(),
        message_id: Some("acp-greeting".to_string()),
    })
    .unwrap();
    sqlx::query(
        r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, 2, 'acp', 'assistant_text_delta', ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(acp_json)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(conversation),
            space_id: thread,
            content: greeting.to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    let messages =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    let visible: Vec<&str> = messages
        .iter()
        .map(|message| message.text.as_str())
        .filter(|text| !text.trim().is_empty())
        .collect();
    assert_eq!(
        visible.iter().filter(|text| **text == "你好").count(),
        1,
        "unique pre-cutover user text must stay: {visible:?}"
    );
    let greetings: Vec<&str> = visible
        .iter()
        .copied()
        .filter(|text| text.contains("我是 Builder"))
        .collect();
    assert_eq!(
        greetings,
        vec![greeting],
        "late cutover must not list the greeting twice: {visible:?}"
    );
}

#[tokio::test]
async fn direct_bot_addresses_workspace_peer_keeps_body_on_sender_and_receipt_on_dest() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created_a = host_create_space_member(
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
    let created_b = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "小B".to_string(),
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
    let a_conv = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
    let b_conv = Uuid::parse_str(created_b.conversation_id.as_deref().unwrap()).unwrap();
    let a_member = identity::binding_of_conversation(&pool, a_conv)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let a_thread = identity::direct_thread_id(&a_member);
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a_conv),
            space_id: a_thread,
            content: "@小B 请支援".to_string(),
            summary: None,
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .expect("workspace DM peers can be addressed from a private chat");
    assert!(
        posted
            .receipts
            .iter()
            .any(|receipt| receipt.conversation_id == b_conv),
        "destination DM conversation is woken"
    );

    let origin_dm = crate::collaboration_sidebar::list_dm_messages(&pool, a_conv, None, Some(50))
        .await
        .unwrap();
    let origin = origin_dm
        .iter()
        .find(|message| message.text.contains("请支援"))
        .expect("sender private chat keeps the body");
    assert!(
        origin
            .cross_chat_sent_to
            .as_ref()
            .is_some_and(|value| value.to_string().contains("小B")),
        "sender private chat marks the destination"
    );

    let dest_dm = crate::collaboration_sidebar::list_dm_messages(&pool, b_conv, None, Some(50))
        .await
        .unwrap();
    assert!(
        dest_dm
            .iter()
            .all(|message| !message.text.contains("请支援")),
        "destination private chat hides the foreign body"
    );
    assert!(
        dest_dm.iter().any(|message| {
            message.text.is_empty()
                && message
                    .cross_chat_received_from
                    .as_ref()
                    .is_some_and(|value| value.to_string().contains("小A"))
        }),
        "destination private chat lists an empty receipt from the sender"
    );
}

#[tokio::test]
async fn user_dm_mention_of_workspace_peer_does_not_return_not_found() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created_a = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Faker".to_string(),
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
    let created_b = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Peter".to_string(),
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
    let a_conv = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
    let b_conv = Uuid::parse_str(created_b.conversation_id.as_deref().unwrap()).unwrap();
    let a_member = identity::binding_of_conversation(&pool, a_conv)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let a_thread = identity::direct_thread_id(&a_member);
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: None,
            space_id: a_thread,
            content: "@Peter 给Peter说让它给Liber发个消息".to_string(),
            summary: None,
            to: vec!["Peter".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .expect("user @ in a private chat must resolve the workspace peer");
    assert!(
        posted
            .receipts
            .iter()
            .any(|receipt| receipt.conversation_id == b_conv),
        "Peter's private chat is woken"
    );
    assert_eq!(posted.receipts.len(), 1);
}

#[tokio::test]
async fn dm_caller_cannot_replace_space_id_with_shared_group() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created_a = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Faker".to_string(),
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
    let created_b = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Peter".to_string(),
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
    let a_conv = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
    let b_conv = Uuid::parse_str(created_b.conversation_id.as_deref().unwrap()).unwrap();
    let group = create_collaboration_space(&pool, a_conv, "海鸥计划", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(
        &pool,
        a_conv,
        &group.space_id,
        b_conv,
        "Peter",
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let error = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a_conv),
            space_id: group.space_id.clone(),
            content: "@Peter 请转达 User 要找 Liber 干活了".to_string(),
            summary: None,
            to: vec!["Peter".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .expect_err("private-chat session must not post with a group space_id");
    assert_eq!(error.code, "invalid_origin_space");
    let group_json = serde_json::to_string(
        &list_space_messages(&pool, &group.space_id, None, None, MessageAudience::User)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(
        !group_json.contains("请转达"),
        "shared group must not receive a forged post from the DM session"
    );
}

#[tokio::test]
async fn dm_caller_addresses_group_by_name_keeps_origin_thread() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
    let created_a = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Faker".to_string(),
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
    let a_conv = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
    let a_member = identity::binding_of_conversation(&pool, a_conv)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let a_thread = identity::direct_thread_id(&a_member);
    let group = create_collaboration_space(&pool, a_conv, "海鸥计划", Uuid::new_v4())
        .await
        .unwrap();
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a_conv),
            space_id: a_thread.clone(),
            content: "@海鸥计划 进度同步".to_string(),
            summary: None,
            to: vec!["海鸥计划".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .expect("private chat addresses a group by name with the current space_id");
    assert!(posted.seq >= 1);
    let origin_dm = crate::collaboration_sidebar::list_dm_messages(&pool, a_conv, None, Some(50))
        .await
        .unwrap();
    let origin = origin_dm
        .iter()
        .find(|message| message.text.contains("进度同步"))
        .expect("sender private chat keeps the body");
    assert!(
        origin
            .cross_chat_sent_to
            .as_ref()
            .is_some_and(|value| value.to_string().contains("海鸥计划")),
        "sender private chat marks the destination group"
    );
    let group_messages =
        list_space_messages(&pool, &group.space_id, None, None, MessageAudience::User)
            .await
            .unwrap();
    assert!(
        group_messages.iter().any(|message| {
            message
                .envelope
                .get("crossChatReceivedFrom")
                .is_some_and(|value| value.to_string().contains("Faker"))
        }),
        "group lists an empty receipt from the private-chat sender"
    );
}

#[tokio::test]
async fn group_name_in_to_wakes_body_mentions_not_the_lead() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let origin = space_of(&pool, a).await;
    add_space_member(&pool, a, &origin, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let dest = create_collaboration_space(&pool, a, "二群", Uuid::new_v4())
        .await
        .unwrap()
        .space_id;
    let b_seat = add_space_member(&pool, a, &dest, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let c_seat = add_space_member(&pool, a, &dest, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    set_space_lead(&pool, &dest, Some(&c_seat.member_id))
        .await
        .unwrap();
    let b_dest = Uuid::parse_str(b_seat.conversation_id.as_deref().unwrap()).unwrap();
    let c_dest = Uuid::parse_str(c_seat.conversation_id.as_deref().unwrap()).unwrap();
    assert_ne!(b_dest, b);

    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: origin.clone(),
            content: "@小B 请看登录".to_string(),
            summary: None,
            to: vec!["二群".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let woken: Vec<Uuid> = posted.receipts.iter().map(|r| r.conversation_id).collect();
    assert_eq!(woken, vec![b_dest]);
    assert_eq!(input_count(&pool, b_dest).await, 1);
    assert_eq!(input_count(&pool, c_dest).await, 0);
    assert_eq!(input_count(&pool, b).await, 0);

    let silent = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: origin,
            content: "进度同步".to_string(),
            summary: None,
            to: vec!["二群".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    assert!(silent.receipts.is_empty());
    let dest_messages = list_space_messages(&pool, &dest, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert!(
        dest_messages
            .iter()
            .any(|message| { message.envelope.get("crossChatReceivedFrom").is_some() }),
        "destination group still logs the cross-space receipt"
    );
}

#[tokio::test]
async fn direct_user_message_wraps_space_context_for_agent() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
        .bind(workspace)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
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
            persona_prompt: None,
            mode_id: None,
            config_values: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread = identity::direct_thread_id(&member);
    send_user_text_to_conversation(
        &pool,
        conversation,
        Uuid::new_v4(),
        "今晚帮我看看登录",
        &DeliveryContext::default(),
    )
    .await
    .expect("deliver dm");

    let raw_payload: String = sqlx::query_scalar(
        "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    let payload: Value = serde_json::from_str(&raw_payload).unwrap();
    assert_eq!(payload["displayText"].as_str(), Some("今晚帮我看看登录"));
    let text = payload["text"].as_str().unwrap();
    assert!(text.contains("[Message from Person"), "{text}");
    assert!(text.contains(&thread), "{text}");
    assert!(text.contains("今晚帮我看看登录"), "{text}");
    assert!(
        text.contains("[PASS]") || text.contains("无需调用工具"),
        "{text}"
    );
    assert_eq!(payload["collaborationOrigin"]["threadKind"], "dm");
    assert_eq!(payload["collaborationOrigin"]["senderKind"], "user");
    assert_eq!(payload["collaborationOrigin"]["spaceId"], thread);
}

#[tokio::test]
async fn receipts_move_queued_processing_replied_and_origin_is_kept() {
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
    // b is busy, so the input waits in its queue.
    mark_running(&pool, b).await;
    let posted = post_as(&pool, None, &space, "@小B 看一下", &[]).await;
    let to_b = posted
        .receipts
        .iter()
        .find(|receipt| receipt.conversation_id == b)
        .unwrap();
    assert_eq!(to_b.state, "queued");
    let input_id = to_b.input_id.unwrap();

    // The queue dispatches the input: receipt becomes processing.
    sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
        .bind(input_id)
        .execute(&pool)
        .await
        .unwrap();
    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    let state_of = |receipts: &[MessageReceipt]| {
        receipts
            .iter()
            .find(|r| r.conversation_id == b.to_string())
            .unwrap()
            .state
            .clone()
    };
    assert_eq!(state_of(&receipts), "processing");

    // b answers in the thread: replied.
    let reply = post_as(&pool, Some(b), &space, "看完了", &["User"]).await;
    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(state_of(&receipts), "replied");

    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let origin_of = |seq: i64| {
        messages
            .iter()
            .find(|m| m.seq == seq)
            .map(|m| m.origin.clone())
            .unwrap()
    };
    assert_eq!(origin_of(posted.seq), "user");
    assert_eq!(origin_of(reply.seq), "agent");
    let user_post = messages.iter().find(|m| m.seq == posted.seq).unwrap();
    assert_eq!(state_of(&user_post.receipts), "replied");
}

#[tokio::test]
async fn listed_messages_expose_id_origin_and_reply_correlation() {
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
    let ask = post_as(&pool, Some(a), &space, "@小B 接口好了吗", &["小B"]).await;
    let reply = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(b),
            space_id: space.clone(),
            content: "@小A 好了".to_string(),
            summary: None,
            to: vec!["小A".to_string()],
            in_reply_to: Some(ask.message_id.clone()),
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let user_post = post_as(&pool, None, &space, "收到", &[]).await;

    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let by_seq = |seq: i64| messages.iter().find(|m| m.seq == seq).unwrap();
    assert_eq!(by_seq(ask.seq).id, ask.message_id);
    assert_eq!(by_seq(ask.seq).origin, "agent");
    assert_eq!(by_seq(ask.seq).in_reply_to, None);
    assert_eq!(by_seq(reply.seq).id, reply.message_id);
    assert_eq!(by_seq(reply.seq).origin, "agent");
    assert_eq!(
        by_seq(reply.seq).in_reply_to.as_deref(),
        Some(ask.message_id.as_str())
    );
    assert_eq!(by_seq(user_post.seq).origin, "user");

    // Wire shape the frontend reads.
    let wire = serde_json::to_value(by_seq(reply.seq)).unwrap();
    assert_eq!(wire["id"], json!(reply.message_id));
    assert_eq!(wire["origin"], json!("agent"));
    assert_eq!(wire["in_reply_to"], json!(ask.message_id));
    let wire_ask = serde_json::to_value(by_seq(ask.seq)).unwrap();
    assert!(wire_ask.get("in_reply_to").is_none());

    // Agents see the same correlation.
    let agent_view = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
        .await
        .unwrap();
    let agent_reply = agent_view.iter().find(|m| m.seq == reply.seq).unwrap();
    assert_eq!(
        agent_reply.in_reply_to.as_deref(),
        Some(ask.message_id.as_str())
    );
}

#[tokio::test]
async fn missed_context_keeps_last_15_and_collapses_older_into_one_line() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    for i in 1..=25 {
        post_as(&pool, None, &space, &format!("@小C 第{i:02}条"), &[]).await;
    }
    post_as(&pool, None, &space, "@小B 你来总结", &[]).await;
    let to_b = inputs_of(&pool, b).await;
    let packed: Value = serde_json::from_str(to_b.last().unwrap()).unwrap();
    let packed = packed["text"].as_str().unwrap();
    assert!(
        packed.contains("[上次发言后的群内新消息]"),
        "GroupSpace deliveries pack missed context: {packed}"
    );
    assert!(packed.contains("第11条"), "{packed}");
    assert!(packed.contains("第25条"), "{packed}");
    assert!(!packed.contains("第06条"), "{packed}");
    let helper = missed_group_context(&pool, &space, b, 0, 26)
        .await
        .unwrap()
        .expect("helper still renders a backlog");
    assert!(helper.contains("[上次发言后的群内新消息]"), "{helper}");
    assert_eq!(
        helper.matches("] Person: ").count(),
        MISSED_CONTEXT_VERBATIM
    );
    assert!(helper.contains("更早 10 条来自 Person"), "{helper}");
    assert!(helper.contains("read_space_messages"), "{helper}");
}

#[tokio::test]
async fn mention_packs_missed_group_messages_and_advances_last_seen() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    let first = post_as(&pool, None, &space, "@小C 先看接口", &[]).await;
    post_as(&pool, Some(c), &space, "接口没问题", &["User"]).await;
    let member_b = identity::member_id_for_conversation(b);
    let seen = |member: String| {
        let pool = pool.clone();
        let space = space.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT last_seen_message_id FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
            )
            .bind(space)
            .bind(member)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(seen(member_b.clone()).await, None);
    assert_eq!(
        seen(identity::member_id_for_conversation(c)).await,
        Some(first.message_id.clone())
    );

    let mention = post_as(&pool, None, &space, "@小B 你来总结", &[]).await;
    let to_b = inputs_of(&pool, b).await;
    assert_eq!(to_b.len(), 1);
    let first_payload: Value = serde_json::from_str(&to_b[0]).unwrap();
    let first = first_payload["text"].as_str().unwrap();
    assert!(
        first.contains("[上次发言后的群内新消息]"),
        "history is packed into the envelope: {first}"
    );
    assert!(first.contains("先看接口"), "{first}");
    assert!(first.contains("接口没问题"), "{first}");
    assert!(
        first.contains("你来总结") || first.contains("来总结"),
        "{first}"
    );
    assert_eq!(
        seen(member_b.clone()).await,
        Some(mention.message_id.clone())
    );

    post_as(&pool, None, &space, "@小B 再补一句", &[]).await;
    let to_b = inputs_of(&pool, b).await;
    assert_eq!(to_b.len(), 2);
    let first: Value = serde_json::from_str(&to_b[0]).unwrap();
    let second: Value = serde_json::from_str(&to_b[1]).unwrap();
    let first = first["text"].as_str().unwrap();
    let second = second["text"].as_str().unwrap();
    assert!(first.contains("[Space 身份与协作规则]"), "{first}");
    assert!(!second.contains("[Space 身份与协作规则]"), "{second}");
    assert!(second.contains("[上次发言后的群内新消息]"), "{second}");
}

#[tokio::test]
async fn space_broadcast_skips_sender_and_user() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let c = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    ensure_user_member(&pool, &space).await.unwrap();
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "@所有人 广播".to_string(),
            summary: None,
            to: Vec::new(),
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let recipients: Vec<Uuid> = posted
        .receipts
        .iter()
        .map(|receipt| receipt.conversation_id)
        .collect();
    assert!(recipients.contains(&b));
    assert!(recipients.contains(&c));
    assert!(!recipients.contains(&a));
    assert_eq!(input_count(&pool, a).await, 0);
    let members = list_space_members(&pool, &space, MessageAudience::Agent)
        .await
        .unwrap();
    assert!(members.iter().all(|member| member.kind != "user"));
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
        .await
        .unwrap();
    let encoded = serde_json::to_string(&messages).unwrap();
    assert!(!encoded.contains("/user"));
}

#[tokio::test]
async fn agent_projection_hides_the_user_actor() {
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
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: None,
            space_id: space.clone(),
            content: "请看这里".to_string(),
            summary: None,
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let agent_messages = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
        .await
        .unwrap();
    let agent_json = serde_json::to_string(&agent_messages).unwrap();
    assert!(!agent_json.contains("/user"));
    assert_eq!(agent_messages[0].envelope["sender"], json!("user"));
    assert!(agent_messages[0].envelope.get("actor").is_none());
    let user_messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(user_messages[0].envelope["sender"], json!("Person"));
    assert!(user_messages[0].envelope.get("actor").is_none());
}

#[tokio::test]
async fn space_replay_requires_membership_and_the_same_request() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, outsider, workspace, Some("外人")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let operation_id = Uuid::new_v4();
    let request = PostToSpace {
        caller_id: Some(a),
        space_id: space.clone(),
        content: "一次".to_string(),
        summary: Some("一次".to_string()),
        to: vec!["小B".to_string()],
        in_reply_to: None,
        operation_id,
    };
    post_to_space(&pool, request.clone()).await.unwrap();
    let mut outsider_request = request.clone();
    outsider_request.caller_id = Some(outsider);
    let denied = post_to_space(&pool, outsider_request).await.unwrap_err();
    assert_eq!(denied.code, "not_a_member");
    // Same-turn agent reuse of operation_id with different content derives a new message_id
    let mut changed_content = request.clone();
    changed_content.content = "两次".to_string();
    let derived = post_to_space(&pool, changed_content).await.unwrap();
    assert_ne!(derived.message_id, operation_id.to_string());
    assert_eq!(input_count(&pool, b).await, 2);

    // Same content but different recipient list with same operation_id still conflicts
    let mut changed = request.clone();
    changed.to = vec!["User".to_string()];
    let conflict = post_to_space(&pool, changed).await.unwrap_err();
    assert_eq!(conflict.code, "conversation_control_failed");
    let other = create_collaboration_space(&pool, a, "另一空间", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &other.space_id, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let mut wrong_space = request.clone();
    wrong_space.space_id = other.space_id.clone();
    let missing = post_to_space(&pool, wrong_space).await.unwrap_err();
    assert_eq!(missing.code, "invalid_origin_space");
    let leaked: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?")
            .bind(&other.space_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(leaked, 0);
}

#[tokio::test]
async fn space_inflight_member_is_queued() {
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
    mark_running(&pool, b).await;
    let posted = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space,
            content: "补充".to_string(),
            summary: Some("补充".to_string()),
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    assert_eq!(posted.receipts[0].delivered, "queued");
    let status: String =
        sqlx::query_scalar("SELECT status FROM conversation_turns WHERE conversation_id = ?")
            .bind(b)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "running");
}

#[tokio::test]
async fn space_retry_does_not_double_submit() {
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
    let operation_id = Uuid::new_v4();
    let request = PostToSpace {
        caller_id: Some(a),
        space_id: space,
        content: "一次".to_string(),
        summary: Some("一次".to_string()),
        to: vec!["小B".to_string()],
        in_reply_to: None,
        operation_id,
    };
    post_to_space(&pool, request.clone()).await.unwrap();
    post_to_space(&pool, request).await.unwrap();
    assert_eq!(input_count(&pool, b).await, 1);
    let deliveries: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_space_deliveries WHERE conversation_id = ?",
    )
    .bind(b.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(deliveries, 1);
}

#[tokio::test]
async fn list_messages_since_seq() {
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
            content: "一".to_string(),
            summary: None,
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "二".to_string(),
            summary: None,
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    let later = list_space_messages(&pool, &space, Some(first.seq), None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(later.len(), 1);
    assert!(later[0].seq > first.seq);
    assert!(
        later[0].envelope["content"]
            .as_str()
            .unwrap()
            .contains('二')
    );
}

#[tokio::test]
async fn space_delivery_strips_mention_for_display_and_embeds_protocol_context() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: None,
            space_id: space.clone(),
            content: " @小A 请你分析我当前项目的性能".to_string(),
            summary: None,
            to: vec!["小A".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    let raw_payload: String = sqlx::query_scalar(
        "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
    )
    .bind(a)
    .fetch_one(&pool)
    .await
    .unwrap();
    let payload: Value = serde_json::from_str(&raw_payload).unwrap();
    assert_eq!(
        payload["displayText"].as_str(),
        Some("请你分析我当前项目的性能")
    );
    let text = payload["text"].as_str().unwrap();
    assert!(
        text.contains("[Group chat \"评审工作\" · from Person"),
        "{text}"
    );
    assert!(text.contains("GroupSpace") || text.contains(&space));
    assert!(text.contains(&space));
    assert!(text.contains("from Person"), "{text}");
    assert!(
        text.contains("[Space 身份与协作规则]")
            || text.contains("协同交互规则")
            || text.contains("协作空间交互规则")
    );
    assert!(!text.contains("空间内成员"));
    assert_eq!(text.matches("请你分析我当前项目的性能").count(), 1);
    assert_eq!(payload["collaborationOrigin"]["threadKind"], "group");
    assert_eq!(payload["collaborationOrigin"]["senderKind"], "user");
    assert_eq!(payload["collaborationOrigin"]["senderNickname"], "你");

    let context = persona_prompt_text(&pool, a).await.unwrap().unwrap();
    assert!(context.contains("[协作空间成员身份]"));
    assert!(context.contains("小A"));
    assert!(context.contains(&space));

    // Member can reply to @User in the space and query spaces & members
    let reply = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "@User 性能分析已完成".to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();
    assert_eq!(reply.seq, 2);
    assert!(reply.receipts.is_empty());

    let spaces_view = list_collaboration_spaces_for_caller(&pool, a)
        .await
        .unwrap();
    assert_eq!(spaces_view["spaces"][0]["space_id"], space);
    assert_eq!(spaces_view["spaces"][0]["is_member"], true);
    assert_eq!(spaces_view["spaces"][0]["my_nickname"], "小A");

    let members_view = list_space_members_detailed(&pool, a, &space).await.unwrap();
    assert_eq!(members_view["my_nickname"], "小A");
    assert_eq!(members_view["members"][0]["nickname"], "小A");
    assert_eq!(members_view["members"][0]["is_self"], true);
}

#[tokio::test]
async fn member_space_post_labels_origin_sender_on_peer_input() {
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
    post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "@小B 请核对接口".to_string(),
            summary: None,
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap();

    let raw_payload: String = sqlx::query_scalar(
        "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
    )
    .bind(b)
    .fetch_one(&pool)
    .await
    .unwrap();
    let payload: Value = serde_json::from_str(&raw_payload).unwrap();
    assert_eq!(payload["displayText"].as_str(), Some("请核对接口"));
    let text = payload["text"].as_str().unwrap();
    assert!(
        text.contains("[Group chat \"评审工作\" · from 小A"),
        "{text}"
    );
    assert!(text.contains("小A"), "{text}");
    assert_eq!(payload["collaborationOrigin"]["threadKind"], "group");
    assert_eq!(payload["collaborationOrigin"]["senderKind"], "member");
    assert_eq!(payload["collaborationOrigin"]["senderNickname"], "小A");
    assert_eq!(
        payload["collaborationOrigin"]["senderConversationId"].as_str(),
        Some(a.to_string().as_str())
    );
}

#[tokio::test]
async fn post_to_space_on_unassigned_space_returns_invalid_space_for_direct_chat() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let bot = Uuid::new_v4();
    create_session(&pool, bot, workspace, Some("私聊Bot")).await;
    let unassigned = unassigned_space_id(workspace);

    let err = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(bot),
            space_id: unassigned.clone(),
            content: "你好".to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "invalid_space_for_direct_chat");

    let delayed_err = post_to_space_delayed_with(
        &pool,
        PostToSpace {
            caller_id: Some(bot),
            space_id: unassigned,
            content: "延时你好".to_string(),
            summary: None,
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        Some(60),
        &DeliveryContext::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(delayed_err.code, "invalid_space_for_direct_chat");
}

#[tokio::test]
async fn group_bot_post_to_space_broadcast_all_default_user_and_no_cross_space_pull() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;

    let space1 = space_of(&pool, a).await;
    add_space_member(&pool, a, &space1, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space1, c, "小C", Uuid::new_v4())
        .await
        .unwrap();

    // 1. Bot omits `to: []` and content has no `@` -> delivers ONLY to User (0 agent receipts/wakes)
    let to_user_only = post_as(&pool, Some(a), &space1, "我已经完成初步分析", &[]).await;
    assert!(
        to_user_only.receipts.is_empty(),
        "bot post without `to` or `@` must default to User and not wake other agents"
    );
    assert_eq!(input_count(&pool, b).await, 0);
    assert_eq!(input_count(&pool, c).await, 0);

    // 2. Bot passes `@所有人` in content (or `to: ["所有人"]`) -> broadcasts to all other agents in group
    let broadcast_by_content = post_as(&pool, Some(a), &space1, "@所有人 请看最新方案", &[]).await;
    let woken_ids: Vec<Uuid> = broadcast_by_content
        .receipts
        .iter()
        .map(|r| r.conversation_id)
        .collect();
    assert_eq!(woken_ids.len(), 2);
    assert!(woken_ids.contains(&b));
    assert!(woken_ids.contains(&c));

    let broadcast_by_to = post_as(&pool, Some(a), &space1, "请大家同步进度", &["所有人"]).await;
    assert_eq!(broadcast_by_to.receipts.len(), 2);

    // 3. Bot addresses a workspace DM peer: deliver to that DM, do not add them to this group.
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
    let expert = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "外部专家".to_string(),
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
    let expert_conv = Uuid::parse_str(expert.conversation_id.as_deref().unwrap()).unwrap();
    let cross = post_to_space(
        &pool,
        PostToSpace {
            caller_id: Some(a),
            space_id: space1.clone(),
            content: "@外部专家 请支援".to_string(),
            summary: None,
            to: vec!["外部专家".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await
    .expect("workspace DM peers can be addressed from a group");
    assert!(
        cross
            .receipts
            .iter()
            .any(|receipt| receipt.conversation_id == expert_conv),
        "external bot's DM conversation is woken"
    );
    let space1_members = list_space_members(&pool, &space1, MessageAudience::Agent)
        .await
        .unwrap();
    assert!(space1_members.iter().all(|m| m.nickname != "外部专家"));
    let origin_messages = list_space_messages(&pool, &space1, None, None, MessageAudience::User)
        .await
        .unwrap();
    let origin = origin_messages
        .iter()
        .find(|message| {
            message.envelope["content"]
                .as_str()
                .is_some_and(|text| text.contains("请支援"))
        })
        .expect("origin group keeps the body");
    assert!(origin.envelope.get("crossChatSentTo").is_some());
    let dm = crate::collaboration_sidebar::list_dm_messages(&pool, expert_conv, None, Some(50))
        .await
        .unwrap();
    assert!(
        dm.iter().all(|message| !message.text.contains("请支援")),
        "target DM does not list the foreign body"
    );
    assert!(
        dm.iter().any(|message| {
            message.text.is_empty()
                && message
                    .cross_chat_received_from
                    .as_ref()
                    .is_some_and(|value| value.to_string().contains("小A"))
        }),
        "target DM lists an empty receipt from the sender"
    );
}

#[tokio::test]
async fn finalize_space_turn_deliveries_posts_fallback_reply_and_clears_processing() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();

    // User sends a message mentioning 小B -> receipt enters `processing` once dispatched
    let user_msg = post_as(&pool, None, &space, "@小B 请汇报鉴权模块状态", &[]).await;
    let b_receipt = user_msg
        .receipts
        .iter()
        .find(|r| r.conversation_id == b)
        .unwrap();
    sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
        .bind(b_receipt.input_id.unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE collaboration_space_deliveries SET receipt_state = 'processing' WHERE space_message_id = ? AND conversation_id = ?",
    )
    .bind(&user_msg.message_id)
    .bind(b.to_string())
    .execute(&pool)
    .await
    .unwrap();

    // 小B finishes its turn with plain assistant text without calling `post_to_space`
    let events = finalize_space_turn_deliveries(
        &pool,
        b,
        "鉴权模块已完成单元测试并通过验证。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].space_id, space);

    // Receipt for user_msg is now `replied`
    let receipts = list_message_receipts(&pool, &user_msg.message_id)
        .await
        .unwrap();
    let b_after = receipts
        .iter()
        .find(|r| r.conversation_id == b.to_string())
        .unwrap();
    assert_eq!(b_after.state, "replied");

    // And the fallback message was posted to the space for User
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(messages.len(), 2);
    let fallback = &messages[1];
    assert_eq!(fallback.origin, "agent");
    assert_eq!(
        fallback.in_reply_to.as_deref(),
        Some(user_msg.message_id.as_str())
    );
    assert_eq!(
        fallback.envelope["content"].as_str().unwrap(),
        "鉴权模块已完成单元测试并通过验证。"
    );
}

#[tokio::test]
async fn third_in_flight_delivery_queues_without_waking() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();

    let first = post_as(&pool, None, &space, "@小A 先做", &[]).await;
    let second = post_as(&pool, None, &space, "@小B 再做", &[]).await;
    sqlx::query("UPDATE collaboration_space_deliveries SET receipt_state = 'processing'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(input_count(&pool, c).await, 0);

    let third = post_as(&pool, None, &space, "@小C 第三件", &[]).await;
    assert_eq!(third.receipts.len(), 1);
    assert_eq!(third.receipts[0].conversation_id, c);
    assert_eq!(third.receipts[0].delivered, "queued");
    assert!(third.receipts[0].input_id.is_none());
    assert_eq!(input_count(&pool, c).await, 0);
    assert_eq!(input_count(&pool, a).await, 1);
    assert_eq!(input_count(&pool, b).await, 1);
    let _ = (first, second);
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert!(
        messages.iter().any(|message| message.origin == "system"),
        "concurrency cap must insert the system notice"
    );
}

#[tokio::test]
async fn migrated_space_without_lead_still_posts() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let lead: Option<String> =
        sqlx::query_scalar("SELECT lead_member_id FROM collaboration_spaces WHERE id = ?")
            .bind(&space)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(lead.is_none());
    let posted = post_as(&pool, None, &space, "旧群也能发", &[]).await;
    assert_eq!(posted.receipts.len(), 1);
    assert_eq!(posted.receipts[0].conversation_id, a);
}

async fn open_turn(
    pool: &SqlitePool,
    message_id: &str,
    conversation_id: Uuid,
) -> Option<(String, String, Option<String>, String)> {
    sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"SELECT id, state, outcome, deadline_at FROM collaboration_turns
               WHERE space_message_id = ? AND conversation_id = ?
               ORDER BY created_at DESC LIMIT 1"#,
    )
    .bind(message_id)
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn mark_processing(pool: &SqlitePool, message_id: &str, conversation_id: Uuid) {
    let input_id: Option<String> = sqlx::query_scalar(
        r#"SELECT input_id FROM collaboration_space_deliveries
               WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(message_id)
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten();
    if let Some(input_id) = input_id {
        sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
            .bind(input_id)
            .execute(pool)
            .await
            .unwrap();
    }
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'processing'
               WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(message_id)
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn deliver_pending_creates_a_running_turn_with_a_reasonable_deadline() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请处理", &[]).await;
    let receipt = posted
        .receipts
        .iter()
        .find(|r| r.conversation_id == a)
        .unwrap();
    assert!(receipt.input_id.is_some());
    let turn = open_turn(&pool, &posted.message_id, a).await.expect("turn");
    assert_eq!(turn.1, "running");
    assert!(turn.2.is_none());
    let deadline = chrono::DateTime::parse_from_rfc3339(&turn.3).unwrap();
    let expected = chrono::Utc::now() + chrono::Duration::minutes(collab_turn_timeout_minutes());
    let delta = (deadline.with_timezone(&chrono::Utc) - expected)
        .num_seconds()
        .abs();
    assert!(
        delta < 90,
        "deadline {deadline} should be ~timeout from now"
    );
    let bound: Option<String> = sqlx::query_scalar(
        r#"SELECT turn_id FROM collaboration_space_deliveries
               WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(&posted.message_id)
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bound.as_deref(), Some(turn.0.as_str()));
}

#[tokio::test]
async fn wake_limit_exceeded_does_not_create_a_turn() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let mut others = Vec::new();
    for name in ["小B", "小C", "小D", "小E"] {
        let id = Uuid::new_v4();
        create_session(&pool, id, workspace, Some(name)).await;
        add_space_member(&pool, a, &space, id, name, Uuid::new_v4())
            .await
            .unwrap();
        others.push(id);
    }
    sqlx::query("UPDATE collaboration_thread_members SET last_active_at = '2000-01-01T00:00:00Z'")
        .execute(&pool)
        .await
        .unwrap();
    sleep_idle_sessions(&pool, 30).await.unwrap();
    mark_running(&pool, a).await;
    let posted = post_as(&pool, Some(a), &space, "@所有人 大家醒醒", &[]).await;
    let held = posted
        .receipts
        .iter()
        .find(|r| r.error_code.as_deref() == Some("wake_limit_exceeded"))
        .expect("one sleeper is held");
    assert!(held.input_id.is_none());
    assert!(
        open_turn(&pool, &posted.message_id, held.conversation_id)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn finalize_empty_assistant_text_passes() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请看", &[]).await;
    mark_processing(&pool, &posted.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "   ", &DeliveryContext::default())
        .await
        .unwrap();
    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(receipts[0].state, "passed");
    assert_eq!(receipts[0].outcome.as_deref(), Some("pass"));
    let turn = open_turn(&pool, &posted.message_id, a).await.unwrap();
    assert_eq!(turn.1, "finished");
    assert_eq!(turn.2.as_deref(), Some("pass"));
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
}

#[tokio::test]
async fn finalize_polite_ack_only_passes() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请看", &[]).await;
    mark_processing(&pool, &posted.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "好的收到。", &DeliveryContext::default())
        .await
        .unwrap();
    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(receipts[0].state, "passed");
    assert_eq!(receipts[0].outcome.as_deref(), Some("pass"));
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(messages.len(), 1, "polite ack must not fallback-post");
}

#[tokio::test]
async fn finalize_writes_outcome_for_every_processing_delivery_in_the_space() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let first = post_as(&pool, None, &space, "@小A 第一件", &[]).await;
    let second = post_as(&pool, None, &space, "@小A 第二件", &[]).await;
    mark_processing(&pool, &first.message_id, a).await;
    mark_processing(&pool, &second.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "两件都做完了。", &DeliveryContext::default())
        .await
        .unwrap();
    for message_id in [&first.message_id, &second.message_id] {
        let receipts = list_message_receipts(&pool, message_id).await.unwrap();
        assert_eq!(receipts[0].state, "replied");
        assert_eq!(receipts[0].outcome.as_deref(), Some("sent"));
        let turn = open_turn(&pool, message_id, a).await.unwrap();
        assert_eq!(turn.1, "finished");
        assert_eq!(turn.2.as_deref(), Some("sent"));
    }
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let fallbacks = messages
        .iter()
        .filter(|message| message.origin == "agent")
        .count();
    assert_eq!(fallbacks, 1, "one fallback post per space");
}

#[tokio::test]
async fn redelivery_after_a_finished_error_turn_inserts_a_new_open_turn() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let first = post_as(&pool, None, &space, "@小A 先做", &[]).await;
    let first_turn = open_turn(&pool, &first.message_id, a).await.unwrap();
    sqlx::query(
        r#"UPDATE collaboration_turns
               SET state = 'finished', outcome = 'error', updated_at = ?
               WHERE id = ?"#,
    )
    .bind(now_stamp())
    .bind(&first_turn.0)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
               SET status = 'failed'
               WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(&first.message_id)
    .bind(a.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let second = post_as(&pool, None, &space, "@小A 再做", &[]).await;
    let second_turn = open_turn(&pool, &second.message_id, a)
        .await
        .expect("new open turn");
    assert_eq!(second_turn.1, "running");
    assert_ne!(second_turn.0, first_turn.0);
    let open: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_turns
               WHERE conversation_id = ? AND state <> 'finished'"#,
    )
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(open, 1);
}

#[tokio::test]
async fn reusing_an_open_turn_does_not_violate_the_unique_index() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请处理", &[]).await;
    let first = open_turn(&pool, &posted.message_id, a).await.unwrap();
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
               SET input_id = NULL, status = 'queued', receipt_state = 'queued',
                   operation_id = ?
               WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&posted.message_id)
    .bind(a.to_string())
    .execute(&pool)
    .await
    .unwrap();
    deliver_pending(
        &pool,
        &space,
        &posted.message_id,
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    let open: Vec<String> = sqlx::query_scalar(
        r#"SELECT id FROM collaboration_turns
               WHERE space_message_id = ? AND conversation_id = ? AND state <> 'finished'"#,
    )
    .bind(&posted.message_id)
    .bind(a.to_string())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(open, vec![first.0]);
}

#[tokio::test]
async fn projected_receipts_keep_legacy_rows_and_the_processing_trigger() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请处理", &[]).await;
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
               SET status = 'failed', receipt_state = 'queued'
               WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(&posted.message_id)
    .bind(a.to_string())
    .execute(&pool)
    .await
    .unwrap();
    let failed = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(failed[0].state, "failed");
    assert_eq!(failed[0].delivered, "failed");

    let second = post_as(&pool, None, &space, "@小A 下一件", &[]).await;
    let input_id = second.receipts[0].input_id.unwrap();
    sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
        .bind(input_id)
        .execute(&pool)
        .await
        .unwrap();
    let processing = list_message_receipts(&pool, &second.message_id)
        .await
        .unwrap();
    assert_eq!(processing[0].state, "processing");
}

#[tokio::test]
async fn cancel_space_turn_allows_owner_and_rejects_other_members() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let posted = post_as(&pool, None, &space, "@小A 请处理", &[]).await;
    mark_processing(&pool, &posted.message_id, a).await;
    let denied = cancel_space_turn(
        &pool,
        &space,
        Some(posted.message_id.as_str()),
        None,
        Some(b),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, "out_of_scope");
    let cancelled = cancel_space_turn(
        &pool,
        &space,
        Some(posted.message_id.as_str()),
        None,
        Some(a),
    )
    .await
    .unwrap();
    assert_eq!(cancelled.len(), 1);
    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(receipts[0].state, "cancelled");
    assert_eq!(receipts[0].outcome.as_deref(), Some("cancelled"));
}

#[tokio::test]
async fn dm_post_and_reply_write_space_messages_and_receipts() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();

    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Builder".to_string(),
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member_id = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread_id = identity::direct_thread_id(&member_id);

    let (posted, _, _) = post_direct_message_with(
        &pool,
        PostDirectMessage {
            thread_id: thread_id.clone(),
            content: "帮我检查一下登录流程".to_string(),
            summary: None,
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .expect("post_direct_message_with");

    assert_eq!(posted.seq, 1);
    assert_eq!(posted.receipts.len(), 1);

    let initial_receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(initial_receipts.len(), 1);
    assert_eq!(initial_receipts[0].state, "queued");

    mark_processing(&pool, &posted.message_id, conversation).await;
    let proc_receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(proc_receipts[0].state, "processing");

    finalize_space_turn_deliveries(
        &pool,
        conversation,
        "登录流程已经检查完毕，token 刷新逻辑正常。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let final_receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(final_receipts[0].state, "replied");
    assert_eq!(final_receipts[0].outcome.as_deref(), Some("sent"));

    let space_messages: Vec<(i64, String, String)> = sqlx::query_as(
        r#"SELECT seq, origin, envelope_json
               FROM collaboration_space_messages
               WHERE space_id = ?
               ORDER BY seq ASC"#,
    )
    .bind(&thread_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(space_messages.len(), 2);
    assert_eq!(space_messages[0].0, 1);
    assert_eq!(space_messages[0].1, "user");
    assert_eq!(space_messages[1].0, 2);
    assert_eq!(space_messages[1].1, "agent");
    let reply_env: Value = serde_json::from_str(&space_messages[1].2).unwrap();
    assert_eq!(
        reply_env.get("reply_to").and_then(Value::as_str),
        Some(posted.message_id.as_str())
    );

    let (second, _, _) = post_direct_message_with(
        &pool,
        PostDirectMessage {
            thread_id: thread_id.clone(),
            content: "收到，谢谢".to_string(),
            summary: None,
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    assert_eq!(second.seq, 3);
    mark_processing(&pool, &second.message_id, conversation).await;
    finalize_space_turn_deliveries(
        &pool,
        conversation,
        "好的收到。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let second_receipts = list_message_receipts(&pool, &second.message_id)
        .await
        .unwrap();
    assert_eq!(second_receipts[0].state, "passed");
    assert_eq!(second_receipts[0].outcome.as_deref(), Some("pass"));

    let after_pass_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?")
            .bind(&thread_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        after_pass_count, 3,
        "polite ack in DM must not write an agent message"
    );
}

#[tokio::test]
async fn list_dm_messages_preserves_pre_cutover_and_splices_post_cutover_with_streaming_draft() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();

    let created = host_create_space_member(
        &pool,
        HostCreateSpaceMember {
            workspace_id: workspace,
            space_id: None,
            nickname: "Tester".to_string(),
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member_id = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread_id = identity::direct_thread_id(&member_id);
    sqlx::query(
        r#"UPDATE collaboration_threads
               SET space_cutover_seq = NULL, space_cutover_at = NULL
               WHERE id = ?"#,
    )
    .bind(&thread_id)
    .execute(&pool)
    .await
    .unwrap();

    let now = now_stamp();
    let user_json = serde_json::to_string(&agents::ConversationEvent::UserTurnCreated {
        blocks: vec![agents::ConversationInputBlock::Text {
            text: "旧版用户消息".to_string(),
        }],
        workflow_refs: Vec::new(),
    })
    .unwrap();
    sqlx::query(
        r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, 10, 'user', 'user_turn_created', ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(user_json)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    let assistant_json = serde_json::to_string(&agents::ConversationEvent::AssistantTextDelta {
        text: "旧版助手回复".to_string(),
        message_id: None,
    })
    .unwrap();
    sqlx::query(
        r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, 11, 'acp', 'assistant_text_delta', ?, ?)"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(assistant_json)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    let pre_cutover =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    assert_eq!(pre_cutover.len(), 2);
    assert_eq!(pre_cutover[0].seq, 10);
    assert_eq!(pre_cutover[0].text, "旧版用户消息");
    assert_eq!(pre_cutover[1].seq, 11);
    assert_eq!(pre_cutover[1].text, "旧版助手回复");

    let (posted, _, _) = post_direct_message_with(
        &pool,
        PostDirectMessage {
            thread_id: thread_id.clone(),
            content: "新版用户消息".to_string(),
            summary: None,
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    mark_processing(&pool, &posted.message_id, conversation).await;

    let active_turn = open_turn(&pool, &posted.message_id, conversation)
        .await
        .expect("running turn");
    let draft_json = serde_json::to_string(&agents::ConversationEvent::AssistantTextDelta {
        text: "正在流式生成的回复...".to_string(),
        message_id: None,
    })
    .unwrap();
    sqlx::query(
            r#"INSERT INTO conversation_events
               (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
               VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM conversation_events WHERE conversation_id = ?), 'acp', 'assistant_text_delta', ?, ?)"#,
        )
        .bind(Uuid::new_v4())
        .bind(conversation)
        .bind(conversation)
        .bind(draft_json)
        .bind(now_stamp())
        .execute(&pool)
        .await
        .unwrap();

    let with_draft =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    assert_eq!(with_draft.len(), 4);
    assert_eq!(with_draft[0].seq, 10);
    assert_eq!(with_draft[1].seq, 11);
    assert_eq!(with_draft[2].seq, 1);
    assert_eq!(with_draft[2].text, "新版用户消息");
    assert_eq!(with_draft[3].streaming, Some(true));
    assert_eq!(
        with_draft[3].turn_id.as_deref(),
        Some(active_turn.0.as_str())
    );
    assert_eq!(with_draft[3].text, "正在流式生成的回复...");

    finalize_space_turn_deliveries(
        &pool,
        conversation,
        "新版助手最终回复",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let finalized =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
            .await
            .unwrap();
    assert_eq!(finalized.len(), 4);
    assert_eq!(finalized[2].seq, 1);
    assert_eq!(finalized[2].delivered.as_deref(), Some("replied"));
    assert_eq!(finalized[3].seq, 2);
    assert_eq!(finalized[3].text, "新版助手最终回复");
    assert_eq!(finalized[3].streaming, None);
    assert_eq!(
        finalized[3].turn_id.as_deref(),
        Some(active_turn.0.as_str())
    );

    let since_post_1 =
        crate::collaboration_sidebar::list_dm_messages(&pool, conversation, Some(1), Some(50))
            .await
            .unwrap();
    assert!(since_post_1.iter().any(|m| m.seq == 10));
    assert!(
        since_post_1
            .iter()
            .any(|m| m.seq == 2 && m.text == "新版助手最终回复")
    );
    assert!(
        !since_post_1
            .iter()
            .any(|m| m.seq == 1 && m.text == "新版用户消息")
    );
}

#[tokio::test]
async fn space_events_cursor_generation_and_tx_rollback() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;

    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let posted = post_as(&pool, None, &space, "@小A 请处理", &[]).await;
    mark_processing(&pool, &posted.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "处理完毕", &DeliveryContext::default())
        .await
        .unwrap();

    let page = crate::collaboration::roles::list_space_events(&pool, &space, None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(page.generation, 1);
    assert!(!page.reset);
    assert!(page.events.len() >= 3);
    let kinds: Vec<&str> = page.events.iter().map(|e| e.kind.as_str()).collect();
    assert!(kinds.contains(&"roster"));
    assert!(kinds.contains(&"message"));
    assert!(kinds.contains(&"turn"));
    for pair in page.events.windows(2) {
        assert!(
            pair[0].seq < pair[1].seq,
            "event seq must strictly increase"
        );
    }

    let first_seq = page.events[0].seq;
    let incremental = crate::collaboration::roles::list_space_events(
        &pool,
        &space,
        None,
        Some(first_seq),
        Some(50),
    )
    .await
    .unwrap();
    assert!(incremental.events.iter().all(|e| e.seq > first_seq));

    let future_cutoff = "9999-12-31T23:59:59Z";
    let deleted =
        crate::collaboration::roles::sweep_expired_space_events_before(&pool, future_cutoff)
            .await
            .unwrap();
    assert!(deleted > 0);

    let reset_page = crate::collaboration::roles::list_space_events(
        &pool,
        &space,
        None,
        Some(first_seq),
        Some(50),
    )
    .await
    .unwrap();
    assert!(reset_page.reset);
    assert_eq!(reset_page.generation, 2);
    assert!(reset_page.events.is_empty());

    let restored_gen = crate::collaboration::roles::restore_space_from_archive(&pool, &space)
        .await
        .unwrap();
    assert_eq!(restored_gen, 3);

    sqlx::query(
        r#"CREATE TRIGGER abort_space_events_insert
               BEFORE INSERT ON collaboration_space_events
               BEGIN
                   SELECT RAISE(ABORT, 'injected space event failure');
               END;"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let count_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?")
            .bind(&space)
            .fetch_one(&pool)
            .await
            .unwrap();

    let err = post_to_space(
        &pool,
        PostToSpace {
            caller_id: None,
            space_id: space.clone(),
            content: "@小A 这条应该回滚".to_string(),
            summary: None,
            to: vec!["小A".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
    )
    .await;
    assert!(err.is_err(), "trigger failure must abort post_to_space");

    let count_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?")
            .bind(&space)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        count_before, count_after,
        "business write must roll back when collaboration_space_events insert fails"
    );
}

#[tokio::test]
async fn multi_target_group_message_runs_sequential_round_and_supersedes_on_new_user_message() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();

    let a_member: String = sqlx::query_scalar(
            "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&space)
        .bind(a.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let single = post_as(&pool, None, &space, "@小B 单独问你", &["小B"]).await;
    let single_round_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&single.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(single_round_count, 0, "single target must not open a round");
    mark_processing(&pool, &single.message_id, b).await;
    finalize_space_turn_deliveries(&pool, b, "好的收到。", &DeliveryContext::default())
        .await
        .unwrap();

    let before_a_inputs = input_count(&pool, a).await;
    let before_b_inputs = input_count(&pool, b).await;
    let before_c_inputs = input_count(&pool, c).await;

    let multi = post_as(
        &pool,
        None,
        &space,
        "@小C @小B @小A 请依次汇报",
        &["小C", "小B", "小A"],
    )
    .await;

    let round_row: (String, String, i64) = sqlx::query_as(
        "SELECT id, state, current_ordinal FROM collaboration_rounds WHERE root_message_id = ?",
    )
    .bind(&multi.message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(round_row.1, "open");
    assert_eq!(round_row.2, 1);

    let ordinals: Vec<(String, i64)> = sqlx::query_as(
        r#"SELECT conversation_id, round_ordinal
               FROM collaboration_space_deliveries
               WHERE space_message_id = ?
               ORDER BY round_ordinal ASC"#,
    )
    .bind(&multi.message_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        ordinals,
        vec![(a.to_string(), 1), (c.to_string(), 2), (b.to_string(), 3),],
        "lead (小A) first, then request `to` order (小C, 小B)"
    );

    assert_eq!(input_count(&pool, a).await, before_a_inputs + 1);
    assert_eq!(input_count(&pool, c).await, before_c_inputs);
    assert_eq!(input_count(&pool, b).await, before_b_inputs);

    mark_processing(&pool, &multi.message_id, a).await;
    finalize_space_turn_deliveries(
        &pool,
        a,
        "我是小A，我的部分已完成。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let after_a: (String, i64) =
        sqlx::query_as("SELECT state, current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_row.0)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_a.0, "open");
    assert_eq!(after_a.1, 2);
    assert_eq!(input_count(&pool, c).await, before_c_inputs + 1);
    assert_eq!(input_count(&pool, b).await, before_b_inputs);

    mark_processing(&pool, &multi.message_id, c).await;
    finalize_space_turn_deliveries(&pool, c, "好的收到。", &DeliveryContext::default())
        .await
        .unwrap();

    let after_c: (String, i64) =
        sqlx::query_as("SELECT state, current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_row.0)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_c.0, "open");
    assert_eq!(after_c.1, 3);
    assert_eq!(input_count(&pool, b).await, before_b_inputs + 1);

    mark_processing(&pool, &multi.message_id, b).await;
    sqlx::query(
            "UPDATE collaboration_turns SET deadline_at = '2000-01-01T00:00:00Z' WHERE space_message_id = ? AND conversation_id = ?",
        )
        .bind(&multi.message_id)
        .bind(b.to_string())
        .execute(&pool)
        .await
        .unwrap();
    sweep_expired_turns(&pool).await.unwrap();

    let after_b: (String, i64) =
        sqlx::query_as("SELECT state, current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_row.0)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_b.0, "closed");

    let round2_msg = post_as(&pool, None, &space, "@小A @小B 第二轮讨论", &["小A", "小B"]).await;
    let round2_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&round2_msg.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &round2_msg.message_id, a).await;

    let round3_msg = post_as(&pool, None, &space, "@小A @小B 换个话题", &["小A", "小B"]).await;
    let round2_state: String =
        sqlx::query_scalar("SELECT state FROM collaboration_rounds WHERE id = ?")
            .bind(&round2_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(round2_state, "superseded");

    let old_receipts = list_message_receipts(&pool, &round2_msg.message_id)
        .await
        .unwrap();
    assert!(
        old_receipts.iter().all(|r| r.state == "cancelled"),
        "superseded round deliveries must be cancelled: {old_receipts:?}"
    );
    let new_round_state: String =
        sqlx::query_scalar("SELECT state FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&round3_msg.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(new_round_state, "open");
}

#[tokio::test]
async fn finalize_pass_token_does_not_post() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请看", &[]).await;
    mark_processing(&pool, &posted.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "  [pass]  ", &DeliveryContext::default())
        .await
        .unwrap();
    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(receipts[0].state, "passed");
    assert_eq!(receipts[0].outcome.as_deref(), Some("pass"));
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
}

#[tokio::test]
async fn finalize_strips_own_nickname_prefix_and_posts_to_user_without_peer_wake() {
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
    let posted = post_as(&pool, None, &space, "@小A 请看登录", &[]).await;
    let before_b = input_count(&pool, b).await;
    mark_processing(&pool, &posted.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "小A: 鉴权已完成。", &DeliveryContext::default())
        .await
        .unwrap();
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let fallback = messages.iter().find(|m| m.origin == "agent").unwrap();
    assert_eq!(
        fallback.envelope["content"].as_str().unwrap(),
        "鉴权已完成。"
    );
    let to = fallback.envelope["to"].as_array().unwrap();
    assert_eq!(to, &vec![json!("Person")]);
    assert_eq!(fallback.envelope["sender"].as_str().unwrap(), "小A");
    assert_eq!(input_count(&pool, b).await, before_b);
}

#[tokio::test]
async fn finalize_group_at_peer_wakes_mentioned_bot() {
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
    let posted = post_as(&pool, None, &space, "@小A 请看登录", &[]).await;
    let before_b = input_count(&pool, b).await;
    mark_processing(&pool, &posted.message_id, a).await;
    finalize_space_turn_deliveries(&pool, a, "@小A: @小B 请接登录", &DeliveryContext::default())
        .await
        .unwrap();
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let fallback = messages.iter().find(|m| m.origin == "agent").unwrap();
    assert_eq!(
        fallback.envelope["content"].as_str().unwrap(),
        "@小B 请接登录"
    );
    let to = fallback.envelope["to"].as_array().unwrap();
    assert_eq!(to, &vec![json!("小B")]);
    assert_eq!(input_count(&pool, b).await, before_b + 1);
    let to_b = inputs_of(&pool, b).await;
    let payload: Value = serde_json::from_str(to_b.last().unwrap()).unwrap();
    let text = payload["text"].as_str().unwrap();
    assert!(text.contains("请接登录"), "{text}");
}

#[tokio::test]
async fn finalize_bot_space_always_addresses_user() {
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
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();
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
    let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
    let member_id = identity::binding_of_conversation(&pool, conversation)
        .await
        .unwrap()
        .expect("identity")
        .member_id;
    let thread_id = identity::direct_thread_id(&member_id);
    let (posted, _, _) = post_direct_message_with(
        &pool,
        PostDirectMessage {
            thread_id: thread_id.clone(),
            content: "帮我检查一下登录流程".to_string(),
            summary: None,
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    mark_processing(&pool, &posted.message_id, conversation).await;
    finalize_space_turn_deliveries(
        &pool,
        conversation,
        "小A: 登录流程正常。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    let space_messages: Vec<(i64, String, String)> = sqlx::query_as(
        r#"SELECT seq, origin, envelope_json
           FROM collaboration_space_messages
           WHERE space_id = ?
           ORDER BY seq ASC"#,
    )
    .bind(&thread_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let fallback = space_messages
        .iter()
        .find(|(_, origin, _)| origin == "agent")
        .expect("agent fallback post");
    let envelope: Value = serde_json::from_str(&fallback.2).unwrap();
    assert_eq!(envelope["content"].as_str().unwrap(), "登录流程正常。");
    assert_eq!(envelope["to"].as_array().unwrap(), &vec![json!("Person")]);
    assert_eq!(envelope["sender"].as_str().unwrap(), "小A");
}

#[tokio::test]
async fn round_delivery_prompt_includes_speaking_order() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    let a_member: String = sqlx::query_scalar(
            "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
        )
        .bind(&space)
        .bind(a.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let multi = post_as(
        &pool,
        None,
        &space,
        "@小C @小B @小A 请依次汇报",
        &["小C", "小B", "小A"],
    )
    .await;
    let texts = inputs_of(&pool, a).await;
    let payload: Value = serde_json::from_str(texts.last().unwrap()).unwrap();
    let text = payload["text"].as_str().unwrap();
    assert!(text.contains("speaking order:"), "{text}");
    assert!(text.contains("@小A (you, now)"), "{text}");
    assert!(text.contains("@小C (waiting)"), "{text}");
    assert!(text.contains("@小B (waiting)"), "{text}");

    mark_processing(&pool, &multi.message_id, a).await;
    finalize_space_turn_deliveries(
        &pool,
        a,
        "我是小A，我的部分已完成。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    let texts_c = inputs_of(&pool, c).await;
    let payload_c: Value = serde_json::from_str(texts_c.last().unwrap()).unwrap();
    let text_c = payload_c["text"].as_str().unwrap();
    assert!(text_c.contains("@小A (posted)"), "{text_c}");
    assert!(text_c.contains("@小C (you, now)"), "{text_c}");
    assert!(text_c.contains("@小B (waiting)"), "{text_c}");
}

#[tokio::test]
async fn new_space_messages_store_flat_envelopes() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请看", &[]).await;
    let raw: String =
        sqlx::query_scalar("SELECT envelope_json FROM collaboration_space_messages WHERE id = ?")
            .bind(&posted.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!raw.contains("activitystreams"), "{raw}");
    assert!(!raw.contains("\"@context\""), "{raw}");
    let envelope: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(envelope["sender"], json!("Person"));
    assert_eq!(envelope["to"], json!(["小A"]));
    assert_eq!(envelope["content"], json!("@小A 请看"));
    assert_eq!(envelope["id"], json!(posted.message_id));
}

#[tokio::test]
async fn group_delivery_prompt_lists_working_peers() {
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
    let first = post_as(&pool, None, &space, "@小A 先做鉴权", &[]).await;
    mark_processing(&pool, &first.message_id, a).await;
    post_as(&pool, None, &space, "@小B 你来看登录", &[]).await;
    let texts = inputs_of(&pool, b).await;
    let payload: Value = serde_json::from_str(texts.last().unwrap()).unwrap();
    let text = payload["text"].as_str().unwrap();
    assert!(text.contains("still at work: @小A (working)"), "{text}");
}

#[tokio::test]
async fn round_grace_period_detaches_and_wakes_the_next_bot() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    let a_member: String = sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&space)
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let before_c = input_count(&pool, c).await;
    let multi = post_as(
        &pool,
        None,
        &space,
        "@小C @小B @小A 请依次汇报",
        &["小C", "小B", "小A"],
    )
    .await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, a).await;
    sqlx::query(
        "UPDATE collaboration_turns SET created_at = '2000-01-01T00:00:00Z' WHERE space_message_id = ? AND conversation_id = ?",
    )
    .bind(&multi.message_id)
    .bind(a.to_string())
    .execute(&pool)
    .await
    .unwrap();

    advance_round(&pool, &round_id, &DeliveryContext::default())
        .await
        .unwrap();

    let ordinal: i64 =
        sqlx::query_scalar("SELECT current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ordinal, 2);
    assert_eq!(input_count(&pool, c).await, before_c + 1);
    let receipts = list_message_receipts(&pool, &multi.message_id)
        .await
        .unwrap();
    let a_receipt = receipts
        .iter()
        .find(|r| r.conversation_id == a.to_string())
        .unwrap();
    assert_eq!(a_receipt.state, "processing");

    finalize_space_turn_deliveries(&pool, a, "鉴权模块完成。", &DeliveryContext::default())
        .await
        .unwrap();
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m.origin == "agent" && m.envelope["content"] == json!("鉴权模块完成。")),
        "{messages:?}"
    );
}

#[tokio::test]
async fn round_progress_post_detaches_without_closing_the_slot() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let a_member: String = sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&space)
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let before_b = input_count(&pool, b).await;
    let multi = post_as(&pool, None, &space, "@小A @小B 请接力", &["小A", "小B"]).await;
    mark_processing(&pool, &multi.message_id, a).await;
    post_as(&pool, Some(a), &space, "正在处理登录", &["User"]).await;

    let receipts = list_message_receipts(&pool, &multi.message_id)
        .await
        .unwrap();
    let a_receipt = receipts
        .iter()
        .find(|r| r.conversation_id == a.to_string())
        .unwrap();
    assert_eq!(a_receipt.state, "processing");
    assert_eq!(input_count(&pool, b).await, before_b + 1);

    finalize_space_turn_deliveries(&pool, a, "登录已修好。", &DeliveryContext::default())
        .await
        .unwrap();
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m.origin == "agent" && m.envelope["content"] == json!("登录已修好。")),
        "{messages:?}"
    );
}

async fn round_slots(pool: &SqlitePool, round_id: &str) -> Vec<(String, i64, String, String)> {
    sqlx::query_as(
        r#"SELECT conversation_id, round_ordinal, receipt_state, space_message_id
           FROM collaboration_space_deliveries
           WHERE round_id = ?
           ORDER BY round_ordinal ASC, conversation_id ASC"#,
    )
    .bind(round_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn bot_mention_during_open_round_splices_next_slot_instead_of_waking_in_parallel() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (arch, coder, qa) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, arch, workspace, Some("Arch")).await;
    create_session(&pool, coder, workspace, Some("Coder")).await;
    create_session(&pool, qa, workspace, Some("QA")).await;
    let space = space_of(&pool, arch).await;
    add_space_member(&pool, arch, &space, coder, "Coder", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, arch, &space, qa, "QA", Uuid::new_v4())
        .await
        .unwrap();

    let before_coder = input_count(&pool, coder).await;
    let before_qa = input_count(&pool, qa).await;
    let multi = post_as(
        &pool,
        None,
        &space,
        "@Arch @Coder 请接力",
        &["Arch", "Coder"],
    )
    .await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, arch).await;

    let handoff = post_as(&pool, Some(arch), &space, "@QA 请先做验收", &["QA"]).await;
    let slots = round_slots(&pool, &round_id).await;
    assert_eq!(slots.len(), 3, "QA must join the open round: {slots:?}");
    assert_eq!(slots[0].0, arch.to_string());
    assert_eq!(slots[0].1, 1);
    assert_eq!(slots[1].0, qa.to_string());
    assert_eq!(slots[1].1, 2);
    assert_eq!(slots[1].3, handoff.message_id);
    assert_eq!(slots[2].0, coder.to_string());
    assert_eq!(slots[2].1, 3);

    let open_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_rounds WHERE space_id = ? AND state = 'open'",
    )
    .bind(&space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(open_count, 1);
    assert_eq!(
        input_count(&pool, qa).await,
        before_qa + 1,
        "spliced QA becomes the next slot and is woken after Arch's handoff detaches"
    );
    assert_eq!(
        input_count(&pool, coder).await,
        before_coder,
        "Coder must not speak in parallel with the spliced QA slot"
    );

    finalize_space_turn_deliveries(&pool, arch, "方案已写完。", &DeliveryContext::default())
        .await
        .unwrap();
    assert_eq!(input_count(&pool, qa).await, before_qa + 1);
    assert_eq!(input_count(&pool, coder).await, before_coder);

    let qa_text = inputs_of(&pool, qa).await;
    let payload: Value = serde_json::from_str(qa_text.last().unwrap()).unwrap();
    let text = payload["text"].as_str().unwrap();
    assert!(text.contains("请先做验收"), "{text}");
    assert!(text.contains("@QA (you, now)"), "{text}");
    assert!(text.contains("@Coder (waiting)"), "{text}");

    mark_processing(&pool, &handoff.message_id, qa).await;
    finalize_space_turn_deliveries(&pool, qa, "验收通过。", &DeliveryContext::default())
        .await
        .unwrap();
    assert_eq!(input_count(&pool, coder).await, before_coder + 1);
}

#[tokio::test]
async fn bot_multi_mention_without_open_round_creates_a_serial_round() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (arch, coder, qa) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, arch, workspace, Some("Arch")).await;
    create_session(&pool, coder, workspace, Some("Coder")).await;
    create_session(&pool, qa, workspace, Some("QA")).await;
    let space = space_of(&pool, arch).await;
    add_space_member(&pool, arch, &space, coder, "Coder", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, arch, &space, qa, "QA", Uuid::new_v4())
        .await
        .unwrap();

    let before_coder = input_count(&pool, coder).await;
    let before_qa = input_count(&pool, qa).await;
    let posted = post_as(
        &pool,
        Some(arch),
        &space,
        "@Coder @QA 请依次实现再验收",
        &["Coder", "QA"],
    )
    .await;

    let round: (String, String, i64) = sqlx::query_as(
        "SELECT id, state, current_ordinal FROM collaboration_rounds WHERE root_message_id = ?",
    )
    .bind(&posted.message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(round.1, "open");
    assert_eq!(round.2, 1);

    let slots = round_slots(&pool, &round.0).await;
    assert_eq!(
        slots
            .iter()
            .map(|(id, ord, _, _)| (id.clone(), *ord))
            .collect::<Vec<_>>(),
        vec![(coder.to_string(), 1), (qa.to_string(), 2)]
    );
    assert_eq!(input_count(&pool, coder).await, before_coder + 1);
    assert_eq!(
        input_count(&pool, qa).await,
        before_qa,
        "QA must wait behind Coder in the bot-started round"
    );

    mark_processing(&pool, &posted.message_id, coder).await;
    finalize_space_turn_deliveries(&pool, coder, "实现完成。", &DeliveryContext::default())
        .await
        .unwrap();
    assert_eq!(input_count(&pool, qa).await, before_qa + 1);
}

#[tokio::test]
async fn person_comment_during_open_round_is_absorbed_without_supersede_or_extra_wake() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (arch, coder) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, arch, workspace, Some("Arch")).await;
    create_session(&pool, coder, workspace, Some("Coder")).await;
    let space = space_of(&pool, arch).await;
    add_space_member(&pool, arch, &space, coder, "Coder", Uuid::new_v4())
        .await
        .unwrap();
    let arch_member: String = sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&space)
    .bind(arch.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(arch_member.as_str()))
        .await
        .unwrap();

    let before_coder = input_count(&pool, coder).await;
    let before_arch = input_count(&pool, arch).await;
    let multi = post_as(
        &pool,
        None,
        &space,
        "@Arch @Coder 请接力",
        &["Arch", "Coder"],
    )
    .await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, arch).await;

    post_as(&pool, None, &space, "补充：注意超时边界", &[]).await;

    let round_state: String =
        sqlx::query_scalar("SELECT state FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(round_state, "open");
    let receipts = list_message_receipts(&pool, &multi.message_id)
        .await
        .unwrap();
    let arch_receipt = receipts
        .iter()
        .find(|r| r.conversation_id == arch.to_string())
        .unwrap();
    assert_eq!(arch_receipt.state, "processing");
    assert_eq!(
        input_count(&pool, arch).await,
        before_arch + 1,
        "Person interrupt must not steer or re-wake the current speaker"
    );
    assert_eq!(
        input_count(&pool, coder).await,
        before_coder,
        "Person interrupt must not wake the next slot immediately"
    );

    finalize_space_turn_deliveries(&pool, arch, "方案已写完。", &DeliveryContext::default())
        .await
        .unwrap();
    assert_eq!(input_count(&pool, coder).await, before_coder + 1);
    let coder_text = inputs_of(&pool, coder).await;
    let payload: Value = serde_json::from_str(coder_text.last().unwrap()).unwrap();
    let text = payload["text"].as_str().unwrap();
    assert!(text.contains("补充：注意超时边界"), "{text}");
}

#[tokio::test]
async fn person_single_mention_during_open_round_splices_instead_of_superseding() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (arch, coder, qa) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, arch, workspace, Some("Arch")).await;
    create_session(&pool, coder, workspace, Some("Coder")).await;
    create_session(&pool, qa, workspace, Some("QA")).await;
    let space = space_of(&pool, arch).await;
    add_space_member(&pool, arch, &space, coder, "Coder", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, arch, &space, qa, "QA", Uuid::new_v4())
        .await
        .unwrap();

    let before_coder = input_count(&pool, coder).await;
    let before_qa = input_count(&pool, qa).await;
    let multi = post_as(
        &pool,
        None,
        &space,
        "@Arch @Coder 请接力",
        &["Arch", "Coder"],
    )
    .await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, arch).await;

    let interrupt = post_as(&pool, None, &space, "@QA 先插一嘴验收标准", &["QA"]).await;
    let round_state: String =
        sqlx::query_scalar("SELECT state FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(round_state, "open");
    let slots = round_slots(&pool, &round_id).await;
    assert_eq!(slots[1].0, qa.to_string());
    assert_eq!(slots[1].1, 2);
    assert_eq!(slots[1].3, interrupt.message_id);
    assert_eq!(slots[2].0, coder.to_string());
    assert_eq!(slots[2].1, 3);
    assert_eq!(input_count(&pool, qa).await, before_qa);
    assert_eq!(input_count(&pool, coder).await, before_coder);

    finalize_space_turn_deliveries(&pool, arch, "方案已写完。", &DeliveryContext::default())
        .await
        .unwrap();
    assert_eq!(input_count(&pool, qa).await, before_qa + 1);
    assert_eq!(input_count(&pool, coder).await, before_coder);
}

#[tokio::test]
async fn mid_turn_tool_call_bubbles_step_text_without_closing_or_duplicating() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let a = Uuid::new_v4();
    create_session(&pool, a, workspace, Some("小A")).await;
    let space = space_of(&pool, a).await;
    let posted = post_as(&pool, None, &space, "@小A 请看登录", &[]).await;
    mark_processing(&pool, &posted.message_id, a).await;
    clear_space_turn_tool_started(a);

    on_space_turn_tool_call(
        &pool,
        a,
        "我先检查一下 auth.rs",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let receipts = list_message_receipts(&pool, &posted.message_id)
        .await
        .unwrap();
    assert_eq!(receipts[0].state, "processing");
    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let step = messages
        .iter()
        .find(|m| m.origin == "agent" && m.envelope["content"] == json!("我先检查一下 auth.rs"))
        .expect("step text must land in the space log");
    assert_eq!(step.envelope["to"], json!(["Person"]));

    on_space_turn_tool_call(
        &pool,
        a,
        "我先检查一下 auth.rs",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    let after_repeat = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let step_count = after_repeat
        .iter()
        .filter(|m| m.origin == "agent" && m.envelope["content"] == json!("我先检查一下 auth.rs"))
        .count();
    assert_eq!(
        step_count, 1,
        "identical mid-turn text must not be posted twice"
    );

    finalize_space_turn_deliveries(&pool, a, "鉴权没有问题。", &DeliveryContext::default())
        .await
        .unwrap();
    let final_messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert_eq!(
        final_messages
            .iter()
            .filter(|m| m.origin == "agent")
            .count(),
        2
    );
    assert!(
        final_messages
            .iter()
            .any(|m| m.origin == "agent" && m.envelope["content"] == json!("鉴权没有问题。")),
        "{final_messages:?}"
    );
    assert!(
        final_messages.iter().all(|m| m.origin != "agent"
            || m.envelope["content"] != json!("我先检查一下 auth.rs\n鉴权没有问题。")),
        "pre-tool step text must not be concatenated into the conclusion"
    );
}

#[tokio::test]
async fn plain_text_round_does_not_detach_within_ten_seconds() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    let a_member: String = sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&space)
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let before_c = input_count(&pool, c).await;
    let multi = post_as(
        &pool,
        None,
        &space,
        "@小C @小B @小A 请依次汇报",
        &["小C", "小B", "小A"],
    )
    .await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, a).await;
    clear_space_turn_tool_started(a);
    let started = chrono::Utc::now() - chrono::Duration::seconds(5);
    sqlx::query(
        "UPDATE collaboration_turns SET created_at = ? WHERE space_message_id = ? AND conversation_id = ?",
    )
    .bind(started.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    .bind(&multi.message_id)
    .bind(a.to_string())
    .execute(&pool)
    .await
    .unwrap();

    advance_round(&pool, &round_id, &DeliveryContext::default())
        .await
        .unwrap();
    let ordinal: i64 =
        sqlx::query_scalar("SELECT current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ordinal, 1, "plain-text generation must not detach at 5s");
    assert_eq!(input_count(&pool, c).await, before_c);
}

#[tokio::test]
async fn open_tool_calls_detach_the_round_without_waiting_for_plain_text() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    create_session(&pool, c, workspace, Some("小C")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
        .await
        .unwrap();
    let a_member: String = sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&space)
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let before_c = input_count(&pool, c).await;
    let multi = post_as(
        &pool,
        None,
        &space,
        "@小C @小B @小A 请依次汇报",
        &["小C", "小B", "小A"],
    )
    .await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, a).await;
    clear_space_turn_tool_started(a);
    let turn_id = mark_running(&pool, a).await;
    sqlx::query(
        r#"INSERT INTO conversation_tool_calls
           (id, conversation_id, turn_id, tool_call_id, status)
           VALUES (?, ?, ?, 'read-auth', 'running')"#,
    )
    .bind(Uuid::new_v4())
    .bind(a)
    .bind(turn_id)
    .execute(&pool)
    .await
    .unwrap();

    advance_round(&pool, &round_id, &DeliveryContext::default())
        .await
        .unwrap();
    let ordinal: i64 =
        sqlx::query_scalar("SELECT current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(ordinal, 2);
    assert_eq!(input_count(&pool, c).await, before_c + 1);
}

#[tokio::test]
async fn in_memory_tool_start_does_not_detach_before_grace() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();
    let a_member: String = sqlx::query_scalar(
        "SELECT member_id FROM collaboration_space_members WHERE space_id = ? AND conversation_id = ?",
    )
    .bind(&space)
    .bind(a.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::collaboration::roles::set_space_lead(&pool, &space, Some(a_member.as_str()))
        .await
        .unwrap();

    let before_b = input_count(&pool, b).await;
    let multi = post_as(&pool, None, &space, "@小A @小B 请接力", &["小A", "小B"]).await;
    let round_id: String =
        sqlx::query_scalar("SELECT id FROM collaboration_rounds WHERE root_message_id = ?")
            .bind(&multi.message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    mark_processing(&pool, &multi.message_id, a).await;
    let started = chrono::Utc::now() - chrono::Duration::seconds(20);
    sqlx::query(
        "UPDATE collaboration_turns SET created_at = ? WHERE space_message_id = ? AND conversation_id = ?",
    )
    .bind(started.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    .bind(&multi.message_id)
    .bind(a.to_string())
    .execute(&pool)
    .await
    .unwrap();
    clear_space_turn_tool_started(a);
    mark_space_turn_tool_started(a);

    advance_round(&pool, &round_id, &DeliveryContext::default())
        .await
        .unwrap();
    let ordinal: i64 =
        sqlx::query_scalar("SELECT current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        ordinal, 1,
        "a just-started tool call must wait for the 3s grace"
    );
    assert_eq!(input_count(&pool, b).await, before_b);
    clear_space_turn_tool_started(a);
}

#[tokio::test]
async fn asked_by_bot_is_the_implicit_recipient_when_reply_has_no_mention() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, a, workspace, Some("小A")).await;
    create_session(&pool, b, workspace, Some("小B")).await;
    let space = space_of(&pool, a).await;
    add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
        .await
        .unwrap();

    let ask = post_as(&pool, Some(a), &space, "@小B 请修登录", &["小B"]).await;
    mark_processing(&pool, &ask.message_id, b).await;
    let before_a = input_count(&pool, a).await;
    finalize_space_turn_deliveries(&pool, b, "登录已修好。", &DeliveryContext::default())
        .await
        .unwrap();

    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    let fallback = messages
        .iter()
        .find(|m| m.origin == "agent" && m.envelope["content"] == json!("登录已修好。"))
        .expect("B's conclusion must be posted");
    assert_eq!(fallback.envelope["to"], json!(["小A"]));
    assert_eq!(fallback.envelope["sender"].as_str().unwrap(), "小B");
    assert_eq!(input_count(&pool, a).await, before_a + 1);
}

#[tokio::test]
async fn queued_follow_up_delivery_survives_turn_one_completion_and_syncs_turn_two_reply() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let bot = Uuid::new_v4();
    create_session(&pool, bot, workspace, Some("小A")).await;
    let space = space_of(&pool, bot).await;

    let msg1 = post_as(&pool, None, &space, "@小A 第一个问题", &["小A"]).await;
    mark_processing(&pool, &msg1.message_id, bot).await;

    // While msg1 is processing, user sends msg2 which stays queued in collaboration_space_deliveries.
    let msg2 = post_as(&pool, None, &space, "@小A 第二个问题", &["小A"]).await;

    let notified = Arc::new(std::sync::Mutex::new(Vec::new()));
    let notified_clone = notified.clone();
    let ctx = DeliveryContext {
        space_changed: Some(Arc::new(move |evt| {
            notified_clone.lock().unwrap().push(evt);
        })),
        ..DeliveryContext::default()
    };

    // Turn 1 finishes: msg1 must be replied, notify_space_changed must fire, and msg2 must remain queued.
    finalize_space_turn_deliveries(&pool, bot, "第一个问题的回答。", &ctx)
        .await
        .unwrap();

    assert!(
        !notified.lock().unwrap().is_empty(),
        "fallback post on turn completion must emit notify_space_changed"
    );

    let state2: String = sqlx::query_scalar(
        "SELECT receipt_state FROM collaboration_space_deliveries WHERE space_message_id = ? AND conversation_id = ?",
    )
    .bind(&msg2.message_id)
    .bind(bot.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        state2, "queued",
        "queued follow-up delivery must not be prematurely closed by Turn 1 completion"
    );

    // Turn 2 now dispatches msg2 and completes.
    mark_processing(&pool, &msg2.message_id, bot).await;
    finalize_space_turn_deliveries(&pool, bot, "第二个问题的回答。", &ctx)
        .await
        .unwrap();

    let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
        .await
        .unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m.origin == "agent" && m.envelope["content"] == json!("第一个问题的回答。")),
        "Turn 1 reply must be in space"
    );
    assert!(
        messages
            .iter()
            .any(|m| m.origin == "agent" && m.envelope["content"] == json!("第二个问题的回答。")),
        "Turn 2 reply must also be synced to space"
    );
}

#[tokio::test]
async fn sequential_round_packs_peer_reply_after_trigger_and_advances_completed_watermark() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (docu, coder) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, docu, workspace, Some("Docu")).await;
    create_session(&pool, coder, workspace, Some("Coder")).await;
    let space = space_of(&pool, docu).await;
    add_space_member(&pool, docu, &space, coder, "Coder", Uuid::new_v4())
        .await
        .unwrap();

    // Person triggers a sequential round: @Docu @Coder
    post_as(&pool, None, &space, "@Docu @Coder 请排查超时配置", &[]).await;

    // Docu finishes slot 1, which posts #2 and wakes Coder for #1
    finalize_space_turn_deliveries(
        &pool,
        docu,
        "文档里定义的字段名是 timeout_ms。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let coder_inputs = inputs_of(&pool, coder).await;
    assert_eq!(coder_inputs.len(), 1);
    let first_payload: Value = serde_json::from_str(&coder_inputs[0]).unwrap();
    let first_text = first_payload["text"].as_str().unwrap();

    // The root trigger message #1 must appear BEFORE Docu's reply #2 in chronological order.
    let trigger_pos = first_text
        .find("请排查超时配置")
        .expect("root trigger message in envelope");
    let peer_reply_pos = first_text
        .find("[#2] Docu: 文档里定义的字段名是 timeout_ms。")
        .expect("Docu's round reply packed in envelope");
    assert!(
        trigger_pos < peer_reply_pos,
        "round peer reply #2 must appear chronologically after root trigger #1:\n{first_text}"
    );

    // Coder finishes slot 2, posting #3.
    finalize_space_turn_deliveries(
        &pool,
        coder,
        "代码侧已统一改为 timeout_ms。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    // Next turn: Person sends #4 to @Coder. Since Coder already saw #2 and authored #3,
    // #2 must NOT be re-packed as missed context on #4.
    post_as(&pool, None, &space, "@Coder 再确认一下默认值", &[]).await;
    let coder_inputs = inputs_of(&pool, coder).await;
    assert_eq!(coder_inputs.len(), 2);
    let second_payload: Value = serde_json::from_str(&coder_inputs[1]).unwrap();
    let second_text = second_payload["text"].as_str().unwrap();
    assert!(
        !second_text.contains("文档里定义的字段名是 timeout_ms。"),
        "already-seen round reply #2 must not be re-packed in subsequent turn:\n{second_text}"
    );
}

#[tokio::test]
async fn group_space_member_session_resolve_and_direct_session_reply_projection() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let dm_cid = Uuid::new_v4();
    create_session(&pool, dm_cid, workspace, Some("Bot A")).await;
    let unassigned = unassigned_space_id(workspace);
    let (_, _, dm_resolved) = identity::bind_seat(&pool, &unassigned, dm_cid, Some("Bot A"))
        .await
        .unwrap();
    let dm_resolved_cid = dm_resolved.conversation_id;

    // Create a GroupSpace and add Bot A using its DM conversation id (`dm_resolved_cid`).
    let creator_cid = Uuid::new_v4();
    create_session(&pool, creator_cid, workspace, Some("Lead")).await;
    let group_space = create_collaboration_space(&pool, creator_cid, "Group 1", Uuid::new_v4())
        .await
        .unwrap();
    let seat = host_add_space_member(
        &pool,
        &group_space.space_id,
        dm_resolved_cid,
        "Bot A",
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    let group_cid = Uuid::parse_str(seat.conversation_id.as_deref().unwrap()).unwrap();
    assert_ne!(
        group_cid, dm_resolved_cid,
        "adding a DM member to a GroupSpace must create an isolated per-space session instead of stealing the DM session"
    );

    // Resolving the session tab by the seat's per-space UUID (`seat.member_id`) must return `group_cid`.
    let resolved_by_seat_id = resolve_thread_session(&pool, &seat.member_id, &group_space.space_id)
        .await
        .unwrap();
    assert_eq!(resolved_by_seat_id, group_cid);

    // Posting `@Bot A` in the GroupSpace routes to `group_cid`.
    let post_res = post_to_space_with(
        &pool,
        PostToSpace {
            caller_id: None,
            space_id: group_space.space_id.clone(),
            content: "@Bot A 请检查构建脚本".to_string(),
            summary: None,
            to: vec![],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    assert_eq!(post_res.receipts.len(), 1);
    assert_eq!(post_res.receipts[0].conversation_id, group_cid);

    let group_inputs = inputs_of(&pool, group_cid).await;
    assert_eq!(group_inputs.len(), 1);

    // Finish the first turn so no space deliveries remain open.
    finalize_space_turn_deliveries(
        &pool,
        group_cid,
        "构建脚本检查完毕。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    // Now simulate the user sending a message directly inside Bot A's GroupSpace session tab
    // (a `conversation_turns` row without `collaboration_space_origin`).
    let direct_turn = db::models::conversation_turn::ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id: group_cid,
            prompt_id: None,
            text_preview: Some("顺便看下环境变量"),
            input_blocks_json: r#"[{"type":"text","text":"顺便看下环境变量"}]"#,
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE conversation_turns SET status = 'completed' WHERE id = ?")
        .bind(direct_turn.id)
        .execute(&pool)
        .await
        .unwrap();

    finalize_space_turn_deliveries(
        &pool,
        group_cid,
        "环境变量 VIBEX_PORT 已配置。",
        &DeliveryContext::default(),
    )
    .await
    .unwrap();

    let messages = list_space_messages(
        &pool,
        &group_space.space_id,
        None,
        None,
        MessageAudience::User,
    )
    .await
    .unwrap();
    assert!(
        messages.iter().any(|m| {
            m.origin == "agent" && m.envelope["content"] == json!("环境变量 VIBEX_PORT 已配置。")
        }),
        "Bot A's reply to a direct session-tab message must also be projected into the GroupSpace"
    );
}

#[tokio::test]
async fn user_mention_during_open_round_queues_delivery_for_currently_speaking_bot() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let (bot_a, bot_b) = (Uuid::new_v4(), Uuid::new_v4());
    create_session(&pool, bot_a, workspace, Some("BotA")).await;
    create_session(&pool, bot_b, workspace, Some("BotB")).await;
    let space = space_of(&pool, bot_a).await;
    add_space_member(&pool, bot_a, &space, bot_b, "BotB", Uuid::new_v4())
        .await
        .unwrap();

    // Start a sequential round with @BotA @BotB so BotA is currently speaking in an open round.
    post_as(&pool, None, &space, "@BotA @BotB 第一轮任务", &[]).await;
    assert_eq!(inputs_of(&pool, bot_a).await.len(), 1);

    // While BotA is still speaking in the open round, user sends a follow-up `@BotA 补充说明`.
    let follow_up = post_to_space_with(
        &pool,
        PostToSpace {
            caller_id: None,
            space_id: space.clone(),
            content: "@BotA 补充说明".to_string(),
            summary: None,
            to: vec!["BotA".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v4(),
        },
        &DeliveryContext::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        follow_up.receipts.len(),
        1,
        "User's explicit @BotA during an open round must create a delivery receipt for BotA"
    );
    assert_eq!(follow_up.receipts[0].conversation_id, bot_a);
}
