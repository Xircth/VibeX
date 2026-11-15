use std::{str::FromStr, time::Duration as StdDuration};

use agents::{AgentId, ConversationInputPayload};
use chrono::{Duration, Utc};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord},
    conversation_event::AppendConversationEvent,
    conversation_input::ConversationInputRecord,
    conversation_steering::ConversationSteeringRecord,
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tempfile::TempDir;
use uuid::Uuid;

use super::{
    CancelConversationInput, ConversationInputControl, ConversationInputControlError,
    ConversationInputEvent, ConversationInputQueue, ConversationInputStatus,
    MAX_CONVERSATION_INPUT_BYTES, ReorderConversationInput, SubmitConversationInput,
    UpdateConversationInput,
};
use crate::{ConversationEventAppender, ConversationProjector};

fn submitted(input_id: Uuid, sort_key: i64) -> ConversationInputEvent {
    ConversationInputEvent::Submitted {
        input_id,
        operation_id: Uuid::new_v4(),
        revision: 1,
        sort_key,
        payload_digest: format!("digest-{input_id}"),
        payload: payload("hello"),
        principal: serde_json::json!({ "kind": "test" }),
    }
}

fn payload(text: &str) -> ConversationInputPayload {
    ConversationInputPayload {
        continuation_policy: None,
        expected_binding_revision: None,
        agent_id: AgentId::parse("codex").expect("agent id"),
        workspace_id: Uuid::new_v4(),
        executor_profile_id: None,
        text: text.to_string(),
        display_text: None,
        images: Vec::new(),
        mode_override: None,
        config_overrides: Vec::new(),
        workflow_refs: Vec::new(),
        file_refs: Vec::new(),
        internal_prompt_contributions: Vec::new(),
        collaboration_origin: None,
    }
}

async fn setup_pool() -> sqlx::SqlitePool {
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
        .expect("disable foreign keys for focused projection test");
    pool
}

async fn setup_multi_connection_pool() -> (TempDir, sqlx::SqlitePool) {
    let temporary = TempDir::new().expect("temporary sqlite directory");
    let database_path = temporary.path().join("conversation-claims.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&database_path)
        .create_if_missing(true)
        .foreign_keys(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(StdDuration::from_secs(5));
    let migration_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options.clone())
        .await
        .expect("connect migration db");
    sqlx::migrate!("../db/migrations")
        .run(&migration_pool)
        .await
        .expect("run migrations");
    migration_pool.close().await;
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("PRAGMA foreign_keys = OFF")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .expect("connect multi-connection db");
    (temporary, pool)
}

#[test]
fn rebuilds_multiple_inputs_in_stable_queue_order() {
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let queue = ConversationInputQueue::rebuild([
        submitted(second, 20),
        submitted(first, 10),
        ConversationInputEvent::Reordered {
            input_id: second,
            revision: 2,
            sort_key: 5,
        },
    ])
    .expect("valid event history");

    assert_eq!(queue.queued_ids(), vec![second, first]);
}

#[test]
fn claimed_input_cannot_be_edited() {
    let input_id = Uuid::new_v4();
    let claim_token = Uuid::new_v4();
    let mut queue =
        ConversationInputQueue::rebuild([submitted(input_id, 10)]).expect("submitted input");
    queue
        .apply(ConversationInputEvent::Claimed {
            input_id,
            claim_token,
            claim_deadline: Utc::now() + Duration::seconds(30),
        })
        .expect("claim queued input");

    let error = queue
        .apply(ConversationInputEvent::Updated {
            input_id,
            revision: 2,
            payload_digest: "changed".to_string(),
            payload: payload("changed"),
        })
        .expect_err("claimed inputs are immutable");

    assert_eq!(
        queue.get(input_id).unwrap().status,
        ConversationInputStatus::Claimed
    );
    assert!(error.to_string().contains("queued"));
}

#[test]
fn dispatch_requires_the_active_claim_token() {
    let input_id = Uuid::new_v4();
    let claim_token = Uuid::new_v4();
    let turn_id = Uuid::new_v4();
    let mut queue = ConversationInputQueue::rebuild([
        submitted(input_id, 10),
        ConversationInputEvent::Claimed {
            input_id,
            claim_token,
            claim_deadline: Utc::now() + Duration::seconds(30),
        },
    ])
    .expect("claimed input");

    let error = queue
        .apply(ConversationInputEvent::Dispatched {
            input_id,
            claim_token: Uuid::new_v4(),
            turn_id,
        })
        .expect_err("a competing dispatcher cannot consume the claim");

    assert!(error.to_string().contains("claim token"));
    assert_eq!(
        queue.get(input_id).unwrap().status,
        ConversationInputStatus::Claimed
    );
}

#[test]
fn mutations_require_the_next_revision() {
    let input_id = Uuid::new_v4();
    let mut queue =
        ConversationInputQueue::rebuild([submitted(input_id, 10)]).expect("submitted input");

    let error = queue
        .apply(ConversationInputEvent::Cancelled {
            input_id,
            revision: 3,
        })
        .expect_err("revision gaps are conflicts");

    assert!(error.to_string().contains("revision 2"));
    assert_eq!(
        queue.get(input_id).unwrap().status,
        ConversationInputStatus::Queued
    );
}

#[tokio::test]
async fn event_append_and_rebuild_are_the_input_projection_authority() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let input_id = Uuid::new_v4();
    let event = agents::ConversationEvent::ConversationInput {
        event: ConversationInputEvent::Submitted {
            input_id,
            operation_id: Uuid::new_v4(),
            revision: 1,
            sort_key: 1024,
            payload_digest: "digest".to_string(),
            payload: payload("persist me"),
            principal: serde_json::json!({ "kind": "test" }),
        },
    };
    let normalized = serde_json::to_string(&event).expect("serialize input event");
    ConversationEventAppender::append(
        &pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "user",
            event_kind: "conversation_input",
            normalized_json: &normalized,
            raw_json: None,
            idempotency_key: Some(&format!("input:{input_id}:submitted")),
        },
    )
    .await
    .expect("append input event");

    let projected = ConversationInputRecord::find_by_id(&pool, input_id)
        .await
        .expect("read input projection")
        .expect("input projected from event");
    assert_eq!(projected.status, "queued");

    sqlx::query("DELETE FROM conversation_inputs WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("simulate lost projection");
    ConversationProjector::rebuild_projection(&pool, conversation_id)
        .await
        .expect("rebuild projection");
    assert!(
        ConversationInputRecord::find_by_id(&pool, input_id)
            .await
            .expect("read rebuilt input")
            .is_some()
    );
}

