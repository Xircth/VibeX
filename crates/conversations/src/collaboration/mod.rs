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
mod prompt;
mod roles;
mod routing;
mod scheduled;

#[cfg(test)]
pub(crate) mod test_support;

pub(crate) use collection::purge_space_collection;
pub use collection::{
    AddSpaceCollectionItem, SPACE_COLLECTION_MAX_BYTES, SpaceCollectionItemRecord,
    SpaceCollectionReadRecord, add_to_space_collection, add_to_space_collection_with,
    is_team_space_collection_file, list_space_collection, list_space_collection_with,
    read_space_collection_item, read_space_collection_item_with, space_collection_dir,
    update_space_collection_item_note, update_space_collection_item_note_with,
};
pub use delivery::{
    DEFAULT_HANDOFF_MAX_DEPTH, DEFAULT_HANDOFF_MAX_PER_TURN, DeliveryReceipt, Handoff,
    HandoffEnvelope, HandoffResult, MISSED_CONTEXT_VERBATIM, MessageAudience, MessageReceipt,
    PostToSpace, SendReceipt, SendSessionInput, SpaceMessage, SpacePostResult,
    finalize_space_turn_deliveries, handoff, handoff_max_depth, handoff_max_per_turn, handoff_with,
    list_message_receipts, list_message_receipts_batch, list_space_messages, post_to_space,
    post_to_space_with, prepare_steer, redeliver_deferred, send_session_input,
    send_session_input_with, send_user_text_to_conversation,
};
pub(crate) use delivery::{
    accept_space_replay, decode_replay, deliver_text, digest_text, finish_immediate, finish_tx,
    load_stored_operation, seat_binding, store_operation, user_actor,
};
pub use prompt::prefix_persona_prompt;
pub(crate) use prompt::{
    COLLABORATION_MCP_TOOLS_SUMMARY, build_space_delivery_prompt, format_collaboration_space_rules,
};
pub use roles::{
    BatchDeleteMemberTarget, BatchDeleteResult, CollaborationSpaceChangedEvent,
    ConversationListItem, ConversationPersonaView, CreateSpawnedConversation, CreatedConversation,
    HostCreateSpaceMember, IsolatedWorkspaceProvisioner, ListConversations, MemberRecord,
    MemberSessionConfig, MemberWriteAccess, MemberWritePlan, RoleRecord, SaveRole, SaveTeam,
    SpaceRecord, TeamRecord, WorkspaceConversationOption, active_collaboration_children,
    add_space_member, collaboration_parent_depth, conversation_persona, create_collaboration_space,
    create_role, create_spawned_conversation, create_team, create_workspace_space, delete_role,
    delete_team, ensure_user_member, execution_workspace_id, host_add_space_member,
    host_batch_delete_space_items, host_create_space_member, host_move_space_member,
    list_collaboration_spaces_for_caller, list_conversations, list_roles, list_space_members,
    list_space_members_detailed, list_teams, list_workspace_conversations, list_workspace_spaces,
    load_member_session_config, member_activity_limit, member_space_context_text,
    member_space_context_text_for, member_worktree_workspace_id, parse_unassigned_space_id,
    persona_prompt_text, persona_prompt_text_for_turn, plan_member_write,
    read_session_info_for_delegation, read_session_info_for_session_product,
    record_member_session_workspace, release_member_write, rename_workspace_space,
    resolve_member_target, resolve_session, resolve_thread_session, set_conversation_persona_team,
    set_member_session_config, set_member_write_access, set_space_identity, space_workspace_id,
    try_acquire_member_write, unassigned_space_id, update_role, update_team,
};
pub(crate) use roles::{
    caller_seat, load_space, load_space_or_unassigned, member_nickname, resolve_seat_target,
    seat_conversation,
};
pub use routing::{
    DEFAULT_AGENT_REPLY_CHAIN_MAX, DEFAULT_IDLE_SLEEP_MINUTES, DEFAULT_WAKE_CAP_PER_TURN,
    WAKE_LIMIT_REACHED, WakePreview, agent_reply_chain_max, clean_space_display_text,
    idle_sleep_minutes, is_broadcast_target_name, preview_space_wake, sleep_idle_sessions,
    spawn_idle_session_sweeper, wake_cap_per_turn,
};
pub(crate) use routing::{
    consecutive_agent_messages_since_last_user, env_i64, hold_over_wake_cap, reserve_wake,
    resolve_targets, session_is_asleep, touch_session_activity, wake_turn_in_flight, wake_turn_key,
};
pub use scheduled::{
    ScheduledSpaceMessage, cancel_space_scheduled_message, list_space_scheduled_messages,
    post_to_space_delayed_with, promote_due_delayed_inputs, promote_due_delayed_inputs_with,
    spawn_delayed_input_promoter, update_space_scheduled_message,
};
pub(crate) use scheduled::{schedule_input, scheduled_deadline};

const ROLE_CAP: i64 = 100;
const TEAM_CAP: i64 = 30;
const LIST_DEFAULT_LIMIT: i64 = 50;
const LIST_HARD_CAP: i64 = 100;
const SPACE_LIST_DEFAULT: i64 = 50;
const SPACE_LIST_HARD_CAP: i64 = 200;
const SUBMIT_HOURLY_CAP: i64 = 60;
const DIGEST_REPLAY_MINUTES: i64 = 10;
const HARD_DELAY_HOURS: i64 = 168;

/// Starts the next durable input when the conversation has no in-flight turn.
/// The Application Core service is the production implementation. A missing
/// dispatcher leaves the input queued; the receipt must not say `dispatched`.
#[async_trait]
pub trait IdleTurnDispatcher: Send + Sync {
    async fn start_if_idle(&self, conversation_id: Uuid) -> Result<Option<Uuid>, String>;
}

/// Publisher and idle-start hook for one host process. Tests omit both.
#[derive(Clone, Default)]
pub struct DeliveryContext {
    pub publisher: Option<Arc<dyn crate::ConversationEventPublisher>>,
    pub dispatcher: Option<Arc<dyn IdleTurnDispatcher>>,
    pub space_changed: Option<Arc<dyn Fn(CollaborationSpaceChangedEvent) + Send + Sync>>,
}

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
