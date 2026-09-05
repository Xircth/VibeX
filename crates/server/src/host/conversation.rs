use agents::{
    AgentAvailableCommand, AgentSessionConfigOption, AgentSessionControlsSnapshot, AgentSessionId,
    conversation::{
        AcpCapabilitySnapshot, ConversationBundlePayload, ConversationEvent, ConversationRowPage,
        ConversationSessionModes, ConversationTimeline, ConversationTimelineRow, MessageTurn,
        SessionStats, TurnUsage,
    },
};
use application::ApplicationError;
use conversations::{
    CONVERSATION_PROJECTION_VERSION, ConversationBundleError, ConversationForkResult,
    ConversationProjector, ConversationRelationControl, CreateConversationRelation,
    export_conversation_bundle, import_conversation_bundle, preview_checkpoint_file_changes,
    render_html, render_markdown,
};
use db::models::{
    conversation::{
        BindingStatus, ConversationAgentBindingRecord, ConversationRecord,
        CreateConversationAgentBinding, DbConversationSummary,
    },
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const OPEN_TIMELINE_ROW_LIMIT: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConversationDetail {
    pub summary: DbConversationSummary,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<MessageTurn>,
    pub timeline: ConversationTimeline,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_binding: Option<HostConversationActiveBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<HostConversationCurrentTurn>,
    pub projection_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_user_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<ConversationSessionModes>,
    #[serde(default)]
    pub session_config_options: Vec<AgentSessionConfigOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AgentAvailableCommand>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConversationActiveBinding {
    pub id: Uuid,
    pub agent_type: String,
    pub working_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    pub status: String,
    pub capabilities: AcpCapabilitySnapshot,
    #[serde(default)]
    pub delegation_mcp_delivered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConversationCurrentTurn {
    pub id: Uuid,
    pub ordinal: i64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    #[serde(alias = "conversationId")]
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationIdArgs {
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsSinceArgs {
    conversation_id: String,
    after_sequence: i64,
    #[serde(default)]
    limit: Option<i64>,
}

impl ServerApplicationDomains {
    pub(crate) async fn conversation_detail(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: SessionIdArgs = parse(args)?;
        let id = parse_uuid(&args.session_id)?;
        serialize(load_conversation_detail(&self.pool, id).await?)
    }

    pub(crate) async fn conversation_events_since(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: EventsSinceArgs = parse(args)?;
        let conversation_id = parse_uuid(&args.conversation_id)?;
        let _ = args.limit;
        let (rows, last_sequence) =
            ConversationProjector::rows_since(&self.pool, conversation_id, args.after_sequence)
                .await
                .map_err(internal_error)?;
        serialize(ConversationRowPage {
            conversation_id,
            after_sequence: args.after_sequence,
            last_sequence,
            rows,
        })
    }

    pub(crate) async fn conversation_ensure_session_controls(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: ConversationIdArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        let snapshot: AgentSessionControlsSnapshot =
            conversations::ConversationSessionService::new(self.conversations.clone())
                .ensure_session_controls(id)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(snapshot)
    }

    pub(crate) async fn conversation_rebind_session(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: ConversationIdArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        let snapshot: AgentSessionControlsSnapshot =
            conversations::ConversationSessionService::new(self.conversations.clone())
                .rebind_session(id)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(snapshot)
    }

    pub(crate) async fn conversation_timeline_page(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TimelinePageArgs {
            conversation_id: String,
            cursor: Option<String>,
            limit: Option<usize>,
        }
        let args: TimelinePageArgs = parse(args)?;
        let conversation_id = parse_uuid(&args.conversation_id)?;
        let mut timeline = ConversationProjector::project(&self.pool, conversation_id)
            .await
            .map_err(internal_error)?;
        agents::conversation::cap_timeline_preview_fields(&mut timeline);
        let start = args
            .cursor
            .as_deref()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let bounded_limit = args.limit.unwrap_or(100).clamp(1, 200);
        let rows = timeline
            .rows
            .iter()
            .skip(start)
            .take(bounded_limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_index = start + rows.len();
        let next_cursor = (next_index < timeline.rows.len()).then(|| next_index.to_string());
        serialize(json!({
            "conversation_id": conversation_id,
            "projection_version": timeline.projection_version,
            "cursor": args.cursor,
            "next_cursor": next_cursor,
            "rows": rows,
        }))
    }

    pub(crate) async fn conversation_truncate_to_turn(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TruncateArgs {
            conversation_id: String,
            ordinal: i64,
        }
        let args: TruncateArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        conversations::ConversationSessionService::new(self.conversations.clone())
            .truncate_to_turn(id, args.ordinal)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(Value::Null)
    }

    pub(crate) async fn conversation_search_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SearchArgs {
            query: String,
            workspace_id: Option<String>,
            limit: Option<i64>,
        }
        let args: SearchArgs = parse(args)?;
        let workspace_id = args
            .workspace_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok());
        let mut conn = self.pool.acquire().await.map_err(internal_error)?;
        let hits = conversations::search_conversations(
            &mut conn,
            &args.query,
            workspace_id,
            args.limit.unwrap_or(50),
        )
        .await
        .map_err(internal_error)?;
        serialize(hits)
    }

    pub(crate) async fn conversation_export_text(
        &self,
        args: Value,
        html: bool,
    ) -> Result<Value, ApplicationError> {
        let args: ConversationIdArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        let (title, timeline) = export_title_and_timeline(&self.pool, id).await?;
        if html {
            serialize(render_html(&title, &timeline.rows))
        } else {
            serialize(render_markdown(&title, &timeline.rows))
        }
    }

    pub(crate) async fn conversation_export_bundle(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportArgs {
            conversation_id: String,
            #[serde(default)]
            destination_path: Option<String>,
        }
        let args: ExportArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        serialize(
            export_conversation_bundle(
                &self.pool,
                id,
                args.destination_path.as_deref(),
                env!("CARGO_PKG_VERSION"),
            )
            .await
            .map_err(bundle_error)?,
        )
    }

    pub(crate) async fn conversation_close_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CloseArgs {
            conversation_id: String,
            #[serde(default)]
            reason: Option<String>,
        }
        let args: CloseArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        conversations::ConversationSessionService::new(self.conversations.clone())
            .close_conversation(id, args.reason)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(Value::Null)
    }

    pub(crate) async fn conversation_checkpoint_preview(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PreviewArgs {
            conversation_id: String,
            ordinal: i64,
        }
        let args: PreviewArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        serialize(
            preview_checkpoint_file_changes(self.deployment.as_ref(), id, args.ordinal)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    pub(crate) async fn conversation_import_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportArgs {
            workspace_id: String,
            bundle: ConversationBundlePayload,
        }
        let args: ImportArgs = parse(args)?;
        let workspace_id = parse_uuid(&args.workspace_id)?;
        serialize(
            import_conversation_bundle(&self.pool, args.bundle, workspace_id)
                .await
                .map_err(bundle_error)?,
        )
    }

    pub(crate) async fn conversation_fork_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: ConversationIdArgs = parse(args)?;
        let source_id = parse_uuid(&args.conversation_id)?;
        serialize(self.fork_conversation(source_id).await?)
    }

    async fn fork_conversation(
        &self,
        source_id: Uuid,
    ) -> Result<ConversationForkResult, ApplicationError> {
        let summary = DbConversationSummary::find_by_id(&self.pool, source_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!("conversation {source_id} not found"))
            })?;
        if let Some(conversation) = ConversationRecord::find_by_id(&self.pool, source_id)
            .await
            .map_err(internal_error)?
            && let Some(active_turn_id) = conversation.active_turn_id
            && let Some(active_turn) =
                ConversationTurnRecord::find_by_id(&self.pool, active_turn_id)
                    .await
                    .map_err(internal_error)?
            && matches!(
                active_turn.status.as_str(),
                "pending" | "queued" | "running" | "blocked"
            )
        {
            return Err(ApplicationError::conflict(
                "Cannot fork a conversation while a turn is in flight",
            ));
        }

        let exported =
            export_conversation_bundle(&self.pool, source_id, None, env!("CARGO_PKG_VERSION"))
                .await
                .map_err(bundle_error)?;
        let imported =
            import_conversation_bundle(&self.pool, exported.bundle, summary.workspace_id)
                .await
                .map_err(bundle_error)?;
        let new_id = imported.conversation_id;
        ConversationRelationControl::with_publisher(
            self.pool.clone(),
            self.conversations.event_publisher.clone(),
        )
        .create(CreateConversationRelation {
            parent_conversation_id: source_id,
            child_conversation_id: new_id,
            kind: agents::ConversationRelationKind::Fork,
            visibility: agents::ConversationRelationVisibility::Visible,
            metadata: serde_json::json!({ "source": "conversation_fork" }),
        })
        .await
        .map_err(internal_error)?;

        let base = summary
            .title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("会话");
        if let Err(error) =
            DbConversationSummary::set_title(&self.pool, new_id, &format!("{base}（分叉）")).await
        {
            tracing::warn!(%error, conversation_id = %new_id, "forked conversation title was not updated");
        }

        let Some(agent_id) = summary.agent_id.as_ref() else {
            return Ok(ConversationForkResult::history_only(
                imported,
                "The source conversation has no Agent binding; only visible history was copied",
            ));
        };
        let source_binding =
            ConversationAgentBindingRecord::latest_for_conversation(&self.pool, source_id)
                .await
                .map_err(internal_error)?;
        let Some(source_binding) = source_binding else {
            return Ok(ConversationForkResult::history_only(
                imported,
                "The source Agent session has no resumable binding; only visible history was copied",
            ));
        };

        match self
            .conversations
            .agent_runtime
            .fork_session(AgentSessionId(source_id))
            .await
        {
            Ok(forked_external_id) => {
                let binding = ConversationAgentBindingRecord::create(
                    &self.pool,
                    Uuid::new_v4(),
                    CreateConversationAgentBinding {
                        conversation_id: new_id,
                        agent_id,
                        working_dir: &source_binding.working_dir,
                        acp_session_id: Some(&forked_external_id),
                        acp_protocol_version: source_binding.acp_protocol_version.as_deref(),
                        runtime_version: source_binding.runtime_version.as_deref(),
                        acp_version: source_binding.acp_version.as_deref(),
                        load_supported: source_binding.load_supported,
                        resume_supported: source_binding.resume_supported,
                        close_supported: source_binding.close_supported,
                        terminal_supported: source_binding.terminal_supported,
                        additional_directories_supported: source_binding
                            .additional_directories_supported,
                        prompt_capabilities_json: &source_binding.prompt_capabilities_json,
                        session_capabilities_json: &source_binding.session_capabilities_json,
                        client_capabilities_json: &source_binding.client_capabilities_json,
                        mcp_servers_json: &source_binding.mcp_servers_json,
                        modes_json: &source_binding.modes_json,
                        config_options_json: &source_binding.config_options_json,
                        current_mode: source_binding.current_mode.as_deref(),
                        config_selection_json: &source_binding.config_selection_json,
                        status: BindingStatus::Closed,
                    },
                )
                .await;
                match binding {
                    Ok(_) => Ok(ConversationForkResult::with_agent_context(imported)),
                    Err(error) => Ok(ConversationForkResult::history_only(
                        imported,
                        format!("Agent context was forked but could not be attached: {error}"),
                    )),
                }
            }
            Err(error) => Ok(ConversationForkResult::history_only(
                imported,
                format!("Agent context could not be forked: {error}"),
            )),
        }
    }
}

fn bundle_error(error: ConversationBundleError) -> ApplicationError {
    match error {
        ConversationBundleError::NotFound(message) => ApplicationError::not_found(message),
        ConversationBundleError::BadRequest(message) => ApplicationError::bad_request(message),
        ConversationBundleError::Conflict(message) => ApplicationError::conflict(message),
        ConversationBundleError::Internal(message) => ApplicationError::internal(message),
    }
}

async fn export_title_and_timeline(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(String, ConversationTimeline), ApplicationError> {
    let title = DbConversationSummary::find_by_id(pool, conversation_id)
        .await
        .map_err(internal_error)?
        .and_then(|summary| summary.title)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "会话".to_string());
    let timeline = ConversationProjector::project(pool, conversation_id)
        .await
        .map_err(internal_error)?;
    Ok((title, timeline))
}

pub async fn load_conversation_detail(
    pool: &SqlitePool,
    id: Uuid,
) -> Result<Option<HostConversationDetail>, ApplicationError> {
    let Some(summary) = DbConversationSummary::find_by_id(pool, id)
        .await
        .map_err(internal_error)?
    else {
        return Ok(None);
    };
    let mut timeline = ConversationProjector::project(pool, id)
        .await
        .map_err(internal_error)?;
    agents::conversation::cap_timeline_preview_fields(&mut timeline);
    let session_stats = session_stats_from_turns(&message_turns_from_timeline(&timeline));
    truncate_timeline_for_open(&mut timeline);
    let current_turn = current_turn_for_conversation(pool, id).await?;
    let in_flight_user_turn_id = current_turn.as_ref().and_then(|turn| {
        matches!(
            turn.status.as_str(),
            "pending" | "queued" | "running" | "blocked"
        )
        .then(|| turn.id.to_string())
    });
    Ok(Some(HostConversationDetail {
        summary,
        turns: Vec::new(),
        timeline,
        active_binding: active_binding_for_conversation(pool, id).await?,
        current_turn,
        projection_version: CONVERSATION_PROJECTION_VERSION,
        session_stats,
        in_flight_user_turn_id,
        session_modes: latest_event(pool, id, "session_mode_updated", |event| match event {
            ConversationEvent::SessionModeUpdated { current, modes } => {
                Some(ConversationSessionModes { current, modes })
            }
            _ => None,
        })
        .await?,
        session_config_options: latest_event(pool, id, "session_config_options_updated", |event| {
            match event {
                ConversationEvent::SessionConfigOptionsUpdated { options } => Some(options),
                _ => None,
            }
        })
        .await?
        .unwrap_or_default(),
        available_commands: latest_event(
            pool,
            id,
            "available_commands_updated",
            |event| match event {
                ConversationEvent::AvailableCommandsUpdated { commands } => Some(commands),
                _ => None,
            },
        )
        .await?,
    }))
}

async fn latest_event<T>(
    pool: &SqlitePool,
    conversation_id: Uuid,
    kind: &str,
    map: impl FnOnce(ConversationEvent) -> Option<T>,
) -> Result<Option<T>, ApplicationError> {
    let record = ConversationEventRecord::latest_of_kind(pool, conversation_id, kind)
        .await
        .map_err(internal_error)?;
    Ok(record.and_then(|record| {
        serde_json::from_str::<ConversationEvent>(&record.normalized_json)
            .ok()
            .and_then(map)
    }))
}

fn truncate_timeline_for_open(timeline: &mut ConversationTimeline) {
    let len = timeline.rows.len();
    if len <= OPEN_TIMELINE_ROW_LIMIT {
        timeline.truncated_from_start = false;
        timeline.older_cursor = None;
        return;
    }
    let start = len - OPEN_TIMELINE_ROW_LIMIT;
    timeline.rows = timeline.rows.split_off(start);
    timeline.truncated_from_start = true;
    timeline.older_cursor = Some(start.to_string());
}

fn message_turns_from_timeline(timeline: &ConversationTimeline) -> Vec<MessageTurn> {
    timeline
        .rows
        .iter()
        .filter_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn.clone()),
            _ => None,
        })
        .collect()
}

