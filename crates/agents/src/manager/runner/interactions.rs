use super::*;

impl AgentConnectionRunner {
    pub(in crate::manager) async fn respond_pending_permission(
        &self,
        permission_id: &str,
        response: AgentPermissionResponse,
    ) {
        let pending = self.pending_permissions.lock().await.remove(permission_id);
        if let Some(pending) = pending {
            let persist = response.should_persist_auto_approve(&pending.options);
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id: pending.permission_id,
                    response,
                    auto: false,
                },
            );
            if persist {
                self.persist_connection_auto_approve().await;
            }
        } else {
            self.emit(
                None,
                None,
                AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({
                        "kind": "unknown_permission_response",
                        "permission_id": permission_id,
                    }),
                },
            );
        }
    }

    pub(in crate::manager) async fn persist_connection_auto_approve(&self) {
        *self.auto_approve_mode.lock().await = AgentAutoApproveMode::Yolo;
        let remaining = {
            let mut pending = self.pending_permissions.lock().await;
            pending.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };
        let mode = *self.auto_approve_mode.lock().await;
        for pending in remaining {
            let request = AgentPermissionRequest {
                id: pending.permission_id,
                session_id: pending.session_id,
                title: String::new(),
                details: None,
                options: pending.options.clone(),
            };
            let response = decide_auto_permission_response(mode, &request)
                .unwrap_or(AgentPermissionResponse::Cancelled);
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id: pending.permission_id,
                    response,
                    auto: true,
                },
            );
        }
    }

    /// Is the agent currently blocked waiting on a permission decision for this
    /// session? Such a wait produces no ACP activity, so the idle watchdog must
    /// not mistake it for a hang.
    pub(in crate::manager) async fn has_pending_permission_for(
        &self,
        session_id: AgentSessionId,
    ) -> bool {
        self.pending_permissions
            .lock()
            .await
            .values()
            .any(|pending| pending.session_id == session_id)
    }

    pub(in crate::manager) async fn has_running_terminal_for(
        &self,
        session_id: AgentSessionId,
    ) -> bool {
        agent_terminal_registry()
            .has_running_for_session(session_id)
            .await
    }

    pub(in crate::manager) async fn cancel_pending_interactions(&self, session_id: AgentSessionId) {
        let pending = {
            let mut pending_permissions = self.pending_permissions.lock().await;
            let permission_ids = pending_permissions
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(permission_id, _)| permission_id.clone())
                .collect::<Vec<_>>();

            permission_ids
                .into_iter()
                .filter_map(|permission_id| pending_permissions.remove(&permission_id))
                .collect::<Vec<_>>()
        };

        for pending in pending {
            let response = AgentPermissionResponse::Cancelled;
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::PermissionResponded {
                    permission_id: pending.permission_id,
                    response,
                    auto: false,
                },
            );
        }
        self.cancel_pending_elicitations(session_id).await;
        agent_terminal_registry()
            .release_all_for_session(session_id)
            .await;
    }

    pub(in crate::manager) async fn cancel_all_pending_interactions(&self) {
        let mut session_ids: std::collections::HashSet<AgentSessionId> =
            self.session_map.read().await.keys().copied().collect();
        session_ids.extend(
            self.pending_permissions
                .lock()
                .await
                .values()
                .map(|pending| pending.session_id),
        );
        session_ids.extend(
            self.pending_elicitations
                .lock()
                .await
                .values()
                .map(|pending| pending.session_id),
        );
        if let Some((session_id, _)) = *self.active_prompt.lock().await {
            session_ids.insert(session_id);
        }
        if let Some(session_id) = *self.pending_session_id.lock().await {
            session_ids.insert(session_id);
        }
        for session_id in session_ids {
            self.cancel_pending_interactions(session_id).await;
        }
    }

    pub(in crate::manager) async fn respond_pending_elicitation(
        &self,
        elicitation_id: &str,
        response: AgentElicitationResponse,
    ) {
        let pending = self
            .pending_elicitations
            .lock()
            .await
            .remove(elicitation_id);
        if let Some(pending) = pending {
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::ElicitationResponded {
                    elicitation_id: pending.elicitation_id,
                    response,
                },
            );
        } else {
            self.emit(
                None,
                None,
                AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({
                        "kind": "unknown_elicitation_response",
                        "elicitation_id": elicitation_id,
                    }),
                },
            );
        }
    }

    /// Is the agent blocked waiting on a user answer to an elicitation for this
    /// session? Like a permission wait, this produces no ACP activity, so the
    /// idle watchdog must not mistake it for a hang.
    pub(in crate::manager) async fn has_pending_elicitation_for(
        &self,
        session_id: AgentSessionId,
    ) -> bool {
        self.pending_elicitations
            .lock()
            .await
            .values()
            .any(|pending| pending.session_id == session_id)
    }

    pub(in crate::manager) async fn cancel_pending_elicitations(&self, session_id: AgentSessionId) {
        let pending = {
            let mut pending_elicitations = self.pending_elicitations.lock().await;
            let elicitation_ids = pending_elicitations
                .iter()
                .filter(|(_, pending)| pending.session_id == session_id)
                .map(|(elicitation_id, _)| elicitation_id.clone())
                .collect::<Vec<_>>();

            elicitation_ids
                .into_iter()
                .filter_map(|elicitation_id| pending_elicitations.remove(&elicitation_id))
                .collect::<Vec<_>>()
        };

        for pending in pending {
            let response = AgentElicitationResponse::Cancel;
            let _ = pending.tx.send(response.clone());
            self.emit(
                Some(pending.session_id),
                None,
                AgentEvent::ElicitationResponded {
                    elicitation_id: pending.elicitation_id,
                    response,
                },
            );
        }
    }
}
