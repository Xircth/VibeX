use std::collections::HashSet;

use agents::{
    AgentContentBlock, AgentSessionId, EnsureAgentSessionInput, ResumeAgentSessionInput,
    conversation::ContinuationPolicy,
};
use db::models::{conversation::ConversationAgentBindingRecord, session::Session};
use uuid::Uuid;

use super::{ConversationSessionService, ConversationStartTurnInput, PreparedTurnPrompt};
use crate::{
    ConversationServiceError,
    handoff::{DeterministicHandoffService, HandoffError},
};

fn map_handoff_error_to_service(error: HandoffError) -> ConversationServiceError {
    match error {
        HandoffError::ConversationNotFound(id) => {
            ConversationServiceError::NotFound(format!("Conversation {id} not found"))
        }
        HandoffError::InvalidTokenBudget | HandoffError::InvalidTargetEngine(_) => {
            ConversationServiceError::BadRequest(error.to_string())
        }
        HandoffError::RestrictedOwner => ConversationServiceError::SessionUnavailable {
            code: "continuation_not_allowed",
            message: error.to_string(),
        },
        HandoffError::ActiveTurnInProgress | HandoffError::WorkspaceRootMissing(_) => {
            ConversationServiceError::Conflict(error.to_string())
        }
        HandoffError::Database(err) => ConversationServiceError::Internal(err.to_string()),
    }
}

