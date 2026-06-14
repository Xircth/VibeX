use std::collections::BTreeMap;

use agents::conversation::{
    ContentBlock, ConversationDelegationView, ConversationErrorView, ConversationEvent,
    ConversationPermissionView, ConversationSessionNotice, ConversationTerminalView,
    ConversationTimeline, ConversationTimelineRow, MessageTurn, PlanEntry, TurnRole, TurnUsage,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    conversation_event::{AppendConversationEvent, ConversationEventRecord},
    conversation_side_effects::{
        ConversationFileChangeRecord, ConversationPermissionRecord, ConversationTerminalRecord,
        InsertConversationFileChange, UpsertConversationPermission, UpsertConversationTerminal,
    },
    conversation_tool::{ConversationToolCallRecord, UpsertConversationToolCall},
    conversation_turn::ConversationTurnRecord,
};

pub const CONVERSATION_PROJECTION_VERSION: u32 = 1;

pub struct ConversationEventAppender;

impl ConversationEventAppender {
    pub async fn append(
        pool: &SqlitePool,
        input: AppendConversationEvent<'_>,
    ) -> Result<ConversationEventRecord, sqlx::Error> {
        let record = ConversationEventRecord::append(pool, input).await?;
        ConversationStateApplier::apply_record(pool, &record).await?;
        Ok(record)
    }
}

pub struct ConversationStateApplier;

impl ConversationStateApplier {
    pub async fn apply_record(
        pool: &SqlitePool,
        record: &ConversationEventRecord,
    ) -> Result<(), sqlx::Error> {
        let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) else {
            return Ok(());
        };

