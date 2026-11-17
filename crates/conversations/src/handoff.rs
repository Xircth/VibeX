//! Durable delivery evidence for Stage B inline handoffs, plus deterministic
//! cross-engine context packing (`DeterministicHandoffService`) and `thread_read_history`
//! retrieval without any hidden LLM summarization calls.

use std::collections::HashSet;

use agents::conversation::{ContinuationPolicy, ConversationEvent, TurnRole};
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

use crate::{ConversationStartTurnInput, continuation::HistorySelection};

mod candidates;
use candidates::{CandidateItem, load_candidates, load_history_items_by_ids};

pub(crate) async fn plan(
    pool: &SqlitePool,
    input: &ConversationStartTurnInput,
    turn_id: Uuid,
    source: Option<Uuid>,
    selection: Option<&HistorySelection>,
) -> Result<(), sqlx::Error> {
    let policy = match input.continuation_policy {
        Some(ContinuationPolicy::Portable) => "portable",
        _ => "fresh",
    };
    let payload = selection.map(|s| s.prompt.as_str()).unwrap_or("");
    let selection_json =
        serde_json::to_string(&selection).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    sqlx::query("INSERT INTO conversation_handoffs (id, conversation_id, turn_id, input_id, source_binding_id, history_revision, policy, status, selection_json, payload_digest) SELECT ?, id, ?, ?, ?, history_revision, ?, 'planned', ?, ? FROM sessions WHERE id = ?")
        .bind(Uuid::new_v4()).bind(turn_id).bind(input.queued_input_claim.map(|c| c.input_id))
        .bind(source).bind(policy).bind(selection_json).bind(format!("{:x}", Sha256::digest(payload)))
        .bind(input.conversation_id).execute(pool).await?;
    Ok(())
}

pub(crate) async fn set_target(
    pool: &SqlitePool,
    turn: Uuid,
    target: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET target_binding_id = ? WHERE turn_id = ? AND status = 'planned'")
        .bind(target).bind(turn).execute(pool).await?;
    Ok(())
}

pub(crate) async fn sending(pool: &SqlitePool, turn: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET status = 'sending', updated_at = datetime('now', 'subsec') WHERE turn_id = ? AND status = 'planned' AND target_binding_id IS NOT NULL")
        .bind(turn).execute(pool).await?;
    Ok(())
}

pub(crate) async fn settle(pool: &SqlitePool, turn: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET status = CASE status WHEN 'sending' THEN 'uncertain' ELSE 'cancelled' END, updated_at = datetime('now', 'subsec') WHERE turn_id = ? AND status IN ('planned', 'sending')")
        .bind(turn).execute(pool).await?;
    Ok(())
}

pub(crate) async fn accept(
    pool: &SqlitePool,
    conversation: Uuid,
    connection: &str,
    prompt: &str,
) -> Result<(), sqlx::Error> {
    // A local PromptStarted event is never evidence. Only a successful ACP
    // prompt response, carrying its exact request ID, reaches this interface.
    sqlx::query("UPDATE conversation_handoffs SET status = 'delivered', evidence = 'acp_prompt_response', updated_at = datetime('now', 'subsec') WHERE conversation_id = ? AND status IN ('sending', 'uncertain') AND turn_id IN (SELECT id FROM conversation_turns WHERE prompt_id = ?) AND target_binding_id IN (SELECT id FROM conversation_agent_bindings WHERE connection_id = ?)")
        .bind(conversation).bind(prompt).bind(connection).execute(pool).await?;
    Ok(())
}

pub(crate) async fn recover(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET status = CASE status WHEN 'sending' THEN 'uncertain' ELSE 'cancelled' END, updated_at = datetime('now', 'subsec') WHERE status IN ('sending', 'planned')")
        .execute(pool).await?;
    Ok(())
}

/// Item IDs a binding has already received through delivered handoffs.
///
/// A resumed binding's native session may have consumed a gap in an earlier
/// switch; delivering it again would duplicate that history. Only `delivered`
/// handoffs count: planned/sending/uncertain deliveries are not evidence that
/// the target ever consumed the content.
pub(crate) async fn delivered_item_ids(
    pool: &SqlitePool,
    target_binding_id: Uuid,
) -> Result<HashSet<String>, sqlx::Error> {
    let selections: Vec<String> = sqlx::query_scalar(
        "SELECT selection_json FROM conversation_handoffs WHERE target_binding_id = ? AND status = 'delivered'",
    )
    .bind(target_binding_id)
    .fetch_all(pool)
    .await?;
    let mut ids = HashSet::new();
    for selection in selections {
        // A malformed or null selection contributes nothing rather than
        // aborting the delta computation for the whole switch.
        if let Ok(Some(selection)) = serde_json::from_str::<Option<HistorySelection>>(&selection) {
            ids.extend(selection.items.into_iter().map(|item| item.id));
        }
    }
    Ok(ids)
}