fn session_stats_from_turns(turns: &[MessageTurn]) -> Option<SessionStats> {
    let total_usage = turns.iter().filter_map(|turn| turn.usage.clone()).fold(
        TurnUsage::default(),
        |mut acc, usage| {
            acc.input_tokens += usage.input_tokens;
            acc.output_tokens += usage.output_tokens;
            acc.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            acc.cache_read_input_tokens += usage.cache_read_input_tokens;
            acc
        },
    );
    let total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_creation_input_tokens
        + total_usage.cache_read_input_tokens;
    let context_window = turns.iter().rev().find_map(|turn| {
        let usage = turn.usage.clone()?;
        let max = usage.context_window_max?;
        let used = usage.input_tokens
            + usage.output_tokens
            + usage.cache_creation_input_tokens
            + usage.cache_read_input_tokens;
        Some((used, max))
    });
    (total_tokens > 0).then_some(SessionStats {
        total_usage: Some(total_usage),
        total_tokens: Some(total_tokens),
        total_duration_ms: turns.iter().filter_map(|turn| turn.duration_ms).sum(),
        context_window_used_tokens: context_window.map(|(used, _)| used),
        context_window_max_tokens: context_window.map(|(_, max)| max),
        context_window_usage_percent: context_window.map(|(used, max)| {
            if max > 0 {
                (used as f64 / max as f64) * 100.0
            } else {
                0.0
            }
        }),
    })
}