        match event {
            ConversationEvent::UserTurnQueued => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_queued(pool, turn_id).await?;
                }
            }
            ConversationEvent::UserTurnStarted => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_running(pool, turn_id).await?;
                }
            }
            ConversationEvent::TurnBlocked { .. } => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_blocked(pool, turn_id).await?;
                }
            }
            ConversationEvent::TurnCompleted { stop_reason } => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_completed(
                        pool,
                        turn_id,
                        stop_reason.as_deref(),
                        None,
                        None,
                    )
                    .await?;
                }
            }
            ConversationEvent::TurnFailed { error } => {
                if let Some(turn_id) = record.turn_id {
                    let error_json =
                        serde_json::to_string(&error).unwrap_or_else(|_| "{}".to_string());
                    ConversationTurnRecord::mark_failed(pool, turn_id, &error_json).await?;
                }
            }
            ConversationEvent::TurnCancelled { reason } => {
                if let Some(turn_id) = record.turn_id {
                    let reason_json =
                        reason.map(|message| serde_json::json!({ "message": message }).to_string());
                    ConversationTurnRecord::mark_cancelled(pool, turn_id, reason_json.as_deref())
                        .await?;
                }
            }
            ConversationEvent::ToolCallUpsert { tool_call } => {
                if let Some(turn_id) = record.turn_id {
                    let raw_input_json = json_string_ref(&tool_call.raw_input);
                    let raw_output_json = json_string_ref(&tool_call.raw_output);
                    let content_json = json_string_ref(&tool_call.content);
                    let locations_json = json_string_ref(&tool_call.locations);
                    let metadata_json = json_string_ref(&tool_call.metadata);
                    let images_json = if tool_call.images.is_empty() {
                        None
                    } else {
                        serde_json::to_string(&tool_call.images).ok()
                    };
                    ConversationToolCallRecord::upsert(
                        pool,
                        UpsertConversationToolCall {
                            id: Uuid::new_v4(),
                            conversation_id: record.conversation_id,
                            turn_id,
                            tool_call_id: &tool_call.tool_call_id,
                            title: tool_call.title.as_deref(),
                            kind: tool_call.kind.as_deref(),
                            status: tool_call.status.as_deref().unwrap_or("running"),
                            raw_input_json: raw_input_json.as_deref(),
                            raw_output_json: raw_output_json.as_deref(),
                            content_json: content_json.as_deref(),
                            locations_json: locations_json.as_deref(),
                            metadata_json: metadata_json.as_deref(),
                            images_json: images_json.as_deref(),
                        },
                    )
                    .await?;
                }
            }
            ConversationEvent::PermissionRequested { request } => {
                if let Some(turn_id) = record.turn_id {
                    let details_json = request
                        .request
                        .details
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .unwrap_or_else(|_| Some("{}".to_string()))
                        .unwrap_or_else(|| "{}".to_string());
                    let options_json = serde_json::to_string(&request.request.options)
                        .unwrap_or_else(|_| "[]".to_string());
                    ConversationPermissionRecord::upsert_pending(
                        pool,
                        UpsertConversationPermission {
                            id: Uuid::new_v4(),
                            conversation_id: record.conversation_id,
                            turn_id,
                            permission_id: &request.permission_id,
                            title: Some(&request.request.title),
                            details_json: &details_json,
                            options_json: &options_json,
                            auto: false,
                        },
                    )
                    .await?;
                }
            }
            ConversationEvent::PermissionResponded {
                permission_id,
                response,
            } => {
                let response_json =
                    serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string());
                ConversationPermissionRecord::respond(
                    pool,
                    record.conversation_id,
                    &permission_id,
                    &response_json,
                )
                .await?;
            }
            ConversationEvent::TerminalUpdated { terminal } => {
                if let Some(turn_id) = record.turn_id {
                    let args_json =
                        serde_json::to_string(&terminal.args).unwrap_or_else(|_| "[]".to_string());
                    let exit_status_json = json_string_ref(&terminal.exit_status);
                    ConversationTerminalRecord::upsert(
                        pool,
                        UpsertConversationTerminal {
                            id: Uuid::new_v4(),
                            conversation_id: record.conversation_id,
                            turn_id,
                            terminal_id: &terminal.terminal_id,
                            command: terminal.command.as_deref(),
                            args_json: &args_json,
                            cwd: terminal.cwd.as_deref(),
                            status: &terminal.status,
                            output_summary: terminal.output_summary.as_deref(),
                            output_truncated: terminal.output_truncated,
                            exit_status_json: exit_status_json.as_deref(),
                        },
                    )
                    .await?;
                }
            }
            ConversationEvent::FileChangeSummaryUpdated { summary } => {
                if let Some(turn_id) = record.turn_id {
                    for file in summary.files {
                        ConversationFileChangeRecord::insert(
                            pool,
                            InsertConversationFileChange {
                                id: Uuid::new_v4(),
                                conversation_id: record.conversation_id,
                                turn_id,
                                source: &summary.source,
                                path: &file.path,
                                change_kind: &file.change_kind,
                                additions: file.additions,
                                deletions: file.deletions,
                                old_path: file.old_path.as_deref(),
                                diff_summary_json: summary.summary.as_deref(),
                            },
                        )
                        .await?;
                    }
                }
            }
            _ => {}
        }

        Ok(())
    }
}

pub struct ConversationProjector;