#[tokio::test]
async fn steering_receipt_rebuilds_from_requested_and_terminal_events() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    let expected_turn_id = Uuid::new_v4();
    let steering_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");

    for (event, key) in [
        (
            agents::ConversationEvent::ConversationSteering {
                event: agents::ConversationSteeringEvent::Requested {
                    steering_id,
                    operation_id: Uuid::new_v4(),
                    expected_turn_id,
                    payload_digest: "digest".to_string(),
                    blocks: vec![agents::ConversationInputBlock::Text {
                        text: "focus the failing test".to_string(),
                    }],
                    principal: serde_json::json!({ "kind": "test" }),
                },
            },
            "requested",
        ),
        (
            agents::ConversationEvent::ConversationSteering {
                event: agents::ConversationSteeringEvent::Accepted {
                    steering_id,
                    expected_turn_id,
                    delivery_mode: Some(agents::ConversationSteeringDeliveryMode::Native),
                    restarted_turn_id: None,
                },
            },
            "accepted",
        ),
    ] {
        let normalized = serde_json::to_string(&event).expect("serialize steering event");
        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(expected_turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user",
                event_kind: "conversation_steering",
                normalized_json: &normalized,
                raw_json: None,
                idempotency_key: Some(&format!("steering:{steering_id}:{key}")),
            },
        )
        .await
        .expect("append steering event");
    }

    assert_eq!(
        ConversationSteeringRecord::find_by_id(&pool, conversation_id, steering_id)
            .await
            .expect("read receipt")
            .expect("projected receipt")
            .status,
        "accepted"
    );
    sqlx::query("DELETE FROM conversation_steering WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("drop projection");
    ConversationProjector::rebuild_projection(&pool, conversation_id)
        .await
        .expect("rebuild projection");
    let rebuilt = ConversationSteeringRecord::find_by_id(&pool, conversation_id, steering_id)
        .await
        .expect("read rebuilt receipt")
        .expect("rebuilt receipt");
    assert_eq!(rebuilt.status, "accepted");
    assert_eq!(rebuilt.delivery_mode.as_deref(), Some("native"));
}

