use agents::{
    AgentContentBlock, AgentSessionId, EnsureAgentSessionInput, ResumeAgentSessionInput,
    conversation::ContinuationPolicy,
};
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use uuid::Uuid;

use super::{ConversationSessionService, ConversationStartTurnInput, PreparedTurnPrompt};
use crate::{ConversationServiceError, continuation::select_history};

/// Continuation key: agent identity fingerprint for resume matching.
/// Same agent + same normalized working directory = same key.
pub fn continuation_key(agent_id: &str, working_dir: &str) -> String {
    format!("{agent_id}|{working_dir}")
}

impl ConversationSessionService {
    pub(super) async fn prepare_turn_continuation(
        &self,
        input: &ConversationStartTurnInput,
        turn_id: Uuid,
        prepared: &mut PreparedTurnPrompt,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let session = Session::find_by_id(pool, input.conversation_id)
            .await?
            .ok_or_else(|| ConversationServiceError::NotFound("Conversation not found".into()))?;
        let source =
            ConversationAgentBindingRecord::active_for_conversation(pool, input.conversation_id)
                .await?;
        let switching = session
            .agent_id
            .as_ref()
            .is_some_and(|agent| *agent != input.agent_id);
        let fresh = input.continuation_policy == Some(ContinuationPolicy::Fresh);

        // Stage C: look for a resumable binding with matching continuation key.
        let target_key = continuation_key(input.agent_id.as_str(), &prepared.working_dir);
        let resume_candidate = if switching && !fresh {
            ConversationAgentBindingRecord::resume_head_for_key(
                pool,
                input.conversation_id,
                &target_key,
            )
            .await?
            .filter(|b| {
                b.resume_allowed && b.acp_session_id.as_deref().is_some_and(|id| !id.is_empty())
            })
        } else {
            None
        };

        let cold = (switching && resume_candidate.is_none()) || fresh;

        if cold {
            self.validate_continuation_owner(input.conversation_id)
                .await?;
            if let Ok(controls) = self
                .ctx
                .agent_runtime
                .session_controls_snapshot(AgentSessionId(input.conversation_id))
                .await
                && controls
                    .async_tasks
                    .iter()
                    .any(|task| !agents::async_tasks::async_task_state_is_terminal(&task.state))
            {
                return Err(ConversationServiceError::SessionUnavailable {
                    code: "continuation_not_allowed",
                    message: "Stop background Agent tasks before changing context".into(),
                });
            }
            self.release_agent_session_for_switch(input.conversation_id)
                .await?;
            if !self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?
            {
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during history preparation".into(),
                ));
            }
            let selection = if input.continuation_policy == Some(ContinuationPolicy::Portable) {
                let turns = crate::jsonl_history::load_all_turns(pool, input.conversation_id)
                    .await?
                    .ok_or_else(|| {
                        ConversationServiceError::Internal(
                            "Conversation history is unavailable".into(),
                        )
                    })?;
                let current_bytes = serde_json::to_vec(&prepared.agent_blocks)
                    .map_err(|e| ConversationServiceError::Internal(e.to_string()))?
                    .len();
                let budget = (64 * 1024usize).min((128 * 1024usize).saturating_sub(current_bytes));
                let selection = select_history(&turns, budget);
                if selection.prompt.len() > budget {
                    return Err(ConversationServiceError::SessionUnavailable {
                        code: "handoff_budget_exceeded",
                        message: "Current input leaves no space for history context".into(),
                    });
                }
                Some(selection)
            } else {
                None
            };
            crate::handoff::plan(
                pool,
                input,
                turn_id,
                source.as_ref().map(|b| b.id),
                selection.as_ref(),
            )
            .await?;

