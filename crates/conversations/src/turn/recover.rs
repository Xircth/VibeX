use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

use agents::{
    AgentId, AgentPermissionResponse, AgentSessionControlsSnapshot, AgentSessionId,
    CancelAgentPromptInput,
    conversation::{
        ConversationAgentConnectionStatus, ConversationError, ConversationEvent,
        ConversationPermissionResponse,
    },
};
use chrono::{DateTime, Utc};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_side_effects::ConversationPermissionRecord,
    conversation_turn::ConversationTurnRecord,
    session::{Session, SessionStatus},
    session_checkpoint::SessionCheckpoint,
};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{
    ConversationSessionService, is_in_flight_turn_status, parse_agent_connection_id,
    parse_agent_prompt_id, spawn_turn_end_collaboration_cleanup,
};
use crate::{ConversationInputControl, ConversationProjector, ConversationServiceError};

impl ConversationSessionService {
    pub async fn cancel_turn(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), ConversationServiceError> {
        // Share the exact same per-Conversation critical section as start_turn.
        // Without this, a Workflow can expose its child Conversation as running,
        // receive Pause while the first prompt is still being prepared, and then
        // start a follow-up before the first Turn has committed its active pointer.
        // The two Agent bindings race and the old connection's close event can fail
        // the new Turn. Holding this guard makes Pause an acknowledged boundary:
        // when it returns, any concurrent start has either committed and been
        // cancelled, or never existed.
        let (snapshot, turn_id) = {
            let turn_lock = self.turn_lock(conversation_id).await;
            let _turn_guard = turn_lock.lock().await;
            let snapshot = self.runtime_snapshot(conversation_id).await;
            let pool = &self.ctx.deployment.db().pool;
            let persisted_turn_id = ConversationRecord::find_by_id(pool, conversation_id)
                .await?
                .and_then(|conversation| conversation.active_turn_id);
            let turn_id = persisted_turn_id.or(snapshot.active_turn_id);
            let turn_id = match turn_id {
                Some(turn_id) => ConversationTurnRecord::find_by_id(pool, turn_id)
                    .await?
                    .filter(|turn| is_in_flight_turn_status(&turn.status))
                    .map(|turn| turn.id),
                None => None,
            };
            if turn_id.is_none() {
                // Optimistic "generating" with no Turn yet: the durable input is
                // queued. Stop must cancel it, or reload shows "queued" forever.
                let inputs = ConversationInputControl::with_publisher(
                    pool.clone(),
                    self.ctx.event_publisher.clone(),
                );
                if let Err(error) = inputs.cancel_queued(conversation_id).await {
                    tracing::warn!(
                        %conversation_id,
                        %error,
                        "failed to cancel queued conversation inputs with no in-flight turn"
                    );
                }
            }
            (snapshot, turn_id)
        };
        let cancel_target = match (
            snapshot
                .connection_id
                .as_deref()
                .and_then(parse_agent_connection_id),
            snapshot
                .active_prompt_id
                .as_deref()
                .and_then(parse_agent_prompt_id),
        ) {
            (Some(connection_id), Some(prompt_id)) => Some((connection_id, prompt_id)),
            _ => {
                self.ctx
                    .agent_runtime
                    .live_cancel_target(AgentSessionId(conversation_id))
                    .await
            }
        };
        if let Some((connection_id, prompt_id)) = cancel_target {
            if let Err(error) = self
                .ctx
                .agent_runtime
                .cancel_prompt(CancelAgentPromptInput {
                    connection_id,
                    session_id: AgentSessionId(conversation_id),
                    prompt_id,
                })
                .await
            {
                // The runtime may already be dead (auth expiry, crashed process, lost
                // transport). The user's cancel intent must still settle the durable
                // turn locally instead of leaving the composer stuck forever.
                tracing::warn!(
                    %conversation_id,
                    %prompt_id,
                    %error,
                    "Agent prompt cancellation failed; settling turn locally"
                );
            }
        } else {
            // Handshake / session-load retries have no prompt yet. Drop the live
            // connection so Stop aborts `session/new` instead of waiting it out.
            self.drop_live_agent_connection(conversation_id).await;
        }
        let Some(turn_id) = turn_id else {
            return Ok(());
        };
        let settled_here = {
            let turn_lock = self.turn_lock(conversation_id).await;
            let _turn_guard = turn_lock.lock().await;
            let pool = &self.ctx.deployment.db().pool;
            if let Some((_, prompt_id)) = cancel_target {
                let _ =
                    ConversationTurnRecord::set_prompt_id(pool, turn_id, &prompt_id.to_string())
                        .await;
            }
            let still_in_flight = ConversationTurnRecord::find_by_id(pool, turn_id)
                .await?
                .is_some_and(|turn| is_in_flight_turn_status(&turn.status));
            if still_in_flight {
                crate::handoff::settle(pool, turn_id).await?;
                self.append_event(
                    conversation_id,
                    Some(turn_id),
                    "runtime",
                    ConversationEvent::TurnCancelled {
                        reason: reason.clone(),
                    },
                    Some(format!("turn:{turn_id}:cancelled")),
                )
                .await?;
            }
            if ConversationRecord::find_by_id(pool, conversation_id)
                .await?
                .and_then(|conversation| conversation.active_turn_id)
                == Some(turn_id)
            {
                ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
            }
            still_in_flight
        };
        if settled_here {
            spawn_turn_end_collaboration_cleanup(self.ctx.clone(), conversation_id, false, None);
        }
        self.update_runtime_state(conversation_id, |state| {
            if state.active_turn_id.is_none() || state.active_turn_id == Some(turn_id) {
                state.turn_in_flight = false;
                state.active_turn_id = None;
                state.active_prompt_id = None;
                state.recovery_status = reason;
            }
        })
        .await;
        self.spawn_dispatch_queued_after_bind(conversation_id);
        Ok(())
    }