pub async fn latest_agent_handoff_sequence(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<i64, sqlx::Error> {
    let seq: Option<i64> = sqlx::query_scalar(
        r#"SELECT MAX(sequence)
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind = 'raw_diagnostic_recorded'
             AND normalized_json LIKE '%"agent_handoff"%'"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    Ok(seq.unwrap_or(0))
}

// ============================================================================
// Deterministic Cross-Engine Handoff Service (Zero LLM Calls)
// ============================================================================

/// Default context token budget when switching engines (`~24k` tokens).
pub const DEFAULT_HANDOFF_TOKEN_BUDGET: usize = 24_000;

/// Number of most-recent complete turns prioritized immediately after active error diagnostics.
pub const PRIORITY_RECENT_TURNS: usize = 3;

#[derive(Debug, Error)]
pub enum HandoffError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error("conversation {0} not found")]
    ConversationNotFound(Uuid),

    #[error("invalid token budget: must be > 0")]
    InvalidTokenBudget,

    #[error("target Agent `{0}` is empty or invalid")]
    InvalidTargetEngine(String),

    #[error("{0}")]
    InvalidTargetInstance(String),

    #[error("workflow or delegation child conversation cannot switch Agent")]
    RestrictedOwner,

    #[error("cannot switch Agent while a turn is running")]
    ActiveTurnInProgress,

    #[error("workspace root `{0}` does not exist on disk")]
    WorkspaceRootMissing(String),
}

/// Outcome returned when confirming an engine switch so the host can emit invalidation events.
#[derive(Debug, Clone)]
pub struct EngineHandoffConfirmation {
    pub workspace_id: Uuid,
    pub space_changed_events: Vec<crate::collaboration::CollaborationSpaceChangedEvent>,
    pub agent_switched: bool,
    pub instance_switched: bool,
    pub from_instance_id: Option<String>,
    pub to_instance_id: Option<String>,
    pub handoff_boundary: Option<(Uuid, agents::AgentId)>,
    pub previous_model: Option<String>,
}

/// One packed historical item inside [`ConversationEngineHandoffPreview`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationEngineHandoffPackedItem {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "sort_index")]
    pub sort_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "created_at")]
    pub created_at: Option<String>,
}

/// Wire-compatible cross-engine handoff preview & execution payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationEngineHandoffPreview {
    #[serde(alias = "source_engine")]
    pub source_engine: String,
    #[serde(alias = "target_engine")]
    pub target_engine: String,
    #[serde(alias = "packed_messages")]
    pub packed_messages: Vec<ConversationEngineHandoffPackedItem>,
    #[serde(alias = "omitted_ids")]
    pub omitted_ids: Vec<String>,
    #[serde(alias = "total_tokens")]
    pub total_tokens: usize,
    #[serde(alias = "token_budget")]
    pub token_budget: usize,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "handoff_prompt_text"
    )]
    pub handoff_prompt_text: Option<String>,
}

/// Domain alias matching the architecture spec (`HandoffContext`).
pub type HandoffContext = ConversationEngineHandoffPreview;

/// Deterministic, zero-LLM cross-engine context packer and `thread_read_history` reader.
pub struct DeterministicHandoffService;

