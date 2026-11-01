//! Host collaboration control plane.
//!
//! Roles, spawned conversations, same-workspace send, delayed inputs, and
//! collaboration spaces all enter through this module. An immediate message is
//! persisted with [`ConversationInputControl::submit`], then
//! [`IdleTurnDispatcher`] starts a turn when the conversation is idle. Without
//! that dispatcher the receipt stays `queued`. A delayed row has no queue
//! position until the promoter calls the same submit with the row's operation
//! id. Steering never falls back to submit.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::ConversationRelationControl;

mod collection;
mod delivery;
mod hot_group;
mod prompt;
mod reactions;
mod roles;
mod routing;
mod scheduled;
mod warmup;

#[cfg(test)]
pub(crate) mod test_support;

pub(crate) use collection::purge_space_collection;
pub use collection::{
    AddSpaceCollectionItem, SPACE_COLLECTION_MAX_BYTES, SpaceCollectionItemRecord,
    SpaceCollectionReadRecord, add_to_space_collection, add_to_space_collection_with,
    collection_dir_display, ensure_space_collection_dir, ensure_space_collection_dir_async,
    is_team_space_collection_file, list_space_collection, list_space_collection_with,
    read_space_collection_item, read_space_collection_item_with, remove_space_collection_item,
    remove_space_collection_item_with, space_collection_dir, update_space_collection_item_note,
    update_space_collection_item_note_with,
};
pub use delivery::{
    DeliveryReceipt, MISSED_CONTEXT_VERBATIM, MessageAudience, MessageReceipt, PostDirectMessage,
    PostToSpace, SendReceipt, SendSessionInput, SpaceMessage, SpacePostResult, SpaceTurnInterrupt,
    SpaceTurnStreamingStep, advance_round, advance_space_turn_streaming_step,
    append_space_turn_streaming_text, cancel_space_turn, cancel_space_turn_with,
    clear_space_turn_flushing_step, clear_space_turn_tool_started, finalize_space_turn_deliveries,
    interrupt_space_member_turn, list_message_receipts, list_message_receipts_batch,
    list_space_messages, mark_space_turn_tool_started, notify_space_turn_streaming,
    on_space_turn_tool_call, post_direct_message, post_direct_message_with, post_to_space,
    post_to_space_with, prepare_steer, redeliver_deferred, reset_space_turn_streaming_step,
    send_session_input, send_session_input_with, send_user_text_to_conversation,
    space_turn_streaming_step,
};
pub(crate) use delivery::{
    accept_space_replay, decode_replay, deliver_text, digest_text, finish_immediate, finish_tx,
    last_completed_delivery_seq, load_stored_operation, parse_space_envelope,
    parse_space_envelope_str, round_speaking_order_line, seat_binding, split_missed_group_context,
    store_operation, sweep_round_grace_detach, working_peers_line,
};
pub use hot_group::HotGroupTracker;
pub(crate) use prompt::{
    COLLABORATION_MCP_TOOLS_SUMMARY, compose_space_delivery_prompt,
    format_collaboration_space_rules,
};
pub use prompt::{
    PRIVATE_BOOTSTRAP_CLOSE_TAG, PRIVATE_BOOTSTRAP_OPEN_TAG, build_bot_bootstrap_prompt,
    invalidate_space_delivery_prompt_injections, prefix_persona_prompt,
    strip_private_bootstrap_tags,
};
pub use reactions::{
    SPACE_REACTION_USER_ACTOR, SpaceReaction, attach_reactions_to_json_messages,
    canonical_space_message_id, list_space_reactions, list_space_reactions_batch,
    toggle_space_reaction,
};
pub use roles::{
    BatchDeleteMemberTarget, BatchDeleteResult, CollaborationSpaceChangedEvent,
    ConversationListItem, ConversationPersonaView, CreateSpaceMemberRequest,
    CreateSpawnedConversation, CreatedConversation, HostCreateSpaceMember,
    IsolatedWorkspaceProvisioner, ListConversations, MemberRecord, MemberSessionConfig,
    MemberWriteAccess, MemberWritePlan, RoleRecord, SaveRole, SaveTeam, SpaceEventList,
    SpaceEventRecord, SpaceRecord, TeamRecord, WorkspaceConversationOption,
    active_collaboration_children, add_space_member, bump_space_generation,
    collaboration_parent_depth, conversation_is_space_session, conversation_persona,
    create_collaboration_space, create_role, create_space_member, create_spawned_conversation,
    create_team, create_workspace_space, delete_collaboration_space, delete_role,
    delete_space_member, delete_team, ensure_user_member, execution_workspace_id,
    host_add_space_member, host_batch_delete_space_items, host_create_space_member,
    host_move_space_member, identity_member_id_for_conversation, is_caller_workspace_supervisor,
    is_member_supervisor, latest_space_changed_event, leave_space,
    list_collaboration_spaces_for_caller, list_conversations, list_roles, list_space_events,
    list_space_members, list_space_members_detailed, list_spaces_for_caller, list_teams,
    list_workspace_conversations, list_workspace_spaces, load_conversation_member_session_config,
    load_member_session_config, load_space_generation, member_activity_limit,
    member_space_context_text, member_space_context_text_for, member_worktree_workspace_id,
    parse_unassigned_space_id, persona_prompt_text, persona_prompt_text_for_turn,
    plan_member_write, read_session_info_for_delegation, read_session_info_for_session_product,
    record_member_session_workspace, release_member_write, remove_space_member,
    rename_workspace_space, require_supervisor_or_group_admin, require_workspace_supervisor,
    resolve_bot_conversation, resolve_member_target, resolve_session, resolve_thread_session,
    restore_space_from_archive, set_conversation_persona_team, set_member_session_config,
    set_member_write_access, set_space_identity, set_space_lead, space_event_retention_days,
    space_member_tool_value, space_tracks_events, space_workspace_id, sweep_expired_space_events,
    sweep_expired_space_events_before, thread_id_for_conversation, transfer_space_lead,
    try_acquire_member_write, unassigned_space_id, update_role, update_team,
};
pub(crate) use roles::{
    append_space_event, append_space_event_pool, append_space_event_tx, caller_seat, load_space,
    load_space_or_unassigned, member_nickname, require_caller_thread, resolve_seat_target,
    seat_conversation,
};
pub use routing::{
    DEFAULT_AGENT_REPLY_CHAIN_MAX, DEFAULT_COLLAB_TURN_TIMEOUT_MINUTES, DEFAULT_IDLE_SLEEP_MINUTES,
    DEFAULT_WAKE_CAP_PER_TURN, WAKE_LIMIT_REACHED, WakePreview, agent_reply_chain_max,
    clean_space_display_text, collab_turn_timeout_minutes, idle_sleep_minutes,
    is_broadcast_target_name, preview_space_wake, sleep_idle_sessions, spawn_idle_session_sweeper,
    sweep_expired_turns, wake_cap_per_turn,
};
pub(crate) use routing::{
    actor_display_name, env_i64, hold_over_wake_cap, is_bot_space, is_group_space, is_pass_token,
    is_person_ref, mentioned_local_bot_nicknames, recipient_display_name, reserve_wake,
    resolve_targets, session_is_asleep, strip_own_nickname_prefix, strip_stray_pass_tokens,
    touch_session_activity, wake_turn_in_flight, wake_turn_key, workspace_direct_peers,
};
pub use scheduled::{
    ScheduledSpaceMessage, cancel_space_scheduled_message, list_space_scheduled_messages,
    post_to_space_delayed_with, promote_due_delayed_inputs, promote_due_delayed_inputs_with,
    spawn_delayed_input_promoter, update_space_scheduled_message,
};
pub(crate) use scheduled::{schedule_input, scheduled_deadline};
pub use warmup::{SessionProcessWarmup, SpaceWarmupResult, warmup_space_members};