    /// Reset-to-here: truncate the conversation back to *before* the user turn at
    /// `ordinal` — delete that turn and everything after it (events, turns,
    /// checkpoints) and rebuild the projection — so the caller can re-send that
    /// message in its original position. The optional workspace file rollback is the
    /// caller's separate concern (it must run before this, while the ordinal's
    /// checkpoint still exists).
    pub async fn truncate_to_turn(
        &self,
        conversation_id: Uuid,
        user_ordinal: i64,
    ) -> Result<(), ConversationServiceError> {
        // Serialize against start_turn / cancel_turn on the same conversation.
        let turn_lock = {
            let mut locks = self.ctx.turn_locks.lock().await;
            Arc::clone(
                locks
                    .entry(conversation_id)
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _turn_guard = turn_lock.lock().await;

        let pool = &self.ctx.deployment.db().pool;
        // Reject truncation while a Turn is in flight; the pending Turn's
        // history and binding are still being established.
        let conversation = ConversationRecord::find_by_id(pool, conversation_id)
            .await?
            .ok_or_else(|| ConversationServiceError::NotFound("Conversation not found".into()))?;
        if let Some(active_turn_id) = conversation.active_turn_id
            && let Some(active_turn) =
                ConversationTurnRecord::find_by_id(pool, active_turn_id).await?
            && is_in_flight_turn_status(&active_turn.status)
        {
            return Err(ConversationServiceError::Conflict(
                "Cannot truncate while a Turn is in flight".into(),
            ));
        }
        // Resolve and replace the visible history while the source native identity
        // is still available for legacy transcript lookup.
        crate::jsonl_history::truncate_transcript_to_user_ordinal(
            pool,
            conversation_id,
            user_ordinal.max(0) as usize,
        )
        .await?;
        // Detach before truncating the control log. The old ACP session still
        // holds the removed suffix: if detach fails after that cut, the log is
        // short while the binding
        // still points at the full context, and the next send replays the deleted
        // messages through `session/load`. The `AgentBindingRecovered` event is
        // appended after the cut, since truncation drops every later sequence.
        self.detach_agent_session(conversation_id).await?;

        // `user_ordinal` is the 0-based user-message index (same basis as the checkpoint
        // ordinal / `reset_agent_session_to_checkpoint`). `conversation_turns.ordinal`
        // is 1-based (created via `MAX(ordinal)+1`), so the turn to reset *from* is
        // `user_ordinal + 1`; checkpoints share the 0-based basis.
        let turn_ordinal = user_ordinal + 1;
        ConversationProjector::truncate_to_turn_ordinal(pool, conversation_id, turn_ordinal)
            .await?;
        SessionCheckpoint::delete_from_ordinal(pool, conversation_id, user_ordinal).await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        // The live projector cursor may now point beyond the truncated event log.
        // Invalidate it at the mutation boundary so the next committed event seeds a
        // fresh projector from its actual predecessor sequence.
        self.ctx
            .row_projectors
            .lock()
            .await
            .remove(&conversation_id);

        self.update_runtime_state(conversation_id, |state| {
            state.active_turn_id = None;
            state.active_prompt_id = None;
            state.turn_in_flight = false;
            state.pending_user_message = None;
        })
        .await;
        self.record_agent_binding_recovered(
            conversation_id,
            agents::SessionRecoveryStrategy::Rebound,
            None,
        )
        .await?;

        Ok(())
    }

    pub async fn interrupt_orphaned_turn(
        &self,
        conversation_id: Uuid,
    ) -> Result<bool, ConversationServiceError> {
        self.reclaim_dead_in_flight_turn(conversation_id).await
    }

    /// Settle an in-flight Turn whose Agent process is gone so follow-up can
    /// dispatch. Handshake still has a live process and no ACP mapping yet —
    /// that is not a zombie and must not be failed.
    pub(super) async fn reclaim_dead_in_flight_turn(
        &self,
        conversation_id: Uuid,
    ) -> Result<bool, ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let Some(conversation) = ConversationRecord::find_by_id(pool, conversation_id).await?
        else {
            return Ok(false);
        };
        let Some(turn_id) = conversation.active_turn_id else {
            return Ok(false);
        };
        let Some(turn) = ConversationTurnRecord::find_by_id(pool, turn_id).await? else {
            return Ok(false);
        };
        if turn.status == "pending" && crate::continuation::preparing(conversation_id) {
            // A reserved Turn may still be preparing history, hooks or session/new.
            return Ok(false);
        }
        if !is_zombie_in_flight_turn(
            is_in_flight_turn_status(&turn.status),
            self.ctx
                .agent_runtime
                .has_bound_acp_session(AgentSessionId(conversation_id))
                .await,
            self.ctx
                .agent_runtime
                .has_live_agent_process(AgentSessionId(conversation_id))
                .await,
        ) {
            return Ok(false);
        }

        if turn_predates_this_host(turn.created_at) {
            self.interrupt_in_flight_turn(turn.conversation_id, turn.id)
                .await?;
            return Ok(true);
        }

        self.fail_dead_in_flight_turn(turn.conversation_id, turn.id)
            .await?;
        Ok(true)
    }

    async fn fail_dead_in_flight_turn(
        &self,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        crate::jsonl_history::preserve_unprompted_input(pool, conversation_id, turn_id).await?;
        crate::handoff::settle(pool, turn_id).await?;
        let permissions = ConversationPermissionRecord::list_for_turn(pool, turn_id).await?;
        for permission in permissions.into_iter().filter(|p| p.status == "pending") {
            self.append_event(
                conversation_id,
                Some(turn_id),
                "runtime",
                ConversationEvent::PermissionResponded {
                    permission_id: permission.permission_id.clone(),
                    response: ConversationPermissionResponse {
                        response: AgentPermissionResponse::Cancelled,
                        auto: true,
                    },
                },
                Some(format!(
                    "recovery:permission-cancelled:{}",
                    permission.permission_id
                )),
            )
            .await?;
        }
        let agent_id = Session::find_by_id(pool, conversation_id)
            .await?
            .and_then(|session| session.agent_id);
        self.append_event(
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError::new(
                    "Agent connection closed before the turn completed.",
                    Some("connection_closed".into()),
                    None,
                )
                .with_cached_plan_usage(agent_id.as_ref()),
            },
            Some(format!("turn:{turn_id}:connection_closed")),
        )
        .await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        spawn_turn_end_collaboration_cleanup(self.ctx.clone(), conversation_id, false, None);
        self.drop_live_agent_connection(conversation_id).await;
        self.update_runtime_state(conversation_id, |state| {
            state.turn_in_flight = false;
            state.active_turn_id = None;
            state.active_prompt_id = None;
            state.recovery_status = Some("connection_closed".to_string());
        })
        .await;
        Ok(())
    }