impl DeterministicHandoffService {
    /// Fast, deterministic token estimator (~4 ASCII bytes/token, ~1.5 tokens per CJK scalar).
    ///
    /// Never calls a remote tokenizer or LLM endpoint.
    pub fn estimate_tokens(text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }
        let mut ascii_chars = 0usize;
        let mut non_ascii_chars = 0usize;
        for ch in text.chars() {
            if ch.is_ascii() {
                ascii_chars += 1;
            } else {
                non_ascii_chars += 1;
            }
        }
        let ascii_tokens = ascii_chars.div_ceil(4);
        let non_ascii_tokens = (non_ascii_chars * 3).div_ceil(2);
        (ascii_tokens + non_ascii_tokens).max(1)
    }

    /// Build a deterministic handoff context preview for switching `conversation_id` to
    /// `target_engine` within `token_budget` (defaults to [`DEFAULT_HANDOFF_TOKEN_BUDGET`]).
    pub async fn build_handoff_context(
        pool: &SqlitePool,
        conversation_id: Uuid,
        target_engine: &str,
        token_budget: Option<usize>,
    ) -> Result<HandoffContext, HandoffError> {
        let budget = token_budget.unwrap_or(DEFAULT_HANDOFF_TOKEN_BUDGET);
        if budget == 0 {
            return Err(HandoffError::InvalidTokenBudget);
        }

        let session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or(HandoffError::ConversationNotFound(conversation_id))?;

        let latest_binding =
            ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?;
        let source_engine = latest_binding
            .as_ref()
            .map(|b| b.agent_id.as_str().to_string())
            .or_else(|| session.agent_id.as_ref().map(|a| a.as_str().to_string()))
            .or_else(|| session.executor.clone())
            .unwrap_or_else(|| "unknown".to_string());

        let candidates = load_candidates(pool, conversation_id).await?;
        Ok(pack_candidates(
            &source_engine,
            target_engine.trim(),
            budget,
            conversation_id,
            candidates,
        ))
    }

    /// Build a deterministic handoff selection for turn execution using the exact same
    /// candidate prioritization, token estimation, and `<dimo-engine-handoff>` rendering
    /// as [`Self::build_handoff_context`], excluding `exclude_turn_id` and any items
    /// already known to the target binding (`known_prefixes` / `delivered_ids`).
    ///
    /// Gracefully degrades (shrinking or returning `Ok(None)`) when `byte_budget` is
    /// tight instead of failing the turn with `handoff_budget_exceeded`.
    pub async fn build_execution_handoff(
        pool: &SqlitePool,
        conversation_id: Uuid,
        target_engine: &str,
        exclude_turn_id: Uuid,
        known_prefixes: &[String],
        delivered_ids: &HashSet<String>,
        byte_budget: usize,
    ) -> Result<Option<crate::continuation::HistorySelection>, HandoffError> {
        let session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or(HandoffError::ConversationNotFound(conversation_id))?;

        let latest_binding =
            ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?;
        let source_engine = latest_binding
            .as_ref()
            .map(|b| b.agent_id.as_str().to_string())
            .or_else(|| session.agent_id.as_ref().map(|a| a.as_str().to_string()))
            .or_else(|| session.executor.clone())
            .unwrap_or_else(|| "unknown".to_string());

        let exclude_turn_str = exclude_turn_id.to_string();
        let exclude_prefix = format!("{exclude_turn_id}:");
        let candidates: Vec<CandidateItem> = load_candidates(pool, conversation_id)
            .await?
            .into_iter()
            .filter(|c| {
                if c.turn_id == Some(exclude_turn_id)
                    || c.id == exclude_turn_str
                    || c.id.starts_with(&exclude_prefix)
                {
                    return false;
                }
                if delivered_ids.contains(&c.id) {
                    return false;
                }
                if known_prefixes.iter().any(|prefix| {
                    let prefix_trimmed = prefix.trim_end_matches(':');
                    c.id == prefix_trimmed
                        || c.id.starts_with(prefix)
                        || c.turn_id.is_some_and(|tid| {
                            let tid_str = tid.to_string();
                            tid_str == prefix_trimmed || format!("{tid}:") == *prefix
                        })
                }) {
                    return false;
                }
                true
            })
            .collect();

        if candidates.is_empty() || byte_budget == 0 {
            if !candidates.is_empty() && byte_budget == 0 {
                tracing::warn!(
                    %conversation_id,
                    %exclude_turn_id,
                    "current input exhausts handoff byte budget; skipping inline history context"
                );
            }
            return Ok(None);
        }

        let target = target_engine.trim();
        let mut token_budget = ((byte_budget / 4).max(1)).min(DEFAULT_HANDOFF_TOKEN_BUDGET);
        loop {
            let ctx = pack_candidates(
                &source_engine,
                target,
                token_budget,
                conversation_id,
                candidates.clone(),
            );
            if let Some(prompt_text) = ctx.handoff_prompt_text.as_ref()
                && prompt_text.len() <= byte_budget
            {
                let items = ctx
                    .packed_messages
                    .iter()
                    .map(|m| crate::continuation::HistoryItem {
                        id: m.id.clone(),
                        role: match m.role.as_str() {
                            "user" => TurnRole::User,
                            "system" => TurnRole::System,
                            _ => TurnRole::Assistant,
                        },
                        text: m.content.clone(),
                        omitted_blocks: 0,
                    })
                    .collect::<Vec<_>>();
                return Ok(Some(crate::continuation::HistorySelection {
                    omitted_items: ctx.omitted_ids.len(),
                    omitted_ids: ctx.omitted_ids,
                    omitted_blocks: 0,
                    items,
                    prompt: prompt_text.clone(),
                }));
            }
            if token_budget <= 16 {
                break;
            }
            token_budget = (token_budget / 2).max(16);
        }

        // Last-resort graceful fallback: omitted-only reference notice if it fits in byte_budget,
        // otherwise omit the inline handoff block completely so the turn still proceeds.
        let omitted_ids: Vec<String> = candidates.into_iter().map(|c| c.id).collect();
        let minimal_prompt = format_handoff_prompt_text(
            conversation_id,
            &source_engine,
            target,
            &[],
            &omitted_ids,
            token_budget,
        );
        if minimal_prompt.len() <= byte_budget {
            tracing::warn!(
                %conversation_id,
                %exclude_turn_id,
                byte_budget,
                "handoff items exceed byte budget; falling back to omitted-history reference"
            );
            return Ok(Some(crate::continuation::HistorySelection {
                omitted_items: omitted_ids.len(),
                omitted_ids,
                omitted_blocks: 0,
                items: Vec::new(),
                prompt: minimal_prompt,
            }));
        }

        tracing::warn!(
            %conversation_id,
            %exclude_turn_id,
            byte_budget,
            minimal_bytes = minimal_prompt.len(),
            "current input leaves insufficient space for handoff wrapper; omitting inline history"
        );
        Ok(None)
    }

    /// Retrieve full, untruncated historical items by `row_id` (or `turn_id`) to back the
    /// `thread_read_history` MCP tool when an agent inspects `omitted_ids`.
    pub async fn read_history_items_by_ids(
        pool: &SqlitePool,
        conversation_id: Uuid,
        item_ids: &[String],
    ) -> Result<Vec<ConversationEngineHandoffPackedItem>, HandoffError> {
        if Session::find_by_id(pool, conversation_id).await?.is_none() {
            return Err(HandoffError::ConversationNotFound(conversation_id));
        }
        Ok(load_history_items_by_ids(pool, conversation_id, item_ids).await?)
    }
}

