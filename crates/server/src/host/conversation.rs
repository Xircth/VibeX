use std::str::FromStr;

use agents::{
    AgentAvailableCommand, AgentSessionConfigOption, AgentSessionControlsSnapshot, AgentSessionId,
    conversation::{
        AcpCapabilitySnapshot, ConversationBundlePayload, ConversationEvent, ConversationRowPage,
        ConversationSessionModes, ConversationTimeline, ConversationTimelineRow, MessageTurn,
        SessionStats,
    },
};
use application::ApplicationError;
use conversations::{
    CONVERSATION_PROJECTION_VERSION, ConversationBundleError, ConversationForkResult,
    ConversationImportResult, ConversationProjector, ConversationRelationControl,
    CreateConversationRelation, ForkVisibleConversation, export_conversation_bundle,
    fork_visible_conversation, import_conversation_bundle, jsonl_history,
    preview_checkpoint_file_changes, render_html, render_markdown,
    session_stats_with_usage_snapshot,
};
use db::models::{
    conversation::{
        BindingStatus, ConversationAgentBindingRecord, CreateConversationAgentBinding,
        DbConversationSummary,
    },
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
    conversation_usage::ConversationUsageSnapshotRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostConversationDetail {
    pub summary: DbConversationSummary,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<MessageTurn>,
    pub timeline: ConversationTimeline,
    #[serde(default)]
    pub turns_offset: u32,
    #[serde(default)]
    pub turns_total: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_hash: Option<String>,
    #[serde(default)]
    pub user_turns_before_offset: u32,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<conversations::collaboration::ConversationPersonaView>,
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
struct ConversationIdArgs {
    #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
    conversation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTouchArgs {
    #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
    conversation_id: String,
    /// `Some` registers or forgets the on-screen surface. `None` is one bump.
    #[serde(default)]
    watch: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationEnsureSessionControlsArgs {
    #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
    conversation_id: String,
    #[serde(default)]
    reload: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationForkArgs {
    #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
    conversation_id: String,
    #[serde(default, alias = "at_turn_id")]
    at_turn_id: Option<String>,
    #[serde(default)]
    current_mode: Option<String>,
    #[serde(default, alias = "config_selection_json")]
    config_selection_json: Option<String>,
    #[serde(default, alias = "operation_id")]
    _operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsSinceArgs {
    #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
    conversation_id: String,
    #[serde(alias = "after_sequence")]
    after_sequence: i64,
    #[serde(default)]
    limit: Option<i64>,
}

impl ServerApplicationDomains {
    pub(crate) async fn conversation_detail(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DetailArgs {
            #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
            conversation_id: String,
            #[serde(default)]
            tail_turns: Option<u32>,
            #[serde(default)]
            from_index: Option<u32>,
        }
        let args: DetailArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        let request = jsonl_history::parse_window(args.tail_turns, args.from_index)
            .map_err(ApplicationError::bad_request)?;
        serialize(load_conversation_detail(&self.pool, id, request).await?)
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
        let args: ConversationEnsureSessionControlsArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        let snapshot: AgentSessionControlsSnapshot =
            conversations::ConversationSessionService::new(self.conversations.clone())
                .ensure_session_controls_with_reload(id, args.reload)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(snapshot)
    }

    pub(crate) async fn conversation_touch(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ConversationTouchArgs = parse(args)?;
        let id = parse_uuid(&args.conversation_id)?;
        let service = conversations::ConversationSessionService::new(self.conversations.clone());
        match args.watch {
            Some(watch) => service
                .set_session_keepalive(id, watch)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
            None => service
                .touch_session(id)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        }
        let idle_timeout_secs = agents::idle_timeout_from_env()
            .map(|timeout| timeout.as_secs())
            .unwrap_or(0);
        serialize(json!({ "ok": true, "idleTimeoutSecs": idle_timeout_secs }))
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
        let start = args
            .cursor
            .as_deref()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let bounded_limit = args
            .limit
            .unwrap_or(100)
            .clamp(1, conversations::turn_window::MAX_WINDOW_TURNS);
        let page = jsonl_history::load_page(&self.pool, conversation_id, start, bounded_limit)
            .await
            .map_err(internal_error)?;
        let (cursor, next_cursor, rows) = match page {
            Some(page) => (
                Some(page.start.to_string()),
                page.next_cursor.map(|index| index.to_string()),
                page.rows,
            ),
            None => (args.cursor, None, Vec::new()),
        };
        serialize(json!({
            "conversation_id": conversation_id,
            "projection_version": CONVERSATION_PROJECTION_VERSION,
            "cursor": cursor,
            "next_cursor": next_cursor,
            "rows": rows,
        }))
    }

    pub(crate) async fn conversation_timeline_image(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TimelineImageArgs {
            hash: String,
        }
        let args: TimelineImageArgs = parse(args)?;
        match agents::read_timeline_image(&args.hash) {
            Ok(image) => serialize(image),
            Err(agents::TimelineImageError::InvalidHash) => {
                Err(ApplicationError::bad_request("invalid timeline image hash"))
            }
            Err(agents::TimelineImageError::NotFound) => {
                Err(ApplicationError::not_found("timeline image not found"))
            }
            Err(agents::TimelineImageError::Io(error)) => Err(internal_error(error)),
        }
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
        let args: ConversationForkArgs = parse(args)?;
        let source_id = parse_uuid(&args.conversation_id)?;
        let until_turn_id = self
            .resolve_fork_target_turn_uuid(source_id, args.at_turn_id.as_deref())
            .await?;
        serialize(
            self.fork_conversation(
                source_id,
                until_turn_id,
                args.at_turn_id.as_deref(),
                args.current_mode,
                args.config_selection_json,
            )
            .await?,
        )
    }

    async fn resolve_fork_target_turn_uuid(
        &self,
        source_id: Uuid,
        raw_turn_id: Option<&str>,
    ) -> Result<Option<Uuid>, ApplicationError> {
        let Some(raw) = raw_turn_id.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        let stripped = raw
            .strip_suffix(":assistant")
            .or_else(|| raw.strip_suffix(":user"))
            .unwrap_or(raw);
        if let Ok(uuid) = Uuid::parse_str(stripped) {
            return Ok(Some(uuid));
        }
        let turns = jsonl_history::load_all_turns(&self.pool, source_id)
            .await
            .map_err(internal_error)?
            .unwrap_or_default();
        let db_turns = ConversationTurnRecord::list_for_conversation(&self.pool, source_id)
            .await
            .map_err(internal_error)?;
        let mut round_index: Option<usize> = None;
        for turn in &turns {
            if matches!(turn.role, agents::conversation::TurnRole::User)
                && !turn.id.contains(":steer:")
            {
                round_index = Some(round_index.map_or(0, |idx| idx + 1));
            }
            if turn.id == raw {
                if let Some(idx) = round_index
                    && let Some(db_turn) = db_turns.get(idx)
                {
                    return Ok(Some(db_turn.id));
                }
                break;
            }
        }
        Err(ApplicationError::bad_request(format!(
            "invalid fork turn id: {raw}"
        )))
    }

    async fn fork_conversation(
        &self,
        source_id: Uuid,
        until_turn_id: Option<Uuid>,
        raw_at_turn_id: Option<&str>,
        overlay_mode: Option<String>,
        overlay_config_json: Option<String>,
    ) -> Result<ConversationForkResult, ApplicationError> {
        let summary = DbConversationSummary::find_by_id(&self.pool, source_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!("conversation {source_id} not found"))
            })?;
        let source_binding =
            ConversationAgentBindingRecord::latest_for_conversation(&self.pool, source_id)
                .await
                .map_err(internal_error)?;
        let capabilities = source_binding.as_ref().and_then(|binding| {
            serde_json::from_str::<AcpCapabilitySnapshot>(&binding.session_capabilities_json).ok()
        });
        if !capabilities
            .as_ref()
            .is_some_and(|snapshot| snapshot.fork_session)
        {
            return Err(ApplicationError::bad_request("fork_unsupported"));
        }
        let latest_turn = ConversationTurnRecord::latest_for_conversation(&self.pool, source_id)
            .await
            .map_err(internal_error)?;
        let latest_in_flight = latest_turn.as_ref().is_some_and(|turn| {
            matches!(
                turn.status.as_str(),
                "pending" | "queued" | "running" | "blocked"
            )
        });
        if until_turn_id.is_none() && latest_in_flight {
            return Err(ApplicationError::conflict("fork_turn_in_flight"));
        }
        let is_tail = match until_turn_id {
            None => true,
            Some(turn_id) => latest_turn
                .as_ref()
                .is_some_and(|latest| latest.id == turn_id),
        };
        if is_tail && latest_in_flight {
            return Err(ApplicationError::conflict("fork_turn_in_flight"));
        }
        let agent_id = summary.agent_id.as_ref();
        let fork_point = match (agent_id, until_turn_id) {
            (Some(agent_id), Some(_)) => {
                self.resolve_agent_fork_point(source_id, until_turn_id, raw_at_turn_id, agent_id)
                    .await?
            }
            _ => None,
        };
        if !is_tail && fork_point.is_none() {
            return Err(ApplicationError::bad_request("fork_point_unnamed"));
        }

        let (new_id, imported_event_count) = fork_visible_conversation(
            &self.pool,
            ForkVisibleConversation {
                source_id,
                until_turn_id,
            },
        )
        .await
        .map_err(|error| match error {
            conversations::ConversationServiceError::NotFound(message) => {
                ApplicationError::not_found(message)
            }
            conversations::ConversationServiceError::BadRequest(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::Conflict(message) => {
                ApplicationError::conflict(message)
            }
            other => ApplicationError::internal(other.to_string()),
        })?;
        let imported = ConversationImportResult {
            conversation_id: new_id,
            imported_event_count,
            projection_version: CONVERSATION_PROJECTION_VERSION,
        };
        let Some(agent_id) = agent_id else {
            ConversationRelationControl::with_publisher(
                self.pool.clone(),
                self.conversations.event_publisher.clone(),
            )
            .create(CreateConversationRelation {
                parent_conversation_id: source_id,
                child_conversation_id: new_id,
                kind: agents::ConversationRelationKind::Fork,
                visibility: agents::ConversationRelationVisibility::Visible,
                metadata: serde_json::json!({
                    "source": "conversation_fork",
                    "forkTurnId": until_turn_id,
                    "continuity": "history_only",
                    "continuityNote": "The source conversation has no Agent binding",
                }),
            })
            .await
            .map_err(internal_error)?;
            return Ok(ConversationForkResult::history_only(
                imported,
                source_id,
                "The source conversation has no Agent binding; only visible history was copied",
            ));
        };
        let Some(source_binding) = source_binding else {
            ConversationRelationControl::with_publisher(
                self.pool.clone(),
                self.conversations.event_publisher.clone(),
            )
            .create(CreateConversationRelation {
                parent_conversation_id: source_id,
                child_conversation_id: new_id,
                kind: agents::ConversationRelationKind::Fork,
                visibility: agents::ConversationRelationVisibility::Visible,
                metadata: serde_json::json!({
                    "source": "conversation_fork",
                    "forkTurnId": until_turn_id,
                    "continuity": "history_only",
                    "continuityNote": "The source Agent session has no resumable binding",
                }),
            })
            .await
            .map_err(internal_error)?;
            return Ok(ConversationForkResult::history_only(
                imported,
                source_id,
                "The source Agent session has no resumable binding; only visible history was copied",
            ));
        };

        ConversationRelationControl::with_publisher(
            self.pool.clone(),
            self.conversations.event_publisher.clone(),
        )
        .create(CreateConversationRelation {
            parent_conversation_id: source_id,
            child_conversation_id: new_id,
            kind: agents::ConversationRelationKind::Fork,
            visibility: agents::ConversationRelationVisibility::Visible,
            metadata: serde_json::json!({
                "source": "conversation_fork",
                "forkTurnId": until_turn_id,
            }),
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

        let child_mode = overlay_mode
            .as_deref()
            .or(source_binding.current_mode.as_deref());
        let child_config = overlay_config_json
            .as_deref()
            .unwrap_or(source_binding.config_selection_json.as_str());

        match self
            .conversations
            .agent_runtime
            .fork_session(AgentSessionId(source_id), fork_point)
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
                        current_mode: child_mode,
                        config_selection_json: child_config,
                        status: BindingStatus::Closed,
                    },
                )
                .await;
                match binding {
                    Ok(_) => Ok(ConversationForkResult::with_agent_context(
                        imported, source_id,
                    )),
                    Err(error) => Ok(ConversationForkResult::history_only(
                        imported,
                        source_id,
                        format!("Agent context was forked but could not be attached: {error}"),
                    )),
                }
            }
            Err(error) => Ok(ConversationForkResult::history_only(
                imported,
                source_id,
                format!("Agent context could not be forked: {error}"),
            )),
        }
    }

    async fn resolve_agent_fork_point(
        &self,
        source_id: Uuid,
        until_turn_id: Option<Uuid>,
        raw_at_turn_id: Option<&str>,
        agent_id: &agents::AgentId,
    ) -> Result<Option<agents::ForkPoint>, ApplicationError> {
        let Some(until_turn_id) = until_turn_id else {
            return Ok(None);
        };
        let Ok(agent_kind) = agents::AgentKind::from_str(agent_id.as_str()) else {
            return Ok(None);
        };
        if let Some(turns) = jsonl_history::load_all_turns(&self.pool, source_id)
            .await
            .map_err(internal_error)?
            && !turns.is_empty()
        {
            if let Some(raw) = raw_at_turn_id
                && let Some(fp) = agents::resolve_fork_point_for_turn(&turns, raw, agent_kind)
            {
                return Ok(Some(fp));
            }
            if let Some(fp) =
                agents::resolve_fork_point_for_turn(&turns, &until_turn_id.to_string(), agent_kind)
            {
                return Ok(Some(fp));
            }
            let db_turns = ConversationTurnRecord::list_for_conversation(&self.pool, source_id)
                .await
                .map_err(internal_error)?;
            if let Some(user_ordinal) = db_turns.iter().position(|turn| turn.id == until_turn_id) {
                let target_turn_id = turns
                    .iter()
                    .filter(|turn| {
                        matches!(turn.role, agents::conversation::TurnRole::User)
                            && !turn.id.contains(":steer:")
                    })
                    .nth(user_ordinal)
                    .map(|turn| turn.id.clone());
                if let Some(target_turn_id) = target_turn_id
                    && let Some(fp) =
                        agents::resolve_fork_point_for_turn(&turns, &target_turn_id, agent_kind)
                {
                    return Ok(Some(fp));
                }
            }
        }
        let timeline = ConversationProjector::project(&self.pool, source_id)
            .await
            .map_err(internal_error)?;
        let turns: Vec<MessageTurn> = timeline
            .rows
            .into_iter()
            .filter_map(|row| match row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn),
                _ => None,
            })
            .collect();
        Ok(agents::resolve_fork_point_for_turn(
            &turns,
            &until_turn_id.to_string(),
            agent_kind,
        ))
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
    let turns = jsonl_history::load_all_turns(pool, conversation_id)
        .await
        .map_err(internal_error)?
        .unwrap_or_default();
    let timeline = jsonl_history::timeline_from_turns(conversation_id, &turns);
    Ok((title, timeline))
}

pub async fn load_conversation_detail(
    pool: &SqlitePool,
    id: Uuid,
    request: conversations::turn_window::TurnWindowReq,
) -> Result<Option<HostConversationDetail>, ApplicationError> {
    let Some(summary) = DbConversationSummary::find_by_id(pool, id)
        .await
        .map_err(internal_error)?
    else {
        return Ok(None);
    };
    let history = jsonl_history::load_window(pool, id, request)
        .await
        .map_err(internal_error)?
        .unwrap_or_else(jsonl_history::WindowedHistory::empty);
    let timeline = jsonl_history::timeline_from_window(id, &history);
    let usage_snapshot = ConversationUsageSnapshotRecord::find(pool, id)
        .await
        .map_err(internal_error)?;
    let session_stats =
        session_stats_with_usage_snapshot(history.session_stats.clone(), usage_snapshot.as_ref());
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
        turns: history.turns,
        timeline,
        turns_offset: history.offset as u32,
        turns_total: history.total as u32,
        prefix_hash: Some(history.meta.prefix_hash),
        user_turns_before_offset: history.meta.user_before as u32,
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
        persona: conversations::collaboration::conversation_persona(pool, id)
            .await
            .map_err(internal_error)?,
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
    if capabilities.delivery_channel == agents::conversation::DeliveryChannel::None {
        capabilities.delivery_channel = if capabilities.steering {
            agents::conversation::DeliveryChannel::Native
        } else if binding.mcp_servers_json.contains("check_user_feedback") {
            agents::conversation::DeliveryChannel::Pull
        } else {
            agents::conversation::DeliveryChannel::None
        };
    }
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
            turns_offset: 0,
            turns_total: 0,
            prefix_hash: None,
            user_turns_before_offset: 0,
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
            persona: None,
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
    fn conversation_id_args_accept_open_path_session_id() {
        let from_session: ConversationIdArgs = crate::domains::parse(serde_json::json!({
            "sessionId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        }))
        .expect("sessionId");
        assert_eq!(
            from_session.conversation_id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        );
        let from_request: EventsSinceArgs = crate::domains::parse(serde_json::json!({
            "request": {
                "sessionId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "afterSequence": 0,
                "limit": 500
            }
        }))
        .expect("events since sessionId");
        assert_eq!(
            from_request.conversation_id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        );
        assert_eq!(from_request.after_sequence, 0);
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
                Uuid::nil(),
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
