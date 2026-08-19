use std::collections::HashMap;

use agents::conversation::{
    ConversationBundleChecksum, ConversationBundleManifest, ConversationBundlePayload,
    ConversationEvent, ConversationInputBlock,
};
use chrono::Utc;
use conversations::{
    CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord, DbConversationSummary},
    conversation_bundle::{
        ConversationExportRecord, ConversationImportRecord, InsertConversationExport,
        InsertConversationImport,
    },
    conversation_event::{AppendConversationEvent, ConversationEventRecord},
    conversation_side_effects::{
        ConversationFileChangeRecord, ConversationPermissionRecord, ConversationTerminalRecord,
    },
    conversation_tool::ConversationToolCallRecord,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::SessionStatus,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::error::AppError;

const BUNDLE_VERSION: &str = "vibex-conversation-bundle.v1";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationExportResult {
    pub conversation_id: Uuid,
    pub bundle: ConversationBundlePayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationImportResult {
    pub conversation_id: Uuid,
    pub imported_event_count: usize,
    pub projection_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationForkContinuity {
    AgentContext,
    HistoryOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationForkResult {
    pub conversation_id: Uuid,
    pub imported_event_count: usize,
    pub projection_version: u32,
    pub continuity: ConversationForkContinuity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuity_note: Option<String>,
}

impl ConversationForkResult {
    pub fn history_only(imported: ConversationImportResult, note: impl Into<String>) -> Self {
        Self {
            conversation_id: imported.conversation_id,
            imported_event_count: imported.imported_event_count,
            projection_version: imported.projection_version,
            continuity: ConversationForkContinuity::HistoryOnly,
            continuity_note: Some(note.into()),
        }
    }

    pub fn with_agent_context(imported: ConversationImportResult) -> Self {
        Self {
            conversation_id: imported.conversation_id,
            imported_event_count: imported.imported_event_count,
            projection_version: imported.projection_version,
            continuity: ConversationForkContinuity::AgentContext,
            continuity_note: None,
        }
    }
}

#[cfg(test)]
mod fork_result_tests {
    use uuid::Uuid;

    use super::{ConversationForkContinuity, ConversationForkResult, ConversationImportResult};

    #[test]
    fn history_only_fork_is_explicit_in_the_wire_result() {
        let result = ConversationForkResult::history_only(
            ConversationImportResult {
                conversation_id: Uuid::nil(),
                imported_event_count: 3,
                projection_version: 1,
            },
            "agent did not advertise session/fork",
        );

        assert_eq!(result.continuity, ConversationForkContinuity::HistoryOnly);
        assert_eq!(
            result.continuity_note.as_deref(),
            Some("agent did not advertise session/fork")
        );
    }
}

pub async fn export_conversation_bundle(
    pool: &SqlitePool,
    conversation_id: Uuid,
    destination_path: Option<&str>,
) -> Result<ConversationExportResult, AppError> {
    let Some(summary) = DbConversationSummary::find_by_id(pool, conversation_id).await? else {
        return Err(AppError::NotFound(format!(
            "Conversation {conversation_id} not found"
        )));
    };
    let bindings =
        ConversationAgentBindingRecord::list_for_conversation(pool, conversation_id).await?;
    let turns = ConversationTurnRecord::list_for_conversation(pool, conversation_id).await?;
    let events = ConversationEventRecord::events_since(pool, conversation_id, 0, i64::MAX).await?;
    let tools = ConversationToolCallRecord::list_for_conversation(pool, conversation_id).await?;
    let files = ConversationFileChangeRecord::list_for_conversation(pool, conversation_id).await?;
    let permissions =
        ConversationPermissionRecord::list_for_conversation(pool, conversation_id).await?;
    let terminals =
        ConversationTerminalRecord::list_for_conversation(pool, conversation_id).await?;
    let checkpoints = checkpoint_json(pool, conversation_id).await?;

    let conversations_json = serde_json::to_value(vec![summary])?;
    let bindings_json = serde_json::to_value(&bindings)?;
    let turns_json = serde_json::to_value(&turns)?;
    let events_jsonl = events
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    let tool_calls_json = serde_json::to_value(&tools)?;
    let file_changes_json = serde_json::to_value(&files)?;
    let permissions_json = serde_json::to_value(&permissions)?;
    let terminals_json = serde_json::to_value(&terminals)?;

    let checksums = vec![
        checksum("conversations.json", &conversations_json)?,
        checksum("bindings.json", &bindings_json)?,
        checksum("turns.json", &turns_json)?,
        checksum_str("events.jsonl", &events_jsonl),
        checksum("tool-calls.json", &tool_calls_json)?,
        checksum("file-changes.json", &file_changes_json)?,
        checksum("permissions.json", &permissions_json)?,
        checksum("terminals.json", &terminals_json)?,
        checksum("checkpoints.json", &checkpoints)?,
    ];

    let manifest = ConversationBundleManifest {
        bundle_version: BUNDLE_VERSION.to_string(),
        export_app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: Utc::now(),
        source_platform: std::env::consts::OS.to_string(),
        conversation_ids: vec![conversation_id],
        projection_version: CONVERSATION_PROJECTION_VERSION,
        checksums,
    };

    let bundle = ConversationBundlePayload {
        manifest: manifest.clone(),
        conversations_json,
        bindings_json,
        turns_json,
        events_jsonl,
        tool_calls_json,
        file_changes_json,
        permissions_json,
        terminals_json,
        checkpoints_json: checkpoints,
    };

    if let Some(path) = destination_path.filter(|path| !path.trim().is_empty()) {
        let raw = serde_json::to_string_pretty(&bundle)?;
        tokio::fs::write(path, raw).await.map_err(|error| {
            AppError::Internal(format!("failed to write conversation bundle: {error}"))
        })?;
        ConversationExportRecord::insert(
            pool,
            InsertConversationExport {
                id: Uuid::new_v4(),
                conversation_id,
                bundle_version: BUNDLE_VERSION,
                destination_path: path,
                manifest_json: &serde_json::to_string(&manifest)?,
            },
        )
        .await?;
    }

    Ok(ConversationExportResult {
        conversation_id,
        bundle,
        destination_path: destination_path.map(str::to_string),
    })
}

pub async fn import_conversation_bundle(
    pool: &SqlitePool,
    bundle: ConversationBundlePayload,
    workspace_id: Uuid,
) -> Result<ConversationImportResult, AppError> {
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        pool,
        conversation_id,
        db::models::conversation::CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: Some("Imported conversation"),
            initial_prompt: None,
            status: Some(SessionStatus::Todo),
            executor: Some("agent"),
        },
    )
    .await?;

    let mut imported_event_count = 0usize;
    let mut turn_map: HashMap<Uuid, Uuid> = HashMap::new();
    for line in bundle
        .events_jsonl
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let record: ConversationEventRecord = serde_json::from_str(line)?;
        let event: ConversationEvent = serde_json::from_str(&record.normalized_json)?;
        let new_turn_id = if let Some(old_turn_id) = record.turn_id {
            Some(
                ensure_import_turn(pool, conversation_id, old_turn_id, &event, &mut turn_map)
                    .await?,
            )
        } else {
            None
        };
        let normalized_json = serde_json::to_string(&event)?;
        let event_kind = serde_json::to_value(&event)?
            .get("kind")
            .and_then(|kind| kind.as_str())
            .unwrap_or("unknown")
            .to_string();
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: new_turn_id,
                binding_id: None,
                connection_id: record.connection_id.as_deref(),
                prompt_id: record.prompt_id.as_deref(),
                source: "import",
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: record.raw_json.as_deref(),
                idempotency_key: None,
            },
        )
        .await?;
        imported_event_count += 1;
    }

    let _timeline = ConversationProjector::project(pool, conversation_id).await?;
    ConversationImportRecord::insert(
        pool,
        InsertConversationImport {
            id: Uuid::new_v4(),
            source: "vibex_bundle",
            source_agent: None,
            external_session_id: None,
            bundle_version: Some(&bundle.manifest.bundle_version),
            raw_source_path: None,
            imported_conversation_id: Some(conversation_id),
            raw_json: &serde_json::to_string(&bundle.manifest)?,
        },
    )
    .await?;

    Ok(ConversationImportResult {
        conversation_id,
        imported_event_count,
        projection_version: CONVERSATION_PROJECTION_VERSION,
    })
}