const ROLE_CAP: i64 = 100;
const TEAM_CAP: i64 = 30;
const LIST_DEFAULT_LIMIT: i64 = 50;
const LIST_HARD_CAP: i64 = 100;
const SPACE_LIST_DEFAULT: i64 = 50;
const SPACE_LIST_HARD_CAP: i64 = 200;
const SUBMIT_HOURLY_CAP: i64 = 60;
const HARD_DELAY_HOURS: i64 = 168;

/// Assistant-to-assistant wakes allowed on one user-rooted message.
/// Raise this (or later read it from config) to loosen the hop cap.
pub const MAX_ASSISTANT_HOPS_PER_ROOT: i64 = 8;
/// In-flight (`processing`) deliveries allowed in one group at a time.
/// Raise this (or later read it from config) to loosen the concurrency cap.
pub const MAX_IN_FLIGHT_DELIVERIES_PER_SPACE: i64 = 2;

/// Stored on the system notice posted when a hop or concurrency cap is hit.
pub const COLLABORATION_LIMIT_NOTICE_ZH: &str = "已达到自动协作上限，请 @ 助手继续";
pub const COLLABORATION_LIMIT_NOTICE_EN: &str =
    "Automatic collaboration limit reached. @ a Bot to continue.";

/// Starts the next durable input when the conversation has no in-flight turn.
/// The Application Core service is the production implementation. A missing
/// dispatcher leaves the input queued; the receipt must not say `dispatched`.
#[async_trait]
pub trait IdleTurnDispatcher: Send + Sync {
    async fn start_if_idle(&self, conversation_id: Uuid) -> Result<Option<Uuid>, String>;
}