    async fn interrupt_in_flight_turn(
        &self,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        crate::jsonl_history::preserve_unprompted_input(pool, conversation_id, turn_id).await?;
        crate::handoff::settle(pool, turn_id).await?;
        let permissions = ConversationPermissionRecord::list_for_turn(pool, turn_id).await?;
        for permission in permissions.into_iter().filter(|p| p.status == "pending") {
            self.append_event(
                conversation_id,
                Some(turn_id),
                "runtime",
                ConversationEvent::PermissionResponded {
                    permission_id: permission.permission_id.clone(),
                    response: ConversationPermissionResponse {
                        response: AgentPermissionResponse::Cancelled,
                        auto: true,
                    },
                },
                Some(format!(
                    "recovery:permission-cancelled:{}",
                    permission.permission_id
                )),
            )
            .await?;
        }
        self.append_event(
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnInterrupted {
                reason: Some("会话在生成过程中因应用重启而中断".to_string()),
            },
            Some(format!("recovery:turn-interrupted:{turn_id}")),
        )
        .await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        spawn_turn_end_collaboration_cleanup(self.ctx.clone(), conversation_id, false, None);
        self.forget_conversation_runtime(conversation_id).await;
        Ok(())
    }

    pub async fn close_conversation(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), ConversationServiceError> {
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        let pool = &self.ctx.deployment.db().pool;
        if let Some(conversation) = ConversationRecord::find_by_id(pool, conversation_id).await?
            && let Some(turn_id) = conversation.active_turn_id
            && let Some(turn) = ConversationTurnRecord::find_by_id(pool, turn_id).await?
            && is_in_flight_turn_status(&turn.status)
        {
            self.append_event(
                conversation_id,
                Some(turn.id),
                "runtime",
                ConversationEvent::TurnCancelled {
                    reason: reason.clone(),
                },
                Some(format!("turn:{}:cancelled", turn.id)),
            )
            .await?;
            ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        }
        self.append_event(
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Closed,
                message: None,
                bound: false,
            },
            Some(format!("conversation:{conversation_id}:closed")),
        )
        .await?;
        ConversationRecord::update_status(
            &self.ctx.deployment.db().pool,
            conversation_id,
            SessionStatus::Done,
        )
        .await?;
        self.update_runtime_state(conversation_id, |state| {
            state.turn_in_flight = false;
            state.connection_status = Some("closed".to_string());
            state.recovery_status = reason;
        })
        .await;
        // Release the ACP child before forgetting maps. Close previously only
        // dropped in-memory coordination, so the agent process kept running
        // until process exit (the UI also never called this path).
        self.drop_live_agent_connection(conversation_id).await;
        // Drop this conversation's in-memory coordination state now that it is closed.
        // Without this, both maps leaked one entry per conversation ever opened — the
        // whole codebase had no `remove` on either (架构报告 recovery). The closed
        // status is authoritative in the event log + SessionStatus, not these maps.
        self.forget_conversation_runtime(conversation_id).await;
        Ok(())
    }

    /// Reconcile turns orphaned by the previous process lifecycle (startup recovery,
    /// ADR-0001). A turn left in-flight (pending/queued/running/blocked) when the host
    /// died can never resume its generation, so drive it to the **Interrupted** terminal
    /// state *through the event log* (never a bare status UPDATE) and void its orphaned
    /// pending permission requests. Session *context* is reloaded lazily on the next
    /// open/send via ACP `session/load` — we deliberately do **not** eagerly reconnect
    /// agents here. Returns the number of turns recovered.
    pub async fn recover_interrupted_turns(&self) -> Result<usize, ConversationServiceError> {
        note_host_lifetime();
        let pool = &self.ctx.deployment.db().pool;
        crate::handoff::recover(pool).await?;
        let inputs = ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let released_claims = inputs.recover_orphaned_unsubmitted_claims().await?;
        if released_claims > 0 {
            tracing::info!(
                released_claims,
                "released orphaned unsubmitted input claims"
            );
        }
        if let Err(error) = self.recover_orphaned_connecting_conversations().await {
            tracing::warn!(
                %error,
                "startup recovery: failed to reconcile orphaned connecting conversations"
            );
        }
        let in_flight = ConversationTurnRecord::list_in_flight(pool).await?;
        if in_flight.is_empty() {
            return Ok(0);
        }

        let count = in_flight.len();
        tracing::info!(
            count,
            "startup recovery: marking orphaned in-flight turns as interrupted"
        );

        let mut recovered = 0usize;
        let mut failed = 0usize;
        for turn in &in_flight {
            match self
                .interrupt_in_flight_turn(turn.conversation_id, turn.id)
                .await
            {
                Ok(()) => recovered += 1,
                Err(error) => {
                    failed += 1;
                    tracing::error!(
                        conversation_id = %turn.conversation_id,
                        turn_id = %turn.id,
                        %error,
                        "startup crash-recovery failed for one turn"
                    );
                }
            }
        }
        if failed > 0 {
            tracing::error!(
                recovered,
                failed,
                "startup crash-recovery left orphaned in-flight turns; they will be interrupted when next opened"
            );
        }

        Ok(recovered)
    }

    async fn recover_orphaned_connecting_conversations(
        &self,
    ) -> Result<usize, ConversationServiceError> {
        reconcile_orphaned_connecting_conversations_in_pool(
            &self.ctx.deployment.db().pool,
            Some(self.ctx.event_publisher.as_ref()),
        )
        .await
    }
    /// Remove a conversation's entries from the in-memory coordination maps (turn
    /// locks, runtime state, and the cached incremental row projector).
    ///
    /// The turn lock is only pruned when nobody still holds a clone of it. Removing
    /// a referenced lock lets a concurrent `start_turn` / `dispatch_next_queued_input`
    /// `or_insert` a *second* mutex for the same conversation, after which both tasks
    /// believe they hold exclusive access — the very double in-flight Turn the lock
    /// exists to prevent (ADR-0061 §4.2, CONTEXT.md "In-flight turn").
    pub(super) async fn drop_live_agent_connection(&self, conversation_id: Uuid) {
        let from_state = self
            .runtime_snapshot(conversation_id)
            .await
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id);
        let from_runtime = self
            .ctx
            .agent_runtime
            .live_connection_id(AgentSessionId(conversation_id))
            .await;
        if let Some(connection_id) = from_state.or(from_runtime) {
            agents::transcript_target::release(connection_id);
        }
        if let Some(connection_id) = from_state.or(from_runtime)
            && let Err(error) = self
                .ctx
                .agent_runtime
                .discard_connection(connection_id)
                .await
        {
            tracing::warn!(
                %conversation_id,
                %error,
                "failed to drop Agent connection while reloading or cancelling"
            );
        }
        self.update_runtime_state(conversation_id, |state| {
            state.connection_id = None;
            state.active_prompt_id = None;
            state.connection_status = Some("closed".to_string());
        })
        .await;
    }

    pub(super) async fn forget_conversation_runtime(&self, conversation_id: Uuid) {
        self.prune_turn_lock(conversation_id).await;
        self.ctx
            .runtime_states
            .lock()
            .await
            .remove(&conversation_id);
        self.ctx
            .row_projectors
            .lock()
            .await
            .remove(&conversation_id);
    }

    async fn prune_turn_lock(&self, conversation_id: Uuid) {
        prune_unreferenced_turn_lock(&mut *self.ctx.turn_locks.lock().await, conversation_id);
    }

    pub(super) async fn turn_is_still_in_flight(
        &self,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<bool, ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let Some(turn) = ConversationTurnRecord::find_by_id(pool, turn_id).await? else {
            return Ok(false);
        };
        if !is_in_flight_turn_status(&turn.status) {
            return Ok(false);
        }
        let active = ConversationRecord::find_by_id(pool, conversation_id)
            .await?
            .and_then(|conversation| conversation.active_turn_id);
        Ok(active == Some(turn_id))
    }

    pub async fn rebind_session(
        &self,
        conversation_id: Uuid,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        let preparation = crate::continuation::preparation_lock(conversation_id);
        let _preparation_guard = preparation.lock().await;
        let controls = {
            let turn_lock = self.turn_lock(conversation_id).await;
            let _turn_guard = turn_lock.lock().await;
            self.interrupt_orphaned_turn(conversation_id).await?;
            if let Some(conversation) =
                ConversationRecord::find_by_id(&self.ctx.deployment.db().pool, conversation_id)
                    .await?
            {
                super::ensure_conversation_has_no_in_flight_turn(
                    &self.ctx.deployment.db().pool,
                    &conversation,
                )
                .await?;
            }
            self.detach_agent_session(conversation_id).await?;
            self.record_agent_binding_recovered(
                conversation_id,
                agents::SessionRecoveryStrategy::Rebound,
                None,
            )
            .await?;
            self.ensure_session_controls_locked(conversation_id, None)
                .await?
        };
        self.spawn_dispatch_queued_after_bind(conversation_id);
        Ok(controls)
    }

    /// Release execution while retaining the native generation for a future return.
    pub(super) async fn release_agent_session_for_switch(
        &self,
        conversation_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        // The source remains authoritative if its checkpoint cannot be persisted.
        if let Err(error) =
            crate::jsonl_history::preserve_transcript_before_detach(pool, conversation_id).await
        {
            self.drop_live_agent_connection(conversation_id).await;
            self.forget_conversation_runtime(conversation_id).await;
            return Err(error.into());
        }
        self.drop_live_agent_connection(conversation_id).await;
        self.forget_conversation_runtime(conversation_id).await;
        let _ = sqlx::query("UPDATE conversation_agent_bindings SET connection_id = NULL WHERE id = (SELECT active_agent_binding_id FROM sessions WHERE id = ?)")
            .bind(conversation_id).execute(pool).await?;
        Ok(())
    }

    /// Rebind abandons this native generation; keeping its ID is evidence only.
    pub(super) async fn detach_agent_session(
        &self,
        conversation_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        self.release_agent_session_for_switch(conversation_id)
            .await?;
        ConversationAgentBindingRecord::invalidate_active(
            &self.ctx.deployment.db().pool,
            conversation_id,
            "rebind",
        )
        .await?;
        Ok(())
    }

    pub(super) async fn record_agent_binding_recovered(
        &self,
        conversation_id: Uuid,
        strategy: agents::SessionRecoveryStrategy,
        continues_from: Option<String>,
    ) -> Result<(), ConversationServiceError> {
        self.append_event(
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecovered {
                strategy,
                continues_from,
            },
            None,
        )
        .await?;
        Ok(())
    }
}