#[tokio::test]
async fn submit_is_idempotent_and_rejects_operation_payload_conflicts() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let operation_id = Uuid::new_v4();
    let control = ConversationInputControl::new(pool.clone());
    let original_payload: ConversationInputPayload =
        serde_json::from_value(serde_json::json!({
            "agentId": "codex", "workspaceId": Uuid::new_v4(), "text": "hello",
            "continuationPolicy": "portable", "expectedBindingRevision": 0
        }))
        .unwrap();

    let first = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id,
            payload: original_payload.clone(),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("first submit");
    sqlx::query("UPDATE sessions SET binding_revision = 1 WHERE id = ?")
        .bind(conversation_id)
        .execute(&pool)
        .await
        .unwrap();
    let retry = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id,
            payload: original_payload.clone(),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("idempotent retry");
    assert_eq!(retry.id, first.id);

    let stale = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: original_payload.clone(),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await;
    assert!(
        stale.is_err(),
        "a new operation must not accept a stale binding revision"
    );
    let mut changed_policy = original_payload.clone();
    changed_policy.continuation_policy = Some(agents::conversation::ContinuationPolicy::Fresh);
    assert!(matches!(
        control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: changed_policy,
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await,
        Err(ConversationInputControlError::OperationConflict { .. })
    ));

    let principal_conflict = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id,
            payload: original_payload.clone(),
            principal: serde_json::json!({ "kind": "different-user" }),
        })
        .await
        .expect_err("an operation id cannot be replayed by another principal");
    assert!(matches!(
        principal_conflict,
        ConversationInputControlError::OperationConflict { .. }
    ));

    let mut conflicting_payload = original_payload;
    conflicting_payload.text = "different".to_string();
    let conflict = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id,
            payload: conflicting_payload,
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect_err("same operation cannot change payload");
    assert!(matches!(
        conflict,
        ConversationInputControlError::OperationConflict { .. }
    ));
    assert_eq!(
        control
            .list(conversation_id)
            .await
            .expect("list inputs")
            .len(),
        1
    );
}

#[tokio::test]
async fn oversized_input_is_rejected_before_it_reaches_the_event_log() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool.clone());
    let error = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload(&"x".repeat(MAX_CONVERSATION_INPUT_BYTES)),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect_err("oversized input must fail closed");
    assert!(matches!(
        error,
        ConversationInputControlError::InputTooLarge { .. }
    ));
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .expect("count events");
    assert_eq!(events, 0);
}

#[tokio::test]
async fn queued_inputs_can_be_updated_reordered_and_cancelled_with_revisions() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool);
    let queued = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("first"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit input");

    let updated = control
        .update(UpdateConversationInput {
            conversation_id,
            input_id: queued.id,
            operation_id: Uuid::new_v4(),
            expected_revision: 1,
            payload: payload("edited"),
            delay_seconds: None,
        })
        .await
        .expect("update queued input");
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.payload.text, "edited");

    let reordered = control
        .reorder(ReorderConversationInput {
            conversation_id,
            input_id: queued.id,
            operation_id: Uuid::new_v4(),
            expected_revision: 2,
            sort_key: -100,
        })
        .await
        .expect("reorder queued input");
    assert_eq!(reordered.revision, 3);
    assert_eq!(reordered.sort_key, -100);

    let cancelled = control
        .cancel(CancelConversationInput {
            conversation_id,
            input_id: queued.id,
            operation_id: Uuid::new_v4(),
            expected_revision: 3,
        })
        .await
        .expect("cancel queued input");
    assert_eq!(cancelled.revision, 4);
    assert_eq!(cancelled.status, ConversationInputStatus::Cancelled);
}