async fn active_binding_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<HostConversationActiveBinding>, ApplicationError> {
    let Some(binding) =
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id)
            .await
            .map_err(internal_error)?
    else {
        return Ok(None);
    };
    let mut capabilities =
        serde_json::from_str::<AcpCapabilitySnapshot>(&binding.session_capabilities_json)
            .unwrap_or_default();
    if let Ok(prompt) = serde_json::from_str(&binding.prompt_capabilities_json) {
        capabilities.prompt = prompt;
    }
    capabilities.load_session = binding.load_supported;
    capabilities.resume_session = binding.resume_supported;
    capabilities.close_session = binding.close_supported;
    capabilities.terminal = binding.terminal_supported;
    capabilities.additional_directories = binding.additional_directories_supported;
    Ok(Some(HostConversationActiveBinding {
        id: binding.id,
        agent_type: binding.agent_id.into_string(),
        working_dir: binding.working_dir,
        acp_session_id: binding.acp_session_id,
        status: binding.status,
        capabilities,
        delegation_mcp_delivered: plugins::binding_has_delegation_mcp(&binding.mcp_servers_json),
    }))
}

async fn current_turn_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<HostConversationCurrentTurn>, ApplicationError> {
    let Some(active_turn_id) =
        sqlx::query_scalar::<_, Option<Uuid>>("SELECT active_turn_id FROM sessions WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(pool)
            .await
            .map_err(internal_error)?
            .flatten()
    else {
        return Ok(None);
    };
    let Some(turn) = ConversationTurnRecord::find_by_id(pool, active_turn_id)
        .await
        .map_err(internal_error)?
    else {
        return Ok(None);
    };
    Ok(Some(HostConversationCurrentTurn {
        id: turn.id,
        ordinal: turn.ordinal,
        status: turn.status,
        prompt_id: turn.prompt_id,
        text_preview: turn.text_preview,
    }))
}

fn parse_uuid(value: &str) -> Result<Uuid, ApplicationError> {
    Uuid::parse_str(value).map_err(|error| ApplicationError::bad_request(error.to_string()))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use db::models::session::SessionStatus;

    use super::*;

    #[test]
    fn conversation_detail_uses_open_path_snake_case_keys() {
        let now = Utc::now();
        let detail = HostConversationDetail {
            summary: DbConversationSummary {
                id: Uuid::nil(),
                workspace_id: Uuid::nil(),
                task_id: None,
                title: Some("Conversation".into()),
                title_locked: false,
                status: SessionStatus::Todo,
                agent_id: None,
                model: None,
                external_session_id: None,
                message_count: 0,
                pinned_at: None,
                parent_session_id: None,
                parent_tool_use_id: None,
                delegation_call_id: None,
                created_at: now,
                updated_at: now,
            },
            turns: Vec::new(),
            timeline: ConversationTimeline {
                conversation_id: Uuid::nil(),
                projection_version: CONVERSATION_PROJECTION_VERSION,
                last_sequence: 0,
                rows: Vec::new(),
                truncated_from_start: false,
                older_cursor: None,
            },
            active_binding: Some(HostConversationActiveBinding {
                id: Uuid::nil(),
                agent_type: "grok".into(),
                working_dir: "/tmp".into(),
                acp_session_id: None,
                status: "active".into(),
                capabilities: AcpCapabilitySnapshot::default(),
                delegation_mcp_delivered: false,
            }),
            current_turn: None,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            session_stats: None,
            in_flight_user_turn_id: None,
            session_modes: Some(ConversationSessionModes {
                current: Some("plan".into()),
                modes: Vec::new(),
            }),
            session_config_options: Vec::new(),
            available_commands: None,
        };

        let value = serde_json::to_value(&detail).expect("conversation detail");
        assert!(value.get("session_modes").is_some());
        assert!(value.get("session_config_options").is_some());
        assert!(value.get("active_binding").is_some());
        assert!(value.get("sessionModes").is_none());
        assert!(value.get("sessionConfigOptions").is_none());
        assert!(value.get("activeBinding").is_none());
        assert_eq!(value["active_binding"]["agent_type"], "grok");
        assert!(value["active_binding"].get("agentType").is_none());
    }

    #[test]
    fn conversation_extra_args_accept_frontend_wrappers() {
        let close: CloseArgsProbe = crate::domains::parse(serde_json::json!({
            "request": { "conversationId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "reason": "done" }
        }))
        .expect("close");
        assert_eq!(
            close.conversation_id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        );
        let export: ExportArgsProbe = crate::domains::parse(serde_json::json!({
            "conversationId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "destinationPath": "/tmp/out.json"
        }))
        .expect("export");
        assert_eq!(export.destination_path.as_deref(), Some("/tmp/out.json"));
        let imported: conversations::ConversationForkResult =
            conversations::ConversationForkResult::history_only(
                conversations::ConversationImportResult {
                    conversation_id: Uuid::nil(),
                    imported_event_count: 2,
                    projection_version: 1,
                },
                "copied history",
            );
        let value = serde_json::to_value(&imported).expect("fork");
        assert_eq!(value["continuity"], "history_only");
        assert!(value.get("conversationId").is_some() || value.get("conversation_id").is_some());
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloseArgsProbe {
        conversation_id: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ExportArgsProbe {
        destination_path: Option<String>,
    }
}