/// Handshake has a live process and no ACP mapping yet. A leftover running
/// Turn with neither mapping nor process can never complete — follow-up must
/// settle it instead of queueing behind a ghost.
pub(super) fn is_zombie_in_flight_turn(
    turn_is_in_flight: bool,
    has_bound_acp_session: bool,
    has_live_agent_process: bool,
) -> bool {
    turn_is_in_flight && !has_bound_acp_session && !has_live_agent_process
}

pub(super) fn host_started_at() -> DateTime<Utc> {
    static STARTED: OnceLock<DateTime<Utc>> = OnceLock::new();
    *STARTED.get_or_init(Utc::now)
}

fn note_host_lifetime() {
    let _ = host_started_at();
}

pub(super) fn turn_predates_this_host(created_at: DateTime<Utc>) -> bool {
    created_at < host_started_at()
}

/// Drop a conversation's turn mutex only when the map holds its last reference.
///
/// The map itself owns one strong reference; anything above that is a live guard
/// holder. Evicting a referenced mutex lets the next `or_insert` mint a second one
/// for the same conversation, so two tasks can hold "the" turn lock at once.
pub(super) fn prune_unreferenced_turn_lock(
    locks: &mut HashMap<Uuid, Arc<Mutex<()>>>,
    conversation_id: Uuid,
) {
    if locks
        .get(&conversation_id)
        .is_some_and(|lock| Arc::strong_count(lock) == 1)
    {
        locks.remove(&conversation_id);
    }
}