/// Stops the Agent turn behind a collaboration turn. Interrupting is a control
/// command, not a durable write: the real ACP turn is stopped first and the
/// collaboration ledger is closed afterwards. A missing interruptor must fail
/// loudly instead of reporting an interruption that never happened.
#[async_trait]
pub trait TurnInterruptor: Send + Sync {
    async fn interrupt_turn(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), String>;
}

/// Publisher, idle-start and turn-stop hooks for one host process. Tests omit
/// them.
#[derive(Clone, Default)]
pub struct DeliveryContext {
    pub publisher: Option<Arc<dyn crate::ConversationEventPublisher>>,
    pub dispatcher: Option<Arc<dyn IdleTurnDispatcher>>,
    pub interruptor: Option<Arc<dyn TurnInterruptor>>,
    pub space_changed: Option<Arc<dyn Fn(CollaborationSpaceChangedEvent) + Send + Sync>>,
}

#[allow(clippy::type_complexity)]
fn global_space_changed_listener()
-> &'static std::sync::RwLock<Option<Arc<dyn Fn(CollaborationSpaceChangedEvent) + Send + Sync>>> {
    static LISTENER: std::sync::OnceLock<
        std::sync::RwLock<Option<Arc<dyn Fn(CollaborationSpaceChangedEvent) + Send + Sync>>>,
    > = std::sync::OnceLock::new();
    LISTENER.get_or_init(|| std::sync::RwLock::new(None))
}

impl DeliveryContext {
    pub fn with_space_changed(
        mut self,
        listener: impl Fn(CollaborationSpaceChangedEvent) + Send + Sync + 'static,
    ) -> Self {
        let arc: Arc<dyn Fn(CollaborationSpaceChangedEvent) + Send + Sync> = Arc::new(listener);
        if let Ok(mut guard) = global_space_changed_listener().write() {
            *guard = Some(arc.clone());
        }
        self.space_changed = Some(arc);
        self
    }

    pub fn notify_space_changed(&self, event: CollaborationSpaceChangedEvent) {
        if let Some(listener) = &self.space_changed {
            listener(event);
        } else if let Some(listener) = global_space_changed_listener()
            .read()
            .ok()
            .and_then(|guard| guard.clone())
        {
            listener(event);
        }
    }
}

/// Why a new child cannot be admitted under the shared collaboration budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDeny {
    Depth { current: u32, limit: u32 },
    Active { active: u32, limit: u32 },
}

