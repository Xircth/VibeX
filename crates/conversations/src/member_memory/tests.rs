use super::*;
use crate::collaboration::test_support::{create_session, setup_pool};

struct MockReviewModel {
    response_json: String,
    captured_prompts: std::sync::Mutex<Vec<MemoryReviewPrompt>>,
}

impl MockReviewModel {
    fn new(response_json: impl Into<String>) -> Self {
        Self {
            response_json: response_json.into(),
            captured_prompts: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl MemoryReviewModel for MockReviewModel {
    async fn complete_review(
        &self,
        prompt: &MemoryReviewPrompt,
    ) -> Result<String, CollaborationError> {
        self.captured_prompts.lock().unwrap().push(prompt.clone());
        Ok(self.response_json.clone())
    }
}

#[test]
fn secret_guard_catches_api_keys_passwords_and_long_digits_without_false_positives() {
    assert_eq!(
        contains_secret_or_credential("项目统一使用 pnpm 管理依赖"),
        None
    );
    assert_eq!(
        contains_secret_or_credential("私聊里帮用户查了工资单密码。"),
        None
    );
    assert_eq!(
        contains_secret_or_credential("OpenAI key: sk-1234567890abcdefghijklmnop"),
        Some("api_key_prefix")
    );
    assert_eq!(
        contains_secret_or_credential("GitHub token ghp_1234567890abcdefghijklmnopqrstuv"),
        Some("api_key_prefix")
    );
    assert_eq!(
        contains_secret_or_credential("数据库的 password = SuperSecret99"),
        Some("credential_assignment")
    );
    assert_eq!(
        contains_secret_or_credential("测试服登录密码是 Admin8888"),
        Some("credential_assignment_zh")
    );
    assert_eq!(
        contains_secret_or_credential("卡号 6222021234567890123"),
        Some("long_digit_sequence")
    );
}

#[tokio::test]
async fn unified_space_memory_syncs_markdown_topics_journal_and_natural_language_ask() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let conv = Uuid::new_v4();
    create_session(&pool, conv, workspace, Some("Hailer")).await;
    let _ = crate::collaboration::test_support::space_of(&pool, conv).await;
    let member_id = identity::member_id_for_conversation(conv);
    let space_id = format!("direct:{member_id}");

    // 1. Secret write is rejected
    let secret_err = add_space_fact(
        &pool,
        &space_id,
        Some(&member_id),
        "生产环境密码是 P@ssw0rd123",
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(secret_err.code, "secret_rejected");

    // 2. Ask bar instruction adds a fact directly into MEMORY.md
    let added = ask_space_memory(
        &pool,
        &space_id,
        Some(&member_id),
        "记住：所有账单邮件归入 Finance 标签并静默归档",
    )
    .await
    .unwrap();
    assert_eq!(added.changes.len(), 1);
    assert_eq!(added.changes[0].op, "add");
    let fact_id = added.changes[0].fact_id.unwrap();

    // 3. Topic creation and MEMORY.md ## Index sync
    let topic = write_space_topic(
        &space_id,
        "mail-templates",
        Some("商务邮件回复模板"),
        "对外商务邮件统一使用英文签名档，并在末尾附带团队日历链接。",
        "user",
    )
    .unwrap();
    assert_eq!(topic.topic, "mail-templates");

    let view = view_space_memory(&pool, &space_id, Some(&member_id))
        .await
        .unwrap();
    assert_eq!(view.facts.len(), 1);
    assert_eq!(view.topics.len(), 1);
    assert!(!view.journal.is_empty());

    let md = std::fs::read_to_string(&view.memory_file_path).unwrap();
    assert!(md.contains("所有账单邮件归入 Finance 标签并静默归档"));
    assert!(md.contains("[[topic:mail-templates]]"));

    // 4. Hand-edit MEMORY.md directly on disk and verify it is authoritative (never overwritten by SQLite)
    let manual_md = format!(
        "# Memory\n\n- 手动在文件中添加的排期规则：每周三下午 3 点进行架构评审\n{}",
        md.trim_start_matches("# Memory").trim_start()
    );
    std::fs::write(&view.memory_file_path, manual_md).unwrap();
    let after_manual = view_space_memory(&pool, &space_id, Some(&member_id))
        .await
        .unwrap();
    assert_eq!(
        after_manual.facts.len(),
        2,
        "hand-edited bullet in MEMORY.md must be parsed and preserved"
    );
    assert!(
        after_manual
            .facts
            .iter()
            .any(|f| f.content.contains("每周三下午 3 点进行架构评审"))
    );

    // 5. Ask bar instruction edits the fact in place inside MEMORY.md
    let edited = ask_space_memory(
        &pool,
        &space_id,
        Some(&member_id),
        &format!("把 #{fact_id} 改成：账单邮件统一归入 Billing 标签"),
    )
    .await
    .unwrap();
    assert_eq!(edited.changes.len(), 1);
    assert_eq!(edited.changes[0].op, "edit");
    assert!(
        edited
            .view
            .facts
            .iter()
            .any(|f| f.content == "账单邮件统一归入 Billing 标签")
    );

    // 6. Ask bar Q&A searches facts from MEMORY.md
    let qa = ask_space_memory(&pool, &space_id, Some(&member_id), "账单邮件怎么处理？")
        .await
        .unwrap();
    assert!(qa.reply.contains("Billing 标签"));
}

#[tokio::test]
async fn model_driven_review_applies_add_edit_and_remove_on_space_memory_md() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let conv = Uuid::new_v4();
    create_session(&pool, conv, workspace, Some("ReviewerBot")).await;
    let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;
    let member_id = identity::member_id_for_conversation(conv);

    // Seed 2 initial entries in the group space's MEMORY.md
    let f1 = add_space_fact(
        &pool,
        &group_space_id,
        Some(&member_id),
        "对外接口默认使用 snake_case",
        Some("thread"),
    )
    .await
    .unwrap();
    let f2 = add_space_fact(
        &pool,
        &group_space_id,
        Some(&member_id),
        "临时调试开关开启 verbose 日志",
        Some("thread"),
    )
    .await
    .unwrap();
    assert_ne!(f1.id, f2.id);

    let (entries, memory_chars) =
        collect_numbered_space_entries(&group_space_id, &member_id, false);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].entry_number, 1);
    assert_eq!(entries[1].entry_number, 2);