impl ConversationProjector {
    pub async fn project(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<ConversationTimeline, sqlx::Error> {
        let events =
            ConversationEventRecord::events_since(pool, conversation_id, 0, i64::MAX).await?;
        Ok(Self::project_records(conversation_id, &events))
    }

    pub fn project_records(
        conversation_id: Uuid,
        records: &[ConversationEventRecord],
    ) -> ConversationTimeline {
        let mut turns: BTreeMap<Uuid, ProjectedTurn> = BTreeMap::new();
        let mut turn_order: Vec<Uuid> = Vec::new();
        let mut side_rows: Vec<ConversationTimelineRow> = Vec::new();
        let mut last_sequence = 0;

        for record in records {
            last_sequence = last_sequence.max(record.sequence);
            let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json)
            else {
                continue;
            };

            match event {
                ConversationEvent::UserTurnCreated { blocks } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        let turn = turns.get_mut(&turn_id).expect("turn exists");
                        turn.user.blocks = blocks
                            .into_iter()
                            .filter_map(|block| match block {
                                agents::conversation::ConversationInputBlock::Text { text } => {
                                    Some(ContentBlock::Text { text })
                                }
                                agents::conversation::ConversationInputBlock::Image {
                                    uri,
                                    mime_type,
                                    ..
                                } => Some(ContentBlock::Image {
                                    data: String::new(),
                                    mime_type,
                                    uri: Some(uri),
                                }),
                                agents::conversation::ConversationInputBlock::Resource {
                                    ..
                                } => None,
                            })
                            .collect();
                    }
                }
                ConversationEvent::AssistantTextDelta { text, .. } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        let turn = turns.get_mut(&turn_id).expect("turn exists");
                        append_text_block(&mut turn.assistant.blocks, text);
                    }
                }
                ConversationEvent::AssistantReasoningDelta { text, .. } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        let turn = turns.get_mut(&turn_id).expect("turn exists");
                        append_thinking_block(&mut turn.assistant.blocks, text);
                    }
                }
                ConversationEvent::PlanUpdated { entries } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        let turn = turns.get_mut(&turn_id).expect("turn exists");
                        turn.assistant.blocks.push(ContentBlock::Plan {
                            entries: entries
                                .into_iter()
                                .map(|entry| PlanEntry {
                                    content: entry.content,
                                    status: entry.status,
                                    priority: entry.priority,
                                })
                                .collect(),
                        });
                    }
                }
                ConversationEvent::ToolCallUpsert { tool_call } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        let turn = turns.get_mut(&turn_id).expect("turn exists");
                        turn.assistant.blocks.push(ContentBlock::ToolUse {
                            tool_use_id: Some(tool_call.tool_call_id.clone()),
                            tool_name: tool_call
                                .title
                                .or(tool_call.kind)
                                .unwrap_or(tool_call.tool_call_id),
                            input_preview: tool_call.raw_input.map(|value| value.to_string()),
                            meta: tool_call.metadata,
                        });
                        if let Some(output) = tool_call.raw_output {
                            turn.assistant.blocks.push(ContentBlock::ToolResult {
                                tool_use_id: None,
                                output_preview: Some(output.to_string()),
                                is_error: matches!(tool_call.status.as_deref(), Some("failed")),
                                agent_stats: None,
                            });
                        }
                    }
                }
                ConversationEvent::UsageUpdated { usage } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        let turn = turns.get_mut(&turn_id).expect("turn exists");
                        turn.assistant.usage = Some(TurnUsage {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            cache_creation_input_tokens: usage.cache_creation_input_tokens,
                            cache_read_input_tokens: usage.cache_read_input_tokens,
                        });
                    }
                }
                ConversationEvent::TurnCompleted { .. } => {
                    if let Some(turn_id) = record.turn_id {
                        ensure_turn(&mut turns, &mut turn_order, turn_id, record);
                        turns.get_mut(&turn_id).expect("turn exists").phase = "settled".into();
                    }
                }
                ConversationEvent::PermissionRequested { request } => {
                    side_rows.push(ConversationTimelineRow::PermissionRequest {
                        request: ConversationPermissionView {
                            permission_id: request.permission_id,
                            title: Some(request.request.title),
                            status: "pending".into(),
                        },
                    });
                }
                ConversationEvent::QuestionRequested { request } => {
                    side_rows.push(ConversationTimelineRow::QuestionRequest { request });
                }
                ConversationEvent::FeedbackRequested { request } => {
                    side_rows.push(ConversationTimelineRow::FeedbackRequest { request });
                }
                ConversationEvent::TerminalUpdated { terminal } => {
                    side_rows.push(ConversationTimelineRow::TerminalSummary {
                        terminal: ConversationTerminalView {
                            terminal_id: terminal.terminal_id,
                            command: terminal.command,
                            status: terminal.status,
                            output_summary: terminal.output_summary,
                            output_truncated: terminal.output_truncated,
                        },
                    });
                }
                ConversationEvent::DelegationStarted { delegation } => {
                    side_rows.push(ConversationTimelineRow::Delegation {
                        delegation: ConversationDelegationView {
                            delegation_id: delegation.delegation_id,
                            parent_tool_call_id: Some(delegation.parent_tool_call_id),
                            child_conversation_id: Some(delegation.child_conversation_id),
                            agent_type: Some(delegation.agent_type),
                            task_preview: Some(delegation.task_preview),
                            status: "running".into(),
                            result: None,
                        },
                    });
                }
                ConversationEvent::DelegationCompleted {
                    delegation_id,
                    result,
                } => {
                    side_rows.push(ConversationTimelineRow::Delegation {
                        delegation: ConversationDelegationView {
                            delegation_id,
                            parent_tool_call_id: None,
                            child_conversation_id: None,
                            agent_type: None,
                            task_preview: None,
                            status: "completed".into(),
                            result: Some(result),
                        },
                    });
                }
                ConversationEvent::FileChangeSummaryUpdated { summary } => {
                    side_rows.push(ConversationTimelineRow::FileChangeSummary { summary });
                }
                ConversationEvent::TurnFailed { error } => {
                    side_rows.push(ConversationTimelineRow::TurnError {
                        error: ConversationErrorView {
                            turn_id: record.turn_id,
                            error,
                        },
                    });
                }
                ConversationEvent::AgentBindingLoadFailed { reason } => {
                    side_rows.push(ConversationTimelineRow::SessionNotice {
                        notice: ConversationSessionNotice {
                            title: "Agent session load failed".into(),
                            message: Some(format!("{reason:?}")),
                            severity: "warning".into(),
                        },
                    });
                }
                ConversationEvent::AgentBindingRecoveryFailed { reason } => {
                    side_rows.push(ConversationTimelineRow::SessionNotice {
                        notice: ConversationSessionNotice {
                            title: "Agent session recovery failed".into(),
                            message: Some(reason),
                            severity: "error".into(),
                        },
                    });
                }
                ConversationEvent::SessionConfigStale { stale, reason } => {
                    if stale {
                        side_rows.push(ConversationTimelineRow::SessionNotice {
                            notice: ConversationSessionNotice {
                                title: "Agent configuration changed".into(),
                                message: reason,
                                severity: "info".into(),
                            },
                        });
                    }
                }
                ConversationEvent::RawDiagnosticRecorded { label } => {
                    side_rows.push(ConversationTimelineRow::SessionNotice {
                        notice: ConversationSessionNotice {
                            title: "Agent diagnostic".into(),
                            message: Some(label),
                            severity: "info".into(),
                        },
                    });
                }
                _ => {}
            }
        }

        let mut rows = Vec::new();
        for turn_id in turn_order {
            if let Some(turn) = turns.remove(&turn_id) {
                rows.push(ConversationTimelineRow::MessageTurn {
                    turn: turn.user,
                    phase: turn.phase.clone(),
                });
                if !turn.assistant.blocks.is_empty() {
                    rows.push(ConversationTimelineRow::MessageTurn {
                        turn: turn.assistant,
                        phase: turn.phase,
                    });
                }
            }
        }
        rows.extend(side_rows);

        ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence,
            rows,
        }
    }
}