pub(super) fn resume_external_session_id(
    known_id: Option<String>,
    has_live_bound_acp_session: bool,
) -> Option<String> {
    known_id
        .filter(|id| !is_placeholder_acp_session_id(id))
        .filter(|_| !has_live_bound_acp_session)
}

fn is_placeholder_acp_session_id(id: &str) -> bool {
    agents::is_placeholder_acp_session_id(id)
}

pub(super) fn restorable_agent_binding<'a>(
    bindings: &'a [ConversationAgentBindingRecord],
    agent_id: &AgentId,
) -> Option<&'a ConversationAgentBindingRecord> {
    // An invalidated generation is a recovery barrier even when its native ID
    // is retained. Never fall back to an older generation after rebind.
    let latest_for_agent = bindings
        .iter()
        .rev()
        .find(|binding| binding.agent_id == *agent_id)?;
    if !latest_for_agent.resume_allowed {
        return None;
    }
    latest_for_agent
        .acp_session_id
        .as_deref()
        .filter(|id| !is_placeholder_acp_session_id(id))?;
    Some(latest_for_agent)
}

pub(super) fn known_acp_session_id(
    latest_binding: Option<&ConversationAgentBindingRecord>,
    persisted_session: Option<&Session>,
    agent_id: &AgentId,
) -> Option<String> {
    if latest_binding
        .is_some_and(|binding| binding.agent_id == *agent_id && !binding.resume_allowed)
    {
        return None;
    }
    latest_binding
        .filter(|binding| binding.agent_id == *agent_id && binding.resume_allowed)
        .and_then(|binding| binding.acp_session_id.clone())
        .filter(|id| !is_placeholder_acp_session_id(id))
        .or_else(|| {
            persisted_session
                .filter(|session| {
                    session
                        .agent_id
                        .as_ref()
                        .is_some_and(|persisted_id| persisted_id == agent_id)
                })
                .and_then(|session| session.external_session_id.clone())
                .filter(|id| !is_placeholder_acp_session_id(id))
        })
}