fn pack_candidates(
    source_engine: &str,
    target_engine: &str,
    token_budget: usize,
    conversation_id: Uuid,
    mut candidates: Vec<CandidateItem>,
) -> HandoffContext {
    if candidates.is_empty() {
        return HandoffContext {
            source_engine: source_engine.to_string(),
            target_engine: target_engine.to_string(),
            packed_messages: Vec::new(),
            omitted_ids: Vec::new(),
            total_tokens: 0,
            token_budget,
            handoff_prompt_text: None,
        };
    }

    // Order for selection: highest priority first (`UnresolvedError` < `RecentTurn` <
    // `FileModification` < `HistoricalTurn`), then newest (`sort_index DESC`) first!
    let mut ranked_indices: Vec<usize> = (0..candidates.len()).collect();
    ranked_indices.sort_by(|&a, &b| {
        candidates[a]
            .priority
            .cmp(&candidates[b].priority)
            .then_with(|| candidates[b].sort_index.cmp(&candidates[a].sort_index))
    });

    let mut selected = vec![false; candidates.len()];
    let mut total_tokens = 0usize;

    for idx in ranked_indices {
        let item_tokens = candidates[idx].tokens;
        if total_tokens.saturating_add(item_tokens) <= token_budget {
            selected[idx] = true;
            total_tokens = total_tokens.saturating_add(item_tokens);
        } else if total_tokens == 0 && selected.iter().all(|&s| !s) {
            // Always fit at least a truncated slice of the single highest-priority item so
            // a tiny budget never produces a blank handoff when history exists.
            let max_chars = token_budget.saturating_mul(3).max(32);
            let clipped: String = candidates[idx].content.chars().take(max_chars).collect();
            candidates[idx].content = format!("{clipped}\n…[clipped to token budget]");
            candidates[idx].tokens =
                DeterministicHandoffService::estimate_tokens(&candidates[idx].content)
                    .min(token_budget);
            selected[idx] = true;
            total_tokens = candidates[idx].tokens;
        }
    }

    // Emit packed items and omitted IDs in chronological (`sort_index ASC`) order.
    let mut packed_messages = Vec::new();
    let mut omitted_ids = Vec::new();
    for (idx, item) in candidates.into_iter().enumerate() {
        if selected[idx] {
            packed_messages.push(ConversationEngineHandoffPackedItem {
                id: item.id,
                role: item.role,
                content: item.content,
                sort_index: Some(item.sort_index),
                created_at: item.created_at,
            });
        } else {
            omitted_ids.push(item.id);
        }
    }

    let handoff_prompt_text = Some(format_handoff_prompt_text(
        conversation_id,
        source_engine,
        target_engine,
        &packed_messages,
        &omitted_ids,
        token_budget,
    ));

    HandoffContext {
        source_engine: source_engine.to_string(),
        target_engine: target_engine.to_string(),
        packed_messages,
        omitted_ids,
        total_tokens,
        token_budget,
        handoff_prompt_text,
    }
}