/// Continuation key: agent + optional provider instance + working directory fingerprint for resume matching.
pub fn continuation_key(
    agent_id: &str,
    working_dir: &str,
    provider_instance_id: Option<&str>,
) -> String {
    match provider_instance_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(instance_id) => format!("{agent_id}|{instance_id}|{working_dir}"),
        None => format!("{agent_id}|{working_dir}"),
    }
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
        let requested_instance = input
            .provider_instance_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let target_key = continuation_key(
            input.agent_id.as_str(),
            &prepared.working_dir,
            requested_instance,
        );
        let switching = if let Some(binding) = source.as_ref() {
            binding.agent_id != input.agent_id
                || (requested_instance.is_some()
                    && binding.continuation_key.as_deref() != Some(target_key.as_str()))
        } else if let Some(latest) =
            ConversationAgentBindingRecord::latest_for_conversation(pool, input.conversation_id)
                .await?
        {
            latest.agent_id != input.agent_id
        } else if session
            .agent_id
            .as_ref()
            .is_some_and(|agent| *agent != input.agent_id)
        {
            true
        } else if input.continuation_policy == Some(ContinuationPolicy::Portable)
            && session.external_session_id.is_none()
        {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND id != ?)",
            )
            .bind(input.conversation_id)
            .bind(turn_id)
            .fetch_one(pool)
            .await?
        } else {
            false
        };
        let fresh = input.continuation_policy == Some(ContinuationPolicy::Fresh);

        // Stage C: look for a resumable binding with matching continuation key.
        let resume_candidate = if switching && !fresh {
            ConversationAgentBindingRecord::resume_head_for_key(
                pool,
                input.conversation_id,
                &target_key,
            )
            .await?
            .filter(|b| {
                b.resume_allowed
                    && b.acp_session_id.as_deref().is_some_and(|id| {
                        !id.is_empty() && !agents::is_placeholder_acp_session_id(id)
                    })
            })
        } else {
            None
        };

        let cold = (switching && resume_candidate.is_none()) || fresh;

        if cold {
            self.validate_continuation_owner(input.conversation_id, input.agent_id.as_str())
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
                let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, input.conversation_id)
                    .await?;
                let current_bytes = serde_json::to_vec(&prepared.agent_blocks)
                    .map_err(|e| ConversationServiceError::Internal(e.to_string()))?
                    .len();
                let byte_budget =
                    (64 * 1024usize).min((128 * 1024usize).saturating_sub(current_bytes));
                DeterministicHandoffService::build_execution_handoff(
                    pool,
                    input.conversation_id,
                    input.agent_id.as_str(),
                    turn_id,
                    &[],
                    &HashSet::new(),
                    byte_budget,
                )
                .await
                .map_err(map_handoff_error_to_service)?
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

            let settings = self
                .ctx
                .host
                .launch_settings_with_provider_instance(
                    pool,
                    &input.agent_id,
                    requested_instance,
                )
                .await?;
            let mut preferences = self
                .resolved_session_control_preferences(pool, &input.agent_id, None)
                .await;
            preferences.mode = input.mode_override.clone().or(preferences.mode);
            for value in &input.config_overrides {
                preferences.config.retain(|old| old.key != value.key);
                preferences.config.push(value.clone());
            }
            let candidate = self
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
                .map_err(ConversationServiceError::from)?;
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
                requested_instance,
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
            self.validate_continuation_owner(input.conversation_id, input.agent_id.as_str())
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
            // "Known" is the union of turns executed on this binding and
            // every item a delivered handoff already gave it. Re-delivering a
            // previously delivered gap would duplicate the same history.
            let selection = if input.continuation_policy == Some(ContinuationPolicy::Portable) {
                let known_prefixes = self.known_segment_prefixes(pool, resume.id).await?;
                let delivered_ids = crate::handoff::delivered_item_ids(pool, resume.id).await?;
                let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, input.conversation_id)
                    .await?;
                let current_bytes = serde_json::to_vec(&prepared.agent_blocks)
                    .map_err(|e| ConversationServiceError::Internal(e.to_string()))?
                    .len();
                let byte_budget =
                    (64 * 1024usize).min((128 * 1024usize).saturating_sub(current_bytes));
                DeterministicHandoffService::build_execution_handoff(
                    pool,
                    input.conversation_id,
                    input.agent_id.as_str(),
                    turn_id,
                    &known_prefixes,
                    &delivered_ids,
                    byte_budget,
                )
                .await
                .map_err(map_handoff_error_to_service)?
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

            let settings = self
                .ctx
                .host
                .launch_settings_with_provider_instance(
                    pool,
                    &input.agent_id,
                    requested_instance,
                )
                .await?;
            let mut preferences = self
                .resolved_session_control_preferences(pool, &input.agent_id, Some(&resume))
                .await;
            preferences.mode = input.mode_override.clone().or(preferences.mode);
            for value in &input.config_overrides {
                preferences.config.retain(|old| old.key != value.key);
                preferences.config.push(value.clone());
            }
            let acp_session_id = resume.acp_session_id.clone().unwrap_or_default();
            let (resumed_session, recovery) = self
                .ctx
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: input.agent_id.clone(),
                    launch_lock: settings.launch_lock,
                    workspace_id: input.workspace_id,
                    working_dir: prepared.working_dir.clone().into(),
                    additional_directories: prepared.additional_directories.clone(),
                    session_id: AgentSessionId(input.conversation_id),
                    external_session_id: acp_session_id.clone(),
                    auto_approve_mode: settings.auto_approve_mode,
                    env: settings.env,
                    preferences,
                })
                .await
                .map_err(ConversationServiceError::from)?;
            let runtime_session_id = AgentSessionId(input.conversation_id);
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
            // Re-activate the resumed binding and record its live connection_id + acp_session_id.
            let _ = sqlx::query(
                "UPDATE conversation_agent_bindings
                 SET acp_session_id = ?,
                     connection_id = ?,
                     status = 'ready',
                     updated_at = datetime('now', 'subsec')
                 WHERE id = ?",
            )
            .bind(&resumed_session.acp_session_id)
            .bind(resumed_session.connection_id.to_string())
            .bind(resume.id)
            .execute(pool)
            .await?;
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
            self.replay_remembered_session_controls(
                input.conversation_id,
                runtime_session_id,
                Some(&resumed_binding),
            )
            .await;
            self.ctx
                .agent_runtime
                .commit_prepared_session(runtime_session_id)
                .await;
            let capabilities = self
                .ctx
                .agent_runtime
                .session_controls_snapshot(runtime_session_id)
                .await
                .ok()
                .and_then(|controls| controls.capabilities)
                .or_else(|| {
                    serde_json::from_str::<agents::conversation::AcpCapabilitySnapshot>(
                        &resumed_binding.session_capabilities_json,
                    )
                    .ok()
                })
                .unwrap_or_default();
            self.append_event(
                input.conversation_id,
                None,
                "runtime",
                agents::conversation::ConversationEvent::AgentBindingReady {
                    acp_session_id: resumed_session.acp_session_id.clone(),
                    capabilities,
                },
                None,
            )
            .await?;
            if matches!(
                recovery,
                Some(agents::SessionRecoveryStrategy::CreatedNewSession)
            ) {
                let continues_from = (!acp_session_id.is_empty()
                    && acp_session_id != resumed_session.acp_session_id)
                    .then_some(acp_session_id);
                self.record_agent_binding_recovered(
                    input.conversation_id,
                    agents::SessionRecoveryStrategy::CreatedNewSession,
                    continues_from,
                )
                .await?;
            }
            if let Some(selection) = selection {
                prepared.agent_blocks.insert(
                    0,
                    AgentContentBlock::Text {
                        text: selection.prompt,
                    },
                );
            }
        } else {
            if session.agent_id.as_ref() != Some(&input.agent_id) {
                let _ = Session::update_agent_metadata(
                    pool,
                    input.conversation_id,
                    session.external_session_id.as_deref(),
                    Some(&input.agent_id),
                )
                .await;
            }
            self.ensure_session_controls_locked_with_provider_instance(
                input.conversation_id,
                Some(prepared.working_dir.clone().into()),
                requested_instance,
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

    /// Get the turn-ID and legacy segment-ID prefixes for turns the binding already owns natively.
    async fn known_segment_prefixes(
        &self,
        pool: &sqlx::SqlitePool,
        binding_id: Uuid,
    ) -> Result<Vec<String>, sqlx::Error> {
        let turn_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM conversation_turns WHERE agent_binding_id = ? ORDER BY ordinal",
        )
        .bind(binding_id)
        .fetch_all(pool)
        .await?;
        let segment_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM conversation_transcript_segments WHERE binding_id = ? ORDER BY ordinal",
        )
        .bind(binding_id)
        .fetch_all(pool)
        .await?;
        let mut prefixes = Vec::with_capacity(turn_ids.len() + segment_ids.len());
        for id in turn_ids {
            prefixes.push(format!("{id}:"));
        }
        for id in segment_ids {
            prefixes.push(format!("segment:{}:", id.simple()));
        }
        Ok(prefixes)
    }

    async fn validate_continuation_owner(
        &self,
        conversation_id: Uuid,
        requested_agent_id: &str,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let owned: bool = sqlx::query_scalar(
            r#"SELECT EXISTS(
                   SELECT 1 FROM conversation_relations
                   WHERE child_conversation_id = ?
                     AND kind IN ('workflow_step', 'delegation')
               )
               OR EXISTS(
                   SELECT 1 FROM collaboration_thread_members tm
                   LEFT JOIN collaboration_members m ON m.id = tm.member_id
                   WHERE tm.conversation_id = ?
                     AND lower(replace(COALESCE(m.agent, ''), '-', '_')) != lower(replace(?, '-', '_'))
               )"#,
        )
        .bind(conversation_id)
        .bind(conversation_id.to_string())
        .bind(requested_agent_id)
        .fetch_one(pool)
        .await?;
        if owned {
            return Err(ConversationServiceError::SessionUnavailable {
                code: "continuation_not_allowed",
                message: "This conversation's Agent is controlled by its workflow or bot".into(),
            });
        }
        Ok(())
    }
}