            let settings = self.ctx.host.launch_settings(pool, &input.agent_id).await?;
            let mut preferences = self
                .resolved_session_control_preferences(pool, &input.agent_id, None)
                .await;
            preferences.mode = input.mode_override.clone().or(preferences.mode);
            for value in &input.config_overrides {
                preferences.config.retain(|old| old.key != value.key);
                preferences.config.push(value.clone());
            }
            let candidate = match self
                .ctx
                .agent_runtime
                .prepare_session(EnsureAgentSessionInput {
                    agent_id: input.agent_id.clone(),
                    launch_lock: settings.launch_lock,
                    workspace_id: input.workspace_id,
                    working_dir: prepared.working_dir.clone().into(),
                    additional_directories: prepared.additional_directories.clone(),
                    session_id: AgentSessionId(input.conversation_id),
                    acp_session_id: String::new(),
                    auto_approve_mode: settings.auto_approve_mode,
                    env: settings.env,
                    preferences,
                })
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    return Err(ConversationServiceError::Internal(e.to_string()));
                }
            };
            let lock = self.turn_lock(input.conversation_id).await;
            let _guard = lock.lock().await;
            let in_flight = self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?;
            if !in_flight {
                self.drop_live_agent_connection(input.conversation_id).await;
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during Agent startup".into(),
                ));
            }
            self.commit_native_binding(
                input.conversation_id,
                &input.agent_id,
                &prepared.working_dir,
                &candidate.session.acp_session_id,
                candidate.session.connection_id,
            )
            .await?;
            self.ctx
                .agent_runtime
                .commit_prepared_session(AgentSessionId(input.conversation_id))
                .await;
            if let Some(selection) = selection {
                prepared.agent_blocks.insert(
                    0,
                    AgentContentBlock::Text {
                        text: selection.prompt,
                    },
                );
            }
        } else if let Some(resume) = resume_candidate {
            // Stage C resume: restore the target agent's native session.
            self.validate_continuation_owner(input.conversation_id)
                .await?;
            if let Ok(controls) = self
                .ctx
                .agent_runtime
                .session_controls_snapshot(AgentSessionId(input.conversation_id))
                .await
                && controls
                    .async_tasks
                    .iter()
                    .any(|task| !agents::async_tasks::async_task_state_is_terminal(&task.state))
            {
                return Err(ConversationServiceError::SessionUnavailable {
                    code: "continuation_not_allowed",
                    message: "Stop background Agent tasks before changing context".into(),
                });
            }
            self.release_agent_session_for_switch(input.conversation_id)
                .await?;
            if !self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?
            {
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during history preparation".into(),
                ));
            }

            // Delta: only carry items the resumed binding doesn't already know.
            // "Known" is the union of the binding's own transcript segments and
            // every item a delivered handoff already gave it. Re-delivering a
            // previously delivered gap would duplicate the same history.
            let selection = if input.continuation_policy == Some(ContinuationPolicy::Portable) {
                let known_prefixes = self.known_segment_prefixes(pool, resume.id).await?;
                let delivered_ids = crate::handoff::delivered_item_ids(pool, resume.id).await?;
                let all_turns = crate::jsonl_history::load_all_turns(pool, input.conversation_id)
                    .await?
                    .ok_or_else(|| {
                        ConversationServiceError::Internal(
                            "Conversation history is unavailable".into(),
                        )
                    })?;
                let unknown_turns: Vec<_> = all_turns
                    .iter()
                    .filter(|t| {
                        !known_prefixes.iter().any(|prefix| t.id.starts_with(prefix))
                            && !delivered_ids.contains(&t.id)
                    })
                    .cloned()
                    .collect();
                if unknown_turns.is_empty() {
                    None
                } else {
                    let current_bytes = serde_json::to_vec(&prepared.agent_blocks)
                        .map_err(|e| ConversationServiceError::Internal(e.to_string()))?
                        .len();
                    let budget =
                        (64 * 1024usize).min((128 * 1024usize).saturating_sub(current_bytes));
                    let selection = select_history(&unknown_turns, budget);
                    if selection.prompt.len() > budget {
                        return Err(ConversationServiceError::SessionUnavailable {
                            code: "handoff_budget_exceeded",
                            message: "Current input leaves no space for history context".into(),
                        });
                    }
                    Some(selection)
                }
            } else {
                None
            };
            crate::handoff::plan(
                pool,
                input,
                turn_id,
                source.as_ref().map(|b| b.id),
                selection.as_ref(),
            )
            .await?;

            let settings = self.ctx.host.launch_settings(pool, &input.agent_id).await?;
            let mut preferences = self
                .resolved_session_control_preferences(pool, &input.agent_id, None)
                .await;
            preferences.mode = input.mode_override.clone().or(preferences.mode);
            for value in &input.config_overrides {
                preferences.config.retain(|old| old.key != value.key);
                preferences.config.push(value.clone());
            }
            let acp_session_id = resume.acp_session_id.clone().unwrap_or_default();
            let (resumed_session, _recovery) = self
                .ctx
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: input.agent_id.clone(),
                    launch_lock: settings.launch_lock,
                    workspace_id: input.workspace_id,
                    working_dir: prepared.working_dir.clone().into(),
                    additional_directories: prepared.additional_directories.clone(),
                    session_id: AgentSessionId(input.conversation_id),
                    external_session_id: acp_session_id,
                    auto_approve_mode: settings.auto_approve_mode,
                    env: settings.env,
                    preferences,
                })
                .await
                .map_err(|e| ConversationServiceError::Internal(e.to_string()))?;
            let lock = self.turn_lock(input.conversation_id).await;
            let _guard = lock.lock().await;
            if !self
                .turn_is_still_in_flight(input.conversation_id, turn_id)
                .await?
            {
                self.drop_live_agent_connection(input.conversation_id).await;
                return Err(ConversationServiceError::Conflict(
                    "Turn was cancelled during Agent startup".into(),
                ));
            }
            // Re-activate the resumed binding and set up its transcript target.
            ConversationAgentBindingRecord::activate(pool, input.conversation_id, resume.id)
                .await?;
            let resumed_binding = ConversationAgentBindingRecord::active_for_conversation(
                pool,
                input.conversation_id,
            )
            .await?
            .ok_or_else(|| {
                ConversationServiceError::Internal("Resumed binding disappeared".into())
            })?;
            crate::jsonl_history::prepare_binding_transcript(
                pool,
                input.conversation_id,
                &resumed_binding,
                resumed_session.connection_id,
            )
            .await?;
            self.ctx
                .agent_runtime
                .commit_prepared_session(AgentSessionId(input.conversation_id))
                .await;
            if let Some(selection) = selection {
                prepared.agent_blocks.insert(
                    0,
                    AgentContentBlock::Text {
                        text: selection.prompt,
                    },
                );
            }
        } else {
            self.ensure_session_controls_locked(
                input.conversation_id,
                Some(prepared.working_dir.clone().into()),
            )
            .await?;
        }
        let binding =
            ConversationAgentBindingRecord::active_for_conversation(pool, input.conversation_id)
                .await?
                .ok_or_else(|| {
                    ConversationServiceError::Internal("Prepared Agent has no binding".into())
                })?;
        sqlx::query("UPDATE conversation_turns SET agent_binding_id = ? WHERE id = ? AND status = 'pending'")
            .bind(binding.id).bind(turn_id).execute(pool).await?;
        crate::handoff::set_target(pool, turn_id, binding.id).await?;
        Ok(())
    }

    /// Get the segment-ID prefixes for turns the binding already knows about.
    async fn known_segment_prefixes(
        &self,
        pool: &sqlx::SqlitePool,
        binding_id: Uuid,
    ) -> Result<Vec<String>, sqlx::Error> {
        let segment_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM conversation_transcript_segments WHERE binding_id = ? ORDER BY ordinal",
        )
        .bind(binding_id)
        .fetch_all(pool)
        .await?;
        Ok(segment_ids
            .iter()
            .map(|id| format!("segment:{}:", id.simple()))
            .collect())
    }

    async fn validate_continuation_owner(
        &self,
        conversation_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let owned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM conversation_relations WHERE child_conversation_id = ? AND kind IN ('workflow_step', 'delegation')) OR EXISTS(SELECT 1 FROM collaboration_thread_members WHERE conversation_id = ?)")
            .bind(conversation_id).bind(conversation_id.to_string()).fetch_one(pool).await?;
        if owned {
            return Err(ConversationServiceError::SessionUnavailable {
                code: "continuation_not_allowed",
                message: "This conversation's Agent is controlled by its workflow or bot".into(),
            });
        }
        Ok(())
    }
}