struct ProjectedTurn {
    user: MessageTurn,
    assistant: MessageTurn,
    phase: String,
}

fn ensure_turn(
    turns: &mut BTreeMap<Uuid, ProjectedTurn>,
    turn_order: &mut Vec<Uuid>,
    turn_id: Uuid,
    record: &ConversationEventRecord,
) {
    if turns.contains_key(&turn_id) {
        return;
    }

    turn_order.push(turn_id);
    turns.insert(
        turn_id,
        ProjectedTurn {
            user: MessageTurn {
                id: format!("{turn_id}:user"),
                role: TurnRole::User,
                blocks: Vec::new(),
                timestamp: record.created_at,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
            },
            assistant: MessageTurn {
                id: format!("{turn_id}:assistant"),
                role: TurnRole::Assistant,
                blocks: Vec::new(),
                timestamp: record.created_at,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
            },
            phase: "streaming".into(),
        },
    );
}

fn append_text_block(blocks: &mut Vec<ContentBlock>, text: String) {
    if let Some(ContentBlock::Text { text: existing }) = blocks.last_mut() {
        existing.push_str(&text);
    } else {
        blocks.push(ContentBlock::Text { text });
    }
}

fn append_thinking_block(blocks: &mut Vec<ContentBlock>, text: String) {
    if let Some(ContentBlock::Thinking { text: existing }) = blocks.last_mut() {
        existing.push_str(&text);
    } else {
        blocks.push(ContentBlock::Thinking { text });
    }
}