/// Depth and active-child decision shared by `delegate_to_agent` and
/// `create_conversation`. Callers supply the active count they can see:
/// the broker adds in-flight tasks, durable creates count living children.
pub fn admit_collaboration_child(
    parent_depth: u32,
    active_children: u32,
    depth_limit: u32,
    max_active_children: u32,
) -> Result<(), AdmissionDeny> {
    let depth_limit = depth_limit.clamp(1, 8);
    let max_active_children = max_active_children.clamp(1, 64);
    let next_depth = parent_depth.saturating_add(1);
    if next_depth > depth_limit {
        return Err(AdmissionDeny::Depth {
            current: next_depth,
            limit: depth_limit,
        });
    }
    if active_children >= max_active_children {
        return Err(AdmissionDeny::Active {
            active: active_children,
            limit: max_active_children,
        });
    }
    Ok(())
}

/// A parent exit cancels a child only when that child is a one-shot delegation.
/// Spawned conversations keep `parent_session_id` for navigation and depth, and
/// leave `delegation_call_id` empty so they never enter the broker's task map.
pub fn parent_exit_cancels_child(delegation_call_id: Option<&str>) -> bool {
    delegation_call_id.is_some_and(|call_id| !call_id.trim().is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompanionWritePolicy {
    /// Self or a descendant in the same workspace.
    AncestorTree,
    /// Any live conversation in the caller's workspace.
    SameWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollaborationError {
    pub code: &'static str,
    pub message: String,
}

impl CollaborationError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "error_code": self.code,
            "message": self.message,
        })
    }
}

impl std::fmt::Display for CollaborationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CollaborationError {}

pub(crate) fn db(error: sqlx::Error) -> CollaborationError {
    CollaborationError::new("conversation_control_failed", error.to_string())
}

fn operation_conflict() -> CollaborationError {
    CollaborationError::new(
        "conversation_control_failed",
        "operation was retried with different content",
    )
}

fn delivery_in_progress() -> CollaborationError {
    CollaborationError::new("conversation_control_failed", "delivery in progress")
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(crate) fn now_stamp() -> String {
    stamp(Utc::now())
}

pub fn bounded_delay_cap_hours(hours: i64) -> i64 {
    hours.clamp(1, HARD_DELAY_HOURS)
}

pub fn default_since_days(configured: Option<i64>) -> i64 {
    configured.unwrap_or(7).clamp(1, 90)
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct SessionHead {
    pub(crate) workspace_id: Uuid,
    pub(crate) agent_id: Option<String>,
    pub(crate) status: String,
    pub(crate) name: Option<String>,
    pub(crate) deleted_at: Option<String>,
}

async fn load_session(
    pool: &SqlitePool,
    id: Uuid,
) -> Result<Option<SessionHead>, CollaborationError> {
    sqlx::query_as::<_, SessionHead>(
        r#"SELECT workspace_id, agent_id, status, name, deleted_at
           FROM sessions WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

fn live_session(head: Option<SessionHead>) -> Result<SessionHead, CollaborationError> {
    match head {
        Some(head) if head.deleted_at.is_none() && head.status != "archived" => Ok(head),
        _ => Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        )),
    }
}

async fn authorize_write(
    pool: &SqlitePool,
    caller_id: Uuid,
    target_id: Uuid,
    policy: CompanionWritePolicy,
) -> Result<SessionHead, CollaborationError> {
    let caller = live_session(load_session(pool, caller_id).await?)?;
    let target = live_session(load_session(pool, target_id).await?)?;
    if caller.workspace_id != target.workspace_id {
        return Err(CollaborationError::new(
            "not_found",
            "conversation was not found",
        ));
    }
    if policy == CompanionWritePolicy::AncestorTree && caller_id != target_id {
        let descendant = ConversationRelationControl::new(pool.clone())
            .is_descendant(caller_id, target_id)
            .await
            .map_err(db)?;
        if !descendant {
            return Err(CollaborationError::new(
                "out_of_scope",
                "conversation is outside the companion scope",
            ));
        }
    }
    Ok(target)
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<sqlx::Error> for CollaborationError {
    fn from(error: sqlx::Error) -> Self {
        db(error)
    }
}