pub(super) async fn reconcile_orphaned_connecting_conversations_in_pool(
    pool: &sqlx::SqlitePool,
    publisher: Option<&dyn super::ConversationEventPublisher>,
) -> Result<usize, ConversationServiceError> {
    let mut candidates: Vec<Uuid> = sqlx::query_scalar(
        r#"SELECT e.conversation_id
           FROM conversation_events e
           INNER JOIN (
               SELECT conversation_id, MAX(sequence) AS max_seq
               FROM conversation_events
               WHERE event_kind IN (
                   'agent_connection_status_changed',
                   'agent_binding_ready',
                   'agent_binding_recovered',
                   'agent_binding_recovery_failed',
                   'agent_binding_load_failed'
               )
               GROUP BY conversation_id
           ) latest
           ON e.conversation_id = latest.conversation_id AND e.sequence = latest.max_seq
           WHERE e.event_kind IN ('agent_connection_status_changed', 'agent_binding_ready', 'agent_binding_recovered')"#,
    )
    .fetch_all(pool)
    .await?;

    let materialized_candidates: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT conversation_id FROM conversation_timeline_rows WHERE row_id IN ('notice:agent-connection-recovering', 'status:agent-connection')",
    )
    .fetch_all(pool)
    .await?;
    for cid in materialized_candidates {
        if !candidates.contains(&cid) {
            candidates.push(cid);
        }
    }

    let mut closed_count = 0usize;
    for conversation_id in candidates {
        let fold = ConversationProjector::fold(pool, conversation_id).await?;
        let has_recovering_notice = fold
            .side_rows
            .iter()
            .any(|row| row.row_id == "notice:agent-connection-recovering");
        let had_live_connection = fold.side_rows.iter().any(|row| match &row.row {
            agents::conversation::ConversationTimelineRow::SessionNotice { notice } => {
                notice.connection_status.as_ref().is_some_and(|connection| {
                    !matches!(
                        connection.status,
                        ConversationAgentConnectionStatus::Closed
                            | ConversationAgentConnectionStatus::Error
                    )
                })
            }
            _ => false,
        });
        if has_recovering_notice || had_live_connection {
            let event = ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Closed,
                message: None,
                bound: false,
            };
            let normalized_json = serde_json::to_string(&event)
                .map_err(|e| ConversationServiceError::Internal(e.to_string()))?;
            let idempotency_key = format!("recovery:connection-closed:{}", fold.last_sequence);
            let record = crate::ConversationEventAppender::append(
                pool,
                db::models::conversation_event::AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "runtime",
                    event_kind: "agent_connection_status_changed",
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(&idempotency_key),
                },
            )
            .await?;
            if let Some(publisher) = publisher {
                publisher.publish(&record).await;
            }
            closed_count += 1;
        } else {
            let _ = ConversationProjector::persist_fold_to_pool(pool, conversation_id, &fold).await;
        }
    }
    Ok(closed_count)
}