/// Render the portable `<dimo-engine-handoff>` context block with an explicit MCP
/// `thread_read_history` hint whenever historical items were omitted.
pub fn format_handoff_prompt_text(
    conversation_id: Uuid,
    source_engine: &str,
    target_engine: &str,
    packed_messages: &[ConversationEngineHandoffPackedItem],
    omitted_ids: &[String],
    token_budget: usize,
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "<dimo-engine-handoff conversation_id=\"{conversation_id}\" source_engine=\"{source_engine}\" target_engine=\"{target_engine}\">\n"
    ));
    for item in packed_messages {
        out.push_str(&format!(
            "<item id=\"{}\" role=\"{}\">\n{}\n</item>\n",
            item.id, item.role, item.content
        ));
    }
    if !omitted_ids.is_empty() {
        let preview_ids: Vec<&str> = omitted_ids.iter().take(32).map(String::as_str).collect();
        let more_suffix = if omitted_ids.len() > 32 {
            format!(" (+{} more)", omitted_ids.len() - 32)
        } else {
            String::new()
        };
        out.push_str(&format!(
            "<omitted_history count=\"{}\" token_budget=\"{token_budget}\">\n\
             Earlier turns were omitted to fit the deterministic handoff budget: [{}{}].\n\
             If you need full untruncated details from any omitted turn, call MCP tool `thread_read_history` \
             with `conversation_id=\"{conversation_id}\"` and `item_ids`.\n\
             </omitted_history>\n",
            omitted_ids.len(),
            preview_ids.join(", "),
            more_suffix
        ));
    }
    out.push_str("</dimo-engine-handoff>");
    out
}

impl DeterministicHandoffService {
    /// Read-only atomic preflight validation before switching a conversation's Agent engine
    /// or provider instance.
    ///
    /// Verifies target engine non-emptiness, target provider instance validity, conversation
    /// existence, non-restricted ownership, absence of an active turn, and on-disk existence
    /// of any bound workspace `container_ref` before performing any persistence flush or SQLite write.
    pub async fn preflight_engine_handoff(
        pool: &SqlitePool,
        conversation_id: Uuid,
        target_agent_id: &agents::AgentId,
        target_provider_instance_id: Option<&str>,
    ) -> Result<Session, HandoffError> {
        use db::models::{conversation_turn::ConversationTurnRecord, workspace::Workspace};

        if target_agent_id.as_str().trim().is_empty() {
            return Err(HandoffError::InvalidTargetEngine(
                target_agent_id.as_str().to_string(),
            ));
        }

        if let Some(requested_instance) = target_provider_instance_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            crate::resolve_effective_provider_instance_id(
                pool,
                target_agent_id,
                Some(requested_instance),
            )
            .await
            .map_err(|err| match err {
                crate::ConversationServiceError::BadRequest(msg) => {
                    HandoffError::InvalidTargetInstance(msg)
                }
                crate::ConversationServiceError::Internal(msg) => {
                    HandoffError::Database(sqlx::Error::Protocol(msg))
                }
                other => HandoffError::InvalidTargetInstance(other.to_string()),
            })?;
        }

        let session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or(HandoffError::ConversationNotFound(conversation_id))?;