async fn ensure_import_turn(
    pool: &SqlitePool,
    conversation_id: Uuid,
    old_turn_id: Uuid,
    event: &ConversationEvent,
    turn_map: &mut HashMap<Uuid, Uuid>,
) -> Result<Uuid, AppError> {
    if let Some(existing) = turn_map.get(&old_turn_id) {
        return Ok(*existing);
    }
    let new_turn_id = Uuid::new_v4();
    let text_preview = match event {
        ConversationEvent::UserTurnCreated { blocks, .. } => blocks.iter().find_map(|block| {
            if let ConversationInputBlock::Text { text } = block {
                Some(text.as_str())
            } else {
                None
            }
        }),
        _ => None,
    };
    ConversationTurnRecord::create_pending(
        pool,
        new_turn_id,
        CreateConversationTurn {
            conversation_id,
            prompt_id: None,
            text_preview,
            input_blocks_json: "[]",
        },
    )
    .await?;
    turn_map.insert(old_turn_id, new_turn_id);
    Ok(new_turn_id)
}

async fn checkpoint_json(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<serde_json::Value, sqlx::Error> {
    let rows: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_object(
               'id', id,
               'conversation_id', conversation_id,
               'turn_id', turn_id,
               'ordinal', ordinal,
               'before_snapshot_json', before_snapshot_json,
               'after_snapshot_json', after_snapshot_json,
               'diff_summary_json', diff_summary_json,
               'created_at', created_at,
               'finalized_at', finalized_at
           )
           FROM conversation_checkpoints
           WHERE conversation_id = ?
           ORDER BY ordinal ASC"#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter_map(|raw: String| serde_json::from_str(&raw).ok())
    .collect();
    Ok(serde_json::Value::Array(rows))
}

fn checksum(
    path: &str,
    value: &serde_json::Value,
) -> Result<ConversationBundleChecksum, serde_json::Error> {
    serde_json::to_string(value).map(|raw| checksum_str(path, &raw))
}

fn checksum_str(path: &str, value: &str) -> ConversationBundleChecksum {
    ConversationBundleChecksum {
        path: path.to_string(),
        sha256: format!("{:x}", Sha256::digest(value.as_bytes())),
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::conversation::{ConversationEvent, ConversationInputBlock};
    use conversations::ConversationEventAppender;
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_event::AppendConversationEvent,
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn seed_conversation(pool: &SqlitePool) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id,
                task_id: None,
                title: Some("Bundle source"),
                initial_prompt: Some("hello"),
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
                prompt_id: None,
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        append_event(
            pool,
            conversation_id,
            turn.id,
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".to_string(),
                }],
                workflow_refs: Vec::new(),
            },
        )
        .await;
        append_event(
            pool,
            conversation_id,
            turn.id,
            ConversationEvent::AssistantTextDelta {
                text: "hi".to_string(),
                message_id: None,
            },
        )
        .await;
        (conversation_id, workspace_id)
    }

    async fn append_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Uuid,
        event: ConversationEvent,
    ) {
        let event_kind = serde_json::to_value(&event)
            .expect("event value")
            .get("kind")
            .and_then(|kind| kind.as_str())
            .unwrap_or("unknown")
            .to_string();
        let normalized_json = serde_json::to_string(&event).expect("event json");
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user",
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append");
    }

    #[tokio::test]
    async fn conversation_bundle_export_contains_vibex_tables() {
        let pool = migrated_pool().await;
        let (conversation_id, _) = seed_conversation(&pool).await;

        let exported = export_conversation_bundle(&pool, conversation_id, None)
            .await
            .expect("export");

        assert_eq!(
            exported.bundle.manifest.conversation_ids,
            vec![conversation_id]
        );
        assert!(exported.bundle.events_jsonl.contains("user_turn_created"));
        assert_eq!(exported.bundle.manifest.checksums.len(), 9);
    }

    #[tokio::test]
    async fn conversation_bundle_import_restores_renderable_events() {
        let pool = migrated_pool().await;
        let (conversation_id, workspace_id) = seed_conversation(&pool).await;
        let exported = export_conversation_bundle(&pool, conversation_id, None)
            .await
            .expect("export");

        let imported = import_conversation_bundle(&pool, exported.bundle, workspace_id)
            .await
            .expect("import");

        assert_eq!(imported.imported_event_count, 2);
        let timeline = ConversationProjector::project(&pool, imported.conversation_id)
            .await
            .expect("project");
        assert!(!timeline.rows.is_empty());
    }
}
