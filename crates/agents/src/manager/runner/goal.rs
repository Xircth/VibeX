use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn execute_goal_control(
        &self,
        conn: &ConnectionTo<Agent>,
        session_id: AgentSessionId,
        action: &str,
        is_idle: bool,
    ) -> AgentResult<crate::GoalControlReceipt> {
        let action = action.trim();
        if action.is_empty() {
            return Err(AgentError::Runtime(
                "goal control action cannot be empty".into(),
            ));
        }
        let acp_session_id = self
            .session_map
            .read()
            .await
            .get(&session_id)
            .cloned()
            .filter(|id| crate::is_restorable_acp_session_id(id))
            .ok_or(AgentError::AcpSessionNotBound)?;
        let (method, actions) = self.resolve_session_goal_control().await.ok_or_else(|| {
            AgentError::Runtime("agent does not advertise session goal control".into())
        })?;
        if !actions.iter().any(|candidate| candidate == action) {
            return Err(AgentError::Runtime(format!(
                "agent does not advertise goal action `{action}`"
            )));
        }
        let goal_was_active = {
            let controls = self.session_controls.read().await;
            controls.get(&session_id).is_some_and(|state| {
                state.open_goal_run.is_some()
                    || state
                        .goal
                        .as_ref()
                        .and_then(|goal| goal.get("status"))
                        .and_then(serde_json::Value::as_str)
                        == Some("active")
            })
        };

        if method == crate::codex_goal::NEUTRAL_GOAL_CONTROL_METHOD {
            conn.send_request(AcpNeutralGoalControlRequest {
                session_id: acp_session_id.clone(),
                action: action.to_string(),
            })
            .block_task()
            .await
            .map_err(|error| AgentError::Runtime(format!("{method} ({action}) failed: {error}")))?;
        } else if method == crate::codex_goal::LEGACY_GOAL_CONTROL_METHOD {
            conn.send_request(AcpLegacyGoalControlRequest {
                session_id: acp_session_id.clone(),
                action: action.to_string(),
            })
            .block_task()
            .await
            .map_err(|error| AgentError::Runtime(format!("{method} ({action}) failed: {error}")))?;
        } else {
            return Err(AgentError::Runtime(format!(
                "unsupported goal control method `{method}`"
            )));
        }

        let should_interrupt_turn =
            crate::codex_goal::goal_control_is_out_of_band(self.agent_kind())
                && goal_was_active
                && matches!(action, "pause" | "clear");
        if should_interrupt_turn && is_idle {
            let _ = conn.send_notification(CancelNotification::new(SessionId::new(acp_session_id)));
        }

        Ok(crate::GoalControlReceipt {
            action: action.to_string(),
            method,
            should_interrupt_turn,
            goal: None,
        })
    }

    pub(in crate::manager) async fn execute_stop_async_task(
        &self,
        conn: &ConnectionTo<Agent>,
        session_id: AgentSessionId,
        task_id: &str,
    ) -> AgentResult<bool> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err(AgentError::Runtime("async task id cannot be empty".into()));
        }
        let acp_session_id = self
            .session_map
            .read()
            .await
            .get(&session_id)
            .cloned()
            .filter(|id| crate::is_restorable_acp_session_id(id))
            .ok_or(AgentError::AcpSessionNotBound)?;
        let response = conn
            .send_request(AcpStopAsyncTaskRequest {
                session_id: acp_session_id,
                async_task_id: task_id.to_string(),
                task_id: task_id.to_string(),
            })
            .block_task()
            .await
            .map_err(|error| {
                AgentError::Runtime(format!(
                    "{} ({task_id}) failed: {error}",
                    crate::async_tasks::ASYNC_TASK_STOP_METHOD
                ))
            })?;
        Ok(response
            .get("stopped")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false))
    }

    pub(in crate::manager) async fn apply_session_info_goal(
        &self,
        session_id: Option<AgentSessionId>,
        goal: &serde_json::Value,
        emit_events: bool,
    ) {
        let Some(session_id) = session_id else {
            return;
        };
        let actions = self.resolved_goal_actions().await;
        let (normalized_goal, marker_call) = {
            let mut controls = self.session_controls.write().await;
            let state = controls.entry(session_id).or_default();
            let marker = crate::codex_goal::advance_goal_marker(&mut state.open_goal_run, goal);
            let normalized = if goal.is_null() {
                None
            } else {
                crate::codex_goal::normalize_goal_snapshot(goal)
            };
            state.goal = normalized.clone();
            let marker_call = marker.map(|marker| {
                state.goal_marker_sequence += 1;
                let id = crate::codex_goal::goal_tool_call_id(state.goal_marker_sequence);
                AgentToolCall {
                    id,
                    title: marker.tool_name.to_string(),
                    kind: Some("other".to_string()),
                    status: Some("completed".to_string()),
                    content: Some(marker.output_json),
                    input_preview: Some(marker.input_json),
                    meta: normalized.clone(),
                    images: Vec::new(),
                }
            });
            (normalized, marker_call)
        };
        if !emit_events {
            return;
        }
        let active_prompt_id = self
            .active_prompt
            .lock()
            .await
            .filter(|(active_session, _)| *active_session == session_id)
            .map(|(_, prompt_id)| prompt_id);
        self.emit(
            Some(session_id),
            active_prompt_id,
            AgentEvent::GoalUpdated {
                goal: normalized_goal,
                goal_actions: actions,
            },
        );
        if let Some(tool_call) = marker_call {
            if let Some(acp_session_id) = self.session_map.read().await.get(&session_id).cloned()
                && records_acp_jsonl(self.snapshot.agent_id.as_str())
                && crate::acp_transcript::safe_component(&acp_session_id)
            {
                let agent_dir = jsonl_agent_dir(self.snapshot.agent_id.as_str());
                let raw_input = tool_call
                    .input_preview
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                let raw_output = tool_call
                    .content
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                let payload = serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": tool_call.id,
                    "title": tool_call.title,
                    "kind": "other",
                    "status": "completed",
                    "rawInput": raw_input,
                    "rawOutput": raw_output,
                    "_meta": tool_call.meta,
                });
                drop(crate::acp_transcript::record_entry(
                    &agent_dir,
                    &acp_session_id,
                    crate::acp_transcript::EntryKind::Update,
                    payload,
                ));
            }
            self.emit(
                Some(session_id),
                active_prompt_id,
                AgentEvent::ToolCall { tool_call },
            );
        }
    }

    pub(in crate::manager) async fn apply_async_task_delta(
        &self,
        session_id: Option<AgentSessionId>,
        delta: crate::AsyncTaskDelta,
    ) {
        let Some(session_id) = session_id else {
            return;
        };
        let updated = {
            let mut controls = self.session_controls.write().await;
            let state = controls.entry(session_id).or_default();
            if crate::async_tasks::apply_async_task_delta(&mut state.async_tasks, &delta) {
                Some(state.async_tasks.clone())
            } else {
                None
            }
        };
        let Some(tasks) = updated else {
            return;
        };
        let active_prompt_id = self
            .active_prompt
            .lock()
            .await
            .filter(|(active_session, _)| *active_session == session_id)
            .map(|(_, prompt_id)| prompt_id);
        self.emit(
            Some(session_id),
            active_prompt_id,
            AgentEvent::AsyncTasksUpdated { tasks },
        );
    }

    pub(in crate::manager) async fn apply_prompt_suggestion(
        &self,
        session_id: Option<AgentSessionId>,
        suggestion: Option<String>,
    ) {
        let Some(session_id) = session_id else {
            return;
        };
        if !self.wants_prompt_suggestions(session_id).await {
            return;
        }
        let changed = {
            let mut controls = self.session_controls.write().await;
            let state = controls.entry(session_id).or_default();
            if state.prompt_suggestion == suggestion {
                false
            } else {
                state.prompt_suggestion = suggestion.clone();
                true
            }
        };
        if !changed {
            return;
        }
        self.emit(
            Some(session_id),
            None,
            AgentEvent::PromptSuggestionUpdated { suggestion },
        );
    }

    pub(in crate::manager) fn emit_session_load_failed(
        &self,
        session_id: AgentSessionId,
        reason: SessionLoadFailureReason,
    ) {
        tracing::warn!(
            session_id = %session_id.0,
            ?reason,
            "ACP session restore failed"
        );
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionLoadFailed { reason },
        );
    }
}