    // Model reviews the numbered entries and returns add + edit [1] + remove [2] + secret (which must be rejected)
    let model = MockReviewModel::new(
        r#"```json
        {
          "changes": [
            {"op": "edit", "entry": 1, "text": "对外接口统一改为 camelCase 命名"},
            {"op": "remove", "entry": 2},
            {"op": "add", "text": "所有 PR 合并前必须通过 clippy 与 vitest 检查"},
            {"op": "add", "text": "生产密码是 SuperSecret999"}
          ]
        }
        ```"#,
    );

    let prompt = MemoryReviewPrompt {
        space_id: group_space_id.clone(),
        member_id: member_id.clone(),
        conversation_id: Some(conv),
        system_prompt: build_review_system_prompt(&member_id, &group_space_id, false),
        user_prompt: build_review_user_prompt(
            &group_space_id,
            &entries,
            memory_chars,
            &[],
            &["User: 从现在起接口改用 camelCase，去掉临时 verbose 日志，并且 PR 必须跑 clippy 和 vitest。".to_string()],
        ),
    };
    let raw = model.complete_review(&prompt).await.unwrap();
    let parsed_changes = parse_review_response(&raw).unwrap();
    assert_eq!(parsed_changes.len(), 4);

    let applied = apply_review_changes(
        &pool,
        &group_space_id,
        &member_id,
        false,
        &entries,
        &parsed_changes,
    )
    .await
    .unwrap();
    assert_eq!(
        applied.len(),
        3,
        "secret add must be filtered out while edit/remove/valid add succeed"
    );

    let updated_facts = list_thread_facts(&pool, &group_space_id).await.unwrap();
    let texts: Vec<&str> = updated_facts.iter().map(|f| f.content.as_str()).collect();
    assert!(texts.contains(&"对外接口统一改为 camelCase 命名"));
    assert!(texts.contains(&"所有 PR 合并前必须通过 clippy 与 vitest 检查"));
    assert!(!texts.iter().any(|t| t.contains("verbose 日志")));
    assert!(!texts.iter().any(|t| t.contains("SuperSecret999")));
}

async fn seed_conversation_turns(pool: &SqlitePool, conv_id: Uuid, message_texts: &[&str]) {
    use agents::conversation::{ConversationEvent, ConversationInputBlock};
    use db::models::{
        conversation_event::{AppendConversationEvent, ConversationEventRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };

    for table in [
        "conversation_events",
        "conversation_turns",
        "conversation_timeline_rows",
        "conversation_projection_snapshots",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE conversation_id = ?"))
            .bind(conv_id)
            .execute(pool)
            .await
            .unwrap();
    }

    let mut current_turn_id: Option<Uuid> = None;
    for (idx, text) in message_texts.iter().enumerate() {
        let is_user = idx % 2 == 0;
        if is_user {
            let round_idx = idx / 2;
            let turn_id = Uuid::new_v5(&conv_id, format!("seed-round-{round_idx}").as_bytes());
            ConversationTurnRecord::create_pending(
                pool,
                turn_id,
                CreateConversationTurn {
                    conversation_id: conv_id,
                    prompt_id: None,
                    text_preview: Some(text),
                    input_blocks_json: "[]",
                },
            )
            .await
            .unwrap();
            let ev = ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: (*text).to_string(),
                }],
                workflow_refs: Vec::new(),
            };
            ConversationEventRecord::append(
                pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: conv_id,
                    turn_id: Some(turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "user",
                    event_kind: "user_turn_created",
                    normalized_json: &serde_json::to_string(&ev).unwrap(),
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .unwrap();
            current_turn_id = Some(turn_id);
        } else if let Some(turn_id) = current_turn_id {
            let delta = ConversationEvent::AssistantTextDelta {
                text: (*text).to_string(),
                message_id: Some(format!("msg-{}", idx + 1)),
            };
            ConversationEventRecord::append(
                pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: conv_id,
                    turn_id: Some(turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "acp",
                    event_kind: "assistant_text_delta",
                    normalized_json: &serde_json::to_string(&delta).unwrap(),
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .unwrap();
            let completed = ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            };
            ConversationEventRecord::append(
                pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: conv_id,
                    turn_id: Some(turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "acp",
                    event_kind: "turn_completed",
                    normalized_json: &serde_json::to_string(&completed).unwrap(),
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .unwrap();
            let _ =
                ConversationTurnRecord::mark_completed(pool, turn_id, Some("end_turn"), None, None)
                    .await;
        }
    }

    crate::ConversationProjector::rebuild_projection(pool, conv_id)
        .await
        .unwrap();
    let _ = sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 1 WHERE id = ?")
        .bind(conv_id)
        .execute(pool)
        .await;
}

#[test]
fn parse_review_response_handles_malformed_inputs_caps_at_eight_and_filters_invalid_entries() {
    // 1. Empty / whitespace returns empty Vec
    assert!(parse_review_response("").unwrap().is_empty());
    assert!(parse_review_response("   \n\t  ").unwrap().is_empty());

    // 2. Prose without JSON object returns Err
    let no_json = parse_review_response("No memory changes are needed for this turn.");
    assert!(no_json.is_err());

    // 3. Truncated / broken JSON returns Err
    let broken_json = parse_review_response(r#"{"changes": [{"op": "add", "text": "broken"#);
    assert!(broken_json.is_err());
    let reversed_braces = parse_review_response("} invalid {");
    assert!(reversed_braces.is_err());

    // 4. Empty changes array or missing changes key returns empty Vec
    assert!(
        parse_review_response(r#"{"changes": []}"#)
            .unwrap()
            .is_empty()
    );
    assert!(
        parse_review_response(r#"{"other": 123}"#)
            .unwrap()
            .is_empty()
    );

    // 5. Out-of-bounds entry 0, negative entry, empty text, and unknown ops are filtered out,
    //    and valid changes are capped at 8 even when > 8 valid changes are present.
    let over_eight = r#"{
        "changes": [
            {"op": "edit", "entry": 0, "text": "entry 0 must be ignored"},
            {"op": "remove", "entry": 0},
            {"op": "edit", "entry": -2, "text": "negative entry must fail deserialization"},
            {"op": "add", "text": "   "},
            {"op": "unknown_op", "text": "ignored"},
            {"op": "add", "text": "fact 1"},
            {"op": "add", "text": "fact 2"},
            {"op": "edit", "entry": 1, "text": "fact 3"},
            {"op": "remove", "entry": 2},
            {"op": "add", "text": "fact 5"},
            {"op": "add", "text": "fact 6"},
            {"op": "add", "text": "fact 7"},
            {"op": "add", "text": "fact 8"},
            {"op": "add", "text": "fact 9 should be truncated"},
            {"op": "add", "text": "fact 10 should be truncated"}
        ]
    }"#;
    let parsed = parse_review_response(over_eight).unwrap();
    assert_eq!(parsed.len(), 8, "must cap valid review changes at 8");
    assert_eq!(
        parsed[0],
        MemoryReviewChange::Add {
            text: "fact 1".to_string(),
            topic: None,
            scope: None,
        }
    );
    assert_eq!(
        parsed[2],
        MemoryReviewChange::Edit {
            entry: 1,
            text: "fact 3".to_string(),
        }
    );
    assert_eq!(parsed[3], MemoryReviewChange::Remove { entry: 2 });
    assert_eq!(
        parsed[7],
        MemoryReviewChange::Add {
            text: "fact 8".to_string(),
            topic: None,
            scope: None,
        }
    );
}

#[tokio::test]
async fn apply_review_changes_ignores_out_of_bounds_entry_even_when_matching_fact_id() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let conv = Uuid::new_v4();
    create_session(&pool, conv, workspace, Some("BoundsBot")).await;
    let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;
    let member_id = identity::member_id_for_conversation(conv);

    let f1 = add_space_fact(
        &pool,
        &group_space_id,
        Some(&member_id),
        "第一条保留规则",
        Some("thread"),
    )
    .await
    .unwrap();
    let f2 = add_space_fact(
        &pool,
        &group_space_id,
        Some(&member_id),
        "第二条保留规则",
        Some("thread"),
    )
    .await
    .unwrap();

    let (entries, _) = collect_numbered_space_entries(&group_space_id, &member_id, false);
    assert_eq!(entries.len(), 2);

    // Attempt to edit and remove out-of-bounds entry numbers (including f1.id as usize if > 2, and 999)
    let bogus_entry = (f1.id.unsigned_abs() as usize).max(99);
    let changes = vec![
        MemoryReviewChange::Edit {
            entry: bogus_entry,
            text: "绝不该生效的越界修改".to_string(),
        },
        MemoryReviewChange::Remove { entry: bogus_entry },
        MemoryReviewChange::Remove { entry: 3 },
        MemoryReviewChange::Add {
            text: "x".repeat(MEMORY_ENTRY_MAX_CHARS + 1),
            topic: None,
            scope: None,
        },
    ];

    let applied = apply_review_changes(
        &pool,
        &group_space_id,
        &member_id,
        false,
        &entries,
        &changes,
    )
    .await
    .unwrap();
    assert!(
        applied.is_empty(),
        "out-of-bounds entry numbers and >300-char adds must not apply any change"
    );

    let remaining = list_thread_facts(&pool, &group_space_id).await.unwrap();
    assert_eq!(remaining.len(), 2);
    assert!(
        remaining
            .iter()
            .any(|f| f.id == f1.id && f.content == "第一条保留规则")
    );
    assert!(
        remaining
            .iter()
            .any(|f| f.id == f2.id && f.content == "第二条保留规则")
    );
}

#[tokio::test]
async fn memory_write_enforces_300_char_limit_across_all_write_paths() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let conv = Uuid::new_v4();
    create_session(&pool, conv, workspace, Some("LimitBot")).await;
    let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;
    let member_id = identity::member_id_for_conversation(conv);

    let exact_300 = "规".repeat(MEMORY_ENTRY_MAX_CHARS);
    let over_300 = "规".repeat(MEMORY_ENTRY_MAX_CHARS + 1);

    // 1. Bot manual `tool_write` with 301 chars is rejected
    let err_write = tool_write(&pool, conv, &over_300, Some("thread"))
        .await
        .unwrap_err();
    assert_eq!(err_write.code, "bad_request");
    assert!(
        err_write.message.contains("300"),
        "expected 300-char limit error, got: {}",
        err_write.message
    );

    // 2. Bot `tool_write_with_options` (add) with 301 chars is rejected
    let err_opts = tool_write_with_options(
        &pool,
        conv,
        ToolWriteOptions {
            content: over_300.clone(),
            scope: Some("thread".to_string()),
            op: Some("add".to_string()),
            fact_id: None,
            topic: None,
            title: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err_opts.code, "bad_request");

    // 3. Exact 300 chars via `tool_write` succeeds
    let ok_fact = tool_write(&pool, conv, &exact_300, Some("thread"))
        .await
        .unwrap();
    assert_eq!(ok_fact.content.chars().count(), MEMORY_ENTRY_MAX_CHARS);

    // 4. Bot `tool_write_with_options` (replace/edit) with 301 chars is rejected
    let err_replace = tool_write_with_options(
        &pool,
        conv,
        ToolWriteOptions {
            content: over_300.clone(),
            scope: None,
            op: Some("replace".to_string()),
            fact_id: Some(ok_fact.id),
            topic: None,
            title: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err_replace.code, "bad_request");

    // 5. Direct `add_space_fact` and `update_fact` also enforce 300 chars
    assert!(
        add_space_fact(&pool, &group_space_id, Some(&member_id), &over_300, None)
            .await
            .is_err()
    );
    assert!(
        update_fact(&pool, &member_id, ok_fact.id, Some(&over_300), None)
            .await
            .is_err()
    );
}

struct FailableReviewModel {
    responses: std::sync::Mutex<std::collections::VecDeque<Result<String, CollaborationError>>>,
    prompts: std::sync::Mutex<Vec<MemoryReviewPrompt>>,
}

impl FailableReviewModel {
    fn new(responses: Vec<Result<String, CollaborationError>>) -> Self {
        Self {
            responses: std::sync::Mutex::new(responses.into()),
            prompts: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn call_count(&self) -> usize {
        self.prompts.lock().unwrap().len()
    }
}

#[async_trait::async_trait]
impl MemoryReviewModel for FailableReviewModel {
    async fn complete_review(
        &self,
        prompt: &MemoryReviewPrompt,
    ) -> Result<String, CollaborationError> {
        self.prompts.lock().unwrap().push(prompt.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(r#"{"changes": []}"#.to_string()))
    }
}

#[tokio::test]
async fn review_requires_30_new_messages_advances_cursor_and_preserves_cursor_on_failure() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let conv = Uuid::new_v4();
    create_session(&pool, conv, workspace, Some("ThresholdBot")).await;
    let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;

    let model = FailableReviewModel::new(vec![
        Ok(
            r#"{"changes": [{"op": "add", "text": "满 30 条增量消息后沉淀的团队规范"}]}"#
                .to_string(),
        ),
        Err(CollaborationError::new(
            "model_failed",
            "simulated review error",
        )),
        Ok("not valid json at all".to_string()),
        Ok(
            r#"{"changes": [{"op": "edit", "entry": 1, "text": "满 60 条消息后更新的团队规范"}]}"#
                .to_string(),
        ),
    ]);

    // 1. Seed 29 messages (< MEMORY_REVIEW_MIN_NEW_MESSAGES = 30): must skip model call & keep cursor at 0
    let msgs_29: Vec<String> = (1..=29).map(|i| format!("讨论消息 {i}")).collect();
    let refs_29: Vec<&str> = msgs_29.iter().map(String::as_str).collect();
    seed_conversation_turns(&pool, conv, &refs_29).await;

    let res_under = review_conversation_memory_with_model(&pool, conv, &model)
        .await
        .unwrap();
    assert!(res_under.is_empty());
    assert_eq!(
        model.call_count(),
        0,
        "must not call model before 30 new messages"
    );
    let state_before = read_space_review_state(&group_space_id);
    assert_eq!(state_before.last_turn_count, 0);
    assert!(state_before.last_turn_id.is_none());

    // 2. Seed 30th message: triggers review, applies change, and advances cursor to 30
    let msgs_30: Vec<String> = (1..=30).map(|i| format!("讨论消息 {i}")).collect();
    let refs_30: Vec<&str> = msgs_30.iter().map(String::as_str).collect();
    seed_conversation_turns(&pool, conv, &refs_30).await;

    let res_30 = review_conversation_memory_with_model(&pool, conv, &model)
        .await
        .unwrap();
    assert_eq!(res_30.len(), 1);
    assert_eq!(model.call_count(), 1);
    let state_30 = read_space_review_state(&group_space_id);
    assert_eq!(state_30.last_turn_count, 30);
    assert!(state_30.last_turn_id.is_some());
    let saved_turn_id_30 = state_30.last_turn_id.clone();

    // 3. Seed 45 messages (only 15 new since cursor at 30): must skip review and keep cursor at 30
    let msgs_45: Vec<String> = (1..=45).map(|i| format!("讨论消息 {i}")).collect();
    let refs_45: Vec<&str> = msgs_45.iter().map(String::as_str).collect();
    seed_conversation_turns(&pool, conv, &refs_45).await;

    let res_45 = review_conversation_memory_with_model(&pool, conv, &model)
        .await
        .unwrap();
    assert!(res_45.is_empty());
    assert_eq!(
        model.call_count(),
        1,
        "only 15 new messages since last review; must skip"
    );
    assert_eq!(read_space_review_state(&group_space_id).last_turn_count, 30);

    // 4. Seed 60 messages (30 new since cursor at 30), but model fails and then returns bad JSON:
    //    cursor must remain at 30 (neither advance to 60 nor regress to 0)
    let msgs_60: Vec<String> = (1..=60).map(|i| format!("讨论消息 {i}")).collect();
    let refs_60: Vec<&str> = msgs_60.iter().map(String::as_str).collect();
    seed_conversation_turns(&pool, conv, &refs_60).await;

    assert!(
        review_conversation_memory_with_model(&pool, conv, &model)
            .await
            .is_err()
    );
    let state_after_err = read_space_review_state(&group_space_id);
    assert_eq!(state_after_err.last_turn_count, 30);
    assert_eq!(state_after_err.last_turn_id, saved_turn_id_30);

    assert!(
        review_conversation_memory_with_model(&pool, conv, &model)
            .await
            .is_err()
    );
    let state_after_bad_json = read_space_review_state(&group_space_id);
    assert_eq!(state_after_bad_json.last_turn_count, 30);
    assert_eq!(state_after_bad_json.last_turn_id, saved_turn_id_30);

    // 5. Retry when model succeeds: reviews turns 31..60, edits entry [1], and advances cursor to 60
    let res_60 = review_conversation_memory_with_model(&pool, conv, &model)
        .await
        .unwrap();
    assert_eq!(res_60.len(), 1);
    assert_eq!(res_60[0].op, "edit");
    let state_60 = read_space_review_state(&group_space_id);
    assert_eq!(state_60.last_turn_count, 60);
    assert_ne!(state_60.last_turn_id, saved_turn_id_30);

    let facts = list_thread_facts(&pool, &group_space_id).await.unwrap();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].content, "满 60 条消息后更新的团队规范");
}

#[tokio::test]
async fn concurrent_space_reviews_serialize_and_preserve_multi_member_cursors() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let conv_a = Uuid::new_v4();
    let conv_b = Uuid::new_v4();
    create_session(&pool, conv_a, workspace, Some("BotA")).await;
    create_session(&pool, conv_b, workspace, Some("BotB")).await;
    let group_space_id = crate::collaboration::test_support::space_of(&pool, conv_a).await;

    // Add BotB into the same group space using `add_space_member`
    crate::collaboration::add_space_member(
        &pool,
        conv_a,
        &group_space_id,
        conv_b,
        "BotB",
        Uuid::new_v4(),
    )
    .await
    .unwrap();

    // Seed 16 turns in conv_a and 16 turns in conv_b (total 32 new turns across the group space >= 30)
    let msgs_a: Vec<String> = (1..=16).map(|i| format!("BotA 会话消息 {i}")).collect();
    let refs_a: Vec<&str> = msgs_a.iter().map(String::as_str).collect();
    seed_conversation_turns(&pool, conv_a, &refs_a).await;

    let msgs_b: Vec<String> = (1..=16).map(|i| format!("BotB 会话消息 {i}")).collect();
    let refs_b: Vec<&str> = msgs_b.iter().map(String::as_str).collect();
    seed_conversation_turns(&pool, conv_b, &refs_b).await;

    let model = FailableReviewModel::new(vec![
        Ok(r#"{"changes": [{"op": "add", "text": "并发审查只落盘一次的共享记忆"}]}"#.to_string()),
        Ok(r#"{"changes": [{"op": "add", "text": "不应触发的第二次重复审查"}]}"#.to_string()),
    ]);

    // Fire two concurrent reviews on conv_a and conv_b simultaneously
    let (res_a, res_b) = tokio::join!(
        review_conversation_memory_with_model(&pool, conv_a, &model),
        review_conversation_memory_with_model(&pool, conv_b, &model),
    );
    let applied_a = res_a.unwrap();
    let applied_b = res_b.unwrap();

    // Exactly ONE of the two concurrent calls should have reviewed the 32 messages;
    // the second one sees the updated cursors (0 new messages) and skips model invocation!
    assert_eq!(
        model.call_count(),
        1,
        "same batch of messages across concurrent group members must only be reviewed once"
    );
    assert_eq!(applied_a.len() + applied_b.len(), 1);

    let state = read_space_review_state(&group_space_id);
    assert_eq!(
        state
            .conversations
            .get(&conv_a.to_string())
            .map(|c| c.last_turn_count),
        Some(16)
    );
    assert_eq!(
        state
            .conversations
            .get(&conv_b.to_string())
            .map(|c| c.last_turn_count),
        Some(16)
    );
}

struct MockSessionDriver {
    prepare_count: std::sync::atomic::AtomicUsize,
    run_count: std::sync::atomic::AtomicUsize,
    discard_count: std::sync::atomic::AtomicUsize,
    fail_on_run: std::sync::atomic::AtomicUsize,
}

impl MockSessionDriver {
    fn new(fail_on_run: usize) -> Self {
        Self {
            prepare_count: std::sync::atomic::AtomicUsize::new(0),
            run_count: std::sync::atomic::AtomicUsize::new(0),
            discard_count: std::sync::atomic::AtomicUsize::new(0),
            fail_on_run: std::sync::atomic::AtomicUsize::new(fail_on_run),
        }
    }
}

#[async_trait::async_trait]
impl ReviewSessionDriver for MockSessionDriver {
    async fn resolve_agent_id(
        &self,
        _prompt: &MemoryReviewPrompt,
    ) -> Result<agents::AgentId, CollaborationError> {
        Ok(agents::AgentId::parse("codex").unwrap())
    }

    async fn is_session_alive(&self, _session: &ResidentReviewSession) -> bool {
        true
    }

    async fn prepare_session(
        &self,
        agent_id: &agents::AgentId,
        _space_id: &str,
    ) -> Result<ResidentReviewSession, CollaborationError> {
        self.prepare_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(ResidentReviewSession {
            agent_id: agent_id.clone(),
            session_id: agents::AgentSessionId::from(Uuid::new_v4()),
            connection_id: agents::AgentConnectionId::from(Uuid::new_v4()),
            review_count: 0,
        })
    }

    async fn touch_session(&self, _session: &ResidentReviewSession) {}

    async fn discard_session(&self, _session: &ResidentReviewSession) {
        self.discard_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    async fn run_prompt(
        &self,
        _session: &ResidentReviewSession,
        _combined_prompt: String,
    ) -> Result<String, CollaborationError> {
        let run_idx = self
            .run_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if run_idx == self.fail_on_run.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(CollaborationError::new(
                "review_model_timeout",
                "simulated timeout",
            ));
        }
        Ok(r#"{"changes": []}"#.to_string())
    }
}

#[tokio::test]
async fn resident_review_session_pool_reuses_live_session_and_evicts_on_failure() {
    let pool = ResidentReviewSessionPool::default();
    // Fail on the 3rd run
    let driver = MockSessionDriver::new(3);
    let prompt = MemoryReviewPrompt {
        space_id: "space-1".to_string(),
        member_id: "member-reuse-1".to_string(),
        conversation_id: None,
        system_prompt: "sys".to_string(),
        user_prompt: "usr".to_string(),
    };

    // Run 1 & Run 2 reuse the exact same resident session
    assert!(pool.complete_with_driver(&driver, &prompt).await.is_ok());
    assert!(pool.complete_with_driver(&driver, &prompt).await.is_ok());
    assert_eq!(
        driver
            .prepare_count
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "must prepare session only once across multiple reviews"
    );
    assert_eq!(
        driver.run_count.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert_eq!(
        driver
            .discard_count
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    // Run 3 fails -> evicts and discards the resident session
    assert!(pool.complete_with_driver(&driver, &prompt).await.is_err());
    assert_eq!(
        driver
            .discard_count
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "failed review turn must evict and discard broken session"
    );

    // Run 4 prepares a fresh resident session
    assert!(pool.complete_with_driver(&driver, &prompt).await.is_ok());
    assert_eq!(
        driver
            .prepare_count
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[tokio::test]
async fn private_chat_facts_and_topics_never_leak_into_group_space() {
    let pool = setup_pool().await;
    let workspace = Uuid::new_v4();
    let group_conv = Uuid::new_v4();
    let private_conv = Uuid::new_v4();
    create_session(&pool, group_conv, workspace, Some("PrivacyBot")).await;
    create_session(&pool, private_conv, workspace, Some("PrivacyBotDirect")).await;

    let group_space_id = crate::collaboration::test_support::space_of(&pool, group_conv).await;
    let member_id = identity::member_id_for_conversation(group_conv);
    let direct_space_id = format!("direct:{member_id}");

    // Bind `private_conv` to a private direct thread for the same `member_id`
    let private_thread_id = identity::direct_thread_id(&member_id);
    sqlx::query(
        "INSERT INTO collaboration_threads (id, kind, title, created_at) VALUES (?, 'direct', '', '2026-10-24T00:00:00Z')",
    )
    .bind(&private_thread_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, joined_at) VALUES (?, ?, ?, '2026-10-24T00:00:00Z')",
    )
    .bind(&private_thread_id)
    .bind(&member_id)
    .bind(private_conv.to_string())
    .execute(&pool)
    .await
    .unwrap();

    // 1. Write a private fact and a private topic in `direct:<member_id>`
    let priv_fact = create_fact(
        &pool,
        &member_id,
        "私聊专属秘密：下周三准备个人晋升述职材料",
        &FactScope::Private,
        Some(&private_thread_id),
        "user",
    )
    .await
    .unwrap();
    assert_eq!(priv_fact.scope, "private");

    write_space_topic(
        &direct_space_id,
        "personal-notes",
        Some("个人私密笔记"),
        "这是仅私聊可见的个人复盘内容",
        "user",
    )
    .unwrap();

    // 2. Group space view, group MEMORY.md, group memory_context_text, and group tool_search must NEVER see private fact or private topic
    let group_view = view_space_memory(&pool, &group_space_id, None)
        .await
        .unwrap();
    assert!(
        !group_view
            .facts
            .iter()
            .any(|f| f.content.contains("个人晋升述职材料")),
        "private fact must never appear in group SpaceMemoryView"
    );
    assert!(
        !group_view
            .topics
            .iter()
            .any(|t| t.topic == "personal-notes"),
        "private topic must never appear in group SpaceMemoryView"
    );

    let group_ctx = memory_context_text(&pool, group_conv, None, 10)
        .await
        .unwrap();
    if let Some(ctx_text) = group_ctx {
        assert!(!ctx_text.contains("个人晋升述职材料"));
        assert!(!ctx_text.contains("personal-notes"));
    }

    let search_res = tool_search_with_topic(&pool, group_conv, "晋升述职", None, 20)
        .await
        .unwrap();
    assert_eq!(search_res["facts"].as_array().unwrap().len(), 0);
    assert!(
        !search_res["topics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["topic"] == "personal-notes")
    );
    assert!(
        tool_search_with_topic(&pool, group_conv, "", Some("personal-notes"), 10)
            .await
            .is_err(),
        "recalling a private topic from a group thread must be denied"
    );

    // 3. Attempting to write a `private` scope fact from a group conversation is rejected
    assert!(
        tool_write(
            &pool,
            group_conv,
            "试图从群聊写入私聊作用域",
            Some("private")
        )
        .await
        .is_err()
    );
}