#[tokio::test]
async fn promote_to_front_and_submit_at_front_place_target_before_existing_queue() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool);
    let first = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("msg 1"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit msg 1");
    let second = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("msg 2"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit msg 2");
    let third = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("msg 3"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit msg 3");

    let promote_op = Uuid::new_v4();
    let promoted = control
        .promote_to_front(conversation_id, third.id, promote_op, Some(1))
        .await
        .expect("promote msg 3");
    assert!(promoted.sort_key < first.sort_key);
    assert_eq!(promoted.revision, 2);

    // Retry with the same operation_id is idempotent even after revision bumped.
    let retry = control
        .promote_to_front(conversation_id, third.id, promote_op, Some(1))
        .await
        .expect("retry promote msg 3");
    assert_eq!(retry.id, third.id);
    assert_eq!(retry.sort_key, promoted.sort_key);

    // Direct composer steer via submit_at_front lands ahead of even the promoted item.
    let front_direct = control
        .submit_at_front(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("urgent steer"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit at front");
    assert!(front_direct.sort_key < promoted.sort_key);

    let ordered_ids: Vec<Uuid> = control
        .list(conversation_id)
        .await
        .expect("list queue")
        .into_iter()
        .map(|view| view.id)
        .collect();
    assert_eq!(ordered_ids, vec![front_direct.id, third.id, first.id, second.id]);
}

#[tokio::test]
async fn cancel_queued_cancels_waiting_inputs_and_leaves_claimed_alone() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool);
    let first = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("first"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit first");
    let second = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("second"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit second");
    control
        .claim_next(conversation_id, Duration::seconds(30))
        .await
        .expect("claim first")
        .expect("queued input to claim");

    let cancelled = control
        .cancel_queued(conversation_id)
        .await
        .expect("cancel remaining queued inputs");
    assert_eq!(cancelled, 1);

    let listed = control.list(conversation_id).await.expect("list inputs");
    let first_status = listed
        .iter()
        .find(|input| input.id == first.id)
        .expect("first input")
        .status;
    let second_status = listed
        .iter()
        .find(|input| input.id == second.id)
        .expect("second input")
        .status;
    assert_eq!(first_status, ConversationInputStatus::Claimed);
    assert_eq!(second_status, ConversationInputStatus::Cancelled);
}

#[tokio::test]
async fn input_mutation_cannot_cross_conversation_scope() {
    let pool = setup_pool().await;
    let first_conversation = Uuid::new_v4();
    let second_conversation = Uuid::new_v4();
    for conversation_id in [first_conversation, second_conversation] {
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
    }
    let control = ConversationInputControl::new(pool);
    let input = control
        .submit(SubmitConversationInput {
            conversation_id: first_conversation,
            operation_id: Uuid::new_v4(),
            payload: payload("protected"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit input");

    let error = control
        .reorder(ReorderConversationInput {
            conversation_id: second_conversation,
            input_id: input.id,
            operation_id: Uuid::new_v4(),
            expected_revision: 1,
            sort_key: 1,
        })
        .await
        .expect_err("cross-conversation mutation must fail closed");
    assert!(matches!(
        error,
        ConversationInputControlError::StateConflict { .. }
    ));
    assert_eq!(
        control
            .find(first_conversation, input.id)
            .await
            .expect("original input")
            .revision,
        1
    );
}

#[tokio::test]
async fn claim_next_is_an_event_sourced_single_consumer_decision() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool.clone());
    let queued = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("claim me"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit input");

    let claim = control
        .claim_next(conversation_id, Duration::seconds(30))
        .await
        .expect("claim query")
        .expect("queued input");
    assert_eq!(claim.input.id, queued.id);
    assert_eq!(claim.input.status, ConversationInputStatus::Claimed);
    assert_eq!(claim.input.claim_token, Some(claim.claim_token));
    assert!(
        control
            .claim_next(conversation_id, Duration::seconds(30))
            .await
            .expect("second claim query")
            .is_none(),
        "a second dispatcher cannot claim the same input"
    );

    let claimed_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_events \
         WHERE conversation_id = ? AND event_kind = 'conversation_input' \
         AND normalized_json LIKE '%\"kind\":\"claimed\"%'",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .expect("count claim events");
    assert_eq!(claimed_events, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_multi_connection_claim_stress_has_exactly_one_winner() {
    let (_temporary, pool) = setup_multi_connection_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool.clone());
    control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("claim once"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit input");

    let mut claims = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let control = control.clone();
        claims.spawn(async move {
            control
                .claim_next(conversation_id, Duration::seconds(30))
                .await
        });
    }
    let mut winners = 0;
    while let Some(result) = claims.join_next().await {
        if result.expect("claim task").expect("claim query").is_some() {
            winners += 1;
        }
    }
    assert_eq!(winners, 1);

    let claimed_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_events
         WHERE conversation_id = ? AND event_kind = 'conversation_input'
           AND normalized_json LIKE '%\"kind\":\"claimed\"%'",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .expect("count claim events");
    assert_eq!(claimed_events, 1);
}

#[tokio::test]
async fn previous_process_claims_are_released_even_when_the_deadline_has_not_elapsed() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool.clone());
    let queued = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("resume after restart"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit input");
    control
        .claim_next(conversation_id, Duration::seconds(30))
        .await
        .expect("claim query")
        .expect("claimed input");

    assert!(
        ConversationInputRecord::queued_conversation_ids(&pool)
            .await
            .expect("queued conversation ids")
            .is_empty(),
        "a live claim must not look like a queued input to startup dispatch"
    );

    let released = control
        .recover_orphaned_unsubmitted_claims()
        .await
        .expect("recover orphaned claims");
    assert_eq!(released, 1);
    assert_eq!(
        control
            .find(conversation_id, queued.id)
            .await
            .expect("recovered input")
            .status,
        ConversationInputStatus::Queued
    );
    assert_eq!(
        ConversationInputRecord::queued_conversation_ids(&pool)
            .await
            .expect("queued conversation ids"),
        vec![conversation_id]
    );
}

#[tokio::test]
async fn stale_claim_recovery_appends_release_event_before_requeueing() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool.clone());
    let queued = control
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("recover me"),
            principal: serde_json::json!({ "kind": "test" }),
        })
        .await
        .expect("submit input");
    let claim = control
        .claim_next(conversation_id, Duration::milliseconds(1))
        .await
        .expect("claim query")
        .expect("claimed input");
    assert_eq!(claim.input.id, queued.id);

    let released = control
        .recover_stale_claims(Utc::now() + Duration::seconds(1))
        .await
        .expect("recover stale claims");
    assert_eq!(released, 1);
    assert_eq!(
        control
            .find(conversation_id, queued.id)
            .await
            .expect("recovered input")
            .status,
        ConversationInputStatus::Queued
    );
    let release_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_events \
         WHERE conversation_id = ? \
         AND normalized_json LIKE '%\"kind\":\"claim_released\"%'",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .expect("count release events");
    assert_eq!(release_events, 1);
    assert!(
        control
            .claim_next(conversation_id, Duration::seconds(30))
            .await
            .expect("claim after recover")
            .is_some(),
        "released claims must be claimable again without waiting for process restart"
    );
}

#[tokio::test]
async fn concurrent_submits_allocate_distinct_order_inside_the_append_transaction() {
    let pool = setup_pool().await;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .expect("create conversation");
    let control = ConversationInputControl::new(pool);
    let first = control.submit(SubmitConversationInput {
        conversation_id,
        operation_id: Uuid::new_v4(),
        payload: payload("first"),
        principal: serde_json::json!({ "kind": "test" }),
    });
    let second = control.submit(SubmitConversationInput {
        conversation_id,
        operation_id: Uuid::new_v4(),
        payload: payload("second"),
        principal: serde_json::json!({ "kind": "test" }),
    });
    let (first, second) = tokio::join!(first, second);
    first.expect("first concurrent submit");
    second.expect("second concurrent submit");

    let inputs = control.list(conversation_id).await.expect("ordered inputs");
    assert_eq!(inputs.len(), 2);
    assert_ne!(inputs[0].sort_key, inputs[1].sort_key);
    assert!(inputs[0].sort_key < inputs[1].sort_key);
}

#[test]
#[ignore = "fixed-fixture capacity gate; run explicitly before release"]
fn rebuilds_ten_thousand_input_events_with_one_thousand_queued_inputs() {
    let started = std::time::Instant::now();
    let mut events = Vec::with_capacity(10_000);
    let mut ids = Vec::with_capacity(1_000);
    for index in 0..1_000 {
        let input_id = Uuid::new_v4();
        ids.push(input_id);
        events.push(ConversationInputEvent::Submitted {
            input_id,
            operation_id: Uuid::new_v4(),
            revision: 1,
            sort_key: i64::from(index) * 1_024,
            payload_digest: format!("digest-{index}-1"),
            payload: payload("capacity fixture"),
            principal: serde_json::json!({"kind": "capacity"}),
        });
    }
    for revision in 2..=10 {
        for (index, input_id) in ids.iter().copied().enumerate() {
            events.push(ConversationInputEvent::Reordered {
                input_id,
                revision,
                sort_key: i64::try_from(index).unwrap() * 1_024,
            });
        }
    }

    let queue = ConversationInputQueue::rebuild(events).expect("capacity fixture is valid");
    let ordered = queue.queued_ids();
    let elapsed = started.elapsed();
    assert_eq!(ordered.len(), 1_000);
    assert_eq!(ordered.first(), ids.first());
    assert_eq!(ordered.last(), ids.last());
    assert!(
        elapsed < StdDuration::from_secs(2),
        "10k-event queue rebuild exceeded 2s: {elapsed:?}"
    );
    eprintln!(
        "conversation_capacity events=10000 queued=1000 elapsed_ms={}",
        elapsed.as_millis()
    );
}