        let is_restricted_child: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(
                   SELECT 1 FROM conversation_relations
                   WHERE child_conversation_id = ?
                     AND kind IN ('workflow_step', 'delegation')
               )"#,
        )
        .bind(conversation_id)
        .fetch_one(pool)
        .await?;
        if is_restricted_child {
            return Err(HandoffError::RestrictedOwner);
        }

        if ConversationTurnRecord::find_active_for_session(pool, conversation_id)
            .await?
            .is_some()
        {
            return Err(HandoffError::ActiveTurnInProgress);
        }

        if let Some(workspace) = Workspace::find_by_id(pool, session.workspace_id).await?
            && let Some(container_ref) = workspace
                .container_ref
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
            && !std::path::Path::new(container_ref).is_dir()
        {
            return Err(HandoffError::WorkspaceRootMissing(
                container_ref.to_string(),
            ));
        }

        Ok(session)
    }

    /// Persist an intentional Agent or provider-instance switch on `sessions`, synchronize any
    /// linked Collaboration Bot identity (`collaboration_members`, `conversation_personas`, and
    /// idle sibling thread conversations), and preserve `active_agent_binding_id` so
    /// `prepare_turn_continuation` still delivers portable history on the next turn.
    pub async fn confirm_engine_handoff(
        pool: &SqlitePool,
        conversation_id: Uuid,
        target_agent_id: &agents::AgentId,
        target_provider_instance_id: Option<&str>,
    ) -> Result<EngineHandoffConfirmation, HandoffError> {
        use std::collections::BTreeSet;
        use db::models::{
            conversation::ConversationAgentBindingRecord,
            conversation_turn::ConversationTurnRecord,
            session::{normalize_provider_instance_id, normalize_provider_instance_storage_id},
        };

        let session = Self::preflight_engine_handoff(
            pool,
            conversation_id,
            target_agent_id,
            target_provider_instance_id,
        )
        .await?;

        let prev_session_agent = session.agent_id.clone().or_else(|| {
            session
                .executor
                .as_deref()
                .and_then(agents::AgentKind::from_lenient)
                .and_then(|kind| agents::AgentId::parse(kind.as_str()).ok())
        });
        let agent_switched = prev_session_agent
            .as_ref()
            .is_some_and(|prev| prev != target_agent_id);

        let requested_target_instance = target_provider_instance_id
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let prev_effective_instance = if let Some(ref prev_agent) = prev_session_agent {
            match crate::resolve_effective_provider_instance_id(
                pool,
                prev_agent,
                session.provider_instance_id.as_deref(),
            )
            .await
            {
                Ok(id) => id,
                Err(_) => normalize_provider_instance_id(session.provider_instance_id.as_deref()),
            }
        } else {
            normalize_provider_instance_id(session.provider_instance_id.as_deref())
        };

        let next_storage_instance = if let Some(req) = requested_target_instance {
            normalize_provider_instance_storage_id(Some(req))
        } else if agent_switched {
            None
        } else {
            session.provider_instance_id.clone()
        };

        let next_effective_instance = crate::resolve_effective_provider_instance_id(
            pool,
            target_agent_id,
            next_storage_instance.as_deref(),
        )
        .await
        .map_err(|err| match err {
            crate::ConversationServiceError::BadRequest(msg) => {
                HandoffError::InvalidTargetInstance(msg)
            }
            crate::ConversationServiceError::Internal(msg) => {
                HandoffError::Database(sqlx::Error::Protocol(msg))
            }
            other => HandoffError::InvalidTargetInstance(other.to_string()),
        })?;

        let instance_switched = !agent_switched && prev_effective_instance != next_effective_instance;
        let switched = agent_switched || instance_switched;

        if switched {
            crate::runtime_events::flush_conversation_persistence(conversation_id).await;
        }

        let last_turn_row: Option<(Uuid, Option<String>)> = sqlx::query_as(
            r#"SELECT t.id, b.agent_id
               FROM conversation_turns t
               LEFT JOIN conversation_agent_bindings b ON b.id = t.agent_binding_id
               WHERE t.conversation_id = ?
               ORDER BY t.ordinal DESC
               LIMIT 1"#,
        )
        .bind(conversation_id)
        .fetch_optional(pool)
        .await?;

        let active_binding_agent = if last_turn_row.is_some() {
            ConversationAgentBindingRecord::active_for_conversation(pool, conversation_id)
                .await?
                .map(|b| b.agent_id)
        } else {
            None
        };

        let handoff_boundary = if let Some((last_turn_id, turn_binding_agent_raw)) = last_turn_row {
            let origin_agent = turn_binding_agent_raw
                .as_deref()
                .and_then(|raw| agents::AgentId::parse(raw).ok())
                .or(active_binding_agent)
                .or_else(|| prev_session_agent.clone());
            origin_agent
                .filter(|origin| switched || origin != target_agent_id)
                .map(|origin| (last_turn_id, origin))
        } else {
            None
        };

        let mut previous_model = sqlx::query_scalar::<_, Option<String>>(
            "SELECT model FROM sessions WHERE id = ?",
        )
        .bind(conversation_id)
        .fetch_optional(pool)
        .await?
        .flatten()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
        if previous_model.is_none() && handoff_boundary.is_some() {
            previous_model = sqlx::query_scalar::<_, Option<String>>(
                "SELECT model FROM conversation_usage_snapshots WHERE conversation_id = ?",
            )
            .bind(conversation_id)
            .fetch_optional(pool)
            .await?
            .flatten()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        }

        let next_agent = target_agent_id.as_str();
        sqlx::query(
            r#"UPDATE sessions
               SET external_session_id = CASE
                       WHEN ?3 = 1 THEN NULL
                       WHEN agent_id IS NOT NULL AND agent_id != ?1 THEN NULL
                       WHEN agent_id IS NULL
                            AND executor IS NOT NULL
                            AND lower(replace(executor, '-', '_')) != lower(replace(?1, '-', '_'))
                       THEN NULL
                       ELSE external_session_id
                   END,
                   model = CASE
                       WHEN ?3 = 1 THEN NULL
                       WHEN agent_id IS NOT NULL AND agent_id != ?1 THEN NULL
                       WHEN agent_id IS NULL
                            AND executor IS NOT NULL
                            AND lower(replace(executor, '-', '_')) != lower(replace(?1, '-', '_'))
                       THEN NULL
                       ELSE model
                   END,
                   agent_id = ?1,
                   agent_type = ?1,
                   executor = ?1,
                   provider_instance_id = ?4,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?2"#,
        )
        .bind(next_agent)
        .bind(conversation_id)
        .bind(i64::from(switched))
        .bind(next_storage_instance.as_deref())
        .execute(pool)
        .await?;

        let conv_str = conversation_id.to_string();
        sqlx::query("UPDATE conversation_personas SET agent_id = ?1 WHERE conversation_id = ?2")
            .bind(next_agent)
            .bind(&conv_str)
            .execute(pool)
            .await?;

        let mut member_ids: BTreeSet<String> = BTreeSet::new();
        let thread_member_ids: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT member_id FROM collaboration_thread_members WHERE conversation_id = ?",
        )
        .bind(&conv_str)
        .fetch_all(pool)
        .await?;
        for mid in thread_member_ids {
            let trimmed = mid.trim();
            if !trimmed.is_empty() {
                member_ids.insert(trimmed.to_string());
            }
        }
        let space_member_ids: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT member_id
               FROM collaboration_space_members
               WHERE conversation_id = ? AND member_id IS NOT NULL"#,
        )
        .bind(&conv_str)
        .fetch_all(pool)
        .await?;
        for mid in space_member_ids {
            let trimmed = mid.trim();
            if !trimmed.is_empty() {
                member_ids.insert(trimmed.to_string());
            }
        }

        let mut affected_spaces: BTreeSet<String> = BTreeSet::new();
        let conv_spaces: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT space_id FROM collaboration_space_members WHERE conversation_id = ?",
        )
        .bind(&conv_str)
        .fetch_all(pool)
        .await?;
        for sid in conv_spaces {
            if !sid.trim().is_empty() {
                affected_spaces.insert(sid);
            }
        }

        for member_id in &member_ids {
            sqlx::query(
                r#"UPDATE collaboration_members
                   SET model = CASE
                           WHEN ?3 = 1 THEN NULL
                           WHEN lower(replace(COALESCE(agent, ''), '-', '_')) != lower(replace(?1, '-', '_'))
                           THEN NULL
                           ELSE model
                       END,
                       mode_id = CASE
                           WHEN ?3 = 1 THEN NULL
                           WHEN lower(replace(COALESCE(agent, ''), '-', '_')) != lower(replace(?1, '-', '_'))
                           THEN NULL
                           ELSE mode_id
                       END,
                       config_values = CASE
                           WHEN ?3 = 1 THEN '{}'
                           WHEN lower(replace(COALESCE(agent, ''), '-', '_')) != lower(replace(?1, '-', '_'))
                           THEN '{}'
                           ELSE config_values
                       END,
                       agent = ?1
                   WHERE id = ?2"#,
            )
            .bind(next_agent)
            .bind(member_id)
            .bind(i64::from(switched))
            .execute(pool)
            .await?;

            let sibling_convs: Vec<String> = sqlx::query_scalar(
                r#"SELECT DISTINCT conversation_id
                   FROM collaboration_thread_members
                   WHERE member_id = ? AND status = 'active'"#,
            )
            .bind(member_id)
            .fetch_all(pool)
            .await?;
            for sibling_raw in sibling_convs {
                let Ok(sibling_id) = Uuid::parse_str(sibling_raw.trim()) else {
                    continue;
                };
                if sibling_id == conversation_id {
                    continue;
                }
                if ConversationTurnRecord::find_active_for_session(pool, sibling_id)
                    .await?
                    .is_some()
                {
                    continue;
                }
                sqlx::query(
                    r#"UPDATE sessions
                       SET external_session_id = CASE
                               WHEN ?3 = 1 THEN NULL
                               WHEN agent_id IS NOT NULL AND agent_id != ?1 THEN NULL
                               ELSE external_session_id
                           END,
                           model = CASE
                               WHEN ?3 = 1 THEN NULL
                               WHEN agent_id IS NOT NULL AND agent_id != ?1 THEN NULL
                               ELSE model
                           END,
                           agent_id = ?1,
                           agent_type = ?1,
                           executor = ?1,
                           provider_instance_id = ?4,
                           updated_at = datetime('now', 'subsec')
                       WHERE id = ?2"#,
                )
                .bind(next_agent)
                .bind(sibling_id)
                .bind(i64::from(switched))
                .bind(next_storage_instance.as_deref())
                .execute(pool)
                .await?;
                sqlx::query(
                    "UPDATE conversation_personas SET agent_id = ?1 WHERE conversation_id = ?2",
                )
                .bind(next_agent)
                .bind(sibling_id.to_string())
                .execute(pool)
                .await?;
            }

            let member_spaces: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT space_id FROM collaboration_space_members WHERE member_id = ?",
            )
            .bind(member_id)
            .fetch_all(pool)
            .await?;
            for sid in member_spaces {
                if !sid.trim().is_empty() {
                    affected_spaces.insert(sid);
                }
            }
            affected_spaces.insert(format!("direct:{member_id}"));
        }

        let mut space_changed_events = Vec::with_capacity(affected_spaces.len());
        for space_id in affected_spaces {
            space_changed_events.push(
                crate::collaboration::latest_space_changed_event(
                    pool,
                    session.workspace_id,
                    &space_id,
                    None,
                )
                .await,
            );
        }

        Ok(EngineHandoffConfirmation {
            workspace_id: session.workspace_id,
            space_changed_events,
            agent_switched,
            instance_switched,
            from_instance_id: prev_effective_instance,
            to_instance_id: next_effective_instance,
            handoff_boundary,
            previous_model,
        })
    }
}