fn json_string_ref<T: serde::Serialize>(value: &Option<T>) -> Option<String> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPermissionRequest, AgentPermissionResponse, AgentSessionId, AgentType,
        conversation::{
            ConversationDelegation, ConversationDelegationResult, ConversationError,
            ConversationFeedbackRequest, ConversationFileChange, ConversationFileChangeSummary,
            ConversationInputBlock, ConversationPermissionRequest, ConversationPermissionResponse,
            ConversationQuestionRequest, ConversationTerminalPatch, ConversationToolCallPatch,
            ConversationUsage,
        },
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn seed_turn(pool: &SqlitePool) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        (conversation_id, turn.id)
    }

    async fn append_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Option<Uuid>,
        source: &'static str,
        event: ConversationEvent,
        idempotency_key: Option<&'static str>,
    ) -> ConversationEventRecord {
        let event_kind = serde_json::to_value(&event)
            .ok()
            .and_then(|value| value["kind"].as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".into());
        let normalized_json = serde_json::to_string(&event).expect("event json");
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key,
            },
        )
        .await
        .expect("append event")
    }

    #[test]
    fn conversation_projection_fixtures_are_present_and_parse() {
        let fixtures = [
            (
                "happy-path",
                include_str!("../../fixtures/conversation-projection/happy-path.json"),
            ),
            (
                "no-assistant-output-error",
                include_str!(
                    "../../fixtures/conversation-projection/no-assistant-output-error.json"
                ),
            ),
            (
                "permission-blocked",
                include_str!("../../fixtures/conversation-projection/permission-blocked.json"),
            ),
            (
                "tool-heavy",
                include_str!("../../fixtures/conversation-projection/tool-heavy.json"),
            ),
            (
                "terminal",
                include_str!("../../fixtures/conversation-projection/terminal.json"),
            ),
            (
                "file-change",
                include_str!("../../fixtures/conversation-projection/file-change.json"),
            ),
        ];

        for (expected_name, raw) in fixtures {
            let value: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
            assert_eq!(value["name"], expected_name);
            assert_eq!(value["projectionVersion"], CONVERSATION_PROJECTION_VERSION);
            assert!(
                value["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
            );
            assert!(
                value["expectedTimeline"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            );
        }
    }

    #[tokio::test]
    async fn conversation_event_appender_dedupes_and_applies_turn_state() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let first = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            Some("start"),
        )
        .await;
        let duplicate = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            Some("start"),
        )
        .await;
        assert_eq!(duplicate.id, first.id);

        let turn = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "running");
    }

    #[tokio::test]
    async fn conversation_turn_state_is_event_driven() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnBlocked {
                reason: agents::conversation::TurnBlockedReason::Other {
                    message: "waiting".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        let turn = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "completed");
        assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
    }

    #[tokio::test]
    async fn conversation_tool_projection_updates_by_tool_call_id() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Edit".into()),
                    kind: Some("edit".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"path":"src/main.rs"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::json!({"ok":true})),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;

        let tools = super::super::conversation_tool::ConversationToolCallRecord::list_for_turn(
            &pool, turn_id,
        )
        .await
        .expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].status, "completed");
        assert!(tools[0].raw_input_json.is_some());
        assert!(tools[0].raw_output_json.is_some());
    }

    #[tokio::test]
    async fn conversation_side_effect_projection_updates_state_tables() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Run command".into(),
            details: None,
            options: vec![AgentPermissionOption {
                id: "allow".into(),
                label: "Allow".into(),
                kind: AgentPermissionOptionKind::AllowOnce,
                description: None,
            }],
        };
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "permission-1".into(),
                    request,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionResponded {
                permission_id: "permission-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::Selected {
                        option_id: "allow".into(),
                    },
                    auto: false,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::TerminalUpdated {
                terminal: ConversationTerminalPatch {
                    terminal_id: "terminal-1".into(),
                    command: Some("cargo".into()),
                    args: vec!["test".into()],
                    cwd: None,
                    status: "exited".into(),
                    output_summary: Some("ok".into()),
                    output_truncated: false,
                    exit_status: Some(serde_json::json!({"code":0})),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "checkpoint_diff".into(),
                    files: vec![ConversationFileChange {
                        path: "src/main.rs".into(),
                        change_kind: "modified".into(),
                        additions: Some(1),
                        deletions: Some(0),
                        old_path: None,
                    }],
                    summary: Some("changed".into()),
                },
            },
            None,
        )
        .await;

        assert_eq!(
            super::super::conversation_side_effects::ConversationPermissionRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("permissions")[0]
                .status,
            "responded"
        );
        assert_eq!(
            super::super::conversation_side_effects::ConversationTerminalRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("terminals")
            .len(),
            1
        );
        assert_eq!(
            super::super::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("files")
            .len(),
            1
        );
    }

    #[tokio::test]
    async fn conversation_checkpoint_file_changes_are_projected_from_event() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "checkpoint_diff".into(),
                    files: vec![ConversationFileChange {
                        path: "src/lib.rs".into(),
                        change_kind: "modified".into(),
                        additions: Some(10),
                        deletions: Some(2),
                        old_path: None,
                    }],
                    summary: Some("checkpoint diff".into()),
                },
            },
            None,
        )
        .await;

        let files =
            super::super::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
                &pool, turn_id,
            )
            .await
            .expect("files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].source, "checkpoint_diff");
        assert_eq!(files[0].path, "src/lib.rs");
    }

    #[tokio::test]
    async fn conversation_timeline_projection_covers_interaction_side_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "question-1".into(),
                    prompt: "Pick one".into(),
                    options: vec!["A".into(), "B".into()],
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "feedback-1".into(),
                    prompt: "Was this useful?".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: "delegation-1".into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_type: AgentType::Codex,
                    task_preview: "Review diff".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: "delegation-1".into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::SessionConfigStale {
                stale: true,
                reason: Some("settings changed".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::RawDiagnosticRecorded {
                label: "stream recovered".into(),
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let kinds = timeline
            .rows
            .iter()
            .map(|row| match row {
                ConversationTimelineRow::QuestionRequest { .. } => "question",
                ConversationTimelineRow::FeedbackRequest { .. } => "feedback",
                ConversationTimelineRow::Delegation { .. } => "delegation",
                ConversationTimelineRow::SessionNotice { .. } => "notice",
                _ => "other",
            })
            .collect::<Vec<_>>();

        assert!(kinds.contains(&"question"));
        assert!(kinds.contains(&"feedback"));
        assert_eq!(
            kinds.iter().filter(|kind| **kind == "delegation").count(),
            2
        );
        assert_eq!(kinds.iter().filter(|kind| **kind == "notice").count(), 2);
    }

    #[tokio::test]
    async fn conversation_timeline_projection_folds_messages_and_errors() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".into(),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "he".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "llo".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: "late visible error".into(),
                    code: None,
                    raw: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project timeline");
        assert_eq!(timeline.last_sequence, 6);
        assert!(timeline.rows.len() >= 3);
        assert!(matches!(
            timeline.rows[0],
            ConversationTimelineRow::MessageTurn { .. }
        ));
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row, ConversationTimelineRow::TurnError { .. }))
        );
    }
}
