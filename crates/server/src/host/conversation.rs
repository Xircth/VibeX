use agents::{
    AgentAvailableCommand, AgentSessionConfigOption, AgentSessionControlsSnapshot,
    conversation::{
        AcpCapabilitySnapshot, ConversationEvent, ConversationRowPage, ConversationSessionModes,
        ConversationTimeline, ConversationTimelineRow, MessageTurn, SessionStats, TurnUsage,
    },
};
use application::ApplicationError;
use conversations::{CONVERSATION_PROJECTION_VERSION, ConversationProjector};
use db::models::{
    conversation::{ConversationAgentBindingRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const OPEN_TIMELINE_ROW_LIMIT: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
        session_config_options: latest_event(
            pool,
            id,
            "session_config_options_updated",
            |event| match event {
                ConversationEvent::SessionConfigOptionsUpdated { options } => Some(options),
                _ => None,
            },
        )
        .await?
        .unwrap_or_default(),
        available_commands: latest_event(pool, id, "available_commands_updated", |event| {
            match event {
                ConversationEvent::AvailableCommandsUpdated { commands } => Some(commands),
                _ => None,
            }
        })
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