impl crate::ConversationSessionService {
    pub async fn preflight_engine_handoff(
        &self,
        conversation_id: Uuid,
        target_agent_id: &agents::AgentId,
        target_provider_instance_id: Option<&str>,
    ) -> Result<(), HandoffError> {
        let _ = DeterministicHandoffService::preflight_engine_handoff(
            &self.ctx.deployment.db().pool,
            conversation_id,
            target_agent_id,
            target_provider_instance_id,
        )
        .await?;
        Ok(())
    }

    pub async fn preview_engine_handoff(
        &self,
        conversation_id: Uuid,
        target_engine: &str,
        token_budget: Option<usize>,
    ) -> Result<HandoffContext, HandoffError> {
        DeterministicHandoffService::build_handoff_context(
            &self.ctx.deployment.db().pool,
            conversation_id,
            target_engine,
            token_budget,
        )
        .await
    }

    pub async fn confirm_engine_handoff(
        &self,
        conversation_id: Uuid,
        target_agent_id: &agents::AgentId,
        target_provider_instance_id: Option<&str>,
    ) -> Result<EngineHandoffConfirmation, HandoffError> {
        let confirmation = DeterministicHandoffService::confirm_engine_handoff(
            &self.ctx.deployment.db().pool,
            conversation_id,
            target_agent_id,
            target_provider_instance_id,
        )
        .await?;
        if confirmation.agent_switched || confirmation.instance_switched {
            self.drop_live_agent_connection(conversation_id).await;
        }
        if let Some((last_turn_id, ref origin_agent)) = confirmation.handoff_boundary {
            let handoff_tokens = match DeterministicHandoffService::build_handoff_context(
                &self.ctx.deployment.db().pool,
                conversation_id,
                target_agent_id.as_str(),
                None,
            )
            .await
            {
                Ok(ctx) if ctx.total_tokens > 0 => Some(ctx.total_tokens),
                Ok(_) => None,
                Err(error) => {
                    tracing::warn!(
                        %conversation_id,
                        %error,
                        "failed to compute handoff token count for timeline event"
                    );
                    None
                }
            };
            let payload = serde_json::json!({
                "kind": "agent_handoff",
                "afterTurnId": last_turn_id,
                "fromAgent": origin_agent.as_str(),
                "toAgent": target_agent_id.as_str(),
                "fromInstance": confirmation.from_instance_id,
                "toInstance": confirmation.to_instance_id,
                "fromModel": confirmation.previous_model,
                "handoffTokens": handoff_tokens,
                "continuationPolicy": "portable",
            });
            if let Err(error) = self
                .append_event(
                    conversation_id,
                    None,
                    "host",
                    ConversationEvent::RawDiagnosticRecorded {
                        label: "agent_handoff".into(),
                        payload: Some(payload),
                    },
                    None,
                )
                .await
            {
                tracing::warn!(
                    %conversation_id,
                    %error,
                    "failed to append cross-agent handoff timeline event"
                );
            }
        }
        Ok(confirmation)
    }

    pub async fn append_fork_handoff_notice(
        &self,
        conversation_id: Uuid,
        after_turn_id: Uuid,
        from_agent: &agents::AgentId,
        to_agent: &agents::AgentId,
        from_model: Option<&str>,
    ) {
        let handoff_tokens = match DeterministicHandoffService::build_handoff_context(
            &self.ctx.deployment.db().pool,
            conversation_id,
            to_agent.as_str(),
            None,
        )
        .await
        {
            Ok(ctx) if ctx.total_tokens > 0 => Some(ctx.total_tokens),
            Ok(_) => None,
            Err(error) => {
                tracing::warn!(
                    %conversation_id,
                    %error,
                    "failed to compute fork handoff token count for timeline event"
                );
                None
            }
        };
        let payload = serde_json::json!({
            "kind": "agent_handoff",
            "handoffKind": "fork",
            "afterTurnId": after_turn_id,
            "fromAgent": from_agent.as_str(),
            "toAgent": to_agent.as_str(),
            "fromModel": from_model,
            "handoffTokens": handoff_tokens,
            "continuationPolicy": "portable",
        });
        if let Err(error) = self
            .append_event(
                conversation_id,
                None,
                "host",
                ConversationEvent::RawDiagnosticRecorded {
                    label: "agent_handoff".into(),
                    payload: Some(payload),
                },
                None,
            )
            .await
        {
            tracing::warn!(
                %conversation_id,
                %error,
                "failed to append fork handoff timeline event"
            );
        }
    }
}

#[cfg(test)]
mod tests;
